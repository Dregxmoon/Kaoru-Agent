'use strict';

/**
 * Fase A — autonomía con consentimiento: propuestas, feedback persistido y
 * slider de autonomía.
 *
 * IMPORTANTE: correr con ELECTRON_RUN_AS_NODE=1 (igual que test_proactive):
 *
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron tests/test_proposals.js
 *
 * Cubre:
 *   - ProposalStore: persistencia en disco, contadores por tipo, factor de
 *     cooldown por rechazos consecutivos (tope ×3), reset con aceptación.
 *   - Payload de iniciativa con `proposal` determinista (id/title/preview/
 *     action declarada) para señales con hint; `proposal: null` para las que
 *     no (el LLM NUNCA inventa la propuesta).
 *   - Decisiones (aceptar/descartar) → feedback persistido + factor de cooldown
 *     aplicado (tanto por handler directo como por evento 'initiative:decision').
 *   - Autonomía graduada: `act` sólo ejecuta sin otro clic cuando una política
 *     persistente y explícita devuelve `allow`; el fallback sigue preguntando.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
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

const { ProactiveEngine } = require('../core/behavior/ProactiveEngine.js');
const { ProposalStore } = require('../core/behavior/ProposalStore.js');
const LLMProvider = require('../core/llm/LLMProvider.js');
const { getEventBus } = require('../infrastructure/event-bus/EventBus.js');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proposals-'));

function fakeGraph() {
  return {
    _ready: true,
    queryNodes: () => [],
    getWorldModel: () => [],
    getRecentEpisodes: () => [],
    getLastSessions: () => [],
  };
}

function fakeSensor() {
  return {
    getCurrentContext: () => ({ category: null, elapsed: 0, idleSecs: 0 }),
    getTodaySummary: () => '',
  };
}

let defaultMessageSeq = 0;

function stubLLM({ provider = 'groq', complete } = {}) {
  const origP = LLMProvider.getActiveProvider;
  const origC = LLMProvider.complete;
  let calls = 0;
  LLMProvider.getActiveProvider = () => provider;
  LLMProvider.complete = async (...args) => {
    calls++;
    return complete
      ? complete(...args)
      : `mensaje de propuesta de prueba variante${++defaultMessageSeq}`;
  };
  return {
    calls: () => calls,
    restore: () => {
      LLMProvider.getActiveProvider = origP;
      LLMProvider.complete = origC;
    },
  };
}

function makeEngine(store) {
  const engine = new ProactiveEngine(fakeGraph(), { store });
  engine.setOSSensor(fakeSensor());
  engine.start();
  return engine;
}

// ── Test 1: ProposalStore — persistencia y factor de cooldown ─────────────────

function testProposalStore() {
  console.log(C.bold('\nTest 1: ProposalStore — persistencia y factor de cooldown'));

  const filePath = path.join(tmpDir, 'store-1.json');
  const store = new ProposalStore({ filePath });
  store.reset();

  // 1a. Rechazos consecutivos → factor crece hasta el tope
  store.record({ proposalId: 'p1', type: 'git_redflag', decision: 'rejected' });
  assert(store.cooldownMultiplier('git_redflag') === 1.5, '1 rechazo → factor 1.5');
  store.record({ proposalId: 'p2', type: 'git_redflag', decision: 'rejected' });
  assert(store.cooldownMultiplier('git_redflag') === 2, '2 rechazos seguidos → factor 2');
  store.record({ proposalId: 'p3', type: 'git_redflag', decision: 'rejected' });
  assert(store.cooldownMultiplier('git_redflag') === 2.5, '3 rechazos → factor 2.5');
  store.record({ proposalId: 'p4', type: 'git_redflag', decision: 'rejected' });
  assert(store.cooldownMultiplier('git_redflag') === 3, '4+ rechazos → tope 3 (no explota)');

  // 1b. Aceptar resetea la racha de rechazos
  store.record({ proposalId: 'p5', type: 'git_redflag', decision: 'accepted' });
  assert(store.cooldownMultiplier('git_redflag') === 1, 'aceptar resetea la racha → factor 1');
  assert(
    store._data.byType.git_redflag.accepted === 1 && store._data.byType.git_redflag.rejected === 4,
    'contadores por tipo correctos'
  );

  // 1c. Persistencia real en disco (recargar desde archivo)
  const reloaded = new ProposalStore({ filePath });
  assert(
    reloaded._data.byType.git_redflag.rejected === 4,
    'recargado desde disco conserva los rechazos'
  );
  assert(reloaded._data.byType.git_redflag.accepted === 1, 'recargado conserva las aceptaciones');

  // 1d. Tipos sin feedback → factor 1
  assert(
    new ProposalStore({ filePath }).cooldownMultiplier('long_silence') === 1,
    'tipo sin feedback → factor 1'
  );

  // 1e. reset limpia el archivo
  store.reset();
  assert(
    new ProposalStore({ filePath })._data.byType.git_redflag === undefined,
    'reset deja el store vacío en disco'
  );
}

// ── Test 2: payload con propuesta determinista ────────────────────────────────

async function testPayload() {
  console.log(C.bold('\nTest 2: payload de iniciativa con propuesta determinista'));

  const bus = getEventBus();

  // 2a. git_redflag env_unignored → propuesta 'action' con acción declarada
  const store = new ProposalStore({ filePath: path.join(tmpDir, 'store-2.json') });
  store.reset();
  const engine = makeEngine(store);
  const stub = stubLLM();
  let captured = null;
  const listener = (p) => {
    captured = p;
  };
  bus.on('initiative:trigger', listener);
  const res = await engine._tryTrigger({
    type: 'git_redflag',
    kind: 'env_unignored',
    context: 'El .env no está en .gitignore.',
  });
  bus.off('initiative:trigger', listener);
  stub.restore();
  engine.stop();

  assert(res, 'trigger pasa el pre-filtro y el LLM genera mensaje');
  assert(captured && captured.proposal, 'payload lleva bloque proposal');
  assert(
    captured?.proposal?.id && typeof captured.proposal.id === 'string',
    'proposal.id generado'
  );
  assert(captured?.proposal?.type === 'git_redflag', 'proposal.type = tipo del trigger');
  assert(captured?.proposal?.kind === 'action', 'proposal.kind = action');
  assert(
    captured?.proposal?.action?.tool === 'gitignore_add',
    'proposal.action declarada (Fase B la ejecuta)'
  );
  assert(
    captured?.proposalId === captured?.proposal?.id,
    'proposalId del payload coincide con proposal.id'
  );
  assert(
    typeof captured?.proposal?.title === 'string' && captured.proposal.title.length > 0,
    'proposal.title presente'
  );

  // 2b. Trigger sin hint → proposal null (solo informa)
  const engine2 = makeEngine(store);
  const stub2 = stubLLM();
  let captured2 = null;
  const listener2 = (p) => {
    captured2 = p;
  };
  bus.on('initiative:trigger', listener2);
  await engine2._tryTrigger({ type: 'long_silence', context: 'x' });
  bus.off('initiative:trigger', listener2);
  stub2.restore();
  engine2.stop();

  assert(captured2 && captured2.proposal === null, 'sin hint → proposal null');
  assert(captured2 && captured2.proposalId === null, 'sin hint → proposalId null');

  // 2c. kind desconocido cae al hint default de su tipo. Se prueba vía
  //     _buildPayload directo: el gate (Fase F) ya decide si la señal llega al
  //     LLM; aquí se verifica el build determinista de la propuesta.
  const engine3 = makeEngine(store);
  const payload3 = await engine3._buildPayload(
    { type: 'git_redflag', kind: 'unpushed_commits', context: 'Hay commits sin subir.' },
    'mensaje'
  );
  engine3.stop();

  assert(
    payload3?.proposal?.type === 'git_redflag',
    'kind sin entrada propia → hint default del tipo'
  );
  assert(payload3?.proposal?.action?.tool === 'git_status', 'default de git_redflag → git_status');
}

// ── Test 3: decisiones → feedback + cooldown efectivo ─────────────────────────

function testDecisions() {
  console.log(C.bold('\nTest 3: decisiones del usuario → feedback persistido + cooldown efectivo'));

  const store = new ProposalStore({ filePath: path.join(tmpDir, 'store-3.json') });
  store.reset();
  const engine = makeEngine(store);

  // 3a. handler directo
  const s1 = engine.handleDecision({
    proposalId: 'p-1',
    type: 'system_warning',
    decision: 'accepted',
  });
  assert(s1 && s1.accepted === 1, 'handleDecision(accepted) registra en el store');
  assert(store.cooldownMultiplier('system_warning') === 1, 'aceptar no penaliza el cooldown');

  // 3b. el cooldown efectivo aplica el factor
  const before = engine.getCooldownFor('system_warning');
  engine.handleDecision({ proposalId: 'p-2', type: 'system_warning', decision: 'rejected' });
  engine.handleDecision({ proposalId: 'p-3', type: 'system_warning', decision: 'rejected' });
  const after = engine.getCooldownFor('system_warning');
  assert(before.base === after.base, 'la base del cooldown no cambia');
  assert(after.effective === after.base * 2, 'efectivo = base × factor tras 2 rechazos');
  assert(after.factor === 2, 'factor expuesto en getCooldownFor');

  // 3c. validación: decisiones inválidas / sin store
  assert(
    engine.handleDecision({ proposalId: 'x', type: 'system_warning', decision: 'maybe' }) === false,
    'decisión inválida → false'
  );
  const noStore = new ProactiveEngine(fakeGraph());
  assert(
    noStore.handleDecision({ proposalId: 'x', type: 'system_warning', decision: 'accepted' }) ===
      false,
    'sin store → false (no-op)'
  );

  engine.stop();
}

// ── Test 4: decisión vía bus (camino real IPC → Core → engine) ──────────

async function testBusDecision() {
  console.log(C.bold('\nTest 4: decisión vía evento del bus (camino real)'));

  const bus = getEventBus();
  const store = new ProposalStore({ filePath: path.join(tmpDir, 'store-4.json') });
  store.reset();
  const engine = makeEngine(store);

  bus.emit('initiative:decision', { proposalId: 'p-4', type: 'error_title', decision: 'rejected' });
  await new Promise((r) => setImmediate(r));

  assert(
    store._data.byType.error_title?.rejected === 1,
    'emit en el bus → feedback persistido por el engine'
  );
  assert(
    engine.getCooldownFor('error_title').factor === 1.5,
    'factor aplicado tras el rechazo por bus'
  );

  engine.stop();
}

// ── Test 5: slider de autonomía ───────────────────────────────────────────────

async function testAutonomySlider() {
  console.log(C.bold('\nTest 5: slider de autonomía (observe | suggest | act)'));

  const store = new ProposalStore({ filePath: path.join(tmpDir, 'store-5.json') });
  store.reset();

  // 5a. observe → bloquea todo sin consultar al LLM
  const engine = makeEngine(store);
  engine.setAutonomyMode('observe');
  assert(engine.getAutonomyMode() === 'observe', 'setAutonomyMode(observe) aplicado');
  const stub = stubLLM();
  const res = await engine._tryTrigger({ type: 'long_silence', context: 'x' });
  assert(res && res.blocked, 'observe → { blocked }');
  assert(stub.calls() === 0, 'observe → el LLM NUNCA se consulta');
  assert(!engine._lastAttemptByType['long_silence'], 'observe → no consume cooldown');
  stub.restore();

  // 5b. suggest (default) → informa + propone. Se usa una señal que el gate
  //     admite (env_unignored es crítico → ACT), verificando el flujo completo
  //     en modo suggest; y _buildPayload directo para la propuesta informativa.
  const engine2 = makeEngine(store);
  assert(engine2.getAutonomyMode() === 'suggest', 'modo default = suggest');
  const stub2 = stubLLM();
  await engine2._tryTrigger({
    type: 'git_redflag',
    kind: 'env_unignored',
    context: 'El .env no está en .gitignore.',
  });
  assert(stub2.calls() === 1, 'suggest → consulta al LLM');

  const infoPayload = await engine2._buildPayload(
    { type: 'upcoming_event', context: 'Recordatorio: doctor a las 5.' },
    'mensaje'
  );
  assert(
    infoPayload && infoPayload.proposal && infoPayload.proposal.kind === 'info',
    'suggest → lleva propuesta informativa'
  );
  stub2.restore();

  // 5c. act sin regla explícita sigue proponiendo; nunca convierte un default en permiso.
  const engine3 = makeEngine(store);
  engine3.setAutonomyMode('act');
  const stub3 = stubLLM();
  const res3 = await engine3._tryTrigger({ type: 'long_silence', context: 'x' });
  assert(res3, 'act → conserva la propuesta cuando no hay autorización explícita');
  stub3.restore();

  // 5d. valor inválido → cae a suggest
  engine3.setAutonomyMode('todo_poder');
  assert(engine3.getAutonomyMode() === 'suggest', 'valor inválido → suggest');

  engine.stop();
  engine2.stop();
  engine3.stop();
}

function testContextPreferences() {
  console.log(C.bold('\nTest 6: presencia adaptativa por contexto'));
  const filePath = path.join(tmpDir, 'store-context.json');
  const store = new ProposalStore({ filePath });
  store.reset();

  assert(store.getContextPolicy('search').effective === 'quiet', 'búsqueda parte en silencio');
  const explicit = store.setContextPreference('work', 'engaged');
  assert(
    explicit.ok && explicit.source === 'explicit',
    'una preferencia explícita tiene prioridad'
  );
  assert(
    new ProposalStore({ filePath }).getContextPolicy('work').effective === 'engaged',
    'la preferencia sobrevive al reinicio'
  );

  for (let i = 0; i < 4; i++) {
    store.record({
      proposalId: `media-${i}`,
      type: 'media_watching',
      decision: 'accepted',
      context: 'media',
    });
  }
  const learned = store.getContextPolicy('media');
  assert(
    learned.effective === 'engaged' && learned.source === 'learned',
    'cuatro aceptaciones enseñan que media admite más compañía'
  );

  const engine = new ProactiveEngine(fakeGraph(), {
    store,
    getWorkspace: () => null,
    getFocusedFile: () => null,
  });
  engine.setOSSensor({
    getCurrentContext: () => ({
      category: 'browser',
      app: 'Chrome',
      title: 'resultados de búsqueda - Google Search',
      idleSecs: 0,
    }),
    getTodaySummary: () => '',
  });
  const quiet = engine._evaluateTrigger({ type: 'long_silence', hours: 3, context: 'silencio' });
  assert(
    quiet?.verdict === 'DROP' && quiet.reason === 'context_preference_quiet',
    'el gate calla antes del LLM durante una búsqueda'
  );

  engine._sentFeedback.set('work-answer', {
    type: 'project_resume',
    context: 'work',
    at: Date.now(),
  });
  engine.handleDecision({
    proposalId: 'work-answer',
    type: 'project_resume',
    decision: 'accepted',
  });
  assert(
    store._data.byContext.work.accepted === 1,
    'el desenlace se atribuye al contexto original'
  );
  engine.stop();
}

async function testLongitudinalContinuity() {
  console.log(C.bold('\nTest 7: continuidad relacional y evaluación longitudinal'));
  const filePath = path.join(tmpDir, 'store-longitudinal.json');
  const store = new ProposalStore({ filePath });
  store.reset();
  const sentAt = Date.now() - 2500;
  store.recordEmission({
    proposalId: 'long-1',
    type: 'project_resume',
    context: 'work',
    message: 'Retomamos la prueba del módulo donde quedó el bloqueo.',
    at: sentAt,
  });
  store.resolveEmission('long-1', 'accepted', sentAt + 2000);
  store.recordEmission({
    type: 'long_silence',
    context: 'neutral',
    message: 'Hay una idea distinta que podríamos revisar después.',
  });

  const reloaded = new ProposalStore({ filePath });
  const history = reloaded.getRecentEmissions({ limit: 5 });
  assert(history.length === 2, 'el historial de iniciativas sobrevive al reinicio');
  assert(
    history[0].outcome === 'accepted' && history[0].responseLatencyMs === 2000,
    'conserva desenlace y latencia de respuesta'
  );
  const metrics = reloaded.getLongitudinalStats();
  assert(
    metrics.totalEmissions === 2 && metrics.resolved === 1 && metrics.acceptanceRate === 1,
    'calcula utilidad sobre desenlaces reales sin contar pendientes como rechazo'
  );

  const engine = new ProactiveEngine(fakeGraph(), { store: reloaded });
  engine.setOSSensor(fakeSensor());
  assert(
    engine._recentProactive.length === 2,
    'rehidrata el anti-repetición al construir el engine'
  );
  const stub = stubLLM({
    complete: () => 'Retomamos la prueba del módulo donde quedó el bloqueo.',
  });
  const duplicate = await engine._generateMessage({
    type: 'project_resume',
    context: 'retomar módulo',
    _gate: { verdict: 'ACT' },
  });
  assert(duplicate === null, 'silencia una repetición casi idéntica después de reiniciar');
  stub.restore();
  const cleared = engine.clearLongitudinalHistory();
  assert(cleared.ok && cleared.deleted === 2, 'el usuario puede eliminar el historial relacional');
  assert(
    engine._recentProactive.length === 0 && reloaded.getRecentEmissions().length === 0,
    'la eliminación limpia tanto memoria viva como persistencia'
  );
  engine.stop();
}

async function testGraduatedAutonomy() {
  console.log(C.bold('\nTest 8: autonomía graduada exige regla allow explícita'));
  const store = new ProposalStore({ filePath: path.join(tmpDir, 'store-autonomous.json') });
  store.reset();
  const executed = [];
  const executor = {
    preview: async () => ({ ok: true, preview: 'Añadir .env a .gitignore' }),
    isDone: () => false,
    execute: async (action) => {
      executed.push(action);
      return { ok: true, detail: 'acción aplicada' };
    },
  };
  const engine = new ProactiveEngine(fakeGraph(), {
    store,
    executor,
    authorizeAction: () => ({
      action: 'allow',
      rule: { id: 'gitignore_add:/workspace', action: 'allow' },
    }),
  });
  engine.setOSSensor(fakeSensor());
  engine.setAutonomyMode('act');
  engine.start();
  const stub = stubLLM();
  let payload = null;
  const listener = (value) => {
    payload = value;
  };
  getEventBus().on('initiative:trigger', listener);
  await engine._tryTrigger({
    type: 'git_redflag',
    kind: 'env_unignored',
    file: '.env',
    context: 'El .env no está ignorado.',
  });
  await new Promise((resolve) => setImmediate(resolve));
  getEventBus().off('initiative:trigger', listener);
  assert(payload?.proposal?.autonomous === true, 'marca la propuesta como autónoma');
  assert(payload?.proposal?.requiresConsent === null, 'no pide un segundo consentimiento');
  assert(executed.length === 1, 'ejecuta después de una regla allow explícita');
  assert(engine._sentFeedback.size === 0, 'no finge que el usuario aceptó la propuesta');
  assert(
    store.getRecentEmissions()[0]?.outcome === 'auto_executed',
    'distingue ejecución autónoma de aceptación humana'
  );
  engine.stop();
  stub.restore();

  const askExecuted = [];
  const askEngine = new ProactiveEngine(fakeGraph(), {
    store: new ProposalStore({ filePath: path.join(tmpDir, 'store-autonomous-ask.json') }),
    executor: {
      ...executor,
      execute: async (action) => {
        askExecuted.push(action);
        return { ok: true };
      },
    },
    authorizeAction: () => ({ action: 'allow', rule: null }),
  });
  askEngine.setOSSensor(fakeSensor());
  askEngine.setAutonomyMode('act');
  askEngine.start();
  const askStub = stubLLM();
  let askPayload = null;
  const askListener = (value) => {
    askPayload = value;
  };
  getEventBus().on('initiative:trigger', askListener);
  await askEngine._tryTrigger({
    type: 'git_redflag',
    kind: 'env_unignored',
    file: '.env',
    context: 'El .env no está ignorado.',
  });
  await new Promise((resolve) => setImmediate(resolve));
  getEventBus().off('initiative:trigger', askListener);
  assert(!askPayload?.proposal?.autonomous, 'un allow por defecto no concede autonomía');
  assert(askPayload?.proposal?.requiresConsent === 'confirm', 'mantiene el botón de confirmación');
  assert(askExecuted.length === 0, 'no ejecuta sin regla persistente explícita');
  askEngine.stop();
  askStub.restore();
}

// ── Runner ────────────────────────────────────────────────────────────────────

(async () => {
  console.log(C.cyan(C.bold('Fase A — propuestas proactivas: payload + feedback + autonomía')));

  testProposalStore();
  await testPayload();
  testDecisions();
  await testBusDecision();
  await testAutonomySlider();
  testContextPreferences();
  await testLongitudinalContinuity();
  await testGraduatedAutonomy();

  console.log('');
  console.log(C.bold(`Resultado: ${C.green(passed + ' ✓')} / ${C.red(failed + ' ✗')}`));
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(C.red('Fallo en la ejecución de la suite:'), e);
  process.exit(1);
});
