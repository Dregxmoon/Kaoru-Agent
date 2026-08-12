'use strict';

/**
 * test_workspace_stack.js — Fase 3: firmeza del código.
 *
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron tests/test_workspace_stack.js
 *
 * Verifica:
 *   - buildWorkspaceStackSection: stack del proyecto activo (lenguaje, scripts,
 *     deps, raíz, rama git) y casos límite (sin cwd, ruta inexistente).
 *   - CODE_VERACITY_RULE: regla estática contra código no verificado,
 *     salidas inventadas y lenguajes mezclados.
 *   - buildContext inyecta AMBAS secciones en el system prompt.
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

// ── Helpers: proyecto temporal ─────────────────────────────────────────────────

let tmpRoot = null;

function makeProject(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsstack-'));
  for (const [rel, content] of Object.entries(entries)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf-8');
  }
  tmpRoot = dir;
  return dir;
}

function cleanup() {
  if (tmpRoot) {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
    tmpRoot = null;
  }
}

// ── Test 1: buildWorkspaceStackSection ───────────────────────────────────────

async function testWorkspaceStack() {
  console.log(C.bold('\nTest 1: buildWorkspaceStackSection — stack del proyecto'));

  const ctx = require('../core/core/context.js');

  // CommonJS sin fuentes TS (tsconfig solo para typecheck, como el propio repo).
  const cjs = makeProject({
    'package.json': JSON.stringify({
      name: 'mi-app',
      type: 'commonjs',
      scripts: { start: 'node index.js', test: 'jest' },
      dependencies: { express: '^4' },
      devDependencies: { jest: '^29' },
    }),
    'tsconfig.json': '{}',
    'index.js': "console.log('hi')\n",
    'README.md': '# mi-app',
  });
  let sec = ctx.buildWorkspaceStackSection(cjs);
  assert(sec.includes('- Proyecto: mi-app'), 'incluye el nombre del proyecto');
  assert(
    sec.includes('- Lenguaje/stack: JavaScript (CommonJS)'),
    'CommonJS + tsconfig sin fuentes .ts → CommonJS (no TypeScript)',
    sec
  );
  assert(sec.includes('- Scripts: start, test'), 'incluye scripts');
  assert(sec.includes('1 deps + 1 dev (npm)'), 'incluye deps y manager');
  assert(sec.includes('- Raíz:'), 'incluye estructura raíz');
  cleanup();

  // TypeScript real (hay fuentes .ts).
  const ts = makeProject({
    'package.json': JSON.stringify({ name: 'ts-app', type: 'module' }),
    'tsconfig.json': '{}',
    'src/main.ts': 'export const a: number = 1\n',
  });
  sec = ctx.buildWorkspaceStackSection(ts);
  assert(sec.includes('- Lenguaje/stack: TypeScript'), 'fuentes .ts reales → TypeScript', sec);
  assert(
    sec.includes('- Lenguaje/stack: TypeScript'),
    'type module + .ts → TypeScript (prima el stack real)'
  );
  cleanup();

  // ESM puro (type: module sin TS).
  const esm = makeProject({
    'package.json': JSON.stringify({ name: 'esm-app', type: 'module' }),
    'src/index.js': 'export const a = 1\n',
  });
  sec = ctx.buildWorkspaceStackSection(esm);
  assert(
    sec.includes('- Lenguaje/stack: JavaScript (ESM)'),
    'type: module sin .ts → JavaScript (ESM)',
    sec
  );
  cleanup();

  // Rama git (lectura de .git/HEAD).
  const git = makeProject({
    '.git/HEAD': 'ref: refs/heads/mi-rama\n',
  });
  sec = ctx.buildWorkspaceStackSection(git);
  assert(sec.includes('- Rama git: mi-rama'), 'lee la rama de .git/HEAD', sec);
  cleanup();

  // Casos límite.
  assert(ctx.buildWorkspaceStackSection('') === '', 'cwd vacío → sección vacía');
  assert(
    ctx.buildWorkspaceStackSection('/no/existe/ruta') === '',
    'ruta inexistente → sección vacía'
  );
  assert(ctx.buildWorkspaceStackSection(null) === '', 'cwd null → sección vacía');
}

// ── Test 2: CODE_VERACITY_RULE ────────────────────────────────────────────────

function testCodeVeracity() {
  console.log(C.bold('\nTest 2: CODE_VERACITY_RULE — regla estática de veracidad'));

  const { CODE_VERACITY_RULE } = require('../core/core/context.js');

  assert(typeof CODE_VERACITY_RULE === 'string', 'la regla está exportada');
  assert(CODE_VERACITY_RULE.length > 300, 'la regla tiene cuerpo (no es un stub)');
  assert(
    CODE_VERACITY_RULE.includes('EJECUTADO') && CODE_VERACITY_RULE.includes('sin verificar'),
    'prohíbe afirmar resultados sin ejecutar'
  );
  assert(
    CODE_VERACITY_RULE.includes('inventes salidas'),
    'prohíbe salidas inventadas (números, hashes, mensajes)'
  );
  assert(
    CODE_VERACITY_RULE.includes('MISMO lenguaje/stack'),
    'exige el lenguaje/stack del proyecto o del usuario'
  );
  assert(CODE_VERACITY_RULE.includes('CONSISTENTES'), 'exige ejemplos consistentes entre mensajes');
}

// ── Test 3: buildContext inyecta ambas secciones ─────────────────────────────

async function testBuildContextInject() {
  console.log(C.bold('\nTest 3: buildContext inyecta stack + veracidad en el prompt'));

  const ctx = require('../core/core/context.js');
  const state = require('../core/core/state.js');
  const { setProjectCWD } = require('../core/planner/Planner.js');
  const { getToolRegistry } = require('../core/task/ToolRegistry.js');

  const saved = { ...state };
  const savedCwd = require('../core/planner/ActionParser.js').PROJECT_CWD;
  const proj = makeProject({
    'package.json': JSON.stringify({
      name: 'proyecto-test',
      type: 'commonjs',
      scripts: { start: 'node index.js' },
    }),
    'index.js': "console.log('ok')\n",
    '.git/HEAD': 'ref: refs/heads/ramatest\n',
  });
  setProjectCWD(proj);

  try {
    state.grounding = null;
    state.behavior = null;
    state.detector = null;
    state.osSensor = null;
    state.learning = null;
    state.skillManager = null;
    state.bridge = null;
    state.mcp = null;
    state.graph = null;
    state.taskDetector = { detect: async () => ({ isTask: false, domain: null, confidence: 0 }) };
    state.toolRegistry = getToolRegistry();

    const result = await ctx.buildContext([], 'groq', { mode: 'chat' });
    const prompt = result.systemPrompt || '';

    assert(
      prompt.includes('# WORKSPACE ACTIVO (PROYECTO)'),
      'el prompt incluye la sección del workspace activo'
    );
    assert(prompt.includes('- Proyecto: proyecto-test'), 'el stack refleja el proyecto real');
    assert(prompt.includes('- Rama git: ramatest'), 'el stack incluye la rama git');
    assert(prompt.includes('# VERACIDAD DEL CÓDIGO'), 'el prompt incluye la regla de veracidad');
  } finally {
    Object.assign(state, saved);
    setProjectCWD(savedCwd || process.cwd());
    cleanup();
  }
}

// ── Runner ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(C.bold(C.cyan('\nFase 3 — firmeza del código (workspace stack + veracidad)')));
  await testWorkspaceStack();
  testCodeVeracity();
  await testBuildContextInject();

  console.log(C.bold('\n════════════════════════════════════════════════════════'));
  const total = passed + failed;
  console.log(
    C.bold(
      `  Resultado: ${C.green(`${passed} passed`)}  ${failed > 0 ? C.red(`${failed} failed`) : C.dim('0 failed')}  / ${total} total`
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
