'use strict';

/**
 * test_windows_sandbox.js — soporte de sandbox en Windows.
 *
 * Verifica que el bridge refleje fielmente el estado AppContainer publicado
 * por el servidor y nunca invente un sandbox en el cliente:
 *
 *   1. /health con AppContainer devuelve { enabled: true, reason: null }.
 *   2. getSandboxStatus() refleja esa configuración.
 *   3. getOpenClawStatus() expone el estado y motivo exactos al renderer.
 *
 * Correr igual que las demás suites (Node de Electron):
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron tests/test_windows_sandbox.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WindowsSandbox } = require('../core/sandbox/WindowsSandbox.js');

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
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

// ── Helpers ─────────────────────────────────────────────────────────────

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

function restorePlatform(origPlatform) {
  Object.defineProperty(process, 'platform', { value: origPlatform });
}

function freshBridgeFor(port) {
  delete require.cache[require.resolve('../core/planner/OpenClawBridge.js')];
  const prevPort = process.env.OPENCLAW_PORT;
  process.env.OPENCLAW_PORT = String(port);
  // Force Windows platform in the module scope
  const prevPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  const bridge = require('../core/planner/OpenClawBridge.js').getOpenClawBridge();
  return {
    bridge,
    restore: () => {
      process.env.OPENCLAW_PORT = prevPort;
      Object.defineProperty(process, 'platform', { value: prevPlatform });
    },
  };
}

// ── Test 1: isAvailable() en Windows reporta AppContainer ───────────────

async function testWindowsSandboxEnabled() {
  console.log(C.bold('\n── Windows: isAvailable() reporta AppContainer activo ───────────'));

  const stub = await startStubHealth({ status: 'ok', sandbox: 'appcontainer' });
  const { bridge, restore } = freshBridgeFor(stub.port);
  try {
    const available = await bridge.isAvailable(true);
    assert(available === true, 'bridge.isAvailable() → true (server responde)');

    const sandbox = bridge.getSandboxStatus();
    assert(sandbox !== null, 'getSandboxStatus() informado (no null)');
    assertEqual(sandbox.enabled, true, 'sandbox.enabled === true');
    assertEqual(sandbox.reason, null, 'sandbox.reason === null');
  } finally {
    restore();
    stub.close();
  }
}

// ── Test 2: isAvailable() sin servidor → disponible false, sandbox null ──

async function testWindowsNoServer() {
  console.log(C.bold('\n── Windows: sin servidor → disponible false ────────────────────'));

  const { bridge, restore } = freshBridgeFor(randomPort());
  try {
    const available = await bridge.isAvailable(true);
    assert(available === false, 'bridge.isAvailable() → false (sin servidor)');
    assertEqual(bridge.getSandboxStatus(), null, 'getSandboxStatus() === null');
  } finally {
    restore();
  }
}

// ── Test 3: resetAvailabilityCache() limpia sandbox en Windows ──────────

async function testWindowsResetCache() {
  console.log(C.bold('\n── Windows: resetAvailabilityCache() limpia sandbox ────────────'));

  const stub = await startStubHealth({ status: 'ok', sandbox: 'appcontainer' });
  const { bridge, restore } = freshBridgeFor(stub.port);
  try {
    await bridge.isAvailable(true);
    const before = bridge.getSandboxStatus();
    assert(before !== null, 'sandbox informado antes del reset');

    bridge.resetAvailabilityCache();
    const after = bridge.getSandboxStatus();
    assertEqual(after, null, 'getSandboxStatus() === null después del reset');
  } finally {
    restore();
    stub.close();
  }
}

// ── Test 4: getOpenClawStatus() en Windows ──────────────────────────────

async function testWindowsGetOpenClawStatus() {
  console.log(C.bold('\n── Windows: getOpenClawStatus() sandbox:false + reason ────────'));

  const misc = require('../core/core/misc.js');
  const state = require('../core/core/state.js');
  const prevBridge = state.bridge;

  const stub = await startStubHealth({ status: 'ok', sandbox: 'appcontainer' });
  delete require.cache[require.resolve('../core/planner/OpenClawBridge.js')];
  const prevPort = process.env.OPENCLAW_PORT;
  process.env.OPENCLAW_PORT = String(stub.port);
  const prevPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  state.bridge = require('../core/planner/OpenClawBridge.js').getOpenClawBridge();

  try {
    const status = await misc.getOpenClawStatus();
    assertEqual(status.available, true, 'status.available === true');
    assertEqual(status.sandbox, true, 'status.sandbox === true');
    assertEqual(status.sandboxReason, null, 'status.sandboxReason === null');
  } finally {
    state.bridge = prevBridge;
    process.env.OPENCLAW_PORT = prevPort;
    Object.defineProperty(process, 'platform', { value: prevPlatform });
    stub.close();
  }
}

// ── Test 5: isAvailable() con servidor respondiendo pero sin sandbox ────

async function testWindowsServerResponding() {
  console.log(C.bold('\n── Windows: AppContainer no disponible ───────────────────────'));

  const stub = await startStubHealth({
    status: 'ok',
    sandbox: 'disabled',
    sandboxReason: 'AppContainer self-test failed',
  });
  const { bridge, restore } = freshBridgeFor(stub.port);
  try {
    await bridge.isAvailable(true);
    const sandbox = bridge.getSandboxStatus();
    assert(sandbox !== null, 'getSandboxStatus() informado');
    assertEqual(sandbox.enabled, false, 'sandbox.enabled === false');
    assertEqual(
      sandbox.reason,
      'AppContainer self-test failed',
      'reason conserva el fallo del servidor'
    );
  } finally {
    restore();
    stub.close();
  }
}

// ── Test 6: el launcher falla cerrado y conserva argv sin shell ─────────────

function testWindowsLauncherFailClosed() {
  console.log(C.bold('\n── Windows: launcher AppContainer fail-closed ─────────────────'));
  const cwd = path.resolve('/tmp/kaoru-win-sandbox-workspace');
  const sandbox = new WindowsSandbox({ platform: 'win32', cwd, cacheDir: '/tmp/kaoru-win-cache' });

  let rejected = false;
  try {
    sandbox.wrap(['cmd.exe', '/c', 'echo unsafe']);
  } catch (error) {
    rejected = String(error.message).includes('no disponible');
  }
  assert(rejected, 'no ejecuta directamente cuando AppContainer no está listo');

  sandbox._enabled = true;
  const wrapped = sandbox.wrap(['cmd.exe', '/d', '/s', '/c', 'echo "hola mundo"'], {
    cwd,
    timeout: 1234,
  });
  assert(wrapped[0].endsWith('Kaoru.WindowsSandbox.exe'), 'usa el helper nativo');
  assertEqual(wrapped[wrapped.indexOf('--timeout') + 1], '1234', 'propaga timeout');
  const separator = wrapped.indexOf('--');
  const decoded = wrapped
    .slice(separator + 1)
    .map((arg) => Buffer.from(arg, 'base64').toString('utf8'));
  assertEqual(decoded.join('|'), 'cmd.exe|/d|/s|/c|echo "hola mundo"', 'argv viaja en base64');

  let outsideRejected = false;
  try {
    sandbox.wrap(['cmd.exe'], { cwd: path.resolve('/tmp/fuera') });
  } catch (error) {
    outsideRejected = String(error.message).includes('fuera del workspace');
  }
  assert(outsideRejected, 'rechaza cwd fuera del workspace');
}

// ── Test 7: el helper usa fronteras nativas, no un wrapper cosmético ────────

function testNativeAppContainerHelper() {
  console.log(C.bold('\n── Windows: helper nativo AppContainer ────────────────────────'));
  const helper = fs.readFileSync(
    path.join(__dirname, '..', 'core', 'sandbox', 'compile-windows-sandbox.ps1'),
    'utf8'
  );
  const server = fs.readFileSync(path.join(__dirname, '..', 'openclaw-server.js'), 'utf8');

  assert(helper.includes('CreateAppContainerProfile'), 'crea un perfil AppContainer');
  assert(
    helper.includes('PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES'),
    'lanza con token AppContainer'
  );
  assert(helper.includes('GrantWorkspaceAccess'), 'ACL explícita para el workspace');
  assert(
    helper.includes('JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE'),
    'Job Object contiene descendientes'
  );
  assert(helper.includes('CREATE_SUSPENDED'), 'asigna el Job Object antes de ejecutar');
  assert(!helper.includes('internetClient'), 'red denegada por defecto');
  assert(
    server.includes("_sandboxKind = enabled ? 'appcontainer'"),
    '/health identifica AppContainer'
  );
  assert(
    server.includes('_windowsSandbox.wrap(commandArgs'),
    'el servidor conecta ejecución al helper'
  );
}

// ── Runner ──────────────────────────────────────────────────────────────

async function main() {
  const origPlatform = process.platform;
  console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
  console.log(C.bold(' Windows sandbox support'));
  console.log(C.bold('════════════════════════════════════════════════════════'));

  try {
    await testWindowsSandboxEnabled();
  } catch (e) {
    console.error(`  ${C.red('✗')} testWindowsSandboxEnabled falló: ${e.message}`);
    failed++;
  }
  try {
    await testWindowsNoServer();
  } catch (e) {
    console.error(`  ${C.red('✗')} testWindowsNoServer falló: ${e.message}`);
    failed++;
  }
  try {
    await testWindowsResetCache();
  } catch (e) {
    console.error(`  ${C.red('✗')} testWindowsResetCache falló: ${e.message}`);
    failed++;
  }
  try {
    await testWindowsGetOpenClawStatus();
  } catch (e) {
    console.error(`  ${C.red('✗')} testWindowsGetOpenClawStatus falló: ${e.message}`);
    failed++;
  }
  try {
    await testWindowsServerResponding();
  } catch (e) {
    console.error(`  ${C.red('✗')} testWindowsServerResponding falló: ${e.message}`);
    failed++;
  }
  try {
    testWindowsLauncherFailClosed();
  } catch (e) {
    console.error(`  ${C.red('✗')} testWindowsLauncherFailClosed falló: ${e.message}`);
    failed++;
  }
  try {
    testNativeAppContainerHelper();
  } catch (e) {
    console.error(`  ${C.red('✗')} testNativeAppContainerHelper falló: ${e.message}`);
    failed++;
  }

  restorePlatform(origPlatform);

  console.log(C.bold('\n════════════════════════════════════════════════════════'));
  const total = passed + failed;
  const color = failed === 0 ? C.green : C.red;
  if (failed === 0) {
    console.log(
      `  ${color('Resultado')}: ${color(`${passed} passed`)}  ${C.dim(`0 failed`)}  / ${total} total`
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
