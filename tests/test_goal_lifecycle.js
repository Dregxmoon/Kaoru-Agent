// @ts-check
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { StateGraph } = require('../core/state-graph/StateGraph.js');
const { beginGoal, settleGoal } = require('../core/memory/GoalLifecycle.js');

let passed = 0;
let failed = 0;

/** @param {unknown} condition @param {string} label */
function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${label}`);
  }
}

function main() {
  console.log('\nCiclo durable de objetivos — alcance y evidencia');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoru-goal-life-'));
  const workspaceA = path.join(dir, 'alpha');
  const workspaceB = path.join(dir, 'beta');
  fs.mkdirSync(workspaceA);
  fs.mkdirSync(workspaceB);
  const graph = new StateGraph(path.join(dir, 'memory.db')).init();
  try {
    graph.createIntention({
      sessionId: 'session-a',
      workspace: workspaceA,
      goal: 'Meta exclusiva de alpha',
    });
    graph.createIntention({
      sessionId: 'session-b',
      workspace: workspaceB,
      goal: 'Meta exclusiva de beta',
    });
    const alphaOnly = graph.listActiveIntentions({ workspace: workspaceA });
    assert(alphaOnly.length === 1, 'filtra intenciones por workspace');
    assert(alphaOnly[0].goal.includes('alpha'), 'no mezcla el objetivo de otro proyecto');

    const commitment = beginGoal({
      graph,
      sessionId: 'session-a',
      workspace: workspaceA,
      goal: 'Implementar una mejora verificable',
    });
    assert(commitment?.resumed === false, 'registra una tarea smart desde el inicio');
    const resumed = beginGoal({
      graph,
      sessionId: 'session-a',
      workspace: workspaceA,
      goal: 'Implementar una mejora verificable',
    });
    assert(resumed?.id === commitment?.id && resumed?.resumed, 'retoma sin duplicar el compromiso');

    const unfinished = settleGoal({
      graph,
      commitment,
      workspace: workspaceA,
      result: {
        plan: { steps: ['Editar el módulo', 'Ejecutar pruebas'], done: 1, total: 2 },
        toolResults: [{ tool: 'edit', ok: true }],
      },
      evaluation: {
        terminalSuccess: true,
        success: false,
        verificationStatus: 'unverified',
        verificationReason: 'verification_missing',
        mutationCount: 1,
      },
    });
    assert(unfinished.state === 'active', 'una mutación sin verificar no completa el objetivo');
    assert(
      graph.getIntention(commitment.id)?.status === 'active',
      'conserva el objetivo para reanudarlo'
    );
    assert(
      graph.getProjectCompanion(workspaceA)?.phase === 'verifying',
      'el compañero sabe que falta verificación'
    );

    const completed = settleGoal({
      graph,
      commitment,
      workspace: workspaceA,
      result: { plan: { steps: ['Editar el módulo', 'Ejecutar pruebas'], done: 2, total: 2 } },
      evaluation: {
        terminalSuccess: true,
        success: true,
        verificationStatus: 'verified',
        verificationReason: 'verification_passed',
        mutationCount: 1,
      },
    });
    assert(completed.state === 'completed', 'cierra el objetivo cuando existe evidencia');
    assert(
      graph.getIntention(commitment.id)?.status === 'done',
      'marca la intención como resuelta'
    );
    const companion = graph.getProjectCompanion(workspaceA);
    assert(!companion?.objective && !companion?.nextStep, 'limpia el hilo activo al completar');
    assert(
      graph.listGoalEvents(commitment.id).some((event) => event.type === 'goal_completed'),
      'conserva un ledger del cierre verificable'
    );
  } finally {
    graph.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\nResultado: ${passed} passed  ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main();
