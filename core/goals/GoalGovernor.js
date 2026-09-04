// @ts-check
'use strict';

const logger = require('../observability/Logger.js');
const { evaluateTaskOutcome } = require('../learning/OutcomeEvaluator.js');
const { settleGoal } = require('../memory/GoalLifecycle.js');

const DEFAULT_INTERVAL_MS = 60 * 1000;
const START_DELAY_MS = 30 * 1000;

/** @param {unknown} error */
function _errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

class GoalGovernor {
  /**
   * @param {object} options
   * @param {any} options.graph
   * @param {any} options.bus
   * @param {()=>string|null} options.getWorkspace
   * @param {()=>string|null} options.getSessionId
   * @param {()=>any} options.getPermissionManager
   * @param {(goal:string,options:object)=>Promise<any>} options.execute
   * @param {number} [options.intervalMs]
   */
  constructor(options) {
    this._graph = options.graph;
    this._bus = options.bus;
    this._getWorkspace = options.getWorkspace;
    this._getSessionId = options.getSessionId;
    this._getPermissionManager = options.getPermissionManager;
    this._execute = options.execute;
    this._intervalMs = Math.max(10_000, Number(options.intervalMs) || DEFAULT_INTERVAL_MS);
    this._timer = null;
    this._startTimer = null;
    this._running = false;
    this._evaluating = false;
    this._activeController = null;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._startTimer = setTimeout(() => this.tick().catch(() => {}), START_DELAY_MS);
    this._timer = setInterval(() => this.tick().catch(() => {}), this._intervalMs);
    this._startTimer.unref?.();
    this._timer.unref?.();
    logger.info('GoalGovernor', '[goal-governor] iniciado');
  }

  stop() {
    if (this._startTimer) clearTimeout(this._startTimer);
    if (this._timer) clearInterval(this._timer);
    this._startTimer = null;
    this._timer = null;
    this._running = false;
    this._activeController?.abort();
    this._activeController = null;
  }

  /** Evalúa como máximo un objetivo por ciclo para evitar tormentas de trabajo. */
  async tick(now = Date.now()) {
    if (this._evaluating || !this._graph || this._graph.usingFallback) {
      return { state: 'idle', reason: 'busy_or_no_persistence' };
    }
    const workspace = this._getWorkspace?.();
    const sessionId = this._getSessionId?.();
    if (!workspace || !sessionId) return { state: 'idle', reason: 'no_active_scope' };
    this._evaluating = true;
    try {
      const active = this._graph.listActiveIntentions?.({ limit: 50, workspace }) || [];
      for (const intention of active) {
        this._graph.ensureGoalGovernance?.(intention.id, workspace);
      }
      const candidate = this._graph.listRunnableGoals?.({ workspace, now, limit: 1 })?.[0];
      if (!candidate?.intention?.goal) return { state: 'idle', reason: 'no_runnable_goal' };

      if (candidate.autonomy === 'manual') {
        this._graph.settleGoalGovernance?.(candidate.intentionId, { state: 'paused' });
        return { state: 'paused', intentionId: candidate.intentionId };
      }
      if (candidate.autonomy !== 'act') {
        this._suggest(candidate, now, 'ready');
        return { state: 'suggested', intentionId: candidate.intentionId };
      }

      const permission = this._getPermissionManager?.()?.check?.({
        tool: 'goal_run',
        path: workspace,
        defaultAction: 'ask',
      });
      if (permission?.action !== 'allow' || !permission.rule) {
        this._graph.settleGoalGovernance?.(candidate.intentionId, {
          state: 'waiting_permission',
          error: 'Se requiere una regla allow explícita para goal_run en este workspace.',
        });
        this._bus?.emit('goal:ready', {
          intentionId: candidate.intentionId,
          goal: candidate.intention.goal,
          workspace,
          reason: 'permission_required',
        });
        return { state: 'waiting_permission', intentionId: candidate.intentionId };
      }

      const claim = this._graph.claimGoalExecution?.(candidate.intentionId, {
        source: 'governor',
        now,
        leaseMs: candidate.maxRuntimeMs,
      });
      if (!claim) return { state: 'idle', reason: 'claim_failed' };
      return await this._run(candidate, claim);
    } finally {
      this._evaluating = false;
    }
  }

  /** @param {any} candidate @param {number} now @param {string} reason */
  _suggest(candidate, now, reason) {
    this._graph.markGoalSuggested?.(candidate.intentionId, now);
    this._graph.recordGoalEvent?.(candidate.intentionId, null, 'governor_suggested', { reason });
    this._bus?.emit('goal:ready', {
      intentionId: candidate.intentionId,
      goal: candidate.intention.goal,
      workspace: candidate.workspace,
      reason,
    });
  }

  /** @param {any} candidate @param {any} claim */
  async _run(candidate, claim) {
    const controller = new AbortController();
    this._activeController = controller;
    const timeout = setTimeout(() => controller.abort(), claim.maxRuntimeMs);
    timeout.unref?.();
    this._bus?.emit('goal:execution-started', {
      intentionId: candidate.intentionId,
      goal: candidate.intention.goal,
    });
    try {
      const result = await this._execute(`Objetivo: ${candidate.intention.goal}`, {
        mode: 'smart',
        signal: controller.signal,
        executiveRun: true,
        governanceClaimed: true,
      });
      let current = this._graph.getGoalGovernance?.(candidate.intentionId);
      if (current?.state === 'running') {
        settleGoal({
          graph: this._graph,
          commitment: {
            id: candidate.intentionId,
            goal: candidate.intention.goal,
            resumed: true,
            claimed: true,
            source: 'governor',
          },
          workspace: candidate.workspace,
          result,
          evaluation: evaluateTaskOutcome(result),
        });
        current = this._graph.getGoalGovernance?.(candidate.intentionId);
      }
      this._bus?.emit('goal:execution-finished', {
        intentionId: candidate.intentionId,
        state: current?.state || 'unknown',
        ok: !result?.error,
      });
      return { state: current?.state || 'unknown', intentionId: candidate.intentionId, result };
    } catch (error) {
      const current = this._graph.getGoalGovernance?.(candidate.intentionId) || claim;
      const exhausted = Number(current.attempts) >= Number(current.maxAttempts);
      const delay = Math.min(
        6 * 60 * 60 * 1000,
        5 * 60 * 1000 * 2 ** Math.max(0, Number(current.attempts || 1) - 1)
      );
      this._graph.settleGoalGovernance?.(candidate.intentionId, {
        state: exhausted ? 'blocked' : 'retry_scheduled',
        error: _errorText(error),
        nextRunAt: exhausted ? null : Date.now() + delay,
      });
      return {
        state: exhausted ? 'blocked' : 'retry_scheduled',
        intentionId: candidate.intentionId,
        error: _errorText(error),
      };
    } finally {
      clearTimeout(timeout);
      this._activeController = null;
    }
  }
}

module.exports = { GoalGovernor, DEFAULT_INTERVAL_MS };
