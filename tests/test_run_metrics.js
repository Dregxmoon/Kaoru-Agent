'use strict';

// Instrumentación por-run (AgentLoop): métricas de ejecución emitidas al final
// de CADA run (éxito, error o cancelación) vía _emitRunMetrics, persistiéndose
// en la telemetría local (TelemetryStore.recordAgentRun). El contrato de
// run() NO cambia: solo se agrega el campo extra `metrics` al resultado.
//
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron tests/test_run_metrics.js

const path = require('path');
const fs = require('fs');
const os = require('os');

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

// ── TelemetryStore.recordAgentRun: agregación por día ─────────────────────────

function testTelemetryRecordAgentRun() {
  console.log(C.bold('\n── TelemetryStore.recordAgentRun: agregación por día y resumen mensual ──'));

  const { TelemetryStore } = require('../core/telemetry/TelemetryStore.js');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-telemetry-'));
  let now = new Date(2026, 7, 10, 12, 0, 0).getTime(); // 2026-08-10
  const store = new TelemetryStore({
    filePath: path.join(tmpDir, 'telemetry.json'),
    now: () => now,
  });

  store.recordAgentRun({
    tool_calls_total: 3,
    errors_total: 1,
    approval_requests: 2,
    approvals_granted: 1,
    approvals_denied: 1,
    cancelled: false,
    duration_ms: 5000,
  });
  store.recordAgentRun({
    tool_calls_total: 1,
    errors_total: 0,
    approval_requests: 0,
    approvals_granted: 0,
    approvals_denied: 0,
    cancelled: false,
    duration_ms: 10000,
  });
  store.recordAgentRun({
    tool_calls_total: 0,
    errors_total: 0,
    approval_requests: 0,
    approvals_granted: 0,
    approvals_denied: 0,
    cancelled: true,
    duration_ms: 15000,
  });

  const m = store.monthSummary('2026-8');
  assert(m.agentRuns === 3, 'agentRuns === 3', `got=${m.agentRuns}`);
  assert(m.agentToolCalls === 4, 'agentToolCalls === 4 (3+1+0)', `got=${m.agentToolCalls}`);
  assert(m.agentErrors === 1, 'agentErrors === 1', `got=${m.agentErrors}`);
  assert(m.agentApprovalRequests === 2, 'agentApprovalRequests === 2', `got=${m.agentApprovalRequests}`);
  assert(m.agentApprovalsGranted === 1, 'agentApprovalsGranted === 1', `got=${m.agentApprovalsGranted}`);
  assert(m.agentApprovalsDenied === 1, 'agentApprovalsDenied === 1', `got=${m.agentApprovalsDenied}`);
  assert(m.agentCancelled === 1, 'agentCancelled === 1', `got=${m.agentCancelled}`);
  assert(m.avgRunDurationMs === 10000, 'avgRunDurationMs === 10000', `got=${m.avgRunDurationMs}`);
  assert(m.p50RunDurationMs === 10000, 'p50RunDurationMs === 10000', `got=${m.p50RunDurationMs}`);
  assert(m.p90RunDurationMs === 15000, 'p90RunDurationMs === 15000', `got=${m.p90RunDurationMs}`);

  // Los campos de turnos siguen intactos (la agregación es aditiva).
  assert(m.userMessages === 0 && m.sessions === 0, 'Turnos intactos (0) tras recordAgentRun');

  // Persistencia en disco: se guardó el JSON con el día.
  const persisted = JSON.parse(fs.readFileSync(path.join(tmpDir, 'telemetry.json'), 'utf-8'));
  const day = persisted.days['2026-8-10'];
  assert(day && day.agentRuns === 3, 'Persistido en disco (day.agentRuns === 3)');

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
}

// ── Loop: mocks (mismos helpers que test_verify_step) ─────────────────────────

function createRouterLLM({ main, resolution }) {
  let mainCount = 0;
  const fn = async (messages, system) => {
    const sys = system || '';
    if (sys.includes('editor de código experto')) return resolution;
    const next = main[mainCount++];
    return next === undefined ? 'Tarea completada.' : next;
  };
  fn.mainCalls = () => mainCount;
  return fn;
}

function createBridge(projectCwd) {
  const resolve = (p) => (path.isAbsolute(p) ? p : path.join(projectCwd, p));
  return {
    execute: async (tool, params) => {
      const t0 = Date.now();
      if (tool === 'read') {
        const p = resolve(params.path);
        return fs.existsSync(p)
          ? { ok: true, result: fs.readFileSync(p, 'utf-8'), error: null, tool, elapsed: Date.now() - t0 }
          : { ok: false, error: `File not found: ${p}`, result: null, tool, elapsed: Date.now() - t0 };
      }
      if (tool === 'edit') {
        const p = resolve(params.path);
        if (params.old_text && fs.existsSync(p) && fs.readFileSync(p, 'utf-8').includes(params.old_text)) {
          const content = fs.readFileSync(p, 'utf-8');
          fs.writeFileSync(p, content.replace(params.old_text, params.new_text), 'utf-8');
          return { ok: true, result: `Edited ${p}`, error: null, tool, elapsed: Date.now() - t0 };
        }
        return { ok: false, error: 'no_matching_text', result: null, tool, elapsed: Date.now() - t0 };
      }
      return { ok: true, result: `[mock] ${tool} ejecutado`, error: null, tool, elapsed: Date.now() - t0 };
    },
  };
}

const EDIT_BLOCK = (f) =>
  '```action\nACCIÓN: edit_file | ARCHIVO: ' + f + '\nCONTENIDO: cambia "x = 1" por "y = 1"\n```';
const CREATE_BLOCK = (f) =>
  '```action\nACCIÓN: create_file | ARCHIVO: ' + f + '\nCONTENIDO: hola\n```';

function setupTmp(prefix) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const AP = require('../core/planner/ActionParser.js');
  AP.setProjectCWD(tmpDir);
  return { tmpDir, AgentLoop, AP };
}

// ── Test 1: run exitoso → métricas completas y aditivas ───────────────────────

async function testMetricsSuccess() {
  console.log(C.bold('\n── Métricas: run exitoso (edit + cierre) ──────────────────────────────'));

  const { tmpDir, AgentLoop } = setupTmp('metrics-ok-');
  const f = path.join(tmpDir, 'src', 'demo.js');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, 'const x = 1;\n', 'utf-8');

  const mockLLM = createRouterLLM({
    main: [EDIT_BLOCK(f), 'Listo, corregí el typo.'],
    resolution: JSON.stringify({ old_text: 'const x = 1;', new_text: 'const y = 1;' }),
  });

  const loop = new AgentLoop({
    maxIterations: 5,
    mode: 'smart',
    llm: mockLLM,
    bridge: createBridge(tmpDir),
  });

  const result = await loop.run('edita src/demo.js', 'Eres un asistente.', [], {});

  // Contrato de run() intacto (campo extra, no rompe nada).
  assert(result.response && result.response.includes('corregí el typo'), 'run() sigue devolviendo response');
  assert(Array.isArray(result.toolResults), 'run() sigue devolviendo toolResults');

  const m = result.metrics;
  assert(!!m, 'result.metrics presente (campo adicional)');
  assert(m.iterations === 2, 'iterations === 2', `got=${m.iterations}`);
  assert(m.tool_calls_total === 1, 'tool_calls_total === 1', `got=${m.tool_calls_total}`);
  assert(m.tool_calls_by_type && m.tool_calls_by_type.edit === 1, 'tool_calls_by_type.edit === 1');
  assert(m.errors_total === 0, 'errors_total === 0', `got=${m.errors_total}`);
  assert(m.approval_requests === 0, 'approval_requests === 0 (edit dentro del proyecto)', `got=${m.approval_requests}`);
  assert(m.approvals_granted === 0 && m.approvals_denied === 0, 'sin aprobaciones');
  assert(m.cancelled === false, 'cancelled === false');
  assert(Number.isInteger(m.duration_ms) && m.duration_ms >= 0, 'duration_ms es un número (puede ser 0 en mocks)', `got=${m.duration_ms}`);
  assert(m.error === null, 'error === null');
  assert(fs.readFileSync(f, 'utf-8').includes('const y = 1;'), 'La mutación quedó aplicada');

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
}

// ── Test 2: run con error de tool → errors_total contado ──────────────────────

async function testMetricsToolError() {
  console.log(C.bold('\n── Métricas: run con falla real de tool (no_matching_text) ────────────'));

  const { tmpDir, AgentLoop } = setupTmp('metrics-err-');
  const f = path.join(tmpDir, 'src', 'demo.js');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, 'const x = 1;\n', 'utf-8');

  const mockLLM = createRouterLLM({
    main: [EDIT_BLOCK(f), 'No pude editar, no encontré el texto.'],
    // old_text inexistente → fallo real de la tool edit
    resolution: JSON.stringify({ old_text: 'const zzz = 9;', new_text: 'const y = 1;' }),
  });

  const loop = new AgentLoop({
    maxIterations: 5,
    mode: 'smart',
    llm: mockLLM,
    bridge: createBridge(tmpDir),
  });

  const result = await loop.run('edita src/demo.js', 'Eres un asistente.', [], {});

  const m = result.metrics;
  assert(m.errors_total === 1, 'errors_total === 1 (falla real, no bloqueo)', `got=${m.errors_total}`);
  assert(m.tool_calls_total === 1, 'tool_calls_total === 1', `got=${m.tool_calls_total}`);
  assert(m.cancelled === false, 'cancelled === false');
  assert(result.toolResults && result.toolResults.length === 1 && result.toolResults[0].ok === false, 'El fallo quedó en toolResults');

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
}

// ── Test 3: run cancelado (AbortController) → cancelled en métricas ───────────

async function testMetricsCancelled() {
  console.log(C.bold('\n── Métricas: run cancelado por el usuario (signal abortada) ────────────'));

  const { tmpDir, AgentLoop } = setupTmp('metrics-cancel-');

  const mockLLM = createRouterLLM({ main: [] });
  const loop = new AgentLoop({
    maxIterations: 5,
    mode: 'smart',
    llm: mockLLM,
    bridge: createBridge(tmpDir),
  });

  const ac = new AbortController();
  ac.abort();
  const result = await loop.run('tarea larga', 'Eres un asistente.', [], { signal: ac.signal });

  assert(result.cancelled === true, 'result.cancelled === true');
  const m = result.metrics;
  assert(m.cancelled === true, 'metrics.cancelled === true', `got=${m.cancelled}`);
  assert(m.iterations >= 1, 'iterations >= 1', `got=${m.iterations}`);
  assert(m.tool_calls_total === 0, 'tool_calls_total === 0 (no llegó a ejecutar tools)');
  assert(m.errors_total === 0, 'errors_total === 0');
  assert(Number.isInteger(m.duration_ms) && m.duration_ms >= 0, 'duration_ms es un número', `got=${m.duration_ms}`);

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
}

// ── Test 4: aprobaciones → granted / denied contadas ─────────────────────────

async function testMetricsApproval() {
  console.log(C.bold('\n── Métricas: aprobación de alto impacto (write fuera del proyecto) ─────'));

  const { tmpDir, AgentLoop } = setupTmp('metrics-appr-');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-out-'));
  const target = path.join(outside, 'note.txt');

  // 4a: aprobación concedida → granted
  const grantLLM = createRouterLLM({
    main: [CREATE_BLOCK(target), 'Listo, escribí el archivo.'],
  });
  let approvals = 0;
  const loopGrant = new AgentLoop({
    maxIterations: 5,
    mode: 'smart',
    llm: grantLLM,
    bridge: createBridge(tmpDir),
  });
  const resGrant = await loopGrant.run('escribe el archivo', 'Eres un asistente.', [], {
    onApprovalNeeded: async () => {
      approvals++;
      return true;
    },
  });
  const mg = resGrant.metrics;
  assert(approvals === 1, 'onApprovalNeeded invocada 1 vez', `got=${approvals}`);
  assert(mg.approval_requests === 1, 'approval_requests === 1', `got=${mg.approval_requests}`);
  assert(mg.approvals_granted === 1, 'approvals_granted === 1', `got=${mg.approvals_granted}`);
  assert(mg.approvals_denied === 0, 'approvals_denied === 0');
  assert(mg.tool_calls_total === 1, 'tool_calls_total === 1 (la write pedida)');
  assert(mg.errors_total === 0, 'errors_total === 0');

  // 4b: aprobación denegada → denied (no cuenta como error)
  const denyLLM = createRouterLLM({
    main: [CREATE_BLOCK(target), 'El usuario lo rechazó, continúo sin escribirlo.'],
  });
  const loopDeny = new AgentLoop({
    maxIterations: 5,
    mode: 'smart',
    llm: denyLLM,
    bridge: createBridge(tmpDir),
  });
  const resDeny = await loopDeny.run('escribe el archivo', 'Eres un asistente.', [], {
    onApprovalNeeded: async () => false,
  });
  const md = resDeny.metrics;
  assert(md.approval_requests === 1, 'denegada: approval_requests === 1', `got=${md.approval_requests}`);
  assert(md.approvals_granted === 0, 'denegada: approvals_granted === 0');
  assert(md.approvals_denied === 1, 'denegada: approvals_denied === 1', `got=${md.approvals_denied}`);
  assert(md.tool_calls_total === 1, 'denegada: tool_calls_total === 1 (igual fue pedida)');
  assert(md.errors_total === 0, 'denegada: errors_total === 0 (no es falla real)');
  assert(md.cancelled === false, 'denegada: cancelled === false (el run NO se cancela)');

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  } catch {}
}

async function main() {
  testTelemetryRecordAgentRun();
  await testMetricsSuccess();
  await testMetricsToolError();
  await testMetricsCancelled();
  await testMetricsApproval();

  console.log(C.bold('\n════════════════════════════════════════════════════════'));
  const total = passed + failed;
  console.log(
    C.bold(
      `  Resultado: ${C.green(passed + ' passed')}  ${failed > 0 ? C.red(failed + ' failed') : C.dim('0 failed')}  / ${total} total`
    )
  );
  console.log(C.bold('════════════════════════════════════════════════════════\n'));

  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(C.red('\nERROR FATAL:'), e.message);
  console.error(e.stack);
  process.exit(1);
});
