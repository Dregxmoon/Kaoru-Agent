// @ts-check
'use strict';

const { AgentLoop } = require('../planner/AgentLoop.js');
const { getToolSchemas } = require('../llm/ToolSchemas.js');
const { getToolRegistry } = require('../task/ToolRegistry.js');
const {
  MissionGrant,
  assessAction,
  requestActionApproval,
} = require('../security/AuthorizedToolExecutor.js');
const { beginGoal, settleGoal } = require('../memory/GoalLifecycle.js');

const DESKTOP_MISSION_TOOLS = new Set([
  'list_apps',
  'launch_app',
  'desktop_snapshot',
  'desktop_screenshot',
  'pointer_click',
  'window_list',
  'window_focus',
  'window_close',
  'ui_get_state',
  'ui_wait',
  'ui_click',
  'ui_type',
  'ui_press',
  'ui_select',
  'ui_scroll',
  'desktop_capabilities',
]);

/** @typedef {{type:'ui_visible'|'window_visible',application:string,name?:string,role?:string,state?:string,absent?:boolean}} Expected */
/** @typedef {InstanceType<typeof MissionGrant>} MissionGrantType */
/** @typedef {{description:string,expected:Expected}} MissionStep */
/** @typedef {{goal:string,applications:string[],steps:MissionStep[]}} Mission */

let desktopMissionActive = false;

/** @param {unknown} value @param {number} max */
function safeText(value, max) {
  return String(value || '')
    .trim()
    .slice(0, max);
}

/** @param {unknown} left @param {unknown} right */
function sameApplication(left, right) {
  return (
    safeText(left, 120).normalize('NFKC').toLocaleLowerCase() ===
    safeText(right, 120).normalize('NFKC').toLocaleLowerCase()
  );
}

const INTERACTIVE_ROLES = new Set([
  'button',
  'push button',
  'entry',
  'combo box',
  'menu item',
  'link',
]);

/** @param {unknown} input @returns {Mission} */
function validateMission(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('La misión requiere un objeto estructurado');
  }
  const raw = /** @type {Record<string,any>} */ (input);
  const goal = safeText(raw.goal, 1000);
  const applications = Array.isArray(raw.applications)
    ? [
        ...new Set(
          raw.applications.map((/** @type {unknown} */ app) => safeText(app, 120)).filter(Boolean)
        ),
      ]
    : [];
  const rawSteps = Array.isArray(raw.steps) ? raw.steps : [];
  if (!goal || !applications.length || applications.length > 8) {
    throw new Error('La misión requiere una meta y entre una y ocho aplicaciones');
  }
  if (!rawSteps.length || rawSteps.length > 12) {
    throw new Error('La misión requiere entre uno y doce resultados observables');
  }
  const steps = rawSteps.map((/** @type {any} */ item) => {
    const description = safeText(item?.description, 500);
    const expected = item?.expected || {};
    const type = safeText(expected.type, 30);
    const application = safeText(expected.application, 120);
    const name = safeText(expected.name, 300);
    const role = safeText(expected.role, 80);
    const state = safeText(expected.state, 80);
    if (!description || !['ui_visible', 'window_visible'].includes(type) || !application) {
      throw new Error('Cada paso requiere descripción y postcondición de UI o ventana');
    }
    if (!name) {
      throw new Error('Una postcondición de escritorio requiere el nombre observable concreto');
    }
    if (type === 'ui_visible' && expected.absent !== true && !role && !state) {
      throw new Error('Una postcondición positiva de UI requiere rol o estado observable');
    }
    if (
      type === 'ui_visible' &&
      expected.absent !== true &&
      INTERACTIVE_ROLES.has(role.toLocaleLowerCase()) &&
      !state
    ) {
      throw new Error('Un control interactivo requiere un estado observable para probar éxito');
    }
    if (
      !applications.some(
        (app) =>
          app.normalize('NFKC').toLocaleLowerCase() ===
          application.normalize('NFKC').toLocaleLowerCase()
      )
    ) {
      throw new Error(`La aplicación ${application} no está en el alcance de la misión`);
    }
    return {
      description,
      expected: /** @type {Expected} */ ({
        type,
        application,
        ...(name ? { name } : {}),
        ...(role ? { role } : {}),
        ...(state ? { state } : {}),
        ...(expected.absent === true ? { absent: true } : {}),
      }),
    };
  });
  return { goal, applications, steps };
}

/**
 * Ciclo especializado: un AgentLoop focal ejecuta cada paso, pero el cierre lo
 * decide una postcondición independiente del texto final del modelo.
 */
class DesktopMissionLoop {
  /**
   * @param {{bridge:any,graph?:any,makeAgentLoop?:(opts:any)=>any,now?:()=>number}} input
   */
  constructor(input) {
    this._bridge = input.bridge;
    this._graph = input.graph || null;
    this._makeAgentLoop = input.makeAgentLoop || ((opts) => new AgentLoop(opts));
    this._now = input.now || Date.now;
  }

  /**
   * @param {Expected} expected
   * @param {{permissionManager?:any,onApprovalNeeded?:(action:any)=>Promise<any>,workspace?:string,
   * missionGrant:MissionGrantType,signal?:AbortSignal|null,precheck?:boolean}} options
   */
  async _verify(expected, options) {
    if (options.signal?.aborted) return { verified: false, reason: 'cancelled' };
    const action =
      expected.type === 'ui_visible'
        ? {
            tool: 'ui_wait',
            params: {
              application: expected.application,
              timeout: options.precheck ? 0 : 500,
              expected: {
                ...(expected.name ? { name: expected.name } : {}),
                ...(expected.name ? { exactName: true } : {}),
                ...(expected.role ? { role: expected.role } : {}),
                ...(expected.state ? { state: expected.state } : {}),
                ...(expected.absent === true ? { absent: true } : {}),
              },
            },
          }
        : { tool: 'window_list', params: { application: expected.application } };
    const assessment = assessAction(action, {
      permissionManager: options.permissionManager,
      workspace: options.workspace,
      missionGrant: options.missionGrant,
    });
    const approval = await requestActionApproval(assessment, action, {
      onApprovalNeeded: options.onApprovalNeeded,
      missionGrant: options.missionGrant,
    });
    if (!approval.approved)
      return { verified: false, reason: `approval_${approval.reason || 'denied'}` };
    if (options.signal?.aborted) return { verified: false, reason: 'cancelled' };
    const result = await this._bridge.execute(action.tool, action.params);
    if (options.signal?.aborted) return { verified: false, reason: 'cancelled' };
    if (!result.ok) return { verified: false, reason: safeText(result.error, 300) };
    if (expected.type === 'ui_visible') {
      return {
        verified: result.result?.verified === true,
        reason: safeText(result.result?.evidence || result.result?.status, 300),
      };
    }
    const windows = Array.isArray(result.result?.nodes) ? result.result.nodes : [];
    const name = safeText(expected.name, 300).normalize('NFKC').toLocaleLowerCase();
    const found = windows.some((/** @type {any} */ node) => {
      const application = safeText(node.application, 120);
      const title = safeText(node.window || node.name, 300)
        .normalize('NFKC')
        .toLocaleLowerCase();
      return sameApplication(application, expected.application) && title === name;
    });
    return {
      verified: expected.absent === true ? !found : found,
      reason: found ? 'window_observed' : 'window_missing',
    };
  }

  /**
   * @param {unknown} input
   * @param {{systemPrompt:string,messages?:any[],permissionManager?:any,
   * onApprovalNeeded?:(action:any)=>Promise<any>,onProgress?:(progress:any)=>void,
   * onPlan?:(plan:any)=>void,signal?:AbortSignal|null,sessionId?:string,workspace?:string,
   * llm?:any,planReview?:any,reviewDesktopMissionPlan?:(mission:Mission,options:{signal?:AbortSignal|null})=>Promise<any>}} options
   */
  async run(input, options) {
    const mission = validateMission(input);
    const { reviewMissionPlan, validatePlanReview } = require('./MissionPlanReviewer.js');
    const rawReview =
      options.planReview ||
      (await (options.reviewDesktopMissionPlan || reviewMissionPlan)(mission, {
        signal: options.signal,
      }));
    const review = validatePlanReview(rawReview, mission.steps.length);
    if (!review.covered) {
      return {
        status: 'paused',
        error: review.error || 'mission_plan_incomplete',
        gaps: review.gaps,
        weakSteps: review.weakSteps,
        steps: [],
        completed: 0,
        total: mission.steps.length,
      };
    }
    if (desktopMissionActive) {
      return {
        status: 'paused',
        error: 'desktop_busy',
        steps: [],
        completed: 0,
        total: mission.steps.length,
      };
    }
    const automation = this._bridge.getDesktopAutomation?.() || null;
    if (automation?.health) {
      let health;
      try {
        health = await automation.health();
      } catch (cause) {
        health = { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
      }
      if (!health?.ok) {
        return {
          status: 'paused',
          error: 'desktop_unavailable',
          detail: safeText(health?.error, 300),
          steps: [],
          completed: 0,
          total: mission.steps.length,
          resumePoint: 1,
          persistence: 'session_only',
        };
      }
    }
    if (desktopMissionActive) {
      return {
        status: 'paused',
        error: 'desktop_busy',
        steps: [],
        completed: 0,
        total: mission.steps.length,
      };
    }
    const grant = new MissionGrant({
      applications: mission.applications,
      now: this._now,
      resolveObservedApplication: (params) => automation?.observedApplication?.(params) || '',
    });
    const stepStates = mission.steps.map((step, index) => ({
      ordinal: index + 1,
      description: step.description,
      status: 'pending',
      evidence: /** @type {Array<{tool:string,reason:string,at:number}>} */ ([]),
    }));
    const workspace = options.workspace || process.cwd();
    const commitment =
      this._graph && options.sessionId
        ? beginGoal({
            graph: this._graph,
            sessionId: options.sessionId,
            workspace,
            goal: `Desktop: ${mission.goal}`,
          })
        : null;
    if (commitment && !commitment.claimed) {
      return {
        status: 'paused',
        error: 'goal_already_running',
        steps: stepStates,
        completed: 0,
        total: stepStates.length,
        resumePoint: 1,
        persistence: 'state_graph',
      };
    }
    const persistedSteps =
      commitment && commitment.resumed ? this._graph?.getGoalPlan?.(commitment.id) || [] : [];
    if (persistedSteps.length) {
      const samePlan =
        persistedSteps.length === mission.steps.length &&
        persistedSteps.every(
          (/** @type {any} */ stored, /** @type {number} */ index) =>
            stored.description === mission.steps[index].description &&
            stored.successCriteria?.[0] === JSON.stringify(mission.steps[index].expected)
        );
      if (!samePlan) {
        if (commitment) {
          this._graph?.settleGoalGovernance?.(commitment.id, {
            state: 'waiting_user',
            error: 'mission_plan_changed',
          });
        }
        return {
          status: 'paused',
          error: 'mission_plan_changed',
          steps: stepStates,
          completed: 0,
          total: stepStates.length,
          resumePoint: 1,
          persistence: 'state_graph',
        };
      }
      persistedSteps.forEach((/** @type {any} */ stored, /** @type {number} */ index) => {
        if (stored.status === 'pending') return;
        stepStates[index].status =
          stored.status === 'completed' ? 'completed' : 'awaiting_verification';
        stepStates[index].evidence.push({
          tool: 'state_graph',
          reason: `persisted_${stored.status}`,
          at: this._now(),
        });
      });
    }
    /** @type {'completed'|'paused'|'cancelled'} */
    let status = 'completed';
    let error = '';
    const toolNames = DESKTOP_MISSION_TOOLS;
    const tools = getToolSchemas().filter((/** @type {any} */ schema) =>
      toolNames.has(schema.name)
    );
    const toolCatalog = getToolRegistry().serializeToPrompt(null, 30, toolNames);
    const startedAt = this._now();
    /** @param {boolean} [final] */
    const publish = (final = false) =>
      options.onPlan?.({
        kind: 'mission',
        status: final ? status : 'running',
        goalId: commitment?.id || null,
        steps: mission.steps.map((step) => step.description),
        done: stepStates.filter((step) => step.status === 'completed').length,
        total: stepStates.length,
        stepStates: stepStates.map((step) => ({ ordinal: step.ordinal, status: step.status })),
      });
    desktopMissionActive = true;
    try {
      publish();
      for (const step of stepStates) {
        if (options.signal?.aborted) {
          status = 'cancelled';
          error = 'cancelled';
          break;
        }
        if (this._now() >= grant.expiresAt || grant.usedActions >= grant.maxActions) {
          status = 'paused';
          error = 'mission_budget_exhausted';
          break;
        }
        const expected = mission.steps[step.ordinal - 1].expected;
        grant.setStepApplication(expected.application);
        // Reobservar antes de ejecutar evita repetir una acción cuyo efecto ya existe.
        const before = await this._verify(expected, {
          ...options,
          workspace,
          missionGrant: grant,
          precheck: true,
        });
        if (options.signal?.aborted || before.reason === 'cancelled') {
          status = 'cancelled';
          error = 'cancelled';
          break;
        }
        if (before.reason.startsWith('approval_')) {
          status = 'paused';
          error = before.reason;
          break;
        }
        if (before.verified) {
          step.status = 'completed';
          step.evidence.push({ tool: 'mission_verify', reason: before.reason, at: this._now() });
          publish();
          continue;
        }
        if (this._now() >= grant.expiresAt || grant.usedActions >= grant.maxActions) {
          status = 'paused';
          error = 'mission_budget_exhausted';
          break;
        }
        if (step.status !== 'pending') {
          status = 'paused';
          error = `prior_step_${step.ordinal}_unverified`;
          step.status = 'awaiting_verification';
          step.evidence.push({ tool: 'mission_verify', reason: before.reason, at: this._now() });
          publish();
          break;
        }
        step.status = 'in_progress';
        publish();
        const child = this._makeAgentLoop({
          maxIterations: 18,
          bridge: this._bridge,
          mode: 'smart',
          graph: this._graph,
        });
        const outcome = await child.run(
          `${mission.goal}\nPaso ${step.ordinal}/${mission.steps.length}: ${step.description}\nResultado observable: ${JSON.stringify(expected)}`,
          options.systemPrompt,
          options.messages || [],
          {
            llm: options.llm,
            signal: options.signal,
            tools,
            toolCatalog,
            allowedToolNames: toolNames,
            permissionManager: options.permissionManager,
            onApprovalNeeded: options.onApprovalNeeded
              ? (/** @type {any} */ action) =>
                  options.onApprovalNeeded?.({ ...action, _desktopMission: true })
              : undefined,
            missionGrant: grant,
            taskIntent: { isTask: true, domain: 'system', confidence: 'high' },
            planning: false,
            strictCompletion: false,
            currentGoalPlan: [
              {
                ordinal: 1,
                description: step.description,
                successCriteria: [JSON.stringify(expected)],
                status: 'pending',
              },
            ],
            onProgress: (/** @type {any} */ progress) =>
              options.onProgress?.({ ...progress, missionStep: step.ordinal }),
            maxElapsedMs: Math.max(1, grant.expiresAt - this._now()),
          }
        );
        if (options.signal?.aborted || outcome.cancelled) {
          status = 'cancelled';
          error = 'cancelled';
          break;
        }
        if (this._now() >= grant.expiresAt || grant.usedActions >= grant.maxActions) {
          status = 'paused';
          error = 'mission_budget_exhausted';
          step.status = 'awaiting_verification';
          publish();
          break;
        }
        const after = await this._verify(expected, {
          ...options,
          workspace,
          missionGrant: grant,
        });
        if (options.signal?.aborted || after.reason === 'cancelled') {
          status = 'cancelled';
          error = 'cancelled';
          break;
        }
        if (!after.verified) {
          status = 'paused';
          error = outcome.error || `step_${step.ordinal}_unverified`;
          step.status = 'awaiting_verification';
          step.evidence.push({ tool: 'mission_verify', reason: after.reason, at: this._now() });
          publish();
          break;
        }
        step.status = 'completed';
        step.evidence.push({ tool: 'mission_verify', reason: after.reason, at: this._now() });
        publish();
      }
      if (status === 'completed' && stepStates.some((step) => step.status !== 'completed')) {
        status = 'paused';
        error = error || 'mission_incomplete';
      }
      publish(true);
      const result = {
        status,
        error: error || null,
        completed: stepStates.filter((step) => step.status === 'completed').length,
        total: stepStates.length,
        elapsedMs: this._now() - startedAt,
        steps: stepStates.map((step) => ({
          ordinal: step.ordinal,
          description: step.description,
          status: step.status,
          evidence: step.evidence,
        })),
        resumePoint: stepStates.find((step) => step.status !== 'completed')?.ordinal || null,
        persistence: commitment ? 'state_graph' : 'session_only',
      };
      if (commitment) {
        const plan = {
          steps: mission.steps.map((step) => step.description),
          criteria: mission.steps.map((step) => JSON.stringify(step.expected)),
          stepStates: result.steps,
          done: result.completed,
          total: result.total,
          coverageComplete: status === 'completed',
        };
        settleGoal({
          graph: this._graph,
          commitment,
          workspace,
          result: { plan, error: error || null, cancelled: status === 'cancelled' },
          evaluation: {
            terminalSuccess: status === 'completed',
            success: status === 'completed',
            verificationStatus: status === 'completed' ? 'verified' : 'unverified',
            verificationReason: error || 'all_steps_observed',
            mutationCount: 0,
          },
        });
      }
      return result;
    } catch (cause) {
      if (commitment) {
        this._graph?.settleGoalGovernance?.(commitment.id, {
          state: 'waiting_user',
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
      throw cause;
    } finally {
      desktopMissionActive = false;
    }
  }
}

module.exports = { DesktopMissionLoop, DESKTOP_MISSION_TOOLS, validateMission };
