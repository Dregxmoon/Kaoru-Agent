// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LLMProvider = require('../core/llm/LLMProvider.js');
const { RetrievalPlanner } = require('../core/grounding/RetrievalPlanner.js');
const { SessionManager } = require('../core/state-graph/SessionManager.js');
const { StateGraph } = require('../core/state-graph/StateGraph.js');
const { StateUpdater } = require('../core/state-graph/StateUpdater.js');
const { ResponseEvaluator } = require('../core/behavior/proactive/ResponseEvaluator.js');
const { ObservationBridge } = require('../core/perception/ObservationBridge.js');
const { EventBus } = require('../infrastructure/event-bus/EventBus.js');

let passed = 0;

/** @param {string} label */
function ok(label) {
  passed++;
  console.log(`  ✓ ${label}`);
}

/** @returns {{graph: StateGraph, dir: string}} */
function makeGraph() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-jarvis-'));
  return { graph: new StateGraph(path.join(dir, 'core.db')).init(), dir };
}

/** @param {Array<string>} prompts */
function mockLLM(prompts) {
  const originalComplete = LLMProvider.complete;
  const originalCompleteTask = LLMProvider.completeTask;
  const run = async (messages) => {
    prompts.push(String(messages?.[0]?.content || ''));
    return JSON.stringify({
      episode_summary: `Resumen ${prompts.length}`,
      episode_importance: 0.6,
      nodes: [],
      relations: [],
    });
  };
  LLMProvider.complete = run;
  LLMProvider.completeTask = run;
  return () => {
    LLMProvider.complete = originalComplete;
    LLMProvider.completeTask = originalCompleteTask;
  };
}

async function testIncrementalCursor() {
  const { graph, dir } = makeGraph();
  const prompts = [];
  const restore = mockLLM(prompts);
  try {
    const manager = new SessionManager(graph, {}, { incrementalEveryTurns: 4 });
    const started = await manager.start(null);
    manager.addTurn('user', 'Estoy construyendo la memoria de Kaoru');
    manager.addTurn('assistant', 'Entendido');
    manager.addTurn('user', 'Quiero que sobreviva a un cierre inesperado');
    manager.addTurn('assistant', 'Lo guardaré por lotes');
    await manager._incrementalPromise;

    const active = graph._db.prepare('SELECT * FROM sessions WHERE id=?').get(started.sessionId);
    assert.equal(active.memory_cursor, 4);
    assert.equal(active.ended_at, null);
    assert.equal(prompts.length, 1);
    ok('la memoria incremental avanza un cursor durable sin cerrar la sesión');

    const firstObservations = graph.listObservations({ sessionId: started.sessionId });
    assert.equal(firstObservations.length, 4);
    assert.ok(firstObservations.every((row) => row.processed_at));
    const firstEpisode = graph._db
      .prepare("SELECT id FROM nodes WHERE type='Episode' ORDER BY id LIMIT 1")
      .get();
    assert.equal(graph.getMemoryEvidence(firstEpisode.id).length, 4);
    assert.ok(graph.getObservationStats().evidenceLinks >= 4);
    ok('cada episodio conserva evidencia trazable hacia los turnos que lo originaron');

    const resumed = new SessionManager(graph, {}, { incrementalEveryTurns: 4 });
    const resumedState = await resumed.start(null);
    assert.equal(resumedState.resumed, true);
    resumed.addTurn('user', 'Este turno todavía no fue procesado');
    resumed.addTurn('assistant', 'Se procesará al cerrar');
    await resumed.close();

    const closed = graph._db.prepare('SELECT * FROM sessions WHERE id=?').get(started.sessionId);
    assert.equal(closed.memory_cursor, 6);
    assert.ok(closed.ended_at);
    assert.equal(prompts.length, 2);
    assert.equal(graph.listObservations({ sessionId: started.sessionId }).length, 6);
    ok('resume continúa desde el cursor y no vuelve a extraer lotes anteriores');
  } finally {
    restore();
    graph.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testLongExtractionKeepsBeginning() {
  const { graph, dir } = makeGraph();
  const prompts = [];
  const restore = mockLLM(prompts);
  try {
    const updater = new StateUpdater(graph);
    const history = Array.from({ length: 14 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `MARCADOR_${index} ${'detalle '.repeat(350)}`,
    }));
    await updater._extractMemories(history);
    const sent = prompts.join('\n');
    assert.ok(prompts.length > 1);
    assert.ok(sent.includes('MARCADOR_0'));
    assert.ok(sent.includes('MARCADOR_13'));
    ok('la extracción larga conserva principio y final mediante chunks');
  } finally {
    restore();
    graph.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testFailedExtractionIsRetried() {
  const { graph, dir } = makeGraph();
  const originalComplete = LLMProvider.complete;
  const originalCompleteTask = LLMProvider.completeTask;
  try {
    LLMProvider.complete = async () => 'respuesta que no es json';
    LLMProvider.completeTask = LLMProvider.complete;
    const manager = new SessionManager(graph, {}, { incrementalEveryTurns: 4 });
    const started = await manager.start(null);
    manager.addTurn('user', 'Dato uno');
    manager.addTurn('assistant', 'Respuesta uno');
    manager.addTurn('user', 'Dato dos');
    manager.addTurn('assistant', 'Respuesta dos');
    await manager._incrementalPromise;
    const failed = graph._db
      .prepare('SELECT memory_cursor FROM sessions WHERE id=?')
      .get(started.sessionId);
    assert.equal(failed.memory_cursor, 0);
    assert.equal(
      graph.listObservations({ sessionId: started.sessionId, unprocessedOnly: true }).length,
      4
    );

    const prompts = [];
    const valid = async (messages) => {
      prompts.push(String(messages?.[0]?.content || ''));
      return JSON.stringify({ episode_summary: 'Recuperado', episode_importance: 0.5, nodes: [] });
    };
    LLMProvider.complete = valid;
    LLMProvider.completeTask = valid;
    manager._scheduleIncrementalMemory();
    await manager._incrementalPromise;
    const recovered = graph._db
      .prepare('SELECT memory_cursor FROM sessions WHERE id=?')
      .get(started.sessionId);
    assert.equal(recovered.memory_cursor, 4);
    assert.ok(prompts[0].includes('Dato uno'));
    ok('una extracción inválida no avanza el cursor y se reintenta sin perder turnos');
    await manager.close();
  } finally {
    LLMProvider.complete = originalComplete;
    LLMProvider.completeTask = originalCompleteTask;
    graph.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testInstantMemoryEvidence() {
  const { graph, dir } = makeGraph();
  const prompts = [];
  const restore = mockLLM(prompts);
  try {
    const manager = new SessionManager(graph, {}, { incrementalEveryTurns: 100 });
    await manager.start(null);
    manager.addTurn('user', 'me llamo Ada');
    manager.addTurn('assistant', 'Mucho gusto');
    await manager.close();
    const node = graph._findActiveNodeByLabel('nombre_usuario');
    const evidence = graph.getMemoryEvidence(node.id);
    assert.ok(
      evidence.some((row) => row.kind === 'user_message' && row.content === 'me llamo Ada')
    );
    ok('los recuerdos instantáneos conservan el mensaje exacto como evidencia');
  } finally {
    restore();
    graph.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testOSContextReachesWorldModel() {
  let received = null;
  const graph = {
    isReady: true,
    getWorldModel: (context) => {
      received = context;
      return [];
    },
    queryNodesSemantic: async () => [],
    queryNodes: () => [],
    getRecentEpisodes: () => [],
  };
  const planner = new RetrievalPlanner(graph);
  await planner.plan('continúa con este proyecto', {
    app: 'code',
    friendlyName: 'Visual Studio Code',
    title: 'StateGraph.js',
    category: 'code',
  });
  assert.equal(received.activeApp, 'code');
  assert.equal(received.windowTitle, 'StateGraph.js');
  ok('el contexto OS real llega al boosting del world model');
}

function testFeedbackIsolation() {
  let updates = 0;
  const evaluator = new ResponseEvaluator({ updateScore: () => updates++ });
  evaluator.recordResponse(
    'Respuesta de la sesión A',
    { forbidden: [] },
    null,
    'responseLength',
    'A'
  );
  const wrong = evaluator.evaluate(0.9, 'B');
  assert.equal(wrong.feedbackApplied, false);
  assert.equal(updates, 0);
  const right = evaluator.evaluate(0.9, 'A');
  assert.equal(right.feedbackApplied, true);
  assert.equal(updates, 1);
  ok('el feedback de una sesión no contamina otra sesión');
}

function testObservationDedupeAndExpiry() {
  const { graph, dir } = makeGraph();
  try {
    const first = graph.recordObservation({
      source: 'sensor-test',
      kind: 'window_change',
      content: 'Editor',
      dedupeKey: 'same-event',
    });
    const repeated = graph.recordObservation({
      source: 'sensor-test',
      kind: 'window_change',
      content: 'Editor repetido',
      dedupeKey: 'same-event',
    });
    assert.equal(repeated, first);
    graph.recordObservation({
      source: 'sensor-test',
      kind: 'ephemeral',
      occurredAt: Date.now() - 100,
      ttlMs: 1,
    });
    assert.equal(graph.pruneExpiredObservations(), 1);
    assert.equal(graph.listObservations({ source: 'sensor-test' }).length, 1);
    ok('el ledger deduplica señales y aplica retención por TTL');
  } finally {
    graph.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testSensorNormalization() {
  const recorded = [];
  const bridge = new ObservationBridge({
    bus: new EventBus(),
    graph: { recordObservation: (opts) => recorded.push(opts) },
  });
  bridge.start();
  bridge._bus.emit('os:app-changed', {
    app: 'code',
    friendlyName: 'Code',
    category: 'code',
    title: 'Memory.js',
  });
  bridge._bus.emit('clipboard:copied', { kind: 'stacktrace', snippet: 'Error privado' });
  assert.equal(recorded.length, 2);
  assert.equal(recorded[0].source, 'os');
  assert.equal(recorded[0].metadata.title, 'Memory.js');
  assert.equal(recorded[1].sensitivity, 'sensitive');
  assert.ok(recorded[1].ttlMs <= 60 * 60 * 1000);
  bridge.stop();
  ok('los sensores se normalizan con privacidad y retención antes de persistir');
}

async function main() {
  console.log('\n═══ Memoria cognitiva incremental ═══');
  await testIncrementalCursor();
  await testLongExtractionKeepsBeginning();
  await testFailedExtractionIsRetried();
  await testInstantMemoryEvidence();
  await testOSContextReachesWorldModel();
  testFeedbackIsolation();
  testObservationDedupeAndExpiry();
  testSensorNormalization();
  console.log(`\nResultado: ${passed} passed  0 failed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
