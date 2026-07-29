'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const C = {
  green:  (s) => `\x1b[32m${s}\x1b[0m`,
  red:    (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan:   (s) => `\x1b[36m${s}\x1b[0m`,
  bold:   (s) => `\x1b[1m${s}\x1b[0m`,
  dim:    (s) => `\x1b[2m${s}\x1b[0m`,
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

// ── Setup / Teardown ──────────────────────────────────────────────────────────

let tmpDir;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-test-'));
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ key: 'value' }), 'utf-8');
  return tmpDir;
}

function teardown() {
  if (tmpDir) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    tmpDir = null;
  }
}

// ── Mock LLM ──────────────────────────────────────────────────────────────────

function createMockLLM(responses) {
  let callCount = 0;
  const fn = async (messages, systemPrompt) => {
    if (callCount >= responses.length) {
      return 'Tarea completada.';
    }
    return responses[callCount++];
  };
  fn.callCount = () => callCount;
  fn.reset = () => { callCount = 0; };
  return fn;
}

// ── Mock Bridge (opera directo sobre FS para no depender de OpenClaw) ────────

function createMockBridge(projectCwd) {
  return {
    execute: async (tool, params) => {
      const t0 = Date.now();
      try {
        switch (tool) {
          case 'read': {
            const p = params.path;
            if (!fs.existsSync(p)) {
              return { ok: false, error: `File not found: ${p}`, result: null, tool, elapsed: Date.now() - t0 };
            }
            const content = fs.readFileSync(p, 'utf-8');
            return { ok: true, result: content, error: null, tool, elapsed: Date.now() - t0 };
          }
          case 'write':
          case 'create_file': {
            const p = params.path;
            const dir = path.dirname(p);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const content = params.content || `Archivo creado: ${path.basename(p)}`;
            fs.writeFileSync(p, content, 'utf-8');
            return { ok: true, result: `Written to ${p}`, error: null, tool, elapsed: Date.now() - t0 };
          }
          case 'exec':
          case 'run_command': {
            const cmd = params.command || '';
            return { ok: true, result: { stdout: `[mock] ${cmd} ejecutado`, stderr: '', exitCode: 0 }, error: null, tool, elapsed: Date.now() - t0 };
          }
          case 'edit':
          case 'edit_file': {
            const p = params.path;
            if (!fs.existsSync(p)) {
              return { ok: false, error: `File not found: ${p}`, result: null, tool, elapsed: Date.now() - t0 };
            }
            const content = fs.readFileSync(p, 'utf-8');
            const oldText = params.old_text || params.instruction || '';
            const newText = params.new_text || '';
            if (oldText && content.includes(oldText)) {
              const updated = content.replace(oldText, newText);
              fs.writeFileSync(p, updated, 'utf-8');
              return { ok: true, result: `Edited ${p}`, error: null, tool, elapsed: Date.now() - t0 };
            }
            return { ok: true, result: `File ${p} unchanged (no matching text)`, error: null, tool, elapsed: Date.now() - t0 };
          }
          default:
            return { ok: true, result: `[mock] ${tool} ejecutado`, error: null, tool, elapsed: Date.now() - t0 };
        }
      } catch (e) {
        return { ok: false, error: e.message, result: null, tool, elapsed: Date.now() - t0 };
      }
    },
  };
}

// ── Test 1: Loop termina en respuesta de texto ────────────────────────────────

async function testTextResponse() {
  console.log(C.bold('\n── Test 1: Loop termina en respuesta de texto ─────────────────'));

  const { AgentLoop } = require('../core/planner/AgentLoop.js');

  const mockLLM = createMockLLM([
    'El archivo config.json contiene una clave "key" con el valor "value".'
  ]);

  const loop = new AgentLoop({ maxIterations: 10, llm: mockLLM, bridge: createMockBridge('/tmp') });

  const result = await loop.run(
    '¿Qué hay en config.json?',
    'Eres un asistente útil.',
    [],
    {}
  );

  assert(result.iterations === 1, 'Termina en 1 iteración', `iteraciones: ${result.iterations}`);
  assert(!result.truncated, 'No está truncado');
  assert(!result.error, 'Sin error', `error: ${result.error}`);
  assert(result.response.includes('config.json'), 'Respuesta contiene el texto esperado', result.response.slice(0, 100));
}

// ── Test 2: Loop se adapta al resultado real (archivo no existe → create) ─────

async function testAdaptsToRealResult() {
  console.log(C.bold('\n── Test 2: Loop se adapta al resultado real de un paso ─────────'));

  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const AP = require('../core/planner/ActionParser.js');

  const projectCwd = setup();
  AP.setProjectCWD(projectCwd);

  const nonExistentPath = path.join(projectCwd, 'no-existe.json');

  const mockLLM = createMockLLM([
    `Revisando el archivo...
\`\`\`action
ACCIÓN: read_file | ARCHIVO: ${nonExistentPath}
\`\`\``,
    `El archivo no existe, lo creo.
\`\`\`action
ACCIÓN: create_file | ARCHIVO: ${path.join(projectCwd, 'nuevo.json')}
\`\`\``,
  ]);

  const loop = new AgentLoop({ maxIterations: 5, llm: mockLLM, bridge: createMockBridge(projectCwd) });

  const result = await loop.run(
    'crea config.json si no existe',
    'Eres un asistente que gestiona archivos.',
    [],
    { onApprovalNeeded: async () => true }
  );

  assert(result.iterations === 3, 'Ejecuta 3 iteraciones (read + create + texto final)', `iteraciones: ${result.iterations}`);
  assert(result.toolResults.length === 2, 'Dos herramientas ejecutadas', `tools: ${result.toolResults.length}`);

  const firstTool = result.toolResults[0];
  assert(firstTool.tool === 'read', 'Primera tool: read', `tool: ${firstTool.tool}`);
  assert(!firstTool.ok, 'Primera tool falla (archivo no existe)',
    firstTool.error ? firstTool.error.slice(0, 80) : '');

  const secondTool = result.toolResults[1];
  assert(secondTool.tool === 'write', 'Segunda tool: write (normalizado de create_file)',
    `tool: ${secondTool.tool} — verifica que el LLM adaptó su decisión al resultado real`);
  assert(secondTool.ok, 'Segunda tool tiene éxito', secondTool.error || '');

  const createdFile = path.join(projectCwd, 'nuevo.json');
  assert(fs.existsSync(createdFile), 'El archivo fue creado en disco');

  assert(!result.truncated, 'No está truncado');
  assert(!result.error, 'Sin error');

  teardown();
}

// ── Test 3: Límite de iteraciones ─────────────────────────────────────────────

async function testMaxIterations() {
  console.log(C.bold('\n── Test 3: Límite de iteraciones no es infinito ───────────────'));

  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const AP = require('../core/planner/ActionParser.js');

  const projectCwd = teardown() || setup();
  AP.setProjectCWD(projectCwd);

  // Mock LLM que SIEMPRE pide una herramienta (nunca texto final)
  const alwaysTool = `\`\`\`action
ACCIÓN: read_file | ARCHIVO: ${path.join(projectCwd, 'nonexistent.txt')}
\`\`\``;
  const mockLLM = createMockLLM([
    alwaysTool, alwaysTool, alwaysTool, alwaysTool, alwaysTool,
  ]);

  const loop = new AgentLoop({ maxIterations: 3, llm: mockLLM, bridge: createMockBridge(projectCwd) });

  const result = await loop.run(
    'ejecuta herramientas sin parar',
    'Eres un asistente.',
    [],
    {}
  );

  assert(result.truncated === true, 'Resultado marcado como truncado');
  assert(result.iterations <= 3, `Iteraciones respetan límite: ${result.iterations} <= 3`);
  assert(result.error === 'max_iterations_reached', `Error es max_iterations_reached`, `error: ${result.error}`);

  teardown();
}

// ── Test 4: Aprobación rechazada no rompe el loop ────────────────────────────

async function testApprovalRejected() {
  console.log(C.bold('\n── Test 4: Aprobación rechazada no rompe el loop ──────────────'));

  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const AP = require('../core/planner/ActionParser.js');

  const projectCwd = teardown() || setup();
  AP.setProjectCWD(projectCwd);
  const testFilePath = path.join(projectCwd, 'test-aprobacion.txt');

  let approvalCalls = 0;
  let rejectedTool = null;
  let approvedTool = null;

  const approvalHandler = async (step) => {
    approvalCalls++;
    if (step.tool === 'exec') {
      rejectedTool = step.tool;
      return false;
    }
    approvedTool = step.tool;
    return true;
  };

  const mockLLM = createMockLLM([
    `Voy a ejecutar esto.
\`\`\`action
ACCIÓN: run_command | COMANDO: rm -rf /
\`\`\``,
    `Ahora creo el archivo.
\`\`\`action
ACCIÓN: create_file | ARCHIVO: ${testFilePath}
\`\`\``,
  ]);

  const loop = new AgentLoop({ maxIterations: 5, llm: mockLLM, bridge: createMockBridge(projectCwd) });

  const result = await loop.run(
    'prueba de aprobación',
    'Eres un asistente.',
    [],
    { onApprovalNeeded: approvalHandler }
  );

  assert(approvalCalls === 1, 'Handler de aprobación llamado 1 vez (solo exec, write no requiere aprobación)', `veces: ${approvalCalls}`);
  assert(rejectedTool === 'exec', 'La primera tool (exec) fue rechazada');
  assert(approvedTool === null, 'write normalizado no requiere aprobación (path interno)');
  assert(result.toolResults.length === 1, 'Solo 1 herramienta ejecutada (write pasó directo)', `tools: ${result.toolResults.length}`);
  assert(result.toolResults[0].tool === 'write', 'La ejecutada es write (normalizado de create_file)');
  assert(result.toolResults[0].ok, 'write se ejecuta correctamente');
  assert(fs.existsSync(testFilePath), 'Archivo de prueba creado');

  teardown();
}

// ── Test 5: Sin callback de aprobación → fail closed ──────────────────────────

async function testNoApprovalCallback() {
  console.log(C.bold('\n── Test 5: Sin callback de aprobación → fail closed ────────────'));

  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const AP = require('../core/planner/ActionParser.js');

  const projectCwd = teardown() || setup();
  AP.setProjectCWD(projectCwd);
  const testFilePath = path.join(projectCwd, 'no-deberia-existir.txt');

  const mockLLM = createMockLLM([
    `Aplicando patch...
\`\`\`action
ACCIÓN: apply_patch | ARCHIVO: ${testFilePath}
\`\`\``,
    `Tarea completada.`,
  ]);

  const loop = new AgentLoop({ maxIterations: 5, llm: mockLLM, bridge: createMockBridge(projectCwd) });

  // Sin onApprovalNeeded → apply_patch es highImpact → fail closed
  const result = await loop.run(
    'aplica un patch',
    'Eres un asistente.',
    [],
    {} // sin onApprovalNeeded
  );

  assert(result.toolResults.length === 0, 'Ninguna herramienta se ejecutó (fail closed)',
    `tools: ${result.toolResults.length}`);
  assert(!fs.existsSync(testFilePath), 'El archivo NO fue creado (apply_patch bloqueado)');

  // El loop debió continuar y eventualmente terminar con texto normal
  assert(!result.truncated, 'No está truncado');
  assert(!result.error, 'Sin error');

  teardown();
}

// ── Test 6: Iteración ejecuta bridge real contra directorio temporal ──────────

async function testBridgeExecution() {
  console.log(C.bold('\n── Test 6: Bridge real contra directorio temporal ─────────────'));

  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const AP = require('../core/planner/ActionParser.js');
  const projectCwd = teardown() || setup();
  AP.setProjectCWD(projectCwd);

  // Crear archivo de prueba
  const testFile = path.join(projectCwd, 'prueba.txt');
  fs.writeFileSync(testFile, 'contenido de prueba', 'utf-8');

  const mockLLM = createMockLLM([
    `Leyendo archivo...
\`\`\`action
ACCIÓN: read_file | ARCHIVO: ${testFile}
\`\`\``,
    `El archivo contiene: contenido de prueba.`,
  ]);

  const loop = new AgentLoop({ maxIterations: 5, llm: mockLLM, bridge: createMockBridge(projectCwd) });

  const result = await loop.run(
    'lee el archivo de prueba',
    'Eres un asistente.',
    [],
    {}
  );

  assert(result.iterations === 2, '2 iteraciones (read + texto)');
  assert(result.toolResults.length === 1, '1 herramienta ejecutada');
  assert(result.toolResults[0].ok, 'read_file tuvo éxito');
  assert(result.toolResults[0].tool === 'read', 'Tool es read');

  // Verificar que el resultado incluye el contenido real
  const resultStr = typeof result.toolResults[0].result === 'string'
    ? result.toolResults[0].result
    : JSON.stringify(result.toolResults[0].result);
  assert(resultStr.includes('contenido de prueba'), 'Resultado contiene el contenido real del archivo',
    resultStr.slice(0, 100));

  teardown();
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
  console.log(C.bold(C.cyan('  March 7th — Test Suite: AgentLoop Fase 0')));
  console.log(C.bold(C.cyan('════════════════════════════════════════════════════════')));

  await testTextResponse();
  await testAdaptsToRealResult();
  await testMaxIterations();
  await testApprovalRejected();
  await testNoApprovalCallback();
  await testBridgeExecution();

  console.log(C.bold('\n════════════════════════════════════════════════════════'));
  const total = passed + failed;
  console.log(
    C.bold(`  Resultado: ${C.green(passed + ' passed')}  ${failed > 0 ? C.red(failed + ' failed') : C.dim('0 failed')}  / ${total} total`)
  );
  console.log(C.bold('════════════════════════════════════════════════════════\n'));

  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(C.red('\nERROR FATAL:'), e.message);
  console.error(e.stack);
  process.exit(1);
});
