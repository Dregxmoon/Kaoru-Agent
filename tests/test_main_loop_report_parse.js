'use strict';

// Regresión del fix de "cierre en prosa" del loop principal:
// cuando el run ya ejecutó al menos una herramienta, un texto sin bloque
// ```action es el CIERRE del run (regla 3 del prompt del bucle), NO una
// orden. Escanearlo con el parser legacy re-disparaba ediciones fantasma
// (p. ej. "Listo, terminé la modificación del archivo X" o "Terminé
// escribiendo el archivo Y" → edit_file con edit:err). El fallback legacy
// se conserva en i=0 (primera respuesta en modo texto puro).

const path = require('path');
const fs = require('fs');
const os = require('os');

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

// Mock LLM con enrutado por system prompt:
//  - 'editor de código experto' → resolución del edit (JSON o 'no json').
//  - 'reflexión' → veredicto de reflexión (ABANDONAR en los tests que la usan).
//  - resto → respuestas del agente principal, en orden secuencial.
function createRouterLLM({ main, resolution, reflection }) {
  let mainCount = 0;
  let reflectionCount = 0;
  const fn = async (messages, system) => {
    const sys = system || '';
    if (sys.includes('editor de código experto')) return resolution;
    if (/reflexi[oó]n/i.test(sys)) {
      reflectionCount++;
      return reflection || 'VEREDICTO: COMPLETA';
    }
    const next = main[mainCount++];
    return next === undefined ? 'Tarea completada.' : next;
  };
  fn.mainCalls = () => mainCount;
  fn.reflectionCalls = () => reflectionCount;
  return fn;
}

// Mock bridge sobre FS real. Resuelve rutas relativas contra el projectCWD
// (como hace OpenClawBridge) porque el parser legacy emite rutas relativas.
function createBridge(projectCwd) {
  const resolve = (p) => (path.isAbsolute(p) ? p : path.join(projectCwd, p));
  return {
    execute: async (tool, params) => {
      const t0 = Date.now();
      try {
        if (tool === 'read') {
          const p = resolve(params.path);
          if (!fs.existsSync(p)) {
            return {
              ok: false,
              error: `File not found: ${p}`,
              result: null,
              tool,
              elapsed: Date.now() - t0,
            };
          }
          return {
            ok: true,
            result: fs.readFileSync(p, 'utf-8'),
            error: null,
            tool,
            elapsed: Date.now() - t0,
          };
        }
        if (tool === 'write' || tool === 'create_file') {
          const p = resolve(params.path);
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, params.content || '', 'utf-8');
          return { ok: true, result: `Written ${p}`, error: null, tool, elapsed: Date.now() - t0 };
        }
        if (tool === 'edit') {
          const p = resolve(params.path);
          if (!fs.existsSync(p)) {
            return {
              ok: false,
              error: `File not found: ${p}`,
              result: null,
              tool,
              elapsed: Date.now() - t0,
            };
          }
          const content = fs.readFileSync(p, 'utf-8');
          if (params.old_text && content.includes(params.old_text)) {
            fs.writeFileSync(p, content.replace(params.old_text, params.new_text), 'utf-8');
            return { ok: true, result: `Edited ${p}`, error: null, tool, elapsed: Date.now() - t0 };
          }
          return {
            ok: false,
            error: 'no_matching_text',
            result: null,
            tool,
            elapsed: Date.now() - t0,
          };
        }
        return {
          ok: true,
          result: `[mock] ${tool} ejecutado`,
          error: null,
          tool,
          elapsed: Date.now() - t0,
        };
      } catch (e) {
        return { ok: false, error: e.message, result: null, tool, elapsed: Date.now() - t0 };
      }
    },
  };
}

// ── Test 1: cierre en prosa "terminé la modificación del archivo X" ──────────

async function testClosingProseDoesNotPhantomEdit() {
  console.log(C.bold('\n── Cierre en prosa tras un edit real NO re-dispara edición fantasma ─'));

  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const AP = require('../core/planner/ActionParser.js');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-close-prose-'));
  AP.setProjectCWD(tmpDir);
  const f = path.join(tmpDir, 'src', 'demo.js');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, 'const x = 1;\nconsole.log(x);\n', 'utf-8');

  const mockLLM = createRouterLLM({
    main: [
      '```action\nACCIÓN: edit_file | ARCHIVO: ' +
        f +
        '\nCONTENIDO: cambia "x = 1" por "y = 2" en la primera línea\n```',
      'Listo, terminé la modificación del archivo ' + f + ' para corregir el bug.',
    ],
    resolution: JSON.stringify({ old_text: 'const x = 1;', new_text: 'const y = 2;' }),
  });

  const loop = new AgentLoop({
    maxIterations: 6,
    llm: mockLLM,
    bridge: createBridge(tmpDir),
  });

  const result = await loop.run('edita src/demo.js renombrando x por y', 'Eres un asistente.', [], {
    onApprovalNeeded: async () => true,
  });

  const edited = fs.readFileSync(f, 'utf-8');
  assert(
    result.toolResults.length === 1,
    'Una sola herramienta ejecutada (el edit real, sin fantasma)',
    `tools: ${JSON.stringify(result.toolResults.map((t) => `${t.tool}:${t.ok}`))}`
  );
  assert(
    result.toolResults[0].tool === 'edit' && result.toolResults[0].ok,
    'El edit real terminó en ok'
  );
  assert(
    result.iterations === 2,
    'Dos iteraciones (edit + cierre)',
    `iterations: ${result.iterations}`
  );
  assert(
    result.response.includes('terminé la modificación'),
    'La prosa de cierre quedó intacta como respuesta'
  );
  assert(edited.includes('const y = 2;'), 'El archivo quedó editado (y = 2)');
  assert(!edited.includes('const x = 1;'), 'El texto original fue reemplazado');

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
}

// ── Test 2: reflexión ABANDONAR + cierre "terminé escribiendo X" ─────────────

async function testReflectionAbandonarClosingProseDoesNotPhantomEdit() {
  console.log(C.bold('\n── Reflexión ABANDONAR + cierre "terminé escribiendo X" sin fantasma ──'));

  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const AP = require('../core/planner/ActionParser.js');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-abandonar-'));
  AP.setProjectCWD(tmpDir);
  const f = path.join(tmpDir, 'src', 'demo.js');
  const f2 = path.join(tmpDir, 'src', 'other.js');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, 'const x = 1;\n', 'utf-8');
  fs.writeFileSync(f2, 'const y = 2;\n', 'utf-8');

  const mockLLM = createRouterLLM({
    main: [
      '```action\nACCIÓN: edit_file | ARCHIVO: ' + f + '\nCONTENIDO: cambia algo\n```',
      '```action\nACCIÓN: edit_file | ARCHIVO: ' + f2 + '\nCONTENIDO: cambia algo\n```',
      'Listo, terminé escribiendo el archivo ' + f + ' con la lógica nueva. Adiós.',
    ],
    resolution: 'no json', // resolución inválida → edit_no_resuelto → la tool falla
    reflection:
      'VEREDICTO: ABANDONAR\nRAZÓN: no se puede completar con las herramientas disponibles.',
  });

  const loop = new AgentLoop({
    maxIterations: 6,
    llm: mockLLM,
    bridge: createBridge(tmpDir),
  });

  const result = await loop.run('modifica los archivos', 'Eres un asistente.', [], {
    onApprovalNeeded: async () => true,
    reflection: true,
  });

  assert(mockLLM.reflectionCalls() === 1, 'La reflexión ABANDONAR se disparó una vez');
  assert(
    result.toolResults.length === 2,
    'Solo las dos fallas reales, sin edit fantasma tras el cierre',
    `tools: ${JSON.stringify(result.toolResults.map((t) => `${t.tool}:${t.ok}`))}`
  );
  assert(
    result.toolResults.every((t) => t.tool === 'edit' && !t.ok),
    'Ambas entradas son edits fallidos (sin fantasma ok)'
  );
  assert(
    result.iterations === 3,
    'Tres iteraciones (2 fallas + reflexión + cierre)',
    `iterations: ${result.iterations}`
  );
  assert(
    result.response.includes('terminé escribiendo'),
    'La prosa de cierre quedó intacta como respuesta'
  );

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
}

// ── Test 3: primera respuesta en prosa (i=0) conserva el fallback legacy ─────

async function testFirstResponseProseStillDetectsEdit() {
  console.log(C.bold('\n── Primera respuesta en prosa (i=0) aún detecta la edición ─────────'));

  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const AP = require('../core/planner/ActionParser.js');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-first-prose-'));
  AP.setProjectCWD(tmpDir);
  fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'src', 'demo.js'), 'const x = 1;\nconsole.log(x);\n', 'utf-8');

  const mockLLM = createRouterLLM({
    main: ['Claro, ya lo hago.', 'Listo, terminé.'],
    resolution: JSON.stringify({ old_text: 'const x = 1;', new_text: 'const y = 1;' }),
  });

  const loop = new AgentLoop({
    maxIterations: 5,
    llm: mockLLM,
    bridge: createBridge(tmpDir),
  });

  const result = await loop.run(
    'Modifica src/demo.js renombrando la variable x por y',
    'Eres un asistente.',
    [],
    {
      onApprovalNeeded: async () => true,
    }
  );

  const edited = fs.readFileSync(path.join(tmpDir, 'src', 'demo.js'), 'utf-8');
  assert(
    result.toolResults.length === 1 &&
      result.toolResults[0].tool === 'edit' &&
      result.toolResults[0].ok,
    'La edición pedida en prosa en la primera respuesta se ejecutó',
    `tools: ${JSON.stringify(result.toolResults.map((t) => `${t.tool}:${t.ok}`))}`
  );
  assert(
    result.iterations === 2,
    'Dos iteraciones (prosa + ejecución, cierre)',
    `iterations: ${result.iterations}`
  );
  assert(
    edited.includes('const y = 1;') && !edited.includes('const x = 1;'),
    'El archivo quedó editado'
  );
  assert(!result.error, 'Sin error');

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
}

async function main() {
  await testClosingProseDoesNotPhantomEdit();
  await testReflectionAbandonarClosingProseDoesNotPhantomEdit();
  await testFirstResponseProseStillDetectsEdit();

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
