'use strict';

/**
 * test_openclaw_sandbox_visibility.js — visibilidad del estado del sandbox.
 *
 * Verifica que el estado de aislamiento de proceso (bwrap) que el
 * openclaw-server reporta en /health quede expuesto al renderer:
 *
 *   1. Bridge → getSandboxStatus(): captura `enabled`/`reason` del /health
 *      (mockeado con sandbox activo y desactivado).
 *   2. getOpenClawStatus() (canal 'openclaw-status'): mapea el estado a la
 *      forma que consume la UI (sandbox true/false/null + sandboxReason).
 *   3. /health sin el campo sandbox → null (sin aviso, compat. hacia atrás).
 *   4. Server real con OPENCLAW_SANDBOX=0 → sandboxEnabled() false y
 *      sandboxReason() informa el motivo (determinista en cualquier host).
 *
 * Correr igual que las demás suites (Node de Electron):
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron tests/test_openclaw_sandbox_visibility.js
 */

const http = require('http');

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
let skipped = 0;

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

// ── Helpers ─────────────────────────────────────────────────────────────────

// Stub HTTP que responde en /health con el estado de sandbox que queremos
// "mockear". Devuelve { port, close }.
function startStubHealth(healthBody) {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(healthBody));
      return;
    }
    res.writeHead(404);
    res.end('{}');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, close: () => server.close() });
    });
  });
}

function randomPort() {
  return 18789 + Math.floor(Math.random() * 5000);
}

// Bridge fresh + puerto del stub. Restauramos env y cache al terminar.
function freshBridgeFor(port) {
  delete require.cache[require.resolve('../core/planner/OpenClawBridge.js')];
  const prevPort = process.env.OPENCLAW_PORT;
  process.env.OPENCLAW_PORT = String(port);
  const bridge = require('../core/planner/OpenClawBridge.js').getOpenClawBridge();
  return { bridge, restore: () => (process.env.OPENCLAW_PORT = prevPort) };
}

// ── Test 1: sandbox habilitado (mockeado 'bwrap') ────────────────────────────

async function testSandboxEnabled() {
  console.log(C.bold('\n── sandbox habilitado (mock /health → bwrap) ─────────────'));

  const stub = await startStubHealth({ status: 'ok', sandbox: 'bwrap', sandboxReason: null });
  const { bridge, restore } = freshBridgeFor(stub.port);
  try {
    const available = await bridge.isAvailable(true);
    assert(available === true, 'bridge.isAvailable() → true');

    const sandbox = bridge.getSandboxStatus();
    assert(sandbox !== null, 'getSandboxStatus() informado (no null)');
    assertEqual(sandbox.enabled, true, 'sandbox.enabled === true');
    assertEqual(sandbox.reason, null, 'sandbox.reason === null (sin motivo)');
  } finally {
    restore();
    stub.close();
  }
}

// ── Test 2: sandbox desactivado (mockeado 'disabled' + motivo) ───────────────

async function testSandboxDisabled() {
  console.log(C.bold('\n── sandbox desactivado (mock /health → disabled) ─────────'));

  const stub = await startStubHealth({
    status: 'ok',
    sandbox: 'disabled',
    sandboxReason: 'bwrap no encontrado en PATH',
  });
  const { bridge, restore } = freshBridgeFor(stub.port);
  try {
    const available = await bridge.isAvailable(true);
    assert(available === true, 'bridge.isAvailable() → true (server sigue respondiendo)');

    const sandbox = bridge.getSandboxStatus();
    assert(sandbox !== null, 'getSandboxStatus() informado');
    assertEqual(sandbox.enabled, false, 'sandbox.enabled === false');
    assertEqual(sandbox.reason, 'bwrap no encontrado en PATH', 'sandbox.reason presente');
  } finally {
    restore();
    stub.close();
  }
}

// ── Test 3: /health sin el campo sandbox → null (sin aviso) ──────────────────

async function testSandboxUnknown() {
  console.log(C.bold('\n── /health sin campo sandbox → sin aviso ─────────────────'));

  const stub = await startStubHealth({ status: 'ok' });
  const { bridge, restore } = freshBridgeFor(stub.port);
  try {
    const available = await bridge.isAvailable(true);
    assert(available === true, 'bridge.isAvailable() → true');
    assertEqual(bridge.getSandboxStatus(), null, 'getSandboxStatus() === null (no mockea aviso)');
  } finally {
    restore();
    stub.close();
  }
}

// ── Test 4: getOpenClawStatus() (canal 'openclaw-status') con sandbox mockeado ─

async function testGetOpenClawStatus() {
  console.log(C.bold('\n── getOpenClawStatus(): forma que consume la UI ──────────'));

  const misc = require('../core/core/misc.js');
  const state = require('../core/core/state.js');
  const prevBridge = state.bridge;
  const prevPort = process.env.OPENCLAW_PORT;

  try {
    // Sandbox desactivado → la UI debe recibir sandbox:false + motivo.
    const stubOff = await startStubHealth({
      status: 'ok',
      sandbox: 'disabled',
      sandboxReason: 'bwrap no usable: error',
    });
    delete require.cache[require.resolve('../core/planner/OpenClawBridge.js')];
    process.env.OPENCLAW_PORT = String(stubOff.port);
    state.bridge = require('../core/planner/OpenClawBridge.js').getOpenClawBridge();
    let status = await misc.getOpenClawStatus();
    assertEqual(status.available, true, 'status.available === true');
    assertEqual(status.sandbox, false, 'status.sandbox === false (aviso UI)');
    assertEqual(status.sandboxReason, 'bwrap no usable: error', 'status.sandboxReason presente');
    stubOff.close();

    // Sandbox habilitado → sandbox:true, sin motivo.
    const stubOn = await startStubHealth({ status: 'ok', sandbox: 'bwrap', sandboxReason: null });
    delete require.cache[require.resolve('../core/planner/OpenClawBridge.js')];
    process.env.OPENCLAW_PORT = String(stubOn.port);
    state.bridge = require('../core/planner/OpenClawBridge.js').getOpenClawBridge();
    status = await misc.getOpenClawStatus();
    assertEqual(status.sandbox, true, 'status.sandbox === true (sin aviso UI)');
    assertEqual(status.sandboxReason, null, 'status.sandboxReason === null');
    stubOn.close();

    // Sin bridge → degradación segura.
    state.bridge = null;
    status = await misc.getOpenClawStatus();
    assertEqual(status.available, false, 'sin bridge → status.available === false');
    assertEqual(status.sandbox, null, 'sin bridge → status.sandbox === null');
  } finally {
    state.bridge = prevBridge;
    process.env.OPENCLAW_PORT = prevPort;
  }
}

// ── Test 5: server real con OPENCLAW_SANDBOX=0 → sandbox desactivado ─────────

async function testServerSandboxDisabled() {
  console.log(C.bold('\n── server real con OPENCLAW_SANDBOX=0 ────────────────────'));

  const prevEnv = process.env.OPENCLAW_SANDBOX;
  process.env.OPENCLAW_SANDBOX = '0';
  delete require.cache[require.resolve('../openclaw-server.js')];
  const srv = require('../openclaw-server.js');
  try {
    assert(
      typeof srv.sandboxEnabled === 'function' && typeof srv.sandboxReason === 'function',
      'openclaw-server exporta sandboxEnabled() y sandboxReason()'
    );
    assertEqual(srv.sandboxEnabled(), false, 'sandboxEnabled() === false con OPENCLAW_SANDBOX=0');
    assert(
      typeof srv.sandboxReason() === 'string' && srv.sandboxReason().length > 0,
      'sandboxReason() informa el motivo',
      String(srv.sandboxReason())
    );

    // /health real debe reflejarlo.
    const port = randomPort();
    await srv.startServer(port);
    const health = await new Promise((resolve, reject) => {
      const req = http.get({ hostname: '127.0.0.1', port, path: '/health' }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve(JSON.parse(data)));
      });
      req.on('error', reject);
    });
    assertEqual(health.status, 'ok', '/health → status ok');
    assertEqual(health.sandbox, 'disabled', '/health → sandbox "disabled"');
    assert(
      typeof health.sandboxReason === 'string' && health.sandboxReason.includes('OPENCLAW_SANDBOX'),
      '/health → sandboxReason refleja la desactivación por env',
      health.sandboxReason
    );
    await srv.stopServer();
  } finally {
    if (prevEnv === undefined) delete process.env.OPENCLAW_SANDBOX;
    else process.env.OPENCLAW_SANDBOX = prevEnv;
    delete require.cache[require.resolve('../openclaw-server.js')];
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
  console.log(C.bold(' openclaw sandbox visibility'));
  console.log(C.bold('════════════════════════════════════════════════════════'));

  try {
    await testSandboxEnabled();
  } catch (e) {
    console.error(`  ${C.red('✗')} sandbox habilitado falló: ${e.message}`);
    failed++;
  }
  try {
    await testSandboxDisabled();
  } catch (e) {
    console.error(`  ${C.red('✗')} sandbox desactivado falló: ${e.message}`);
    failed++;
  }
  try {
    await testSandboxUnknown();
  } catch (e) {
    console.error(`  ${C.red('✗')} sandbox desconocido falló: ${e.message}`);
    failed++;
  }
  try {
    await testGetOpenClawStatus();
  } catch (e) {
    console.error(`  ${C.red('✗')} getOpenClawStatus falló: ${e.message}`);
    failed++;
  }
  try {
    await testServerSandboxDisabled();
  } catch (e) {
    console.error(`  ${C.red('✗')} server OPENCLAW_SANDBOX=0 falló: ${e.message}`);
    failed++;
  }

  console.log(C.bold('\n════════════════════════════════════════════════════════'));
  const total = passed + failed + skipped;
  const color = failed === 0 ? C.green : C.red;
  const skipNote = skipped > 0 ? `  ${C.yellow(`${skipped} skipped`)}` : '';
  if (failed === 0) {
    console.log(
      `  ${color('Resultado')}: ${color(`${passed} passed`)}  ${C.dim(`0 failed`)}${skipNote}  / ${total} total`
    );
  } else {
    console.log(
      `  Resultado: ${C.green(`${passed} passed`)}  ${C.red(`${failed} failed`)}${skipNote}  / ${total} total`
    );
  }
  console.log(C.bold('════════════════════════════════════════════════════════'));

  if (failed > 0) process.exit(1);
}

main();
