// @ts-check
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { StateGraph } = require('../core/state-graph/StateGraph.js');
const { CausalMemoryStore } = require('../core/state-graph/stores/CausalMemoryStore.js');
const { MemorySleepCycle } = require('../core/memory/MemorySleepCycle.js');

let passed = 0;
let failed = 0;

function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
    passed++;
  } else {
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

function testFallbackAndMigration() {
  console.log('\nMemoria causal — fallback y migración compatible');
  const fallback = new CausalMemoryStore(null, { usingFallback: true });
  for (let i = 0; i < 4; i++) {
    fallback.recordOutcome({
      sessionId: `fallback-${i % 2}`,
      mode: 'smart',
      difficulty: 'easy',
      success: true,
      terminalSuccess: true,
      verificationStatus: 'verified',
      successfulTools: ['read'],
      ts: Date.now() - 1000,
    });
  }
  assert(
    fallback.consolidate({ minAgeMs: 0, minSamples: 3 }).hypotheses.length === 1,
    'el modo degradado conserva aprendizaje causal en memoria'
  );

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoru-causal-migration-'));
  const dbPath = path.join(dir, 'memory.db');
  const Database = require('better-sqlite3');
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE task_outcome_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      goal TEXT NOT NULL DEFAULT '',
      mode TEXT NOT NULL,
      strategy TEXT NOT NULL,
      outcome TEXT NOT NULL,
      verification_status TEXT NOT NULL,
      verification_reason TEXT,
      tools TEXT NOT NULL DEFAULT '[]',
      elapsed_ms INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      consolidated_at INTEGER
    );
  `);
  legacy.close();
  const graph = new StateGraph(dbPath).init();
  try {
    const columns = graph._db.prepare('PRAGMA table_info(task_outcome_evidence)').all();
    assert(
      columns.some((column) => column.name === 'difficulty'),
      'migra el esquema intermedio'
    );
    assert(
      graph.recordTaskOutcomeEvidence({ mode: 'smart', difficulty: 'hard' }) !== null,
      'el esquema migrado acepta evidencia nueva'
    );
  } finally {
    graph.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function record(graph, index, success, verificationStatus = success ? 'verified' : 'failed') {
  return graph.recordTaskOutcomeEvidence({
    sessionId: `session-${index % 3}`,
    goal: 'Corregir CI',
    mode: 'smart',
    difficulty: 'medium',
    success,
    terminalSuccess: success,
    verificationStatus,
    verificationReason: success ? 'suite_passed' : 'suite_failed',
    successfulTools: ['exec', 'edit'],
    elapsedMs: 1000,
    ts: Date.now() - 10_000,
  });
}

function testCausalConsolidation() {
  console.log('\nMemoria causal — evidencia, contradicción y persistencia');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoru-causal-'));
  const dbPath = path.join(dir, 'memory.db');
  let graph = new StateGraph(dbPath).init();
  try {
    for (let i = 0; i < 9; i++) record(graph, i, true);
    record(graph, 20, true, 'unverified');
    const first = graph.runCausalConsolidation({ minAgeMs: 0, minSamples: 3 });
    assert(first.hypotheses.length === 1, 'deriva una hipótesis con muestras multisessión');
    const hypothesis = first.hypotheses[0];
    assert(hypothesis.effect === 'completion_likely', 'distingue una estrategia favorable');
    assert(hypothesis.supportCount === 9, 'sólo cuenta outcomes verificables');
    assert(hypothesis.confidence >= 0.65, 'la confianza crece con evidencia consistente');
    assert(
      (graph.buildCausalMemorySection() || '').includes('NO OTORGA PERMISOS'),
      'inyecta una inferencia fuerte con límite de autoridad explícito'
    );
    assert(
      graph.runCausalConsolidation({ minAgeMs: 0 }).hypotheses.length === 0,
      'repetir sin evidencia nueva es idempotente'
    );

    assert(graph.decideCausalHypothesis(hypothesis.signature, 'accepted'), 'permite confirmarla');
    assert(
      graph.listCausalHypotheses({ status: 'accepted' }).length === 1,
      'registra la decisión humana'
    );

    for (let i = 0; i < 9; i++) record(graph, 30 + i, false);
    const contradicted = graph.runCausalConsolidation({ minAgeMs: 0, minSamples: 3 });
    assert(contradicted.hypotheses.length === 1, 'recalcula al llegar contradicciones');
    assert(contradicted.hypotheses[0].effect === 'uncertain', 'retira una conclusión equilibrada');
    assert(contradicted.hypotheses[0].status === 'inferred', 'invalida aceptación ya contradicha');
    assert(graph.listCausalHypotheses().length === 1, 'no duplica la misma relación causal');
    assert(graph.buildCausalMemorySection() === null, 'una tesis incierta no condiciona el prompt');

    graph.close();
    graph = new StateGraph(dbPath).init();
    const restored = graph.listCausalHypotheses()[0];
    assert(restored.effect === 'uncertain', 'la revisión causal sobrevive al reinicio');
    assert(restored.evidenceIds.length === 18, 'conserva trazabilidad hacia la evidencia');
  } finally {
    graph.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testSleepCycle() {
  console.log('\nCiclo de reposo — inactividad, límites y cancelación');
  /** @type {Map<string, (payload:any)=>void>} */
  const handlers = new Map();
  const calls = [];
  const bus = {
    on(event, handler) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
  };
  const graph = {
    runConsolidation(opts) {
      calls.push({ kind: 'semantic', opts });
      return { consolidated: 0 };
    },
    runCausalConsolidation(opts) {
      calls.push({ kind: 'causal', opts });
      return { consolidated: 0 };
    },
    runAutobiographicalMaintenance(limit) {
      calls.push({ kind: 'autobiographical', limit });
      return { indexed: 0 };
    },
  };
  const cycle = new MemorySleepCycle({ bus, graph }, { idleSeconds: 300, cooldownMs: 60_000 });
  cycle.start();
  handlers.get('os:idle-changed')?.({ idle: true, idleSecs: 299 });
  assert(calls.length === 0, 'no trabaja antes del umbral de inactividad');
  handlers.get('os:idle-changed')?.({ idle: true, idleSecs: 300 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert(calls.length === 3, 'ejecuta los tres mantenimientos al entrar en reposo');
  assert(calls[0].opts.limit === 50, 'el trabajo semántico está acotado');
  assert(calls[1].opts.limit === 500, 'el trabajo causal está acotado');
  assert(calls[2].limit === 100, 'el backfill autobiográfico está acotado');
  assert(!cycle.schedule('duplicate'), 'el cooldown evita ciclos repetidos');
  cycle.stop();
  assert(!handlers.has('os:idle-changed'), 'shutdown cancela la percepción de inactividad');

  const stopped = new MemorySleepCycle({ bus, graph }, { idleSeconds: 0, cooldownMs: 0 }).start();
  const before = calls.length;
  assert(stopped.schedule('pending'), 'permite programar un ciclo nuevo');
  stopped.stop();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert(calls.length === before, 'stop cancela trabajo pendiente');
}

async function main() {
  testCausalConsolidation();
  testFallbackAndMigration();
  await testSleepCycle();
  console.log(`\nResultado: ${passed} passed  ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
