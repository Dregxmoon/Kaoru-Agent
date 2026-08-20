'use strict';

// // @ts-check
// Test de los helpers cross-platform de URIs file:// en LSPManager.
// En Windows una ruta `C:\Users\x\main.ts` DEBE convertirse a
// `file:///C:/Users/x/main.ts` (triple slash + forward slashes); con el viejo
// `file://${path}` se producía `file://C:\Users\x\main.ts`, URI inválido que
// tsserver rechaza (esto rompía el LSP entero en Windows). Se simula
// process.platform='win32' para verificar el formato sin una máquina Windows.

const { _toFileUri, _fromFileUri } = require('../core/lsp/LSPManager.js');

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
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

const ORIGINAL_PLATFORM = process.platform;

function withPlatform(platform, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    Object.defineProperty(process, 'platform', { value: platform });
    return fn();
  } finally {
    if (original) Object.defineProperty(process, 'platform', original);
    else delete process.platform;
  }
}

// NOTA: path.resolve() depende del platform actual; con win32 resuelto
// internamente por Node usa separadores de Windows si el path ya los tiene.
function testToFileUri() {
  console.log(C.bold('\n── _toFileUri: formato de URI cross-platform ────────────────────'));

  // Caso Linux (comportamiento real en este runner)
  withPlatform('linux', () => {
    const uri = _toFileUri('/tmp/lsp-tests-ws/main.ts');
    assert(uri === 'file:///tmp/lsp-tests-ws/main.ts', 'linux: file:// + path absoluto', uri);
  });

  // Caso Windows: drive + backslashes → file:///C:/Users/... (forward slashes)
  withPlatform('win32', () => {
    const uri = _toFileUri('C:\\Users\\panfilo\\repo\\src\\main.ts');
    assert(
      uri === 'file:///C:/Users/panfilo/repo/src/main.ts',
      'win32: file:/// + drive + forward slashes',
      uri
    );
    assert(!uri.includes('\\'), 'win32: sin backslashes en el URI', uri);
    assert(uri.startsWith('file:///'), 'win32: triple slash inicial', uri);
  });

  // Ruta sin drive (UNC o relativa a un drive) → sigue siendo válida
  withPlatform('win32', () => {
    const uri = _toFileUri('C:\\\\repo\\x.ts');
    assert(uri.startsWith('file:///'), 'win32: ruta con drive escapado sigue siendo válida', uri);
  });
}

function testFromFileUri() {
  console.log(C.bold('\n── _fromFileUri: vuelta del URI a ruta local ─────────────────────'));

  withPlatform('linux', () => {
    const p = _fromFileUri('file:///tmp/lsp-tests-ws/main.ts');
    assert(p === '/tmp/lsp-tests-ws/main.ts', 'linux: recupera el path absoluto', p);
  });

  withPlatform('win32', () => {
    const p = _fromFileUri('file:///C:/Users/panfilo/repo/src/main.ts');
    assert(
      p === 'C:\\Users\\panfilo\\repo\\src\\main.ts',
      'win32: recupera drive + backslashes',
      p
    );
  });

  withPlatform('win32', () => {
    const p = _fromFileUri('file:///C:/Users/x/archivo%20con%20espacio.ts');
    assert(p === 'C:\\Users\\x\\archivo con espacio.ts', 'win32: decodifica %20', p);
  });
}

function testRoundTrip() {
  console.log(C.bold('\n── round-trip: to → from es estable en Windows ───────────────────'));
  withPlatform('win32', () => {
    const original = 'C:\\Users\\panfilo\\repo\\src\\main.ts';
    const uri = _toFileUri(original);
    const back = _fromFileUri(uri);
    assert(back === original, 'toFileUri(fromFileUri(x)) === x en Windows', `${uri} → ${back}`);
  });
}

function main() {
  console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
  console.log(C.bold(C.cyan('  Test Suite: helpers URI file:// cross-platform (LSP)')));
  console.log(C.bold(C.cyan('════════════════════════════════════════════════════════')));

  testToFileUri();
  testFromFileUri();
  testRoundTrip();

  const total = passed + failed;
  console.log(C.bold('\n════════════════════════════════════════════════════════'));
  console.log(
    C.bold(
      `  Resultado: ${C.green(passed + ' passed')}  ${failed > 0 ? C.red(failed + ' failed') : C.dim('0 failed')}  / ${total} total`
    )
  );
  console.log(C.bold('════════════════════════════════════════════════════════\n'));
  if (failed > 0) process.exit(1);
}

main();
