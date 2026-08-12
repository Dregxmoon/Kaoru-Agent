// @ts-check
'use strict';

/**
 * IntentionsStore.js — Fase 3, ítem 1: metas persistentes.
 *
 * Persiste un STACK de intenciones activas (metas en vuelo) asociadas a una
 * sesión. Modela el ciclo "usuario pide una tarea → se interrumpe (cancel /
 * max_iterations / cierre de ventana) → la intención queda 'active' → al
 * reanudar se re-inyecta al prompt del agente para re-planificar".
 *
 * Semántica de stack: las intenciones activas se listan de la más reciente
 * (tope del stack) a la más antigua; al completar/dropear la del tope, la
 * siguiente queda como candidata a retomar. Las intenciones no mueren con la
 * sesión (status 'active' persiste entre sesiones hasta que se resuelven).
 */

const logger = require('../../observability/Logger.js');

const STATUS = ['active', 'done', 'dropped'];

/**
 * Mensaje seguro de un `catch` (el tipo es `unknown` con el tsconfig actual;
 * `e.message` no es accesible sin narrowing).
 * @param {unknown} e
 * @returns {string}
 */
function _errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}

/**
 * @typedef {{
 *   id: number,
 *   session_id: string,
 *   goal: string,
 *   status: string,
 *   steps: string,
 *   last_progress: string | null,
 *   last_progress_at: number,
 *   created_at: number,
 *   updated_at: number,
 * }} IntentionRow
 */

class IntentionsStore {
  /**
   * @param {any} db  Base de datos (better-sqlite3 o emulador de memoria).
   * @param {any} graph  Estado compartido (StateGraph), para usingFallback.
   */
  constructor(db, graph) {
    this._db = db;
    this._g = graph;
  }

  /**
   * Crea una intención activa (empuja al tope del stack).
   * @param {{sessionId: string, goal: string, steps?: Array<object>, lastProgress?: string}} opts
   * @returns {number | null} id de la intención, o null en modo memoria.
   */
  create({ sessionId, goal, steps = [], lastProgress = '' }) {
    if (this._g.usingFallback || !sessionId || !goal) return null;
    const now = Date.now();
    try {
      const info = this._db
        .prepare(
          `INSERT INTO intentions (session_id, goal, status, steps, last_progress, last_progress_at, created_at, updated_at)
           VALUES (?, ?, 'active', ?, ?, ?, ?, ?)`
        )
        .run(
          String(sessionId),
          String(goal),
          JSON.stringify(steps),
          String(lastProgress || ''),
          now,
          now,
          now
        );
      return Number(info.lastInsertRowid);
    } catch (e) {
      logger.warn('IntentionsStore', `[intentions] no se pudo crear intención: ${_errMsg(e)}`);
      return null;
    }
  }

  /**
   * Stack de intenciones activas: del tope (más reciente) hacia abajo.
   * @param {{limit?: number}} [opts]
   * @returns {IntentionRow[]}
   */
  listActive({ limit = 10 } = {}) {
    if (this._g.usingFallback) return [];
    try {
      const rows = this._db
        .prepare(
          `SELECT id, session_id, goal, status, steps, last_progress, last_progress_at, created_at, updated_at
           FROM intentions WHERE status='active'
           ORDER BY updated_at DESC, id DESC LIMIT ?`
        )
        .all(limit);
      return /** @type {IntentionRow[]} */ (rows);
    } catch (e) {
      logger.warn('IntentionsStore', `[intentions] error listando activas: ${_errMsg(e)}`);
      return [];
    }
  }

  /**
   * @param {number} id
   * @returns {IntentionRow | undefined}
   */
  get(id) {
    if (this._g.usingFallback) return undefined;
    try {
      return /** @type {IntentionRow | undefined} */ (
        this._db
          .prepare(
            `SELECT id, session_id, goal, status, steps, last_progress, last_progress_at, created_at, updated_at
             FROM intentions WHERE id=?`
          )
          .get(id)
      );
    } catch (e) {
      logger.warn('IntentionsStore', `[intentions] error leyendo ${id}: ${_errMsg(e)}`);
      return undefined;
    }
  }

  /**
   * Actualiza estado/progreso y "toca" updated_at (mueve al tope del stack).
   * Cualquier mutación cuenta como ACTIVIDAD de la intención: también sube
   * `last_progress_at` (cuándo hubo movimiento por última vez). Un status
   * 'done'/'dropped' deja de ser candidata a stale porque ya no está 'active'.
   * @param {number} id
   * @param {{status?: string, steps?: Array<object>, lastProgress?: string}} [opts]
   * @returns {boolean}
   */
  update(id, opts = {}) {
    if (this._g.usingFallback) return false;
    try {
      const row = this.get(id);
      if (!row) return false;
      const status = opts.status ? String(opts.status) : row.status;
      if (!STATUS.includes(status)) {
        logger.warn('IntentionsStore', `[intentions] status inválido: ${status}`);
        return false;
      }
      const steps = opts.steps ? JSON.stringify(opts.steps) : row.steps;
      const lastProgress =
        opts.lastProgress !== undefined ? String(opts.lastProgress) : row.last_progress;
      const now = Date.now();
      this._db
        .prepare(
          `UPDATE intentions SET status=?, steps=?, last_progress=?, updated_at=?, last_progress_at=? WHERE id=?`
        )
        .run(status, steps, lastProgress, now, now, id);
      return true;
    } catch (e) {
      logger.warn('IntentionsStore', `[intentions] error actualizando ${id}: ${_errMsg(e)}`);
      return false;
    }
  }

  /** @param {number} id */
  complete(id) {
    return this.update(id, { status: 'done' });
  }

  /** @param {number} id */
  drop(id) {
    return this.update(id, { status: 'dropped' });
  }

  /**
   * Intenciones activas ABANDONADAS: no tuvieron actividad (last_progress_at)
   * en los últimos `olderThanMs` ms. Se usan para preguntar con curiosidad por
   * metas que el usuario dejó a medias ("dijiste que ibas a X, ¿cómo va?").
   * El orden es el de más abandonada primero (last_progress_at ASC).
   * @param {{olderThanMs?: number, limit?: number}} [opts]
   * @returns {IntentionRow[]}
   */
  listStale({ olderThanMs, limit = 10 } = {}) {
    if (this._g.usingFallback || typeof olderThanMs !== 'number' || olderThanMs <= 0) return [];
    try {
      const cutoff = Date.now() - olderThanMs;
      const rows = this._db
        .prepare(
          `SELECT id, session_id, goal, status, steps, last_progress, last_progress_at, created_at, updated_at
           FROM intentions WHERE status='active' AND last_progress_at < ?
           ORDER BY last_progress_at ASC, id DESC LIMIT ?`
        )
        .all(cutoff, limit);
      return /** @type {IntentionRow[]} */ (rows);
    } catch (e) {
      logger.warn('IntentionsStore', `[intentions] error listando stale: ${_errMsg(e)}`);
      return [];
    }
  }

  /** @returns {{active: number, done: number, dropped: number}} */
  getStats() {
    if (this._g.usingFallback) return { active: 0, done: 0, dropped: 0 };
    try {
      const rows = this._db
        .prepare('SELECT status, COUNT(*) as c FROM intentions GROUP BY status')
        .all();
      const by = { active: 0, done: 0, dropped: 0 };
      for (const r of rows) {
        const status = /** @type {keyof typeof by} */ (r.status);
        if (status in by) by[status] = Number(r.c);
      }
      return by;
    } catch (e) {
      logger.warn('IntentionsStore', `[intentions] error en stats: ${_errMsg(e)}`);
      return { active: 0, done: 0, dropped: 0 };
    }
  }
}

module.exports = { IntentionsStore };
