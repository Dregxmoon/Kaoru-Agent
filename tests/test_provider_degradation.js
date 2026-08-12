'use strict';

/**
 * test_provider_degradation.js — Fase 4a: memoria de degradación de providers.
 *
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron tests/test_provider_degradation.js
 *
 * Verifica:
 *   1. _rotationOrder: sin degradación → [primary, ...fallback].
 *   2. Marcar el primary degradado → el fallback pasa PRIMERO (no se martilla
 *      el provider en rate-limit en cada request).
 *   3. _isProviderDegraded: false para providers no marcados; expira y deja
 *      de considerar degradado.
 *   4. La marca dura al menos la base (60s) y se extiende con el retry-after.
 *   5. configure() con primary/fallback distintos respeta el orden.
 */

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

const LLMProvider = require('../core/llm/LLMProvider.js');

function resetDegradation() {
  LLMProvider._debug_degradedProviders.clear();
}

// ── Test 1: orden sin degradación ─────────────────────────────────────────────

function testRotationNormal() {
  console.log(C.bold('\n── Test 1: rotación normal (sin degradación) ────────────────'));

  LLMProvider.configure({ primary: 'groq', fallback: ['gemini', 'openai'] });
  resetDegradation();

  const order = LLMProvider._debug_rotationOrder();
  assert(
    order[0] === 'groq' && order[1] === 'gemini' && order[2] === 'openai',
    'orden = [primary, ...fallback]',
    order.join(', ')
  );
  assert(
    LLMProvider._debug_isProviderDegraded('groq') === false,
    'provider sin marcar → no degradado'
  );
}

// ── Test 2: primary degradado → fallback primero ─────────────────────────────

function testRotationDegradedPrimary() {
  console.log(C.bold('\n── Test 2: primary degradado → fallback pasa primero ────────'));

  LLMProvider.configure({ primary: 'groq', fallback: ['gemini', 'openai'] });
  resetDegradation();

  LLMProvider._debug_markProviderDegraded('groq', 'rate-limit', 50 * 60 * 1000); // 50 min
  assert(
    LLMProvider._debug_isProviderDegraded('groq') === true,
    'groq queda degradado tras un 429 con espera larga'
  );

  const order = LLMProvider._debug_rotationOrder();
  assert(
    order[0] === 'gemini' && order[1] === 'openai' && order[2] === 'groq',
    'el fallback va PRIMERO y el primary degradado al final',
    order.join(', ')
  );

  // La degradación NO afecta a otros providers.
  assert(LLMProvider._debug_isProviderDegraded('gemini') === false, 'gemini no se ve afectado');
}

// ── Test 3: expira y deja de estar degradado ─────────────────────────────────

function testDegradationExpires() {
  console.log(C.bold('\n── Test 3: la degradación expira ────────────────────────────'));

  LLMProvider.configure({ primary: 'groq', fallback: ['gemini'] });
  resetDegradation();

  // Simular una marca que ya venció (hace 1s).
  LLMProvider._debug_degradedProviders.set('groq', {
    until: Date.now() - 1000,
    reason: 'rate-limit',
  });
  assert(
    LLMProvider._debug_isProviderDegraded('groq') === false,
    'marca vencida → ya no degradado (y se limpia de la memoria)'
  );
  assert(
    LLMProvider._debug_degradedProviders.has('groq') === false,
    'el provider vencido se purga del mapa'
  );

  const order = LLMProvider._debug_rotationOrder();
  assert(order[0] === 'groq', 'tras expirar, el primary vuelve primero', order.join(', '));
}

// ── Test 4: duración de la marca (base + retry-after) ────────────────────────

function testMarkDuration() {
  console.log(C.bold('\n── Test 4: duración de la marca (base + retry-after) ────────'));

  LLMProvider.configure({ primary: 'groq', fallback: ['gemini'] });
  resetDegradation();

  // Sin retry-after: dura al menos la base (60s).
  const t0 = Date.now();
  LLMProvider._debug_markProviderDegraded('groq', 'rate-limit', 0);
  const entry = LLMProvider._debug_degradedProviders.get('groq');
  assert(
    entry && entry.until - t0 >= 60_000,
    'sin retry-after, la marca dura ≥ 60s',
    `hasta en ${Math.round((entry.until - t0) / 1000)}s`
  );
  resetDegradation();

  // Con retry-after largo: se extiende más allá de la base.
  const t1 = Date.now();
  LLMProvider._debug_markProviderDegraded('groq', 'rate-limit', 15_000);
  const entry2 = LLMProvider._debug_degradedProviders.get('groq');
  assert(
    entry2 && entry2.until - t1 >= 15_000,
    'el retry-after extiende la memoria de degradación',
    `hasta en ${Math.round((entry2.until - t1) / 1000)}s`
  );
}

// ── Test 5: fallback sin primary (solo fallback degradado) ───────────────────

function testDegradedFallback() {
  console.log(C.bold('\n── Test 5: un provider del fallback degradado ───────────────'));

  LLMProvider.configure({ primary: 'groq', fallback: ['gemini', 'openai'] });
  resetDegradation();

  LLMProvider._debug_markProviderDegraded('gemini', 'rate-limit', 30_000);
  const order = LLMProvider._debug_rotationOrder();
  assert(
    order[0] === 'groq' && order[1] === 'openai' && order[2] === 'gemini',
    'el fallback degradado se empuja al final, sin tocar el primary',
    order.join(', ')
  );
}

// ── Runner ───────────────────────────────────────────────────────────────────

function main() {
  console.log(C.bold(C.cyan('\nFase 4a — fallback de providers (memoria de degradación)')));

  testRotationNormal();
  testRotationDegradedPrimary();
  testDegradationExpires();
  testMarkDuration();
  testDegradedFallback();

  console.log(C.bold('\n════════════════════════════════════════════════════════'));
  const total = passed + failed;
  console.log(
    C.bold(
      `  Resultado: ${C.green(`${passed} passed`)}  ${failed > 0 ? C.red(`${failed} failed`) : C.dim('0 failed')}  / ${total} total`
    )
  );
  console.log(C.bold('════════════════════════════════════════════════════════\n'));

  if (failed > 0) process.exit(1);
}

main();
