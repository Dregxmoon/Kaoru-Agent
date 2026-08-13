'use strict';

/**
 * Verificación real del flujo proactivo (ProactiveEngine + BehaviorModel).
 *
 * IMPORTANTE: correr con ELECTRON_RUN_AS_NODE=1 (igual que test_state_graph),
 * para que los requires de módulos con ABI de Electron funcionen:
 *
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron tests/test_proactive.js
 *
 * Cubre la auditoría del flujo proactivo:
 *   - Contrato de _tryTrigger: { blocked } vs null (LLM dijo NO) vs mensaje.
 *   - Cooldowns por tipo, gap global, lock _deciding, gate de idle.
 *   - sustained_focus NO consume la racha si el trigger quedó bloqueado
 *     (bug: se marcaba _categoryStreakFired ANTES de preguntar al LLM, así
 *     que chat abierto/cooldown/idle perdían la oportunidad para siempre).
 *   - Follow-up (minSec × 3) y su interacción con cooldown/gap.
 *   - session_end, context_switch_thrash, return_from_break.
 *   - _checkSpecialDate (incl. fix QW-5 de formato con ceros/año).
 *   - BehaviorModel._detectUrgency con timestamps reales (antes .timestamp
 *     no existía en el historial → falso 'medium' permanente y heurística de
 *     inactividad muerta).
 *   - SessionManager.addTurn guarda ts y lo preserva tras un resume.
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
const { BehaviorModel } = require('../core/behavior/BehaviorModel.js');
const { StateGraph } = require('../core/state-graph/StateGraph.js');
const { SessionManager } = require('../core/state-graph/SessionManager.js');
const LLMProvider = require('../core/llm/LLMProvider.js');
const { getEventBus } = require('../infrastructure/event-bus/EventBus.js');
const {
  _detectMediaTitle,
  _matchMediaTaste,
  _extractFinalMessage,
} = require('../core/behavior/proactive/helpers.js');
const { getMemoryGaps, isRealIdentityNode } = require('../core/core/misc.js');
const { candidateFromTrigger } = require('../core/decision/SignalNormalizer.js');
const state = require('../core/core/state.js');

function flush() {
  return new Promise((r) => setTimeout(r, 0));
}

// ── Mocks ─────────────────────────────────────────────────────────────────────

function fakeGraph(userNodes = []) {
  return {
    _ready: true,
    queryNodes: ({ type } = {}) => userNodes.filter((n) => !type || n.type === type),
    getWorldModel: () => [],
    getRecentEpisodes: () => [],
    getLastSessions: () => [],
  };
}

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

function makeEngine(userNodes = [], sensorCtx) {
  const engine = new ProactiveEngine(fakeGraph(userNodes));
  if (sensorCtx !== undefined) engine.setOSSensor(fakeSensor(sensorCtx));
  engine.start(); // _tryTrigger exige _running=true (guard anti-arranque incompleto)
  return engine;
}

// ── Test 1: contrato de _tryTrigger ──────────────────────────────────────────

async function testTryTriggerContract() {
  console.log(C.bold('\nTest 1: contrato de _tryTrigger ({blocked} vs null vs mensaje)'));

  // 1a. Sin proveedor LLM → bloqueado (no se consume cooldown)
  let restore = stubLLM({ provider: null });
  let engine = makeEngine();
  let res = await engine._tryTrigger({ type: 'long_silence', context: 'x' });
  assert(res && res.blocked, 'sin proveedor LLM → { blocked }');
  assert(
    !engine._lastAttemptByType['long_silence'],
    'sin proveedor → NO consume cooldown por tipo'
  );
  restore();

  // 1b. Conversación RECIENTE del usuario → bloqueado (el chat abierto por sí
  //     solo ya NO bloquea: es la ventana principal y el canal de las propuestas)
  restore = stubLLM();
  engine = makeEngine();
  engine.onUserMessage(); // el usuario acaba de hablar
  res = await engine._tryTrigger({ type: 'long_silence', context: 'x' });
  assert(res && res.blocked, 'conversación reciente (< 2 min) → { blocked }');
  assert(
    !engine._lastAttemptByType['long_silence'],
    'conversación reciente → NO consume cooldown por tipo'
  );

  // 1b2. Chat abierto pero sin conversación reciente → NO bloquea (Fase B:
  //      las propuestas se muestran en el chat)
  restore = stubLLM({
    complete: async () => '¿Quieres que revise lo que estabas haciendo con los tests?',
  });
  engine = makeEngine();
  engine.setChatOpen(true);
  res = await engine._tryTrigger({ type: 'long_silence', context: 'x' });
  assert(
    res === '¿Quieres que revise lo que estabas haciendo con los tests?',
    'chat abierto sin conversación reciente → NO bloquea'
  );
  assert(
    typeof engine._lastAttemptByType['long_silence'] === 'number',
    'chat abierto → consume cooldown (sí se consultó al LLM)'
  );
  engine.setChatOpen(false);
  restore();

  // 1c. LLM decide NO → null (y SÍ consume cooldown: fue consultado)
  restore = stubLLM({ complete: async () => 'NO' });
  engine = makeEngine();
  res = await engine._tryTrigger({ type: 'long_silence', context: 'x' });
  assert(res === null, 'LLM dijo NO → null');
  assert(
    typeof engine._lastAttemptByType['long_silence'] === 'number',
    'LLM dijo NO → SÍ consume cooldown (fue consultado)'
  );
  restore();

  // 1d. LLM genera mensaje → se emite initiative:trigger y se actualiza _lastProactive
  restore = stubLLM({
    complete: async () => 'Llevas un rato sin escribir: ¿quieres que haga una pausa contigo?',
  });
  engine = makeEngine();
  const fired = [];
  const listener = (p) => fired.push(p);
  getEventBus().on('initiative:trigger', listener);
  res = await engine._tryTrigger({ type: 'long_silence', context: 'x' });
  assert(
    res === 'Llevas un rato sin escribir: ¿quieres que haga una pausa contigo?',
    'LLM genera mensaje → devuelve el mensaje'
  );
  assert(
    fired.length === 1 &&
      fired[0].suggestion === 'Llevas un rato sin escribir: ¿quieres que haga una pausa contigo?' &&
      fired[0].reason === 'long_silence',
    'emite initiative:trigger con { reason, suggestion }',
    JSON.stringify(fired)
  );
  assert(engine._lastProactive > 0, '_lastProactive actualizado');
  getEventBus().off('initiative:trigger', listener);
  engine.stop();
  restore();
}

// ── Test 2: cooldown por tipo ────────────────────────────────────────────────

async function testTypeCooldown() {
  console.log(C.bold('\nTest 2: cooldown por tipo de trigger'));

  const restore = stubLLM();
  const engine = makeEngine();
  await engine._tryTrigger({ type: 'sustained_focus', context: 'x' }); // envía
  const res = await engine._tryTrigger({ type: 'sustained_focus', context: 'x' });
  assert(res && res.blocked, 'mismo tipo dentro del cooldown → { blocked }');

  // Simular paso del tiempo: limpiar intentos → vuelve a disparar
  engine._lastAttemptByType = {};
  engine._lastProactive = 0;
  const res2 = await engine._tryTrigger({ type: 'sustained_focus', context: 'x' });
  assert(typeof res2 === 'string', 'tras pasar el cooldown → vuelve a disparar');
  engine.stop();
  restore();
}

// ── Test 3: gap global entre cualquier mensaje ───────────────────────────────

async function testGlobalGap() {
  console.log(C.bold('\nTest 3: gap global (GLOBAL_MIN_GAP_MS) entre CUALQUIER mensaje'));

  const restore = stubLLM();
  const engine = makeEngine();
  await engine._tryTrigger({ type: 'late_night', context: 'x' }); // envía → _lastProactive=now
  const res = await engine._tryTrigger({ type: 'return_from_break', context: 'y' });
  assert(res && res.blocked, 'otro tipo dentro del gap global → { blocked }');

  engine._lastProactive = 0; // paso del tiempo
  const res2 = await engine._tryTrigger({ type: 'return_from_break', context: 'y' });
  assert(typeof res2 === 'string', 'tras el gap global → dispara el otro tipo');
  engine.stop();
  restore();
}

// ── Test 4: lock _deciding ───────────────────────────────────────────────────

async function testDecidingLock() {
  console.log(C.bold('\nTest 4: lock _deciding (una sola consulta al LLM a la vez)'));

  const restore = stubLLM();
  const engine = makeEngine();
  engine._deciding = true;
  const res = await engine._tryTrigger({ type: 'long_silence', context: 'x' });
  assert(res && res.blocked, 'mientras _deciding=true → { blocked }');
  assert(!engine._lastAttemptByType['long_silence'], 'bloqueado por lock → NO consume cooldown');
  engine._deciding = false;
  const res2 = await engine._tryTrigger({ type: 'long_silence', context: 'x' });
  assert(typeof res2 === 'string', 'tras liberar el lock → dispara');
  engine.stop();
  restore();
}

// ── Test 5: gate de idle (no interrumpir si lleva mucho AFK) ─────────────────

async function testIdleGate() {
  console.log(C.bold('\nTest 5: no interrumpir si el usuario lleva mucho AFK'));

  const restore = stubLLM();
  const engine = makeEngine([], () => ({ category: 'code', elapsed: 3600, idleSecs: 2000 }));
  const res = await engine._tryTrigger({ type: 'sustained_focus', context: 'x' });
  assert(res && res.blocked, 'idle 33min + trigger normal → { blocked }');

  const res2 = await engine._tryTrigger({ type: 'return_from_break', gapSec: 1200, context: 'y' });
  assert(
    typeof res2 === 'string',
    'idle 33min + return_from_break → SÍ dispara (es el trigger que vuelve del AFK)'
  );
  engine.stop();
  restore();
}

// ── Test 6: fin de bloque de foco (borde natural, no contador) ───────────────

async function testFocusBlockEnd() {
  console.log(C.bold('\nTest 6: focus_block_end (fin de bloque — borde, no contador)'));

  // 6a. Bloque corto (< el mínimo de la categoría) → ni focus_block_end ni session_end
  let restore = stubLLM();
  let engine = makeEngine();
  engine._onAppChanged({ app: 'code', category: 'code' }); // inicia bloque
  engine._categoryStreakStart = Date.now() - 2 * 60 * 1000; // 2 min
  await engine._onAppChanged({ app: 'firefox', category: 'browser' });
  await flush();
  assert(
    !engine._lastAttemptByType['focus_block_end'] && !engine._lastAttemptByType['session_end'],
    'bloque de 2 min → ni focus_block_end ni session_end'
  );
  engine.stop();
  restore();

  // 6b. Bloque de 10 min → focus_block_end con duración y ventana (hito)
  restore = stubLLM({ complete: async () => 'NO' });
  engine = makeEngine();
  let captured = null;
  const origTry = engine._tryTrigger;
  engine._tryTrigger = async (t) => {
    captured = t;
    return 'NO';
  };
  engine._onAppChanged({ app: 'code', category: 'code' });
  engine._categoryStreakStart = Date.now() - 10 * 60 * 1000;
  engine._lastFocusedWindow = {
    category: 'code',
    app: 'VS Code',
    title: 'foo.js — Visual Studio Code',
    at: Date.now(),
  };
  await engine._onAppChanged({ app: 'firefox', category: 'browser' });
  await flush();
  assert(
    captured && captured.type === 'focus_block_end',
    'salto tras 10 min de foco → focus_block_end'
  );
  assert(
    captured && captured.streakSec === 600 && captured.context.includes('10 minutos'),
    'contexto con la duración del bloque'
  );
  assert(
    captured && captured.context.includes('foo.js'),
    'contexto con la ventana del bloque (hito)'
  );
  engine._tryTrigger = origTry;
  engine.stop();
  restore();

  // 6b2. Flujo real: el fin de bloque consulta al LLM (consume cooldown por tipo)
  restore = stubLLM({ complete: async () => 'NO' });
  engine = makeEngine();
  engine._onAppChanged({ app: 'code', category: 'code' });
  engine._categoryStreakStart = Date.now() - 10 * 60 * 1000;
  await engine._onAppChanged({ app: 'firefox', category: 'browser' });
  await flush();
  assert(
    typeof engine._lastAttemptByType['focus_block_end'] === 'number',
    '…consulta el LLM (consumido por tipo)'
  );
  assert(!engine._lastAttemptByType['session_end'], '…sin session_end (racha < 20 min)');
  engine.stop();
  restore();

  // 6c. Bloque largo work→no-work (≥20 min) → lo cubre session_end, NO duplica
  restore = stubLLM({ complete: async () => 'NO' });
  engine = makeEngine();
  engine._onAppChanged({ app: 'code', category: 'code' });
  engine._categoryStreakStart = Date.now() - 26 * 60 * 1000;
  await engine._onAppChanged({ app: 'firefox', category: 'browser' });
  await flush();
  assert(
    typeof engine._lastAttemptByType['session_end'] === 'number',
    'racha ≥ 20 min work→no-work → session_end consultado'
  );
  assert(!engine._lastAttemptByType['focus_block_end'], '…sin duplicar con focus_block_end');
  engine.stop();
  restore();

  // 6d. Bloqueado por conversación reciente → el borde se procesa una sola vez
  restore = stubLLM();
  engine = makeEngine();
  engine.onUserMessage(); // conversación reciente → el gate lo frena
  engine._onAppChanged({ app: 'code', category: 'code' });
  engine._categoryStreakStart = Date.now() - 10 * 60 * 1000;
  await engine._onAppChanged({ app: 'firefox', category: 'browser' });
  await flush();
  assert(
    engine._categoryStreakFired === true,
    'el borde se procesa una vez aunque quede bloqueado (no se re-dispara)'
  );
  engine.stop();
  restore();
}

// ── Test 7: sin contador mid-flow en el bloque ───────────────────────────────

async function testNoMidFlowNag() {
  console.log(C.bold('\nTest 7: sin comentarios mid-flow por contador (solo en el borde)'));

  const restore = stubLLM({ complete: async () => 'NO' });
  const engine = makeEngine();
  // Even 20 min in the SAME block: no mid-flow sustained_focus anymore.
  await engine._onAppTick({
    friendlyName: 'VSCode',
    category: 'code',
    elapsed: 301,
    elapsedFormatted: '5m',
  });
  await engine._onAppTick({
    friendlyName: 'VSCode',
    category: 'code',
    elapsed: 1200,
    elapsedFormatted: '20m',
  });
  await flush();
  assert(
    !engine._lastAttemptByType['sustained_focus'],
    '20 min de foco en el mismo bloque → NO se consulta sustained_focus mid-flow'
  );
  assert(
    engine._categoryStreakFired === false,
    '…la racha no se consume mientras el bloque sigue (el comentario es del borde)'
  );

  // El borde SÍ dispara cuando el bloque termina (contraparte de 6b).
  engine._onAppChanged({ app: 'code', category: 'code' });
  engine._categoryStreakStart = Date.now() - 10 * 60 * 1000;
  await engine._onAppChanged({ app: 'firefox', category: 'browser' });
  await flush();
  assert(
    typeof engine._lastAttemptByType['focus_block_end'] === 'number',
    '…al terminar el bloque, el comentario sale por el borde'
  );
  engine.stop();
  restore();
}

// ── Test 8: session_end ──────────────────────────────────────────────────────

async function testSessionEnd() {
  console.log(C.bold('\nTest 8: session_end (racha de trabajo → otra cosa)'));

  // 8a. Racha de 21 min en code → salta a browser → session_end
  let restore = stubLLM({ complete: async () => 'NO' });
  let engine = makeEngine();
  engine._onAppChanged({ app: 'code', category: 'code' });
  engine._categoryStreakStart = Date.now() - 21 * 60 * 1000; // 21 min de racha
  await engine._onAppChanged({ app: 'firefox', category: 'browser' });
  await flush();
  assert(
    typeof engine._lastAttemptByType['session_end'] === 'number',
    'racha ≥ 20 min + salto a no-trabajo → trigger session_end consultado'
  );
  engine.stop();
  restore();

  // 8b. Racha corta → NO hay session_end
  restore = stubLLM();
  engine = makeEngine();
  engine._onAppChanged({ app: 'code', category: 'code' });
  engine._categoryStreakStart = Date.now() - 5 * 60 * 1000; // 5 min de racha
  await engine._onAppChanged({ app: 'firefox', category: 'browser' });
  await flush();
  assert(!engine._lastAttemptByType['session_end'], 'racha de 5 min → NO hay session_end');
  engine.stop();
  restore();
}

// ── Test 9: context_switch_thrash ────────────────────────────────────────────

async function testThrash() {
  console.log(C.bold('\nTest 9: context_switch_thrash (6+ cambios / 3+ categorías en 10 min)'));

  const restore = stubLLM({ complete: async () => 'NO' });
  const engine = makeEngine();
  engine._recentSwitches = [
    { ts: Date.now() - 1000, category: 'code', app: 'vscode' },
    { ts: Date.now() - 900, category: 'terminal', app: 'kitty' },
    { ts: Date.now() - 800, category: 'code', app: 'vscode' },
    { ts: Date.now() - 700, category: 'docs', app: 'chrome' },
    { ts: Date.now() - 600, category: 'code', app: 'vscode' },
    { ts: Date.now() - 500, category: 'terminal', app: 'kitty' },
  ];
  await engine._onAppChanged({ app: 'firefox', category: 'browser' }); // el 7º switch
  await flush();
  assert(
    typeof engine._lastAttemptByType['context_switch_thrash'] === 'number',
    '6+ cambios en la ventana con 3+ categorías → trigger thrash consultado'
  );

  // Ventana que no alcanza el mínimo → no dispara
  const engine2 = makeEngine();
  engine2._recentSwitches = [
    { ts: Date.now() - 1000, category: 'code', app: 'vscode' },
    { ts: Date.now() - 500, category: 'code', app: 'vscode' },
    { ts: Date.now() - 200, category: 'code', app: 'cursor' },
  ];
  await engine2._onAppChanged({ app: 'firefox', category: 'browser' });
  await flush();
  assert(!engine2._lastAttemptByType['context_switch_thrash'], 'pocos cambios → NO hay thrash');

  engine.stop();
  engine2.stop();
  restore();
}

// ── Test 10: return_from_break ───────────────────────────────────────────────

async function testReturnFromBreak() {
  console.log(C.bold('\nTest 10: return_from_break (volver de una ausencia)'));

  // 10a. Ausencia de ~20 min → vuelve → trigger
  let restore = stubLLM({ complete: async () => 'NO' });
  let engine = makeEngine();
  engine._categoryStreakFired = true; // previo a la ausencia, estaba disparado
  engine._onIdleChanged({ idle: true, idleSecs: 1200 }); // idle ~20 min
  await engine._onIdleChanged({ idle: false, idleSecs: 0 }); // vuelve
  await flush();
  assert(
    typeof engine._lastAttemptByType['return_from_break'] === 'number',
    'ausencia de 20 min → trigger return_from_break consultado'
  );
  assert(engine._categoryStreakFired === false, 'al volver, la racha de enfoque se reinicia');
  engine.stop();
  restore();

  // 10b. Ausencia corta (< 15 min) → no trigger
  restore = stubLLM();
  engine = makeEngine();
  engine._onIdleChanged({ idle: true, idleSecs: 600 }); // ~10 min
  await engine._onIdleChanged({ idle: false, idleSecs: 0 });
  await flush();
  assert(!engine._lastAttemptByType['return_from_break'], 'ausencia de 10 min → NO hay trigger');
  engine.stop();
  restore();

  // 10c. Sin haber detectado idle antes → un idle:false suelto no dispara
  restore = stubLLM();
  engine = makeEngine();
  await engine._onIdleChanged({ idle: false, idleSecs: 0 });
  await flush();
  assert(
    !engine._lastAttemptByType['return_from_break'],
    'idle:false sin idle previo → NO dispara'
  );
  engine.stop();
  restore();
}

// ── Test 11: _checkSpecialDate (incl. fix QW-5) ─────────────────────────────

function testSpecialDate() {
  console.log(C.bold('\nTest 11: _checkSpecialDate'));

  // 11a. Cumpleaños hoy en texto → detectado como birthday
  let engine = makeEngine([{ type: 'User', content: 'Cumpleaños: 15 de junio' }]);
  let r = engine._checkSpecialDate(new Date(2026, 5, 15, 12));
  assert(
    r && r.type === 'special_date' && r.subtype === 'birthday',
    'cumpleaños "15 de junio" detectado el 15/6 (texto)',
    JSON.stringify(r)
  );

  // 11b. Mismo nodo en otra fecha → no
  r = engine._checkSpecialDate(new Date(2026, 5, 20, 12));
  assert(r === null, 'el 20/6 no hay fecha especial');

  // 11c. FIX QW-5: fecha guardada "15/06/2000" (con ceros y año) → detectada
  engine = makeEngine([{ type: 'User', content: 'Aniversario: 15/06/2000' }]);
  r = engine._checkSpecialDate(new Date(2026, 5, 15, 12));
  assert(
    r && r.type === 'special_date',
    'fecha "15/06/2000" detectada (fix QW-5)',
    JSON.stringify(r)
  );

  // 11d. Fecha ISO "2026-06-15" en contenido → detectada
  engine = makeEngine([{ type: 'User', content: 'recordatorio: 2026-06-15 es importante' }]);
  r = engine._checkSpecialDate(new Date(2026, 5, 15, 12));
  assert(r && r.type === 'special_date', 'fecha ISO en contenido detectada', JSON.stringify(r));
}

// ── Test 12: BehaviorModel._detectUrgency ────────────────────────────────────

function testBehaviorUrgency() {
  console.log(C.bold('\nTest 12: BehaviorModel._detectUrgency'));

  const bm = new BehaviorModel(null);

  // 12a. Palabras urgentes → high
  let ctx = bm.evaluate('URGENTE se cayó el server ya mismo', null, []);
  assert(ctx.urgency === 'high', 'palabras urgentes → high');

  // 12b. Mensajes muy seguidos (ts < 10s) → medium
  const rapid = [
    { role: 'user', content: 'a', ts: Date.now() - 8000 },
    { role: 'user', content: 'b', ts: Date.now() - 2000 },
  ];
  ctx = bm.evaluate('otra cosa', null, rapid);
  assert(ctx.urgency === 'medium', 'mensajes con <10s de separación → medium');

  // 12c. Historial SIN timestamps (sesión restaurada de DB) → NO falso medium
  //      (regresión: antes `?.timestamp || Date.now()` daba gap=0 → medium SIEMPRE)
  const noTs = [
    { role: 'user', content: 'a' },
    { role: 'user', content: 'b' },
  ];
  ctx = bm.evaluate('un mensaje normal', null, noTs);
  assert(ctx.urgency === 'low', 'historial sin ts → NO falso medium (antes pasaba)');

  // 12d. Mensaje corto tras >1h de inactividad → medium (heurística que era código muerto)
  const old = [
    { role: 'user', content: 'a', ts: Date.now() - 2 * 3600 * 1000 },
    { role: 'user', content: 'b', ts: Date.now() - 2 * 3600 * 1000 + 1000 },
  ];
  ctx = bm.evaluate('hola', null, old);
  assert(ctx.urgency === 'medium', 'mensaje corto tras >1h de inactividad → medium');

  // 12e. Terminal → medium
  ctx = bm.evaluate('algo', { category: 'terminal' }, []);
  assert(ctx.urgency === 'medium', 'categoría terminal → medium');

  // 12f. Default → low
  ctx = bm.evaluate('mensaje normal y corriente sin señales', null, noTs);
  assert(ctx.urgency === 'low', 'sin señales → low');

  // 12g. Tono y longitud básicos
  ctx = bm.evaluate('¿cómo funciona el sistema?', null, []);
  assert(ctx.tone === 'curious', `"¿cómo funciona?" → tono curious (era ${ctx.tone})`);
  ctx = bm.evaluate('sí', null, []);
  assert(ctx.responseLength === 'brief', '"sí" → longitud brief');
  assert(ctx.tone === 'dry', '"sí" → tono dry');
}

// ── Test 13: SessionManager guarda ts y lo preserva en resume ────────────────

async function testSessionTs() {
  console.log(C.bold('\nTest 13: SessionManager.addTurn guarda ts (para BehaviorModel)'));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proactive-ts-'));
  const graph = new StateGraph(path.join(dir, 'core.db')).init();

  const sm = new SessionManager(graph, null);
  await sm.start(null);
  sm.addTurn('user', 'hola');
  sm.addTurn('assistant', 'encantada');
  const h = sm.getHistory();
  assert(
    h.length === 2 && typeof h[0].ts === 'number' && typeof h[1].ts === 'number',
    'addTurn guarda ts en cada turno'
  );
  // Sin close() → simulamos un crash → la sesión queda reanudable
  const sm2 = new SessionManager(graph, null);
  const resumed = await sm2.start(null);
  assert(
    resumed.resumed === true && resumed.history.length === 2,
    'la sesión interrumpida se reanuda con su historial'
  );
  assert(typeof resumed.history[0].ts === 'number', 'ts preservado tras el resume');
  await sm2.close().catch(() => {});

  graph.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Test 14: media_watching (contenido en pantalla) ──────────────────────────

function testDetectMediaTitle() {
  console.log(C.bold('\nTest 14a: _detectMediaTitle (YouTube/Spotify/VLC)'));
  let r = _detectMediaTitle('Video épico - YouTube', 'browser');
  assert(
    r && r.title === 'Video épico' && r.platform === 'youtube',
    'título con - YouTube → limpio + plataforma'
  );
  r = _detectMediaTitle('League - Twitch', 'browser');
  assert(
    r && r.title === 'League' && r.platform === 'twitch',
    'título - Twitch → limpio + plataforma'
  );
  r = _detectMediaTitle('Canción - Artista', 'media');
  assert(
    r && r.title === 'Canción - Artista' && r.platform === 'media',
    'app media → el título ES el contenido'
  );
  r = _detectMediaTitle('Never Gonna - Spotify', 'media');
  assert(
    r && r.title === 'Never Gonna' && r.platform === 'spotify',
    'Spotify app → limpia sufijo y detecta plataforma'
  );
  r = _detectMediaTitle('pelicula.mkv - VLC media player', 'media');
  assert(r && r.title === 'pelicula.mkv', 'VLC → limpia sufijo del reproductor');
  r = _detectMediaTitle('Chrome sin video', 'browser');
  assert(r === null, 'browser sin plataforma reconocible → null');
  r = _detectMediaTitle('', 'media');
  assert(r === null, 'título vacío → null');
}

async function testMediaWatching() {
  console.log(C.bold('\nTest 14b: media_watching (racha sobre el mismo título)'));
  const restore = stubLLM({ complete: async () => 'NO' });
  const engine = makeEngine();
  await engine._onAppTick({
    friendlyName: 'Firefox',
    category: 'browser',
    title: 'Video épico - YouTube',
    elapsed: 0,
    elapsedFormatted: '0m',
  });
  assert(
    !engine._lastAttemptByType['media_watching'],
    'menos de MEDIA_MIN_SEC sobre el título → aún no dispara'
  );
  // Forzar la racha: adelantamos el reloj del track.
  engine._mediaTrack.startedAt = Date.now() - 3 * 60 * 1000;
  await engine._onAppTick({
    friendlyName: 'Firefox',
    category: 'browser',
    title: 'Video épico - YouTube',
    elapsed: 3 * 60,
    elapsedFormatted: '3m',
  });
  await flush();
  assert(
    typeof engine._lastAttemptByType['media_watching'] === 'number',
    '3 min sobre el mismo título → media_watching consultado'
  );
  assert(engine._mediaFired.has('video épico'), 'título marcado como ya comentado');
  engine.stop();
  restore();
}

async function testMediaDedupAndReset() {
  console.log(C.bold('\nTest 14c: media_watching dedup por título y reset'));
  const restore = stubLLM({ complete: async () => 'NO' });
  const engine = makeEngine();

  // Dedup: mismo título dos veces seguidas → no vuelve a intentar.
  await engine._onAppTick({
    friendlyName: 'Firefox',
    category: 'browser',
    title: 'Lo Mismo - YouTube',
    elapsed: 0,
    elapsedFormatted: '0m',
  });
  engine._mediaTrack.startedAt = Date.now() - 3 * 60 * 1000;
  await engine._onAppTick({
    friendlyName: 'Firefox',
    category: 'browser',
    title: 'Lo Mismo - YouTube',
    elapsed: 3 * 60,
    elapsedFormatted: '3m',
  });
  await flush();
  const first = engine._lastAttemptByType['media_watching'];
  assert(typeof first === 'number', 'primer título → consulta');
  await engine._onAppTick({
    friendlyName: 'Firefox',
    category: 'browser',
    title: 'Lo Mismo - YouTube',
    elapsed: 4 * 60,
    elapsedFormatted: '4m',
  });
  await flush();
  assert(
    engine._lastAttemptByType['media_watching'] === first,
    'mismo título ya comentado → NO re-consulta'
  );

  // Reset: cambia de contenido → se reinicia la racha (nuevo title, nuevo track).
  await engine._onAppTick({
    friendlyName: 'Firefox',
    category: 'browser',
    title: 'Otro Video - YouTube',
    elapsed: 0,
    elapsedFormatted: '0m',
  });
  assert(
    engine._mediaTrack && engine._mediaTrack.key === 'otro video',
    'cambió el título → nuevo track'
  );
  // El cooldown por tipo (2h) aún bloquea la re-consulta; lo expiramos para
  // verificar que el NUEVO título sí vuelve a intentar (dedup es por título).
  delete engine._lastAttemptByType['media_watching'];
  engine._mediaTrack.startedAt = Date.now() - 3 * 60 * 1000;
  await engine._onAppTick({
    friendlyName: 'Firefox',
    category: 'browser',
    title: 'Otro Video - YouTube',
    elapsed: 3 * 60,
    elapsedFormatted: '3m',
  });
  await flush();
  assert(
    typeof engine._lastAttemptByType['media_watching'] === 'number' &&
      engine._lastAttemptByType['media_watching'] >= first,
    'nuevo título (cooldown expirado) → re-consulta (racha distinta)'
  );

  // Media no visible → reset total.
  await engine._onAppTick({
    friendlyName: 'VSCode',
    category: 'code',
    title: 'foo.js - Visual Studio Code',
    elapsed: 1,
    elapsedFormatted: '1s',
  });
  assert(engine._mediaTrack === null, 'app no-media → track reseteado');
  engine.stop();
  restore();
}

// ── Test 15: curiosidad de memoria (Fase A) ──────────────────────────────────

function testCuriosityContext() {
  console.log(C.bold('\nTest 15: _buildCuriosityContext (baja fricción + gaps/tensiones)'));
  // getMemoryGaps lee state.graph (global). Lo inyectamos con nodos reales.
  const prevGraph = state.graph;
  state.graph = {
    _ready: true,
    queryNodes: () => [
      { id: 1, type: 'User', label: 'nombre_usuario', content: 'luka', tags: '[]' },
      {
        id: 2,
        type: 'User',
        label: 'ubicacion_usuario',
        content: 'No determinada',
        tags: '[]',
      },
    ],
  };
  try {
    const engine = makeEngine();
    // getTensions en el grafo del engine (fake)
    engine._graph.getTensions = () => [
      {
        contentA: 'le gusta la noche',
        contentB: 'prefiere madrugar',
      },
    ];

    // Baja fricción → curiosidad con gaps + tensión.
    let ctx = engine._buildCuriosityContext({ type: 'return_from_break' });
    assert(ctx.includes('aún no sabes'), 'return_from_break → curiosidad con gap');
    assert(ctx.includes('contradicción'), 'tensión de memoria incluida');
    ctx = engine._buildCuriosityContext({ type: 'long_silence' });
    assert(
      ctx.includes('aún no sabes') && !ctx.includes('aún no sabes su edad'),
      'long_silence → curiosidad con rotación (pide un gap distinto)'
    );
    // Trigger no-baja-fricción → sin curiosidad.
    ctx = engine._buildCuriosityContext({ type: 'context_switch_thrash' });
    assert(ctx === '', 'thrash (alta fricción) → sin curiosidad');
    ctx = engine._buildCuriosityContext({ type: 'media_watching' });
    assert(ctx === '', 'media_watching → sin curiosidad forzada');
    // Sin gaps ni tensiones → vacío. Cubrimos TODOS los KNOWLEDGE_GAPS.
    state.graph.queryNodes = () => [
      { id: 1, type: 'User', label: 'nombre_usuario', content: 'luka', tags: '[]' },
      { id: 2, type: 'User', label: 'edad_usuario', content: '25 años', tags: '[]' },
      { id: 3, type: 'User', label: 'ubicacion_usuario', content: 'CDMX', tags: '[]' },
      { id: 4, type: 'User', label: 'trabajo_usuario', content: 'programador', tags: '[]' },
      { id: 5, type: 'Preference', label: 'musica_favorita', content: 'jazz', tags: '[]' },
      { id: 6, type: 'Preference', label: 'preferencia_anime', content: 'Evangelion', tags: '[]' },
      { id: 7, type: 'Preference', label: 'color_favorito', content: 'verde', tags: '[]' },
      { id: 8, type: 'Preference', label: 'comida_favorita', content: 'tacos', tags: '[]' },
      { id: 9, type: 'Preference', label: 'preferencia_hobby', content: 'leer', tags: '[]' },
      {
        id: 10,
        type: 'Preference',
        label: 'preferencia_lenguaje',
        content: 'typescript',
        tags: '[]',
      },
      { id: 11, type: 'Preference', label: 'preferencia_tonos', content: 'seco', tags: '[]' },
    ];
    engine._graph.getTensions = () => [];
    ctx = engine._buildCuriosityContext({ type: 'return_from_break' });
    assert(ctx === '', 'sin gaps ni tensiones → sin curiosidad');
  } finally {
    state.graph = prevGraph;
  }
}

// ── Test 16: thrash con datos reales (Fase B) ────────────────────────────────

async function testThrashRealData() {
  console.log(C.bold('\nTest 16: context_switch_thrash lleva apps reales y título'));
  const restore = stubLLM({ complete: async () => 'NO' });
  const engine = makeEngine();
  const seen = [];
  const origTry = engine._tryTrigger;
  engine._tryTrigger = async (t) => {
    seen.push(t);
    return origTry.call(engine, t);
  };
  engine._recentSwitches = [
    { ts: Date.now() - 1000, category: 'code', app: 'cursor' },
    { ts: Date.now() - 900, category: 'terminal', app: 'kitty' },
    { ts: Date.now() - 800, category: 'code', app: 'cursor' },
    { ts: Date.now() - 700, category: 'docs', app: 'firefox' },
    { ts: Date.now() - 600, category: 'code', app: 'cursor' },
    { ts: Date.now() - 500, category: 'terminal', app: 'kitty' },
  ];
  engine.setOSSensor(
    fakeSensor(() => ({ title: 'app.ts — Proyecto — Visual Studio Code', idleSecs: 0 }))
  );
  await engine._onAppChanged({ app: 'firefox', category: 'docs' });
  await flush();
  const thrash = seen.find((t) => t.type === 'context_switch_thrash');
  assert(!!thrash, 'thrash se disparó');
  assert(
    Array.isArray(thrash.apps) && thrash.apps.includes('cursor') && thrash.apps.includes('kitty'),
    'payload incluye nombres reales de apps',
    JSON.stringify(thrash.apps)
  );
  assert(
    thrash.title === 'app.ts — Proyecto — Visual Studio Code',
    'payload incluye el título de la ventana actual (categoría de trabajo)'
  );
  assert(
    thrash.context.includes('cursor') && thrash.context.includes('app.ts'),
    'context usa datos reales'
  );

  // Fase 5: el título SOLO entra si la ventana actual es de trabajo. Un título
  // de media/ocio (p. ej. un anime en Crunchyroll) no se revela — vigilancia.
  engine._recentSwitches = [
    { ts: Date.now() - 1000, category: 'code', app: 'cursor' },
    { ts: Date.now() - 900, category: 'terminal', app: 'kitty' },
    { ts: Date.now() - 800, category: 'media', app: 'vlc' },
    { ts: Date.now() - 700, category: 'code', app: 'cursor' },
    { ts: Date.now() - 600, category: 'terminal', app: 'kitty' },
    { ts: Date.now() - 500, category: 'media', app: 'vlc' },
  ];
  engine.setOSSensor(fakeSensor(() => ({ title: 'One Piece Ep 1041 — Crunchyroll', idleSecs: 0 })));
  seen.length = 0;
  await engine._onAppChanged({ app: 'vlc', category: 'media' });
  await flush();
  const thrashMedia = seen.find((t) => t.type === 'context_switch_thrash');
  assert(!!thrashMedia, 'thrash en categoría media también se dispara');
  assert(!thrashMedia.title || thrashMedia.title === null, 'título de media NO entra al payload');
  assert(
    !thrashMedia.context.includes('One Piece'),
    'el contexto NO revela el contenido de media',
    thrashMedia.context.slice(0, 120)
  );
  engine.stop();
  restore();
}

// ── Test 17: contexto de código (Fase C) ─────────────────────────────────────

async function testCodeContext() {
  console.log(C.bold('\nTest 17: _buildCodeContext (archivo enfocado + símbolos)'));
  const engine = new ProactiveEngine(fakeGraph(), {
    getFocusedFile: () => '/proyecto/src/app.ts',
    getSymbols: async () => [
      { name: 'handleLogin', line: 12 },
      { name: 'validateForm', line: 40 },
      { name: 'logout', line: 90 },
    ],
  });

  // Trigger de código en modo producción → archivo + símbolos.
  let ctx = await engine._buildCodeContext({ type: 'sustained_focus', _gate: { score: 0.9 } });
  assert(ctx.includes('app.ts'), 'incluye el archivo enfocado');
  assert(
    ctx.includes('handleLogin') && ctx.includes('validateForm'),
    'incluye símbolos del archivo'
  );
  assert(ctx.includes('opinar algo concreto'), 'instrucción de opinar sobre el archivo');

  // Sin gate (modo no-producción) → solo el archivo, sin símbolos.
  ctx = await engine._buildCodeContext({ type: 'sustained_focus' });
  assert(
    ctx.includes('app.ts') && !ctx.includes('handleLogin'),
    'sin gate → archivo pero NO símbolos'
  );

  // Trigger no-código → vacío.
  ctx = await engine._buildCodeContext({ type: 'late_night' });
  assert(ctx === '', 'trigger no-código → sin contexto');

  // Sin getter de archivo → vacío.
  const bare = new ProactiveEngine(fakeGraph());
  ctx = await bare._buildCodeContext({ type: 'sustained_focus', _gate: {} });
  assert(ctx === '', 'sin getFocusedFile → sin contexto');

  // LSP que falla (getSymbols rechaza) → no rompe, solo el archivo.
  const broken = new ProactiveEngine(fakeGraph(), {
    getFocusedFile: () => '/proyecto/src/foo.ts',
    getSymbols: async () => {
      throw new Error('LSP down');
    },
  });
  ctx = await broken._buildCodeContext({ type: 'lsp_error', _gate: { score: 0.9 } });
  assert(
    ctx.includes('foo.ts') && !ctx.includes('Símbolos'),
    'LSP caído → archivo sin símbolos, no lanza'
  );
}

// ── Test 18: anti-repetición real (Fase D) ───────────────────────────────────

async function testAntiRepeatHistory() {
  console.log(C.bold('\nTest 18: anti-repetición usa el historial de mensajes previos'));
  const engine = makeEngine();
  engine._recentProactive = [
    { msg: '¿Cómo va el proyecto?', trigger: 'sustained_focus', at: 100 },
    { msg: '¿Andas buscando algo?', trigger: 'context_switch_thrash', at: 200 },
    { msg: 'Buen regreso, ¿descansaste?', trigger: 'return_from_break', at: 300 },
  ];
  let captured = null;
  const restore = stubLLM({
    complete: async (msgs) => {
      captured = msgs[0].content;
      return 'algo distinto';
    },
  });
  await engine._generateMessage({ type: 'sustained_focus', context: 'x' });
  assert(
    captured.includes('¿Andas buscando algo?') && captured.includes('Buen regreso'),
    'el prompt cita los últimos mensajes previos'
  );
  assert(
    captured.includes('No repitas esos temas ni hagas preguntas equivalentes'),
    'instrucción anti-repetición presente'
  );
  restore();

  // El gate registra cada envío en _recentProactive.
  const restore2 = stubLLM({ complete: async () => 'Mensaje de prueba genérico' });
  const engine2 = makeEngine();
  const fired = [];
  const listener = (p) => fired.push(p);
  getEventBus().on('initiative:trigger', listener);
  await engine2._tryTrigger({ type: 'long_silence', context: 'x' });
  assert(
    engine2._recentProactive.length === 1 && engine2._recentProactive[0].msg.includes('Mensaje'),
    'tras un envío, el historial guarda el mensaje y su trigger'
  );
  getEventBus().off('initiative:trigger', listener);
  engine2.stop();
  restore2();
}

// ── Test 19: match pantalla ↔ memoria de gustos ──────────────────────────────

function testTasteMatch() {
  console.log(C.bold('\nTest 19: _matchMediaTaste (contenido en pantalla ↔ gustos)'));
  const nodes = [
    { label: 'musica_favorita', content: 'G2 Shanks', importance: 0.9 },
    { label: 'comida_favorita', content: 'tacos al pastor', importance: 0.8 },
    { label: 'preferencia_anime', content: 'Evangelion', importance: 0.7 },
  ];

  let r = _matchMediaTaste('G2 Shanks - Spotify', nodes);
  assert(
    r.length === 1 && r[0].label === 'musica_favorita',
    'título que coincide → match del nodo de gusto'
  );
  assert(typeof r[0].score === 'number' && r[0].score > 0, 'el match trae score');
  r = _matchMediaTaste('Dragon Ball - YouTube', nodes);
  assert(r.length === 0, 'sin términos compartidos → sin match');
  r = _matchMediaTaste('', nodes);
  assert(r.length === 0, 'título vacío → sin match');
  r = _matchMediaTaste('Tacos al pastor receta - YouTube', [nodes[1]]);
  assert(
    r.length === 1 && r[0].label === 'comida_favorita',
    'coincidencia parcial del contenido → match'
  );
}

// ── Test 20: _extractFinalMessage quita el chain-of-thought del LLM ──────────
// Los modelos de razonamiento vuelcan su razonamiento (con datos internos del
// sistema: score del gate, umbrales, contexto crudo) en el content antes del
// mensaje final. El usuario solo debe ver el mensaje de proactividad.

function testExtractFinalMessage() {
  console.log(C.bold('\nTest 20: _extractFinalMessage descarta el razonamiento interno'));
  const leaked = `Here's a thinking process:
Analyze User Input:
Trigger/Reason: High app switching (6 times in 10 min). Gate already approved (score 0.465). I MUST write a message.
Constraints: 1-3 sentences max. THRASH_MIN_SWITCHES = 6.
Draft - Mental Refinement:
Saltar entre apps va a hacer que la cabeza explote.
Better. Check constraints.
Let's verify against constraints:
'Nunca usas frases como' -> Checked.

Veo que has saltado entre la terminal, WhatsApp y el repo del asistente. Si estás cruzando datos, dime qué archivo tienes abierto en OpenCode y lo revisamos línea por línea.`;
  const got = _extractFinalMessage(leaked);
  assert(
    got.includes('Veo que has saltado entre la terminal'),
    'conserva el mensaje final de Kaoru'
  );
  assert(
    !got.includes('Gate already approved') &&
      !got.includes('score 0.465') &&
      !got.includes('THRASH_MIN_SWITCHES') &&
      !got.includes('thinking process') &&
      !got.includes('Draft') &&
      !got.includes('Constraints'),
    'descarta todo el razonamiento interno (score, umbrales, cabeceras)'
  );
  assert(
    _extractFinalMessage('Hola, esto es un mensaje normal') === 'Hola, esto es un mensaje normal',
    'mensaje directo sin razonamiento pasa tal cual'
  );
  assert(_extractFinalMessage('') === '', 'entrada vacía → vacío');
  assert(_extractFinalMessage(null) === '', 'entrada nula → vacío');
}

async function testMediaTriggerCarriesTaste() {
  console.log(C.bold('\nTest 19b: el trigger media_watching lleva mediaTasteMatch + tasteMatches'));
  const restore = stubLLM({ complete: async () => 'NO' });
  const engine = makeEngine();
  engine._graph.getWorldModel = () => [
    {
      type: 'Preference',
      label: 'musica_favorita',
      content: 'G2 Shanks',
      importance: 0.9,
      tags: '[]',
      id: 1,
    },
  ];
  let captured = null;
  const origTry = engine._tryTrigger;
  engine._tryTrigger = async (t) => {
    captured = t;
    return 'NO';
  };
  await engine._onAppTick({
    friendlyName: 'Spotify',
    category: 'media',
    title: 'G2 Shanks - Spotify',
    elapsed: 0,
    elapsedFormatted: '0m',
  });
  engine._mediaTrack.startedAt = Date.now() - 3 * 60 * 1000;
  await engine._onAppTick({
    friendlyName: 'Spotify',
    category: 'media',
    title: 'G2 Shanks - Spotify',
    elapsed: 3 * 60,
    elapsedFormatted: '3m',
  });
  await flush();
  assert(
    captured && captured.type === 'media_watching' && captured.mediaTasteMatch === true,
    'trigger marcado con mediaTasteMatch cuando el contenido conecta con memoria'
  );
  assert(
    captured &&
      Array.isArray(captured.tasteMatches) &&
      captured.tasteMatches[0].label === 'musica_favorita',
    'tasteMatches llega con el nodo de gusto relacionado'
  );
  engine._tryTrigger = origTry;
  engine.stop();
  restore();
}

// ── Test 19c: contexto NEUTRO de media cuando no hay gusto guardado ──────────
// Fase 5: referenciar el título exacto de algo que el usuario no ha compartido
// se siente a vigilancia ("sé que estás viendo X"). El contexto del trigger
// solo nombra el contenido si conecta con una preferencia confirmada.

async function testMediaNeutralContext() {
  console.log(C.bold('\nTest 19c: media_watching usa contexto NEUTRO sin match de gustos'));
  const restore = stubLLM({ complete: async () => 'NO' });
  const engine = makeEngine();
  // Sin memoria de gustos → el contenido NO conecta con nada conocido.
  engine._graph.getWorldModel = () => [];
  let captured = null;
  const origTry = engine._tryTrigger;
  engine._tryTrigger = async (t) => {
    captured = t;
    return 'NO';
  };
  await engine._onAppTick({
    friendlyName: 'Firefox',
    category: 'browser',
    title: 'One Piece Ep 1041 - YouTube',
    elapsed: 0,
    elapsedFormatted: '0m',
  });
  engine._mediaTrack.startedAt = Date.now() - 3 * 60 * 1000;
  await engine._onAppTick({
    friendlyName: 'Firefox',
    category: 'browser',
    title: 'One Piece Ep 1041 - YouTube',
    elapsed: 3 * 60,
    elapsedFormatted: '3m',
  });
  await flush();
  assert(captured && captured.type === 'media_watching', 'media_watching se disparó');
  assert(captured.mediaTasteMatch === false, 'sin match de gustos → mediaTasteMatch false');
  assert(
    !captured.context.includes('One Piece'),
    'el contexto NO revela el título sin match',
    captured.context
  );
  assert(
    captured.context.includes('contenido en pantalla'),
    'el contexto es NEUTRO (contenido en pantalla)',
    captured.context
  );
  engine._tryTrigger = origTry;
  engine.stop();
  restore();
}

// ── Test 19d: ventana ADAPTATIVA de conversación activa (Fase 5) ─────────────
// No se interrumpe si el usuario tiene ≥ 3 turnos en los últimos 30 min, aunque
// su último mensaje tenga más de 2 min (pausa para pensar). Complementa el
// RECENT_CHAT_MS fijo, no lo reemplaza.

async function testConvoActiveWindow() {
  console.log(C.bold('\nTest 19d: conversación ACTIVA → gate bloquea (ventana adaptativa)'));
  const restore = stubLLM();
  const engine = makeEngine();

  const now = Date.now();

  // < 3 turnos y sin mensaje reciente → NO hay conversación activa.
  engine._lastUserMsg = now - 5 * 60 * 1000;
  engine._recentUserTurns = [now - 15 * 60 * 1000, now - 5 * 60 * 1000];
  assert(engine._isConvoActive(now) === false, '2 turnos en 30 min → NO conversación activa');

  // 3 turnos dentro de la ventana → conversación activa.
  engine._recentUserTurns = [now - 25 * 60 * 1000, now - 12 * 60 * 1000, now - 3 * 60 * 1000];
  assert(engine._isConvoActive(now) === true, '3 turnos en 30 min → conversación ACTIVA');

  // _recordUserTurn: acumula y PODA a la ventana en cada registro (los turnos
  // viejos se descartan al añadir uno nuevo).
  engine._recentUserTurns = [now - 45 * 60 * 1000]; // turno fuera de la ventana
  engine._recordUserTurn();
  engine._recordUserTurn();
  assert(
    engine._recentUserTurns.length === 2,
    '_recordUserTurn descarta turnos fuera de la ventana (30 min)',
    JSON.stringify(engine._recentUserTurns)
  );

  // Integración: con conversación activa, _tryTrigger bloquea aunque el último
  // mensaje sea viejo (el gate convoActive frena antes de consultar al LLM).
  engine._lastUserMsg = now - 5 * 60 * 1000;
  engine._recentUserTurns = [now - 25 * 60 * 1000, now - 12 * 60 * 1000, now - 3 * 60 * 1000];
  const res = await engine._tryTrigger({ type: 'long_silence', context: 'x' });
  assert(
    res && res.blocked === true,
    '_tryTrigger con conversación activa → { blocked }',
    JSON.stringify(res)
  );

  engine.stop();
  restore();
}

function testGenericContentFilter() {
  console.log(C.bold('\nTest 20: contenido genérico del LLM ya no cuenta como identidad real'));
  const prevGraph = state.graph;
  try {
    // Caso real de la DB del usuario: preferencia_ubicacion = "PC del usuario"
    // (boilerplate). Debe dejar de "tapar" el gap de dónde vive.
    state.graph = {
      _ready: true,
      usingFallback: false,
      queryNodes: () => [
        {
          id: 1,
          type: 'Preference',
          label: 'preferencia_ubicacion',
          content: 'PC del usuario',
          tags: '[]',
        },
      ],
    };
    assert(
      getMemoryGaps().some((g) => g.trait === 'dónde vive'),
      '"PC del usuario" ya no tapa el gap de dónde vive'
    );

    // Con contenido REAL, el gap sí desaparece (el filtro no es agresivo).
    state.graph.queryNodes = () => [
      { id: 1, type: 'Preference', label: 'preferencia_ubicacion', content: 'CDMX', tags: '[]' },
    ];
    assert(
      !getMemoryGaps().some((g) => g.trait === 'dónde vive'),
      'contenido real (CDMX) → el gap se cierra'
    );

    // Unidades: isRealIdentityNode filtra boilerplate y placeholders, no lo real.
    assert(
      !isRealIdentityNode({
        type: 'Preference',
        label: 'preferencia_ubicacion',
        content: 'PC del usuario',
        tags: '[]',
      }),
      'contenido genérico → no es identidad real'
    );
    assert(
      !isRealIdentityNode({
        type: 'User',
        label: 'proyecto_principal',
        content: 'no se menciona',
        tags: '[]',
      }),
      '"no se menciona" es placeholder → no es identidad real'
    );
    assert(
      isRealIdentityNode({
        type: 'Preference',
        label: 'musica_favorita',
        content: 'G2 Shanks',
        tags: '[]',
      }),
      'contenido real (G2 Shanks) → sí es identidad real'
    );
    // Dato real que recibió una cola placeholder (" | Actualizado: No revelada").
    // Se evalúa por segmentos: si el dato de cabecera es real, el nodo es real.
    state.graph.queryNodes = () => [
      {
        id: 1,
        type: 'Preference',
        label: 'preferencia_anime',
        content: 'Anime con acción y aventuras | Actualizado: No revelada',
        tags: '[]',
      },
    ];
    assert(
      !getMemoryGaps().some((g) => g.trait.includes('anime')),
      'preferencia_anime con dato real + cola placeholder → el gap de anime se cierra'
    );
    // Un "color favorito" que no es un color no debe afirmarse ni cerrar el gap.
    assert(
      !isRealIdentityNode({
        type: 'Preference',
        label: 'color_favorito',
        content: 'humor negro',
        tags: '[]',
      }),
      '"humor negro" no es color → no identidad real (gap de color queda abierto)'
    );
    assert(
      isRealIdentityNode({
        type: 'Preference',
        label: 'color_favorito',
        content: 'Colores favoritos: rojo',
        tags: '[]',
      }),
      'color real → identidad (varias palabras + estructura válidas)'
    );
  } finally {
    state.graph = prevGraph;
  }
}

// ── Test 20b: hechos 'stale' aparecen como gaps de revalidación (F3.1) ───────

function testStaleGaps() {
  console.log(
    C.bold('\nTest 20b: hechos fixed marcados stale se revalida por gap de baja prioridad')
  );
  const prevGraph = state.graph;
  try {
    // Un trabajo_usuario con contenido real pero taggado 'stale' por el
    // FactReasonerStore ya no "tapa" el gap: aparece un gap de REVALIDACIÓN.
    state.graph = {
      _ready: true,
      usingFallback: false,
      queryNodes: () => [
        {
          id: 1,
          type: 'User',
          label: 'trabajo_usuario',
          content: 'Editor de video',
          tags: '["stale"]',
        },
      ],
    };
    assert(
      getMemoryGaps().some((g) => g.trait === 'si sigue trabajando en lo mismo'),
      'trabajo stale → reaparece como gap de revalidación'
    );

    // Sin tag stale, un dato real sigue contando como conocido (sin gap).
    state.graph.queryNodes = () => [
      { id: 1, type: 'User', label: 'trabajo_usuario', content: 'Editor de video', tags: '[]' },
    ];
    assert(
      !getMemoryGaps().some((g) => g.trait === 'si sigue trabajando en lo mismo'),
      'trabajo vigente (sin stale) → ningún gap de revalidación'
    );

    // Un label PERMANENTE (nombre_usuario) aunque esté taggado stale no genera
    // gap: no tiene STALE_ASK, su vigencia no se revalida.
    state.graph.queryNodes = () => [
      { id: 1, type: 'User', label: 'nombre_usuario', content: 'Ana', tags: '["stale"]' },
    ];
    assert(
      !getMemoryGaps().some((g) => g.trait === 'su nombre'),
      'nombre stale → sigue siendo conocido (permanente, no se revalida)'
    );
  } finally {
    state.graph = prevGraph;
  }
}

function testMemoryTastePriority() {
  console.log(C.bold('\nTest 21: _buildMemoryContext prioriza gustos y filtra ruido'));
  const engine = makeEngine();
  engine._graph.getWorldModel = () => [
    {
      type: 'Preference',
      label: 'preferencia_archivo',
      content: 'C:\\Users\\Usuario\\Documents\\proyecto.docx',
      importance: 0.9,
      tags: '[]',
      id: 1,
    },
    {
      type: 'Preference',
      label: 'musica_favorita',
      content: 'G2 Shanks',
      importance: 0.85,
      tags: '[]',
      id: 2,
    },
    {
      type: 'Preference',
      label: 'preferencia_idioma',
      content: 'Más de 100 idiomas, incluyendo español, etc.',
      importance: 0.8,
      tags: '[]',
      id: 3,
    },
    {
      type: 'Preference',
      label: 'preferencia_commando',
      content: 'ls core/',
      importance: 0.7,
      tags: '[]',
      id: 4,
    },
    {
      type: 'Preference',
      label: 'anime_favorito',
      content: 'Evangelion',
      importance: 0.6,
      tags: '[]',
      id: 5,
    },
  ];
  const ctx = engine._buildMemoryContext();
  assert(ctx.includes('G2 Shanks'), 'gusto de música entra al prompt');
  assert(ctx.includes('Evangelion'), 'gusto de anime entra al prompt');
  assert(
    !ctx.includes('Usuario\\Documents'),
    'path de archivo ruidoso NO entra (prioridad de gustos)'
  );
  assert(!ctx.includes('Más de 100 idiomas'), 'boilerplate de capacidades filtrado del prompt');
  engine.stop();
}

// ── Test 22: gate media_watching sube score con match de gustos ──────────────

function testMediaBoostGate() {
  console.log(C.bold('\nTest 22: mediaTasteMatch sube saliencia/urgencia del candidato'));
  const base = candidateFromTrigger({ type: 'media_watching', title: 'x', mediaTasteMatch: false });
  const boosted = candidateFromTrigger({
    type: 'media_watching',
    title: 'x',
    mediaTasteMatch: true,
  });
  assert(base && boosted, 'candidateFromTrigger arma candidatos media_watching');
  assert(boosted.saliencia > base.saliencia, 'saliencia sube con match de gustos');
  assert(boosted.urgencia > base.urgencia, 'urgencia sube con match de gustos');
}

// ── Test 23: registro adaptativo (frame de situación) ────────────────────────

async function testSituationFrame() {
  console.log(C.bold('\nTest 23: registro adaptativo (_buildSituationFrame)'));

  // 23a. Recepción mala → registro conservador.
  const engine = makeEngine();
  engine._relationLog = [
    {
      proposalId: 'a',
      trigger: 'git_redflag',
      msg: 'x',
      at: Date.now() - 3000,
      outcome: 'rejected',
    },
    {
      proposalId: 'b',
      trigger: 'system_warning',
      msg: 'y',
      at: Date.now() - 2000,
      outcome: 'ignored',
    },
    {
      proposalId: 'c',
      trigger: 'lsp_error',
      msg: 'z',
      at: Date.now() - 1000,
      outcome: 'rejected',
    },
  ];
  let frame = engine._buildSituationFrame();
  assert(
    frame.includes('MUY conservadora'),
    'descartes/ignorados recientes → registro conservador',
    frame
  );
  assert(frame.includes('no ofrezcas acciones nuevas'), '…y evita ofrecer acciones nuevas');

  // 23b. Recepción buena → registro natural.
  const engine2 = makeEngine();
  engine2._relationLog = [
    {
      proposalId: 'a',
      trigger: 'git_redflag',
      msg: 'x',
      at: Date.now() - 3000,
      outcome: 'accepted',
    },
    { proposalId: 'b', trigger: 'lsp_error', msg: 'y', at: Date.now() - 2000, outcome: 'accepted' },
  ];
  frame = engine2._buildSituationFrame();
  assert(frame.includes('bien recibidas'), 'aceptaciones → registro natural');

  // 23c. Habló hace poco → no repetir.
  const engine3 = makeEngine();
  engine3._lastProactive = Date.now() - 5 * 60 * 1000;
  frame = engine3._buildSituationFrame();
  assert(frame.includes('menos de 45 min'), 'habló hace poco → advertencia de no repetir');

  // 23d. Flow de código → ultra breve.
  const engine4 = makeEngine([], () => ({ category: 'code', idleSecs: 5, elapsed: 700 }));
  engine4._categoryStreakStart = Date.now() - 12 * 60 * 1000;
  frame = engine4._buildSituationFrame();
  assert(frame.includes('MÁXIMO 1 oración'), 'flow de código → registro ultra-breve', frame);
  engine4.stop();

  // 23e. El frame se inyecta en el prompt de generación.
  const engine5 = makeEngine();
  engine5._relationLog = [
    {
      proposalId: 'a',
      trigger: 'git_redflag',
      msg: 'x',
      at: Date.now() - 3000,
      outcome: 'rejected',
    },
    {
      proposalId: 'b',
      trigger: 'system_warning',
      msg: 'y',
      at: Date.now() - 2000,
      outcome: 'rejected',
    },
  ];
  let captured = null;
  const restore = stubLLM({
    complete: async (msgs) => {
      captured = msgs[0].content;
      return 'mensaje de prueba';
    },
  });
  await engine5._generateMessage({ type: 'return_from_break', context: 'x' });
  assert(
    captured.includes('REGISTRO DEL MOMENTO') && captured.includes('MUY conservadora'),
    'el frame de situación llega al prompt del LLM'
  );
  restore();

  engine.stop();
  engine2.stop();
  engine3.stop();
  engine5.stop();
}

// ── Test 24: hilo relacional (bookend + outcomes) ────────────────────────────

async function testRelationBookend() {
  console.log(C.bold('\nTest 24: hilo relacional (_relationLog + bookend + outcomes)'));

  // 24a. Un envío queda registrado en el hilo relacional.
  const restore = stubLLM({ complete: async () => 'Hay un conflicto de merge pendiente.' });
  const engine = makeEngine();
  const fired = [];
  const listener = (p) => fired.push(p);
  getEventBus().on('initiative:trigger', listener);
  const res = await engine._tryTrigger({
    type: 'git_redflag',
    kind: 'merge_conflict',
    context: 'x',
  });
  assert(res === 'Hay un conflicto de merge pendiente.', 'envía el mensaje');
  assert(engine._relationLog.length === 1, 'mensaje registrado en el hilo relacional');
  assert(
    engine._relationLog[0].trigger === 'git_redflag' &&
      typeof engine._relationLog[0].proposalId === 'string' &&
      engine._relationLog[0].outcome === null,
    'entrada con trigger + proposalId + outcome pendiente'
  );

  // 24b. Sin respuesta → bookend "sin respuesta" al insistir con el mismo tipo.
  let bookend = engine._buildBookend({ type: 'git_redflag', kind: 'merge_conflict' });
  assert(bookend.includes('sin respuesta'), 'reintento mismo día → bookend sin respuesta', bookend);
  assert(bookend.includes('conflicto'), 'bookend cita el mensaje previo');

  // 24c. Descartada → bookend de reiteración.
  engine.handleDecision({
    proposalId: engine._relationLog[0].proposalId,
    type: 'git_redflag',
    decision: 'rejected',
  });
  assert(
    engine._relationLog[0].outcome === 'rejected',
    'handleDecision marca el outcome en el hilo'
  );
  bookend = engine._buildBookend({ type: 'git_redflag', kind: 'merge_conflict' });
  assert(
    bookend.includes('Reiteración') && bookend.includes('descartado o ignorado'),
    'bookend de reiteración tras rechazo'
  );

  // 24d. Aceptada → sin bookend.
  engine._relationLog.push({
    proposalId: 'zz',
    trigger: 'lsp_error',
    msg: 'parche aplicado',
    at: Date.now(),
    outcome: null,
  });
  engine.handleDecision({ proposalId: 'zz', type: 'lsp_error', decision: 'accepted' });
  assert(engine._buildBookend({ type: 'lsp_error' }) === '', 'aceptado → sin bookend');

  // 24e. Otros tipos no se ven afectados por el bookend (granularidad por tipo).
  assert(
    engine._buildBookend({ type: 'system_warning' }) === '',
    'otro tipo sin historial → sin bookend'
  );

  getEventBus().off('initiative:trigger', listener);
  engine.stop();
  restore();
}

// ── Test 25: silencio largo solo "porque pasó algo" ──────────────────────────

async function testSilenceCause() {
  console.log(C.bold('\nTest 25: long_silence solo "porque pasó algo"'));

  const restore = stubLLM({ complete: async () => 'NO' });

  // 25a. Silencio largo SIN razón → el LLM ni se consulta.
  let engine = makeEngine();
  engine._lastUserMsg = Date.now() - 5 * 60 * 60 * 1000; // 5h sin hablar
  assert(engine._silenceHasReason() === false, 'sin pendientes/cola/gaps → sin razón');
  await engine._maybeLongSilence(new Date());
  assert(
    !engine._lastAttemptByType['long_silence'],
    'silencio 5h SIN razón → no se consulta al LLM'
  );
  engine.stop();

  // 25b. Con un diferido en cola → hay causa y el silencio se vuelve mensaje.
  engine = makeEngine();
  engine._lastUserMsg = Date.now() - 5 * 60 * 60 * 1000;
  engine._queue.push({ tipo: 'git_redflag', kind: 'default' }, { now: Date.now() });
  assert(engine._silenceHasReason() === true, 'diferido en cola → hay razón');
  await engine._maybeLongSilence(new Date());
  assert(
    typeof engine._lastAttemptByType['long_silence'] === 'number',
    'silencio 5h CON causa → consulta el LLM'
  );
  engine.stop();
  restore();
}

// ── Test 26: intención abandonada → candidato con el texto REAL ──────────────

function testIntentionStaleCandidate() {
  console.log(C.bold('\nTest 26: intention_stale — candidato desde la pila de intenciones'));
  const { CURIOSITY_TYPES, INTENTION_STALE_DAYS } = require('../core/behavior/proactive/config.js');
  const DAY_MS = 24 * 60 * 60 * 1000;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proactive-int-'));
  const graph = new StateGraph(path.join(dir, 'core.db')).init();
  const now = Date.now();

  // Meta vieja y abandonada (10 días sin actividad) → debe generar candidato.
  const abandoned = graph.createIntention({
    sessionId: 's1',
    goal: 'Migrar el backend a PostgreSQL',
    steps: [],
  });
  graph._db
    .prepare('UPDATE intentions SET created_at=?, updated_at=?, last_progress_at=? WHERE id=?')
    .run(now - 10 * DAY_MS, now - 10 * DAY_MS, now - 10 * DAY_MS, abandoned);

  // Meta con actividad RECIENTE → no debe generar candidato.
  const fresh = graph.createIntention({
    sessionId: 's1',
    goal: 'Preparar la demo de mañana',
    steps: [],
  });
  graph.updateIntention(fresh, { lastProgress: 'ensayé la demo' });

  // Meta resuelta hace meses → tampoco (status done ≠ active).
  const done = graph.createIntention({ sessionId: 's1', goal: 'Arreglar el login', steps: [] });
  graph._db
    .prepare('UPDATE intentions SET created_at=?, updated_at=?, last_progress_at=? WHERE id=?')
    .run(now - 90 * DAY_MS, now - 90 * DAY_MS, now - 90 * DAY_MS, done);
  graph.completeIntention(done);

  assert(
    CURIOSITY_TYPES.has('intention_stale'),
    'intention_stale está en CURIOSITY_TYPES (cupo propio)'
  );
  assert(
    INTENTION_STALE_DAYS === 5,
    'INTENTION_STALE_DAYS arranca en 5',
    `got=${INTENTION_STALE_DAYS}`
  );

  const engine = new ProactiveEngine(graph);
  const cands = engine._collectCuriosityCandidates();
  const staleCands = cands.filter((c) => c.type === 'intention_stale');

  assert(
    staleCands.length === 1,
    'solo la intención ABANDONADA genera candidato (activa vieja)',
    JSON.stringify(staleCands.map((c) => c.goal))
  );
  assert(
    staleCands[0].goal === 'Migrar el backend a PostgreSQL',
    'el candidato lleva el TEXTO REAL de la meta',
    staleCands[0]?.goal
  );
  assert(
    staleCands[0].nodeId === abandoned && typeof staleCands[0].lastProgressAt === 'number',
    'referencia el id de la intención y su last_progress_at'
  );
  assert(
    fresh && staleCands.every((c) => c.goal !== 'Preparar la demo de mañana'),
    'la meta con actividad RECIENTE NO genera candidato'
  );

  engine.stop();
  graph.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Test 27: el mensaje usa el texto real de la intención ────────────────────

async function testIntentionStaleMessage() {
  console.log(C.bold('\nTest 27: el mensaje de intention_stale usa el texto REAL de la meta'));
  const engine = makeEngine();
  let captured = '';
  const restore = stubLLM({
    complete: async (msgs) => {
      captured = msgs[0].content;
      return '¿Cómo va lo de migrar a PostgreSQL?';
    },
  });

  await engine._generateMessage({
    type: 'intention_stale',
    goal: 'Migrar el backend a PostgreSQL',
    lastProgress: 'falta el refactor de la capa de datos',
    lastProgressAt: Date.now() - 6 * 24 * 60 * 60 * 1000,
  });

  assert(
    captured.includes('Migrar el backend a PostgreSQL'),
    'el prompt cita la meta con las PALABRAS DEL USUARIO'
  );
  assert(
    captured.includes('falta el refactor de la capa de datos'),
    'el prompt cita el último progreso real que dejó'
  );
  assert(
    captured.includes('dijiste que ibas a') || captured.includes('continuidad real'),
    'instrucción de retomar como continuidad real de conversación, no template',
    captured.slice(0, 200)
  );
  assert(!captured.includes('mensaje de silencio'), 'nada de silencio genérico en el prompt');
  engine.stop();
  restore();
}

// ── Test 28: el outcome de curiosidad cierra el lazo de revalidación ─────────

async function testCuriosityOutcomeLoop() {
  console.log(
    C.bold('\nTest 28: outcome de curiosidad → cierra el lazo (stale/tensión/intención)')
  );
  const { PROPOSAL_HINTS } = require('../core/behavior/proactive/config.js');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proactive-loop-'));
  const graph = new StateGraph(path.join(dir, 'core.db')).init();
  const now = Date.now();

  // ── memory_stale: dos hechos taggeados 'stale' ─────────────────────────────
  const ins = graph._db.prepare(
    'INSERT INTO nodes (type, label, content, importance, tags, verified_at, created_at, updated_at, last_accessed_at) VALUES (?,?,?,?,?,?,?,?,?)'
  );
  const staleKeep = ins.run(
    'User',
    'trabajo_usuario',
    'trabajando en SpaceX',
    0.8,
    '["stale"]',
    now - 40 * 24 * 60 * 60 * 1000,
    now,
    now,
    now
  ).lastInsertRowid;
  const staleDrop = ins.run(
    'User',
    'trabajo_usuario',
    'compro unicornios',
    0.8,
    '["stale"]',
    now - 40 * 24 * 60 * 60 * 1000,
    now,
    now,
    now
  ).lastInsertRowid;

  assert(
    PROPOSAL_HINTS.memory_stale && PROPOSAL_HINTS.memory_tension,
    'memory_stale y memory_tension ahora tienen PROPOSAL_HINTS (botones reales)'
  );

  let engine = new ProactiveEngine(graph);

  const staleProposal = await engine._buildProposal({
    type: 'memory_stale',
    kind: 'trabajo_usuario',
    nodeId: staleKeep,
    label: 'trabajo_usuario',
    content: 'trabajando en SpaceX',
  });
  assert(
    staleProposal && staleProposal.id && engine._proposalRefs.has(staleProposal.id),
    'la propuesta memory_stale lleva proposalId + ref al nodo'
  );
  engine.handleDecision({
    proposalId: staleProposal.id,
    type: 'memory_stale',
    decision: 'accepted',
  });
  const afterKeep = graph.getNode(staleKeep);
  const staleTags = JSON.parse(afterKeep.tags || '[]');
  assert(
    !staleTags.includes('stale'),
    'aceptado → se quita el tag "stale"',
    JSON.stringify(staleTags)
  );
  assert(
    afterKeep.verified_at >= now,
    'aceptado → verified_at refrescado (FactReasoner no lo vuelve a marcar)'
  );

  const dropProposal = await engine._buildProposal({
    type: 'memory_stale',
    kind: 'trabajo_usuario',
    nodeId: staleDrop,
    label: 'trabajo_usuario',
    content: 'compro unicornios',
  });
  engine.handleDecision({
    proposalId: dropProposal.id,
    type: 'memory_stale',
    decision: 'rejected',
  });
  assert(graph.getNode(staleDrop).archived === 1, 'rechazado → el hecho caduco se archiva');

  // ── memory_tension: un par CONTRADICES vivo ────────────────────────────────
  const tA = ins.run(
    'User',
    'comida_favorita',
    'pizza',
    0.7,
    '[]',
    now,
    now,
    now,
    now
  ).lastInsertRowid;
  const tB = ins.run(
    'User',
    'comida_favorita',
    'sushi',
    0.7,
    '[]',
    now,
    now,
    now,
    now
  ).lastInsertRowid;
  graph.createRelation({ source: tA, target: tB, type: 'CONTRADICES' });
  assert(graph.getTensions().length === 1, 'la tensión vive (getTensions la ve)');

  const tensionProposal = await engine._buildProposal({
    type: 'memory_tension',
    kind: 'default',
    label: 'comida_favorita',
    nodeA: tA,
    nodeB: tB,
    contentA: 'pizza',
    contentB: 'sushi',
  });
  assert(
    tensionProposal.id && engine._proposalRefs.has(tensionProposal.id),
    'la propuesta memory_tension lleva ref { nodeA, nodeB }'
  );
  engine.handleDecision({
    proposalId: tensionProposal.id,
    type: 'memory_tension',
    decision: 'accepted',
  });
  assert(graph.getTensions().length === 0, 'aceptado → se conserva nodeA y la tensión desaparece');
  assert(
    graph.getNode(tB).archived === 1 && graph.getNode(tA).archived === 0,
    'el lado descartado (nodeB) queda archivado, el conservado vivo'
  );

  // ── intention_stale: meta abandonada ───────────────────────────────────────
  const intention = graph.createIntention({
    sessionId: 's1',
    goal: 'Migrar a PostgreSQL',
    steps: [],
  });
  graph._db
    .prepare('UPDATE intentions SET created_at=?, updated_at=?, last_progress_at=? WHERE id=?')
    .run(
      now - 10 * 24 * 60 * 60 * 1000,
      now - 10 * 24 * 60 * 60 * 1000,
      now - 10 * 24 * 60 * 60 * 1000,
      intention
    );

  const intProposal = await engine._buildProposal({
    type: 'intention_stale',
    kind: 'default',
    nodeId: intention,
    goal: 'Migrar a PostgreSQL',
  });
  assert(
    intProposal.id && engine._proposalRefs.has(intProposal.id),
    'la propuesta intention_stale lleva ref al id de la intención'
  );

  engine.handleDecision({
    proposalId: intProposal.id,
    type: 'intention_stale',
    decision: 'accepted',
  });
  const refreshed = graph.getIntention(intention);
  assert(
    refreshed.status === 'active' && refreshed.last_progress_at >= now,
    'aceptado → la meta sigue activa y su last_progress_at se refresca (deja de salir stale)'
  );

  const intProposal2 = await engine._buildProposal({
    type: 'intention_stale',
    kind: 'default',
    nodeId: intention,
    goal: 'Migrar a PostgreSQL',
  });
  engine.handleDecision({
    proposalId: intProposal2.id,
    type: 'intention_stale',
    decision: 'rejected',
  });
  assert(
    graph.getIntention(intention).status === 'dropped',
    'rechazado → la meta se descarta (dropIntention)'
  );

  engine.stop();
  graph.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Runner ───────────────────────────────────────────────────────────────────

(async () => {
  console.log(C.bold(C.cyan('\nAuditoría del flujo proactivo')));

  await testTryTriggerContract();
  await testTypeCooldown();
  await testGlobalGap();
  await testDecidingLock();
  await testIdleGate();
  await testFocusBlockEnd();
  await testNoMidFlowNag();
  await testSessionEnd();
  await testThrash();
  await testReturnFromBreak();
  testSpecialDate();
  testBehaviorUrgency();
  await testSessionTs();
  testDetectMediaTitle();
  await testMediaWatching();
  await testMediaDedupAndReset();
  testCuriosityContext();
  await testThrashRealData();
  await testCodeContext();
  await testAntiRepeatHistory();
  testTasteMatch();
  testExtractFinalMessage();
  await testMediaTriggerCarriesTaste();
  await testMediaNeutralContext();
  await testConvoActiveWindow();
  testGenericContentFilter();
  testStaleGaps();
  testMemoryTastePriority();
  testMediaBoostGate();
  await testSituationFrame();
  await testRelationBookend();
  await testSilenceCause();
  testIntentionStaleCandidate();
  await testIntentionStaleMessage();
  await testCuriosityOutcomeLoop();

  console.log(
    C.bold(`\nResultado: ${C.green(`${passed} ✓`)}${failed ? ` / ${C.red(`${failed} ✗`)}` : ''}`)
  );
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(C.red('Fallo en la ejecución de la suite:'), e);
  process.exit(1);
});
