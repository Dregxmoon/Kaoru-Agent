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
const fs   = require('fs');
const os   = require('os');

const C = {
  green:  (s) => `\x1b[32m${s}\x1b[0m`,
  red:    (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
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
const { BehaviorModel }   = require('../core/behavior/BehaviorModel.js');
const { StateGraph }      = require('../core/state-graph/StateGraph.js');
const { SessionManager }  = require('../core/state-graph/SessionManager.js');
const LLMProvider         = require('../core/llm/LLMProvider.js');
const { getEventBus }     = require('../infrastructure/event-bus/EventBus.js');

function flush() { return new Promise(r => setTimeout(r, 0)); }

// ── Mocks ─────────────────────────────────────────────────────────────────────

function fakeGraph(userNodes = []) {
  return {
    _ready: true,
    queryNodes: ({ type } = {}) => userNodes.filter(n => !type || n.type === type),
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
  assert(!engine._lastAttemptByType['long_silence'], 'sin proveedor → NO consume cooldown por tipo');
  restore();

  // 1b. Conversación RECIENTE del usuario → bloqueado (el chat abierto por sí
  //     solo ya NO bloquea: es la ventana principal y el canal de las propuestas)
  restore = stubLLM();
  engine = makeEngine();
  engine.onUserMessage(); // el usuario acaba de hablar
  res = await engine._tryTrigger({ type: 'long_silence', context: 'x' });
  assert(res && res.blocked, 'conversación reciente (< 2 min) → { blocked }');
  assert(!engine._lastAttemptByType['long_silence'], 'conversación reciente → NO consume cooldown por tipo');

  // 1b2. Chat abierto pero sin conversación reciente → NO bloquea (Fase B:
  //      las propuestas se muestran en el chat)
  restore = stubLLM({ complete: async () => '¿todo bien?' });
  engine = makeEngine();
  engine.setChatOpen(true);
  res = await engine._tryTrigger({ type: 'long_silence', context: 'x' });
  assert(res === '¿todo bien?', 'chat abierto sin conversación reciente → NO bloquea');
  assert(typeof engine._lastAttemptByType['long_silence'] === 'number', 'chat abierto → consume cooldown (sí se consultó al LLM)');
  engine.setChatOpen(false);
  restore();

  // 1c. LLM decide NO → null (y SÍ consume cooldown: fue consultado)
  restore = stubLLM({ complete: async () => 'NO' });
  engine = makeEngine();
  res = await engine._tryTrigger({ type: 'long_silence', context: 'x' });
  assert(res === null, 'LLM dijo NO → null');
  assert(typeof engine._lastAttemptByType['long_silence'] === 'number', 'LLM dijo NO → SÍ consume cooldown (fue consultado)');
  restore();

  // 1d. LLM genera mensaje → se emite initiative:trigger y se actualiza _lastProactive
  restore = stubLLM({ complete: async () => '¿sigues ahí?' });
  engine = makeEngine();
  const fired = [];
  const listener = (p) => fired.push(p);
  getEventBus().on('initiative:trigger', listener);
  res = await engine._tryTrigger({ type: 'long_silence', context: 'x' });
  assert(res === '¿sigues ahí?', 'LLM genera mensaje → devuelve el mensaje');
  assert(fired.length === 1 && fired[0].suggestion === '¿sigues ahí?' && fired[0].reason === 'long_silence',
    'emite initiative:trigger con { reason, suggestion }',
    JSON.stringify(fired));
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
  assert(typeof res2 === 'string', 'idle 33min + return_from_break → SÍ dispara (es el trigger que vuelve del AFK)');
  engine.stop();
  restore();
}

// ── Test 6: sustained_focus no consume la racha si queda bloqueado ───────────

async function testStreakNotConsumedWhenBlocked() {
  console.log(C.bold('\nTest 6: sustained_focus NO consume la racha si el trigger queda bloqueado'));

  // 6a. Conversación reciente al cruzar el umbral → la racha NO se consume
  let restore = stubLLM();
  let engine = makeEngine();
  engine.onUserMessage();
  await engine._onAppTick({ friendlyName: 'VSCode', category: 'code', elapsed: 301, elapsedFormatted: '5m' });
  assert(engine._categoryStreakFired === false, 'bloqueado por conversación reciente → _categoryStreakFired queda false (reintentará)');
  engine.stop();
  restore();

  // 6b. Desbloqueado y el LLM dice NO → la racha SÍ se consume (fue consultado)
  restore = stubLLM({ complete: async () => 'NO' });
  engine = makeEngine();
  await engine._onAppTick({ friendlyName: 'VSCode', category: 'code', elapsed: 301, elapsedFormatted: '5m' });
  assert(engine._categoryStreakFired === true, 'LLM dijo NO → _categoryStreakFired true (consultado)');
  engine.stop();
  restore();

  // 6c. Desbloqueado y el LLM dice algo → se envía y la racha se consume
  restore = stubLLM({ complete: async () => 'Llevas rato en esto. ¿Atorada en algo?' });
  engine = makeEngine();
  const fired = [];
  const listener = (p) => fired.push(p);
  getEventBus().on('initiative:trigger', listener);
  await engine._onAppTick({ friendlyName: 'VSCode', category: 'code', elapsed: 301, elapsedFormatted: '5m' });
  assert(fired.length === 1 && fired[0].reason === 'sustained_focus', 'se emite el mensaje de sustained_focus');
  assert(engine._categoryStreakFired === true && engine._categoryStreakFiredAt > 0, 'racha marcada como disparada');
  getEventBus().off('initiative:trigger', listener);
  engine.stop();
  restore();

  // 6d. Bloqueo por gap global al cruzar el umbral → la racha NO se consume
  restore = stubLLM();
  engine = makeEngine();
  engine._lastProactive = Date.now(); // acabamos de enviar algo hace 0s
  await engine._onAppTick({ friendlyName: 'VSCode', category: 'code', elapsed: 301, elapsedFormatted: '5m' });
  assert(engine._categoryStreakFired === false, 'bloqueado por gap global → la racha NO se consume');
  engine._lastProactive = 0;
  await engine._onAppTick({ friendlyName: 'VSCode', category: 'code', elapsed: 301, elapsedFormatted: '5m' });
  assert(engine._categoryStreakFired === true, 'pasado el gap global → reintenta y consume la racha');
  engine.stop();
  restore();
}

// ── Test 7: follow-up de sustained_focus ─────────────────────────────────────

async function testFollowup() {
  console.log(C.bold('\nTest 7: follow-up de sustained_focus (minSec × 3)'));

  const restore = stubLLM({ complete: async () => '¿Ya atorada?' });
  const engine = makeEngine();

  // Primer disparo (racha consumida, _lastProactive=now, cooldown=now)
  await engine._onAppTick({ friendlyName: 'VSCode', category: 'code', elapsed: 301, elapsedFormatted: '5m' });
  assert(engine._categoryStreakFired === true, 'primer disparo consume la racha');

  // 7a. Todavía no llega al umbral de follow-up → no dispara, flag queda false
  await engine._onAppTick({ friendlyName: 'VSCode', category: 'code', elapsed: 600, elapsedFormatted: '10m' });
  assert(engine._categoryStreakFollowupFired === false, 'antes de minSec×3 → el follow-up NO dispara ni se consume');
  engine.stop();

  // 7b. En el umbral pero con cooldown/gap activos → bloqueado y NO se consume
  const engine2 = makeEngine();
  await engine2._onAppTick({ friendlyName: 'VSCode', category: 'code', elapsed: 301, elapsedFormatted: '5m' });
  await engine2._onAppTick({ friendlyName: 'VSCode', category: 'code', elapsed: 900, elapsedFormatted: '15m' });
  assert(engine2._categoryStreakFollowupFired === false,
    'en el umbral con cooldown por tipo + gap activos → bloqueado y NO consume el follow-up');
  engine2.stop();

  // 7c. Con cooldown y gap simulados como pasados → el follow-up dispara
  const engine3 = makeEngine();
  await engine3._onAppTick({ friendlyName: 'VSCode', category: 'code', elapsed: 301, elapsedFormatted: '5m' });
  engine3._lastAttemptByType = {};   // cooldown por tipo pasado
  engine3._lastProactive = 0;        // gap global pasado
  await engine3._onAppTick({ friendlyName: 'VSCode', category: 'code', elapsed: 900, elapsedFormatted: '15m' });
  assert(engine3._categoryStreakFollowupFired === true, 'con cooldown/gap pasados → el follow-up dispara y se consume');
  await engine3._onAppTick({ friendlyName: 'VSCode', category: 'code', elapsed: 1200, elapsedFormatted: '20m' });
  assert(engine3._categoryStreakFollowupFired === true, 'segundo follow-up → ya consumido, no dispara de nuevo');
  engine3.stop();
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
  assert(typeof engine._lastAttemptByType['session_end'] === 'number',
    'racha ≥ 20 min + salto a no-trabajo → trigger session_end consultado');
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
    { ts: Date.now() - 1000, category: 'code',     app: 'vscode' },
    { ts: Date.now() - 900,  category: 'terminal', app: 'kitty' },
    { ts: Date.now() - 800,  category: 'code',     app: 'vscode' },
    { ts: Date.now() - 700,  category: 'docs',     app: 'chrome' },
    { ts: Date.now() - 600,  category: 'code',     app: 'vscode' },
    { ts: Date.now() - 500,  category: 'terminal', app: 'kitty' },
  ];
  await engine._onAppChanged({ app: 'firefox', category: 'browser' }); // el 7º switch
  await flush();
  assert(typeof engine._lastAttemptByType['context_switch_thrash'] === 'number',
    '6+ cambios en la ventana con 3+ categorías → trigger thrash consultado');

  // Ventana que no alcanza el mínimo → no dispara
  const engine2 = makeEngine();
  engine2._recentSwitches = [
    { ts: Date.now() - 1000, category: 'code', app: 'vscode' },
    { ts: Date.now() - 500,  category: 'code', app: 'vscode' },
    { ts: Date.now() - 200,  category: 'code', app: 'cursor' },
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
  engine._onIdleChanged({ idle: true, idleSecs: 1200 });   // idle ~20 min
  await engine._onIdleChanged({ idle: false, idleSecs: 0 }); // vuelve
  await flush();
  assert(typeof engine._lastAttemptByType['return_from_break'] === 'number',
    'ausencia de 20 min → trigger return_from_break consultado');
  assert(engine._categoryStreakFired === false, 'al volver, la racha de enfoque se reinicia');
  engine.stop();
  restore();

  // 10b. Ausencia corta (< 15 min) → no trigger
  restore = stubLLM();
  engine = makeEngine();
  engine._onIdleChanged({ idle: true, idleSecs: 600 });    // ~10 min
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
  assert(!engine._lastAttemptByType['return_from_break'], 'idle:false sin idle previo → NO dispara');
  engine.stop();
  restore();
}

// ── Test 11: _checkSpecialDate (incl. fix QW-5) ─────────────────────────────

function testSpecialDate() {
  console.log(C.bold('\nTest 11: _checkSpecialDate'));

  // 11a. Cumpleaños hoy en texto → detectado como birthday
  let engine = makeEngine([{ type: 'User', content: 'Cumpleaños: 15 de junio' }]);
  let r = engine._checkSpecialDate(new Date(2026, 5, 15, 12));
  assert(r && r.type === 'special_date' && r.subtype === 'birthday',
    'cumpleaños "15 de junio" detectado el 15/6 (texto)', JSON.stringify(r));

  // 11b. Mismo nodo en otra fecha → no
  r = engine._checkSpecialDate(new Date(2026, 5, 20, 12));
  assert(r === null, 'el 20/6 no hay fecha especial');

  // 11c. FIX QW-5: fecha guardada "15/06/2000" (con ceros y año) → detectada
  engine = makeEngine([{ type: 'User', content: 'Aniversario: 15/06/2000' }]);
  r = engine._checkSpecialDate(new Date(2026, 5, 15, 12));
  assert(r && r.type === 'special_date', 'fecha "15/06/2000" detectada (fix QW-5)', JSON.stringify(r));

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
  const graph = new StateGraph(path.join(dir, 'march.db')).init();

  const sm = new SessionManager(graph, null);
  await sm.start(null);
  sm.addTurn('user', 'hola');
  sm.addTurn('march', 'encantada');
  const h = sm.getHistory();
  assert(h.length === 2 && typeof h[0].ts === 'number' && typeof h[1].ts === 'number',
    'addTurn guarda ts en cada turno');
  // Sin close() → simulamos un crash → la sesión queda reanudable
  const sm2 = new SessionManager(graph, null);
  const resumed = await sm2.start(null);
  assert(resumed.resumed === true && resumed.history.length === 2,
    'la sesión interrumpida se reanuda con su historial');
  assert(typeof resumed.history[0].ts === 'number', 'ts preservado tras el resume');
  await sm2.close().catch(() => {});

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
  await testStreakNotConsumedWhenBlocked();
  await testFollowup();
  await testSessionEnd();
  await testThrash();
  await testReturnFromBreak();
  testSpecialDate();
  testBehaviorUrgency();
  await testSessionTs();

  console.log(C.bold(`\nResultado: ${C.green(`${passed} ✓`)}${failed ? ` / ${C.red(`${failed} ✗`)}` : ''}`));
  process.exit(failed ? 1 : 0);
})().catch(e => {
  console.error(C.red('Fallo en la ejecución de la suite:'), e);
  process.exit(1);
});
