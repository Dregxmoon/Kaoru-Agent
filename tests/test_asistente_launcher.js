// @ts-check
'use strict';

const path = require('path');
const {
  spawnElectron,
  resolveElectronBinary,
  isIntegratedTerminal,
} = require('../bin/asistente.js');

let passed = 0;
let failed = 0;

function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

const calls = [];
const fakeChild = { unref() {}, once() {} };
const fakeSpawn = (command, args, options) => {
  calls.push({ command, args, options });
  return fakeChild;
};

const appRoot = path.resolve('Caminos con espacios', 'Kaoru Agent');
const workspace = path.resolve('Workspace con espacios');
const child = spawnElectron(appRoot, workspace, fakeSpawn);
const call = calls[0];
const electron = resolveElectronBinary();

assert(child === fakeChild, 'devuelve el proceso creado');
assert(calls.length === 1, 'crea una sola instancia de Electron');
assert(call.command === electron, 'usa el binario real de Electron');
assert(
  call.args.join('|') === [appRoot, '--workspace', workspace].join('|'),
  'pasa el workspace por argv sin depender de la Control API'
);
assert(call.options.env.ASISTENTE_WORKSPACE === workspace, 'propaga el workspace por entorno');
assert(
  call.options.detached === true && call.options.windowsHide === true,
  'desacopla el launcher'
);
assert(call.options.stdio === 'ignore', 'devuelve el control a la terminal');

assert(isIntegratedTerminal({ KAORU_INTEGRATED_TERMINAL: '1' }), 'detecta la terminal de Kaoru');
assert(!isIntegratedTerminal({}), 'el lanzador externo conserva su comportamiento');

console.log(`Resultado: ${passed} passed  ${failed} failed  / ${passed + failed} total`);
process.exit(failed ? 1 : 0);
