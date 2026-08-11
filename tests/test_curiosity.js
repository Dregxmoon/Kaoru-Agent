'use strict';

/**
 * Curiosidad de memoria (Fase nueva): preguntas sobre la memoria del usuario.
 *
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron tests/test_curiosity.js
 *
 * Verifica el pipeline completo:
 *   - _collectCuriosityCandidates: hechos stale (F3.1), contradicciones vivas
 *     (getTensions) e inferencias de confianza media (Fase 4) → triggers listos.
 *   - Boost de saliencia contextual en generación (justo "estás en el tema").
 *   - ContextGate: cupo PROPIO (CURIOSITY_DAILY_CAP) separado del presupuesto
 *     general; DROP_CURIOSITY_CAP al agotarlo; bypass del piso (los candidatos
 *     de curiosidad NO son ruido a silenciar por score).
 *   - _tryTrigger: un envío real consume SOLO el cupo de curiosidad, nunca
 *     incrementa el presupuesto diario general (y viceversa).
 *   - Outcome de una pattern_uncertain → confirma/archiva el nodo inferido vía
 *     UserModelBuilder.confirmInferred() (además del feedback general).
 */

const { ProactiveEngine } = require('../core/behavior/ProactiveEngine.js');
const { evaluate, DEFAULT_GATE_POLICY } = require('../core/decision/ContextGate.js');
const { candidateFromTrigger } = require('../core/decision/SignalNormalizer.js');
const LLMProvider = require('../core/llm/LLMProvider.js');
const {
  CURIOSITY_DAILY_CAP,
  CURIOSITY_TYPES,
  TRIGGER_COOLDOWN_MS,
} = require('../core/behavior/proactive/config.js');
const { _localDayString } = require('../core/behavior/proactive/helpers.js');

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

// ── Mocks ─────────────────────────────────────────────────────────────────────

function fakeSensor(getCurrentContext) {
  return {
    getCurrentContext: getCurrentContext || (() => ({ category: null, elapsed: 0, idleSecs: 0 })),
    getTodaySummary: () => '',
  };
}

function stubLLM({ provider = 'groq', complete } = {}) {
  const origP = LLMProvider.getActiveProvider;
  const origC = LLMProvider.complete;
  LLMProvider.getActiveProvider = () => provider;
  LLMProvider.complete = complete || (async () => 'hola, mensaje de prueba');
  return () => {
    LLMProvider.getActiveProvider = origP;
    LLMProvider.complete = origC;
  };
}

/** Grafo fake con los 3 orígenes de la curiosidad: stale, tensiones, getModel. */
function curiosityGraph({ stale = [], tensions = [], model = [] } = {}) {
  return {
    _ready: true,
    usingFallback: false,
    _db: { prepare: () => ({ all: () => stale }) }, // perfil "falso": SQL ya en test
    getTensions: () => tensions,
    getUserModel: () => model,
    confirmInferred: () => ({ ok: true }),
  };
}

function makeEngine(graph, sensorCtx) {
  const engine = new ProactiveEngine(graph);
  if (sensorCtx !== undefined) engine.setOSSensor(fakeSensor(sensorCtx));
  engine.start();
  return engine;
}

/** Store fake con la interfaz mínima que toca el engine (gate + SLO + cooldown). */
function fakeProposalStore(trackIncrements = { count: 0 }) {
  return {
    dailyCount: () => 0,
    incrementDaily: () => {
      trackIncrements.count += 1;
    },
    getStats: () => ({ byType: {} }),
    getLearnedWeights: () => null,
    cooldownMultiplier: () => 1,
    record: () => true,
  };
}

// ── Test 1: origen de candidatos ──────────────────────────────────────────────

function testCollectCandidates() {
  console.log(C.bold('\nTest 1: _collectCuriosityCandidates (stale + tensión + inferencia)'));

  const engine = makeEngine(
    curiosityGraph({
      stale: [
        { id: 1, label: 'trabajo_usuario', content: 'Editor de video', tags: '["stale"]' },
        { id: 2, label: 'nombre_usuario', content: 'Ana', tags: '["stale"]' },
      ],
      tensions: [{ label: 'horario', contentA: 'prefiere la noche', contentB: 'madruga mucho' }],
      model: [
        { id: 10, label: 'patron_lenguaje', content: 'Prefiere TypeScript', confidence: 0.55 },
        { id: 11, label: 'patron_cafe', content: 'Toma café por la mañana', confidence: 0.95 },
        { id: 12, label: 'patron_gatos', content: 'Le gustan los gatos', confidence: 0.2 },
      ],
    })
  );

  const cands = engine._collectCuriosityCandidates();
  assert(
    Array.isArray(cands) && cands.length === 4,
    '4 candidatos (2 stale + 1 tensión + 1 mid-conf)',
    `got=${cands.length}`
  );

  const stale = cands.filter((c) => c.type === 'memory_stale');
  assert(
    stale.length === 2 && stale.every((c) => typeof c.nodeId === 'number'),
    'hechos stale con nodeId'
  );
  assert(
    stale.some((c) => c.content === 'Editor de video'),
    'candidato stale lleva el contenido real'
  );

  const tension = cands.find((c) => c.type === 'memory_tension');
  assert(!!tension, 'contradicción viva → memory_tension');
  assert(
    tension.contentA === 'prefiere la noche' && tension.contentB === 'madruga mucho',
    'la tensión lleva ambos lados del conflicto'
  );

  const infer = cands.filter((c) => c.type === 'pattern_uncertain');
  assert(infer.length === 1, 'solo la inferencia de confianza MEDIA (0.55) es candidata');
  assert(
    infer[0] && infer[0].nodeId === 10 && infer[0].confidence === 0.55,
    'la candidata lleva nodeId y confidence'
  );

  // Sin candidatos → [].
  const empty = makeEngine(curiosityGraph());
  assert(empty._collectCuriosityCandidates().length === 0, 'sin datos → sin candidatos');

  engine.stop();
}

// ── Test 2: boost de saliencia contextual ─────────────────────────────────────

function testContextBoost() {
  console.log(C.bold('\nTest 2: boost de saliencia cuando el usuario "está en el tema"'));

  const engine = makeEngine(
    curiosityGraph({
      stale: [{ id: 1, label: 'trabajo_usuario', content: 'Editor de video', tags: '["stale"]' }],
    }),
    () => ({ title: 'Proyecto yt-video — montaje en Premiere', idleSecs: 0 })
  );

  const cands = engine._collectCuriosityCandidates();
  assert(
    cands.length === 1 && cands[0].salienceBoost > 0,
    'contexto de SO relacionado → boost > 0'
  );

  // Sin relación → sin boost (0; el gate no aplica nada).
  const engine2 = makeEngine(
    curiosityGraph({
      stale: [{ id: 1, label: 'trabajo_usuario', content: 'Editor de video', tags: '["stale"]' }],
    }),
    () => ({ title: 'git log — core/decision', idleSecs: 0 })
  );
  const cands2 = engine2._collectCuriosityCandidates();
  assert(cands2[0].salienceBoost === 0, 'contexto sin relación → boost 0');

  // El gate aplica el boost al vector ANTES de scorer (véase audit).
  const trig = cands[0];
  const boosted = candidateFromTrigger(trig);
  const gate = engine._evaluateTrigger(trig);
  assert(
    gate && gate.candidate.signal.salience > boosted.signal.salience,
    'el gate sube la saliencia con el boost (saliencia > base)'
  );

  engine.stop();
  engine2.stop();
}

// ── Test 3: el gate aplica el CUPO PROPIO ─────────────────────────────────────

function testGateCap() {
  console.log(C.bold('\nTest 3: ContextGate — cupo de curiosidad PROPIO (CURIOSITY_DAILY_CAP)'));

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

  // Candidato de curiosidad de memoria (score bajo a propósito: bypass del piso).
  const c = candidateFromTrigger({
    type: 'memory_stale',
    kind: 'trabajo_usuario',
    label: 'trabajo_usuario',
    content: 'Editor de video',
  });
  assert(!!c && CURIOSITY_TYPES.has(c.tipo), 'candidateFromTrigger normaliza memory_stale');

  // Cupo disponible → ACT (aunque el score no llegue al piso de relevancia).
  const admit = evaluate(c, { ...baseCtx, curiosityUsed: 0 });
  assert(admit.admit === true, 'cupo disponible → admit', JSON.stringify(admit.decision));

  // Presupuesto GENERAL agotado pero cupo de curiosidad intacto → sigue ACT.
  const admitsWithGeneralExhausted = evaluate(c, {
    ...baseCtx,
    budgetUsed: DEFAULT_GATE_POLICY.budget ? 999 : 999,
    curiosityUsed: CURIOSITY_DAILY_CAP - 1,
  });
  assert(
    admitsWithGeneralExhausted.admit === true,
    'presupuesto general agotado ≠ curiosidad: sigue admitiendo'
  );

  // Cupo de curiosidad agotado → DROP_CURIOSITY_CAP, aun con alta relevancia.
  const exhausted = evaluate(c, { ...baseCtx, curiosityUsed: CURIOSITY_DAILY_CAP });
  assert(exhausted.admit === false, 'cupo de curiosidad agotado → DROP');
  assert(
    exhausted.decision.reason === 'GATE2_DROP_CURIOSITY_CAP',
    'reason = GATE2_DROP_CURIOSITY_CAP',
    exhausted.decision.reason
  );

  // Un candidato NO-curiosidad con cupo de curiosidad agotado NO le afecta.
  const normal = { tipo: 'git_redflag', kind: 'uncommitted', score: 0.9, selfGated: false };
  const normalResult = evaluate(normal, { ...baseCtx, curiosityUsed: CURIOSITY_DAILY_CAP });
  assert(normalResult.admit === true, 'un trigger normal NO consume el cupo de curiosidad');

  // El cupo se puede overridear por política (tests).
  const policy = { ...DEFAULT_GATE_POLICY, curiosityDailyCap: 1 };
  const withCap1 = evaluate(c, { ...baseCtx, curiosityUsed: 1 }, policy);
  assert(withCap1.admit === false, 'override de política: cap=1 con 1 usada → DROP');
}

// ── Test 4: un envío consume SOLO el cupo de curiosidad ───────────────────────

async function testConsumesOwnBudget() {
  console.log(C.bold('\nTest 4: envío real → consume solo el cupo de curiosidad'));

  const restore = stubLLM({ complete: async () => '¿Sigue vigente que eres Editor de video?' });
  const engine = makeEngine(
    curiosityGraph({
      stale: [{ id: 1, label: 'trabajo_usuario', content: 'Editor de video', tags: '["stale"]' }],
    })
  );
  const general = { count: 0 };
  engine._store = fakeProposalStore(general);

  const res = await engine._tryTrigger({
    type: 'memory_stale',
    kind: 'trabajo_usuario',
    label: 'trabajo_usuario',
    content: 'Editor de video',
    nodeId: 1,
  });
  assert(typeof res === 'string', 'curiosidad admitida → se envía el mensaje');
  assert(engine._curiosityFired === 1, 'curiosityFired = 1 (cupo propio gastado)');
  assert(general.count === 0, 'el presupuesto diario GENERAL no se toca');
  engine.stop();
  restore();

  // Contrapunto: un trigger normal consume el presupuesto general, no la curiosidad.
  const restore2 = stubLLM({ complete: async () => 'mensaje normal' });
  const engine2 = makeEngine();
  const general2 = { count: 0 };
  engine2._store = fakeProposalStore(general2);
  await engine2._tryTrigger({ type: 'long_silence', context: 'x' });
  assert(engine2._curiosityFired === 0, 'un trigger normal no gasta el cupo de curiosidad');
  assert(general2.count === 1, '…y sí consume el presupuesto diario general');
  engine2.stop();
  restore2();

  // Al gastarse el cupo, el siguiente candidato de curiosidad es DROP por cap.
  const restore3 = stubLLM({ complete: async () => 'mensaje' });
  const engine3 = makeEngine(
    curiosityGraph({
      stale: [
        { id: 1, label: 'trabajo_usuario', content: 'Editor de video', tags: '["stale"]' },
        { id: 2, label: 'nombre_usuario', content: 'Ana', tags: '["stale"]' },
      ],
    })
  );
  engine3._curiosityFired = CURIOSITY_DAILY_CAP; // cupo lleno (mismo día)
  engine3._curiosityDay = _localDayString(Date.now());
  const res3 = await engine3._tryTrigger({
    type: 'memory_stale',
    kind: 'trabajo_usuario',
    label: 'trabajo_usuario',
    content: 'Editor de video',
    nodeId: 1,
  });
  assert(
    res3 && res3.blocked && res3.gate && res3.gate.reason === 'GATE2_DROP_CURIOSITY_CAP',
    'cupo lleno → el gate devuelve { blocked, gate: DROP_CURIOSITY_CAP }'
  );
  engine3.stop();
  restore3();
}

// ── Test 5: reseteo diario del cupo ───────────────────────────────────────────

function testDailyReset() {
  console.log(C.bold('\nTest 5: _curiosityUsedToday / _envelopeCuriosityFired (reset por día)'));

  const engine = makeEngine(curiosityGraph());
  assert(engine._curiosityUsedToday() === 0, 'sin envíos → usado 0');

  engine._envelopeCuriosityFired();
  engine._envelopeCuriosityFired();
  assert(engine._curiosityUsedToday() === 2, 'dos envíos → usado 2');

  // Cambio de día → el carril se limpia.
  engine._curiosityDay = '2000-01-01';
  assert(engine._curiosityUsedToday() === 0, 'día distinto → usado 0 (aunque fired>0)');
  engine._envelopeCuriosityFired();
  assert(engine._curiosityUsedToday() === 1, 'primer envío del día nuevo → usado 1');

  // Cooldowns: los tipos de curiosidad tienen cooldown propio (6h) en config.
  assert(typeof TRIGGER_COOLDOWN_MS.memory_stale === 'number', 'config: cooldown de memory_stale');
  assert(
    typeof TRIGGER_COOLDOWN_MS.pattern_uncertain === 'number',
    'config: cooldown de pattern_uncertain'
  );
  assert(
    typeof TRIGGER_COOLDOWN_MS.memory_tension === 'number',
    'config: cooldown de memory_tension'
  );
  assert(
    TRIGGER_COOLDOWN_MS.memory_stale === 6 * 60 * 60 * 1000,
    'cooldown largo (6h) para no repetir la pregunta del mismo tipo'
  );
  engine.stop();
}

// ── Test 6: outcome → confirmInferred ─────────────────────────────────────────

function testOutcomeConfirmsInference() {
  console.log(
    C.bold('\nTest 6: outcome de pattern_uncertain → confirmInferred (además del feedback)')
  );

  const confirmed = { nodeId: null, decision: null };
  const graph = curiosityGraph();
  graph.confirmInferred = (nodeId, decision) => {
    confirmed.nodeId = nodeId;
    confirmed.decision = decision;
    return { ok: true };
  };
  const engine = makeEngine(graph);

  // Simulamos: la propuesta fue creada con ref al nodo inferido.
  engine._proposalRefs.set('p1', { nodeId: 10 });

  engine.handleDecision({ proposalId: 'p1', type: 'pattern_uncertain', decision: 'accepted' });
  assert(
    confirmed.nodeId === 10 && confirmed.decision === 'accepted',
    'accepted → confirmInferred(10, accepted)',
    JSON.stringify(confirmed)
  );
  assert(!engine._proposalRefs.has('p1'), 'el ref se limpia tras el outcome');

  engine._proposalRefs.set('p2', { nodeId: 11 });
  engine.handleDecision({ proposalId: 'p2', type: 'pattern_uncertain', decision: 'rejected' });
  assert(
    confirmed.nodeId === 11 && confirmed.decision === 'rejected',
    'rejected → confirmInferred(11, rejected)'
  );

  // Un tipo NO-curiosidad no toca confirmInferred (no hay ref que conectar).
  engine.handleDecision({ proposalId: 'p3', type: 'git_redflag', decision: 'accepted' });
  assert(confirmed.decision === 'rejected', 'git_redflag → NO vuelve a llamar confirmInferred');
}

// ── Runner ────────────────────────────────────────────────────────────────────

(async () => {
  testCollectCandidates();
  testContextBoost();
  testGateCap();
  await testConsumesOwnBudget();
  testDailyReset();
  testOutcomeConfirmsInference();

  console.log(C.bold('\n══════════════════════════════════════════════'));
  console.log(
    `  Resultado: ${C.green(passed + ' passed')} · ${failed ? C.red(failed + ' failed') : C.green('0 failed')}`
  );
  console.log('══════════════════════════════════════════════');
  process.exit(failed ? 1 : 0);
})();
