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
 *   - Slider de autonomía: 'observe' bloquea todo sin consultar al LLM;
 *     'suggest' (default) informa+propone; 'act' hoy se comporta como suggest.
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

function stubLLM({ provider = 'groq', complete } = {}) {
  const origP = LLMProvider.getActiveProvider;
  const origC = LLMProvider.complete;
  let calls = 0;
  LLMProvider.getActiveProvider = () => provider;
  LLMProvider.complete = async (...args) => {
    calls++;
    return complete ? complete(...args) : 'mensaje de propuesta de prueba';
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
  let fired2 = null;
  const bus = getEventBus();
  const l2 = (p) => {
    fired2 = p;
  };
  bus.on('initiative:trigger', l2);
  await engine2._tryTrigger({
    type: 'git_redflag',
    kind: 'env_unignored',
    context: 'El .env no está en .gitignore.',
  });
  bus.off('initiative:trigger', l2);
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

  // 5c. act → hoy se comporta como suggest (la ejecución llega en Fase B)
  const engine3 = makeEngine(store);
  engine3.setAutonomyMode('act');
  const stub3 = stubLLM();
  const res3 = await engine3._tryTrigger({ type: 'long_silence', context: 'x' });
  assert(res3, 'act → igual que suggest por ahora');
  stub3.restore();

  // 5d. valor inválido → cae a suggest
  engine3.setAutonomyMode('todo_poder');
  assert(engine3.getAutonomyMode() === 'suggest', 'valor inválido → suggest');

  engine.stop();
  engine2.stop();
  engine3.stop();
}

// ── Runner ────────────────────────────────────────────────────────────────────

(async () => {
  console.log(C.cyan(C.bold('Fase A — propuestas proactivas: payload + feedback + autonomía')));

  testProposalStore();
  await testPayload();
  testDecisions();
  await testBusDecision();
  await testAutonomySlider();

  console.log('');
  console.log(C.bold(`Resultado: ${C.green(passed + ' ✓')} / ${C.red(failed + ' ✗')}`));
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(C.red('Fallo en la ejecución de la suite:'), e);
  process.exit(1);
});
