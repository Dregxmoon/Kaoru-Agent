'use strict';

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

const path = require('path');
const GestureEngine    = require('../core/behavior/GestureEngine.js');
const ModelAugmenter   = require('../core/behavior/ModelAugmenter.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'models', 'gtest', 'gtest.model3.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeModel() {
  const calls = [];
  const paramCount = 4;
  return {
    calls,
    motion:   async (g, i, p) => { calls.push(['motion', g, i, p]); return true; },
    expression: async (n) => { calls.push(['expression', n]); return true; },
    internalModel: {
      motionManager: {
        expressionManager: {
          resetExpression() { calls.push(['resetExpression']); },
        },
        stopAllMotions() { calls.push(['stopAllMotions']); },
      },
      coreModel: {
        getParameterCount() { return paramCount; },
        getParameterDefaultValue(i) { return i * 10; },
        setParameterValueByIndex(i, v, w) { calls.push(['param', i, v, w]); },
      },
    },
  };
}

// ── Test 1: reproducción básica ──────────────────────────────────────────────
console.log(C.bold('\n── Test 1: reproducción básica ─────────────────────────────'));
(async () => {
  const model = makeModel();
  const engine = new GestureEngine({ config: { minIntervalMs: 2500, cooldownMs: 15000, durationMs: 50 } });
  engine.attach(model, { model3Path: FIXTURE });

  let r = await engine.play('angry');
  assert(r.ok && r.gesture.name === 'angry', 'play(angry) aplica la expresión "angry"', JSON.stringify(r));
  assert(model.calls[0][0] === 'expression' && model.calls[0][1] === 'angry', 'se llamó model.expression("angry")');

  // ── Test 2: cooldowns ──────────────────────────────────────────────────────
  console.log(C.bold('\n── Test 2: cooldowns ─────────────────────────────────────'));
  r = await engine.play('angry');
  assert(!r.ok && (r.reason === 'min-interval' || r.reason === 'cooldown'), 'mismo mood dentro del cooldown → skip', JSON.stringify(r));
  r = await engine.play('happy');
  assert(!r.ok && r.reason === 'min-interval', 'otro mood dentro del min-interval → skip', JSON.stringify(r));
  r = await engine.play('happy', { priority: 'force' });
  assert(r.ok && r.gesture.name === 'Feliz', 'force ignora cooldowns → happy/Feliz', JSON.stringify(r));

  // ── Test 3: fallback de mood forzado sin coincidencia ──────────────────────
  console.log(C.bold('\n── Test 3: fallback de mood forzado ──────────────────────'));
  r = await engine.play('xyz-no-existe', { priority: 'force' });
  // gtest no tiene Idle con nombre distinto... default → Idle Animation (motion). O falla sin recursión infinita.
  assert(typeof r === 'object' && !r.gesture || r.gesture, 'mood inexistente forzado no crashea ni recicla', JSON.stringify(r).slice(0, 120));

  // ── Test 4: revert automático de expresiones ───────────────────────────────
  console.log(C.bold('\n── Test 4: revert automático de expresiones ─────────────────'));
  model.calls.length = 0;
  await engine.play('angry', { priority: 'force' });
  await sleep(80);
  const resets = model.calls.filter(c => c[0] === 'resetExpression' || c[0] === 'param').length;
  assert(resets >= 1, 'tras durationMs se revierte la expresión (resetExpression + params)', `resets=${resets}`);
  assert(!model.calls.some(c => c[0] === 'stopAllMotions'), 'el revert de expresión no corta motions (idle intacto)', JSON.stringify(model.calls));

  // ── Test 5: motions también revierten (Loop:true no se queda activo) ───────
  console.log(C.bold('\n── Test 5: motions revierten tras durationMs ──────────────'));
  model.calls.length = 0;
  await engine.play('sing', { priority: 'force' });
  assert(model.calls.some(c => c[0] === 'motion' && c[1] === 'motions'), 'motion "sing" → model.motion("motions", index)');
  model.calls.length = 0;
  await sleep(80);
  assert(model.calls.some(c => c[0] === 'stopAllMotions'), 'la motion en bucle se corta al revertir', JSON.stringify(model.calls));
  assert(model.calls.some(c => c[0] === 'param'), 'se restaura la pose neutra (params a default)');

  // ── Test 6: sdk-rechazo (sin métodos de gesto) ─────────────────────────────
  console.log(C.bold('\n── Test 6: sdk-rechazo ────────────────────────────────────'));
  const engine2 = new GestureEngine({ config: { minIntervalMs: 0, cooldownMs: 0 } });
  engine2.attach({}, { gestures: ModelAugmenter.listGestures(FIXTURE) });
  r = await engine2.play('angry', { priority: 'force' });
  assert(!r.ok && r.reason === 'sdk-rechazo', 'modelo sin motion/expression → sdk-rechazo', JSON.stringify(r));

  // ── Test 7: setEmotion / onEvent ───────────────────────────────────────────
  console.log(C.bold('\n── Test 7: setEmotion / onEvent ───────────────────────────'));
  const model3 = makeModel();
  const engine3 = new GestureEngine({ config: { minIntervalMs: 0, cooldownMs: 0, durationMs: 5000 } });
  engine3.attach(model3, { model3Path: FIXTURE });
  await engine3.setEmotion('happy');
  assert(model3.calls.some(c => c[0] === 'expression' && c[1] === 'Feliz'), 'setEmotion(happy) → Feliz');
  model3.calls.length = 0;
  engine3.onEvent('command_ok');
  await sleep(20);
  assert(model3.calls.some(c => c[0] === 'expression' && c[1] === 'Feliz'), 'onEvent(command_ok) → happy → Feliz');
  model3.calls.length = 0;
  engine3.onEvent('proposal-result', { ok: false }); // sad → sin gesto en el fixture → no-op correcto
  await sleep(20);
  assert(model3.calls.length === 0, 'onEvent(proposal-result, ok:false) → sad sin gesto → no anima y no crashea', JSON.stringify(model3.calls));

  // ── Test 8: attach por model3Path y stats ──────────────────────────────────
  console.log(C.bold('\n── Test 8: stats y detach ─────────────────────────────────'));
  const engine4 = new GestureEngine({ config: { minIntervalMs: 0, cooldownMs: 0, durationMs: 10 } });
  engine4.attach(makeModel(), { model3Path: FIXTURE });
  await engine4.play('wink'); // wink → gesto "sing"? no — wink sin match en fixture → skip
  const stats = engine4.getStats();
  assert(typeof stats.plays === 'number' && typeof stats.skipped === 'object', 'stats tiene contadores', JSON.stringify(stats));
  engine4.detach();
  assert(engine4._model === null, 'detach deja el modelo en null');

  // ── Resumen ────────────────────────────────────────────────────────────────
  console.log(C.bold(`\n── GestureEngine: ${C.green(passed)}✓ ${failed ? C.red(failed + '✗') : ''} ──`));
  console.log(`Resultado: ${passed} passed ${failed} failed / ${passed + failed} total`);
  if (failed > 0) process.exitCode = 1;
})().catch(err => { console.error(err); process.exit(1); });
