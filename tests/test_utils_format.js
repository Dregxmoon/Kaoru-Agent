// @ts-nocheck
'use strict';
// test_utils_format.js — formatElapsed: segundos → texto humano corto.

const assert = require('assert');
let passed = 0;
const t = (c, m) => { assert(c, m); passed++; console.log('  ✓', m); };

const { formatElapsed } = require('../core/utils/format.js');

function main() {
  // Camino feliz: segundos crudos.
  t(formatElapsed(0) === '0s', '0 → "0s"');
  t(formatElapsed(45) === '45s', '45 → "45s"');
  t(formatElapsed(59) === '59s', '59 → "59s"');

  // Minutos.
  t(formatElapsed(60) === '1m', '60 → "1m"');
  t(formatElapsed(90) === '1m', '90 → "1m" (trunca)');
  t(formatElapsed(3599) === '59m', '3599 → "59m"');

  // Horas con y sin remanente.
  t(formatElapsed(3600) === '1h', '3600 → "1h" (sin remanente)');
  t(formatElapsed(3660) === '1h 1m', '3660 → "1h 1m"');
  t(formatElapsed(7320) === '2h 2m', '7320 → "2h 2m"');

  // Bordes: valores falsy caen al branch de segundos (comportamiento actual).
  t(formatElapsed(null) === 'nulls' || formatElapsed(null) === '0s', `null no lanza (${formatElapsed(null)})`);
  t(formatElapsed(undefined) !== undefined, 'undefined no lanza');

  console.log(`\nResultado: ${passed} passed`);
}

main();
