'use strict';

const { RECENCY_HALFLIFE_DAYS, SEMANTIC_CANDIDATES } = require('./constants');

class VectorIndex {
  constructor(db, graph) {
    this._db = db;
    this._g = graph;
  }

  enableVectorSearch() {
    if (this._g.usingFallback) return false;
    try {
      const exists = this._db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='node_vectors'"
      ).get();

      if (!exists) {
        this._db.exec(`
          CREATE VIRTUAL TABLE node_vectors USING vec0(
            embedding FLOAT[384]
          );
        `);
        console.log('[state-graph] node_vectors creada — recall semántico habilitado');
      }

      this._g._vectorReady = true;
      return true;
    } catch(e) {
      console.warn('[state-graph] no se pudo habilitar recall semántico (se sigue usando LIKE):', e.message);
      this._g._vectorReady = false;
      return false;
    }
  }

  _upsertNodeVector(id, embeddingBuffer) {
    const bigId = BigInt(id);
    this._db.prepare('DELETE FROM node_vectors WHERE rowid=?').run(bigId);
    this._db.prepare('INSERT INTO node_vectors (rowid, embedding) VALUES (?, ?)').run(bigId, embeddingBuffer);
  }

  async queryNodesSemantic(searchText, { type, limit = 8, includeArchived = false } = {}) {
    if (!this._g._vectorReady || !searchText || !searchText.trim()) {
      return this._g._nodes.queryNodes({ type, search: searchText, limit, includeArchived });
    }

    try {
      const { embedText, float32ToBuffer, distanceToSimilarity } = require('../../grounding/IntentDetector.js');
      const queryVec = await embedText(searchText.slice(0, 500));

      const candidates = this._db.prepare(`
        SELECT nv.rowid as id, distance
        FROM node_vectors nv
        WHERE embedding MATCH ? AND k = ?
        ORDER BY distance
      `).all(float32ToBuffer(queryVec), SEMANTIC_CANDIDATES);

      if (!candidates.length) {
        return this._g._nodes.queryNodes({ type, search: searchText, limit, includeArchived });
      }

      const now = Date.now();
      const ids = candidates.map(c => c.id);
      const placeholders = ids.map(() => '?').join(',');
      const archivedClause = includeArchived ? '' : 'AND archived=0';
      const typeClause = type ? 'AND type=?' : '';

      const rows = this._db.prepare(`
        SELECT * FROM nodes WHERE id IN (${placeholders}) ${archivedClause} ${typeClause}
      `).all(...ids, ...(type ? [type] : []));

      const distanceById = new Map(candidates.map(c => [c.id, c.distance]));

      const scored = rows.map(node => {
        const distance   = distanceById.get(node.id) ?? 1;
        const similarity = distanceToSimilarity(distance);
        const daysSince   = Math.max(0, (now - node.last_accessed_at) / (1000 * 60 * 60 * 24));
        const recencyBoost = 0.5 + 0.5 * Math.exp(-daysSince / RECENCY_HALFLIFE_DAYS);
        const score = similarity * node.importance * recencyBoost;
        return { ...node, _semanticScore: score, _similarity: similarity };
      });

      scored.sort((a, b) => b._semanticScore - a._semanticScore);
      const top = scored.slice(0, limit);

      if (!includeArchived) {
        this._g._nodes._touchNodes(top.map(n => n.id).filter(Boolean), 'queryNodesSemantic');
      }

      return top;

    } catch(e) {
      console.warn('[state-graph] error en recall semántico, cayendo a LIKE:', e.message);
      return this._g._nodes.queryNodes({ type, search: searchText, limit, includeArchived });
    }
  }

  async backfillEmbeddings(batchSize = 10) {
    if (!this._g._vectorReady) return { embedded: 0 };

    try {
      this._db.prepare("SELECT rowid FROM node_vectors LIMIT 1").get();
    } catch(e) {
      console.warn('[state-graph] backfill abortado — node_vectors no existe:', e.message);
      return { embedded: 0, error: 'node_vectors table not found' };
    }

    try {
      const orphaned = this._db.prepare(`
        SELECT nv.rowid FROM node_vectors nv
        LEFT JOIN nodes n ON n.id = nv.rowid
        WHERE n.id IS NULL
      `).all();
      for (const row of orphaned) {
        this._db.prepare('DELETE FROM node_vectors WHERE rowid=?').run(BigInt(row.rowid));
      }
      if (orphaned.length > 0) {
        console.log(`[state-graph] backfill: ${orphaned.length} vectores huérfanos eliminados`);
      }
    } catch(e) {
      console.warn('[state-graph] error limpiando vectores huérfanos:', e.message);
    }

    try {
      const pending = this._db.prepare(`
        SELECT n.id, n.content FROM nodes n
        LEFT JOIN node_vectors nv ON nv.rowid = n.id
        WHERE nv.rowid IS NULL AND n.archived = 0
      `).all();

      if (!pending.length) return { embedded: 0 };

      console.log(`[state-graph] backfill de embeddings: ${pending.length} nodos pendientes...`);
      const { embedText, float32ToBuffer } = require('../../grounding/IntentDetector.js');

      let done = 0;
      for (let i = 0; i < pending.length; i += batchSize) {
        const batch = pending.slice(i, i + batchSize);
        for (const node of batch) {
          try {
            const vec = await embedText((node.content || '').slice(0, 2000));
            this._upsertNodeVector(node.id, float32ToBuffer(vec));
            done++;
          } catch(e) {
            console.warn(`[state-graph] backfill: error embedeando nodo ${node.id}:`, e.message);
          }
        }
        if (i + batchSize < pending.length) await new Promise(r => setTimeout(r, 50));
      }

      console.log(`[state-graph] backfill completado: ${done}/${pending.length} nodos embedeados`);
      return { embedded: done, total: pending.length };
    } catch(e) {
      console.error('[state-graph] error en backfillEmbeddings:', e.message);
      return { embedded: 0, error: e.message };
    }
  }
}

module.exports = { VectorIndex };