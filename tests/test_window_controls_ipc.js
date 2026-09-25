'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');

const listeners = new Map();
const handlers = new Map();
let quitCalls = 0;
const electronMock = {
  app: { quit: () => quitCalls++ },
  ipcMain: {
    on: (channel, listener) => listeners.set(channel, listener),
    handle: (channel, handler) => handlers.set(channel, handler),
  },
};
const originalLoad = Module._load;
Module._load = function mockLoad(request, parent, isMain) {
  if (request === 'electron') return electronMock;
  return originalLoad.call(this, request, parent, isMain);
};
let register;
try {
  ({ register } = require('../ipc/window-model-handlers.js'));
} finally {
  Module._load = originalLoad;
}

const calls = { minimize: 0, maximize: 0, unmaximize: 0 };
let maximized = false;
const webContents = {};
const chatWindow = {
  webContents,
  isDestroyed: () => false,
  isMaximized: () => maximized,
  minimize: () => calls.minimize++,
  maximize: () => {
    calls.maximize++;
    maximized = true;
  },
  unmaximize: () => {
    calls.unmaximize++;
    maximized = false;
  },
};
register({
  S: { chatWindow, mainWindow: null, activeModelId: '' },
  savedConfig: {},
  loadConfig: () => ({}),
  saveConfig: () => {},
  sendToChat: () => {},
});

const control = listeners.get('chat-window-control');
assert.equal(typeof control, 'function');
control({ sender: {} }, 'minimize');
assert.equal(calls.minimize, 0, 'otro renderer no puede controlar la ventana del chat');
control({ sender: webContents }, 'unknown');
assert.deepEqual(calls, { minimize: 0, maximize: 0, unmaximize: 0 });
control({ sender: webContents }, 'minimize');
control({ sender: webContents }, 'maximize');
assert.equal(calls.minimize, 1);
assert.equal(calls.maximize, 1);
control({ sender: webContents }, 'maximize');
assert.equal(calls.unmaximize, 1);
listeners.get('chat-close')({ sender: {} });
assert.equal(quitCalls, 0, 'otro renderer no puede cerrar la app');
listeners.get('chat-close')({ sender: webContents });
assert.equal(quitCalls, 1, 'cerrar conserva la salida existente de la app');
console.log('Window controls IPC: minimizar, maximizar/restaurar y cerrar correctos.');
