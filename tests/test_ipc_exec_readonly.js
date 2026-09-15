'use strict';

const assert = require('assert');
const Module = require('module');
const { EventEmitter } = require('events');

const ipcMain = new EventEmitter();
const handlers = new Map();
ipcMain.handle = (name, handler) => handlers.set(name, handler);

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { ipcMain };
  return originalLoad.call(this, request, parent, isMain);
};
try {
  require('../ipc/init-vectors-handlers.js').register({});
} finally {
  Module._load = originalLoad;
}

(async () => {
  const execCommand = handlers.get('exec-command');
  assert.strictEqual(typeof execCommand, 'function', 'exec-command handler exists');
  const reset = await execCommand({}, { command: 'git reset --soft HEAD~1', timeout: 5 });
  assert.strictEqual(reset.exitCode, 1, 'git mutation is rejected before execution');
  assert(reset.stderr.includes('no permitido'), 'denial is explicit');

  const invalid = await execCommand(
    {},
    { command: 'git log --oneline -1; git reset --soft HEAD~1' }
  );
  assert.strictEqual(invalid.exitCode, 1, 'shell chaining cannot enter the allowlist');

  const history = await execCommand({}, { command: 'git log --oneline -1', timeout: 5 });
  assert.strictEqual(history.exitCode, 0, 'read-only Git history remains available');
  assert(history.stdout.trim(), 'history returns the latest commit');

  console.log('Resultado: 5 passed  0 failed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
