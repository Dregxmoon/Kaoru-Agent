// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AgentLoop } = require('../core/planner/AgentLoop.js');
const LLMProvider = require('../core/llm/LLMProvider.js');
const { DesktopMissionLoop, validateMission } = require('../core/desktop/DesktopMissionLoop.js');
const {
  MissionGrant,
  assessAction,
  requestActionApproval,
} = require('../core/security/AuthorizedToolExecutor.js');
const { PermissionManager } = require('../core/security/PermissionManager.js');
const { StateGraph } = require('../core/state-graph/StateGraph.js');

let passed = 0;
/** @param {unknown} condition @param {string} label */
function check(condition, label) {
  assert(condition, label);
  passed++;
}

/** @param {(step:number)=>void} act @param {StateGraph|null} [graph] */
function makeHarness(act, graph = null) {
  const state = {
    first: false,
    second: false,
    childCalls: 0,
    toolCalls: /** @type {string[]} */ ([]),
  };
  const bridge = {
    getDesktopAutomation: () => ({ observedApplication: () => 'Editor' }),
    execute: async (/** @type {string} */ tool, /** @type {any} */ params) => {
      state.toolCalls.push(tool);
      if (tool === 'window_list') {
        return {
          ok: true,
          result: {
            nodes: state.first
              ? [{ application: 'Editor', window: 'Informe abierto', name: 'Informe abierto' }]
              : [],
          },
        };
      }
      if (tool === 'ui_wait') {
        return {
          ok: true,
          result: { verified: state.second, status: state.second ? 'completed' : 'timeout' },
        };
      }
      throw new Error(`Tool inesperada: ${tool} ${JSON.stringify(params)}`);
    },
  };
  const missionLoop = new DesktopMissionLoop({
    bridge,
    graph,
    makeAgentLoop: () => ({
      run: async () => {
        state.childCalls++;
        act(state.childCalls);
        return { response: 'Listo', toolResults: [], iterations: 1 };
      },
    }),
  });
  return { state, missionLoop };
}

const mission = {
  goal: 'Prepare the report and confirm it in the editor / レポートを準備する',
  applications: ['Editor', 'Agenda'],
  steps: [
    {
      description: 'Open the report in Editor',
      expected: { type: 'window_visible', application: 'Editor', name: 'Informe abierto' },
    },
    {
      description: 'Agenda に完了マークを付ける',
      expected: { type: 'ui_visible', application: 'Agenda', name: '完了', role: 'label' },
    },
  ],
};

/** @param {DesktopMissionLoop} loop */
function options(loop) {
  void loop;
  return {
    systemPrompt: 'Test',
    messages: [],
    workspace: process.cwd(),
    planReview: { covered: true, gaps: [], weakSteps: [] },
  };
}

async function main() {
  check(validateMission(mission).steps.length === 2, 'admite una misión en idiomas mezclados');
  assert.throws(
    () =>
      validateMission({
        ...mission,
        steps: [
          {
            description: 'Confirmar',
            expected: { type: 'ui_visible', application: 'Agenda', role: 'button' },
          },
        ],
      }),
    /nombre observable concreto/,
    'no acepta una postcondición genérica que coincide con cualquier botón'
  );
  passed++;
  assert.throws(
    () =>
      validateMission({
        ...mission,
        steps: [
          { description: 'Abrir', expected: { type: 'window_visible', application: 'Editor' } },
        ],
      }),
    /nombre observable concreto/,
    'una ventana cualquiera no demuestra el resultado esperado'
  );
  passed++;
  assert.throws(
    () => validateMission({ ...mission, steps: [{ description: 'Do it', expected: {} }] }),
    /postcondición/,
    'rechaza pasos sin postcondición observable'
  );
  passed++;
  assert.throws(
    () =>
      validateMission({
        ...mission,
        steps: [
          {
            description: 'Enviar mensaje',
            expected: { type: 'ui_visible', application: 'Agenda', name: 'Enviar', role: 'button' },
          },
        ],
      }),
    /control interactivo requiere un estado observable/,
    'un botón de acción preexistente no prueba que la tarea terminó'
  );
  passed++;

  const complete = makeHarness((step) => {
    if (step === 1) complete.state.first = true;
    if (step === 2) complete.state.second = true;
  });
  const bypass = makeHarness(() => {});
  const bypassResult = await bypass.missionLoop.run(mission, {
    ...options(bypass.missionLoop),
    planReview: { covered: true },
  });
  check(
    bypassResult.status === 'paused' && bypass.state.childCalls === 0,
    'el ejecutor rechaza una revisión incompleta aunque diga covered=true'
  );
  const deniedDirect = await bypass.missionLoop.run(mission, {
    ...options(bypass.missionLoop),
    planReview: undefined,
    reviewDesktopMissionPlan: async () => ({
      covered: false,
      gaps: ['Falta el segundo resultado'],
      weakSteps: [],
    }),
  });
  check(
    deniedDirect.status === 'paused' && bypass.state.childCalls === 0,
    'una invocación directa también exige cobertura del objetivo'
  );
  const progress = /** @type {Array<{done:number,status:string}>} */ ([]);
  const finished = await complete.missionLoop.run(mission, {
    ...options(complete.missionLoop),
    onPlan: (/** @type {any} */ plan) => progress.push({ done: plan.done, status: plan.status }),
  });
  check(
    finished.status === 'completed' && finished.completed === 2,
    'completa dos resultados verificados'
  );
  check(complete.state.childCalls === 2, 'ejecuta pasos de aplicaciones distintas en serie');
  check(
    progress.at(-1)?.done === 2 && progress.at(-1)?.status === 'completed',
    'publica progreso verificado por paso'
  );
  check(
    finished.persistence === 'session_only',
    'declara el límite de persistencia sin StateGraph'
  );

  const preexisting = makeHarness(() => {});
  preexisting.state.first = true;
  preexisting.state.second = true;
  const already = await preexisting.missionLoop.run(mission, options(preexisting.missionLoop));
  check(
    already.status === 'completed' && preexisting.state.childCalls === 0,
    'no repite efectos ya observados'
  );

  const unverified = makeHarness((step) => {
    if (step === 1) unverified.state.first = true;
  });
  let finalPlanStatus = '';
  const partial = await unverified.missionLoop.run(mission, {
    ...options(unverified.missionLoop),
    onPlan: (/** @type {any} */ plan) => {
      finalPlanStatus = plan.status;
    },
  });
  check(partial.status === 'paused' && partial.resumePoint === 2, 'pausa en el paso sin verificar');
  check(finalPlanStatus === 'paused', 'HUD recibe estado pausado al cerrar sin evidencia');
  check(
    unverified.state.childCalls === 2 && partial.completed === 1,
    'no declara terminada la misión'
  );

  const untouched = makeHarness(() => {});
  const blocked = await untouched.missionLoop.run(mission, options(untouched.missionLoop));
  check(
    blocked.status === 'paused' && blocked.resumePoint === 1,
    'una acción no verificada no se repite a ciegas'
  );
  check(
    untouched.state.childCalls === 1,
    'no comienza el siguiente paso tras un resultado incierto'
  );

  const unavailable = makeHarness(() => {});
  unavailable.missionLoop._bridge.getDesktopAutomation = () => ({
    health: async () => ({ ok: false, error: 'macOS sin adaptador accesible' }),
  });
  const unsupported = await unavailable.missionLoop.run(mission, options(unavailable.missionLoop));
  check(
    unsupported.status === 'paused' && unsupported.error === 'desktop_unavailable',
    'plataforma sin adaptador se detiene antes de actuar'
  );
  check(unavailable.state.childCalls === 0, 'no intenta controlar una UI no compatible');

  const cancelled = makeHarness(() => {});
  const controller = new AbortController();
  controller.abort();
  const stopped = await cancelled.missionLoop.run(mission, {
    ...options(cancelled.missionLoop),
    signal: controller.signal,
  });
  check(
    stopped.status === 'cancelled' && cancelled.state.childCalls === 0,
    'cancelación impide iniciar una acción de escritorio'
  );

  const graphDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoru-desktop-mission-'));
  const graph = new StateGraph(path.join(graphDir, 'memory.db')).init();
  try {
    const durable = makeHarness(() => {}, graph);
    durable.state.first = true;
    durable.state.second = true;
    let goalId = 0;
    const persisted = await durable.missionLoop.run(mission, {
      ...options(durable.missionLoop),
      sessionId: 'desktop-test-session',
      workspace: graphDir,
      onPlan: (/** @type {any} */ plan) => {
        goalId = Number(plan.goalId) || goalId;
      },
    });
    const recorded = graph.getIntention(goalId);
    check(
      persisted.status === 'completed' && persisted.persistence === 'state_graph',
      'misión real usa StateGraph'
    );
    check(recorded?.status === 'done', 'StateGraph conserva cierre con evidencia externa');
    check(
      graph.getGoalPlan(recorded.id).length === 2,
      'StateGraph registra el plan y sus postcondiciones'
    );

    const retryMission = { ...mission, goal: 'Preparar otro informe y confirmar la cita' };
    const retry = makeHarness(() => {}, graph);
    retry.state.first = true;
    const retryOptions = {
      ...options(retry.missionLoop),
      sessionId: 'desktop-retry-session',
      workspace: graphDir,
    };
    const firstRun = await retry.missionLoop.run(retryMission, retryOptions);
    check(
      firstRun.status === 'paused' && retry.state.childCalls === 1,
      'primera corrida conserva un paso incierto'
    );
    const changedMission = {
      ...retryMission,
      steps: [
        retryMission.steps[0],
        { ...retryMission.steps[1], description: 'Confirmar otra cita diferente' },
      ],
    };
    const changedRun = await retry.missionLoop.run(changedMission, retryOptions);
    check(
      changedRun.error === 'mission_plan_changed',
      'un plan distinto no reutiliza el historial de otra misión'
    );
    check(retry.state.childCalls === 1, 'un cambio de plan no provoca ejecución adicional');
    const secondRun = await retry.missionLoop.run(retryMission, retryOptions);
    check(
      secondRun.status === 'paused' && secondRun.resumePoint === 2,
      'reanuda en el paso con evidencia pendiente'
    );
    check(retry.state.childCalls === 1, 'reanudar no repite una acción de efecto incierto');
    retry.state.second = true;
    const thirdRun = await retry.missionLoop.run(retryMission, retryOptions);
    check(
      thirdRun.status === 'completed',
      'termina la misión cuando aparece la evidencia pendiente'
    );
    check(retry.state.childCalls === 1, 'resolver por observación no ejecuta de nuevo la acción');
  } finally {
    graph.close();
    fs.rmSync(graphDir, { recursive: true, force: true });
  }

  const grant = new MissionGrant({
    applications: ['Editor'],
    now: () => 1000,
    maxActions: 2,
    resolveObservedApplication: () => 'Editor',
  });
  const scoped = { tool: 'ui_click', params: { observationId: 'o', ref: 'ui-1' } };
  check(grant.allows(scoped), 'concesión cubre un control de la aplicación declarada');
  check(
    !grant.allows({ tool: 'list_apps', params: {} }),
    'listar todas las aplicaciones queda fuera del permiso temporal'
  );
  check(
    grant.allows({ tool: 'list_apps', params: { query: 'Editor' } }),
    'descubrimiento acotado a la aplicación declarada queda cubierto'
  );
  const twoAppGrant = new MissionGrant({ applications: ['Editor', 'Agenda'], now: () => 1000 });
  twoAppGrant.setStepApplication('Editor');
  check(
    !twoAppGrant.allows({ tool: 'launch_app', params: { app: 'Agenda' } }),
    'un paso no hereda acceso automático a otra aplicación'
  );
  check(
    assessAction(
      { tool: 'launch_app', params: { app: 'Agenda' } },
      { missionGrant: twoAppGrant, forceApproval: true }
    ).permissionAction === 'ask',
    'una acción fuera del paso exige autorización aunque exista concesión para otra app'
  );
  twoAppGrant.setStepApplication('Agenda');
  check(
    twoAppGrant.allows({ tool: 'launch_app', params: { app: 'Agenda' } }),
    'el siguiente paso abre su aplicación declarada'
  );
  check(
    !grant.allows({ tool: 'pointer_click', params: { captureId: 'c', x: 1, y: 1 } }),
    'clic visual queda fuera de la concesión'
  );
  const permissionManager = new PermissionManager({ filePath: null });
  permissionManager.setRule({ tool: 'capability:pointer', action: 'deny' });
  const assessment = assessAction(scoped, { permissionManager, missionGrant: grant });
  check(assessment.permissionAction === 'deny', 'un deny de capacidad vence a la concesión');
  const denial = await requestActionApproval(assessment, scoped, { missionGrant: grant });
  check(!denial.approved && grant.usedActions === 0, 'un deny no consume ni ejecuta acción');
  permissionManager.removeRule({ tool: 'capability:pointer' });
  const allowed = assessAction(scoped, { permissionManager, missionGrant: grant });
  const approval = await requestActionApproval(allowed, scoped, { missionGrant: grant });
  check(
    approval.approved && !approval.prompted && grant.usedActions === 1,
    'misión aprobada reutiliza alcance temporal'
  );
  permissionManager.setRule({ tool: 'list_apps', action: 'ask' });
  const asked = assessAction({ tool: 'list_apps', params: {} }, { permissionManager });
  let lowImpactApprovals = 0;
  const lowImpactDecision = await requestActionApproval(
    asked,
    { tool: 'list_apps', params: {} },
    {
      onApprovalNeeded: async () => {
        lowImpactApprovals++;
        return false;
      },
    }
  );
  check(
    !lowImpactDecision.approved && lowImpactApprovals === 1,
    'una regla ask explícita exige diálogo aun en tool de bajo impacto'
  );
  permissionManager.removeRule({ tool: 'list_apps' });
  check(
    assessAction({ tool: 'desktop_mission', params: {} }, { forceApproval: true })
      .permissionAction === 'ask',
    'cada misión requiere autorización inicial'
  );

  const originalTools = LLMProvider.completeWithTools;
  const originalMissionRun = DesktopMissionLoop.prototype.run;
  let nativeCalls = 0;
  let missionApprovals = 0;
  let approvedGoal = '';
  try {
    LLMProvider.completeWithTools = async () => {
      nativeCalls++;
      return nativeCalls === 1
        ? { content: '', toolCalls: [{ tool: 'desktop_mission', params: mission }] }
        : { content: '確認しました。', toolCalls: [] };
    };
    DesktopMissionLoop.prototype.run = async () => ({
      status: 'completed',
      completed: 2,
      total: 2,
      steps: [],
    });
    const parent = new AgentLoop({
      mode: 'fast',
      bridge: {
        execute: async () => {
          throw new Error('bridge directo');
        },
      },
    });
    const routed = await parent.run('レポートを開いて、予定も確認して', 'Test', [], {
      tools: [{ name: 'desktop_mission', inputSchema: { type: 'object', properties: {} } }],
      planning: false,
      reviewDesktopMissionPlan: async () => ({ covered: true, gaps: [], weakSteps: [] }),
      onApprovalNeeded: async (/** @type {any} */ action) => {
        missionApprovals++;
        approvedGoal = action.params.goal;
        return true;
      },
    });
    check(
      routed.toolResults?.some(
        (/** @type {any} */ result) => result.tool === 'desktop_mission' && result.ok
      ),
      'AgentLoop enruta misión multilingüe mediante tool-call nativo'
    );
    check(missionApprovals === 1, 'la misión pide autorización inicial una sola vez');
    check(
      approvedGoal === 'レポートを開いて、予定も確認して',
      'la autorización conserva la meta original del usuario'
    );
    nativeCalls = 0;
    await parent.run('Texto sustituido por un hook local', 'Test', [], {
      originalUserMessage: '元の依頼: informe y agenda',
      tools: [{ name: 'desktop_mission', inputSchema: { type: 'object', properties: {} } }],
      planning: false,
      reviewDesktopMissionPlan: async () => ({ covered: true, gaps: [], weakSteps: [] }),
      onApprovalNeeded: async (/** @type {any} */ action) => {
        approvedGoal = action.params.goal;
        return true;
      },
    });
    check(
      approvedGoal === '元の依頼: informe y agenda',
      'un hook no cambia la meta visible en la autorización'
    );
    nativeCalls = 0;
    DesktopMissionLoop.prototype.run = async () => ({
      status: 'paused',
      error: 'step_2_unverified',
      completed: 1,
      total: 2,
      resumePoint: 2,
      steps: [],
    });
    const incomplete = await parent.run('レポートを開いて、予定も確認して', 'Test', [], {
      tools: [{ name: 'desktop_mission', inputSchema: { type: 'object', properties: {} } }],
      planning: false,
      reviewDesktopMissionPlan: async () => ({ covered: true, gaps: [], weakSteps: [] }),
      onApprovalNeeded: async () => true,
    });
    check(
      incomplete.error === 'desktop_mission_incomplete',
      'misión pausada no se cierra como éxito'
    );
    check(
      incomplete.response.includes('1/2') && !incomplete.response.includes('全部完了'),
      'el cierre usa evidencia real aunque el modelo afirme que terminó'
    );
    nativeCalls = 0;
    let deniedPlanApprovals = 0;
    let deniedPlanExecutions = 0;
    DesktopMissionLoop.prototype.run = async () => {
      deniedPlanExecutions++;
      return { status: 'completed', completed: 2, total: 2, steps: [] };
    };
    await parent.run('メモを作って通知を設定して', 'Test', [], {
      tools: [{ name: 'desktop_mission', inputSchema: { type: 'object', properties: {} } }],
      planning: false,
      reviewDesktopMissionPlan: async () => ({
        covered: false,
        gaps: ['Falta crear el recordatorio'],
        weakSteps: [],
        error: 'mission_plan_incomplete',
      }),
      onApprovalNeeded: async () => {
        deniedPlanApprovals++;
        return true;
      },
    });
    check(
      deniedPlanApprovals === 0 && deniedPlanExecutions === 0,
      'un plan incompleto se bloquea antes de consentimiento y ejecución'
    );
  } finally {
    LLMProvider.completeWithTools = originalTools;
    DesktopMissionLoop.prototype.run = originalMissionRun;
  }

  console.log(`Resultado: ${passed} passed  0 failed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
