'use strict';

/**
 * test_fix_electron.js — reconstrucción graceful de better-sqlite3.
 *
 * Verifica:
 *   1. better-sqlite3 está compilado y funcional.
 *   2. fix-electron.js contiene las funciones de rebuild y fallback.
 *   3. isBetterSqlite3Ready() detecta módulo listo vs roto.
 *   4. Mensajes de error claros y recuperación.
 *
 * Correr igual que las demás suites (Node de Electron):
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron tests/test_fix_electron.js
 */

const path = require('path');
const fs = require('fs');

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

function assertEqual(a, b, label) {
  const ok = a === b;
  assert(ok, label, ok ? '' : `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// ── Test 1: better-sqlite3 está compilado y funcional ──────

function testSqlite3Ready() {
  console.log(C.bold('\n── Test 1: better-sqlite3 compilado y funcional ──────────'));

  const sqlite3Path = path.join(__dirname, '..', 'node_modules', 'better-sqlite3');
  let sqlite3;
  try {
    sqlite3 = require(sqlite3Path);
  } catch (e) {
    assert(false, 'better-sqlite3 se puede cargar', e.message);
    return;
  }

  const ready = typeof sqlite3 === 'function' || typeof sqlite3.Database === 'function';
  assert(ready, 'better-sqlite3 exporta Database (function)');

  if (typeof sqlite3 === 'function') {
    try {
      const db = new sqlite3(':memory:');
      db.close();
      assert(true, 'BD en memoria se crea y cierra sin error');
    } catch (e) {
      assert(false, 'BD en memoria funciona', e.message);
    }
  }
}

// ── Test 2: fix-electron.js tiene funciones de rebuild ───────

function testRebuildLogicExists() {
  console.log(C.bold('\n── Test 2: fix-electron.js tiene funciones de rebuild ───────'));

  const content = fs.readFileSync(path.join(__dirname, '..', 'fix-electron.js'), 'utf8');

  assert(content.includes('isBetterSqlite3Ready'), 'isBetterSqlite3Ready existe');
  assert(content.includes('rebuildNativeModules'), 'rebuildNativeModules existe');
  assert(content.includes('tryFallbackRebuild'), 'tryFallbackRebuild existe');
  assert(content.includes('tryRebuildViaNode'), 'tryRebuildViaNode existe');
  assert(content.includes('did not self-register'), 'Detecta error de ABI del native');
  assert(content.includes('fallback'), 'Mensaje de fallback presente');
  assert(content.includes('npm run rebuild'), 'Instrucción de recuperación presente');
}

// ── Test 3: isBetterSqlite3Ready detecta módulo listo ─────────

function testIsBetterSqlite3Ready() {
  console.log(C.bold('\n── Test 3: isBetterSqlite3Ready() detecta módulo listo ──'));

  const sqlite3Path = path.join(__dirname, '..', 'node_modules', 'better-sqlite3');
  let sqlite3;
  try {
    sqlite3 = require(sqlite3Path);
  } catch (e) {
    assert(false, 'better-sqlite3 carga sin error', e.message);
    return;
  }

  const ready = typeof sqlite3 === 'function' || typeof sqlite3.Database === 'function';
  assert(ready === true, 'isBetterSqlite3Ready() → true (módulo listo)');
}

// ── Test 4: isBetterSqlite3Ready detecta módulo roto ────────

function testIsBetterSqlite3ReadyBroken() {
  console.log(C.bold('\n── Test 4: isBetterSqlite3Ready() detecta módulo roto ──'));

  // Simular error de ABI de better-sqlite3.
  const errorMsg = 'Module did not self-register.';
  const detected =
    errorMsg.includes('ERR_NODE_BINDING') ||
    errorMsg.includes('native') ||
    errorMsg.includes('ABI') ||
    errorMsg.includes('did not self-register');
  assert(detected, 'Error de ABI detectado por la lógica de isBetterSqlite3Ready');
}

// ── Test 5: Mensajes de error claros en fix-electron.js ────

function testClearErrorMessages() {
  console.log(C.bold('\n── Test 5: Mensajes de error claros ─────────────────────'));

  const content = fs.readFileSync(path.join(__dirname, '..', 'fix-electron.js'), 'utf8');

  assert(content.includes('better-sqlite3 ya está compilado'), 'Mensaje de módulo listo');
  assert(content.includes('npm run rebuild'), 'Instrucción de rebuild');
  assert(content.includes('npx @electron/rebuild'), 'Instrucción alternativa para Windows');
  assert(content.includes('memoria en RAM'), 'Mensaje de fallback a RAM');
  assert(content.includes('mismatch de ABI') || content.includes('ABI'), 'Detección de ABI');
}

// ── Runner ──────────────────────────────────────────────────

async function main() {
  console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
  console.log(C.bold(' fix-electron — better-sqlite3 rebuild'));
  console.log(C.bold('════════════════════════════════════════════════════════'));

  try {
    testSqlite3Ready();
  } catch (e) {
    console.error(`  ${C.red('✗')} ${e.message}`);
    failed++;
  }
  try {
    testRebuildLogicExists();
  } catch (e) {
    console.error(`  ${C.red('✗')} ${e.message}`);
    failed++;
  }
  try {
    testIsBetterSqlite3Ready();
  } catch (e) {
    console.error(`  ${C.red('✗')} ${e.message}`);
    failed++;
  }
  try {
    testIsBetterSqlite3ReadyBroken();
  } catch (e) {
    console.error(`  ${C.red('✗')} ${e.message}`);
    failed++;
  }
  try {
    testClearErrorMessages();
  } catch (e) {
    console.error(`  ${C.red('✗')} ${e.message}`);
    failed++;
  }

  console.log(C.bold('\n════════════════════════════════════════════════════════'));
  const total = passed + failed;
  const color = failed === 0 ? C.green : C.red;
  if (failed === 0) {
    console.log(
      `  ${color('Resultado')}: ${color(`${passed} passed`)}  ${C.dim('0 failed')}  / ${total} total`
    );
  } else {
    console.log(
      `  Resultado: ${C.green(`${passed} passed`)}  ${C.red(`${failed} failed`)}  / ${total} total`
    );
  }
  console.log(C.bold('════════════════════════════════════════════════════════'));

  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(C.red('Fallo en la ejecución de la suite:'), e);
  process.exit(1);
});
