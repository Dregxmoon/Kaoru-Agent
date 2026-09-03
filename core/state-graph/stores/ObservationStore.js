// @ts-check
'use strict';

const logger = require('../../observability/Logger.js');

const SENSITIVITY = new Set(['public', 'private', 'sensitive']);

/** @param {unknown} error @returns {string} */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

class ObservationStore {
  /** @param {any} db @param {{usingFallback?:boolean}} graph */
  constructor(db, graph) {
    this._db = db;
    this._graph = graph;
    /** @type {Map<number, any>} */
    this._memory = new Map();
    this._nextMemoryId = 1;
  }

  /**
   * Registra percepción cruda local. Una observación no es un hecho: solo puede
   * convertirse en memoria mediante evidencia explícita.
   * @param {{source:string, kind:string, content?:string, metadata?:object, sessionId?:string|number|null, sensitivity?:string, occurredAt?:number, ttlMs?:number|null, dedupeKey?:string|null}} opts
   * @returns {number|null}
   */
  record(opts) {
    if (!opts?.source || !opts?.kind) return null;
    const now = Number(opts.occurredAt) || Date.now();
    const sensitivity = SENSITIVITY.has(String(opts.sensitivity))
      ? String(opts.sensitivity)
      : 'private';
    const row = {
      source: String(opts.source).slice(0, 80),
      kind: String(opts.kind).slice(0, 80),
      content: String(opts.content || '').slice(0, 8_000),
      metadata: JSON.stringify(opts.metadata || {}),
      session_id: opts.sessionId == null ? null : String(opts.sessionId),
      sensitivity,
      occurred_at: now,
      expires_at: opts.ttlMs ? now + Math.max(1, Number(opts.ttlMs)) : null,
      processed_at: null,
      dedupe_key: opts.dedupeKey ? String(opts.dedupeKey).slice(0, 200) : null,
    };

    if (this._graph.usingFallback) {
      if (row.dedupe_key) {
        const existing = [...this._memory.values()].find(
          (item) => item.dedupe_key === row.dedupe_key
        );
        if (existing) return existing.id;
      }
      const id = this._nextMemoryId++;
      this._memory.set(id, { id, ...row });
      return id;
    }

    try {
      const result = this._db
        .prepare(
          `INSERT OR IGNORE INTO observations
           (source, kind, content, metadata, session_id, sensitivity, occurred_at, expires_at, processed_at, dedupe_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`
        )
        .run(
          row.source,
          row.kind,
          row.content,
          row.metadata,
          row.session_id,
          row.sensitivity,
          row.occurred_at,
          row.expires_at,
          row.dedupe_key
        );
      if (result.changes > 0) return Number(result.lastInsertRowid);
      if (!row.dedupe_key) return null;
      const existing = this._db
        .prepare('SELECT id FROM observations WHERE dedupe_key=?')
        .get(row.dedupe_key);
      return existing ? Number(existing.id) : null;
    } catch (error) {
      logger.warn('ObservationStore', '[observations] no se pudo registrar:', errorMessage(error));
      return null;
    }
  }

  /**
   * @param {{sessionId?:string|number|null, source?:string|null, kind?:string|null, unprocessedOnly?:boolean, limit?:number}} [opts]
   * @returns {any[]}
   */
  list({
    sessionId = null,
    source = null,
    kind = null,
    unprocessedOnly = false,
    limit = 100,
  } = {}) {
    if (this._graph.usingFallback) {
      return [...this._memory.values()]
        .filter((row) => sessionId == null || row.session_id === String(sessionId))
        .filter((row) => !source || row.source === source)
        .filter((row) => !kind || row.kind === kind)
        .filter((row) => !unprocessedOnly || row.processed_at == null)
        .sort((a, b) => a.occurred_at - b.occurred_at || a.id - b.id)
        .slice(0, limit);
    }

    try {
      let sql = 'SELECT * FROM observations WHERE 1=1';
      const args = [];
      if (sessionId != null) {
        sql += ' AND session_id=?';
        args.push(String(sessionId));
      }
      if (source) {
        sql += ' AND source=?';
        args.push(source);
      }
      if (kind) {
        sql += ' AND kind=?';
        args.push(kind);
      }
      if (unprocessedOnly) sql += ' AND processed_at IS NULL';
      sql += ' ORDER BY occurred_at ASC, id ASC LIMIT ?';
      args.push(Math.max(1, Math.min(1000, limit)));
      return this._db.prepare(sql).all(...args);
    } catch (error) {
      logger.warn('ObservationStore', '[observations] no se pudo listar:', errorMessage(error));
      return [];
    }
  }

  /** @param {number[]} ids @returns {number} */
  markProcessed(ids) {
    const safeIds = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
    if (!safeIds.length) return 0;
    const now = Date.now();
    if (this._graph.usingFallback) {
      let changed = 0;
      for (const id of safeIds) {
        const row = this._memory.get(id);
        if (row && row.processed_at == null) {
          row.processed_at = now;
          changed++;
        }
      }
      return changed;
    }
    try {
      const placeholders = safeIds.map(() => '?').join(',');
      return this._db
        .prepare(`UPDATE observations SET processed_at=? WHERE id IN (${placeholders})`)
        .run(now, ...safeIds).changes;
    } catch (error) {
      logger.warn('ObservationStore', '[observations] no se pudo marcar:', errorMessage(error));
      return 0;
    }
  }

  /** @param {number} nodeId @param {number[]} observationIds @param {number} [confidence] */
  linkEvidence(nodeId, observationIds, confidence = 1) {
    if (this._graph.usingFallback || !nodeId) return 0;
    const ids = [...new Set(observationIds.filter((id) => Number.isInteger(id) && id > 0))];
    let linked = 0;
    try {
      const insert = this._db.prepare(
        `INSERT OR IGNORE INTO memory_evidence
         (node_id, observation_id, relation, confidence, created_at)
         VALUES (?, ?, 'SUPPORTS', ?, ?)`
      );
      const transaction = this._db.transaction(() => {
        for (const observationId of ids) {
          linked += insert.run(nodeId, observationId, confidence, Date.now()).changes;
        }
      });
      transaction();
    } catch (error) {
      logger.warn(
        'ObservationStore',
        '[observations] no se pudo enlazar evidencia:',
        errorMessage(error)
      );
    }
    return linked;
  }

  /** @param {number} nodeId @returns {any[]} */
  getEvidence(nodeId) {
    if (this._graph.usingFallback || !nodeId) return [];
    try {
      return this._db
        .prepare(
          `SELECT o.*, e.relation, e.confidence AS evidence_confidence
           FROM memory_evidence e
           JOIN observations o ON o.id=e.observation_id
           WHERE e.node_id=? ORDER BY o.occurred_at ASC, o.id ASC`
        )
        .all(nodeId);
    } catch (error) {
      logger.warn(
        'ObservationStore',
        '[observations] no se pudo leer evidencia:',
        errorMessage(error)
      );
      return [];
    }
  }

  /** @returns {{total:number, pending:number, evidenceLinks:number}} */
  getStats() {
    if (this._graph.usingFallback) {
      const rows = [...this._memory.values()];
      return {
        total: rows.length,
        pending: rows.filter((row) => row.processed_at == null).length,
        evidenceLinks: 0,
      };
    }
    try {
      return {
        total: Number(this._db.prepare('SELECT COUNT(*) AS c FROM observations').get()?.c) || 0,
        pending:
          Number(
            this._db
              .prepare('SELECT COUNT(*) AS c FROM observations WHERE processed_at IS NULL')
              .get()?.c
          ) || 0,
        evidenceLinks:
          Number(this._db.prepare('SELECT COUNT(*) AS c FROM memory_evidence').get()?.c) || 0,
      };
    } catch (error) {
      logger.warn(
        'ObservationStore',
        '[observations] no se pudo calcular stats:',
        errorMessage(error)
      );
      return { total: 0, pending: 0, evidenceLinks: 0 };
    }
  }

  /** @returns {number} */
  pruneExpired() {
    const now = Date.now();
    if (this._graph.usingFallback) {
      let removed = 0;
      for (const [id, row] of this._memory) {
        if (row.expires_at && row.expires_at <= now) {
          this._memory.delete(id);
          removed++;
        }
      }
      return removed;
    }
    try {
      return this._db
        .prepare('DELETE FROM observations WHERE expires_at IS NOT NULL AND expires_at<=?')
        .run(now).changes;
    } catch (error) {
      logger.warn('ObservationStore', '[observations] no se pudo podar:', errorMessage(error));
      return 0;
    }
  }
}

module.exports = { ObservationStore, SENSITIVITY };
