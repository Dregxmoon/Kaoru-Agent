'use strict';

/**
 * Fase F-5 — test de SLOs, degradación automática y telemetría de no-molestia.
 *
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron tests/test_slo.js
 *
 * Verifica:
 *   - assess: acceptanceRate / ignoreRate / nonNuisanceRate bien calculados.
 *   - Degradación: con muestra suficiente y mal SLO, el tipo se degrada.
 *   - degradedTypes: solo tipos degradados, sin muestra → no degrada.
 *   - El gate sube el umbral para tipos degradados (histéresis).
 *   - ProposalStore registra 'ignored'.
 *   - El engine marca 'ignored' propuestas sin respuesta tras el plazo.
 */

const { assess, degradedTypes, DEFAULT_SLOS } = require('../core/decision/SloMonitor.js');
const { evaluate: evaluateGate } = require('../core/decision/ContextGate.js');
const { ProposalStore } = require('../core/behavior/ProposalStore.js');
const { ProactiveEngine } = require('../core/behavior/ProactiveEngine.js');

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
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
    console.log(`  ${C.red('✗')} ${label}${detail ? `\n    ${C.dim(detail)}` : ''}`);
    failed++;
  }
}

function near(a, b, tol = 1e-6) {
  return Math.abs(a - b) <= tol;
}

function fakeGraph() {
  return { _ready: true, queryNodes: () => [], getWorldModel: () => [], queryAll: () => [] };
}

// ── Test 1: assess ───────────────────────────────────────────────────────────

function testAssess() {
  console.log(C.bold('\nTest 1: assess — métricas por tipo'));

  // 10 enviadas: 6 aceptadas, 2 rechazadas, 2 ignoradas.
  const r = assess({ git_redflag: { accepted: 6, rejected: 2, ignored: 2 } });
  const t = r.porTipo.git_redflag;

  assert(t.total === 10, 'total = enviadas', `got=${t.total}`);
  assert(near(t.acceptanceRate, 6 / 8), 'acceptanceRate = 6/(6+2)', `got=${t.acceptanceRate}`);
  assert(near(t.ignoreRate, 2 / 10), 'ignoreRate = 2/10', `got=${t.ignoreRate}`);
  assert(
    near(t.nonNuisanceRate, 0.8),
    'nonNuisanceRate = 1 - ignoreRate',
    `got=${t.nonNuisanceRate}`
  );

  // git_redflag: minAccept 0.6 → 0.75 OK → no degrada.
  assert(t.degraded === false, 'acceptance 0.75 ≥ 0.6 → no degrada');

  // Sin muestra → sampleOk false, nunca degrada.
  const empty = assess({ git_redflag: { accepted: 1, rejected: 0 } }).porTipo.git_redflag;
  assert(empty.sampleOk === false && empty.degraded === false, 'muestra < mínima → no degrada');
  assert(
    empty.acceptanceRate === 1,
    '…pero la tasa se calcula igual',
    `got=${empty.acceptanceRate}`
  );

  // Sin datos → todo null.
  const none = assess({}).global;
  assert(none.acceptanceRate === null && none.nonNuisanceRate === null, 'sin datos → tasas null');
}

// ── Test 2: degradación automática ───────────────────────────────────────────

function testDegradation() {
  console.log(C.bold('\nTest 2: degradación por SLO'));

  // error_title: minAccept 0.4. 5 propuestas, 1 aceptada, 4 rechazadas → 0.2 < 0.4 → degrada.
  const bad = assess({ error_title: { accepted: 1, rejected: 4, ignored: 0 } }).porTipo.error_title;
  assert(bad.degraded === true, 'acceptance 0.2 < 0.4 con muestra suficiente → degrada');

  // Ignorados en exceso: clipboard maxIgnore 0.5. 6 enviadas, 4 ignoradas → 0.67 > 0.5 → degrada.
  const noisy = assess({ clipboard_context: { accepted: 2, rejected: 0, ignored: 4 } }).porTipo
    .clipboard_context;
  assert(noisy.degraded === true, 'ignore 0.67 > 0.5 → degrada');

  // degradedTypes devuelve solo los degradados.
  const set = degradedTypes({
    error_title: { accepted: 1, rejected: 4 },
    git_redflag: { accepted: 8, rejected: 2 },
    clipboard_context: { accepted: 2, rejected: 0, ignored: 4 },
  });
  assert(set.has('error_title'), 'degradedTypes incluye error_title');
  assert(set.has('clipboard_context'), 'degradedTypes incluye clipboard_context');
  assert(!set.has('git_redflag'), 'degradedTypes NO incluye git_redflag (SLO ok)');
}

// ── Test 3: el gate sube el umbral para tipos degradados ─────────────────────

function testGateUsesDegradation() {
  console.log(C.bold('\nTest 3: el gate respeta la degradación (histéresis)'));

  const cand = (score) => ({ tipo: 'error_title', kind: 'default', score, isCritical: false });
  const ctx = {
    now: 1000000,
    chatOpen: false,
    lastUserMsg: 0,
    idleSecs: 0,
    appElapsedSec: 60,
    recentSwitches: [],
    budgetUsed: 0,
    receptivity: 0,
  };

  // Sin degradación: R=0.65 ≥ 0.60 → ACT.
  const normal = evaluateGate(cand(0.65), ctx);
  assert(normal.admit === true, 'sin degradación, R 0.65 → ACT');

  // Con error_title degradado: el umbral sube a 0.60+0.15=0.75 → R 0.65 ya no alcanza.
  const degradedCtx = { ...ctx, degradedTypes: new Set(['error_title']) };
  const degraded = evaluateGate(cand(0.65), degradedCtx);
  assert(degraded.admit === false, 'tipo degradado, R 0.65 → NO ACT');
  assert(
    degraded.decision.verdict === 'QUEUE',
    '…se difiere, no se descarta',
    degraded.decision.verdict
  );

  // R alta sí pasa.
  const strong = evaluateGate(cand(0.85), degradedCtx);
  assert(strong.admit === true, 'tipo degradado pero R 0.85 → ACT');
}

// ── Test 4: ProposalStore registra ignored ───────────────────────────────────

function testStoreIgnored() {
  console.log(C.bold('\nTest 4: ProposalStore registra ignored'));

  const store = new ProposalStore({ filePath: `/tmp/slo-store-${Date.now()}.json` });
  store.record({ proposalId: 'a', type: 'error_title', decision: 'accepted' });
  store.record({ proposalId: 'b', type: 'error_title', decision: 'rejected' });
  store.record({ proposalId: 'c', type: 'error_title', decision: 'ignored' });

  const byType = store.getStats().byType.error_title;
  assert(
    byType.accepted === 1 && byType.rejected === 1 && byType.ignored === 1,
    'contadores por tipo',
    JSON.stringify(byType)
  );

  const slo = assess({ error_title: byType }).porTipo.error_title;
  assert(near(slo.ignoreRate, 1 / 3, 0.001), 'ignoreRate = 1/3', `got=${slo.ignoreRate}`);
}

// ── Test 5: engine marca ignored tras el plazo ───────────────────────────────

function testEngineIgnored() {
  console.log(C.bold('\nTest 5: el engine marca ignored propuestas sin respuesta'));

  const store = new ProposalStore({ filePath: `/tmp/slo-engine-${Date.now()}.json` });
  const engine = new ProactiveEngine(fakeGraph(), {
    store,
    ignoredAfterMs: 1000, // plazo corto para el test
  });

  // Simula un envío sin respuesta: la propuesta entra al seguimiento.
  engine._sentFeedback.set('p-old', { type: 'error_title', at: Date.now() - 5000 });
  engine._markIgnoredStale();

  const byType = store.getStats().byType.error_title;
  assert(
    byType && byType.ignored === 1,
    'propuesta vieja sin respuesta → ignored',
    JSON.stringify(byType)
  );
  assert(!engine._sentFeedback.has('p-old'), '…y sale del seguimiento');

  // Una propuesta reciente NO se marca.
  engine._sentFeedback.set('p-new', { type: 'error_title', at: Date.now() });
  engine._markIgnoredStale();
  assert(engine._sentFeedback.has('p-new'), 'propuesta reciente → sigue en seguimiento');
}

// ── Test 6: SLO en getStats ──────────────────────────────────────────────────

function testStatsExposure() {
  console.log(C.bold('\nTest 6: SLO expuesto en getStats'));

  const store = new ProposalStore({ filePath: `/tmp/slo-stats-${Date.now()}.json` });
  store.record({ proposalId: 'a', type: 'git_redflag', decision: 'accepted' });
  store.record({ proposalId: 'b', type: 'git_redflag', decision: 'rejected' });
  store.record({ proposalId: 'c', type: 'git_redflag', decision: 'rejected' });
  store.record({ proposalId: 'd', type: 'git_redflag', decision: 'rejected' });
  store.record({ proposalId: 'e', type: 'git_redflag', decision: 'rejected' });

  const engine = new ProactiveEngine(fakeGraph(), { store });
  const slo = engine.getStats().slo;
  assert(slo && slo.porTipo.git_redflag, 'getStats().slo presente');
  assert(slo.porTipo.git_redflag.degraded === true, 'git_redflag 1/5 aceptadas → degradado');
  assert(typeof slo.global.nonNuisanceRate === 'number', 'telemetría global de no-molestia');
}

// ── Run ─────────────────────────────────────────────────────────────────────

testAssess();
testDegradation();
testGateUsesDegradation();
testStoreIgnored();
testEngineIgnored();
testStatsExposure();

console.log(`\n${C.bold(`Resultado: ${C.green(`${passed} ✓`)} / ${C.red(`${failed} ✗`)}`)}`);
process.exit(failed ? 1 : 0);
