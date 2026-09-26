'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StateGraph } = require('../core/state-graph/StateGraph.js');
const { SessionManager } = require('../core/state-graph/SessionManager.js');
const Database = require('better-sqlite3');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoru-conversations-'));
const workspaceA = path.join(dir, 'project-a');
const workspaceB = path.join(dir, 'project-b');
fs.mkdirSync(workspaceA);
fs.mkdirSync(workspaceB);

let graph;
try {
  graph = new StateGraph(path.join(dir, 'memory.db')).init();
  assert.strictEqual(graph.usingFallback, false, 'la suite necesita SQLite persistente');
  const manager = new SessionManager(graph, null);
  const first = manager.startNew(workspaceA);
  assert.strictEqual(graph._sessions.getSession(first.sessionId).workspace, workspaceA);

  for (let index = 0; index < 45; index++) manager.addTurn('user', `turno ${index}`);
  const firstRow = graph._sessions.getSession(first.sessionId);
  assert.strictEqual(
    JSON.parse(firstRow.history_json).length,
    45,
    'el historial visible persiste completo'
  );
  assert.strictEqual(manager.getHistory().length, 40, 'el contexto interno conserva su límite');
  graph.endSession(first.sessionId, { turnCount: 45 });

  const second = manager.startNew(workspaceB);
  manager.addTurn('user', 'mensaje del segundo proyecto');
  graph.endSession(second.sessionId, { turnCount: 1 });

  const rows = graph._sessions.listConversations();
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows.find((row) => row.id === first.sessionId).workspace, workspaceA);
  assert.strictEqual(rows.find((row) => row.id === second.sessionId).workspace, workspaceB);

  const abandoned = graph._sessions.startSession(workspaceA);
  assert.strictEqual(graph._sessions.deleteEmptyConversation(abandoned), true);
  assert.strictEqual(
    graph._sessions.getSession(abandoned),
    null,
    'el chat sin mensajes se elimina'
  );
  assert.strictEqual(
    graph._sessions.deleteEmptyConversation(first.sessionId),
    false,
    'un chat con historial nunca se elimina como vacío'
  );
  const orphan = graph._sessions.startSession(workspaceB);
  const activeDraft = graph._sessions.startSession(workspaceA);
  graph._sessions.pruneEmptyConversations(activeDraft);
  assert.strictEqual(
    graph._sessions.getSession(orphan),
    null,
    'se limpian borradores de un cierre brusco'
  );
  assert(graph._sessions.getSession(activeDraft), 'se conserva el borrador activo');
  assert.strictEqual(graph._sessions.deleteEmptyConversation(activeDraft), true);

  const reopened = manager.openExisting(firstRow);
  assert.strictEqual(reopened.sessionId, first.sessionId);
  assert.strictEqual(manager.getHistory()[0].content, 'turno 5');
  manager.addTurn('user', 'mensaje nuevo');
  const updated = graph._sessions.getSession(first.sessionId);
  assert.strictEqual(updated.ended_at, null);
  assert.strictEqual(updated.workspace, workspaceA);
  assert.strictEqual(JSON.parse(updated.history_json).length, 46);
  const snapshot = Array.from({ length: 45 }, (_, index) => ({
    role: 'user',
    content: `snapshot ${index}`,
  }));
  const restored = manager.restore(snapshot, first.sessionId);
  assert.strictEqual(restored.turnCount, 45);
  assert.strictEqual(manager.getHistory()[0].seq, 6);

  graph.close();
  graph = new StateGraph(path.join(dir, 'memory.db')).init();
  assert.strictEqual(graph._sessions.getSession(first.sessionId).workspace, workspaceA);
  assert.strictEqual(graph._sessions.listConversations().length, 2);
  graph.close();

  const oldDbPath = path.join(dir, 'old.db');
  const oldDb = new Database(oldDbPath);
  oldDb.exec(
    'CREATE TABLE sessions (id INTEGER PRIMARY KEY, started_at INTEGER NOT NULL, ended_at INTEGER, summary TEXT, turn_count INTEGER DEFAULT 0, episode_id INTEGER, history_json TEXT)'
  );
  oldDb
    .prepare('INSERT INTO sessions (id, started_at, ended_at, history_json) VALUES (1, ?, ?, ?)')
    .run(Date.now(), Date.now(), '[{"role":"user","content":"chat antiguo"}]');
  oldDb.close();
  graph = new StateGraph(oldDbPath).init();
  const legacy = graph._sessions.getSession(1);
  assert.strictEqual(
    legacy.workspace,
    null,
    'las sesiones antiguas conservan workspace desconocido'
  );
  assert.strictEqual(graph._sessions.listConversations().length, 1);
  console.log('Conversaciones: workspace, historial completo y reapertura persistente OK');
} finally {
  graph?.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
