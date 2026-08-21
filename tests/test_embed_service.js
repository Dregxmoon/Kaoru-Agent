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

// ── Test 6: worker muere tras haber cargado → recuperación vía child_process ─
// onnxruntime-node es NAPI single-load: si el worker llegó a 'ready' y luego
// muere, un worker_threads nuevo fallará (mismo proceso). Pero
// child_process.fork() crea un proceso OS separado donde SÍ se puede cargar
// el binding limpio. Este test verifica que EmbedService intenta la
// recuperación y que funciona cuando el child process carga exitosamente.

async function testChildProcessRecoveryAfterLoad() {
  console.log(C.bold('\n── Test 6: worker muere post-load → recuperación vía child_process ─'));

  const EmbedService = require('../core/grounding/EmbedService.js');
  const IntentDetector = require('../core/grounding/IntentDetector.js');

  EmbedService._debug_resetState();
  const origEmbed = IntentDetector.embedText;
  IntentDetector.embedText = async () => {
    throw new Error('NO debe usarse el main thread cuando hay child process');
  };

  let workerFactoryCalls = 0;
  EmbedService._debug_setWorkerFactory(() => {
    workerFactoryCalls++;
    return makeFakeWorker('readyThenExit');
  });

  let childFactoryCalls = 0;
  EmbedService._debug_setChildProcessFactory(() => {
    childFactoryCalls++;
    const { EventEmitter } = require('events');
    const c = new EventEmitter();
    c._alive = true;
    c.send = (msg) => {
      setImmediate(() => {
        if (!c._alive) return;
        c.emit('message', {
          type: 'result',
          id: msg.id,
          embedding: Array.from(new Float32Array(384)),
        });
      });
    };
    c.kill = () => { c._alive = false; };
    setImmediate(() => {
      if (c._alive) c.emit('message', { type: 'ready' });
    });
    return c;
  });

  try {
    // Worker carga (loadedOnce=true), responde una vez, luego muere.
    const v = await EmbedService.embedText('hola');
    assert(v instanceof Float32Array && v.length === 384, 'worker cargado responde normal');
    assert(
      EmbedService._debug_getState().loadedOnce === true,
      'loadedOnce = true tras el primer éxito'
    );

    // El worker muere → EmbedService inicia child process recovery.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert(
      EmbedService._debug_getState().workerAlive === false,
      'el worker quedó marcado como no vivo'
    );
    assert(
      EmbedService._debug_getState().childRecoveryCount === 1,
      'se intentó 1 child process recovery'
    );
    assert(childFactoryCalls === 1, 'child process factory fue invocado 1 vez');

    // Embedding posterior se resuelve via child process.
    const v2 = await EmbedService.embedText('otro');
    assert(
      v2 instanceof Float32Array && v2.length === 384,
      'embedText resuelve via child process tras recuperación'
    );
    assert(
      EmbedService._debug_getState().disabled === false,
      'servicio habilitado tras child process recovery exitoso'
    );
  } finally {
    IntentDetector.embedText = origEmbed;
    EmbedService._debug_resetState();
  }
}

// ── Test 7: 3 child process fallan → degradación permanente ───────────────────
// Si el worker muere post-load y TODOS los child process fallan al cargar
// onnxruntime, el servicio se degrada permanentemente.

async function testChildProcessRecoveryExhausted() {
  console.log(C.bold('\n── Test 7: 3 child process fallan → degradación permanente ───────'));

  const EmbedService = require('../core/grounding/EmbedService.js');
  const IntentDetector = require('../core/grounding/IntentDetector.js');

  EmbedService._debug_resetState();
  const origEmbed = IntentDetector.embedText;
  IntentDetector.embedText = async () => {
    throw new Error('NO debe usarse el main thread post-load');
  };

  EmbedService._debug_setWorkerFactory(() => makeFakeWorker('readyThenExit'));
  EmbedService._debug_setChildProcessBackoff(0);

  let childFactoryCalls = 0;
  EmbedService._debug_setChildProcessFactory(() => {
    childFactoryCalls++;
    const { EventEmitter } = require('events');
    const c = new EventEmitter();
    c.send = () => {};
    c.kill = () => {};
    // process.nextTick: emite DESPUÉS de que _forkChildProcess attachee
    // los listeners (c.on('message', ...)), pero ANTES del siguiente I/O.
    // Así el listener recibe el fatal.
    process.nextTick(() => {
      c.emit('message', { type: 'fatal', message: 'onnxruntime binding failed' });
    });
    return c;
  });

  try {
    // Worker carga y muere → inicia child process recovery.
    await EmbedService.embedText('hola');
    await new Promise((r) => setImmediate(r));
    assert(EmbedService._debug_getState().loadedOnce === true, 'loadedOnce = true');

    // Esperar a que los 3 child process fallen (nextTick + setImmediate cycles).
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));

    const st = EmbedService._debug_getState();
    assert(
      st.childRecoveryCount >= 3,
      `se intentaron ≥3 child processes (actual: ${st.childRecoveryCount})`
    );
    assert(
      childFactoryCalls >= 3,
      `child process factory invocado ≥3 veces (actual: ${childFactoryCalls})`
    );
    assert(
      st.disabled === true,
      'servicio deshabilitado tras agotar child process recovery'
    );

    // Intento posterior: lanza (degradación permanente).
    let threw = false;
    try {
      await EmbedService.embedText('otro');
    } catch (e) {
      threw = true;
      assert(
        /embeddings no disponibles|degradados/i.test(e.message),
        'error informa degradación permanente',
        e.message
      );
    }
    assert(threw === true, 'embedText lanza tras agotar child process recovery');
  } finally {
    IntentDetector.embedText = origEmbed;
    EmbedService._debug_resetState();
  }
}

// ── Test 8: child process recovery exitoso re-habilita el servicio ────────────
// Verifica que tras un child process exitoso, los contadores se resetean
// y el servicio funciona normalmente.

async function testChildProcessRecoveryResetsState() {
  console.log(C.bold('\n── Test 8: child process recovery exitoso resetea el estado ──────'));

  const EmbedService = require('../core/grounding/EmbedService.js');
  const IntentDetector = require('../core/grounding/IntentDetector.js');

  EmbedService._debug_resetState();
  const origEmbed = IntentDetector.embedText;
  IntentDetector.embedText = async () => {
    throw new Error('NO debe usarse el main thread');
  };

  // Primer worker: carga y muere.
  EmbedService._debug_setWorkerFactory(() => makeFakeWorker('readyThenExit'));

  let childCallCount = 0;
  EmbedService._debug_setChildProcessFactory(() => {
    childCallCount++;
    const { EventEmitter } = require('events');
    const c = new EventEmitter();
    c._alive = true;
    c.send = (msg) => {
      // Responde inmediatamente (sin esperar 'ready').
      setImmediate(() => {
        if (!c._alive) return;
        c.emit('message', {
          type: 'result',
          id: msg.id,
          embedding: Array.from(new Float32Array(384)),
        });
      });
    };
    c.kill = () => { c._alive = false; };
    // 'ready' se emite en process.nextTick: después de que _forkChildProcess
    // attachee listeners, pero antes del siguiente I/O.
    process.nextTick(() => {
      if (c._alive) c.emit('message', { type: 'ready' });
    });
    return c;
  });

  try {
    // Worker carga y muere.
    await EmbedService.embedText('hola');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert(
      EmbedService._debug_getState().childRecoveryCount === 1,
      '1 child process recovery en curso'
    );

    // Segundo embedding resuelve via child process.
    const v = await EmbedService.embedText('mundo');
    assert(v instanceof Float32Array, 'child process resuelve embedding');

    // Estado limpio: child recovery count se mantuvo (es acumulativo),
    // pero el servicio está habilitado y funcional.
    assert(
      EmbedService._debug_getState().disabled === false,
      'servicio habilitado tras child process recovery'
    );
    assert(
      EmbedService._debug_getState().workerAlive === false,
      'worker sigue muerto (solo child process está activo)'
    );
    assert(
      EmbedService._debug_getState().childAlive === true,
      'child process sigue vivo'
    );
    assert(childCallCount === 1, 'solo 1 child process fue necesario');
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
  await testChildProcessRecoveryAfterLoad();
  await testChildProcessRecoveryExhausted();
  await testChildProcessRecoveryResetsState();

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
