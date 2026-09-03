// @ts-check
'use strict';

const logger = require('../../observability/Logger.js');

const STEP_STATUS = new Set([
  'pending',
  'in_progress',
  'awaiting_verification',
  'completed',
  'blocked',
  'skipped',
]);
const COMPLETION_EVIDENCE = new Set(['verified', 'not_applicable']);

/** @param {unknown} e */
function _errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}

/** @param {unknown} raw @param {unknown} fallback @returns {any} */
function _json(raw, fallback) {
  try {
    return JSON.parse(String(raw));
  } catch (_) {
    return fallback;
  }
}

/**
 * @typedef {{description?:string, label?:string, step?:string, dependsOn?:unknown[], parentOrdinal?:number, status?:string, successCriteria?:unknown[], verification?:object|null, triggerContext?:{event?:string,match?:Record<string,unknown>}|null, dueAt?:number|null}} GoalStepInput
 * @typedef {{status?:string, reason?:string, source?:string, at?:number}} VerificationEvidence
 * @typedef {{id:number|null, intentionId:number, ordinal:number, parentOrdinal:number|null, description:string, status:string, dependsOn:number[], successCriteria:string[], verification:object|null, triggerContext:{event?:string,match?:Record<string,unknown>}|null, dueAt:number|null, createdAt:number|null, updatedAt:number|null}} GoalStep
 * @typedef {{intentionId:number, ordinal:number|null, type:string, metadata:object, createdAt:number}} GoalEvent
 */

class GoalPlanStore {
  /** @param {any} db @param {{usingFallback?:boolean}} graph */
  constructor(db, graph) {
    this._db = db;
    this._graph = graph;
    /** @type {Map<number, GoalStep[]>} */
    this._fallbackPlans = new Map();
    /** @type {GoalEvent[]} */
    this._fallbackEvents = [];
  }

  /** @param {string|GoalStepInput} step @param {number} index @param {number} intentionId */
  _normalize(step, index, intentionId) {
    const item = /** @type {GoalStepInput} */ (step && typeof step === 'object' ? step : {});
    const description =
      typeof step === 'string'
        ? step
        : String(item.description || item.label || item.step || `Paso ${index + 1}`);
    const dependsOn = Array.isArray(item.dependsOn)
      ? item.dependsOn.map(Number).filter((n) => Number.isInteger(n) && n > 0 && n <= index)
      : index > 0
        ? [index]
        : [];
    return /** @type {GoalStep} */ ({
      id: null,
      intentionId,
      ordinal: index + 1,
      parentOrdinal: Number.isInteger(Number(item.parentOrdinal))
        ? Number(item.parentOrdinal)
        : null,
      description: description.slice(0, 1000),
      status: STEP_STATUS.has(String(item.status)) ? String(item.status) : 'pending',
      dependsOn: [...new Set(dependsOn)],
      successCriteria: Array.isArray(item.successCriteria)
        ? item.successCriteria
            .map(String)
            .map((s) => s.slice(0, 500))
            .slice(0, 8)
        : [],
      verification:
        item.verification && typeof item.verification === 'object' ? item.verification : null,
      triggerContext:
        item.triggerContext && typeof item.triggerContext === 'object'
          ? {
              event: String(item.triggerContext.event || '').slice(0, 100),
              match:
                item.triggerContext.match && typeof item.triggerContext.match === 'object'
                  ? item.triggerContext.match
                  : {},
            }
          : null,
      dueAt: item.dueAt != null && Number.isFinite(Number(item.dueAt)) ? Number(item.dueAt) : null,
      createdAt: null,
      updatedAt: null,
    });
  }

  /** @param {number} intentionId @param {Array<string|object>} steps */
  createPlan(intentionId, steps = []) {
    if (!intentionId || !Array.isArray(steps) || !steps.length) return [];
    const normalized = steps
      .slice(0, 50)
      .map((step, index) => this._normalize(step, index, intentionId));
    const now = Date.now();
    if (this._graph.usingFallback) {
      const stored = normalized.map((step, index) => ({
        ...step,
        id: index + 1,
        createdAt: now,
        updatedAt: now,
      }));
      this._fallbackPlans.set(intentionId, stored);
      return stored;
    }
    try {
      const insert = this._db.prepare(
        `INSERT OR IGNORE INTO goal_steps
          (intention_id, ordinal, parent_ordinal, description, status, depends_on,
           success_criteria, verification, trigger_context, due_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const run = this._db.transaction(() => {
        for (const step of normalized) {
          insert.run(
            intentionId,
            step.ordinal,
            step.parentOrdinal,
            step.description,
            step.status,
            JSON.stringify(step.dependsOn),
            JSON.stringify(step.successCriteria),
            step.verification ? JSON.stringify(step.verification) : null,
            step.triggerContext ? JSON.stringify(step.triggerContext) : null,
            step.dueAt,
            now,
            now
          );
        }
      });
      run();
      this.recordEvent(intentionId, null, 'plan_created', { steps: normalized.length });
      return this.listSteps(intentionId);
    } catch (e) {
      logger.warn('GoalPlanStore', `[goal-plan] no se pudo crear plan: ${_errMsg(e)}`);
      return [];
    }
  }

  /** @param {number} intentionId @returns {GoalStep[]} */
  listSteps(intentionId) {
    if (this._graph.usingFallback)
      return (this._fallbackPlans.get(intentionId) || []).map((s) => ({ ...s }));
    try {
      const rows = /** @type {any[]} */ (
        this._db
          .prepare(
            `SELECT id, intention_id, ordinal, parent_ordinal, description, status,
                  depends_on, success_criteria, verification, trigger_context, due_at,
                  created_at, updated_at
           FROM goal_steps WHERE intention_id=? ORDER BY ordinal ASC`
          )
          .all(intentionId)
      );
      return rows.map((row) => ({
        id: Number(row.id),
        intentionId: Number(row.intention_id),
        ordinal: Number(row.ordinal),
        parentOrdinal: row.parent_ordinal == null ? null : Number(row.parent_ordinal),
        description: String(row.description),
        status: String(row.status),
        dependsOn: _json(row.depends_on, []),
        successCriteria: _json(row.success_criteria, []),
        verification: row.verification ? _json(row.verification, null) : null,
        triggerContext: row.trigger_context ? _json(row.trigger_context, null) : null,
        dueAt: row.due_at == null ? null : Number(row.due_at),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
      }));
    } catch (e) {
      logger.warn('GoalPlanStore', `[goal-plan] no se pudo leer plan: ${_errMsg(e)}`);
      return [];
    }
  }

  /**
   * @param {number} intentionId
   * @param {number} ordinal
   * @param {{status:string, verification?:VerificationEvidence|null, reason?:string}} update
   */
  updateStep(intentionId, ordinal, update) {
    if (!STEP_STATUS.has(update.status)) return false;
    const evidence = /** @type {VerificationEvidence|null} */ (
      update.verification && typeof update.verification === 'object' ? update.verification : null
    );
    let status = update.status;
    if (status === 'completed' && !COMPLETION_EVIDENCE.has(String(evidence?.status || ''))) {
      status = 'awaiting_verification';
    }
    const now = Date.now();
    if (this._graph.usingFallback) {
      const steps = this._fallbackPlans.get(intentionId) || [];
      const step = steps.find((item) => item.ordinal === ordinal);
      if (!step) return false;
      step.status = status;
      step.verification = evidence;
      step.updatedAt = now;
      return true;
    }
    try {
      const info = this._db
        .prepare(
          `UPDATE goal_steps SET status=?, verification=?, updated_at=?
           WHERE intention_id=? AND ordinal=?`
        )
        .run(status, evidence ? JSON.stringify(evidence) : null, now, intentionId, ordinal);
      if (!info.changes) return false;
      this.recordEvent(intentionId, ordinal, 'step_updated', {
        requestedStatus: update.status,
        status,
        verificationStatus: evidence?.status || null,
        reason: String(update.reason || '').slice(0, 500),
      });
      return true;
    } catch (e) {
      logger.warn('GoalPlanStore', `[goal-plan] no se pudo actualizar paso: ${_errMsg(e)}`);
      return false;
    }
  }

  /** @param {number} intentionId */
  getResumePoint(intentionId) {
    const steps = this.listSteps(intentionId);
    const completed = new Set(
      steps.filter((step) => step.status === 'completed').map((step) => step.ordinal)
    );
    const awaiting = steps.find((step) => step.status === 'awaiting_verification');
    if (awaiting) return { state: 'verify', step: awaiting, blockedBy: [] };
    const ready = steps.find(
      (step) =>
        ['pending', 'in_progress'].includes(step.status) &&
        step.dependsOn.every((dependency) => completed.has(dependency))
    );
    if (ready) return { state: 'ready', step: ready, blockedBy: [] };
    const incomplete = steps.find((step) => !['completed', 'skipped'].includes(step.status));
    if (!incomplete) return { state: 'complete', step: null, blockedBy: [] };
    return {
      state: 'blocked',
      step: incomplete,
      blockedBy: incomplete.dependsOn.filter((dependency) => !completed.has(dependency)),
    };
  }

  /** @param {number} intentionId @param {{done?:number,total?:number}} plan */
  recordRunProgress(intentionId, plan = {}) {
    const steps = this.listSteps(intentionId);
    const observed = Math.min(Math.max(0, Number(plan.done) || 0), steps.length);
    for (let index = 0; index < observed; index++) {
      const step = steps[index];
      if (step.status === 'pending' || step.status === 'in_progress') {
        this.updateStep(intentionId, step.ordinal, {
          status: 'awaiting_verification',
          verification: { status: 'unverified', source: 'tool_progress' },
          reason: 'La corrida observó progreso, pero no verificó este paso individual.',
        });
      }
    }
    const next = steps[observed];
    if (next && next.status === 'pending') {
      this.updateStep(intentionId, next.ordinal, { status: 'in_progress' });
    }
    return this.getResumePoint(intentionId);
  }

  /** @param {number} intentionId @param {VerificationEvidence} verification */
  completePlan(intentionId, verification) {
    if (!COMPLETION_EVIDENCE.has(String(verification?.status || ''))) return false;
    const steps = this.listSteps(intentionId);
    for (const step of steps) {
      if (step.status !== 'skipped') {
        this.updateStep(intentionId, step.ordinal, { status: 'completed', verification });
      }
    }
    this.recordEvent(intentionId, null, 'plan_completed', {
      verificationStatus: verification.status,
      reason: verification.reason || null,
    });
    return true;
  }

  /** @param {number} intentionId @param {number|null} ordinal @param {string} type @param {object} [metadata] */
  recordEvent(intentionId, ordinal, type, metadata = {}) {
    const event = {
      intentionId,
      ordinal,
      type: String(type).slice(0, 80),
      metadata: JSON.parse(JSON.stringify(metadata)),
      createdAt: Date.now(),
    };
    if (this._graph.usingFallback) {
      this._fallbackEvents.push(event);
      return this._fallbackEvents.length;
    }
    try {
      const info = this._db
        .prepare(
          `INSERT INTO goal_events (intention_id, step_ordinal, event_type, metadata, created_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(intentionId, ordinal, event.type, JSON.stringify(event.metadata), event.createdAt);
      return Number(info.lastInsertRowid);
    } catch (e) {
      logger.warn('GoalPlanStore', `[goal-plan] no se pudo registrar evento: ${_errMsg(e)}`);
      return null;
    }
  }

  /** @param {number} intentionId @param {{limit?:number}} [opts] */
  listEvents(intentionId, { limit = 100 } = {}) {
    if (this._graph.usingFallback) {
      return this._fallbackEvents
        .filter((event) => event.intentionId === intentionId)
        .slice(-limit);
    }
    try {
      return /** @type {any[]} */ (
        this._db
          .prepare(
            `SELECT id, intention_id, step_ordinal, event_type, metadata, created_at
           FROM goal_events WHERE intention_id=? ORDER BY id DESC LIMIT ?`
          )
          .all(intentionId, limit)
      ).map((row) => ({
        id: Number(row.id),
        intentionId: Number(row.intention_id),
        ordinal: row.step_ordinal == null ? null : Number(row.step_ordinal),
        type: String(row.event_type),
        metadata: _json(row.metadata, {}),
        createdAt: Number(row.created_at),
      }));
    } catch (_) {
      return [];
    }
  }

  /**
   * Busca recordatorios cuyo evento/contexto coincide y cuyo paso es el punto
   * actual de reanudación. Aplica cooldown de una hora por paso.
   * @param {string} event
   * @param {Record<string,unknown>} payload
   * @param {number} [now]
   */
  findCues(event, payload = {}, now = Date.now()) {
    if (this._graph.usingFallback) return [];
    try {
      const rows = /** @type {any[]} */ (
        this._db
          .prepare(
            `SELECT gs.intention_id, gs.ordinal, gs.description, gs.trigger_context,
                    gs.due_at, i.goal
             FROM goal_steps gs JOIN intentions i ON i.id=gs.intention_id
             WHERE i.status='active'
               AND gs.status NOT IN ('completed','skipped')
               AND gs.trigger_context IS NOT NULL
               AND (gs.due_at IS NULL OR gs.due_at <= ?)`
          )
          .all(now)
      );
      /** @type {Array<{intentionId:number, ordinal:number, goal:string, description:string, dueAt:number|null}>} */
      const cues = [];
      for (const row of rows) {
        const trigger = _json(row.trigger_context, null);
        if (!trigger || trigger.event !== event) continue;
        const matches = trigger.match && typeof trigger.match === 'object' ? trigger.match : {};
        if (
          !Object.entries(matches).every(([key, value]) =>
            Object.prototype.hasOwnProperty.call(payload, key)
              ? String(payload[key]) === String(value)
              : false
          )
        ) {
          continue;
        }
        const resume = this.getResumePoint(Number(row.intention_id));
        if (!resume.step || resume.step.ordinal !== Number(row.ordinal)) continue;
        const recent = this._db
          .prepare(
            `SELECT 1 FROM goal_events
             WHERE intention_id=? AND step_ordinal=? AND event_type='cue_emitted' AND created_at>?
             LIMIT 1`
          )
          .get(Number(row.intention_id), Number(row.ordinal), now - 60 * 60 * 1000);
        if (recent) continue;
        const cue = {
          intentionId: Number(row.intention_id),
          ordinal: Number(row.ordinal),
          goal: String(row.goal),
          description: String(row.description),
          dueAt: row.due_at == null ? null : Number(row.due_at),
        };
        this.recordEvent(cue.intentionId, cue.ordinal, 'cue_emitted', { event });
        cues.push(cue);
      }
      return cues;
    } catch (e) {
      logger.warn('GoalPlanStore', `[goal-plan] búsqueda de cues falló: ${_errMsg(e)}`);
      return [];
    }
  }
}

module.exports = { GoalPlanStore, STEP_STATUS, COMPLETION_EVIDENCE };
