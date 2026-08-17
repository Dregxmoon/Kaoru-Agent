// @ts-check
'use strict';
// Tests para scripts/link-asistente.js — el instalador del comando `asistente`
// que corre en el postinstall de npm. Se prueban las dos plataformas de forma
// simulada (posix → symlink; win32 → shims .cmd/.ps1/bash) contra un temp dir,
// sin tocar el bin real del sistema.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { installAsistente, _shimCmd, _shimPs1, _shimBash } = require('../scripts/link-asistente.js');

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

let tmpRoot;
let appRoot;
let binDir;

function setup() {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'link-asistente-test-'));
  appRoot = path.join(tmpRoot, 'app');
  binDir = path.join(tmpRoot, 'bin');
  fs.mkdirSync(path.join(appRoot, 'bin'), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(appRoot, 'bin', 'asistente.js'),
    '#!/usr/bin/env node\nconsole.log("asistente");\n',
    'utf8'
  );
}

function teardown() {
  if (tmpRoot) {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
    tmpRoot = null;
  }
}

function testPosixSymlink() {
  console.log(C.bold('\n── posix: symlink al binario + ejecutable ──────────────────────'));

  const created = installAsistente({ binDir, platform: 'linux', appRoot, log: () => {} });
  const linkPath = path.join(binDir, 'asistente');

  assert(created.length === 1 && created[0] === linkPath, 'crea una sola ruta (el symlink)');
  assert(fs.existsSync(linkPath), 'el symlink existe');
  assert(fs.lstatSync(linkPath).isSymbolicLink(), 'es un symlink (no una copia)');
  assert(
    fs.readlinkSync(linkPath) === path.join(appRoot, 'bin', 'asistente.js'),
    'apunta al binario real'
  );
  const mode = fs.statSync(path.join(appRoot, 'bin', 'asistente.js')).mode;
  assert((mode & 0o111) !== 0, 'el binario fuente quedó ejecutable', `mode=${mode.toString(8)}`);

  // Idempotente: re-instalar no lanza.
  installAsistente({ binDir, platform: 'linux', appRoot, log: () => {} });
  assert(fs.lstatSync(linkPath).isSymbolicLink(), 're-instalar no rompe el symlink');

  // Limpiar para el siguiente test.
  fs.unlinkSync(linkPath);
}

function testWindowsShims() {
  console.log(C.bold('\n── win32: shims .cmd + .ps1 + bash ─────────────────────────────'));

  const created = installAsistente({ binDir, platform: 'win32', appRoot, log: () => {} });
  const cmdPath = path.join(binDir, 'asistente.cmd');
  const ps1Path = path.join(binDir, 'asistente.ps1');
  const bashPath = path.join(binDir, 'asistente');

  assert(created.length === 3, 'crea 3 shims', JSON.stringify(created));
  assert(fs.existsSync(cmdPath), 'existe asistente.cmd');
  assert(fs.existsSync(ps1Path), 'existe asistente.ps1');
  assert(fs.existsSync(bashPath), 'existe asistente (bash)');

  const cmd = fs.readFileSync(cmdPath, 'utf8');
  assert(
    cmd.includes('node "') && cmd.includes('asistente.js') && cmd.includes('%*'),
    '.cmd invoca node con el binario y reenvía args'
  );

  const ps1 = fs.readFileSync(ps1Path, 'utf8');
  assert(ps1.includes('@args'), '.ps1 reenvía args en PowerShell');

  const bash = fs.readFileSync(bashPath, 'utf8');
  assert(bash.startsWith('#!/usr/bin/env bash') && bash.includes('"$@"'), 'shim bash reenvía args');

  // Idempotente.
  installAsistente({ binDir, platform: 'win32', appRoot, log: () => {} });
  assert(fs.existsSync(cmdPath), 're-instalar no rompe los shims');

  for (const p of created) fs.unlinkSync(p);
}

function testShimEscaping() {
  console.log(C.bold('\n── escapado de comillas en los shims ──────────────────────────'));

  const withQuotes = 'C:\\mi ruta con "comillas"\\asistente.js';
  const cmd = _shimCmd(withQuotes);
  assert(
    cmd.includes('node "C:\\mi ruta con ""comillas""\\asistente.js"'),
    '.cmd escapa comillas dobles'
  );
  const ps1 = _shimPs1(withQuotes);
  assert(ps1.includes('node "C:\\mi ruta con `"comillas`"\\asistente.js"'), '.ps1 escapa comillas');
  const bash = _shimBash(withQuotes);
  assert(
    bash.includes('node "C:\\mi ruta con \\"comillas\\"\\asistente.js"'),
    'bash escapa comillas'
  );
}

function testErrors() {
  console.log(C.bold('\n── errores: binDir inexistente / binario faltante ──────────────'));

  let threw1 = false;
  try {
    installAsistente({
      binDir: path.join(tmpRoot, 'no-existe'),
      platform: 'linux',
      appRoot,
      log: () => {},
    });
  } catch (e) {
    threw1 = true;
    assert(e.message.includes('no existe'), 'binDir inexistente → error claro', e.message);
  }
  assert(threw1, 'binDir inexistente lanza');

  const brokenApp = path.join(tmpRoot, 'app-sin-bin');
  fs.mkdirSync(path.join(brokenApp, 'bin'), { recursive: true });
  let threw2 = false;
  try {
    installAsistente({ binDir, platform: 'win32', appRoot: brokenApp, log: () => {} });
  } catch (e) {
    threw2 = true;
    assert(e.message.includes('no existe'), 'binario fuente faltante → error claro', e.message);
  }
  assert(threw2, 'binario fuente faltante lanza');
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log(C.bold('\n════════════════════════════════════════════════════════'));
console.log(C.bold(C.cyan('  March 7th — Test Suite: link-asistente (npm install)')));
console.log(C.bold('════════════════════════════════════════════════════════'));

setup();
try {
  testPosixSymlink();
  testWindowsShims();
  testShimEscaping();
  testErrors();
} finally {
  teardown();
}

console.log(C.bold('\n════════════════════════════════════════════════════════'));
const total = passed + failed;
console.log(
  `  Resultado: ${C.green(`${passed} passed`)}  ${failed === 0 ? C.bold('0 failed') : C.red(`${failed} failed`)}  / ${total} total`
);
console.log('════════════════════════════════════════════════════════');
process.exit(failed > 0 ? 1 : 0);
