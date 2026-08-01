'use strict';

/**
 * Fase F — núcleo de decisión proactiva (DecisionCore).
 *
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron tests/test_decision_core.js
 *
 * Funciones puras:
 *   - scoreRelevancia: pesos, normalización, rangos.
 *   - receptividad: EMA, decaimiento temporal, asimetría aceptar/rechazar.
 *   - presupuesto: dinámico según receptividad (neutro → base, con clamp).
 *   - decide: histéresis (degradado exige umbral más alto), presupuesto,
 *     señales críticas (ESCALATE salta presupuesto, jamás la presencia),
 *     reason codes correctos.
 *   - AuditLog: trazabilidad {sensor → scores → veredicto → outcome}.
 */

const {
  DEFAULT_POLICY,
  REASON,
  scoreRelevancia,
  receptividad,
  presupuesto,
  decide,
  AuditLog,
} = require('../core/decision/DecisionCore.js');

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
    console.log(`  ${C.red('✗')} ${label}${detail ? `\n    ${C.dim(detail)}` : ''}`);
    failed++;
  }
}

function near(a, b, tol = 1e-9) { return Math.abs(a - b) <= tol; }

// ── Test 1: scoreRelevancia ──────────────────────────────────────────────────

function testScore() {
  console.log(C.bold('\nTest 1: scoreRelevancia — qué tan relevante es una señal'));

  // Señal nula/ausente → 0.
  assert(scoreRelevancia({}) === 0, 'sin señal → R = 0');
  assert(scoreRelevancia(null) === 0, 'null → R = 0');

  // Señal máxima → 1 (pesos suman 1).
  const max = scoreRelevancia({ severity: 1, actionability: 1, salience: 1, costOfIgnore: 1 });
  assert(near(max, 1), 'señal máxima → R = 1', `got=${max}`);

  // Ruido: severidad alta pero sin accionabilidad/saliencia → R bajo.
  const noise = scoreRelevancia({ severity: 1, actionability: 0, salience: 0, costOfIgnore: 0 });
  assert(near(noise, DEFAULT_POLICY.weights.severity), 'ruido (severidad sola) → R = w_severity', `got=${noise}`);

  // Saliencia pesa: mismo error, archivo enfocado vs. no enfocado.
  const focused = scoreRelevancia({ severity: 0.8, actionability: 0.9, salience: 1, costOfIgnore: 0 });
  const unfocused = scoreRelevancia({ severity: 0.8, actionability: 0.9, salience: 0, costOfIgnore: 0 });
  assert(focused > unfocused, 'archivo enfocado → R mayor', `focused=${focused} unfocused=${unfocused}`);

  // Coste de ignorar suma (un secreto expuesto no se puede ignorar).
  const secret = scoreRelevancia({ severity: 1, actionability: 1, salience: 0.3, costOfIgnore: 1 });
  const ordinary = scoreRelevancia({ severity: 1, actionability: 1, salience: 0.3, costOfIgnore: 0 });
  assert(secret > ordinary, 'coste de ignorar alto → R mayor', `secret=${secret} ordinary=${ordinary}`);

  // R siempre en [0,1] y cada término se clamp (severity -5→0, salience 99→1).
  const out = scoreRelevancia({ severity: -5, salience: 99 });
  assert(out >= 0 && out <= 1, 'outliers → R dentro de [0,1]', `got=${out}`);
  assert(near(out, DEFAULT_POLICY.weights.salience), 'términos clampados (salience 99 → 1)', `got=${out}`);

  // Override parcial de pesos.
  const heavy = scoreRelevancia({ severity: 1, actionability: 0, salience: 0, costOfIgnore: 0 },
    { weights: { severity: 0.8 } });
  assert(near(heavy, 0.8), 'override de pesos funciona', `got=${heavy}`);
}

// ── Test 2: receptividad ─────────────────────────────────────────────────────

function testReceptivity() {
  console.log(C.bold('\nTest 2: receptividad — EMA con decaimiento'));

  // Neutro inicial.
  assert(near(receptividad(null, {}), 0), 'sin historial → Rec = 0');

  // Aceptar sube.
  const afterAccept = receptividad(0, { accepted: true });
  assert(afterAccept > 0, 'aceptar → Rec sube', `got=${afterAccept}`);

  // Rechazar baja (desde neutro).
  const afterReject = receptividad(0, { rejected: true });
  assert(afterReject < 0, 'rechazar → Rec baja', `got=${afterReject}`);

  // Ignorar baja, pero menos que rechazar.
  const afterIgnore = receptividad(0, { ignored: true });
  assert(afterIgnore < 0 && afterIgnore > afterReject, 'ignorar baja menos que rechazar',
    `ignore=${afterIgnore} reject=${afterReject}`);

  // EMA: sucesivos aceptados se acercan a 1 pero no lo saltan.
  let rec = 0;
  for (let i = 0; i < 50; i++) rec = receptividad(rec, { accepted: true });
  assert(rec < 1 && rec > 0.5, 'aceptados repetidos → Rec alta pero < 1', `got=${rec}`);

  // Decaimiento temporal: pasado el tiempo, vuelve al neutro.
  const afterDay = receptividad(0.8, {}, 24);
  assert(afterDay < 0.8, 'decaimiento temporal baja Rec', `got=${afterDay}`);

  // Sin decaimiento (h=0) no cambia.
  const same = receptividad(0.5, {});
  assert(near(same, 0.5), 'sin outcome y sin tiempo → Rec no cambia', `got=${same}`);

  // Rango [-1,1].
  assert(receptividad(5, {}) === 1, 'outlier alto → clamp a 1');
  assert(receptividad(-5, {}) === -1, 'outlier bajo → clamp a -1');
}

// ── Test 3: presupuesto dinámico ─────────────────────────────────────────────

function testBudget() {
  console.log(C.bold('\nTest 3: presupuesto — dinámico según receptividad'));

  const neutral = presupuesto(0);
  assert(neutral === DEFAULT_POLICY.budget.base, 'receptividad neutra → base (12)', `got=${neutral}`);

  const receptive = presupuesto(1);
  assert(receptive > neutral, 'receptivo → presupuesto mayor', `got=${receptive}`);

  const cold = presupuesto(-1);
  assert(cold < neutral, 'frío → presupuesto menor', `got=${cold}`);

  const min = presupuesto(-5);
  const max = presupuesto(5);
  assert(min >= DEFAULT_POLICY.budget.min, 'nunca por debajo del mínimo', `got=${min}`);
  assert(max <= DEFAULT_POLICY.budget.max, 'nunca por encima del máximo', `got=${max}`);

  // El clamp actúa ante overrides extremos de la política.
  const huge = presupuesto(1, { budget: { base: 500 } });
  assert(huge === DEFAULT_POLICY.budget.max, 'override enorme → clamp al máximo', `got=${huge}`);
  const tiny = presupuesto(-1, { budget: { base: 0 } });
  assert(tiny === DEFAULT_POLICY.budget.min, 'override mínimo → clamp al mínimo', `got=${tiny}`);

  const custom = presupuesto(0, { budget: { base: 6 } });
  assert(custom === 6, 'override de base', `got=${custom}`);
}

// ── Test 4: decide — política con histéresis ─────────────────────────────────

function testDecide() {
  console.log(C.bold('\nTest 4: decide — ACT / QUEUE / DROP / ESCALATE'));

  // Alta relevancia + buen momento → ACT.
  const act = decide({ relevance: 0.9, goodMoment: true, userPresent: true });
  assert(act.verdict === 'ACT', 'R alta + buen momento → ACT', act.reason);
  assert(act.reason === REASON.HIGH_VALUE_GOOD_MOMENT, 'reason code correcto', act.reason);

  // Relevancia media + mal momento → QUEUE (no se pierde).
  const queued = decide({ relevance: 0.5, goodMoment: false, userPresent: true });
  assert(queued.verdict === 'QUEUE', 'R media + mal momento → QUEUE', queued.reason);

  // Relevancia baja → DROP.
  const dropped = decide({ relevance: 0.1, goodMoment: true, userPresent: true });
  assert(dropped.verdict === 'DROP', 'R baja → DROP', dropped.reason);
  assert(dropped.reason === REASON.DROP_LOW_RELEVANCE, 'reason = DROP_LOW_RELEVANCE', dropped.reason);

  // Presupuesto agotado → DROP (aunque R alta).
  const noBudget = decide({ relevance: 0.9, goodMoment: true, userPresent: true, budgetUsed: 12, budgetLimit: 12 });
  assert(noBudget.verdict === 'DROP' && noBudget.reason === REASON.DROP_BUDGET_EXHAUSTED,
    'presupuesto agotado → DROP_BUDGET_EXHAUSTED', noBudget.reason);

  // Histéresis: tipo degradado con R=0.65 (por debajo de 0.6+0.15) → QUEUE/DROP, no ACT.
  const degraded = decide({ relevance: 0.65, goodMoment: true, userPresent: true, degraded: true });
  assert(degraded.verdict !== 'ACT', 'degradado → NO actúa con R media (histéresis)', degraded.reason);

  // No degradado, misma R → ACT.
  const normal = decide({ relevance: 0.65, goodMoment: true, userPresent: true });
  assert(normal.verdict === 'ACT', 'no degradado → ACT con la misma R', normal.reason);

  // Crítica + presente + R alta → ESCALATE (salta presupuesto).
  const esc = decide({ relevance: 0.95, isCritical: true, userPresent: true, budgetUsed: 999, budgetLimit: 12 });
  assert(esc.verdict === 'ESCALATE', 'crítica → ESCALATE incluso sin presupuesto', esc.reason);
  assert(esc.reason === REASON.ESCALATE_CRITICAL, 'reason = ESCALATE_CRITICAL', esc.reason);

  // Crítica pero usuario ausente → QUEUE (jamás molesta a quien no está).
  const away = decide({ relevance: 0.95, isCritical: true, userPresent: false, budgetUsed: 999, budgetLimit: 12 });
  assert(away.verdict === 'QUEUE', 'crítica sin usuario → QUEUE', away.reason);

  // Cada decisión trae id traceable.
  assert(typeof act.decisionId === 'string' && act.decisionId.length > 0, 'decisionId presente');
}

// ── Test 5: AuditLog ─────────────────────────────────────────────────────────

function testAudit() {
  console.log(C.bold('\nTest 5: AuditLog — trazabilidad de cada decisión'));

  const log = new AuditLog();
  log.push({ sensor: 'lsp', type: 'lsp_error', signal: { severity: 0.9 }, verdict: 'ACT', reason: REASON.HIGH_VALUE_GOOD_MOMENT, decisionId: 'x1' });
  log.push({ sensor: 'git', type: 'git_redflag', signal: { severity: 0.4 }, verdict: 'DROP', reason: REASON.DROP_LOW_RELEVANCE, decisionId: 'x2' });

  const all = log.getEntries();
  assert(all.length === 2, 'guarda las decisiones');

  const acts = log.getEntries({ verdict: 'ACT' });
  assert(acts.length === 1 && acts[0].sensor === 'lsp', 'filtro por veredicto');

  const byType = log.getEntries({ type: 'git_redflag' });
  assert(byType.length === 1, 'filtro por tipo');

  const stats = log.getStats();
  assert(stats.total === 2 && stats.byVerdict.ACT === 1, 'stats por veredicto');

  // Circular: no crece sin límite.
  const small = new AuditLog({ maxEntries: 3 });
  for (let i = 0; i < 10; i++) small.push({ verdict: 'DROP' });
  assert(small.getEntries().length === 3, 'audit circular respeta el máximo');

  // Outcome puede cerrar el ciclo (F-4).
  small.push({ verdict: 'ACT', outcome: 'accepted' });
  const last = small.getEntries().pop();
  assert(last.outcome === 'accepted', 'outcome se registra en el audit');
}

// ── Run ─────────────────────────────────────────────────────────────────────

testScore();
testReceptivity();
testBudget();
testDecide();
testAudit();

console.log(`\n${C.bold(`Resultado: ${C.green(`${passed} ✓`)} / ${C.red(`${failed} ✗`)}`)}`);
process.exit(failed ? 1 : 0);
