// @ts-check
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StateGraph } = require('../core/state-graph/StateGraph');
const explorer = require('../core/memory/MemoryExplorer');
const { isRealIdentityNode, getMemoryGaps } = require('../core/core/misc');
const state = require('../core/core/state');
const { GroqSerializer } = require('../core/grounding/serializers/GroqSerializer');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoru-explorer-test-'));
const graph = new StateGraph(path.join(dir, 'memory.db')).init();
const previous = state.graph;
try {
  state.graph = graph;
  const id = graph.createNode({
    type: 'Preference',
    label: 'preferencia_terminal',
    content: 'Prefiere Warp en Arch Linux',
    importance: 0.8,
  });
  const episode = graph.createNode({
    type: 'Episode',
    label: 'sesion',
    content: 'Instaló Warp para trabajar en Kaoru',
    importance: 0.8,
  });
  const obs = graph.recordObservation({
    source: 'chat',
    kind: 'user_message',
    content: 'Uso Warp',
    sessionId: 'session-a',
  });
  graph.linkMemoryEvidence(id, [obs], 1);
  graph.linkMemoryEvidence(episode, [obs], 1);
  const before = graph.getNode(id);
  const inventory = explorer.inventory(graph, isRealIdentityNode);
  assert.equal(inventory.nodes.length, 2);
  assert(inventory.edges.some((e) => e.category === 'conversation'));
  assert.equal(graph.getNode(id).last_accessed_at, before.last_accessed_at);
  assert.equal(graph.getNode(id).access_count, before.access_count);
  assert(
    explorer.pin(graph, { nodeId: id, pinned: true, expectedUpdatedAt: before.updated_at }).ok
  );
  assert.equal(
    explorer.pin(graph, { nodeId: id, pinned: false, expectedUpdatedAt: before.updated_at }).error,
    'memory_changed'
  );
  graph._db.prepare('UPDATE nodes SET last_accessed_at=?,importance=.01 WHERE id=?').run(1, id);
  graph.applyDecay();
  assert.equal(graph.getNode(id).archived, 0);
  assert(getMemoryGaps().some((g) => g.key === 'comida'));
  explorer.setGapPreference(graph, { key: 'comida', mode: 'never' });
  assert(!getMemoryGaps().some((g) => g.key === 'comida'));
  explorer.setGapPreference(graph, { key: 'ubicacion', mode: 'later' });
  assert(!getMemoryGaps().some((g) => g.key === 'ubicacion'));
  graph._db
    .prepare('UPDATE memory_gap_preferences SET until_at=1 WHERE gap_key=?')
    .run('ubicacion');
  assert(getMemoryGaps().some((g) => g.key === 'ubicacion'));
  explorer.setGapPreference(graph, { key: 'comida', mode: 'ask' });
  assert(getMemoryGaps().some((g) => g.key === 'comida'));
  assert.equal(explorer.setGapPreference(graph, { key: 'x', mode: 'bad' }).ok, false);
  const ctx = {
    persistentMemory: { nodes: [{ id: 7, type: 'User', content: 'Un hecho trazable' }] },
  };
  const serializer = new GroqSerializer();
  assert.deepEqual(serializer.serialize(ctx, { includeMemory: false }).memoryReferences, []);
  const serialized = serializer.serialize(ctx, { includeMemory: true });
  assert.equal(serialized.memoryReferences[0].id, 7);
  assert(serialized.systemPrompt.includes(serialized.memoryReferences[0].line));
  // Exercise the actual inventory cap with thousands of nodes, without embeddings.
  const insert = graph._db.prepare(
    "INSERT INTO nodes(type,label,content,importance,tags,created_at,updated_at,last_accessed_at) VALUES('Episode',?,?,.5,'[]',1,1,1)"
  );
  graph._db.transaction(() => {
    for (let i = 0; i < 10005; i++) insert.run('episode_' + i, 'Memoria de prueba ' + i);
  })();
  const large = explorer.inventory(graph, isRealIdentityNode);
  assert.equal(large.nodes.length, 10000);
  assert.equal(large.truncated, true);
  assert(large.edges.length < 50000, 'sparse connections stay bounded');
  console.log(
    'Memory Explorer: inventory, attribution, consent, pinning, concurrency and 10k scale passed.'
  );
} finally {
  state.graph = previous;
  graph.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
