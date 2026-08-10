'use strict';

// test_intentions.js — Fase 3, ítem 1: metas persistentes.
// Stack de intenciones activas que sobreviven al reinicio y se re-inyectan
// al prompt del agente al reanudar (re-planificación).

const fs = require('fs');
const os = require('os');
const path = require('path');

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

let passed = 0;
let failed = 0;

function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  ${C.green('✓')} ${label}`);
    passed++;
  } else {
    console.log(`  ${C.red('✗')} ${label}`);
    if (detail) console.log(`    ${C.dim(detail)}`);
    failed++;
  }
}

const { StateGraph } = require('../core/state-graph/StateGraph.js');
const { SessionManager } = require('../core/state-graph/SessionManager.js');
const { AgentLoop, buildActiveIntentionsSection } = require('../core/planner/AgentLoop.js');
const Core = require('../core/Core.js');
const state = require('../core/core/state.js');

function makeGraph() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'int-test-'));
  const graph = new StateGraph(path.join(dir, 'core.db')).init();
  return { graph, dir };
}

// ── Test 1: IntentionsStore — stack persistente ────────────────────────────
function testStore() {
  console.log(C.bold('\nTest 1: IntentionsStore — stack de intenciones activas'));
  const { graph, dir } = makeGraph();

  const a = graph.createIntention({
    sessionId: 's1',
    goal: 'Refactorizar el modulo auth',
    steps: [{ description: 'leer auth.js' }],
  });
  const b = graph.createIntention({
    sessionId: 's1',
    goal: 'Escribir tests de intenciones',
    steps: [],
  });
  const c = graph.createIntention({ sessionId: 's2', goal: 'Actualizar README', steps: [] });
  assert(a !== null && b !== null && c !== null, 'createIntention devuelve ids');

  const stack = graph.listActiveIntentions({ limit: 10 });
  assert(stack.length === 3, 'las 3 intenciones están activas');
  // Stack: la más reciente es el tope (orden updated_at DESC, id DESC).
  assert(stack[0].goal === 'Actualizar README', 'tope del stack = la más reciente', stack[0]?.goal);
  assert(
    stack[2].goal === 'Refactorizar el modulo auth',
    'fondo del stack = la más antigua',
    stack[2]?.goal
  );

  // Completar el tope: deja la siguiente como candidata a retomar.
  assert(graph.completeIntention(c), 'completeIntention marca done');
  const after = graph.listActiveIntentions({ limit: 10 });
  assert(after.length === 2, 'solo quedan 2 activas');
  assert(
    after[0].goal === 'Escribir tests de intenciones',
    'la siguiente pasa al tope',
    after[0]?.goal
  );

  // Persistencia real: nueva instancia sobre la misma DB.
  const g2 = new StateGraph(path.join(dir, 'core.db')).init();
  const reloaded = g2.listActiveIntentions({ limit: 10 });
  assert(reloaded.length === 2, 'las intenciones sobreviven al reinicio');
  assert(reloaded[0].goal === 'Escribir tests de intenciones', 'el orden del stack persiste');

  // update: progreso + steps.
  assert(
    g2.updateIntention(a, {
      lastProgress: 'auth leído, falta el refactor',
      steps: [{ description: 'leer auth.js', status: 'done' }],
    }),
    'updateIntention actualiza progreso'
  );
  assert(g2.getIntention(a).last_progress.includes('auth leído'), 'last_progress persistido');
  assert(g2.getIntention(a).status === 'active', 'sigue activa');

  assert(g2.dropIntention(b), 'dropIntention descarta');
  const stats = g2.intentionStats();
  assert(stats.active === 1, 'stats: 1 activa', JSON.stringify(stats));
  assert(
    stats.done === 1 && stats.dropped === 1,
    'stats: 1 done + 1 dropped',
    JSON.stringify(stats)
  );

  g2.close();
  graph.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Test 2: SessionManager — re-planificación al reanudar ──────────────────
async function testSessionManager() {
  console.log(C.bold('\nTest 2: SessionManager expone el stack al iniciar/reanudar'));
  const { graph, dir } = makeGraph();

  // Sesión previa interrumpida con una meta en vuelo.
  const sid = graph.startSession();
  graph.createIntention({ sessionId: sid, goal: 'Terminar la migración de la DB', steps: [] });

  // El SessionManager, al reanudar esa sesión, devuelve la intención activa.
  const sm = new SessionManager(graph, null, { resumeMaxAgeHours: 48 });
  const res = await sm.start(null);
  assert(res.activeIntentions.length >= 1, 'start() devuelve el stack de intenciones activas');
  assert(
    res.activeIntentions[0].goal === 'Terminar la migración de la DB',
    'la meta en vuelo se re-expone para re-planificar',
    JSON.stringify(res.activeIntentions)
  );
  assert(sm.getSessionId(), 'getSessionId expone la sesión activa');
  assert(sm.getActiveIntentions().length === 1, 'getActiveIntentions = alias del stack');

  sm.close();
  graph.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Test 3: buildActiveIntentionsSection (bloque del prompt) ───────────────
function testBuilder() {
  console.log(C.bold('\nTest 3: buildActiveIntentionsSection — bloque del prompt'));
  assert(buildActiveIntentionsSection([]) === null, 'sin intenciones → null');
  assert(buildActiveIntentionsSection(null) === null, 'null → null');

  const block = buildActiveIntentionsSection([
    {
      goal: 'Arreglar el login',
      last_progress: 'falló la 2ª iteración',
      steps: JSON.stringify([{ description: 'revisar auth' }]),
    },
  ]);
  assert(block && block.includes('# INTENCIONES ACTIVAS PENDIENTES'), 'encabezado presente');
  assert(block.includes('Arreglar el login'), 'meta en el bloque');
  assert(block.includes('falló la 2ª iteración'), 'progreso en el bloque');
  assert(block.includes('revisar auth'), 'pasos deserializados del JSON');
}

// ── Test 4: AgentLoop inyecta el stack al prompt del agente ────────────────
async function testLoopInjection() {
  console.log(C.bold('\nTest 4: AgentLoop re-planifica con las intenciones activas'));
  let capturedPrompt = null;
  const mockLLM = async (_messages, systemPrompt) => {
    capturedPrompt = systemPrompt;
    return 'Hecho, retomando la tarea pendiente.';
  };
  const loop = new AgentLoop({ maxIterations: 3, llm: mockLLM, bridge: {} });
  const result = await loop.run('retomá la tarea anterior', 'Eres un asistente útil.', [], {
    activeIntentions: [
      { id: 7, goal: 'Terminar la migración de la DB', last_progress: 'se cortó a mitad' },
    ],
  });
  assert(result.response.includes('retomando'), 'el loop terminó');
  assert(
    capturedPrompt && capturedPrompt.includes('# INTENCIONES ACTIVAS PENDIENTES'),
    'la sección de intenciones llegó al systemPrompt'
  );
  assert(capturedPrompt.includes('Terminar la migración de la DB'), 'la meta está en el prompt');
}

// ── Test 5: Core facade ────────────────────────────────────────────────────
function testCoreFacade() {
  console.log(C.bold('\nTest 5: Core — fachada de metas persistentes'));
  const { graph, dir } = makeGraph();
  const prevGraph = state.graph;
  const prevSession = state.session;
  state.graph = graph;
  state.session = { getSessionId: () => 's-facade' };
  try {
    const id = Core.addIntention({ goal: 'Meta vía fachada' });
    assert(typeof id === 'number' && id > 0, 'addIntention crea la intención');
    const list = Core.listIntentions({ limit: 10 });
    assert(list.length === 1 && list[0].goal === 'Meta vía fachada', 'listIntentions la recupera');
    assert(Core.completeIntention(id), 'completeIntention resuelve');
    const stats = Core.getIntentionsStats();
    assert(
      stats.active === 0 && stats.done === 1,
      'stats reflejan la resolución',
      JSON.stringify(stats)
    );
  } finally {
    state.graph = prevGraph;
    state.session = prevSession;
    graph.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── Runner ─────────────────────────────────────────────────────────────────
async function main() {
  testStore();
  await testSessionManager();
  testBuilder();
  await testLoopInjection();
  testCoreFacade();

  const total = passed + failed;
  console.log(C.bold('\n═══════════════════════════════════════════'));
  console.log(
    C.bold(
      `  Resultado: ${C.green(`${passed} passed`)}  ${failed > 0 ? C.red(`${failed} failed`) : C.dim('0 failed')}  / ${total} total`
    )
  );
  console.log(C.bold('═══════════════════════════════════════════\n'));
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(C.red('[test_intentions] ERROR inesperado:'), e);
  process.exit(1);
});
