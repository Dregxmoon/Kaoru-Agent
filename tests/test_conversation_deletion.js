'use strict';

const assert = require('assert');
const state = require('../core/core/state.js');
const { deleteConversation } = require('../core/core/session.js');

async function main() {
  const previous = {
    graph: state.graph,
    session: state.session,
    activeTerminalId: state.activeTerminalId,
  };
  const rows = new Map([
    [1, { id: 1, session_type: 'chat', history_json: '[]', workspace: '/project' }],
    [2, { id: 2, session_type: 'terminal', history_json: '[]', workspace: '/project' }],
    [3, { id: 3, session_type: 'chat', history_json: '[]', workspace: '/project' }],
  ]);
  let chatId = 1;
  let closeCount = 0;
  try {
    state.graph = {
      _sessions: {
        getSession: (id) => rows.get(id) || null,
        deleteConversation: (id) => rows.delete(id),
      },
    };
    state.session = {
      getSessionId: () => chatId,
      close: async () => {
        closeCount++;
        chatId = null;
      },
    };
    state.activeTerminalId = null;

    assert.strictEqual((await deleteConversation(0)).ok, false);
    const inactive = await deleteConversation(3);
    assert.strictEqual(inactive.ok, true);
    assert.strictEqual(inactive.wasActive, false);
    assert.strictEqual(closeCount, 0);
    assert.strictEqual(inactive.conversation.id, 1);

    const activeChat = await deleteConversation(1);
    assert.strictEqual(activeChat.ok, true);
    assert.strictEqual(activeChat.wasActive, true);
    assert.strictEqual(activeChat.conversation, null);
    assert.strictEqual(closeCount, 1);
    assert.strictEqual(rows.has(1), false);

    state.activeTerminalId = 2;
    const activeTerminal = await deleteConversation(2);
    assert.strictEqual(activeTerminal.ok, true);
    assert.strictEqual(activeTerminal.wasActive, true);
    assert.strictEqual(state.activeTerminalId, null);
    assert.strictEqual(closeCount, 1);
    assert.strictEqual(rows.has(2), false);
    console.log('Borrado de conversaciones: activa, inactiva y terminal OK');
  } finally {
    state.graph = previous.graph;
    state.session = previous.session;
    state.activeTerminalId = previous.activeTerminalId;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
