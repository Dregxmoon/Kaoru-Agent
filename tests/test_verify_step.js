'use strict';

// Verificación forzada (opts.verify): al cerrar el run tras una mutación
// exitosa en modo smart, el loop corre el comando de verificación del proyecto
// por el MISMO camino de cualquier tool exec (bridge.execute('exec')). Nunca
// bloquea la tarea; si falla tras los intentos acotados, el run termina igual
// con verify.status='failed' y aviso explícito en la respuesta.

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

// ── resolveVerifyPlan (resolución en capas) ──────────────────────────────────

function testResolveVerifyPlan() {
  console.log(C.bold('\n── resolveVerifyPlan: config.json gana sobre auto-detect ─────────'));

  const { resolveVerifyPlan } = require('../core/commands/verify.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-plan-'));

  // 1. Sin config ni package.json → skip sin bloquear
  const none = resolveVerifyPlan(path.join(dir, 'no-config.json'), dir);
  assert(none.enabled === false, 'Sin config ni package.json → enabled:false');

  // 2. Auto-detect: scripts.typecheck → npm run typecheck
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      scripts: { lint: 'eslint .', typecheck: 'tsc --noEmit', build: 'vite build' },
    }),
    'utf-8'
  );
  const auto = resolveVerifyPlan(path.join(dir, 'no-config.json'), dir);
  assert(
    auto.enabled === true && auto.command === 'npm run typecheck',
    'Auto-detect prioriza typecheck'
  );
  assert(auto.enabled === true, 'Auto-detect encontró comando');

  // 3. Sin typecheck → lint
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ scripts: { lint: 'eslint .', test: 'jest' } }),
    'utf-8'
  );
  const autoLint = resolveVerifyPlan(path.join(dir, 'no-config.json'), dir);
  assert(autoLint.command === 'npm run lint', 'Sin typecheck → lint');

  // 4. Sin typecheck/lint → test, y luego build
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ scripts: { test: 'jest' } }),
    'utf-8'
  );
  const autoTest = resolveVerifyPlan(path.join(dir, 'no-config.json'), dir);
  assert(autoTest.command === 'npm run test', 'Sin typecheck/lint → test');
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ scripts: { build: 'vite build' } }),
    'utf-8'
  );
  const autoBuild = resolveVerifyPlan(path.join(dir, 'no-config.json'), dir);
  assert(autoBuild.command === 'npm run build', 'Solo build → npm run build');

  // 5. config.json agent.verify.command gana SIEMPRE sobre el auto-detect
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({ agent: { verify: { command: 'npm run lint -- --no-cache' } } }),
    'utf-8'
  );
  const explicit = resolveVerifyPlan(configPath, dir);
  assert(
    explicit.enabled === true && explicit.command === 'npm run lint -- --no-cache',
    'agent.verify.command en config.json gana sobre el auto-detect'
  );

  // 6. agent.verify sin command → cae al auto-detect
  fs.writeFileSync(configPath, JSON.stringify({ agent: { verify: {} } }), 'utf-8');
  const fallback = resolveVerifyPlan(configPath, dir);
  assert(
    fallback.enabled === true && fallback.command === 'npm run build',
    'agent.verify vacío → auto-detect'
  );

  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

// ── Loop: mocks ──────────────────────────────────────────────────────────────

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

// Bridge sobre FS real + cola de respuestas para exec (la verificación).
function createBridge(projectCwd, execResponses = []) {
  let execIdx = 0;
  const resolve = (p) => (path.isAbsolute(p) ? p : path.join(projectCwd, p));
  return {
    execute: async (tool, params) => {
      const t0 = Date.now();
      if (tool === 'exec') {
        const r = execResponses[execIdx++];
        return (
          r || {
            ok: true,
            result: { stdout: '', stderr: '', exitCode: 0, signal: null, error: null },
            tool,
            elapsed: Date.now() - t0,
          }
        );
      }
      if (tool === 'read') {
        const p = resolve(params.path);
        return fs.existsSync(p)
          ? {
              ok: true,
              result: fs.readFileSync(p, 'utf-8'),
              error: null,
              tool,
              elapsed: Date.now() - t0,
            }
          : {
              ok: false,
              error: `File not found: ${p}`,
              result: null,
              tool,
              elapsed: Date.now() - t0,
            };
      }
      if (tool === 'edit') {
        const p = resolve(params.path);
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
    },
  };
}

const EDIT_BLOCK = (f) =>
  '```action\nACCIÓN: edit_file | ARCHIVO: ' + f + '\nCONTENIDO: cambia "x = 1" por "y = 1"\n```';

// ── Test 1: sin mutaciones → skip (no bloquea) ───────────────────────────────

async function testVerifySkipNoMutations() {
  console.log(C.bold('\n── Verificación: sin mutaciones → skipped, tarea normal ─────────────'));

  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const AP = require('../core/planner/ActionParser.js');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-nomut-'));
  AP.setProjectCWD(tmpDir);
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ key: 'value' }), 'utf-8');

  const mockLLM = createRouterLLM({
    main: [
      '```action\nACCIÓN: read_file | ARCHIVO: ' + path.join(tmpDir, 'config.json') + '\n```',
      'Revisé config.json y contiene la clave "key".',
    ],
  });

  const loop = new AgentLoop({
    maxIterations: 5,
    mode: 'smart',
    llm: mockLLM,
    bridge: createBridge(tmpDir, []),
  });

  const result = await loop.run('¿qué contiene config.json?', 'Eres un asistente.', [], {
    verify: { enabled: true, command: 'npm run lint' },
  });

  assert(result.verify && result.verify.status === 'skipped', 'verify.status === skipped');
  assert(result.verify && result.verify.reason === 'no_mutations', 'reason === no_mutations');
  assert(
    result.toolResults.length === 1 && result.toolResults[0].tool === 'read',
    'El read se ejecutó normal'
  );
  assert(
    result.response.includes('Revisé config.json'),
    'Respuesta intacta (sin aviso de verificación)'
  );
  assert(!result.error, 'Sin error');

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
}

// ── Test 2: mutación + comando que pasa → passed ─────────────────────────────

async function testVerifyPasses() {
  console.log(C.bold('\n── Verificación: mutación + comando ok → passed ─────────────────────'));

  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const AP = require('../core/planner/ActionParser.js');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-pass-'));
  AP.setProjectCWD(tmpDir);
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
    bridge: createBridge(tmpDir, [
      { ok: true, result: { stdout: '', stderr: '', exitCode: 0, signal: null, error: null } },
    ]),
  });

  const result = await loop.run('edita src/demo.js', 'Eres un asistente.', [], {
    verify: { enabled: true, command: 'npm run lint' },
  });

  assert(result.verify && result.verify.status === 'passed', 'verify.status === passed');
  assert(result.verify && result.verify.command === 'npm run lint', 'verify.command es el comando');
  assert(result.verify && result.verify.attempts === 1, 'Un solo intento');
  assert(result.verify && result.verify.exitCode === 0, 'exitCode === 0');
  assert(result.response.includes('corregí el typo'), 'Respuesta intacta (sin aviso)');
  assert(fs.readFileSync(f, 'utf-8').includes('const y = 1;'), 'La mutación quedó aplicada');

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
}

// ── Test 3: mutación + comando falla (determinista) → failed + aviso ─────────

async function testVerifyFailsDeterministic() {
  console.log(
    C.bold('\n── Verificación: fallo determinista → failed, aviso explícito, run igual ──')
  );

  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const AP = require('../core/planner/ActionParser.js');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-fail-'));
  AP.setProjectCWD(tmpDir);
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
    bridge: createBridge(tmpDir, [
      {
        ok: true,
        result: {
          stdout: '',
          stderr: 'eslint: error in src/demo.js:12:5',
          exitCode: 1,
          signal: null,
          error: null,
        },
      },
    ]),
  });

  const result = await loop.run('edita src/demo.js', 'Eres un asistente.', [], {
    verify: { enabled: true, command: 'npm run lint' },
  });

  assert(result.verify && result.verify.status === 'failed', 'verify.status === failed');
  assert(result.verify && result.verify.exitCode === 1, 'exitCode === 1');
  assert(
    result.verify && result.verify.attempts === 1,
    'Un solo intento (determinista, sin retry)'
  );
  assert(
    result.verify && result.verify.stderr.includes('eslint: error'),
    'stderr truncado disponible en el resultado'
  );
  assert(
    result.response.includes(
      '[Verificación] La tarea se completó pero la verificación (npm run lint) falló (exit 1)'
    ),
    'La respuesta lo dice explícitamente (nunca cierre silencioso)',
    `resp: ${result.response.slice(-200)}`
  );
  assert(
    result.response.includes('corregí el typo'),
    'El texto del LLM se conserva antes del aviso'
  );
  assert(!result.error, 'El run NO reporta error (terminó igual, con aviso)');
  assert(fs.readFileSync(f, 'utf-8').includes('const y = 1;'), 'La mutación quedó aplicada igual');

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
}

// ── Test 4: sin comando pero con mutación JS → sellado con node --check ──────

async function testVerifyNodeCheckFallback() {
  console.log(
    C.bold('\n── Verificación: sin scripts ni config pero con mutación JS → node --check ──')
  );

  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const AP = require('../core/planner/ActionParser.js');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-nocmd-'));
  AP.setProjectCWD(tmpDir);
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
    bridge: createBridge(tmpDir, []),
  });

  // Mismo escenario que production cuando resolveVerifyPlan devuelve
  // { enabled: false } (sin config ni package.json con scripts): ahora el loop
  // NO se queda sin sellar — corre `node --check` sobre el archivo JS mutado.
  const result = await loop.run('edita src/demo.js', 'Eres un asistente.', [], {
    verify: { enabled: false },
  });

  assert(
    result.verify && result.verify.status === 'passed',
    'verify.status === passed (sellado con node --check)'
  );
  assert(
    result.verify && result.verify.command.startsWith('node --check'),
    'verify.command usa node --check',
    `cmd: ${result.verify && result.verify.command}`
  );
  assert(result.verify && result.verify.attempts === 1, 'Un solo intento');
  assert(result.verify && result.verify.exitCode === 0, 'exitCode === 0');
  assert(
    result.toolResults.length === 1 && result.toolResults[0].ok === true,
    'La edición se ejecutó normal'
  );
  assert(fs.readFileSync(f, 'utf-8').includes('const y = 1;'), 'La mutación quedó aplicada');
  assert(result.response.includes('corregí el typo'), 'Respuesta intacta');

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
}

async function testVerifyNodeCheckFails() {
  console.log(
    C.bold('\n── Verificación: node --check falla (error de sintaxis) → failed + aviso ──')
  );

  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const AP = require('../core/planner/ActionParser.js');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-nchk-'));
  AP.setProjectCWD(tmpDir);
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
    bridge: createBridge(tmpDir, [
      {
        ok: true,
        result: {
          stdout: '',
          stderr: 'src/demo.js:2:1: SyntaxError: Unexpected token',
          exitCode: 1,
          signal: null,
          error: null,
        },
      },
    ]),
  });

  const result = await loop.run('edita src/demo.js', 'Eres un asistente.', [], {
    verify: { enabled: false },
  });

  assert(
    result.verify && result.verify.status === 'failed',
    'verify.status === failed (node --check detectó el error)'
  );
  assert(
    result.verify && result.verify.command.startsWith('node --check'),
    'verify.command usa node --check'
  );
  assert(result.verify && result.verify.exitCode === 1, 'exitCode === 1');
  assert(
    result.response.includes(
      '[Verificación] La tarea se completó pero la verificación (node --check'
    ),
    'La respuesta lo dice explícitamente (nunca cierre silencioso)'
  );

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
}

async function testSubagentInheritsVerify() {
  console.log(C.bold('\n── Subagente hereda la verificación del padre (out.verify) ──────────'));

  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const AP = require('../core/planner/ActionParser.js');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-sub-'));
  AP.setProjectCWD(tmpDir);
  const f = path.join(tmpDir, 'src', 'demo.js');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, 'const x = 1;\n', 'utf-8');

  const subLLM = createRouterLLM({
    main: [EDIT_BLOCK(f), 'Listo, corregí el typo.'],
    resolution: JSON.stringify({ old_text: 'const x = 1;', new_text: 'const y = 1;' }),
  });
  // El subagente usa la bridge del padre (misma cola de exec para la verificación).
  const bridge = createBridge(tmpDir, [
    { ok: true, result: { stdout: '', stderr: '', exitCode: 0, signal: null, error: null } },
  ]);
  const parent = new AgentLoop({ maxIterations: 6, mode: 'smart', llm: subLLM, bridge });
  parent._verifyPlan = { enabled: true, command: 'npm run lint' };

  const out = await parent._executeSubagent({
    tool: 'subagent',
    params: { task: 'edita el archivo' },
  });

  assert(out.ok, 'subagente ejecutado', out.error || '');
  assert(
    out.result && out.result.verify && out.result.verify.status === 'passed',
    'el subagente heredó verify del padre y pasó',
    JSON.stringify(out.result && out.result.verify)
  );
  assert(
    out.result && out.result.verify && out.result.verify.command === 'npm run lint',
    'verify.command es el del padre'
  );
  assert(fs.readFileSync(f, 'utf-8').includes('const y = 1;'), 'La mutación quedó aplicada');

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
}

// ── Test 7: fallo transitorio (timeout) → retry → passed ─────────────────────

async function testVerifyRetryOnTransient() {
  console.log(C.bold('\n── Verificación: timeout transitorio → retry y pasa (attempts 2) ──────'));

  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const AP = require('../core/planner/ActionParser.js');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-trans-'));
  AP.setProjectCWD(tmpDir);
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
    bridge: createBridge(tmpDir, [
      // 1er intento: SIGKILL por timeout del server (transitorio)
      {
        ok: true,
        result: { stdout: '', stderr: '', exitCode: null, signal: 'timeout', error: null },
      },
      // 2º intento: pasa
      { ok: true, result: { stdout: '', stderr: '', exitCode: 0, signal: null, error: null } },
    ]),
  });

  const result = await loop.run('edita src/demo.js', 'Eres un asistente.', [], {
    verify: { enabled: true, command: 'npm run typecheck' },
  });

  assert(
    result.verify && result.verify.status === 'passed',
    'verify.status === passed tras el retry'
  );
  assert(
    result.verify && result.verify.attempts === 2,
    'attempts === 2 (reintento solo por transitorio)'
  );

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
}

async function main() {
  testResolveVerifyPlan();
  await testVerifySkipNoMutations();
  await testVerifyPasses();
  await testVerifyFailsDeterministic();
  await testVerifyNodeCheckFallback();
  await testVerifyNodeCheckFails();
  await testVerifyRetryOnTransient();
  await testSubagentInheritsVerify();

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
