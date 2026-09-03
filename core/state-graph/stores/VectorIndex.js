// @ts-nocheck
'use strict';
const logger = require('../../observability/Logger.js');

const { RECENCY_HALFLIFE_DAYS, SEMANTIC_CANDIDATES } = require('./constants');
const { distanceToSimilarity } = require('../../grounding/IntentDetector.js');

class VectorIndex {
  constructor(db, graph) {
    this._db = db;
    this._g = graph;
  }

  enableVectorSearch() {
    if (this._g.usingFallback) return false;
    try {
      const exists = this._db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='node_vectors'")
        .get();

      if (!exists) {
        this._db.exec(`
          CREATE VIRTUAL TABLE node_vectors USING vec0(
            embedding FLOAT[384]
          );
        `);
        logger.info(
          'VectorIndex',
          '[state-graph] node_vectors creada — recall semántico habilitado'
        );
      }

      this._g._vectorReady = true;
      return true;
    } catch (e) {
      logger.warn(
        'VectorIndex',
        '[state-graph] no se pudo habilitar recall semántico (se sigue usando LIKE):',
        e.message
      );
      this._g._vectorReady = false;
      return false;
    }
  }

  _upsertNodeVector(id, embeddingBuffer) {
    const bigId = BigInt(id);
    this._db.prepare('DELETE FROM node_vectors WHERE rowid=?').run(bigId);
    this._db
      .prepare('INSERT INTO node_vectors (rowid, embedding) VALUES (?, ?)')
      .run(bigId, embeddingBuffer);
  }

  _deleteVector(id) {
    if (!this._g._vectorReady) return false;
    try {
      this._db.prepare('DELETE FROM node_vectors WHERE rowid=?').run(BigInt(id));
      return true;
    } catch (e) {
      logger.warn('VectorIndex', `[state-graph] no se pudo borrar vector ${id}:`, e.message);
      return false;
    }
  }

  /**
   * Elimina los vectores de TODOS los nodos archivados (F2.1). El archivo de
   * un nodo solo marcaba archived=1 en `nodes` y su vector quedaba stale para
   * siempre en node_vectors: ocupaba espacio y aparecía en el KNN antes del
   * filtro por archived. Idempotente y seguro de correr en cualquier momento.
   * @returns {number} vectores eliminados
   */
  purgeArchivedVectors() {
    if (!this._g._vectorReady || this._g.usingFallback) return 0;
    try {
      const archived = this._db.prepare('SELECT id FROM nodes WHERE archived=1').all();
      const del = this._db.prepare('DELETE FROM node_vectors WHERE rowid=?');
      let removed = 0;
      for (const row of archived) {
        removed += del.run(BigInt(row.id)).changes;
      }
      if (removed > 0) {
        logger.info(
          'VectorIndex',
          `[state-graph] purga de vectores archivados: ${removed} eliminados`
        );
      }
      return removed;
    } catch (e) {
      logger.warn('VectorIndex', '[state-graph] error purgando vectores archivados:', e.message);
      return 0;
    }
  }

  async queryNodesSemantic(searchText, { type, limit = 8, includeArchived = false } = {}) {
    if (!this._g._vectorReady || !searchText || !searchText.trim()) {
      return this._g._nodes.queryNodes({ type, search: searchText, limit, includeArchived });
    }

    try {
      // F2.1-D: embeddings en worker_threads (EmbedService), con fallback al
      // embedder de main thread dentro del propio servicio.
      const EmbedService = require('../../grounding/EmbedService.js');
      const queryVec = await EmbedService.embedText(searchText.slice(0, 500));

      const candidates = this._db
        .prepare(
          `
        SELECT nv.rowid as id, distance
        FROM node_vectors nv
        WHERE embedding MATCH ? AND k = ?
        ORDER BY distance
      `
        )
        .all(EmbedService.float32ToBuffer(queryVec), SEMANTIC_CANDIDATES);

      if (!candidates.length) {
        return this._g._nodes.queryNodes({ type, search: searchText, limit, includeArchived });
      }

      const now = Date.now();
      const ids = candidates.map((c) => c.id);
      const placeholders = ids.map(() => '?').join(',');
      const archivedClause = includeArchived ? '' : 'AND archived=0';
      const typeClause = type ? 'AND type=?' : '';

      const rows = this._db
        .prepare(
          `
        SELECT * FROM nodes WHERE id IN (${placeholders}) ${archivedClause} ${typeClause}
      `
        )
        .all(...ids, ...(type ? [type] : []));

      const distanceById = new Map(candidates.map((c) => [c.id, c.distance]));

      const scored = rows.map((node) => {
        const distance = distanceById.get(node.id) ?? 1;
        const similarity = distanceToSimilarity(distance);
        const daysSince = Math.max(0, (now - node.last_accessed_at) / (1000 * 60 * 60 * 24));
        const recencyBoost = 0.5 + 0.5 * Math.exp(-daysSince / RECENCY_HALFLIFE_DAYS);
        const score = similarity * node.importance * recencyBoost;
        return { ...node, _semanticScore: score, _similarity: similarity };
      });

      scored.sort((a, b) => b._semanticScore - a._semanticScore);
      const top = scored.slice(0, limit);

      // No tocar last_accessed_at durante la selección: ese timestamp forma
      // parte del score y refrescarlo aquí haría que una elección del propio
      // algoritmo aumente las probabilidades de repetirse. El caller podrá
      // registrar más adelante qué recuerdos llegaron realmente al prompt.

      return top;
    } catch (e) {
      logger.warn(
        'VectorIndex',
        '[state-graph] error en recall semántico, cayendo a LIKE:',
        e.message
      );
      return this._g._nodes.queryNodes({ type, search: searchText, limit, includeArchived });
    }
  }

  async backfillEmbeddings(batchSize = 10) {
    if (!this._g._vectorReady) return { embedded: 0 };

    try {
      this._db.prepare('SELECT rowid FROM node_vectors LIMIT 1').get();
    } catch (e) {
      logger.warn(
        'VectorIndex',
        '[state-graph] backfill abortado — node_vectors no existe:',
        e.message
      );
      return { embedded: 0, error: 'node_vectors table not found' };
    }

    try {
      const orphaned = this._db
        .prepare(
          `
        SELECT nv.rowid FROM node_vectors nv
        LEFT JOIN nodes n ON n.id = nv.rowid
        WHERE n.id IS NULL
      `
        )
        .all();
      for (const row of orphaned) {
        this._db.prepare('DELETE FROM node_vectors WHERE rowid=?').run(BigInt(row.rowid));
      }
      if (orphaned.length > 0) {
        logger.info(
          'VectorIndex',
          `[state-graph] backfill: ${orphaned.length} vectores huérfanos eliminados`
        );
      }
    } catch (e) {
      logger.warn('VectorIndex', '[state-graph] error limpiando vectores huérfanos:', e.message);
    }

    // F2.1 red de seguridad: en el arranque también se purgan los vectores de
    // nodos archivados que pudieran haber quedado stale antes de esta versión.
    try {
      this.purgeArchivedVectors();
    } catch (e) {
      logger.warn('VectorIndex', '[state-graph] error purgando vectores archivados:', e.message);
    }

    try {
      const pending = this._db
        .prepare(
          `
        SELECT n.id, n.content FROM nodes n
        LEFT JOIN node_vectors nv ON nv.rowid = n.id
        WHERE nv.rowid IS NULL AND n.archived = 0
      `
        )
        .all();

      if (!pending.length) return { embedded: 0 };

      logger.info(
        'VectorIndex',
        `[state-graph] backfill de embeddings: ${pending.length} nodos pendientes...`
      );
      // F2.1-D: embeddings fuera del main thread (worker_threads).
      const EmbedService = require('../../grounding/EmbedService.js');

      let done = 0;
      for (let i = 0; i < pending.length; i += batchSize) {
        const batch = pending.slice(i, i + batchSize);
        for (const node of batch) {
          try {
            const vec = await EmbedService.embedText((node.content || '').slice(0, 2000));
            this._upsertNodeVector(node.id, EmbedService.float32ToBuffer(vec));
            done++;
          } catch (e) {
            logger.warn(
              'VectorIndex',
              `[state-graph] backfill: error embedeando nodo ${node.id}:`,
              e.message
            );
          }
        }
        if (i + batchSize < pending.length) await new Promise((r) => setTimeout(r, 50));
      }

      logger.info(
        'VectorIndex',
        `[state-graph] backfill completado: ${done}/${pending.length} nodos embedeados`
      );
      return { embedded: done, total: pending.length };
    } catch (e) {
      logger.error('VectorIndex', '[state-graph] error en backfillEmbeddings:', e.message);
      return { embedded: 0, error: e.message };
    }
  }
}

module.exports = { VectorIndex };
