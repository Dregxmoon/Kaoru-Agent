// @ts-check
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { StateGraph } = require('../core/state-graph/StateGraph.js');
const { buildActiveIntentionsSection } = require('../core/planner/AgentLoop.js');
const { ObservationBridge } = require('../core/perception/ObservationBridge.js');

let passed = 0;
let failed = 0;

function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
    passed++;
  } else {
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

function testProspectiveGoalGraph() {
  console.log('\nMemoria prospectiva — grafo de pasos verificables');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoru-goals-'));
  const dbPath = path.join(dir, 'memory.db');
  let graph = new StateGraph(dbPath).init();
  try {
    const id = graph.createIntention({
      sessionId: 's-goal',
      goal: 'Publicar una versión estable',
      steps: [
        { description: 'Revisar cambios', successCriteria: ['diff inspeccionado'] },
        { description: 'Ejecutar pruebas' },
        { description: 'Publicar artefactos' },
      ],
    });
    assert(typeof id === 'number', 'crea intención con plan estructurado');
    const plan = graph.getGoalPlan(id);
    assert(plan.length === 3, 'persiste todos los pasos');
    assert(plan[0].dependsOn.length === 0, 'primer paso no tiene dependencias');
    assert(plan[1].dependsOn[0] === 1 && plan[2].dependsOn[0] === 2, 'encadena dependencias');
    assert(plan[0].successCriteria[0] === 'diff inspeccionado', 'conserva criterio de éxito');

    graph.updateGoalStep(id, 1, { status: 'completed' });
    assert(
      graph.getGoalPlan(id)[0].status === 'awaiting_verification',
      'no acepta completed sin evidencia'
    );
    assert(graph.getGoalResumePoint(id).state === 'verify', 'reanuda verificando lo pendiente');

    graph.updateGoalStep(id, 1, {
      status: 'completed',
      verification: { status: 'verified', source: 'test' },
    });
    const resume = graph.getGoalResumePoint(id);
    assert(
      resume.state === 'ready' && resume.step.ordinal === 2,
      'avanza al siguiente paso elegible'
    );

    graph.recordGoalRunProgress(id, { done: 2, total: 3 });
    const afterProgress = graph.getGoalPlan(id);
    assert(
      afterProgress[1].status === 'awaiting_verification',
      'progreso observado no finge verificación'
    );
    assert(afterProgress[2].status === 'in_progress', 'marca el próximo foco sin completarlo');

    assert(
      !graph.completeGoalPlan(id, { status: 'unverified' }),
      'rechaza completar el plan con evidencia insuficiente'
    );
    assert(
      graph.completeGoalPlan(id, { status: 'verified', source: 'suite', reason: 'checks verdes' }),
      'permite cierre global verificado'
    );
    assert(graph.getGoalResumePoint(id).state === 'complete', 'plan queda completamente resuelto');
    assert(graph.listGoalEvents(id).length >= 5, 'ledger conserva la evolución del objetivo');

    graph.close();
    graph = new StateGraph(dbPath).init();
    const restored = graph.getIntention(id);
    assert(restored?.goal_plan?.length === 3, 'el grafo sobrevive al reinicio');
    assert(restored?.resume_point?.state === 'complete', 'restaura el punto de reanudación');

    const legacyInfo = graph._db
      .prepare(
        `INSERT INTO intentions
          (session_id, goal, status, steps, last_progress, last_progress_at, created_at, updated_at)
         VALUES (?, ?, 'active', ?, '', ?, ?, ?)`
      )
      .run(
        's-old',
        'Meta antigua',
        JSON.stringify(['Paso legado']),
        Date.now(),
        Date.now(),
        Date.now()
      );
    const legacy = graph.getIntention(Number(legacyInfo.lastInsertRowid));
    assert(legacy?.goal_plan?.length === 1, 'materializa planes JSON de versiones antiguas');
  } finally {
    graph.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testContextualCue() {
  console.log('\nMemoria prospectiva — recordatorio condicionado por percepción');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoru-cues-'));
  const graph = new StateGraph(path.join(dir, 'memory.db')).init();
  /** @type {Map<string, Array<(payload:any)=>void>>} */
  const handlers = new Map();
  /** @type {any[]} */
  const emitted = [];
  const bus =
    /** @type {{on:(event:string,handler:(payload:any)=>void)=>()=>void, emit:(event:string,payload:any)=>void}} */ ({
      on(event, handler) {
        const list = handlers.get(event) || [];
        list.push(handler);
        handlers.set(event, list);
        return () =>
          handlers.set(
            event,
            (handlers.get(event) || []).filter((item) => item !== handler)
          );
      },
      emit(event, payload) {
        emitted.push({ event, payload });
        for (const handler of handlers.get(event) || []) handler(payload);
      },
    });
  try {
    const id = graph.createIntention({
      sessionId: 's-cue',
      goal: 'Publicar desde producción',
      steps: [
        {
          description: 'Ejecutar release',
          triggerContext: { event: 'git:branch-changed', match: { branch: 'produccion' } },
          dueAt: Date.now() - 1,
        },
      ],
    });
    const bridge = new ObservationBridge({ bus, graph }).start();
    bus.emit('git:branch-changed', { prev: 'main', branch: 'produccion' });
    const cues = emitted.filter((item) => item.event === 'memory:upcoming-event');
    assert(cues.length === 1, 'la percepción coincidente despierta el objetivo');
    assert(cues[0].payload.intentionId === id, 'el recordatorio conserva identidad del objetivo');
    assert(cues[0].payload.kind === 'prospective_goal', 'distingue el recordatorio prospectivo');

    bus.emit('git:branch-changed', { prev: 'main', branch: 'produccion' });
    assert(
      emitted.filter((item) => item.event === 'memory:upcoming-event').length === 1,
      'cooldown evita repetir el mismo recordatorio'
    );
    bridge.stop();
  } finally {
    graph.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testPromptProjection() {
  console.log('\nMemoria prospectiva — proyección segura al prompt');
  const block = buildActiveIntentionsSection([
    {
      goal: 'Terminar CI',
      last_progress: 'tests ejecutados',
      steps: '[]',
      goal_plan: [
        { ordinal: 1, description: 'Revisar lint', status: 'completed' },
        { ordinal: 2, description: 'Empaquetar', status: 'in_progress' },
      ],
      resume_point: {
        state: 'ready',
        step: { ordinal: 2, description: 'Empaquetar' },
      },
    },
  ]);
  assert(block?.includes('[completed] Revisar lint'), 'proyecta estado de cada paso');
  assert(
    block?.includes('Próximo foco: Empaquetar (ready)'),
    'proyecta punto exacto de reanudación'
  );
}

testProspectiveGoalGraph();
testPromptProjection();
testContextualCue();

console.log(`\nResultado: ${passed} passed  ${failed} failed`);
if (failed) process.exit(1);
