'use strict';

/**
 * test_health_metrics.js — punto de observabilidad.
 *
 * Verifica:
 *   1. getHealth() devuelve salud con sandbox, memoria y uptime.
 *   2. getReport() combina salud + uso LLM + requests/minuto.
 *   3. recordRequest / recordResponse rastrean requests activos.
 *   4. recordError() captura el último error.
 *   5. reset() limpia contadores.
 *   6. getUsageSummary() delega al tracker.
 *
 * Correr igual que las demás suites (Node de Electron):
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron tests/test_health_metrics.js
 */

const { HealthMetrics, getHealthMetrics } = require('../core/observability/HealthMetrics.js');
const { UsageTracker } = require('../core/observability/UsageTracker.js');

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

// ── Test 1: getHealth() básico ──────────────────────────────────

function testHealthBasic() {
  console.log(C.bold('\n── Test 1: getHealth() básico ──────────────────────────'));
  const hm = new HealthMetrics();
  const health = hm.getHealth();

  assertEqual(typeof health.healthy, 'boolean', 'healthy es boolean');
  assertEqual(typeof health.uptimeMs, 'number', 'uptimeMs es number');
  assert(health.uptimeMs >= 0, 'uptimeMs >= 0');
  assertEqual(typeof health.memoryMb, 'number', 'memoryMb es number');
  assert(health.memoryMb > 0, 'memoryMb > 0');
  assertEqual(typeof health.timestamp, 'string', 'timestamp es string');
  assertEqual(health.activeRequests, 0, 'activeRequests inicialmente 0');
  assertEqual(health.totalRequests, 0, 'totalRequests inicialmente 0');
  assertEqual(health.lastError, null, 'lastError inicialmente null');
  assertEqual(health.bridgeAvailable, null, 'bridgeAvailable null sin bridge');
  assertEqual(health.sandbox, null, 'sandbox null sin bridge');
}

// ── Test 2: getHealth() con bridge mockeado ────────────────────

function testHealthWithBridge() {
  console.log(C.bold('\n── Test 2: getHealth() con bridge mock ────────────────'));
  const mockBridge = {
    _available: true,
    getSandboxStatus() { return { enabled: true, reason: null }; },
  };
  const hm = new HealthMetrics({ bridge: mockBridge });
  const health = hm.getHealth();

  assertEqual(health.bridgeAvailable, true, 'bridgeAvailable === true');
  assert(health.sandbox !== null, 'sandbox informado');
  assertEqual(health.sandbox.enabled, true, 'sandbox.enabled === true');
  assertEqual(health.healthy, true, 'healthy === true con bridge up');
}

// ── Test 3: recordRequest / recordResponse ────────────────────

function testRequestTracking() {
  console.log(C.bold('\n── Test 3: recordRequest / recordResponse ───────────'));
  const hm = new HealthMetrics();

  hm.recordRequest('test-1');
  assertEqual(hm._activeRequests, 1, 'activeRequests = 1 tras recordRequest');
  assertEqual(hm._totalRequests, 1, 'totalRequests = 1');

  hm.recordRequest('test-2');
  assertEqual(hm._activeRequests, 2, 'activeRequests = 2');

  hm.recordResponse('test-1');
  assertEqual(hm._activeRequests, 1, 'activeRequests = 1 tras recordResponse');

  hm.recordResponse('test-2');
  assertEqual(hm._activeRequests, 0, 'activeRequests = 0 tras segundo recordResponse');
}

// ── Test 4: recordError ───────────────────────────────────────

function testRecordError() {
  console.log(C.bold('\n── Test 4: recordError() ────────────────────────────'));
  const hm = new HealthMetrics();

  hm.recordError('algo salió mal');
  assertEqual(hm._lastError, 'algo salió mal', 'lastError capturado');
  assert(hm._lastErrorTime > 0, 'lastErrorTime definido');
  assertEqual(hm.getHealth().healthy, true, 'healthy es true tras error (depende de bridge + requests)');
}

// ── Test 5: getReport() completo ──────────────────────────────

async function testReport() {
  console.log(C.bold('\n── Test 5: getReport() completo ──────────────────────'));
  const tracker = new UsageTracker(null);
  tracker.record({ provider: 'groq', model: 'llama', promptTokens: 100, completionTokens: 50 });
  tracker.record({ provider: 'groq', model: 'llama', promptTokens: 200, completionTokens: 100 });

  const hm = new HealthMetrics({ tracker });
  hm.recordRequest('query-1');
  const report = hm.getReport();

  assertEqual(report.health.bridgeAvailable, null, 'health.bridgeAvailable');
  assert(report.usage !== null, 'usage no es null');
  assertEqual(report.usage.totalRequests, 2, 'totalRequests = 2');
  assertEqual(report.usage.totalTokens, 450, 'totalTokens = 450 (100+50+200+100)');
  assertEqual(report.usage.totalCostUsd > 0, true, 'costUsd > 0');
  assertEqual(report.requestsPerMinute, 0, 'requestsPerMinute = 0 (ninguna en última hora)');
  assertEqual(report.errorsLastHour, 0, 'errorsLastHour = 0');
}

// ── Test 6: reset() ───────────────────────────────────────────

function testReset() {
  console.log(C.bold('\n── Test 6: reset() ───────────────────────────────────'));
  const hm = new HealthMetrics();
  hm.recordRequest('x');
  hm.recordError('boom');

  hm.reset();
  assertEqual(hm._activeRequests, 0, 'activeRequests = 0 tras reset');
  assertEqual(hm._lastError, null, 'lastError = null tras reset');
  assertEqual(hm._totalRequests, 0, 'totalRequests = 0 tras reset');
}

// ── Test 7: getUsageSummary() ─────────────────────────────────

function testUsageSummary() {
  console.log(C.bold('\n── Test 7: getUsageSummary() ────────────────────────'));
  const tracker = new UsageTracker(null);
  tracker.record({ provider: 'openai', model: 'gpt-4o-mini', promptTokens: 1000, completionTokens: 500 });

  const hm = new HealthMetrics({ tracker });
  const summary = hm.getUsageSummary();

  assert(summary !== null, 'summary no es null');
  assertEqual(summary.totalPromptTokens, 1000, 'totalPromptTokens = 1000');
  assertEqual(summary.totalCompletionTokens, 500, 'totalCompletionTokens = 500');
  assertEqual(summary.byProvider.openai !== undefined, true, 'byProvider.openai existe');
}

// ── Test 8: getHealth() sin tracker ───────────────────────────

function testNoTracker() {
  console.log(C.bold('\n── Test 8: getReport() sin tracker ───────────────────'));
  const hm = new HealthMetrics();
  const report = hm.getReport();

  assertEqual(report.usage, null, 'usage === null sin tracker');
}

// ── Test 9: singleton getHealthMetrics() ──────────────────────

function testSingleton() {
  console.log(C.bold('\n── Test 9: singleton getHealthMetrics() ────────────'));
  const a = getHealthMetrics();
  const b = getHealthMetrics();
  assert(a === b, 'getHealthMetrics() devuelve la misma instancia');
}

// ── Runner ────────────────────────────────────────────────────

async function main() {
  console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
  console.log(C.bold(' HealthMetrics observability point'));
  console.log(C.bold('════════════════════════════════════════════════════════'));

  try { testHealthBasic(); } catch (e) { console.error(`  ${C.red('✗')} ${e.message}`); failed++; }
  try { testHealthWithBridge(); } catch (e) { console.error(`  ${C.red('✗')} ${e.message}`); failed++; }
  try { testRequestTracking(); } catch (e) { console.error(`  ${C.red('✗')} ${e.message}`); failed++; }
  try { testRecordError(); } catch (e) { console.error(`  ${C.red('✗')} ${e.message}`); failed++; }
  try { await testReport(); } catch (e) { console.error(`  ${C.red('✗')} ${e.message}`); failed++; }
  try { testReset(); } catch (e) { console.error(`  ${C.red('✗')} ${e.message}`); failed++; }
  try { testUsageSummary(); } catch (e) { console.error(`  ${C.red('✗')} ${e.message}`); failed++; }
  try { testNoTracker(); } catch (e) { console.error(`  ${C.red('✗')} ${e.message}`); failed++; }
  try { testSingleton(); } catch (e) { console.error(`  ${C.red('✗')} ${e.message}`); failed++; }

  console.log(C.bold('\n════════════════════════════════════════════════════════'));
  const total = passed + failed;
  const color = failed === 0 ? C.green : C.red;
  if (failed === 0) {
    console.log(`  ${color('Resultado')}: ${color(`${passed} passed`)}  ${C.dim('0 failed')}  / ${total} total`);
  } else {
    console.log(`  Resultado: ${C.green(`${passed} passed`)}  ${C.red(`${failed} failed`)}  / ${total} total`);
  }
  console.log(C.bold('════════════════════════════════════════════════════════'));

  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(C.red('Fallo en la ejecución de la suite:'), e);
  process.exit(1);
});
