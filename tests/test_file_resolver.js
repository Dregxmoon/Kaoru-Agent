'use strict';

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

const path = require('path');
const fs = require('fs');
const os = require('os');
const {
  resolveFileReferences,
  readFileContent,
  buildFileContext,
  listProjectFiles,
} = require('../core/commands/FileResolver.js');

// ── Test 1: resolveFileReferences ───────────────────────────────────────
function testResolveReferences() {
  const text = 'Revisa @src/main.js y @README.md por favor';
  const refs = resolveFileReferences(text, '/test');
  assert(refs.length === 2, 'Encuentra 2 referencias @');
  assert(refs[0].ref === 'src/main.js', 'Primera ref es src/main.js');
  assert(refs[1].ref === 'README.md', 'Segunda ref es README.md');
  assert(typeof refs[0].filePath === 'string', 'filePath es string');
}

// ── Test 2: resolveFileReferences sin coincidencias ─────────────────────
function testNoRefs() {
  const refs = resolveFileReferences('Hola mundo', '/test');
  assert(refs.length === 0, 'No encuentra refs en texto sin @');
}

// ── Test 3: resolveFileReferences solo @ sin path ───────────────────────
function testAtOnly() {
  const refs = resolveFileReferences('Hola @', '/test');
  assert(refs.length === 0, 'No encuentra ref cuando @ está solo');
}

// ── Test 4: readFileContent archivo existente ───────────────────────────
function testReadExisting() {
  const tmpFile = path.join(os.tmpdir(), `test-file-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, 'contenido de prueba', 'utf-8');
  const content = readFileContent(tmpFile);
  assert(content === 'contenido de prueba', 'Lee archivo existente');
  fs.unlinkSync(tmpFile);
}

// ── Test 5: readFileContent archivo inexistente ─────────────────────────
function testReadMissing() {
  const content = readFileContent('/ruta/inexistente/archivo.js');
  assert(content === null, 'Retorna null para archivo inexistente');
}

// ── Test 6: readFileContent archivo binario grande ──────────────────────
function testReadLarge() {
  const tmpFile = path.join(os.tmpdir(), `test-large-${Date.now()}.bin`);
  const largeBuf = Buffer.alloc(200 * 1024, 'x');
  fs.writeFileSync(tmpFile, largeBuf);
  const content = readFileContent(tmpFile);
  assert(content !== null, 'No retorna null para archivo grande');
  assert(content.includes('demasiado grande'), 'Indica que es demasiado grande');
  fs.unlinkSync(tmpFile);
}

// ── Test 7: buildFileContext sin referencias ────────────────────────────
function testBuildContextNoRefs() {
  const result = buildFileContext('Hola mundo', '/test');
  assert(result.text === 'Hola mundo', 'Texto sin cambios');
  assert(result.contexts.length === 0, 'Sin contextos');
}

// ── Test 8: buildFileContext con referencias válidas ────────────────────
function testBuildContextWithRefs() {
  const tmpDir = path.join(os.tmpdir(), `test-bc-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'test.js'), 'console.log("hola");', 'utf-8');
  fs.writeFileSync(path.join(tmpDir, 'datos.json'), '{"ok":true}', 'utf-8');

  const text = 'Mira @test.js y @datos.json';
  const result = buildFileContext(text, tmpDir);
  assert(result.text === text, 'Texto original preservado');
  assert(result.contexts.length === 2, 'Dos contextos encontrados');
  assert(result.contexts[0].path.endsWith('test.js'), 'Primer path es test.js');
  assert(result.contexts[1].path.endsWith('datos.json'), 'Segundo path es datos.json');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── Test 9: buildFileContext con referencias repetidas ──────────────────
function testBuildContextDedup() {
  const tmpDir = path.join(os.tmpdir(), `test-bc-dedup-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'test.js'), 'x', 'utf-8');

  const text = 'Mira @test.js y otra vez @test.js';
  const result = buildFileContext(text, tmpDir);
  assert(result.contexts.length === 1, 'Deduplica referencias repetidas');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── Test 10: listProjectFiles ───────────────────────────────────────────
function testListFiles() {
  const tmpDir = path.join(os.tmpdir(), `test-ls-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'src', 'index.js'), '// ok', 'utf-8');
  fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Hola', 'utf-8');
  fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules', 'utf-8');

  const files = listProjectFiles(tmpDir);
  assert(files.length > 0, 'Lista archivos del proyecto');
  assert(
    files.some((f) => f.path === 'src/index.js'),
    'Incluye src/index.js'
  );
  assert(
    files.some((f) => f.name === 'README.md'),
    'Incluye README.md'
  );
  assert(
    files.every((f) => !f.path.includes('.gitignore')),
    'Excluye .gitignore'
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── Test 11: listProjectFiles con filtro ────────────────────────────────
function testListFilesFilter() {
  const tmpDir = path.join(os.tmpdir(), `test-ls-filter-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'index.js'), '// ok', 'utf-8');
  fs.writeFileSync(path.join(tmpDir, 'styles.css'), 'body {}', 'utf-8');
  fs.writeFileSync(path.join(tmpDir, 'data.json'), '{}', 'utf-8');

  const files = listProjectFiles(tmpDir, 'index');
  assert(files.length > 0, 'Encuentra archivos con filtro');
  assert(
    files.every((f) => f.path.toLowerCase().includes('index')),
    'Todos los resultados contienen el filtro'
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── Test 12: listProjectFiles ignora node_modules ───────────────────────
function testListIgnoreNodeModules() {
  const tmpDir = path.join(os.tmpdir(), `test-ls-nm-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'node_modules', 'lodash.js'), '// big', 'utf-8');
  fs.writeFileSync(path.join(tmpDir, 'index.js'), '// ok', 'utf-8');

  const files = listProjectFiles(tmpDir);
  assert(!files.some((f) => f.path.includes('node_modules')), 'Excluye node_modules');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── Test 13: resolveFileReferences con rutas complejas ──────────────────
function testComplexPaths() {
  const text = 'Mira @./src/utils/helpers.js y @../docs/api.md';
  const refs = resolveFileReferences(text, '/proyecto');
  assert(refs.length === 1, 'El ref ../ que escapa del workspace NO se resuelve');
  assert(refs[0].ref === './src/utils/helpers.js', 'Path relativo con ./ se resuelve');
}

// ── Test 14: buildFileContext máximo 10 archivos ────────────────────────
function testMaxFiles() {
  const tmpDir = path.join(os.tmpdir(), `test-max-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const paths = [];
  for (let i = 0; i < 15; i++) {
    const p = path.join(tmpDir, `file${i}.js`);
    fs.writeFileSync(p, `// file ${i}`, 'utf-8');
    paths.push(p);
  }
  const text = Array.from({ length: 15 }, (_, i) => `@file${i}.js`).join(' ');
  const result = buildFileContext(text, tmpDir);
  assert(result.contexts.length <= 10, 'Máximo 10 archivos en contexto');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── Test 15: contención de path traversal (@../../etc/passwd) ────────────
function testContainTraversal() {
  const tmpDir = path.join(os.tmpdir(), `test-ct-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'ok.txt'), 'dentro', 'utf-8');

  const text = 'lee @../../../../etc/passwd';
  const result = buildFileContext(text, tmpDir);
  assert(result.contexts.length === 0, 'Traversal fuera del workspace NO se resuelve');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── Test 16: ref ../ que permanece DENTRO del workspace sí se resuelve ───
function testParentInside() {
  const tmpBase = path.join(os.tmpdir(), `test-pi-${Date.now()}`);
  const sub = path.join(tmpBase, 'sub');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(tmpBase, 'padre.txt'), 'arriba', 'utf-8');

  const result = buildFileContext('lee @../padre.txt', sub, tmpBase);
  assert(result.contexts.length === 1, '@../ dentro del workspace se resuelve');
  assert(
    result.contexts[0].fullPath === path.join(tmpBase, 'padre.txt'),
    'Resuelve al archivo padre dentro del workspace'
  );

  fs.rmSync(tmpBase, { recursive: true, force: true });
}

// ── Test 17: PathGuard isCwdAllowed rechaza cwd externo ─────────────────
function testCwdContained() {
  const PathGuard = require('../core/security/PathGuard.js');
  const tmpDir = path.join(os.tmpdir(), `test-cwd-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const outside = path.join(os.tmpdir(), `test-cwd-out-${Date.now()}`);
  fs.mkdirSync(outside, { recursive: true });

  assert(PathGuard.isCwdAllowed(tmpDir, tmpDir), 'cwd == root aceptado');
  assert(PathGuard.isCwdAllowed(path.join(tmpDir, 'sub'), tmpDir), 'subdirectorio aceptado');
  assert(!PathGuard.isCwdAllowed(outside, tmpDir), 'cwd fuera del root rechazado');
  assert(!PathGuard.isCwdAllowed('/', tmpDir), 'raíz del sistema rechazada');

  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
}

// ── Run ─────────────────────────────────────────────────────────────────
console.log(C.bold('\n📁 FileResolver Tests\n'));

testResolveReferences();
testNoRefs();
testAtOnly();
testReadExisting();
testReadMissing();
testReadLarge();
testBuildContextNoRefs();
testBuildContextWithRefs();
testBuildContextDedup();
testListFiles();
testListFilesFilter();
testListIgnoreNodeModules();
testComplexPaths();
testMaxFiles();
testContainTraversal();
testParentInside();
testCwdContained();

const total = passed + failed;
console.log(
  `\n${C.bold(C.cyan(`📁 FileResolver: ${passed}/${total} tests passed`))}${failed > 0 ? C.red(` (${failed} failed)`) : C.green(' ✅')}`
);
module.exports = { passed, failed };
