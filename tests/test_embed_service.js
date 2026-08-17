'use strict';

const { EventEmitter } = require('events');

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

/**
 * Worker fake (EventEmitter) que replica el protocolo de embedWorker.js:
 *   ready → result | fatal | error
 * Modos:
 *   'ok'           → ready, responde requests, sigue vivo
 *   'startError'   → error al arrancar (nunca 'ready')
 *   'fatal'        → mensaje fatal al arrancar (nunca 'ready')
 *   'readyThenExit'→ ready, responde una vez, luego emite 'exit' (simula un
 *                    worker que cargó onnxruntime y muere después)
 * @param {'ok' | 'startError' | 'fatal' | 'readyThenExit'} mode
 */
function makeFakeWorker(mode) {
  const w = new EventEmitter();
  w._terminated = false;
  w.unref = () => {};
  w.terminate = () => {
    w._terminated = true;
  };
  setImmediate(() => {
    if (mode === 'startError') {
      w.emit('error', new Error('Module did not self-register: /x/onnxruntime_binding.node'));
      return;
    }
    if (mode === 'fatal') {
      w.emit('message', { type: 'fatal', message: 'el embed worker falló al cargar el modelo' });
      return;
    }
    w.emit('message', { type: 'ready' });
  });
  let served = 0;
  w.postMessage = (msg) => {
    if (!msg || typeof msg.id !== 'number' || w._terminated) return;
    setImmediate(() => {
      w.emit('message', { type: 'result', id: msg.id, embedding: new Float32Array(384) });
      if (mode === 'readyThenExit' && ++served === 1) {
        // Simula que el worker muere justo después de la primera respuesta.
        // El servicio trata 'exit' como fallo establecido (ya llegó a 'ready').
        setImmediate(() => w.emit('exit'));
      }
    });
  };
  return w;
}

// ── Test 1: checkNativeBindings + remediación del binding ────────────────────

function testNativeBindingCheck() {
  console.log(C.bold('\n── Test 1: checkNativeBindings y remediación del binding ─────'));

  const EmbedService = require('../core/grounding/EmbedService.js');

  const res = EmbedService.checkNativeBindings();
  assert(typeof res.ok === 'boolean', 'checkNativeBindings devuelve { ok: boolean }');
  if (!res.ok) {
    assert(
      typeof res.hint === 'string' && res.hint.includes('onnxruntime-node'),
      'si el binding falla, la remediación menciona onnxruntime-node',
      res.error
    );
    assert(
      typeof res.hint === 'string' && /reinstal|npm (install|ci)/i.test(res.hint),
      'la remediación es reinstalar (no electron-rebuild)',
      res.hint
    );
  }

  const hintSelfRegister = EmbedService._debug_bindingHint(
    new Error('Module did not self-register: /proyecto/node_modules/onnxruntime_binding.node')
  );
  assert(!!hintSelfRegister, 'errores "did not self-register" reciben remediación');
  assert(
    !!hintSelfRegister && hintSelfRegister.includes('onnxruntime-node'),
    'la remediación apunta a onnxruntime-node'
  );
  assert(
    !!hintSelfRegister && /no uses electron-rebuild/i.test(hintSelfRegister),
    'la remediación advierte de NO usar electron-rebuild (NAPI)'
  );

  assert(
    EmbedService._debug_bindingHint(new Error('boom genérico')) === null,
    'errores no relacionados no reciben remediación de binding'
  );
}

// ── Test 2: worker sano — usa el worker, nunca cae a main thread ─────────────

async function testHealthyWorker() {
  console.log(C.bold('\n── Test 2: worker sano usa el worker, sin fallback a main ───────'));

  const EmbedService = require('../core/grounding/EmbedService.js');
  const IntentDetector = require('../core/grounding/IntentDetector.js');

  EmbedService._debug_resetState();
  EmbedService._debug_setWorkerFactory(() => makeFakeWorker('ok'));

  const origEmbed = IntentDetector.embedText;
  IntentDetector.embedText = async () => {
    throw new Error('NO debe usarse el main thread si el worker está sano');
  };

  try {
    const v = await EmbedService.embedText('hola mundo');
    assert(v instanceof Float32Array && v.length === 384, 'embedText devuelve Float32Array(384)');
    assert(
      EmbedService._debug_getState().consecutiveFailures === 0,
      'con worker sano no se acumulan fallos'
    );
    assert(EmbedService._debug_getState().disabled === false, 'el worker permanece habilitado');
  } catch (e) {
    assert(false, 'embedText no cayó a main thread con worker sano', e.message);
  } finally {
    IntentDetector.embedText = origEmbed;
    EmbedService._debug_resetState();
  }
}

// ── Test 3: 3 fallos → cooldown; dentro del cooldown no se intenta el worker ─

async function testDisableThenCooldown() {
  console.log(C.bold('\n── Test 3: 3 fallos deshabilitan el worker (cooldown) ─────────────'));

  const EmbedService = require('../core/grounding/EmbedService.js');
  const IntentDetector = require('../core/grounding/IntentDetector.js');

  EmbedService._debug_resetState();
  const origEmbed = IntentDetector.embedText;
  IntentDetector.embedText = async () => new Float32Array(384);

  let factoryCalls = 0;
  EmbedService._debug_setWorkerFactory(() => {
    factoryCalls++;
    return makeFakeWorker('startError');
  });

  try {
    for (let i = 0; i < 3; i++) {
      const v = await EmbedService.embedText(`intento ${i}`);
      assert(v instanceof Float32Array, `tras fallo ${i + 1} cae a main thread (no lanza)`);
    }
    const st = EmbedService._debug_getState();
    assert(st.consecutiveFailures >= 3, 'se acumularon 3 fallos');
    assert(st.disabled === true, 'worker deshabilitado (en cooldown)');

    const callsBeforeCooldown = factoryCalls;
    const v2 = await EmbedService.embedText('otro mensaje');
    assert(v2 instanceof Float32Array, 'dentro del cooldown responde por main thread');
    assert(
      factoryCalls === callsBeforeCooldown,
      'dentro del cooldown NO se vuelve a instanciar el worker'
    );
  } finally {
    IntentDetector.embedText = origEmbed;
    EmbedService._debug_resetState();
  }
}

// ── Test 4: tras el cooldown se reintenta el worker y se recupera la sesión ──

async function testRecoveryAfterCooldown() {
  console.log(C.bold('\n── Test 4: recuperación automática tras el cooldown ──────────────'));

  const EmbedService = require('../core/grounding/EmbedService.js');
  const IntentDetector = require('../core/grounding/IntentDetector.js');

  EmbedService._debug_resetState();
  const origEmbed = IntentDetector.embedText;
  IntentDetector.embedText = async () => new Float32Array(384);

  try {
    // cooldown ya expirado (-1ms) → la próxima llamada debe reintentar el worker
    EmbedService._debug_forceDisable(-1);
    assert(
      EmbedService._debug_getState().disabled === false,
      'cooldown expirado → habilitado para reintentar'
    );

    let factoryCalls = 0;
    EmbedService._debug_setWorkerFactory(() => {
      factoryCalls++;
      return makeFakeWorker('ok');
    });

    const v = await EmbedService.embedText('reintento');
    assert(v instanceof Float32Array && v.length === 384, 'el reintento resuelve por el worker');
    assert(factoryCalls === 1, 'el worker se instanció exactamente 1 vez tras el cooldown');
    assert(
      EmbedService._debug_getState().disabled === false &&
        EmbedService._debug_getState().consecutiveFailures === 0,
      'éxito del reintento re-habilita el worker y limpia los fallos'
    );
  } finally {
    IntentDetector.embedText = origEmbed;
    EmbedService._debug_resetState();
  }
}

// ── Test 5: warmup respeta cooldown y se recupera ────────────────────────────

async function testWarmupRespectsCooldown() {
  console.log(C.bold('\n── Test 5: warmup respeta cooldown y se recupera ─────────────────'));

  const EmbedService = require('../core/grounding/EmbedService.js');

  EmbedService._debug_resetState();

  // Dentro del cooldown, warmup no debe instanciar el worker.
  EmbedService._debug_forceDisable(600_000);
  let factoryCalls = 0;
  EmbedService._debug_setWorkerFactory(() => {
    factoryCalls++;
    return makeFakeWorker('ok');
  });
  const okDuringCooldown = await EmbedService.warmup();
  assert(okDuringCooldown === false, 'warmup dentro del cooldown devuelve false');
  assert(factoryCalls === 0, 'warmup dentro del cooldown no instancia el worker');

  // Cooldown expirado → warmup reintenta el worker.
  EmbedService._debug_forceDisable(-1);
  const okAfterCooldown = await EmbedService.warmup();
  assert(okAfterCooldown === true, 'warmup tras el cooldown reintenta y precalienta');
  assert(factoryCalls === 1, 'el worker se instanció tras el cooldown');

  EmbedService._debug_resetState();
}

// ── Test 6: worker muere tras haber cargado → degradación permanente ──────────
// onnxruntime-node es NAPI single-load: si el worker llegó a 'ready' y luego
// muere, NO se puede recrear (ni caer al main thread). El servicio se degrada
// de forma permanente: embedText lanza, no instancia un worker nuevo.

async function testPermanentDegradationAfterLoad() {
  console.log(C.bold('\n── Test 6: worker muerto post-load → degradación permanente ────────'));

  const EmbedService = require('../core/grounding/EmbedService.js');
  const IntentDetector = require('../core/grounding/IntentDetector.js');

  EmbedService._debug_resetState();
  const origEmbed = IntentDetector.embedText;
  IntentDetector.embedText = async () => {
    throw new Error('NO debe usarse el main thread tras un worker cargado (single-load NAPI)');
  };

  let factoryCalls = 0;
  EmbedService._debug_setWorkerFactory(() => {
    factoryCalls++;
    return makeFakeWorker('readyThenExit');
  });

  try {
    // Primera llamada: worker carga ('ready') y responde.
    const v = await EmbedService.embedText('hola');
    assert(v instanceof Float32Array && v.length === 384, 'worker cargado responde normal');
    assert(
      EmbedService._debug_getState().loadedOnce === true,
      'tras el primer éxito, loadedOnce = true (onnxruntime cargado)'
    );

    // El worker muere (evento 'exit' post-ready) → degradación permanente.
    await new Promise((r) => setImmediate(r));
    assert(
      EmbedService._debug_getState().workerAlive === false,
      'el worker quedó marcado como no vivo tras su terminación'
    );
    assert(
      EmbedService._debug_getState().disabled === true,
      'worker deshabilitado de forma permanente'
    );

    // Intento posterior: NO se instancia un worker nuevo y NO se cae a main.
    const callsBefore = factoryCalls;
    let threw = false;
    try {
      await EmbedService.embedText('otro');
    } catch (e) {
      threw = true;
      assert(
        /onnxruntime|embeddings no disponibles/i.test(e.message),
        'el error informa la causa (single-load NAPI)',
        e.message
      );
    }
    assert(threw === true, 'embedText lanza tras degradación permanente');
    assert(factoryCalls === callsBefore, 'NO se instancia un worker nuevo tras la degradación');
  } finally {
    IntentDetector.embedText = origEmbed;
    EmbedService._debug_resetState();
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
  console.log(C.bold(C.cyan('  EmbedService — worker, binding nativo y recuperación')));
  console.log(C.bold(C.cyan('════════════════════════════════════════════════════════')));

  testNativeBindingCheck();
  await testHealthyWorker();
  await testDisableThenCooldown();
  await testRecoveryAfterCooldown();
  await testWarmupRespectsCooldown();
  await testPermanentDegradationAfterLoad();

  console.log(C.bold('\n════════════════════════════════════════════════════════'));
  const total = passed + failed;
  console.log(
    C.bold(
      `  Resultado: ${C.green(passed + ' passed')}  ${failed > 0 ? C.red(failed + ' failed') : C.dim('0 failed')}  / ${total} total`
    )
  );
  console.log(C.bold('════════════════════════════════════════════════════════\n'));

  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(C.red('\nERROR FATAL:'), e.message);
  console.error(e.stack);
  process.exit(1);
});
