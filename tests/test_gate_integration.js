'use strict';

/**
 * Fase F-4 — test de integración del gate en el ProactiveEngine.
 *
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron tests/test_gate_integration.js
 *
 * Verifica que el LLM DEJÓ de decidir si intervenir:
 *   - El gate determinista filtra DROP/QUEUE antes de consultar al LLM.
 *   - ACT/ESCALATE → el LLM PRODUCE el mensaje (no decide).
 *   - Shadow mode → gate + audit corren, pero nunca se consulta al LLM ni se envía.
 *   - Los diferidos QUEUE se reintentan al volver de una pausa.
 *   - El outcome (accepted/rejected) alimenta la receptividad (F-1).
 */

const { ProactiveEngine } = require('../core/behavior/ProactiveEngine.js');
const LLMProvider = require('../core/llm/LLMProvider.js');
const { getEventBus } = require('../infrastructure/event-bus/EventBus.js');
const { normalize } = require('../core/decision/SignalNormalizer.js');

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

function fakeGraph() {
  return { _ready: true, queryNodes: () => [], getWorldModel: () => [], queryAll: () => [] };
}

function fakeSensor(ctx) {
  return {
    getCurrentContext: () => ctx || { category: null, elapsed: 0, idleSecs: 0 },
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

// ── Test 1: gate decide antes que el LLM ─────────────────────────────────────

async function testGateBeforeLLM() {
  console.log(C.bold('\nTest 1: el gate decide ANTES del LLM'));

  // 1a. Señal de baja relevancia (uncommitted con pocos archivos) → DROP
  //     determinista. El LLM NO se consulta.
  let llmCalls = 0;
  let restore = stubLLM({
    complete: async () => {
      llmCalls++;
      return '¿qué tal?';
    },
  });
  let engine = new ProactiveEngine(fakeGraph());
  engine.setOSSensor(fakeSensor());
  engine.start();

  const res = await engine._tryTrigger({
    type: 'git_redflag',
    kind: 'uncommitted',
    count: 2,
    context: 'Hay 2 archivos sin commitear.',
  });
  assert(res && res.blocked, 'señal de baja relevancia → { blocked }');
  assert(llmCalls === 0, '…sin consultar al LLM', `llmCalls=${llmCalls}`);
  assert(res.gate && res.gate.verdict === 'DROP', 'verdict del gate = DROP', res.gate?.verdict);
  restore();

  // 1b. Señal crítica (.env expuesto) + buen momento → ACT → el LLM PRODUCE.
  restore = stubLLM({
    complete: async () => 'Ojo: tienes un .env sin ignorar y parece contener secretos.',
  });
  engine = new ProactiveEngine(fakeGraph());
  engine.setOSSensor(fakeSensor());
  engine.start();

  const fired = [];
  const listener = (p) => fired.push(p);
  getEventBus().on('initiative:trigger', listener);

  const msg = await engine._tryTrigger({
    type: 'git_redflag',
    kind: 'env_unignored',
    file: '.env',
    context: 'El archivo .env existe y no está en .gitignore.',
  });
  getEventBus().off('initiative:trigger', listener);

  assert(
    msg === 'Ojo: tienes un .env sin ignorar y parece contener secretos.',
    'señal crítica → el LLM produce',
    `msg=${msg}`
  );
  assert(fired.length === 1, 'se emitió initiative:trigger');
  assert(fired[0].reason === 'git_redflag', 'payload.reason = git_redflag');
  restore();

  // 1c. El audit registró la decisión ACT con su rastro (sensor, score, reason).
  const stats = engine._audit.getStats();
  assert(stats.total >= 1, 'audit registra la decisión', `total=${stats.total}`);
  assert(stats.byVerdict.ACT >= 1, '…incluye el ACT', `ACT=${stats.byVerdict.ACT}`);
  const actEntry = engine._audit.getEntries({ verdict: 'ACT' }).pop();
  assert(
    actEntry.sensor === 'git:redflag' && Math.abs(actEntry.score - 0.735) < 1e-9,
    '…con score traceable',
    JSON.stringify({ s: actEntry.sensor, score: actEntry.score })
  );
}

// ── Test 2: shadow mode ──────────────────────────────────────────────────────

async function testShadowMode() {
  console.log(C.bold('\nTest 2: shadow mode — correr sin molestar'));

  let llmCalls = 0;
  const restore = stubLLM({
    complete: async () => {
      llmCalls++;
      return 'mensaje';
    },
  });
  const engine = new ProactiveEngine(fakeGraph(), { shadowMode: true });
  engine.setOSSensor(fakeSensor());
  engine.start();

  // .env expuesto es crítica: en modo normal sería ACT; en shadow NUNCA se envía.
  const res = await engine._tryTrigger({
    type: 'git_redflag',
    kind: 'env_unignored',
    file: '.env',
    context: 'El archivo .env existe y no está en .gitignore.',
  });

  assert(res && res.blocked && res.shadow, 'shadow mode → { blocked, shadow }');
  assert(res.gate.verdict === 'ACT', '…pero el gate SÍ evalúa (ACT)', res.gate?.verdict);
  assert(llmCalls === 0, '…y nunca se consulta al LLM', `llmCalls=${llmCalls}`);
  assert(engine._audit.getStats().total >= 1, '…aunque el audit registra la decisión');

  const stats = engine._audit.getStats();
  assert(stats.byVerdict.ACT >= 1, '…con su veredicto ACT traceable');
  restore();
}

// ── Test 3: cola de diferidos ────────────────────────────────────────────────

async function testQueueDefer() {
  console.log(C.bold('\nTest 3: diferidos QUEUE se reintentan al volver de una pausa'));

  let llmCalls = 0;
  const restore = stubLLM({
    complete: async () => {
      llmCalls++;
      return '¿vas a commitear?';
    },
  });

  // Chat abierto → la señal (media relevancia) va a QUEUE, no se consulta LLM.
  const engine = new ProactiveEngine(fakeGraph());
  engine.setOSSensor(fakeSensor());
  engine.start();
  engine.setChatOpen(true);

  const res = await engine._tryTrigger({
    type: 'git_redflag',
    kind: 'merge_conflict',
    count: 3,
    context: 'Hay 3 archivos con conflicto de merge sin resolver.',
  });

  assert(res && res.blocked, 'chat abierto + señal media → { blocked }');
  assert(
    res.gate && res.gate.verdict === 'QUEUE',
    '…el gate la difiere (QUEUE)',
    res.gate?.verdict
  );
  assert(llmCalls === 0, '…sin consultar al LLM', `llmCalls=${llmCalls}`);
  assert(engine._queue.size() === 1, '…y queda en la cola', `size=${engine._queue.size()}`);

  // El usuario cierra el chat y "vuelve de una pausa" → se reintenta la cola.
  engine.setChatOpen(false);
  engine._replayQueued();

  assert(engine._queue.size() === 0, 'tras el replay, la cola queda vacía');
  assert(llmCalls === 1, '…y el diferido se reintentó (LLM produce)', `llmCalls=${llmCalls}`);
  restore();
}

// ── Test 4: outcome → receptividad ───────────────────────────────────────────

async function testReceptivity() {
  console.log(C.bold('\nTest 4: el outcome alimenta la receptividad (F-1)'));

  const restore = stubLLM();
  const engine = new ProactiveEngine(fakeGraph());
  engine.start();

  assert(engine._receptivity === 0, 'receptividad inicial = 0');

  engine.handleDecision({ proposalId: 'p1', type: 'git_redflag', decision: 'accepted' });
  assert(
    engine._receptivity > 0,
    'aceptar → receptividad sube',
    `rec=${engine._receptivity.toFixed(3)}`
  );

  const recAfter = engine._receptivity;
  for (let i = 0; i < 5; i++) {
    engine.handleDecision({ proposalId: `p${i}`, type: 'git_redflag', decision: 'rejected' });
  }
  assert(
    engine._receptivity < recAfter,
    'rechazos seguidos → receptividad baja',
    `rec=${engine._receptivity.toFixed(3)}`
  );

  const stats = engine._audit.getStats();
  assert((stats.byVerdict.ACT ?? 0) === 0, 'los outcomes van al audit (no al byVerdict)');
  restore();
}

// ── Test 5: triggers temporales pasan por el gate (Gap 2) ────────────────────

async function testTemporalTriggers() {
  console.log(C.bold('\nTest 5: triggers temporales pasan por el gate (Gap 2)'));

  // Los temporales (long_silence, return_from_break...) ahora OBTIENEN candidato
  // con score y el gate les da veredicto: su condición ya validó el momento, así
  // que el gate solo impone presupuesto y SLO (no chat/idle/flow). El flujo
  // observable NO cambia: el LLM sigue produciendo el mensaje.
  let llmCalls = 0;
  let restore = stubLLM({
    complete: async () => {
      llmCalls++;
      return 'Llevas 3 horas sin hablar: ¿quieres un respiro?';
    },
  });
  let engine = new ProactiveEngine(fakeGraph());
  engine.start();

  const res = await engine._tryTrigger({
    type: 'long_silence',
    hours: 3,
    context: 'Llevan 3 horas sin hablar.',
  });
  assert(
    res === 'Llevas 3 horas sin hablar: ¿quieres un respiro?',
    'trigger temporal → el LLM produce igual que antes',
    `res=${res}`
  );
  assert(llmCalls === 1, '…el LLM fue consultado', `llmCalls=${llmCalls}`);

  // El gate le dio veredicto ACT self-gated y lo dejó auditable.
  const audit = engine._audit.getEntries({ limit: 5 });
  const temporalEntry = audit.find((e) => e.type === 'long_silence');
  assert(
    temporalEntry && temporalEntry.verdict === 'ACT',
    '…el audit registra el trigger temporal con veredicto ACT'
  );
  assert(
    temporalEntry && temporalEntry.reason === 'GATE3_ACT_SELF_GATED',
    '…con reason SELF_GATED (gate que no re-valida momento)',
    temporalEntry?.reason
  );
  assert(
    temporalEntry && typeof temporalEntry.score === 'number',
    '…con score traceable (ROADMAP: cada mensaje con score)'
  );
  restore();

  // G.1: en modo producción se filtra el relleno genérico (gate admitió, pero
  // "¿todo bien?" no es un mensaje con sustancia → no se emite nada).
  restore = stubLLM({
    complete: async () => {
      llmCalls++;
      return '¿todo bien?';
    },
  });
  engine = new ProactiveEngine(fakeGraph());
  engine.start();
  llmCalls = 0;
  const filler = await engine._tryTrigger({
    type: 'long_silence',
    hours: 3,
    context: 'Llevan 3 horas sin hablar.',
  });
  assert(filler === null, 'relleno "¿todo bien?" → null en modo producción', `filler=${filler}`);
  assert(llmCalls === 1, '…pero el LLM sí fue consultado', `llmCalls=${llmCalls}`);
  restore();

  // Presupuesto agotado → el gate DROP el temporal ANTES del LLM (silencio).
  llmCalls = 0;
  restore = stubLLM({
    complete: async () => {
      llmCalls++;
      return '¿todo bien?';
    },
  });
  engine = new ProactiveEngine(fakeGraph(), {
    store: { dailyCount: () => 99, getStats: () => ({ byType: {} }) },
  });
  engine.start();

  const blocked = await engine._tryTrigger({
    type: 'return_from_break',
    minutes: 20,
    context: 'Volvieron de una pausa.',
  });
  assert(blocked && blocked.blocked, 'con presupuesto agotado → { blocked }');
  assert(
    blocked.gate && blocked.gate.verdict === 'DROP',
    '…verdict = DROP (GATE2_DROP_BUDGET_EXHAUSTED)',
    blocked.gate?.verdict
  );
  assert(llmCalls === 0, '…sin consultar al LLM', `llmCalls=${llmCalls}`);
  restore();
}

// ── Run ─────────────────────────────────────────────────────────────────────

(async () => {
  await testGateBeforeLLM();
  await testShadowMode();
  await testQueueDefer();
  await testReceptivity();
  await testTemporalTriggers();

  console.log(`\n${C.bold(`Resultado: ${C.green(`${passed} ✓`)} / ${C.red(`${failed} ✗`)}`)}`);
  process.exit(failed ? 1 : 0);
})();
