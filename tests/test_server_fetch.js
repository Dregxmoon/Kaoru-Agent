'use strict';

/**
 * test_server_fetch.js — reemplazo de server-fetch por fetch() nativo.
 *
 * Verifica que:
 *   1. MCPManager.js usa fetch() de Node.js, no require('server-fetch').
 *   2. package.json no depende de server-fetch.
 *   3. Las llamadas al registro MCP usan AbortSignal.timeout().
 *   4. El catálogo de src/chat/mcp.js solo lista server-fetch como opción,
 *      sin importarlo ni dependender de él.
 *
 * Correr igual que las demás suites (Node de Electron):
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron tests/test_server_fetch.js
 */

const fs = require('fs');
const path = require('path');

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

// ── Test 1: package.json sin dependencia server-fetch ────────

function testNoServerFetchDep() {
  console.log(C.bold('\n── Test 1: package.json sin server-fetch ─────────────'));

  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

  assertEqual(allDeps['server-fetch'], undefined, 'server-fetch no es dependencia');
  assertEqual(allDeps['node-fetch'], undefined, 'node-fetch no es dependencia');
}

// ── Test 2: MCPManager.js usa fetch() nativo ────────────────

function testMCPManagerUsesFetch() {
  console.log(C.bold('\n── Test 2: MCPManager.js usa fetch() nativo ─────────'));

  const content = fs.readFileSync(
    path.join(__dirname, '..', 'core', 'mcp', 'MCPManager.js'),
    'utf8'
  );

  assert(content.includes('fetch('), 'Usa fetch()');
  assert(!content.includes("require('server-fetch')"), 'No requiere server-fetch');
  assert(!content.includes('require("server-fetch")'), 'No requiere server-fetch (doble)');
  assert(!content.includes("require('node-fetch')"), 'No requiere node-fetch');
  assert(content.includes('AbortSignal.timeout'), 'Usa AbortSignal.timeout para timeout');
}

// ── Test 3: fetch() con signal AbortSignal.timeout ──────────

function testFetchTimeout() {
  console.log(C.bold('\n── Test 3: fetch() con AbortSignal.timeout ───────────'));

  const content = fs.readFileSync(
    path.join(__dirname, '..', 'core', 'mcp', 'MCPManager.js'),
    'utf8'
  );
  const fetchMatches = content.match(/fetch\([^)]*AbortSignal\.timeout/g);
  assert(
    fetchMatches && fetchMatches.length >= 2,
    `Las 2 consultas públicas usan fetch con AbortSignal.timeout (${fetchMatches?.length || 0})`
  );
}

// ── Test 4: src/chat/mcp.js solo lista, no importa ──────────

function testCatalogOnly() {
  console.log(C.bold('\n── Test 4: Catálogo solo lista server-fetch ───────────'));

  const content = fs.readFileSync(path.join(__dirname, '..', 'src', 'chat', 'mcp.js'), 'utf8');

  // server-fetch aparece en el catálogo como opción disponible.
  assert(
    content.includes('@modelcontextprotocol/server-fetch'),
    'Catálogo incluye server-fetch como opción'
  );

  // Pero no lo importa ni lo requiere.
  assert(!content.includes("require('server-fetch')"), 'Catálogo no requiere server-fetch');
  assert(!content.includes('import'), 'Catálogo no usa import (CommonJS puro)');
}

// ── Test 5: fetch() es global de Node >= 18 ────────────────

function testFetchGlobal() {
  console.log(C.bold('\n── Test 5: fetch() disponible globalmente ────────────'));

  assert(typeof fetch === 'function', 'fetch() es función global');
  assert(typeof AbortSignal === 'function', 'AbortSignal es función global');
  assert(typeof AbortSignal.timeout === 'function', 'AbortSignal.timeout es función');
}

// ── Runner ──────────────────────────────────────────────────

async function main() {
  console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
  console.log(C.bold(' server-fetch replacement verification'));
  console.log(C.bold('════════════════════════════════════════════════════════'));

  try {
    testNoServerFetchDep();
  } catch (e) {
    console.error(`  ${C.red('✗')} ${e.message}`);
    failed++;
  }
  try {
    testMCPManagerUsesFetch();
  } catch (e) {
    console.error(`  ${C.red('✗')} ${e.message}`);
    failed++;
  }
  try {
    testFetchTimeout();
  } catch (e) {
    console.error(`  ${C.red('✗')} ${e.message}`);
    failed++;
  }
  try {
    testCatalogOnly();
  } catch (e) {
    console.error(`  ${C.red('✗')} ${e.message}`);
    failed++;
  }
  try {
    testFetchGlobal();
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
