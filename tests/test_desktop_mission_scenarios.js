// @ts-check
'use strict';

const assert = require('assert');
const { DesktopAutomation } = require('../core/desktop/DesktopAutomation.js');
const { DesktopMissionLoop } = require('../core/desktop/DesktopMissionLoop.js');
const { OpenClawBridge } = require('../core/planner/OpenClawBridge.js');
const { MissionGrant } = require('../core/security/AuthorizedToolExecutor.js');
const LLMProvider = require('../core/llm/LLMProvider.js');

/** @typedef {{application:string,button:string,result:string,done?:boolean,window?:string,running?:boolean,action?:'click'|'type'|'select'|'press'|'scroll',delayObservations?:number,remaining?:number}} App */

/** @param {App[]} apps @param {{staleOnce?:boolean,partialFilter?:boolean}} [options] */
function harness(apps, options = {}) {
  const state = {
    apps: new Map(apps.map((app) => [app.application, { ...app }])),
    active: '',
    observations: 0,
    actions: /** @type {Array<{action:string,application:string}>} */ ([]),
    approvals: /** @type {string[]} */ ([]),
    staleOnce: Boolean(options.staleOnce),
    latest: /** @type {{observationId:string,ref:string}|null} */ (null),
    calls: /** @type {Map<string,number>} */ (new Map()),
  };
  const adapter = {
    health: async () => ({ ok: true }),
    snapshot: async (/** @type {any} */ input) => {
      state.observations++;
      const names = input.application
        ? options.partialFilter
          ? [...state.apps.keys()].filter((name) =>
              name.toLocaleLowerCase().includes(String(input.application).toLocaleLowerCase())
            )
          : [String(input.application)]
        : [...state.apps.keys()];
      const nodes = names.flatMap((application) => {
        const app = state.apps.get(application);
        if (!app || app.running === false) return [];
        if (app.remaining && --app.remaining === 0) app.done = true;
        return [
          {
            path: `${application}/window`,
            processId: 100,
            application,
            window: app.window || application,
            name: app.window || application,
            role: 'window',
            states: [],
            depth: 0,
          },
          {
            path: `${application}/${app.done ? 'result' : 'button'}`,
            processId: 100,
            application,
            window: app.window || application,
            name: app.done ? app.result : app.button,
            role: app.done
              ? 'label'
              : app.action === 'type'
                ? 'entry'
                : app.action === 'select'
                  ? 'combo box'
                  : 'button',
            states: [],
            depth: 1,
          },
        ];
      });
      return { ok: true, backend: 'fake-at-spi', nodes };
    },
    execute: async (/** @type {string} */ action, /** @type {any} */ target) => {
      state.actions.push({ action, application: String(target.application) });
      if (state.staleOnce) {
        state.staleOnce = false;
        return { ok: false, stale: true, error: 'La interfaz cambió' };
      }
      const app = state.apps.get(String(target.application));
      if (app && action === (app.action || 'click') && target.name === app.button) {
        if (app.delayObservations) app.remaining = app.delayObservations;
        else app.done = true;
      }
      return { ok: true, executed: true, evidence: 'fake action' };
    },
  };
  const automation = new DesktopAutomation({ platform: 'linux', adapter });
  const realBridge = new OpenClawBridge({
    desktopAutomation: automation,
    desktopControl: {
      execute: async (/** @type {string} */ tool, /** @type {any} */ params) => {
        if (tool !== 'launch_app') throw new Error(`Unexpected control tool: ${tool}`);
        const app = state.apps.get(String(params.app));
        if (app) {
          app.window = `${app.application} abierto`;
          app.running = true;
        }
        return { kind: 'application', app: params.app };
      },
    },
  });
  const bridge = {
    getDesktopAutomation: () => automation,
    execute: async (/** @type {string} */ tool, /** @type {any} */ params) => {
      if (tool === 'ui_wait' || tool === 'window_list') state.active = String(params.application);
      const result = await realBridge.execute(tool, params);
      if (tool === 'desktop_snapshot' && result.ok) {
        const target = result.result.nodes.find((/** @type {any} */ node) => node.depth === 1);
        state.latest = target
          ? { observationId: result.result.observationId, ref: target.ref }
          : null;
      }
      return result;
    },
  };
  const loop = new DesktopMissionLoop({ bridge });
  const mission = {
    goal: 'Preparar un borrador, activar un recordatorio y confirmar una preferencia / 完了する',
    applications: apps.map((app) => app.application),
    steps: apps.map((app) => ({
      description: `Completar ${app.application}`,
      expected: {
        type: 'ui_visible',
        application: app.application,
        name: app.result,
        role: 'label',
      },
    })),
  };
  return { state, loop, mission, automation };
}

/** @param {ReturnType<typeof harness>} scenario @param {{wrongApp?:boolean,recoverStale?:boolean,planReview?:any}} [options] */
async function runScripted(scenario, options = {}) {
  const original = LLMProvider.completeWithTools;
  try {
    LLMProvider.completeWithTools = async () => {
      const app = scenario.state.active;
      const number = (scenario.state.calls.get(app) || 0) + 1;
      scenario.state.calls.set(app, number);
      if (number === 1) {
        if (scenario.state.apps.get(app)?.running === false) {
          return { content: '', toolCalls: [{ tool: 'launch_app', params: { app } }] };
        }
        return {
          content: '',
          toolCalls: [
            {
              tool: 'desktop_snapshot',
              params: { application: options.wrongApp ? 'FueraDeAlcance' : app },
            },
          ],
        };
      }
      if (number === 3 && options.recoverStale) {
        return {
          content: '',
          toolCalls: [{ tool: 'desktop_snapshot', params: { application: app } }],
        };
      }
      if ((number === 2 || (number === 4 && options.recoverStale)) && scenario.state.latest) {
        const action = scenario.state.apps.get(app)?.action || 'click';
        return {
          content: '',
          toolCalls: [
            {
              tool: `ui_${action}`,
              params: {
                ...scenario.state.latest,
                ...(options.wrongApp ? { application: 'FueraDeAlcance' } : {}),
                ...(action === 'type' ? { value: 'Nuevo borrador' } : {}),
                ...(action === 'press' ? { key: 'ENTER' } : {}),
                ...(action === 'scroll' ? { direction: 'down', amount: 2 } : {}),
              },
            },
          ],
        };
      }
      return { content: 'Terminé el paso.', toolCalls: [] };
    };
    return await scenario.loop.run(scenario.mission, {
      planReview: options.planReview || { covered: true, gaps: [], weakSteps: [] },
      systemPrompt: 'Scenario test',
      messages: [],
      workspace: process.cwd(),
      onApprovalNeeded: async (/** @type {any} */ action) => {
        scenario.state.approvals.push(action.tool);
        return false;
      },
    });
  } finally {
    LLMProvider.completeWithTools = original;
  }
}

async function main() {
  const multi = harness([
    { application: 'Notas', button: 'Crear borrador', result: 'Borrador creado' },
    { application: 'Agenda', button: 'Añadir aviso', result: 'Aviso activo' },
    { application: 'Preferencias', button: 'Activar enfoque', result: 'Enfoque activo' },
  ]);
  const multiResult = await runScripted(multi);
  assert.strictEqual(multiResult.status, 'completed', JSON.stringify(multiResult));
  assert.strictEqual(multiResult.completed, 3);
  assert.deepStrictEqual(
    multi.state.actions.map((action) => action.application),
    ['Notas', 'Agenda', 'Preferencias'],
    'cada aplicación se modifica después de verificar el paso anterior'
  );
  assert.deepStrictEqual(
    multi.state.approvals,
    [],
    'las acciones dentro del grant no repiden permiso'
  );

  const varied = harness([
    { application: 'Notas', button: 'Título', result: 'Borrador creado', action: 'type' },
    { application: 'Agenda', button: 'Fecha', result: 'Fecha elegida', action: 'select' },
    { application: 'Ajustes', button: 'Silenciar', result: 'Silencio activo', action: 'press' },
    { application: 'Archivos', button: 'Lista', result: 'Carpeta visible', action: 'scroll' },
  ]);
  const variedResult = await runScripted(varied);
  assert.strictEqual(variedResult.status, 'completed');
  assert.deepStrictEqual(
    varied.state.actions.map((action) => action.action),
    ['type', 'select', 'press', 'scroll'],
    'el AgentLoop ejecuta distintas acciones UI en secuencia'
  );

  const launch = harness([
    { application: 'Editor', button: 'Nuevo', result: 'Nuevo abierto', running: false },
  ]);
  launch.mission.steps[0].expected = {
    type: 'window_visible',
    application: 'Editor',
    name: 'Editor abierto',
  };
  const launchResult = await runScripted(launch);
  assert.strictEqual(launchResult.status, 'completed', 'abrir una aplicación verifica su ventana');
  assert.strictEqual(launch.state.actions.length, 0, 'launch no requiere clic adicional');

  const alreadyDone = harness([
    { application: 'Correo', button: 'Archivar', result: 'Archivado', done: true },
  ]);
  const alreadyResult = await runScripted(alreadyDone);
  assert.strictEqual(alreadyResult.status, 'completed');
  assert.strictEqual(
    alreadyDone.state.actions.length,
    0,
    'no reejecuta un resultado ya observable'
  );

  const stale = harness(
    [{ application: 'Archivos', button: 'Etiquetar', result: 'Etiqueta puesta' }],
    { staleOnce: true }
  );
  const staleResult = await runScripted(stale);
  assert.strictEqual(staleResult.status, 'paused', 'un ref obsoleto no cuenta como éxito');
  assert.strictEqual(stale.state.apps.get('Archivos')?.done, undefined);
  const recovery = harness(
    [{ application: 'Archivos', button: 'Etiquetar', result: 'Etiqueta puesta' }],
    { staleOnce: true }
  );
  const recoveryResult = await runScripted(recovery, { recoverStale: true });
  assert.strictEqual(recoveryResult.status, 'completed', 'reobserva y reintenta tras ref obsoleto');
  assert.strictEqual(recovery.state.actions.length, 2);

  const delayed = harness([
    {
      application: 'Calendario',
      button: 'Crear evento',
      result: 'Evento confirmado',
      delayObservations: 2,
    },
  ]);
  const delayedResult = await runScripted(delayed);
  assert.strictEqual(
    delayedResult.status,
    'completed',
    'la espera posterior recoge resultados tardíos'
  );

  const wrong = harness([
    { application: 'Calculadora', button: 'Guardar operación', result: 'Operación guardada' },
  ]);
  wrong.state.apps.set('FueraDeAlcance', {
    application: 'FueraDeAlcance',
    button: 'Guardar operación',
    result: 'Operación guardada',
  });
  const wrongResult = await runScripted(wrong, { wrongApp: true });
  assert.strictEqual(wrongResult.status, 'paused');
  assert.strictEqual(wrong.state.actions.length, 0, 'una acción fuera del alcance no se ejecuta');

  const twin = harness(
    [{ application: 'Calc', button: 'Crear informe', result: 'Informe listo', window: 'Calc' }],
    { partialFilter: true }
  );
  twin.state.apps.set('Calculator', {
    application: 'Calculator',
    button: 'Crear informe',
    result: 'Informe listo',
    done: true,
    window: 'Informe listo en Calculator',
  });
  const twinUi = await twin.automation.waitFor({
    application: 'Calc',
    expected: { name: 'Informe listo', role: 'label' },
    timeout: 250,
  });
  assert.strictEqual(twinUi.verified, false, 'una UI de Calculator no verifica Calc');
  const windowBridge = {
    getDesktopAutomation: () => twin.automation,
    execute: async (/** @type {string} */ tool, /** @type {any} */ params) => {
      assert.strictEqual(tool, 'window_list');
      return { ok: true, result: await twin.automation.listWindows(params) };
    },
  };
  const windowLoop = new DesktopMissionLoop({ bridge: windowBridge });
  const grant = new MissionGrant({ applications: ['Calc'] });
  grant.setStepApplication('Calc');
  const twinWindow = await windowLoop._verify(
    { type: 'window_visible', application: 'Calc', name: 'Informe listo' },
    { missionGrant: grant }
  );
  assert.strictEqual(twinWindow.verified, false, 'una ventana de Calculator no verifica Calc');

  const titleLoop = new DesktopMissionLoop({
    bridge: {
      execute: async () => ({
        ok: true,
        result: { nodes: [{ application: 'Agenda', window: 'No Confirmada' }] },
      }),
    },
  });
  const titleGrant = new MissionGrant({ applications: ['Agenda'] });
  titleGrant.setStepApplication('Agenda');
  const negatedWindow = await titleLoop._verify(
    { type: 'window_visible', application: 'Agenda', name: 'Confirmada' },
    { missionGrant: titleGrant }
  );
  assert.strictEqual(negatedWindow.verified, false, 'No Confirmada no prueba ventana Confirmada');

  const negated = harness([
    { application: 'Correo', button: 'Archivar', result: 'No archivado', done: true },
  ]);
  negated.mission.steps[0].expected.name = 'Archivado';
  const negatedResult = await runScripted(negated);
  assert.strictEqual(
    negatedResult.status,
    'paused',
    'No archivado no satisface la postcondición exacta Archivado'
  );

  const absentWithoutApp = harness([
    { application: 'Tareas', button: 'Eliminar aviso', result: 'Aviso pendiente' },
  ]);
  absentWithoutApp.state.apps.delete('Tareas');
  absentWithoutApp.mission.steps[0].expected = {
    type: 'ui_visible',
    application: 'Tareas',
    name: 'Aviso pendiente',
    absent: true,
  };
  const absentResult = await runScripted(absentWithoutApp);
  assert.strictEqual(
    absentResult.status,
    'paused',
    'UI ausente sin aplicación observable no es éxito'
  );

  // La revisión semántica bloquea un plan que omite parte de la petición.
  const omittedTask = harness([
    { application: 'Correo', button: 'Archivar', result: 'Archivado', done: true },
  ]);
  omittedTask.mission.goal = 'Archivar el correo y crear una cita en Agenda';
  const omittedResult = await runScripted(omittedTask, {
    planReview: {
      covered: false,
      gaps: ['Falta crear una cita en Agenda'],
      weakSteps: [],
    },
  });
  assert.strictEqual(
    omittedResult.status,
    'paused',
    'un plan sin todos los resultados no entra al ejecutor'
  );
  assert.strictEqual(omittedTask.state.actions.length, 0);
  const weakPostcondition = harness([
    { application: 'Correo', button: 'Enviar', result: 'Mensaje enviado' },
  ]);
  weakPostcondition.mission.goal = 'Enviar el mensaje redactado';
  weakPostcondition.mission.steps[0].expected = {
    type: 'ui_visible',
    application: 'Correo',
    name: 'Enviar',
    role: 'button',
  };
  await assert.rejects(
    () => runScripted(weakPostcondition),
    /control interactivo requiere un estado observable/,
    'un botón preexistente ya no prueba que se envió el mensaje'
  );
  assert.strictEqual(weakPostcondition.state.actions.length, 0);

  const now = new Date().toISOString();
  console.log(
    JSON.stringify({
      at: now,
      scenarios: {
        multiApp: {
          status: multiResult.status,
          actions: multi.state.actions.length,
          observations: multi.state.observations,
          approvals: multi.state.approvals.length,
          elapsedMs: multiResult.elapsedMs,
        },
        variedUi: { status: variedResult.status, actions: varied.state.actions.length },
        launchApp: { status: launchResult.status, actions: launch.state.actions.length },
        alreadyDone: { status: alreadyResult.status, actions: alreadyDone.state.actions.length },
        staleReference: { status: staleResult.status, actions: stale.state.actions.length },
        staleRecovery: { status: recoveryResult.status, actions: recovery.state.actions.length },
        delayedResult: { status: delayedResult.status, elapsedMs: delayedResult.elapsedMs },
        wrongApplication: {
          status: wrongResult.status,
          actions: wrong.state.actions.length,
          approvals: wrong.state.approvals.length,
        },
        applicationNameCollision: {
          uiVerified: twinUi.verified,
          windowVerified: twinWindow.verified,
        },
        negatedWindowTitle: { verified: negatedWindow.verified },
        negatedLabel: { status: negatedResult.status },
        absentWithoutApp: { status: absentResult.status },
        knownGapPlanOmission: { status: omittedResult.status, omittedTaskExecuted: false },
        weakPostconditionRejected: { actions: 0 },
      },
    })
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
