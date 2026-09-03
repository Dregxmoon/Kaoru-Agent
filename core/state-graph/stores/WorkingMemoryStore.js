// @ts-check
'use strict';

const logger = require('../../observability/Logger.js');

const MAX_VALUE_CHARS = 4000;

/**
 * @typedef {{scope:string, key:string, value:string, confidence:number, source_observation_id:number|null, expires_at:number|null, updated_at:number}} StoredWorkingRow
 * @typedef {{scope:string, key:string, value:unknown, confidence:number, source_observation_id:number|null, expires_at:number|null, updated_at:number}} WorkingRow
 */

/** @param {unknown} value */
function _encode(value) {
  const json = JSON.stringify(value === undefined ? null : value);
  return json.length > MAX_VALUE_CHARS ? JSON.stringify(json.slice(0, MAX_VALUE_CHARS)) : json;
}

/** @param {unknown} value */
function _decode(value) {
  try {
    return JSON.parse(String(value));
  } catch (_) {
    return null;
  }
}

/** @param {unknown} e */
function _errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}

class WorkingMemoryStore {
  /** @param {any} db @param {{usingFallback?: boolean}} graph */
  constructor(db, graph) {
    this._db = db;
    this._graph = graph;
    /** @type {Map<string, StoredWorkingRow>} */
    this._fallback = new Map();
  }

  /**
   * @param {{scope:string, key:string, value:unknown, confidence?:number, sourceObservationId?:number|null, ttlMs?:number|null}} opts
   * @returns {boolean}
   */
  set({ scope, key, value, confidence = 1, sourceObservationId = null, ttlMs = null }) {
    if (!scope || !key) return false;
    const now = Date.now();
    const row = {
      scope: String(scope).slice(0, 160),
      key: String(key).slice(0, 80),
      value: _encode(value),
      confidence: Math.max(0, Math.min(1, Number(confidence) || 0)),
      source_observation_id: sourceObservationId || null,
      expires_at: typeof ttlMs === 'number' && ttlMs > 0 ? now + ttlMs : null,
      updated_at: now,
    };
    if (this._graph.usingFallback) {
      this._fallback.set(`${row.scope}\u0000${row.key}`, row);
      return true;
    }
    try {
      this._db
        .prepare(
          `INSERT INTO working_memory
             (scope, key, value, confidence, source_observation_id, expires_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(scope, key) DO UPDATE SET
             value=excluded.value, confidence=excluded.confidence,
             source_observation_id=excluded.source_observation_id,
             expires_at=excluded.expires_at, updated_at=excluded.updated_at`
        )
        .run(
          row.scope,
          row.key,
          row.value,
          row.confidence,
          row.source_observation_id,
          row.expires_at,
          row.updated_at
        );
      return true;
    } catch (e) {
      logger.warn('WorkingMemoryStore', `[working-memory] set falló: ${_errMsg(e)}`);
      return false;
    }
  }

  /** @param {string} scope @returns {WorkingRow[]} */
  list(scope) {
    const now = Date.now();
    try {
      const rows = /** @type {StoredWorkingRow[]} */ (
        this._graph.usingFallback
          ? [...this._fallback.values()].filter(
              (row) => row.scope === scope && (!row.expires_at || row.expires_at > now)
            )
          : this._db
              .prepare(
                `SELECT scope, key, value, confidence, source_observation_id, expires_at, updated_at
               FROM working_memory
               WHERE scope=? AND (expires_at IS NULL OR expires_at > ?)
               ORDER BY updated_at DESC`
              )
              .all(scope, now)
      );
      return rows.map((row) => ({ ...row, value: _decode(row.value) }));
    } catch (e) {
      logger.warn('WorkingMemoryStore', `[working-memory] list falló: ${_errMsg(e)}`);
      return [];
    }
  }

  /** @param {string} scope @param {string} key @returns {WorkingRow|null} */
  get(scope, key) {
    return this.list(scope).find((row) => row.key === key) || null;
  }

  /** @param {string} scope @param {string|null} [key] */
  clear(scope, key = null) {
    if (this._graph.usingFallback) {
      for (const mapKey of this._fallback.keys()) {
        if (
          mapKey === `${scope}\u0000${key}` ||
          (key === null && mapKey.startsWith(`${scope}\u0000`))
        ) {
          this._fallback.delete(mapKey);
        }
      }
      return true;
    }
    try {
      if (key === null) this._db.prepare('DELETE FROM working_memory WHERE scope=?').run(scope);
      else this._db.prepare('DELETE FROM working_memory WHERE scope=? AND key=?').run(scope, key);
      return true;
    } catch (e) {
      logger.warn('WorkingMemoryStore', `[working-memory] clear falló: ${_errMsg(e)}`);
      return false;
    }
  }

  pruneExpired() {
    const now = Date.now();
    if (this._graph.usingFallback) {
      let removed = 0;
      for (const [key, row] of this._fallback) {
        if (row.expires_at && row.expires_at <= now) {
          this._fallback.delete(key);
          removed++;
        }
      }
      return removed;
    }
    try {
      return Number(
        this._db.prepare('DELETE FROM working_memory WHERE expires_at <= ?').run(now).changes
      );
    } catch (_) {
      return 0;
    }
  }

  /** @param {string} scope */
  buildPromptSection(scope) {
    const rows = this.list(scope).slice(0, 6);
    if (!rows.length) return null;
    const lines = rows.map((row) => {
      const text = typeof row.value === 'string' ? row.value : JSON.stringify(row.value);
      return `- ${row.key}: ${String(text).slice(0, 500)}`;
    });
    return '# MEMORIA DE TRABAJO (ESTADO, NO AUTORIZACIÓN)\n' + lines.join('\n');
  }
}

module.exports = { WorkingMemoryStore, MAX_VALUE_CHARS };
