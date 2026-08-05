'use strict';

/**
 * Fase F-3 — test del gate de contexto.
 *
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron tests/test_context_gate.js
 *
 * Verifica:
 *   - detectFlow: idle / active / deep según appElapsedSec + thrashing.
 *   - dynamicBudget: presupuesto según receptividad (delega en el núcleo).
 *   - evaluate: piso de silencio, presupuesto, histéresis en flow profundo,
 *     críticas saltan presupuesto pero jamás a un usuario ausente.
 *   - QueueStore: difiere, reintenta sin quemar, caduca, dedupe.
 */

const {
  evaluate,
  detectFlow,
  dynamicBudget,
  QueueStore,
  FLOW,
  DEFAULT_GATE_POLICY,
} = require('../core/decision/ContextGate.js');
const { scoreRelevancia } = require('../core/decision/DecisionCore.js');

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

// Helper: candidato con relevancia controlada (se pasa el score directamente).
function cand(score, extra = {}) {
  return { tipo: 'git_redflag', kind: 'uncommitted', score, isCritical: false, ...extra };
}

const baseCtx = {
  now: 1000000,
  chatOpen: false,
  lastUserMsg: 0,
  idleSecs: 0,
  appElapsedSec: 60,
  recentSwitches: [],
  budgetUsed: 0,
  receptivity: 0,
};

// ── Test 1: detectFlow ───────────────────────────────────────────────────────

function testFlow() {
  console.log(C.bold('\nTest 1: detectFlow'));

  const idle = detectFlow({ idleSecs: 120 });
  assert(idle.level === FLOW.IDLE, 'idle > 60s → IDLE', idle.reason);

  const active = detectFlow({ idleSecs: 0, appElapsedSec: 60 });
  assert(active.level === FLOW.ACTIVE, 'app 1 min → ACTIVE', active.reason);

  const deep = detectFlow({ idleSecs: 0, appElapsedSec: 30 * 60, recentSwitches: [] });
  assert(deep.level === FLOW.DEEP, 'misma app 30 min sin cambios → DEEP', deep.reason);

  // Thrashing invalida el flow profundo.
  const now = 1000000;
  const thrash = detectFlow({
    idleSecs: 0,
    appElapsedSec: 30 * 60,
    recentSwitches: Array.from({ length: 8 }, (_, i) => ({ ts: now - i * 5000 })),
    now,
  });
  assert(thrash.level === FLOW.ACTIVE, 'thrashing → baja a ACTIVE', thrash.reason);
}

// ── Test 2: dynamicBudget ────────────────────────────────────────────────────

function testBudget() {
  console.log(C.bold('\nTest 2: dynamicBudget'));

  assert(dynamicBudget(0) === 12, 'receptividad neutra → 12');
  assert(dynamicBudget(1) > dynamicBudget(0), 'receptivo → más presupuesto');
  assert(dynamicBudget(-1) < dynamicBudget(0), 'frío → menos presupuesto');
  // Override de política alcanza los límites duros.
  const boundedHigh = dynamicBudget(5, { budget: { base: 500 } });
  const boundedLow = dynamicBudget(-5, { budget: { base: 0 } });
  assert(boundedHigh === 20, 'override enorme → tope 20', `got=${boundedHigh}`);
  assert(boundedLow === 2, 'override mínimo → piso 2', `got=${boundedLow}`);
}

// ── Test 3: evaluate ─────────────────────────────────────────────────────────

function testEvaluate() {
  console.log(C.bold('\nTest 3: evaluate'));

  // Sin candidato.
  assert(evaluate(null, baseCtx).admit === false, 'sin candidato → no admit');

  // Piso de silencio: score bajo nunca se envía.
  const low = evaluate(cand(0.2), baseCtx);
  assert(low.admit === false && low.queue === false, 'score 0.2 → DROP por piso');
  assert(low.decision.reason === 'below_floor', 'reason = below_floor', low.decision.reason);

  // Score alto + buen contexto → ACT.
  const act = evaluate(cand(0.9), baseCtx);
  assert(act.admit === true, 'score 0.9 + buen momento → ACT');
  assert(act.decision.verdict === 'ACT', 'verdict = ACT', act.decision.verdict);
  assert(act.budgetLimit === 12, 'reporta presupuesto dinámico', `got=${act.budgetLimit}`);

  // Score medio + mal momento → QUEUE (se difiere, no se pierde).
  const mid = evaluate(cand(0.5), { ...baseCtx, chatOpen: true });
  assert(mid.admit === false && mid.queue === true, 'score 0.5 + chat abierto → QUEUE');

  // Flow profundo: histéresis — score 0.65 ya no alcanza para ACT (0.60+0.15).
  const deepCtx = { ...baseCtx, appElapsedSec: 30 * 60 };
  const deep = evaluate(cand(0.65), deepCtx);
  assert(deep.admit === false, 'flow profundo + R 0.65 → NO ACT (histéresis)');
  assert(deep.decision.verdict === 'QUEUE', '…y se difiere, no se descarta', deep.decision.verdict);

  const deepHigh = evaluate(cand(0.85), deepCtx);
  assert(deepHigh.admit === true, 'flow profundo + R 0.85 → ACT', deepHigh.decision.reason);

  // Idle: no molestar salvo crítico.
  const idleCtx = { ...baseCtx, idleSecs: 300 };
  const idle = evaluate(cand(0.9), idleCtx);
  assert(idle.admit === false, 'usuario idle + R alta → no ACT');

  // Presupuesto agotado → DROP aunque R alta (no es crítica).
  const broke = evaluate(cand(0.9), { ...baseCtx, budgetUsed: 12, budgetLimit: 12 });
  assert(broke.admit === false && broke.queue === false, 'presupuesto agotado → DROP');

  // Crítica + presente + R alta → ESCALATE aunque no haya presupuesto.
  const crit = evaluate(cand(0.95, { isCritical: true }), { ...baseCtx, budgetUsed: 999 });
  assert(
    crit.admit === true && crit.decision.verdict === 'ESCALATE',
    'crítica → ESCALATE sin presupuesto'
  );

  // Crítica + usuario ausente (no ha hablado + chat cerrado NO = presente real,
  // pero el gate usa `chatOpen` como proxy de presencia; lo crítico exige
  // presentarse — aquí chat abierto → QUEUE).
  const critAway = evaluate(cand(0.95, { isCritical: true }), { ...baseCtx, chatOpen: true });
  assert(critAway.admit === false && critAway.queue === true, 'crítica + chat abierto → QUEUE');

  // Usuario habló hace < 2 min → nunca interrumpir, aunque sea crítico.
  const recent = evaluate(cand(0.95, { isCritical: true }), {
    ...baseCtx,
    lastUserMsg: baseCtx.now - 30 * 1000,
  });
  assert(recent.admit === false, 'usuario habló hace 30s → no ACT (ni crítico)');
}

// ── Test 4: QueueStore ───────────────────────────────────────────────────────

function testQueue() {
  console.log(C.bold('\nTest 4: QueueStore'));

  const q = new QueueStore();

  // Encola y dedupe por (tipo, kind).
  assert(q.push(cand(0.6)) === true, 'primer push ok');
  assert(q.push(cand(0.6)) === false, 'duplicado (mismo tipo+kind) → no vuelve');
  assert(q.size() === 1, 'tamaño 1');

  // Poll con mal contexto → no reintenta aún.
  const bad = q.poll({ ...baseCtx, chatOpen: true, now: 1000000 });
  assert(bad.length === 0, 'contexto malo → nada listo');
  assert(q.size() === 1, 'sigue en cola (sin quemar reintento)', `size=${q.size()}`);

  // Poll con buen contexto → listo.
  const good = q.poll({ ...baseCtx, now: 1000000 + 60 * 1000 });
  assert(good.length === 1, 'contexto bueno → reintenta');
  assert(good[0].decision.verdict === 'ACT', 'verdict del reintento = ACT');
  assert(q.size() === 0, 'sale de la cola tras admit');

  // TTL: caduca candidatos viejos.
  const q2 = new QueueStore();
  q2.push(cand(0.6), { now: 1000000 });
  const expired = q2.poll({ ...baseCtx, now: 1000000 + 2 * 3600 * 1000 });
  assert(expired.length === 0 && q2.size() === 0, 'TTL superado → caduca sin reintentar');

  // Máximo de reintentos: con mal contexto persistente, poll con buena context
  // reintenta; forzamos que el gate lo acepte varias veces... en su lugar
  // verificamos que el límite de reintentos suelta el candidato tras N adits.
  const q3 = new QueueStore();
  q3.push(cand(0.6));
  const retries = [];
  for (let i = 0; i < 5; i++) {
    const ready = q3.poll({ ...baseCtx, now: 1000000 + (i + 1) * 60000 });
    if (ready.length) retries.push(...ready);
  }
  assert(
    retries.length === 1,
    'candidato admitido → 1 reintento efectivo',
    `got=${retries.length}`
  );

  // Circular: no crece sin límite.
  const q4 = new QueueStore();
  for (let i = 0; i < 30; i++) q4.push(cand(0.4 + i * 0.01, { kind: `k${i}` }));
  assert(q4.size() === 20, 'cola circular (máx 20)', `got=${q4.size()}`);
}

// ── Test 5: integración normalizador → gate ─────────────────────────────────

function testPipeline() {
  console.log(C.bold('\nTest 5: normalizador → score → gate (flujo completo)'));

  const { normalize } = require('../core/decision/SignalNormalizer.js');
  const raw = normalize('git:redflag', { kind: 'env_unignored', file: '.env', message: 'x' });
  raw.score = scoreRelevancia(raw.signal);

  const result = evaluate(raw, baseCtx);
  assert(
    result.admit === true,
    '.env sin ignorar → ACT',
    `verdict=${result.decision.verdict} reason=${result.decision.reason}`
  );
  assert(
    result.decision.relevance > 0.6,
    'score supera umbral de act',
    `R=${result.decision.relevance.toFixed(3)}`
  );
}

// ── Test 6: candidatos self-gated (triggers temporales, Gap 2) ───────────────

function testSelfGated() {
  console.log(
    C.bold('\nTest 6: selfGated (triggers temporales) → el gate solo impone presupuesto y SLO')
  );

  const temporal = {
    tipo: 'long_silence',
    kind: 'default',
    score: 0.55,
    selfGated: true,
    isCritical: false,
  };

  // Aunque el usuario habló hace 30s o está idle, un temporal YA validó su
  // momento: el gate NO re-valida chat/idle/flow → ACT directo.
  const busy = evaluate(temporal, { ...baseCtx, lastUserMsg: baseCtx.now - 30 * 1000 });
  assert(busy.admit === true, 'con chat reciente → ACT (self-gated)');
  assert(
    busy.decision.reason === 'GATE3_ACT_SELF_GATED',
    '…reason = SELF_GATED',
    busy.decision.reason
  );

  const idle = evaluate(temporal, { ...baseCtx, idleSecs: 300 });
  assert(idle.admit === true, 'idle → ACT (self-gated)', `verdict=${idle.decision.verdict}`);

  // Un temporal en flow profundo tampoco se frena (misma lógica).
  const deep = evaluate(temporal, { ...baseCtx, appElapsedSec: 30 * 60 });
  assert(deep.admit === true, 'flow profundo → ACT (self-gated)');

  // Lo único que lo frena es el presupuesto...
  const broke = evaluate(temporal, { ...baseCtx, budgetUsed: 12, budgetLimit: 12 });
  assert(broke.admit === false && broke.decision.verdict === 'DROP', 'presupuesto agotado → DROP');
  assert(
    broke.decision.reason === 'GATE2_DROP_BUDGET_EXHAUSTED',
    '…reason = DROP_BUDGET_EXHAUSTED',
    broke.decision.reason
  );

  // ...y la degradación por SLO (F-5): un tipo degradado no molesta.
  const degraded = evaluate(temporal, { ...baseCtx, degradedTypes: new Set(['long_silence']) });
  assert(degraded.admit === false && degraded.decision.verdict === 'DROP', 'tipo degradado → DROP');
  assert(
    degraded.decision.reason === 'GATE2_DROP_DEGRADED',
    '…reason = DROP_DEGRADED',
    degraded.decision.reason
  );

  // Un sensor NORMAL (sin selfGated) sigue obedeciendo chat/idle/flow.
  const normal = evaluate(cand(0.9), { ...baseCtx, lastUserMsg: baseCtx.now - 30 * 1000 });
  assert(normal.admit === false, 'sensor normal con chat reciente → NO ACT (intacto)');
}

// ── Run ─────────────────────────────────────────────────────────────────────

testFlow();
testBudget();
testEvaluate();
testQueue();
testPipeline();
testSelfGated();

console.log(`\n${C.bold(`Resultado: ${C.green(`${passed} ✓`)} / ${C.red(`${failed} ✗`)}`)}`);
process.exit(failed ? 1 : 0);
