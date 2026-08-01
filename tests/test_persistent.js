'use strict';

/**
 * Fase C — compañero persistente: presupuesto diario duro, /olvida y recap de
 * pendientes al arrancar, heurística de genuinidad.
 *
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron tests/test_persistent.js
 *
 * Cubre:
 *   - ProposalStore: byDay persistente, incremento, poda de días viejos, reset.
 *   - ProactiveEngine: presupuesto diario (DAILY_BUDGET=12) bloquea ANTES de
 *     consultar al LLM y solo se gasta con envíos reales (el "NO" del LLM no
 *     cuenta); expuesto en getStats().dailyBudget.
 *   - StateGraph.forget: archiva nodos por label/content, respeta soft-delete,
 *     no toca memoria sin coincidencias.
 *   - Comando /olvida: registrado y con handler vía IPC.
 *   - pendingRecap: detecta recordatorios recordar_* próximos y los ofrece al
 *     arrancar por el pipeline normal (LLM con la última palabra); sin
 *     pendientes → silencio.
 *   - Genuinidad: el prompt proactivo exige memoria factual (no inferir).
 */

const path = require('path');
const fs   = require('fs');
const os   = require('os');

const C = {
  green:  (s) => `\x1b[32m${s}\x1b[0m`,
  red:    (s) => `\x1b[31m${s}\x1b[0m`,
  cyan:   (s) => `\x1b[36m${s}\x1b[0m`,
  bold:   (s) => `\x1b[1m${s}\x1b[0m`,
  dim:    (s) => `\x1b[2m${s}\x1b[0m`,
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

const { ProactiveEngine } = require('../core/behavior/ProactiveEngine.js');
const { ProposalStore }   = require('../core/behavior/ProposalStore.js');
const { execute: executeCommand, getCommand, getHelp } = require('../core/commands/CommandRegistry.js');
const LLMProvider         = require('../core/llm/LLMProvider.js');
const { getEventBus }     = require('../infrastructure/event-bus/EventBus.js');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'persistent-'));

function fakeGraph(extra = {}) {
  return {
    _ready: true,
    queryNodes: () => [],
    getWorldModel: () => [],
    getRecentEpisodes: () => [],
    getLastSessions: () => [],
    ...extra,
  };
}

function fakeSensor() {
  return { getCurrentContext: () => ({ category: null, elapsed: 0, idleSecs: 0 }), getTodaySummary: () => '' };
}

function stubLLM({ complete } = {}) {
  const origP = LLMProvider.getActiveProvider;
  const origC = LLMProvider.complete;
  let calls = 0;
  LLMProvider.getActiveProvider = () => 'groq';
  LLMProvider.complete = async (...args) => { calls++; return complete ? complete(...args) : 'mensaje de prueba'; };
  return {
    calls: () => calls,
    lastSystemPrompt: () => LLMProvider.complete._lastSystem,
    restore: () => { LLMProvider.getActiveProvider = origP; LLMProvider.complete = origC; },
  };
}

function makeEngine(store, graph) {
  const engine = new ProactiveEngine(graph || fakeGraph(), { store });
  engine.setOSSensor(fakeSensor());
  engine.start();
  return engine;
}

// ── Test 1: ProposalStore — presupuesto diario ────────────────────────────────

function testDailyBudgetStore() {
  console.log(C.bold('\nTest 1: ProposalStore — presupuesto diario persistente'));

  const filePath = path.join(tmpDir, 'store-c1.json');
  const store = new ProposalStore({ filePath });
  store.reset();

  assert(store.dailyCount() === 0, 'inicia en 0');
  const dayKey = store.getDailyStats().dayKey;
  assert(/^\d{4}-\d{1,2}-\d{1,2}$/.test(dayKey), 'dayKey = fecha local YYYY-M-D');

  store.incrementDaily();
  store.incrementDaily();
  assert(store.dailyCount() === 2, 'incrementDaily → 2');
  assert(store.getDailyStats().count === 2, 'getDailyStats refleja el conteo');
  assert(store.dailyCount('2099-01-01') === 0, 'otro día → 0');

  const reloaded = new ProposalStore({ filePath });
  assert(reloaded.dailyCount(dayKey) === 2, 'recargado desde disco conserva el conteo del día');

  store.reset();
  assert(new ProposalStore({ filePath }).dailyCount() === 0, 'reset limpia el presupuesto');
}

// ── Test 2: ProactiveEngine — tope duro diario ────────────────────────────────

async function testDailyBudgetEngine() {
  console.log(C.bold('\nTest 2: ProactiveEngine — presupuesto diario (tope duro)'));

  const store = new ProposalStore({ filePath: path.join(tmpDir, 'store-c2.json') });
  store.reset();
  const engine = makeEngine(store);

  // 2a. Un envío real consume presupuesto (el LLM dio el OK)
  const stub = stubLLM({ complete: async () => 'prueba uno' });
  const bus = getEventBus();
  let fired = null;
  const l = (p) => { fired = p; };
  bus.on('initiative:trigger', l);
  const res = await engine._tryTrigger({ type: 'long_silence', context: 'x' });
  bus.off('initiative:trigger', l);
  assert(res === 'prueba uno', 'envío real → mensaje');
  assert(store.dailyCount() === 1, 'envío real → presupuesto 1/12');
  assert(engine.getStats().dailyBudget.count === 1, 'getStats().dailyBudget.count = 1');
  assert(engine.getStats().dailyBudget.limit === 12, 'getStats().dailyBudget.limit = 12');
  stub.restore();

  // 2b. El LLM dice NO → no se gasta presupuesto (intento frustrado no cuenta).
  //     Tipo distinto para no chocar con el cooldown de long_silence; y se
  //     resetea _lastProactive para no chocar con el gap global de 2a.
  //     Se usa env_unignored (crítico): el gate F-4 lo admite (ACT) y el LLM,
  //     ya en modo producción, decide no escribir (responde NO) → null.
  engine._lastProactive = 0;
  const stub2 = stubLLM({ complete: async () => 'NO' });
  const res2 = await engine._tryTrigger({ type: 'git_redflag', kind: 'env_unignored', context: 'El .env no está en .gitignore.' });
  assert(res2 === null, 'LLM NO → null');
  assert(store.dailyCount() === 1, 'LLM NO → presupuesto intacto');
  stub2.restore();

  // 2c. Agotar el presupuesto → bloqueado ANTES de consultar al LLM. Tipo
  //     nuevo para verificar que el bloqueo no toca el cooldown por tipo.
  for (let i = 0; i < 11; i++) store.incrementDaily();
  assert(store.dailyCount() === 12, 'presupuesto lleno (12)');
  const stub3 = stubLLM();
  const res3 = await engine._tryTrigger({ type: 'upcoming_event', context: 'x' });
  assert(res3 && res3.blocked, 'presupuesto agotado → { blocked }');
  assert(stub3.calls() === 0, 'presupuesto agotado → el LLM NUNCA se consulta');
  assert(!engine._lastAttemptByType['upcoming_event'], 'presupuesto agotado → no consume cooldown por tipo');
  stub3.restore();

  // 2d. Sin store → no hay presupuesto, no bloquea por esto
  const noStore = makeEngine(null);
  const stub4 = stubLLM();
  const res4 = await noStore._tryTrigger({ type: 'long_silence', context: 'x' });
  assert(res4 === 'mensaje de prueba', 'sin store → el presupuesto no bloquea');
  stub4.restore();

  engine.stop();
  noStore.stop();
}

// ── Test 3: StateGraph.forget ─────────────────────────────────────────────────

async function testForget() {
  console.log(C.bold('\nTest 3: StateGraph.forget — archivar memoria (/olvida)'));

  const { StateGraph } = require('../core/state-graph/StateGraph.js');
  const graph = new StateGraph(path.join(tmpDir, 'forget-c3.db'));
  await graph.init();  graph.createNode({ type: 'User', label: 'cumple_papa', content: 'Cumpleaños de papá: 15 de junio', importance: 0.9 });
  graph.createNode({ type: 'User', label: 'gusto_musica', content: 'Le gusta el rock de los 90', importance: 0.7 });
  graph.createNode({ type: 'Project', label: 'proyecto_march', content: 'Proyecto: asistente vtuber', importance: 0.8 });

  // 3a. Sin coincidencias
  const none = graph.forget('noexiste-nada');
  assert(none.found === 0 && none.archived === 0, 'sin coincidencias → found 0, archived 0');

  // 3b. Vacío / inválido
  assert(graph.forget('').error, 'texto vacío → error');
  assert(graph.forget(null).error, 'null → error');

  // 3c. Archiva por label (prioridad) y el nodo desaparece de queryNodes
  const res = graph.forget('cumple');
  assert(res.archived === 1, 'forget("cumple") archiva 1 nodo');
  assert(res.nodes[0] && res.nodes[0].label === 'cumple_papa', 'archivó el nodo con label correcto');
  const after = graph.queryNodes({ search: 'cumple' });
  assert(after.length === 0, 'el nodo archivado ya no aparece en consultas activas');

  // 3d. Coincidencia por contenido (no por label)
  const res2 = graph.forget('rock');
  assert(res2.archived >= 1, 'forget("rock") archiva por contenido');
  assert(graph.queryNodes({ search: 'rock' }).length === 0, 'nodo archivado por contenido fuera de las activas');

  // 3e. El resto de la memoria sigue intacta
  assert(graph.queryNodes({ search: 'asistente' }).length === 1, 'memoria no relacionada intacta');

  graph.close();
}

// ── Test 4: comando /olvida ───────────────────────────────────────────────────

function testOlvidaCommand() {
  console.log(C.bold('\nTest 4: comando /olvida'));

  assert(!!getCommand('olvida'), '/olvida registrado');
  assert(getHelp().includes('/olvida'), '/olvida aparece en /help');

  const ctx = {
    ipcRenderer: {
      invoke: async (channel, payload) => {
        if (channel === 'memory-forget' && payload.text === 'cumpleaños') {
          return { found: 2, archived: 1, nodes: [{ label: 'cumple_papa', content: 'Cumpleaños de papá: 15 de junio' }] };
        }
        if (payload.text === 'noexiste') return { found: 0, archived: 0 };
        return { found: 1, archived: 1, nodes: [], warning: 'memoria en RAM (no persistente)' };
      },
    },
  };

  executeCommand('/olvida cumpleaños', ctx).then(r => {
    assert(r.result.includes('Archivé **1** nodo(s)'), 'resultado describe el archivo');
    assert(r.result.includes('cumple_papa'), 'resultado lista el nodo archivado');
  });

  executeCommand('/olvida noexiste', ctx).then(r => {
    assert(r.result.includes('No encontré nada'), 'sin coincidencias → mensaje claro');
  });

  executeCommand('/olvida', ctx).then(r => {
    assert(r.result.includes('/olvida <texto>'), 'sin argumento → muestra el uso');
  });
}

// ── Test 5: pendingRecap (lo que quedó pendiente al arrancar) ────────────────

async function testPendingRecap() {
  console.log(C.bold('\nTest 5: pendingRecap — retomar pendientes al arrancar'));

  // 5a. Con un recordatorio próximo → detectado y ofrecido por el pipeline
  const graph = fakeGraph({
    queryNodes: () => [
      { id: 1, label: 'recordar_x1', content: 'Pidió recordar: llamar al doctor en 30 minutos', importance: 0.88 },
      { id: 2, label: 'no_es_recordar', content: 'otra cosa', importance: 0.5 },
    ],
  });
  const store = new ProposalStore({ filePath: path.join(tmpDir, 'store-c5.json') });
  store.reset();
  const engine = makeEngine(store, graph);

  const pendings = engine._collectPendingReminders();
  assert(pendings.length === 1, 'detecta SOLO el recordatorio válido');
  assert(pendings[0].nodeId === 1, 'referencia al nodo recordar_ correcto');
  assert(pendings[0].when > Date.now(), 'el pendiente es futuro');

  const stub = stubLLM({ complete: async () => 'Tienes pendiente llamar al doctor, ¿lo retomamos?' });
  const bus = getEventBus();
  let fired = null;
  const l = (p) => { fired = p; };
  bus.on('initiative:trigger', l);
  const res = await engine.pendingRecap();
  bus.off('initiative:trigger', l);
  assert(res && res.length > 5, 'pendingRecap → el LLM genera el recap');
  assert(fired && fired.reason === 'pending_recap', 'la iniciativa es de tipo pending_recap');
  assert(fired && fired.proposal && fired.proposal.kind === 'info', 'pending_recap → propuesta informativa (sin acción)');
  stub.restore();

  // 5b. Sin pendientes → silencio (nadie habla por hablar)
  const graphEmpty = fakeGraph();
  const engine2 = makeEngine(store, graphEmpty);
  const res2 = await engine2.pendingRecap();
  assert(res2 === null, 'sin pendientes → pendingRecap no emite nada');
  engine2.stop();

  // 5c. observe → no ofrece recap
  const engine3 = makeEngine(store, graph);
  engine3.setAutonomyMode('observe');
  const res3 = await engine3.pendingRecap();
  assert(res3 === null, 'observe → sin recap (solo observa)');

  engine.stop();
  engine3.stop();
}

// ── Test 6: heurística de genuinidad ─────────────────────────────────────────

async function testGenuinityPrompt() {
  console.log(C.bold('\nTest 6: genuinidad — el prompt proactivo exige memoria factual'));

  const store = new ProposalStore({ filePath: path.join(tmpDir, 'store-c6.json') });
  store.reset();
  const engine = makeEngine(store, fakeGraph());

  const stub = stubLLM({ complete: async (...args) => {
    stub._lastSystem = args[1];
    return 'm';
  } });
  await engine._tryTrigger({ type: 'long_silence', context: 'x' });

  const system = stub._lastSystem || '';
  assert(system.includes('REGLA DE MEMORIA FACTUAL'), 'prompt contiene la regla de memoria factual');
  assert(system.includes('Nunca inventes'), 'prompt prohíbe inventar');
  assert(system.includes('memoria que aparece abajo'), 'memoria como fuente obligatoria');
  stub.restore();
  engine.stop();
}

// ── Runner ────────────────────────────────────────────────────────────────────

(async () => {
  console.log(C.cyan(C.bold('Fase C — compañero persistente: presupuesto diario, /olvida, pendientes, genuinidad')));

  testDailyBudgetStore();
  await testDailyBudgetEngine();
  await testForget();
  testOlvidaCommand();
  await testPendingRecap();
  await testGenuinityPrompt();

  // Los asserts async del comando corren por microtareas; esperar un tick.
  await new Promise(r => setImmediate(r));

  console.log('');
  console.log(C.bold(`Resultado: ${C.green(passed + ' ✓')} / ${C.red(failed + ' ✗')}`));
  process.exit(failed ? 1 : 0);
})().catch(e => {
  console.error(C.red('Fallo en la ejecución de la suite:'), e);
  process.exit(1);
});
