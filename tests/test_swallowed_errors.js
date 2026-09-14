'use strict';

// SwallowedErrors: contar catch silenciosos sin cambiar semántica.
// El contador nunca lanza, nunca bloquea y no tiene dependencias.

const { swallow, getStats, reset } = require('../core/observability/SwallowedErrors.js');

let passed = 0;
let failed = 0;

function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
    passed++;
  } else {
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

async function main() {
  console.log('\n── Conteo básico ──');
  reset();
  let stats = getStats();
  assert(stats.total === 0, 'empieza en cero');

  swallow('Modulo.funcion');
  swallow('Modulo.funcion');
  swallow('Otro.sitio');
  stats = getStats();
  assert(stats.total === 3, 'cuenta cada llamada');
  assert(stats.byScope.length === 2, 'agrega por scope');
  assert(
    stats.byScope[0][0] === 'Modulo.funcion' && stats.byScope[0][1] === 2,
    'ordena por frecuencia'
  );

  console.log('\n── Nunca rompe ──');
  let threw = false;
  try {
    swallow(null);
    swallow(undefined);
    swallow(123);
    swallow('');
    swallow('x'.repeat(500));
  } catch (_) {
    threw = true;
  }
  assert(!threw, 'scopes raros no lanzan');
  stats = getStats();
  assert(stats.total === 8, 'todo contó (incluidos raros)');

  console.log('\n── Tope anti-crecimiento ──');
  reset();
  for (let i = 0; i < 600; i++) swallow(`Dinamico.${i}`);
  stats = getStats();
  assert(stats.scopes <= 501, 'scopes acotados', `scopes: ${stats.scopes}`);
  assert(stats.total === 600, 'el total no se pierde');

  reset();
  assert(getStats().total === 0, 'reset limpia');

  console.log(`\nResultado: ${passed} passed  ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
