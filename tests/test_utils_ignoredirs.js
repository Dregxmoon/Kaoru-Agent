// @ts-nocheck
'use strict';
// test_utils_ignoredirs.js — lista central de carpetas ignoradas:
// dirSet (match por nombre) y dirRegexes (match en rutas completas).

const assert = require('assert');
let passed = 0;
const t = (c, m) => {
  assert(c, m);
  passed++;
  console.log('  ✓', m);
};

const { PROJECT_IGNORE_DIRS, dirSet, dirRegexes } = require('../core/utils/ignoreDirs.js');

function main() {
  // Catálogo base: siempre presentes.
  for (const d of ['node_modules', 'dist', 'build', '.next', '.cache', '__pycache__']) {
    t(PROJECT_IGNORE_DIRS.includes(d), `base incluye ${d}`);
  }

  // ── dirSet ──
  const set = dirSet();
  t(set instanceof Set, 'dirSet devuelve Set');
  t(set.has('node_modules') && set.has('.cache'), 'set incluye defaults');
  t(set.size === PROJECT_IGNORE_DIRS.length, 'sin extras → tamaño = base');

  const withExtras = dirSet(['vendor', '.git']);
  t(withExtras.has('vendor') && withExtras.has('.git'), 'extras incluidos');
  t(withExtras.size === PROJECT_IGNORE_DIRS.length + 2, 'tamaño = base + extras');

  // Borde: extras duplicados con base no duplican (Set).
  const duped = dirSet(['node_modules']);
  t(duped.size === PROJECT_IGNORE_DIRS.length, 'extra duplicado con base no suma');

  // Borde: extras vacíos repetidos son idempotentes.
  t(dirSet().size === dirSet().size, 'llamadas repetidas → mismo tamaño');

  // ── dirRegexes ──
  const regexes = dirRegexes(['vendor']);
  t(
    Array.isArray(regexes) && regexes.length === PROJECT_IGNORE_DIRS.length + 1,
    'una regex por carpeta (base+extras)'
  );

  // Match POSIX y Windows sobre rutas completas.
  const nodeRe = regexes[PROJECT_IGNORE_DIRS.indexOf('node_modules')];
  t(nodeRe.test('/home/x/proy/node_modules/lib/a.js'), 'match ruta POSIX node_modules/');
  t(nodeRe.test('C:\\proy\\node_modules\\lib\\a.js'), 'match ruta Windows node_modules\\');
  t(!nodeRe.test('/home/x/proy/src/a.js'), 'ruta limpia NO matchea');

  // Anclaje: match de SEGMENTO completo — "build" no debe pisar "builder/".
  const allRegexes = dirRegexes();
  const builderPath = '/x/builder/file.js';
  t(
    !allRegexes.some((r) => r.test(builderPath)),
    '"builder" no matchea la carpeta "build" (segmento exacto)'
  );

  // Extra se respeta también en regex.
  const vendorRe = dirRegexes(['vendor']).find((r) => /vendor/.test(String(r)));
  t(!!vendorRe && vendorRe.test('/p/vendor/lib.js'), 'extra "vendor" genera regex funcional');

  // Borde: raíz del disco no matchea (requiere separador después del nombre).
  t(!nodeRe.test('/node_modules'), "'/node_modules' sin slash final no matchea el segmento");
  t(
    dirRegexes().some((r) => r.test('/node_modules/')),
    "'/node_modules/' sí matchea"
  );

  console.log(`\nResultado: ${passed} passed`);
}

main();
