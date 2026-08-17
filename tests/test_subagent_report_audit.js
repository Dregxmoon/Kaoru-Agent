'use strict';

/**
 * test_subagent_report_audit.js — auditoría del reporte de subagentes.
 *
 * Cuando un subagente (AgentLoop anidado vía _executeSubagent) edita/crea
 * archivos, el agente principal recibe su resumen de texto como confiable. Este
 * test verifica que:
 *
 *   1. El subagente reporta correctamente lo que hizo → NO hay nota de
 *      discrepancia (result.discrepancyNote ausente, response intacto).
 *   2. El resumen del subagente no coincide con sus toolResults reales
 *      (menciona archivos que no tocó y/o omite los que sí tocó) → la nota de
 *      discrepancia queda anexada al resultado que ve el agente principal.
 *   3. Subagente que edita pero entrega un resumen que no menciona NADA de lo
 *      que tocó → nota (cambió archivos que no menciona).
 *
 * Los "toolResults reales" son los del subagente anidado (no se parsea el
 * resumen de texto para saber qué tocó).
 *
 * Correr igual que las demás suites (Node de Electron):
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron tests/test_subagent_report_audit.js
 */

const fs = require('fs');
const os = require('os');
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

// ── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-audit-'));
  return tmpDir;
}

function teardown() {
  if (tmpDir) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
    tmpDir = null;
  }
}

// Bridge que ejecuta write de verdad sobre FS (igual que la mock de
// test_agent_loop, mínima: write/read).
function createWriteBridge() {
  return {
    execute: async (tool, params) => {
      const p = params.path;
      if (tool === 'write') {
        if (!p) {
          return { ok: false, error: 'path requerido', result: null, tool, elapsed: 0 };
        }
        fs.writeFileSync(p, params.content || `contenido de ${path.basename(p)}`, 'utf-8');
        return { ok: true, result: `Escrito ${p}`, error: null, tool, elapsed: 0 };
      }
      if (tool === 'read') {
        return fs.existsSync(p)
          ? { ok: true, result: fs.readFileSync(p, 'utf-8'), error: null, tool, elapsed: 0 }
          : { ok: false, error: `not found ${p}`, result: null, tool, elapsed: 0 };
      }
      return { ok: false, error: `tool ${tool} no soportada`, result: null, tool, elapsed: 0 };
    },
  };
}

function actionBlock(action, filePath) {
  return `Voy a ${action}.
\`\`\`action
ACCIÓN: ${action} | ARCHIVO: ${filePath}
\`\`\``;
}

// LLM del subagente anidado: [accion(es), resumen final].
function createSubagentLLM(responses) {
  let calls = 0;
  const fn = async () => {
    if (calls >= responses.length) return 'Terminado.';
    return responses[calls++];
  };
  fn.callCount = () => calls;
  return fn;
}

function runSubagent({ llm, task, projectCwd }) {
  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const AP = require('../core/planner/ActionParser.js');
  AP.setProjectCWD(projectCwd);
  const loop = new AgentLoop({ maxIterations: 6, llm, bridge: createWriteBridge() });
  return loop._executeSubagent({ tool: 'subagent', params: { task: task || 'haz la tarea' } });
}

// ── Test 1: reporte correcto → sin nota ──────────────────────────────────────

async function testCorrectReport() {
  console.log(C.bold('\n── Test 1: subagente reporta bien lo que hizo → sin nota ───────'));

  const dir = setup();
  const target = path.join(dir, 'helpers.js');
  const llm = createSubagentLLM([
    actionBlock('write', target),
    // Resumen correcto y con redacción neutral (nombres sin prefijos de verbo
    // de edición para no disparar el parser legacy).
    `Resumen: tarea completa, el archivo helpers.js quedó listo con la lógica nueva.`,
  ]);

  const result = await runSubagent({ llm, projectCwd: dir });

  assert(result.ok, 'subagente ejecutado con éxito', result.error || '');
  assert(
    result.result.discrepancyNote === undefined,
    'NO hay nota de discrepancia',
    JSON.stringify(result.result.discrepancyNote)
  );
  assert(
    result.result.response.includes('helpers.js'),
    'respuesta intacta (menciona el archivo que tocó)',
    result.result.response.slice(0, 80)
  );
  assert(!result.result.response.includes('Discrepancia'), 'respuesta sin texto de discrepancia');

  teardown();
}

// ── Test 2: resumen que no coincide con toolResults → nota ──────────────────

async function testMismatchedReport() {
  console.log(C.bold('\n── Test 2: resumen no coincide → nota de discrepancia ───────────'));

  const dir = setup();
  const target = path.join(dir, 'a.js');
  const llm = createSubagentLLM([
    actionBlock('write', target),
    // Menciona b.js (que NO tocó) y NO menciona a.js (que sí tocó).
    `Cambié el contenido de b.js para arreglar el bug. Listo.`,
  ]);

  const result = await runSubagent({ llm, projectCwd: dir });

  assert(result.ok, 'subagente ejecutado con éxito', result.error || '');
  const note = result.result.discrepancyNote;
  assert(note !== undefined, 'nota de discrepancia presente', JSON.stringify(note));
  assert(
    Array.isArray(note.changedNotMentioned) && note.changedNotMentioned.includes('a.js'),
    'cambió a.js que NO menciona (presente en changedNotMentioned)',
    JSON.stringify(note.changedNotMentioned)
  );
  assert(
    Array.isArray(note.mentionedNotChanged) && note.mentionedNotChanged.includes('b.js'),
    'menciona b.js que NO está en sus ediciones reales',
    JSON.stringify(note.mentionedNotChanged)
  );
  assert(
    result.result.response.includes('Discrepancia'),
    'el resumen que ve el padre incluye la nota',
    result.result.response.slice(0, 120)
  );

  teardown();
}

// ── Test 3: editó pero el resumen no menciona nada → nota ────────────────────

async function testSilentReport() {
  console.log(C.bold('\n── Test 3: editó pero resumen no menciona lo que tocó → nota ─────'));

  const dir = setup();
  const target = path.join(dir, 'oculto.py');
  const llm = createSubagentLLM([actionBlock('write', target), 'Listo, ya terminé con la tarea.']);

  const result = await runSubagent({ llm, projectCwd: dir });

  assert(result.ok, 'subagente ejecutado con éxito', result.error || '');
  const note = result.result.discrepancyNote;
  assert(note !== undefined, 'nota de discrepancia presente', JSON.stringify(note));
  assert(
    note.changedNotMentioned.includes('oculto.py'),
    'oculto.py (tocado, sin mencionar) en changedNotMentioned',
    JSON.stringify(note.changedNotMentioned)
  );
  assert(
    result.result.response.includes('oculto.py'),
    'la nota señala el archivo omitido al agente principal'
  );

  teardown();
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
  console.log(C.bold(' subagent report audit'));
  console.log(C.bold('════════════════════════════════════════════════════════'));

  const tests = [
    ['reporte correcto', testCorrectReport],
    ['resumen no coincide', testMismatchedReport],
    ['resumen silencioso', testSilentReport],
  ];

  for (const [label, fn] of tests) {
    try {
      await fn();
    } catch (e) {
      console.error(`  ${C.red('✗')} ${label} falló: ${e.message}`);
      failed++;
    }
  }

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

main();
