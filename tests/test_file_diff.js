'use strict';

/**
 * test_file_diff.js — FileDiff (core/git): vista previa de diff para
 * write/edit/apply_patch SIN mutar el disco.
 *
 * Cubre la matriz pedida: 3 tools × estados (diff calculable, null por
 * ambigüedad/no-aplica, archivo nuevo vs existente).
 *
 * Correr como las demás suites (Node de Electron):
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron tests/test_file_diff.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

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

const { computeDiffPreview, MUTATOR_TOOLS } = require('../core/git/FileDiff.js');

const tempDirs = [];

function mkTmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

// ── Suite ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${C.bold('FileDiff — vista previa de diff de mutaciones')}\n`);

  const cwd = mkTmpDir('file-diff-');
  const file = path.join(cwd, 'src', 'file.js');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'const a = 1;\nconst b = 2;\nconst c = 3;\n', 'utf-8');

  // ── write ─────────────────────────────────────────────────────────────────
  console.log(`\n${C.bold('write')}`);

  // write a archivo NUEVO: oldContent = '', todo adición.
  const newFile = path.join(cwd, 'new.js');
  const wNew = computeDiffPreview({
    tool: 'write',
    params: { path: newFile, content: 'x = 1;\n' },
    cwd,
  });
  assert(wNew !== null, 'write a archivo nuevo → diff calculable');
  assert(wNew && wNew.oldContent === '', 'write nuevo: oldContent vacío (no trata como existente)');
  assert(
    wNew && wNew.added === 1 && wNew.removed === 0,
    `write nuevo: +1/−0 (got +${wNew.added}/−${wNew.removed})`
  );
  assert(!fs.existsSync(newFile), 'write nuevo: NO muta el disco');

  // write a archivo EXISTENTE que se sobrescribe entero: oldContent es el
  // contenido real del disco y el diff muestra TODO lo que se pierde.
  const wOver = computeDiffPreview({
    tool: 'write',
    params: { path: file, content: 'const z = 9;\n' },
    cwd,
  });
  assert(wOver !== null, 'write sobre archivo existente → diff calculable');
  assert(
    wOver && wOver.oldContent === 'const a = 1;\nconst b = 2;\nconst c = 3;\n',
    "write existente: oldContent = contenido real del disco (no '' ni contenido nuevo)"
  );
  assert(
    wOver && wOver.newContent === 'const z = 9;\n',
    'write existente: newContent = contenido nuevo'
  );
  assert(
    wOver && wOver.removed === 3,
    `write existente: se marcan las 3 líneas perdidas (got −${wOver.removed})`
  );
  assert(
    wOver && wOver.patch.includes('-const a = 1;') && wOver.patch.includes('+const z = 9;'),
    'write existente: patch contiene lo borrado y lo nuevo'
  );
  assert(
    fs.readFileSync(file, 'utf-8') === 'const a = 1;\nconst b = 2;\nconst c = 3;\n',
    'write existente: disco intacto'
  );

  // write sin content → null (no calculable).
  const wNoContent = computeDiffPreview({ tool: 'write', params: { path: file }, cwd });
  assert(wNoContent === null, 'write sin content → null');

  // ── edit ──────────────────────────────────────────────────────────────────
  console.log(`\n${C.bold('edit')}`);

  const eOk = computeDiffPreview({
    tool: 'edit',
    params: { path: file, old_text: 'const b = 2;', new_text: 'const b = 42;' },
    cwd,
  });
  assert(eOk !== null, 'edit con old_text único → diff calculable');
  assert(
    eOk && eOk.added === 1 && eOk.removed === 1,
    `edit: +1/−1 (got +${eOk.added}/−${eOk.removed})`
  );
  assert(eOk && eOk.newContent.includes('const b = 42;'), 'edit: newContent tiene el reemplazo');
  assert(
    fs.readFileSync(file, 'utf-8') === 'const a = 1;\nconst b = 2;\nconst c = 3;\n',
    'edit: disco intacto'
  );

  // edit ambiguo (old_text repetido) → null, no es error.
  const eAmb = computeDiffPreview({
    tool: 'edit',
    params: { path: file, old_text: 'const ', new_text: 'let ' },
    cwd,
  });
  assert(eAmb === null, 'edit ambiguo (old_text repetido) → null explícito');

  // edit con old_text inexistente → null.
  const eMiss = computeDiffPreview({
    tool: 'edit',
    params: { path: file, old_text: 'no existe', new_text: 'x' },
    cwd,
  });
  assert(eMiss === null, 'edit con old_text ausente → null');

  // edit a archivo inexistente → null (no hay "antes" que editar).
  const eMissing = computeDiffPreview({
    tool: 'edit',
    params: { path: path.join(cwd, 'nope.js'), old_text: 'x', new_text: 'y' },
    cwd,
  });
  assert(eMissing === null, 'edit a archivo inexistente → null');

  // ── apply_patch ───────────────────────────────────────────────────────────
  console.log(`\n${C.bold('apply_patch')}`);

  const goodPatch = `--- a/file.js\n+++ b/file.js\n@@ -1,3 +1,3 @@\n const a = 1;\n-const b = 2;\n+const b = 42;\n const c = 3;\n`;
  const pOk = computeDiffPreview({
    tool: 'apply_patch',
    params: { path: file, patch: goodPatch },
    cwd,
  });
  assert(pOk !== null, 'apply_patch que aplica → diff calculable');
  assert(
    pOk && pOk.added === 1 && pOk.removed === 1,
    `apply_patch: +1/−1 (got +${pOk.added}/−${pOk.removed})`
  );
  assert(
    fs.readFileSync(file, 'utf-8') === 'const a = 1;\nconst b = 2;\nconst c = 3;\n',
    'apply_patch: disco intacto'
  );

  // patch que NO aplica (contexto no coincide) → null explícito.
  const badPatch = `--- a/file.js\n+++ b/file.js\n@@ -1,3 +1,3 @@\n AAA\n-BBB\n+CCC\n DDD\n`;
  const pBad = computeDiffPreview({
    tool: 'apply_patch',
    params: { path: file, patch: badPatch },
    cwd,
  });
  assert(pBad === null, 'apply_patch que no aplica → null');

  // apply_patch sin patch → null.
  const pNoPatch = computeDiffPreview({ tool: 'apply_patch', params: { path: file }, cwd });
  assert(pNoPatch === null, 'apply_patch sin patch → null');

  // ── Guardas ───────────────────────────────────────────────────────────────
  console.log(`\n${C.bold('guardas')}`);

  assert(
    MUTATOR_TOOLS.has('write') && MUTATOR_TOOLS.has('edit') && MUTATOR_TOOLS.has('apply_patch'),
    'MUTATOR_TOOLS exportado'
  );
  assert(
    computeDiffPreview({ tool: 'exec', params: { command: 'ls' }, cwd }) === null,
    'tool no mutadora → null'
  );
  assert(computeDiffPreview({ tool: 'write', params: {}, cwd }) === null, 'sin path → null');
  assert(
    computeDiffPreview({ tool: 'write', params: { path: 'x.js', content: 'a\n' } }) !== null,
    'path relativo resuelto contra cwd por defecto'
  );

  console.log(`\n${C.bold(`Resumen: ${passed} ✓ / ${failed} ✗`)}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(C.red('ERROR en suite:'), e);
  process.exit(1);
});
