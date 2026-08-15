'use strict';

/**
 * test_subagent_summary_parse.js — el resumen final de un subagente NO debe
 * reinterpretarse como una orden de edición.
 *
 * Caso real de producción: el resumen que devuelve un subagente (_executeSubagent
 * en AgentLoop.js) es lenguaje natural del tipo "Terminé escribiendo el archivo
 * X con la función bar()" o "Hice la modificación del archivo Y". Si ese texto
 * pasa por el parser de prosa (ActionParser legacy) como un mensaje del LLM en
 * modo agente normal, frases como "escribiendo el archivo X" / "la modificación
 * del archivo Y" disparan de nuevo _detectEditIntent → se re-ejecuta una edición
 * que el usuario nunca pidió.
 *
 * Fix: los runs anidados de subagentes corren con `reportMode`, que hace que el
 * texto SIN bloque de acción estructurado se trate como el reporte final (no se
 * le aplica el fallback legacy de prosa — ver opts.skipLegacy en
 * StructuredActionParser.parse). Las ediciones del subagente se siguen
 * expresando con bloques ```action``` o tool calls nativos.
 *
 * Estos tests usan resúmenes CON lenguaje natural real (los que disparaban el
 * bug), no el trabajo neutral usado en suites anteriores.
 *
 * Correr igual que las demás suites (Node de Electron):
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron tests/test_subagent_summary_parse.js
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

// ── Setup / Teardown ─────────────────────────────────────────────────────────

let tmpDir;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-summary-'));
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

// ── Bridge mínimo (write/read/edit) sobre FS ────────────────────────────────

function createWriteBridge() {
  return {
    execute: async (tool, params) => {
      const p = params.path;
      if (tool === 'write') {
        if (!p) return { ok: false, error: 'path requerido', result: null, tool, elapsed: 0 };
        const dir = path.dirname(p);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(p, params.content || `contenido de ${path.basename(p)}`, 'utf-8');
        return { ok: true, result: `Escrito ${p}`, error: null, tool, elapsed: 0 };
      }
      if (tool === 'read') {
        return fs.existsSync(p)
          ? { ok: true, result: fs.readFileSync(p, 'utf-8'), error: null, tool, elapsed: 0 }
          : { ok: false, error: `not found ${p}`, result: null, tool, elapsed: 0 };
      }
      if (tool === 'edit') {
        return { ok: true, result: `Editado ${p}`, error: null, tool, elapsed: 0 };
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

// ── Test 1: el bug existe a nivel parser (sin reportMode) y skipLegacy lo evita ──

async function testParserLevel() {
  console.log(C.bold('\n── Test 1: parser legacy re-dispara sobre resúmenes naturales; skipLegacy lo evita ──'));

  const { StructuredActionParser } = require('../core/planner/StructuredActionParser.js');
  const { ActionParser } = require('../core/planner/ActionParser.js');

  const parser = new StructuredActionParser('/tmp');
  // userGoal es el mensaje de resultado de la herramienta (marker); el texto a
  // escanear es el resumen natural del subagente.
  const marker = '[Resultado de herramienta "subagent"]: {...}';

  const cases = [
    'Terminé escribiendo el archivo src/foo.js con la función bar(). Listo.',
    'Hice la modificación del archivo src/foo.js para corregir el bug.',
    'Escribo el archivo src/lib.js con la nueva lógica.',
  ];

  for (const summary of cases) {
    // Bug pre-fix: el fallback legacy detecta una edición fantasma.
    const legacy = ActionParser.parse(summary, marker);
    const phantom = legacy.filter((a) => a.tool === 'edit_file' || a.tool === 'edit');
    assert(
      phantom.length === 1,
      `pre-fix el resumen natural dispara edit fantasma (${JSON.stringify(summary.slice(0, 45))})`,
      JSON.stringify(phantom.map((a) => a.params.path))
    );

    // Fix: con skipLegacy (reportMode del subagente) NO se produce ninguna acción.
    const skipped = parser.parse(summary, marker, null, { skipLegacy: true });
    assert(skipped.length === 0, 'con skipLegacy el resumen no produce acciones');

    // Sin skipLegacy, el StructuredActionParser cae al legacy y también dispara.
    const legacyFull = parser.parse(summary, marker, null);
    assert(
      legacyFull.length === 1 && (legacyFull[0].tool === 'edit_file' || legacyFull[0].tool === 'edit'),
      'sin skipLegacy el StructuredActionParser también detecta el edit fantasma'
    );
  }
}

// ── Test 2: subagente E2E — resumen natural "Terminé escribiendo el archivo X" ──

async function testSubagentNaturalSummaryWrite() {
  console.log(C.bold('\n── Test 2: subagente con resumen natural "Terminé escribiendo el archivo X" ──'));

  const dir = setup();
  const target = path.join(dir, 'src', 'foo.js');
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const llm = createSubagentLLM([
    actionBlock('write', target),
    `Terminé escribiendo el archivo ${target} con la función bar(). El cambio quedó aplicado y listo.`,
  ]);

  const result = await runSubagent({ llm, projectCwd: dir });

  assert(result.ok, 'subagente ejecutado con éxito', result.error || '');
  assert(
    Array.isArray(result.result.toolCalls) &&
      result.result.toolCalls.length === 1 &&
      result.result.toolCalls[0] === 'write:ok',
    'el subagente ejecutó UNA sola edición real (write:ok), sin edit fantasma',
    JSON.stringify(result.result.toolCalls)
  );
  assert(
    result.result.iterations === 2,
    'termina en 2 iteraciones (write + resumen), sin iteración extra de re-parseo',
    `iteraciones: ${result.result.iterations}`
  );
  assert(
    result.result.response.includes('Terminé escribiendo el archivo') &&
      result.result.response.includes(path.basename(target)),
    'la respuesta es el resumen natural intacto',
    result.result.response.slice(0, 100)
  );
  assert(
    fs.existsSync(target),
    'el archivo sí se escribió (el subagente conserva su capacidad de editar)',
    target
  );
  assert(!result.result.response.includes('Discrepancia'), 'sin nota de discrepancia espuria');

  teardown();
}

// ── Test 3: subagente E2E — resumen "Hice la modificación del archivo X" ─────

async function testSubagentNaturalSummaryModify() {
  console.log(C.bold('\n── Test 3: subagente con resumen natural "Hice la modificación del archivo X" ──'));

  const dir = setup();
  const target = path.join(dir, 'helpers.js');

  const llm = createSubagentLLM([
    actionBlock('write', target),
    `Hice la modificación del archivo ${target} para corregir el bug. Listo.`,
  ]);

  const result = await runSubagent({ llm, projectCwd: dir });

  assert(result.ok, 'subagente ejecutado con éxito', result.error || '');
  assert(
    Array.isArray(result.result.toolCalls) &&
      result.result.toolCalls.length === 1 &&
      result.result.toolCalls[0] === 'write:ok',
    'una sola edición real (write:ok), sin edit fantasma',
    JSON.stringify(result.result.toolCalls)
  );
  assert(
    result.result.iterations === 2,
    'termina en 2 iteraciones, sin re-parseo del resumen',
    `iteraciones: ${result.result.iterations}`
  );
  assert(
    result.result.response.includes('Hice la modificación del archivo'),
    'la respuesta es el resumen natural intacto',
    result.result.response.slice(0, 100)
  );

  teardown();
}

// ── Test 4: agente principal — el resumen llega como tool result, no como orden ──
async function testMainAgentProtection() {
  console.log(C.bold('\n── Test 4: el resultado del subagente llega al padre como tool result ──'));

  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const { getStructuredActionParser } = require('../core/planner/StructuredActionParser.js');
  const { ActionParser } = require('../core/planner/ActionParser.js');
  const AP = require('../core/planner/ActionParser.js');

  const dir = setup();
  AP.setProjectCWD(dir);
  const target = path.join(dir, 'src', 'main.js');
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const llm = createSubagentLLM([
    actionBlock('write', target),
    `Terminé escribiendo el archivo ${target} con la lógica nueva. Listo.`,
  ]);

  const subagentResult = await runSubagent({ llm, projectCwd: dir });
  assert(subagentResult.ok, 'subagente resuelto', subagentResult.error || '');

  // El agente principal envuelve el resultado con el marker de herramienta.
  const mainLoop = new AgentLoop({ maxIterations: 5, llm: async () => 'x', bridge: createWriteBridge() });
  const markerMsg = mainLoop._buildToolResultMessage(subagentResult);
  assert(
    markerMsg.startsWith('[Resultado de herramienta "subagent"]:'),
    'el resultado se envuelve como "[Resultado de herramienta "subagent"]"',
    markerMsg.slice(0, 60)
  );

  // El parser del agente principal escanea SU próximo mensaje, no el resumen.
  const parser = getStructuredActionParser(dir);
  const mainText = 'Listo, la tarea quedó completa.';
  const viaStructured = parser.parse(mainText, markerMsg, null);
  const viaLegacy = ActionParser.parse(mainText, markerMsg);
  assert(viaStructured.length === 0, 'el parser del padre no re-detecta edición del resumen', JSON.stringify(viaStructured));
  assert(viaLegacy.length === 0, 'el ActionParser del padre tampoco', JSON.stringify(viaLegacy));

  teardown();
}

// ── Test 5: con reportMode, acciones reales en iteraciones NO-primera siguen ejecutándose ──

async function testActionBlocksInLaterIterations() {
  console.log(C.bold('\n── Test 5: reportMode NO bloquea acciones reales (read→write→resumen) ──'));

  const dir = setup();
  const target = path.join(dir, 'src', 'foo.js');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'const a = 1;\n', 'utf-8');

  // El subagente trabaja en iter 1 (read) e iter 2 (write), y recién en iter 3
  // produce su resumen. skipLegacy:true solo desactiva el parser de PROSA; los
  // bloques ```action``` se siguen parseando y ejecutando en toda iteración.
  const llm = createSubagentLLM([
    actionBlock('read_file', target),
    actionBlock('write', target),
    `Terminé escribiendo el archivo ${target} con la lógica nueva. Listo.`,
  ]);

  const result = await runSubagent({ llm, projectCwd: dir });

  assert(result.ok, 'subagente ejecutado con éxito', result.error || '');
  assert(
    Array.isArray(result.result.toolCalls) &&
      result.result.toolCalls.length === 2 &&
      result.result.toolCalls[0] === 'read:ok' &&
      result.result.toolCalls[1] === 'write:ok',
    'ambas acciones reales se ejecutaron (read:ok, write:ok)',
    JSON.stringify(result.result.toolCalls)
  );
  assert(
    result.result.iterations === 3,
    '3 iteraciones (read + write + resumen), sin iteración fantasma',
    `iteraciones: ${result.result.iterations}`
  );
  assert(
    fs.existsSync(target) && fs.readFileSync(target, 'utf-8').length > 0,
    'el write de la iteración 2 se aplicó de verdad',
    `existe: ${fs.existsSync(target)}`
  );

  teardown();
}

// ── Test 6: la ÚLTIMA respuesta del LLM del subagente es una acción real ──────

async function testLastResponseIsActionBlock() {
  console.log(C.bold('\n── Test 6: la última respuesta del subagente ES una acción real ──'));

  const dir = setup();
  const target = path.join(dir, 'src', 'bar.js');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'const b = 2;\n', 'utf-8');

  // La última salida del LLM del subagente es un bloque de acción (write), no
  // un resumen. reportMode NO debe tragárselo: el write se ejecuta y el run
  // termina en la siguiente iteración con el texto de agotamiento.
  const llm = createSubagentLLM([
    actionBlock('read_file', target),
    actionBlock('write', target),
  ]);

  const result = await runSubagent({ llm, projectCwd: dir });

  assert(result.ok, 'subagente ejecutado con éxito', result.error || '');
  assert(
    Array.isArray(result.result.toolCalls) &&
      result.result.toolCalls.length === 2 &&
      result.result.toolCalls[0] === 'read:ok' &&
      result.result.toolCalls[1] === 'write:ok',
    'la acción de la última respuesta se ejecutó (write:ok)',
    JSON.stringify(result.result.toolCalls)
  );
  assert(
    fs.existsSync(target),
    'el archivo de la última acción quedó escrito',
    target
  );

  teardown();
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
  console.log(C.bold(' subagent summary parse (resumen como tool result)'));
  console.log(C.bold('════════════════════════════════════════════════════════'));

  const tests = [
    ['parser legacy re-dispara / skipLegacy lo evita', testParserLevel],
    ['resumen natural "Terminé escribiendo el archivo X"', testSubagentNaturalSummaryWrite],
    ['resumen natural "Hice la modificación del archivo X"', testSubagentNaturalSummaryModify],
    ['el padre recibe el resumen como tool result', testMainAgentProtection],
    ['acciones reales en iteraciones posteriores (read→write)', testActionBlocksInLaterIterations],
    ['última respuesta del subagente es una acción real', testLastResponseIsActionBlock],
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