'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const { assertAllowed } = require('../ipc/channel-whitelist.js');

const listeners = new Map();
const handlers = new Map();
let service;
class FakeTerminalService {
  constructor(options) {
    this.options = options;
    this.flow = [];
    this.writes = [];
    service = this;
  }
  open(id, workspace) {
    return { id, workspace, scrollback: '', seq: 0 };
  }
  write(id, data) {
    this.writes.push({ id, data });
  }
  resize() {}
  setFlow(id, paused) {
    this.flow.push({ id, paused });
  }
}
const originalLoad = Module._load;
Module._load = function mockLoad(request, parent, isMain) {
  if (request === 'electron')
    return {
      ipcMain: {
        on: (channel, listener) => listeners.set(channel, listener),
        handle: (channel, handler) => handlers.set(channel, handler),
      },
    };
  if (request === '../core/terminal/TerminalService.js')
    return { TerminalService: FakeTerminalService };
  return originalLoad.call(this, request, parent, isMain);
};
let register;
try {
  ({ register } = require('../ipc/terminal-handlers.js'));
} finally {
  Module._load = originalLoad;
}

const sent = [];
const webContents = { send: (channel, payload) => sent.push({ channel, payload }) };
let active = { id: 7, type: 'terminal', workspace: '/tmp' };
register({
  S: { chatWindow: { webContents, isDestroyed: () => false } },
  Core: {
    activeConversation: () => active,
    getGraph: () => ({
      _sessions: {
        getSession: (id) =>
          id === 7
            ? { id, session_type: 'terminal', workspace: '/tmp' }
            : { id, session_type: 'terminal', workspace: '/other' },
      },
    }),
  },
  sendTerminalGesture: () => {},
});
assertAllowed('send', 'terminal-flow');
const flow = listeners.get('terminal-flow');
assert.equal(typeof flow, 'function');
flow({ sender: {} }, { id: 7, paused: true });
flow({ sender: webContents }, { id: 8, paused: true });
flow({ sender: webContents }, { id: -1, paused: true });
flow({ sender: webContents }, { id: 7, paused: 'yes' });
assert.deepEqual(service.flow, [], 'no se acepta pausar desde otra ventana o sesión');
flow({ sender: webContents }, { id: 7, paused: true });
active = null;
flow({ sender: webContents }, { id: 7, paused: false });
assert.deepEqual(service.flow, [
  { id: 7, paused: true },
  { id: 7, paused: false },
]);
service.options.send('terminal-data', { id: 8, data: 'oculto' });
assert.equal(sent.length, 0, 'la salida inactiva no cruza IPC');
active = { id: 7, type: 'terminal', workspace: '/tmp' };
service.options.send('terminal-data', { id: 7, data: 'visible' });
assert.equal(sent.length, 1);
active = { id: 20, type: 'chat', workspace: '/tmp' };
assert.equal(handlers.get('terminal-open')({ sender: webContents }, { id: 8 }).ok, false);
assert.equal(handlers.get('terminal-open')({ sender: webContents }, { id: 7 }).ok, true);
listeners.get('terminal-write')({ sender: webContents }, { id: 7, data: 'echo test' });
listeners.get('terminal-write')({ sender: webContents }, { id: 8, data: 'denegado' });
assert.deepEqual(service.writes, [{ id: 7, data: 'echo test' }]);
service.options.send('terminal-data', { id: 7, data: 'compañera' });
assert.equal(sent.length, 2, 'el chat vinculado recibe solo su terminal');
active = { id: 21, type: 'chat', workspace: '/other' };
service.options.send('terminal-data', { id: 7, data: 'oculto' });
assert.equal(sent.length, 2, 'el cambio de workspace revoca la salida');
console.log('Terminal flow IPC: autorización y salida activa OK');
