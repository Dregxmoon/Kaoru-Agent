'use strict';

// SubagentRegistry (F1): perfiles de subagentes — built-ins, carga de
// markdown con frontmatter, allow/deny por glob y read_only.

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
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

const assertEqual = (a, b, label) =>
  assert(a === b, label, `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  SubagentRegistry,
  _parseFrontmatter,
  _matchesGlob,
  _toolAllowed,
} = require('../core/planner/SubagentRegistry.js');

// ── Test 1: built-ins ────────────────────────────────────────────────────────
function testBuiltins() {
  console.log(C.bold('\n── Test 1: perfiles built-in ───────────────────────────'));
  const reg = new SubagentRegistry();
  reg.load();
  assertEqual(reg.list().length, 3, '3 perfiles embebidos');
  const general = reg.resolve('general');
  const explorador = reg.resolve('explorador');
  const investigador = reg.resolve('investigador');
  assert(!!general, 'resolve("general") existe');
  assert(!!explorador && !!investigador, 'resolve explorador/investigador existe');
  assert(general.readOnly === false, 'general NO es read-only');
  assert(explorador.readOnly === true, 'explorador es read-only');
  assert(investigador.readOnly === true, 'investigador es read-only');
  assertEqual(general.mode, 'inherit', 'general hereda el modo del padre');
  assertEqual(explorador.mode, 'fast', 'explorador corre en fast');
  assert(!!general.description, 'general tiene description');
  assert(reg.describeForPrompt().includes('explorador'), 'describeForPrompt lista perfiles');
  assert(reg.resolve('no_existe') === null, 'perfil desconocido → null');
}

// ── Test 2: frontmatter markdown ─────────────────────────────────────────────
function testFrontmatter() {
  console.log(C.bold('\n── Test 2: frontmatter de perfiles markdown ────────────'));
  const raw = [
    '---',
    'description: Revisa deudas técnicas en el repo',
    'mode: fast',
    'temperature: 0.4',
    'max_iterations: 10',
    'read_only: true',
    'tools_allow: [read, grep, glob]',
    'tools_deny: exec',
    '---',
    'Cuerpo de instrucciones.',
  ].join('\n');
  const { meta, body } = _parseFrontmatter(raw);
  assertEqual(meta.description, 'Revisa deudas técnicas en el repo', 'description');
  assertEqual(meta.mode, 'fast', 'mode');
  assertEqual(meta.temperature, 0.4, 'temperature');
  assertEqual(meta.max_iterations, 10, 'max_iterations');
  assertEqual(meta.readOnly, true, 'read_only → readOnly true');
  assert(
    Array.isArray(meta.tools_allow) && meta.tools_allow.length === 3,
    'tools_allow JSON array'
  );
  assert(Array.isArray(meta.tools_deny) && meta.tools_deny[0] === 'exec', 'tools_deny JSON array');
  assertEqual(body, 'Cuerpo de instrucciones.', 'body del markdown');
}

// ── Test 3: carga desde directorio (proyecto + global) ───────────────────────
function testDirLoading() {
  console.log(C.bold('\n── Test 3: carga desde .kaoru/subagents ────────────────'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoru-subagents-'));
  fs.writeFileSync(
    path.join(dir, 'revisor.md'),
    [
      '---',
      'description: Revisa el código de forma crítica',
      'mode: smart',
      'tools_deny: [git_push, web_search]',
      '---',
      'Revisa todo.',
    ].join('\n')
  );
  fs.writeFileSync(path.join(dir, 'mal.nombre.txt'), 'no markdown');
  const reg = new SubagentRegistry({ projectDir: dir });
  reg.load();
  const revisor = reg.resolve('revisor');
  assert(!!revisor, 'perfil de proyecto cargado');
  assertEqual(revisor.source, 'project', 'source = project');
  assertEqual(revisor.mode, 'smart', 'mode del markdown');
  assert(revisor.tools.deny.includes('git_push'), 'deny del markdown');
  assert(reg.resolve('mal') === null, 'archivo no-md ignorado');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Test 4: _toolAllowed (allow/deny/read_only) ──────────────────────────────
function testToolAllowed() {
  console.log(C.bold('\n── Test 4: allow/deny/read_only ────────────────────────'));
  const reg = new SubagentRegistry();
  reg.load();
  const explorador = reg.resolve('explorador');
  const investigador = reg.resolve('investigador');
  const general = reg.resolve('general');
  assert(_toolAllowed(explorador, 'read') === true, 'explorador: read permitido');
  assert(_toolAllowed(explorador, 'grep') === true, 'explorador: grep permitido');
  assert(_toolAllowed(explorador, 'write') === false, 'explorador: write bloqueado (deny)');
  assert(_toolAllowed(explorador, 'exec') === false, 'explorador: exec bloqueado (deny)');
  assert(_toolAllowed(explorador, 'web_search') === false, 'explorador: web_search bloqueado');
  assert(_toolAllowed(investigador, 'web_search') === true, 'investigador: web_search permitido');
  assert(_toolAllowed(investigador, 'write') === false, 'investigador: write bloqueado');
  assert(_toolAllowed(investigador, 'exec') === false, 'investigador: exec bloqueado');
  assert(_toolAllowed(general, 'write') === true, 'general: write permitido');
  assert(_toolAllowed(general, 'exec') === true, 'general: exec permitido');
  assert(_toolAllowed(general, 'git_push') === true, 'general: git_push permitido');
}

// ── Test 5: globs ────────────────────────────────────────────────────────────
function testGlobs() {
  console.log(C.bold('\n── Test 5: coincidencia por glob ───────────────────────'));
  assert(_matchesGlob('*', 'anything') === true, 'glob * matchea todo');
  assert(_matchesGlob('read_*', 'read_file') === true, 'prefijo read_*');
  assert(_matchesGlob('read_*', 'write_file') === false, 'read_* no matchea write_file');
  assert(_matchesGlob('git_commit', 'git_commit') === true, 'exacta');
  assert(_matchesGlob('', 'x') === false, 'patrón vacío no matchea');
}

// ── Test 6: built-ins no se rompen por el gate read_only ─────────────────────
function testReadOnlyMutatorSet() {
  console.log(C.bold('\n── Test 6: mutadores excluidos en read_only ────────────'));
  const reg = new SubagentRegistry();
  reg.load();
  const investigador = reg.resolve('investigador');
  for (const t of ['edit', 'edit_file', 'apply_patch', 'git_commit', 'git_push', 'rename']) {
    assert(_toolAllowed(investigador, t) === false, `investigador bloquea ${t}`);
  }
}

console.log(C.bold('═══════════ SubagentRegistry ═══════════'));
testBuiltins();
testFrontmatter();
testDirLoading();
testToolAllowed();
testGlobs();
testReadOnlyMutatorSet();
console.log(
  C.bold(`\n── SubagentRegistry: ${C.green(passed)}✓ ${failed ? C.red(failed + '✗') : ''} ──`)
);
console.log(`Resultado: ${passed} passed ${failed} failed / ${passed + failed} total`);
if (failed > 0) process.exitCode = 1;
