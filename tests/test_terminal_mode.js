'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StateGraph } = require('../core/state-graph/StateGraph.js');
const { TerminalService } = require('../core/terminal/TerminalService.js');

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoru-terminal-'));
  const graph = new StateGraph(path.join(dir, 'state.db')).init();
  let service;
  try {
    const store = graph._sessions;
    const id = store.startTerminal(dir);
    assert.strictEqual(store.getSession(id).session_type, 'terminal');
    assert.strictEqual(store.deleteEmptyConversation(id), true);

    const activeId = store.startTerminal(dir);
    const output = [];
    const gestures = [];
    service = new TerminalService({
      send: (channel, payload) => {
        if (channel === 'terminal-data' && payload.id === activeId) output.push(payload.data);
      },
      onActivity: (changedId) => store.markTerminalActivity(changedId),
      onGesture: (mood) => gestures.push(mood),
    });
    const opened = service.open(activeId, dir, { cols: 80, rows: 24 });
    assert.strictEqual(opened.id, activeId);
    assert(opened.shell);
    assert.strictEqual(service.write(activeId + 1, 'echo incorrecto\r'), false);
    assert.strictEqual(service.write(activeId, 'echo KAORU_TERMINAL_OK\r'), true);
    const deadline = Date.now() + 15000;
    while (
      (output.join('').match(/KAORU_TERMINAL_OK/g) || []).length < 2 &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert(
      (output.join('').match(/KAORU_TERMINAL_OK/g) || []).length >= 2,
      'el PTY entrega salida interactiva'
    );
    assert(store.getSession(activeId).terminal_activity > 0);
    assert.strictEqual(store.deleteEmptyConversation(activeId), false);
    assert.strictEqual(service.resize(activeId, 100, 30), true);
    service.write(activeId, "printf 'error: terminal probe\\n'\r");
    const gestureDeadline = Date.now() + 5000;
    while (!gestures.includes('sad') && Date.now() < gestureDeadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert(gestures.includes('sad'), 'la salida de error activa una reacción visual local');
    assert.strictEqual(service.close(activeId), true, 'se puede cerrar solo la terminal borrada');
    assert.strictEqual(service.write(activeId, 'echo cerrado\r'), false);
    assert.strictEqual(service.close(activeId), false);
    console.log('Modo Terminal: PTY interactivo, actividad y persistencia OK');
  } finally {
    service?.closeAll();
    graph.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
