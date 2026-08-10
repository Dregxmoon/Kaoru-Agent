'use strict';

// test_core_facade.js — Fase 2, ítem 5: Core.js es una fachada pura.
// Verifica que exponga SOLO funciones (API pública estable) y que delegue sin
// estado propio: los callers (main.js, bin/cli.js, ipc/*) consumen la misma
// superficie, no el Core monolítico de 1468 líneas que había antes.

const Core = require('../core/Core.js');

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
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

function main() {
  console.log(C.bold('\ntest_core_facade: Core.js como fachada'));

  assert(Core && typeof Core === 'object', 'Core se carga sin errores');

  const keys = Object.keys(Core).sort();
  assert(keys.length >= 30, `la API pública tiene >= 30 miembros (tiene ${keys.length})`);

  // Todas las exportaciones son funciones invocables (fachada, no estado).
  const nonFunctions = keys.filter((k) => typeof Core[k] !== 'function');
  assert(
    nonFunctions.length === 0,
    'todas las exportaciones son funciones',
    `no-función: ${nonFunctions.join(', ')}`
  );

  // Las exportaciones SON las de los módulos por dominio — la delegación real
  // vive en core/core/*.js, no reimplementada aquí.
  const delegated = [
    'init',
    'shutdown',
    'buildContext',
    'runAgent',
    'startSession',
    'closeSession',
    'mcpListServers',
    'permissionsSetRule',
    'setActiveWorkspace',
    'getGraph',
    'storeFact',
    'reloadLLMConfig',
  ];
  const missing = delegated.filter((k) => typeof Core[k] !== 'function');
  assert(missing.length === 0, 'expone los servicios por dominio', `faltan: ${missing.join(', ')}`);

  // La fachada NO expone internos del núcleo (estado mutable, singletons).
  const internals = keys.filter((k) => /state|_db|_instance|S\.|process/i.test(k));
  assert(
    internals.length === 0,
    'no filtra internos del núcleo (estado, singletons)',
    `internos: ${internals.join(', ')}`
  );

  // Los accesores se comportan como getters de servicios, sin romper si el
  // core no está inicializado (degradan a null, no lanzan).
  for (const k of ['getGraph', 'getPlanner', 'getBridge', 'getOSSensor', 'getEventBus']) {
    try {
      const v = Core[k]();
      assert(true, `${k}() es invocable sin init (degradación limpia)`);
      if (v !== null && v !== undefined) {
        // Si hay instancia, que sea el servicio correcto, no un boolean/string.
        assert(typeof v === 'object', `${k}() devuelve el servicio (objeto)`);
      }
    } catch (e) {
      assert(false, `${k}() no lanza sin init`, e.message);
    }
  }

  const total = passed + failed;
  console.log(C.bold('\n═══════════════════════════════════════════'));
  console.log(
    C.bold(
      `  Resultado: ${C.green(`${passed} passed`)}  ${failed > 0 ? C.red(`${failed} failed`) : C.dim('0 failed')}  / ${total} total`
    )
  );
  console.log(C.bold('═══════════════════════════════════════════\n'));
  process.exit(failed > 0 ? 1 : 0);
}

main();
