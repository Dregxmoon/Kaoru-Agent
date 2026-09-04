// @ts-check
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { StateGraph } = require('../core/state-graph/StateGraph.js');
const { GoalGovernor } = require('../core/goals/GoalGovernor.js');
const { PermissionManager } = require('../core/security/PermissionManager.js');

let passed = 0;
let failed = 0;

/** @param {unknown} condition @param {string} label */
function assert(condition, label) {
  if (condition) {
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
    passed++;
  } else {
    console.log(`  \x1b[31m✗\x1b[0m ${label}`);
    failed++;
  }
}

async function main() {
  console.log('\nGobernador ejecutivo — prioridad, consentimiento y verificación');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoru-governor-'));
  const workspace = path.join(dir, 'project');
  fs.mkdirSync(workspace);
  const graph = new StateGraph(path.join(dir, 'memory.db')).init();
  const permissionManager = new PermissionManager({ filePath: null, defaultAction: 'ask' });
  const events = [];
  const bus = { emit: (name, payload) => events.push({ name, payload }) };
  let executions = 0;
  const governor = new GoalGovernor({
    graph,
    bus,
    getWorkspace: () => workspace,
    getSessionId: () => 'session-1',
    getPermissionManager: () => permissionManager,
    execute: async () => {
      executions++;
      return { response: 'listo', iterations: 1, toolResults: [], error: null };
    },
    intervalMs: 10_000,
  });

  try {
    const suggestedId = graph.createIntention({
      sessionId: 'session-1',
      workspace,
      goal: 'Preparar el informe semanal',
    });
    graph.ensureGoalGovernance(suggestedId, workspace, { priority: 60 });
    const suggested = await governor.tick();
    assert(suggested.state === 'suggested', 'suggest es el nivel seguro por defecto');
    assert(executions === 0, 'suggest nunca ejecuta el objetivo');
    assert(
      events.some((event) => event.name === 'goal:ready'),
      'emite una señal proactiva trazable'
    );
    assert(
      graph.getGoalGovernance(suggestedId)?.state === 'waiting_user',
      'la sugerencia no se repite en cada heartbeat'
    );

    const actId = graph.createIntention({
      sessionId: 'session-1',
      workspace,
      goal: 'Verificar el estado del proyecto',
    });
    graph.ensureGoalGovernance(actId, workspace, { priority: 90 });
    graph.configureGoalGovernance(actId, { autonomy: 'act', state: 'pending' });
    const denied = await governor.tick();
    assert(denied.state === 'waiting_permission', 'act exige permiso externo explícito');
    assert(executions === 0, 'el fallback ask no se convierte en autorización');

    permissionManager.setRule({ tool: 'goal_run', path: workspace, action: 'allow' });
    graph.configureGoalGovernance(actId, { state: 'pending' });
    const executed = await governor.tick();
    assert(executed.state === 'completed', 'ejecuta y cierra una meta sin mutaciones verificables');
    assert(executions === 1, 'la meta autorizada se ejecuta una sola vez');
    assert(graph.getIntention(actId)?.status === 'done', 'el lifecycle cierra la intención');
    assert(
      graph.listGoalEvents(actId).some((event) => event.type === 'governor_claimed'),
      'la adquisición del lease queda auditada'
    );

    const manualId = graph.createIntention({
      sessionId: 'session-1',
      workspace,
      goal: 'Esperar decisión humana',
    });
    graph.ensureGoalGovernance(manualId, workspace, { autonomy: 'manual', priority: 100 });
    const manual = await governor.tick();
    assert(manual.state === 'paused', 'manual nunca genera trabajo autónomo');

    const leaseId = graph.createIntention({
      sessionId: 'session-1',
      workspace,
      goal: 'No duplicar ejecución',
    });
    graph.ensureGoalGovernance(leaseId, workspace, { autonomy: 'act' });
    const firstClaim = graph.claimGoalExecution(leaseId, { source: 'test', leaseMs: 60_000 });
    const secondClaim = graph.claimGoalExecution(leaseId, { source: 'test', leaseMs: 60_000 });
    assert(firstClaim && !secondClaim, 'el lease impide ejecuciones concurrentes duplicadas');
  } finally {
    governor.stop();
    graph.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\nResultado: ${passed} passed  ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
