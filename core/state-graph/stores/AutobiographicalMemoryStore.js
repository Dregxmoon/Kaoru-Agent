// @ts-check
'use strict';

const logger = require('../../observability/Logger.js');

const DAY_MS = 24 * 60 * 60 * 1000;
const TEMPORAL_WORDS = new Set([
  'hoy',
  'ayer',
  'semana',
  'pasada',
  'esta',
  'mes',
  'hace',
  'dias',
  'días',
  'cuando',
  'antes',
  'ultima',
  'última',
  'vez',
]);

/** @param {Date} date */
function _startOfDay(date) {
  const value = new Date(date);
  value.setHours(0, 0, 0, 0);
  return value.getTime();
}

/** @param {Date} date */
function _startOfWeek(date) {
  const value = new Date(date);
  const day = value.getDay() || 7;
  value.setDate(value.getDate() - day + 1);
  return _startOfDay(value);
}

/** @param {number} timestamp @param {number} days */
function _shiftCalendarDays(timestamp, days) {
  const value = new Date(timestamp);
  value.setDate(value.getDate() + days);
  return value.getTime();
}

/**
 * Resuelve expresiones temporales explícitas sin LLM. Los intervalos son
 * locales porque las fechas mostradas al usuario también usan su zona local.
 * @param {string} query
 * @param {number} [now]
 * @returns {{from:number,to:number,label:string}|null}
 */
function resolveTemporalWindow(query, now = Date.now()) {
  const text = String(query || '').toLowerCase();
  const current = new Date(now);
  const today = _startOfDay(current);
  if (/\bayer\b/.test(text)) {
    return { from: _shiftCalendarDays(today, -1), to: today, label: 'ayer' };
  }
  if (/\bhoy\b/.test(text)) {
    return { from: today, to: _shiftCalendarDays(today, 1), label: 'hoy' };
  }

  const daysAgo = /\bhace\s+(\d{1,3})\s+d[ií]as?\b/.exec(text);
  if (daysAgo) {
    const target = _shiftCalendarDays(today, -Math.min(3650, Number(daysAgo[1])));
    return { from: target, to: _shiftCalendarDays(target, 1), label: daysAgo[0] };
  }

  if (/\bsemana\s+pasada\b/.test(text)) {
    const thisWeek = _startOfWeek(current);
    return { from: _shiftCalendarDays(thisWeek, -7), to: thisWeek, label: 'semana pasada' };
  }
  if (/\besta\s+semana\b/.test(text)) {
    return { from: _startOfWeek(current), to: now + 1, label: 'esta semana' };
  }
  if (/\bmes\s+pasado\b/.test(text)) {
    const firstThisMonth = new Date(current.getFullYear(), current.getMonth(), 1).getTime();
    const firstLastMonth = new Date(current.getFullYear(), current.getMonth() - 1, 1).getTime();
    return { from: firstLastMonth, to: firstThisMonth, label: 'mes pasado' };
  }

  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  if (iso) {
    const date = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    if (
      date.getFullYear() === Number(iso[1]) &&
      date.getMonth() === Number(iso[2]) - 1 &&
      date.getDate() === Number(iso[3])
    ) {
      const from = _startOfDay(date);
      return { from, to: _shiftCalendarDays(from, 1), label: iso[0] };
    }
  }
  return null;
}

/** @param {string} text */
function _terms(text) {
  return [
    ...new Set(
      String(text || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((word) => word.length >= 4 && !TEMPORAL_WORDS.has(word))
    ),
  ].slice(0, 8);
}

class AutobiographicalMemoryStore {
  /** @param {any} db @param {any} graph */
  constructor(db, graph) {
    this._db = db;
    this._graph = graph;
    /** @type {Map<number, any>} */
    this._fallback = new Map();
  }

  /**
   * Registra metadatos temporales de un Episode ya persistido. No copia ni
   * reescribe su resumen: el nodo original sigue siendo la fuente canónica.
   * @param {number} nodeId
   * @param {{sessionId?:string|number|null,occurredAt?:number,endedAt?:number|null,salience?:number,evidenceCount?:number,source?:string}} [opts]
   */
  registerEpisode(nodeId, opts = {}) {
    if (!Number.isInteger(nodeId) || nodeId <= 0) return false;
    let sessionStartedAt = 0;
    if (!this._graph.usingFallback && opts.sessionId != null && !opts.occurredAt) {
      try {
        sessionStartedAt =
          Number(
            this._db.prepare('SELECT started_at FROM sessions WHERE id=?').get(opts.sessionId)
              ?.started_at
          ) || 0;
      } catch (_) {}
    }
    const row = {
      nodeId,
      sessionId: opts.sessionId == null ? null : String(opts.sessionId).slice(0, 160),
      occurredAt: Number(opts.occurredAt) || sessionStartedAt || Date.now(),
      endedAt: opts.endedAt == null ? null : Number(opts.endedAt),
      salience: Math.max(0.1, Math.min(1, Number(opts.salience) || 0.5)),
      evidenceCount: Math.max(0, Number(opts.evidenceCount) || 0),
      source: String(opts.source || 'session_summary').slice(0, 40),
    };
    if (this._graph.usingFallback) {
      this._fallback.set(nodeId, row);
      return true;
    }
    try {
      this._db
        .prepare(
          `INSERT INTO autobiographical_events
            (node_id, session_id, occurred_at, ended_at, salience, evidence_count, source, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(node_id) DO UPDATE SET
             session_id=COALESCE(excluded.session_id, autobiographical_events.session_id),
             ended_at=COALESCE(excluded.ended_at, autobiographical_events.ended_at),
             salience=MAX(autobiographical_events.salience, excluded.salience),
             evidence_count=MAX(autobiographical_events.evidence_count, excluded.evidence_count)`
        )
        .run(
          row.nodeId,
          row.sessionId,
          row.occurredAt,
          row.endedAt,
          row.salience,
          row.evidenceCount,
          row.source,
          Date.now()
        );
      return true;
    } catch (error) {
      logger.warn(
        'AutobiographicalMemory',
        `[autobiographical] no se pudo indexar episodio: ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }
  }

  /** @param {string|number} sessionId @param {number} [endedAt] */
  closeSession(sessionId, endedAt = Date.now()) {
    if (this._graph.usingFallback) {
      let changed = 0;
      for (const row of this._fallback.values()) {
        if (row.sessionId === String(sessionId) && row.endedAt == null) {
          row.endedAt = endedAt;
          changed++;
        }
      }
      return changed;
    }
    try {
      return this._db
        .prepare(
          `UPDATE autobiographical_events SET ended_at=?
           WHERE session_id=? AND ended_at IS NULL`
        )
        .run(endedAt, String(sessionId)).changes;
    } catch (_) {
      return 0;
    }
  }

  /** Indexa episodios de versiones anteriores, en lotes acotados. */
  backfillLegacy(limit = 200) {
    const safeLimit = Math.min(500, Math.max(1, Number(limit) || 200));
    if (this._graph.usingFallback) return { indexed: 0 };
    try {
      const rows = /** @type {any[]} */ (
        this._db
          .prepare(
            `SELECT n.id, n.created_at, n.importance,
                    CAST(s.id AS TEXT) AS session_id, s.started_at, s.ended_at,
                    (SELECT COUNT(*) FROM memory_evidence me WHERE me.node_id=n.id) AS evidence_count
             FROM nodes n
             LEFT JOIN autobiographical_events ae ON ae.node_id=n.id
             LEFT JOIN sessions s ON s.episode_id=n.id
             WHERE n.type='Episode' AND ae.node_id IS NULL
             ORDER BY n.created_at ASC LIMIT ?`
          )
          .all(safeLimit)
      );
      for (const row of rows) {
        this.registerEpisode(Number(row.id), {
          sessionId: row.session_id,
          occurredAt: Number(row.started_at) || Number(row.created_at),
          endedAt: row.ended_at == null ? null : Number(row.ended_at),
          salience: Number(row.importance) || 0.5,
          evidenceCount: Number(row.evidence_count) || 0,
          source: 'legacy_episode',
        });
      }
      return { indexed: rows.length };
    } catch (error) {
      logger.warn(
        'AutobiographicalMemory',
        `[autobiographical] backfill falló: ${error instanceof Error ? error.message : String(error)}`
      );
      return { indexed: 0 };
    }
  }

  /**
   * @param {{query?:string,now?:number,from?:number|null,to?:number|null,limit?:number}} [opts]
   * @returns {any[]}
   */
  recall({ query = '', now = Date.now(), from = null, to = null, limit = 3 } = {}) {
    const window = from != null || to != null ? null : resolveTemporalWindow(query, now);
    const rangeFrom = from ?? window?.from ?? null;
    const rangeTo = to ?? window?.to ?? null;
    const safeLimit = Math.min(20, Math.max(1, Number(limit) || 3));
    const candidates = this._candidates(rangeFrom, rangeTo, 200);
    const terms = _terms(query);
    return candidates
      .map((/** @type {any} */ row) => {
        const normalized = String(row.content || '')
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '');
        const matches = terms.filter((term) => normalized.includes(term)).length;
        const ageDays = Math.max(0, (now - Number(row.occurredAt)) / DAY_MS);
        const recency = Math.exp(-ageDays / 45);
        const score =
          Number(row.salience || row.importance || 0.5) * 0.45 +
          recency * 0.25 +
          Math.min(1, matches / Math.max(1, terms.length)) * 0.25 +
          (Number(row.evidenceCount) > 0 ? 0.05 : 0);
        return {
          ...row,
          _topicMatches: matches,
          memory_context: {
            occurredAt: Number(row.occurredAt),
            endedAt: row.endedAt == null ? null : Number(row.endedAt),
            sessionId: row.sessionId ?? null,
            evidenceCount: Number(row.evidenceCount) || 0,
            source: row.source || 'session_summary',
            temporalWindow: window?.label || null,
            score,
          },
        };
      })
      .filter((/** @type {any} */ row) => !terms.length || window || row._topicMatches > 0)
      .sort(
        (/** @type {any} */ a, /** @type {any} */ b) =>
          b.memory_context.score - a.memory_context.score ||
          b.memory_context.occurredAt - a.memory_context.occurredAt
      )
      .slice(0, safeLimit);
  }

  /** @param {number|null} from @param {number|null} to @param {number} limit */
  _candidates(from, to, limit) {
    if (this._graph.usingFallback) {
      return (this._graph._nodes?.getRecentEpisodes?.(limit) || [])
        .map((/** @type {any} */ node) => {
          const meta = this._fallback.get(Number(node.id));
          return {
            ...node,
            occurredAt: meta?.occurredAt || Number(node.created_at),
            endedAt: meta?.endedAt ?? null,
            sessionId: meta?.sessionId ?? null,
            evidenceCount: meta?.evidenceCount || 0,
            source: meta?.source || 'fallback_episode',
            salience: meta?.salience || Number(node.importance),
          };
        })
        .filter((/** @type {any} */ row) => from == null || row.occurredAt >= from)
        .filter((/** @type {any} */ row) => to == null || row.occurredAt < to);
    }
    try {
      let sql = `SELECT n.*, ae.session_id AS sessionId, ae.occurred_at AS occurredAt,
                        ae.ended_at AS endedAt, ae.salience, ae.evidence_count AS evidenceCount,
                        ae.source
                 FROM autobiographical_events ae
                 JOIN nodes n ON n.id=ae.node_id
                 WHERE n.archived=0`;
      const args = [];
      if (from != null) {
        sql += ' AND ae.occurred_at>=?';
        args.push(from);
      }
      if (to != null) {
        sql += ' AND ae.occurred_at<?';
        args.push(to);
      }
      sql += ' ORDER BY ae.occurred_at DESC LIMIT ?';
      args.push(limit);
      return this._db.prepare(sql).all(...args);
    } catch (_) {
      return [];
    }
  }
}

module.exports = { AutobiographicalMemoryStore, resolveTemporalWindow };
