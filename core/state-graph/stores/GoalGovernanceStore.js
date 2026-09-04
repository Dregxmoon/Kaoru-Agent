// @ts-check
'use strict';

const path = require('path');
const logger = require('../../observability/Logger.js');

const AUTONOMY = new Set(['manual', 'suggest', 'act']);
const STATES = new Set([
  'pending',
  'running',
  'waiting_user',
  'waiting_permission',
  'waiting_verification',
  'retry_scheduled',
  'paused',
  'blocked',
  'completed',
]);

/** @param {unknown} error */
function _errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

/** @param {unknown} value @param {number} min @param {number} max @param {number} fallback */
function _bounded(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.round(number))) : fallback;
}

/**
 * @typedef {{autonomy?:string,priority?:number,maxAttempts?:number,maxRuntimeMs?:number,nextRunAt?:number|null}} GovernanceOptions
 * @typedef {{usingFallback?:boolean,getIntention?:(id:number)=>any,recordGoalEvent?:(id:number,ordinal:number|null,type:string,metadata?:object)=>number|null}} GovernanceGraph
 */

class GoalGovernanceStore {
  /** @param {any} db @param {GovernanceGraph} graph */
  constructor(db, graph) {
    this._db = db;
    this._graph = graph;
    /** @type {Map<number, any>} */
    this._fallback = new Map();
  }

  /**
   * Crea la política por defecto sin elevar autonomía. `suggest` puede avisar,
   * pero sólo `act` junto con un permiso persistente permite ejecutar.
   * @param {number} intentionId
   * @param {string} workspace
   * @param {GovernanceOptions} [options]
   */
  ensure(intentionId, workspace, options = {}) {
    const id = Number(intentionId);
    const scope = workspace ? path.resolve(String(workspace)) : '';
    if (!Number.isInteger(id) || id <= 0 || !scope) return null;
    const existing = this.get(id);
    if (existing) return existing;
    const now = Date.now();
    const row = {
      intentionId: id,
      workspace: scope,
      state: 'pending',
      autonomy: AUTONOMY.has(String(options.autonomy)) ? String(options.autonomy) : 'suggest',
      priority: _bounded(options.priority, 0, 100, 50),
      attempts: 0,
      maxAttempts: _bounded(options.maxAttempts, 1, 20, 3),
      maxRuntimeMs: _bounded(options.maxRuntimeMs, 30_000, 60 * 60 * 1000, 15 * 60 * 1000),
      nextRunAt: Number(options.nextRunAt) || now,
      leaseUntil: null,
      lastRunAt: null,
      lastSuggestedAt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    if (this._graph.usingFallback) {
      this._fallback.set(id, row);
      return { ...row };
    }
    try {
      this._db
        .prepare(
          `INSERT OR IGNORE INTO goal_governance
           (intention_id, workspace, state, autonomy, priority, attempts, max_attempts,
            max_runtime_ms, next_run_at, lease_until, last_run_at, last_suggested_at,
            last_error, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          row.intentionId,
          row.workspace,
          row.state,
          row.autonomy,
          row.priority,
          row.attempts,
          row.maxAttempts,
          row.maxRuntimeMs,
          row.nextRunAt,
          row.leaseUntil,
          row.lastRunAt,
          row.lastSuggestedAt,
          row.lastError,
          row.createdAt,
          row.updatedAt
        );
      return this.get(id);
    } catch (error) {
      logger.warn('GoalGovernanceStore', `[goal-governor] ensure falló: ${_errorText(error)}`);
      return null;
    }
  }

  /** @param {number} intentionId */
  get(intentionId) {
    const id = Number(intentionId);
    if (this._graph.usingFallback) {
      const row = this._fallback.get(id);
      return row ? { ...row } : null;
    }
    try {
      const row = this._db.prepare('SELECT * FROM goal_governance WHERE intention_id=?').get(id);
      return row ? this._view(row) : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * @param {number} intentionId
   * @param {{autonomy?:string,priority?:number,maxAttempts?:number,maxRuntimeMs?:number,nextRunAt?:number|null,state?:string,lastError?:string|null}} update
   */
  configure(intentionId, update = {}) {
    const intention = this._graph.getIntention?.(Number(intentionId));
    if (!intention) return null;
    const current =
      this.ensure(Number(intentionId), intention.workspace || '') || this.get(intentionId);
    if (!current) return null;
    const row = {
      ...current,
      autonomy: AUTONOMY.has(String(update.autonomy)) ? String(update.autonomy) : current.autonomy,
      priority:
        update.priority === undefined
          ? current.priority
          : _bounded(update.priority, 0, 100, current.priority),
      maxAttempts:
        update.maxAttempts === undefined
          ? current.maxAttempts
          : _bounded(update.maxAttempts, 1, 20, current.maxAttempts),
      maxRuntimeMs:
        update.maxRuntimeMs === undefined
          ? current.maxRuntimeMs
          : _bounded(update.maxRuntimeMs, 30_000, 60 * 60 * 1000, current.maxRuntimeMs),
      nextRunAt:
        update.nextRunAt === undefined
          ? current.nextRunAt
          : update.nextRunAt == null
            ? null
            : Number(update.nextRunAt),
      state: STATES.has(String(update.state))
        ? String(update.state)
        : update.autonomy &&
            ['waiting_user', 'waiting_permission', 'blocked'].includes(current.state)
          ? 'pending'
          : current.state,
      lastError:
        update.lastError === undefined
          ? current.lastError
          : String(update.lastError || '').slice(0, 1000) || null,
      updatedAt: Date.now(),
    };
    return this._write(row);
  }

  /** @param {{workspace:string,now?:number,limit?:number}} input */
  listRunnable({ workspace, now = Date.now(), limit = 5 }) {
    const scope = workspace ? path.resolve(String(workspace)) : '';
    if (!scope) return [];
    if (this._graph.usingFallback) {
      return [...this._fallback.values()]
        .filter(
          (row) =>
            row.workspace === scope &&
            ['pending', 'retry_scheduled', 'running'].includes(row.state) &&
            row.attempts < row.maxAttempts &&
            (!row.nextRunAt || row.nextRunAt <= now) &&
            (!row.leaseUntil || row.leaseUntil <= now)
        )
        .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt)
        .slice(0, limit)
        .map((row) => ({ ...row, intention: this._graph.getIntention?.(row.intentionId) }));
    }
    try {
      return /** @type {any[]} */ (
        this._db
          .prepare(
            `SELECT gg.*, i.goal, i.status AS intention_status, i.last_progress
             FROM goal_governance gg JOIN intentions i ON i.id=gg.intention_id
             WHERE i.status='active' AND gg.workspace=?
               AND gg.state IN ('pending','retry_scheduled','running')
               AND gg.attempts < gg.max_attempts
               AND (gg.next_run_at IS NULL OR gg.next_run_at<=?)
               AND (gg.lease_until IS NULL OR gg.lease_until<=?)
             ORDER BY gg.priority DESC, gg.created_at ASC LIMIT ?`
          )
          .all(scope, now, now, Math.max(1, Math.min(20, Number(limit) || 5)))
      ).map((row) => ({
        ...this._view(row),
        intention: {
          id: Number(row.intention_id),
          goal: String(row.goal),
          status: String(row.intention_status),
          workspace: String(row.workspace),
          last_progress: row.last_progress == null ? null : String(row.last_progress),
        },
      }));
    } catch (error) {
      logger.warn('GoalGovernanceStore', `[goal-governor] consulta falló: ${_errorText(error)}`);
      return [];
    }
  }

  /** @param {number} intentionId @param {{source?:string,now?:number,leaseMs?:number}} [input] */
  claim(intentionId, { source = 'interactive', now = Date.now(), leaseMs = 15 * 60 * 1000 } = {}) {
    const current = this.get(intentionId);
    const autonomousAttempt = source === 'governor';
    if (
      !current ||
      (autonomousAttempt && current.attempts >= current.maxAttempts) ||
      (current.leaseUntil && current.leaseUntil > now)
    ) {
      return null;
    }
    const leaseUntil = now + _bounded(leaseMs, 30_000, 60 * 60 * 1000, current.maxRuntimeMs);
    if (!this._graph.usingFallback) {
      try {
        const info = this._db
          .prepare(
            `UPDATE goal_governance
             SET state='running', attempts=attempts+?, lease_until=?, last_run_at=?,
                 last_error=NULL, updated_at=?
             WHERE intention_id=? AND (?=0 OR attempts<max_attempts)
               AND (lease_until IS NULL OR lease_until<=?)`
          )
          .run(
            autonomousAttempt ? 1 : 0,
            leaseUntil,
            now,
            now,
            Number(intentionId),
            autonomousAttempt ? 1 : 0,
            now
          );
        if (!info.changes) return null;
        const written = this.get(Number(intentionId));
        this._graph.recordGoalEvent?.(Number(intentionId), null, 'governor_claimed', { source });
        return written;
      } catch (error) {
        logger.warn('GoalGovernanceStore', `[goal-governor] claim falló: ${_errorText(error)}`);
        return null;
      }
    }
    const row = {
      ...current,
      state: 'running',
      attempts: current.attempts + (autonomousAttempt ? 1 : 0),
      leaseUntil,
      lastRunAt: now,
      lastError: null,
      updatedAt: now,
    };
    const written = this._write(row);
    if (written) {
      this._graph.recordGoalEvent?.(Number(intentionId), null, 'governor_claimed', { source });
    }
    return written;
  }

  /** @param {number} intentionId @param {{state:string,error?:string|null,nextRunAt?:number|null,now?:number,verification?:string}} input */
  settle(intentionId, input) {
    const current = this.get(intentionId);
    if (!current) return null;
    const state = STATES.has(String(input.state)) ? String(input.state) : 'blocked';
    const row = {
      ...current,
      state,
      leaseUntil: null,
      nextRunAt: input.nextRunAt == null ? null : Number(input.nextRunAt),
      lastError: String(input.error || '').slice(0, 1000) || null,
      updatedAt: Number(input.now) || Date.now(),
    };
    const written = this._write(row);
    if (written) {
      this._graph.recordGoalEvent?.(Number(intentionId), null, `governor_${state}`, {
        attempts: row.attempts,
        verification: input.verification || null,
        error: row.lastError,
      });
    }
    return written;
  }

  /** @param {number} intentionId @param {number} [now] */
  markSuggested(intentionId, now = Date.now()) {
    const current = this.get(intentionId);
    if (!current) return null;
    return this._write({
      ...current,
      state: 'waiting_user',
      lastSuggestedAt: now,
      leaseUntil: null,
      updatedAt: now,
    });
  }

  /** @param {any} row */
  _write(row) {
    if (this._graph.usingFallback) {
      this._fallback.set(Number(row.intentionId), { ...row });
      return { ...row };
    }
    try {
      this._db
        .prepare(
          `UPDATE goal_governance SET workspace=?, state=?, autonomy=?, priority=?, attempts=?,
             max_attempts=?, max_runtime_ms=?, next_run_at=?, lease_until=?, last_run_at=?,
             last_suggested_at=?, last_error=?, updated_at=? WHERE intention_id=?`
        )
        .run(
          row.workspace,
          row.state,
          row.autonomy,
          row.priority,
          row.attempts,
          row.maxAttempts,
          row.maxRuntimeMs,
          row.nextRunAt,
          row.leaseUntil,
          row.lastRunAt,
          row.lastSuggestedAt,
          row.lastError,
          row.updatedAt,
          row.intentionId
        );
      return this.get(Number(row.intentionId));
    } catch (error) {
      logger.warn('GoalGovernanceStore', `[goal-governor] escritura falló: ${_errorText(error)}`);
      return null;
    }
  }

  /** @param {any} row */
  _view(row) {
    return {
      intentionId: Number(row.intention_id),
      workspace: String(row.workspace),
      state: String(row.state),
      autonomy: String(row.autonomy),
      priority: Number(row.priority),
      attempts: Number(row.attempts),
      maxAttempts: Number(row.max_attempts),
      maxRuntimeMs: Number(row.max_runtime_ms),
      nextRunAt: row.next_run_at == null ? null : Number(row.next_run_at),
      leaseUntil: row.lease_until == null ? null : Number(row.lease_until),
      lastRunAt: row.last_run_at == null ? null : Number(row.last_run_at),
      lastSuggestedAt: row.last_suggested_at == null ? null : Number(row.last_suggested_at),
      lastError: row.last_error == null ? null : String(row.last_error),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
}

module.exports = { GoalGovernanceStore, AUTONOMY, STATES };
