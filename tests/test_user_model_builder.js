'use strict';

/**
 * F3.3 — modelo del usuario inferido (UserModelBuilder).
 *
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron tests/test_user_model_builder.js
 *
 * Cubre:
 *   - un cluster de episodios temáticos genera un nodo inferido con
 *     EVIDENCIA_DE y decay alto,
 *   - los episodios usados NO se marcan consolidated (no interfiere con el
 *     consolidator),
 *   - rechazos de validación: confidence fuera de rango, label que colisiona
 *     con FIXED_LABELS, label que colisiona con DYNAMIC_PREFIXES, episodios
 *     inventados, contenido técnico/comando, kind↔prefijo inconsistente,
 *     respuesta null del LLM,
 *   - reconcileInferred NUNCA invoca ContradictionResolver.resolve(),
 *   - fusión por similitud semántica (>= 0.75) en vez de duplicar,
 *   - confirmInferred: 'accepted' lleva confidence a 0.9+, 'rejected' archiva,
 *   - confirmInferred rechaza nodos que no son inferidos,
 *   - piggyback en applyDecay() no bloquea ni lanza,
 *   - clusters ya modelados se saltean (no re-paga LLM).
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

let passed = 0;
let failed = 0;

function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  ${C.green('✓')} ${label}`);
    passed++;
  } else {
    console.log(`  ${C.red('✗')} ${label}`);
    if (detail) console.log(`    ${C.dim(detail)}`);
    failed++;
  }
}

const { StateGraph } = require('../core/state-graph/StateGraph.js');
const { ContradictionResolver } = require('../core/state-graph/ContradictionResolver.js');
const LLMProvider = require('../core/llm/LLMProvider.js');
const {
  UserModelBuilder,
  INFERRED_DECAY_RATE,
  EVIDENCIA_DE,
} = require('../core/state-graph/UserModelBuilder.js');

const DAY = 24 * 60 * 60 * 1000;

function makeGraph() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'umb-test-'));
  const dbPath = path.join(dir, 'core.db');
  const graph = new StateGraph(dbPath).init();
  return { graph, dir };
}

function sqlGet(graph, sql, ...args) {
  return graph._db.prepare(sql).get(...args);
}

function count(graph, sql, ...args) {
  return sqlGet(graph, sql, ...args).c;
}

function tags(graph, id) {
  try {
    return JSON.parse(sqlGet(graph, 'SELECT tags FROM nodes WHERE id=?', id).tags);
  } catch {
    return [];
  }
}

function countInferredBeliefs(graph) {
  return count(graph, `SELECT COUNT(*) as c FROM nodes WHERE type='Belief' AND archived=0`);
}

function countEvidence(graph) {
  return count(graph, `SELECT COUNT(*) as c FROM node_relations WHERE type=?`, EVIDENCIA_DE);
}

// Episodio viejo (8 días) sobre el tema "cocina".
function mkOldEpisode(graph, content) {
  const id = graph.createNode({ type: 'Episode', label: 'ep_cocina', content, importance: 0.7 });
  graph._db.prepare('UPDATE nodes SET created_at=? WHERE id=?').run(Date.now() - 8 * DAY, id);
  return id;
}

// ── Embedder determinista por tema ───────────────────────────────────────────
function patchEmbedder() {
  const EmbedService = require('../core/grounding/EmbedService.js');
  const orig = {
    embedText: EmbedService.embedText,
    float32ToBuffer: EmbedService.float32ToBuffer,
  };
  const kitchen = /cocina|cocinar|receta|guiso|galletas|horneamos/i;
  EmbedService.embedText = async (t) => {
    const v = new Array(384).fill(0);
    v[kitchen.test(t) ? 0 : 1] = 1;
    return v;
  };
  EmbedService.float32ToBuffer = (arr) => Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
  return orig;
}

function restoreEmbedder(orig) {
  const EmbedService = require('../core/grounding/EmbedService.js');
  EmbedService.embedText = orig.embedText;
  EmbedService.float32ToBuffer = orig.float32ToBuffer;
}

// ── Mock del LLM: recibe los ids de episodios del cluster ───────────────────
// `builder(ids)` devuelve el candidato (objeto) o null (sin inferencia).
function mockLLM(builder) {
  const orig = { complete: LLMProvider.complete, completeTask: LLMProvider.completeTask };
  LLMProvider.completeTask = async (messages) => {
    const content = messages[0].content;
    const ids = [...content.matchAll(/\[episodio (\d+)\]/g)].map((m) => Number(m[1]));
    const cand = builder(ids);
    return cand === null ? 'null' : JSON.stringify(cand);
  };
  LLMProvider.complete = LLMProvider.completeTask;
  return orig;
}

function restoreLLM(orig) {
  LLMProvider.complete = orig.complete;
  LLMProvider.completeTask = orig.completeTask;
}

function validCandidate(ids) {
  return {
    label: 'valor_cocinar_en_casa',
    content: 'El usuario disfruta cocinar en casa y probar platos nuevos',
    kind: 'value',
    confidence: 0.7,
    episodiosUsados: ids,
  };
}

function fourKitchenEpisodes(graph) {
  return [
    mkOldEpisode(graph, 'Hoy horneamos galletas con chocolate casero'),
    mkOldEpisode(graph, 'Este fin de semana prepare un guiso para la familia'),
    mkOldEpisode(graph, 'Anoche cocine una receta de pasta con salsa propia'),
    mkOldEpisode(graph, 'La cocina me relaja, sobre todo cuando pruebo platos nuevos'),
  ];
}

// ── Test 1: cluster → nodo inferido con EVIDENCIA_DE ─────────────────────────
async function testCreatesInferredNode() {
  console.log(C.bold('\nTest 1: cluster temático → nodo inferido + EVIDENCIA_DE'));
  const { graph, dir } = makeGraph();
  const embOrig = patchEmbedder();
  const llmOrig = mockLLM((ids) => validCandidate(ids));
  const ids = fourKitchenEpisodes(graph);

  const res = await graph.runUserModel();
  assert(res.clusters === 1, '1 cluster temático', JSON.stringify(res));
  assert(res.inferred === 1, '1 nodo inferido creado', JSON.stringify(res));
  assert(countInferredBeliefs(graph) === 1, 'exactamente 1 Belief inferido');

  const row = sqlGet(
    graph,
    `SELECT * FROM nodes WHERE type='Belief' AND inferred=1 AND archived=0`
  );
  assert(row.label === 'valor_cocinar_en_casa', `label del nodo: ${row.label}`);
  assert(row.confidence === 0.7, `confidence inicial respetada (${row.confidence})`);
  assert(row.decay_rate === INFERRED_DECAY_RATE, `decay_rate alto (${row.decay_rate})`);
  const t = tags(graph, row.id);
  assert(
    t.includes('inferred') && t.includes('value'),
    `tags ['inferred','value']: ${t.join(',')}`
  );

  assert(countEvidence(graph) === 4, '4 relaciones EVIDENCIA_DE (una por episodio)');
  const allEvidence = ids.every((epId) =>
    sqlGet(
      graph,
      'SELECT id FROM node_relations WHERE source_id=? AND target_id=? AND type=?',
      row.id,
      epId,
      EVIDENCIA_DE
    )
  );
  assert(allEvidence, 'cada episodio usado queda trazable');

  const noConsolidated = ids.every((epId) => !tags(graph, epId).includes('consolidated'));
  assert(noConsolidated, 'episodios NO se marcan consolidated (no interfiere con consolidator)');

  restoreLLM(llmOrig);
  restoreEmbedder(embOrig);
  graph.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Test 2: validación — confidence fuera de rango ───────────────────────────
async function testRejectsConfidenceOutOfRange() {
  console.log(C.bold('\nTest 2: rechaza confidence fuera de rango'));
  const { graph, dir } = makeGraph();
  const embOrig = patchEmbedder();
  const llmOrig = mockLLM((ids) => ({ ...validCandidate(ids), confidence: 1.5 }));
  fourKitchenEpisodes(graph);

  const res = await graph.runUserModel();
  assert(res.rejected === 1, 'inferencia descartada', JSON.stringify(res));
  assert(res.inferred === 0, 'no se crea nodo');
  assert(countInferredBeliefs(graph) === 0, '0 Belief inferidos');

  restoreLLM(llmOrig);
  restoreEmbedder(embOrig);
  graph.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Test 3: validación — label colisiona con FIXED_LABELS ────────────────────
async function testRejectsFixedLabelCollision() {
  console.log(C.bold('\nTest 3: rechaza label que colisiona con FIXED_LABELS'));
  const { graph, dir } = makeGraph();
  const embOrig = patchEmbedder();
  const llmOrig = mockLLM((ids) => ({ ...validCandidate(ids), label: 'nombre_usuario' }));
  fourKitchenEpisodes(graph);

  const res = await graph.runUserModel();
  assert(res.rejected === 1, 'inferencia descartada', JSON.stringify(res));
  assert(countInferredBeliefs(graph) === 0, 'no se pisa un hecho fijo');

  restoreLLM(llmOrig);
  restoreEmbedder(embOrig);
  graph.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Test 4: validación — label colisiona con DYNAMIC_PREFIXES ────────────────
async function testRejectsDynamicPrefixCollision() {
  console.log(C.bold('\nTest 4: rechaza label que colisiona con prefijo dinámico'));
  const { graph, dir } = makeGraph();
  const embOrig = patchEmbedder();
  const llmOrig = mockLLM((ids) => ({ ...validCandidate(ids), label: 'proyecto_mi_app' }));
  fourKitchenEpisodes(graph);

  const res = await graph.runUserModel();
  assert(res.rejected === 1, 'inferencia descartada', JSON.stringify(res));
  assert(countInferredBeliefs(graph) === 0, 'no se crea nodo');

  restoreLLM(llmOrig);
  restoreEmbedder(embOrig);
  graph.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Test 5: validación — episodios inventados ────────────────────────────────
async function testRejectsInventedEpisodes() {
  console.log(C.bold('\nTest 5: rechaza episodios fuera de los enviados'));
  const { graph, dir } = makeGraph();
  const embOrig = patchEmbedder();
  const llmOrig = mockLLM((ids) => ({ ...validCandidate(ids), episodiosUsados: [999999, ids[0]] }));
  fourKitchenEpisodes(graph);

  const res = await graph.runUserModel();
  assert(res.rejected === 1, 'inferencia descartada', JSON.stringify(res));
  assert(countInferredBeliefs(graph) === 0, 'no se crea nodo con evidencia falsa');

  restoreLLM(llmOrig);
  restoreEmbedder(embOrig);
  graph.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Test 6: validación — contenido técnico/comando ───────────────────────────
async function testRejectsCommandContent() {
  console.log(C.bold('\nTest 6: rechaza contenido técnico/comando'));
  const { graph, dir } = makeGraph();
  const embOrig = patchEmbedder();
  const llmOrig = mockLLM((ids) => ({
    ...validCandidate(ids),
    content: 'git push origin main y desplegar en producción',
  }));
  fourKitchenEpisodes(graph);

  const res = await graph.runUserModel();
  assert(res.rejected === 1, 'inferencia descartada', JSON.stringify(res));
  assert(countInferredBeliefs(graph) === 0, 'no se guarda un comando como memoria');

  restoreLLM(llmOrig);
  restoreEmbedder(embOrig);
  graph.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Test 7: validación — kind↔prefijo inconsistente ──────────────────────────
async function testRejectsKindPrefixMismatch() {
  console.log(C.bold('\nTest 7: rechaza kind↔prefijo inconsistente'));
  const { graph, dir } = makeGraph();
  const embOrig = patchEmbedder();
  const llmOrig = mockLLM((ids) => ({ ...validCandidate(ids), kind: 'pattern' }));
  fourKitchenEpisodes(graph);

  const res = await graph.runUserModel();
  assert(res.rejected === 1, 'inferencia descartada', JSON.stringify(res));
  assert(countInferredBeliefs(graph) === 0, 'no se crea nodo');

  restoreLLM(llmOrig);
  restoreEmbedder(embOrig);
  graph.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Test 8: validación — respuesta null del LLM ──────────────────────────────
async function testNullResponse() {
  console.log(C.bold('\nTest 8: respuesta null del LLM → sin inferencia'));
  const { graph, dir } = makeGraph();
  const embOrig = patchEmbedder();
  const llmOrig = mockLLM(() => null);
  fourKitchenEpisodes(graph);

  const res = await graph.runUserModel();
  assert(res.rejected === 1, 'cluster evaluado y descartado', JSON.stringify(res));
  assert(res.inferred === 0 && countInferredBeliefs(graph) === 0, 'no se fabrica ningún rasgo');

  restoreLLM(llmOrig);
  restoreEmbedder(embOrig);
  graph.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Test 9: reconcileInferred NUNCA llama a ContradictionResolver.resolve ────
async function testNeverCallsContradictionResolver() {
  console.log(C.bold('\nTest 9: reconcileInferred no pasa por ContradictionResolver'));
  const { graph, dir } = makeGraph();
  const embOrig = patchEmbedder();
  const llmOrig = mockLLM((ids) => validCandidate(ids));
  fourKitchenEpisodes(graph);

  const origResolve = ContradictionResolver.prototype.resolve;
  let resolveCalls = 0;
  ContradictionResolver.prototype.resolve = function (...args) {
    resolveCalls++;
    return origResolve.apply(this, args);
  };

  const res = await graph.runUserModel();
  assert(res.inferred === 1, 'inferencia creada normalmente', JSON.stringify(res));
  assert(
    resolveCalls === 0,
    'ContradictionResolver.resolve() nunca se invocó',
    `calls=${resolveCalls}`
  );

  ContradictionResolver.prototype.resolve = origResolve;
  restoreLLM(llmOrig);
  restoreEmbedder(embOrig);
  graph.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Test 10: fusión por similitud en vez de duplicar ─────────────────────────
async function testMergeBySimilarity() {
  console.log(C.bold('\nTest 10: reconciliación fusiona por similitud (>= 0.75)'));
  const { graph, dir } = makeGraph();
  const embOrig = patchEmbedder();
  const llmOrig = mockLLM((ids) => validCandidate(ids));
  fourKitchenEpisodes(graph);

  // Nodo inferido previo SEMÁNTICAMENTE similar (mismo rasgo).
  const existing = graph.createNode({
    type: 'Belief',
    label: 'valor_cocinar',
    content: 'Al usuario le gusta cocinar en casa',
    importance: 0.7,
    tags: ['inferred', 'value'],
    inferred: 1,
    confidence: 0.5,
    decay_rate: INFERRED_DECAY_RATE,
  });

  // stub de queryNodesSemantic: devuelve el nodo previo con _similarity alta.
  const origQns = graph.queryNodesSemantic;
  graph.queryNodesSemantic = async () => [
    { id: existing, inferred: 1, archived: 0, confidence: 0.5, _similarity: 0.9 },
  ];

  const res = await graph.runUserModel();
  assert(res.inferred === 0, 'NO se crea duplicado', JSON.stringify(res));
  assert(res.merged === 1, 'se fusiona (merged=1)', JSON.stringify(res));
  assert(countInferredBeliefs(graph) === 1, 'sigue habiendo un solo Belief inferido');

  const after = sqlGet(graph, 'SELECT confidence, verified_at FROM nodes WHERE id=?', existing);
  const expected = 0.5 + 0.15 * 0.5;
  assert(
    Math.abs(after.confidence - expected) < 1e-9,
    `confidence reforzada (${after.confidence} ≈ ${expected})`
  );
  assert(typeof after.verified_at === 'number', 'verified_at refrescado');
  assert(countEvidence(graph) === 4, 'nueva evidencia registrada (EVIDENCIA_DE x4)');

  graph.queryNodesSemantic = origQns;
  restoreLLM(llmOrig);
  restoreEmbedder(embOrig);
  graph.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Test 11: confirmInferred 'accepted' → confidence 0.9+ ────────────────────
async function testConfirmAccepted() {
  console.log(C.bold('\nTest 11: confirmInferred accepted lleva confidence a 0.9+'));
  const { graph, dir } = makeGraph();
  const id = graph.createNode({
    type: 'Belief',
    label: 'patron_estudiar_noche',
    content: 'El usuario suele estudiar por la noche',
    importance: 0.6,
    tags: ['inferred', 'pattern'],
    inferred: 1,
    confidence: 0.4,
    decay_rate: INFERRED_DECAY_RATE,
  });

  const res = graph.confirmInferred(id, 'accepted');
  assert(res.ok === true && res.action === 'accepted', 'aceptado', JSON.stringify(res));
  const after = sqlGet(graph, 'SELECT confidence FROM nodes WHERE id=?', id);
  assert(after.confidence >= 0.9, `confidence sube a 0.9+ (${after.confidence})`);

  graph.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Test 12: confirmInferred 'rejected' → archiva ────────────────────────────
async function testConfirmRejectedArchives() {
  console.log(C.bold('\nTest 12: confirmInferred rejected archiva el nodo'));
  const { graph, dir } = makeGraph();
  const id = graph.createNode({
    type: 'Belief',
    label: 'objetivo_aprender_guitarra',
    content: 'El usuario quiere aprender a tocar la guitarra',
    importance: 0.6,
    tags: ['inferred', 'goal'],
    inferred: 1,
    confidence: 0.6,
    decay_rate: INFERRED_DECAY_RATE,
  });

  const res = graph.confirmInferred(id, 'rejected');
  assert(res.ok === true && res.action === 'rejected', 'rechazado', JSON.stringify(res));
  const after = sqlGet(graph, 'SELECT archived FROM nodes WHERE id=?', id);
  assert(after.archived === 1, 'nodo archivado');

  graph.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Test 13: confirmInferred rechaza nodos no inferidos ──────────────────────
async function testConfirmRejectsNonInferred() {
  console.log(C.bold('\nTest 13: confirmInferred rechaza nodos no inferidos'));
  const { graph, dir } = makeGraph();
  const factId = graph.createNode({
    type: 'User',
    label: 'nombre_usuario',
    content: 'El usuario se llama Luka',
    importance: 0.9,
  });

  const res = graph.confirmInferred(factId, 'rejected');
  assert(
    res.ok === false && res.reason === 'not_inferred',
    'no se archiva un hecho fijo',
    JSON.stringify(res)
  );
  const bad = graph.confirmInferred(factId, 'accepted');
  assert(bad.ok === false, 'tampoco se refuerza', JSON.stringify(bad));
  const invalid = graph.confirmInferred(factId, 'talvez');
  assert(
    invalid.ok === false && invalid.reason === 'invalid_outcome',
    'outcome inválido rechazado'
  );

  graph.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Test 14: piggyback en applyDecay() no lanza ni bloquea ───────────────────
async function testPiggybackDoesNotThrow() {
  console.log(C.bold('\nTest 14: applyDecay() dispara el user-model sin bloquear'));
  const { graph, dir } = makeGraph();
  const embOrig = patchEmbedder();
  const llmOrig = mockLLM((ids) => validCandidate(ids));
  fourKitchenEpisodes(graph);

  // Aísla el trigger: la consolidación previa no debe interferir en la aserción.
  const origRun = graph._consolidator.runConsolidation;
  graph._consolidator.runConsolidation = () => ({ episodes: 0, facts: [] });

  let threw = false;
  try {
    const result = graph.applyDecay();
    assert(result && typeof result === 'object', 'applyDecay devuelve resultado síncrono');
  } catch (e) {
    threw = true;
    assert(false, `applyDecay no debe lanzar: ${e.message}`);
  }
  assert(!threw, 'applyDecay() completo sin excepción');

  await new Promise((r) => setTimeout(r, 50));
  assert(countInferredBeliefs(graph) === 1, 'el user-model corrió tras applyDecay (async)');

  graph._consolidator.runConsolidation = origRun;
  restoreLLM(llmOrig);
  restoreEmbedder(embOrig);
  graph.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Test 15: clusters ya modelados se saltean ────────────────────────────────
async function testSkipsAlreadyModeled() {
  console.log(C.bold('\nTest 15: evidencia ya modelada → cluster se saltea'));
  const { graph, dir } = makeGraph();
  const embOrig = patchEmbedder();
  const llmOrig = mockLLM((ids) => validCandidate(ids));
  const ids = fourKitchenEpisodes(graph);

  // Nodo inferido previo + evidencia completa: todo el cluster ya modelado.
  const src = graph.createNode({
    type: 'Belief',
    label: 'valor_cocinar',
    content: 'Al usuario le gusta cocinar en casa',
    importance: 0.7,
    tags: ['inferred', 'value'],
    inferred: 1,
    confidence: 0.8,
    decay_rate: INFERRED_DECAY_RATE,
  });
  for (const epId of ids) graph.createRelation({ source: src, target: epId, type: EVIDENCIA_DE });

  const res = await graph.runUserModel();
  assert(res.clusters === 1, 'cluster detectado', JSON.stringify(res));
  assert(res.skipped === 1, 'se saltea (sin llamada LLM nueva)', JSON.stringify(res));
  assert(res.inferred === 0 && res.merged === 0, 'nada se re-infiere ni se duplica');
  assert(countInferredBeliefs(graph) === 1, 'un solo nodo inferido');

  restoreLLM(llmOrig);
  restoreEmbedder(embOrig);
  graph.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Test 16: episodios consolidated quedan fuera de los candidatos ───────────
async function testExcludesConsolidatedEpisodes() {
  console.log(C.bold('\nTest 16: episodios consolidated quedan fuera del modelo'));
  const { graph, dir } = makeGraph();
  const embOrig = patchEmbedder();
  const llmOrig = mockLLM((ids) => validCandidate(ids));
  const ids = fourKitchenEpisodes(graph);
  for (const id of ids) {
    const t = tags(graph, id);
    t.push('consolidated');
    graph._db.prepare('UPDATE nodes SET tags=? WHERE id=?').run(JSON.stringify(t), id);
  }

  const res = await graph.runUserModel();
  assert(res.clusters === 0, 'candidatos vacíos (todo consolidado)', JSON.stringify(res));
  assert(countInferredBeliefs(graph) === 0, 'no se crea nada');

  restoreLLM(llmOrig);
  restoreEmbedder(embOrig);
  graph.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Test 17: UserModelBuilder usa el helper compartido de candidatos ─────────
async function testSharedCandidateHelper() {
  console.log(C.bold('\nTest 17: mismo criterio de candidatos que el consolidator'));
  const { graph, dir } = makeGraph();
  const um = new UserModelBuilder(graph._db, graph);
  const cons = graph._consolidator;

  const ep = mkOldEpisode(graph, 'me encanta cocinar guisos los fines de semana');
  const before = um._findClusterCandidates({ minAgeMs: Date.now() - DAY, limit: 50 });
  const consBefore = cons._candidates({ minAgeMs: Date.now() - DAY, limit: 50 });
  assert(
    before.map((e) => e.id).join() === consBefore.map((e) => e.id).join(),
    'ambos ven exactamente el mismo conjunto',
    `um=[${before.map((e) => e.id)}] cons=[${consBefore.map((e) => e.id)}]`
  );
  assert(
    before.some((e) => e.id === ep),
    'el episodio viejo aparece'
  );

  graph.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Test 18: getUserModel separa inferencias, getWorldModel solo hechos ──────
async function testGetUserModelSeparation() {
  console.log(C.bold('\nTest 18: getUserModel (inferencias) vs getWorldModel (hechos)'));
  const { graph, dir } = makeGraph();

  graph.createNode({
    type: 'User',
    label: 'nombre_usuario',
    content: 'El usuario se llama Luka',
    importance: 0.9,
  });
  graph.createNode({
    type: 'Belief',
    label: 'patron_estudiar_noche',
    content: 'El usuario suele estudiar de noche',
    importance: 0.5,
    tags: ['inferred', 'pattern'],
    inferred: 1,
    confidence: 0.4,
    decay_rate: INFERRED_DECAY_RATE,
  });
  const strong = graph.createNode({
    type: 'Belief',
    label: 'valor_cocinar',
    content: 'Al usuario le gusta cocinar en casa',
    importance: 0.6,
    tags: ['inferred', 'value'],
    inferred: 1,
    confidence: 0.9,
    decay_rate: INFERRED_DECAY_RATE,
  });
  graph.createNode({
    type: 'Belief',
    label: 'objetivo_ejercicio',
    content: 'El usuario quiere hacer ejercicio',
    importance: 0.9,
    tags: ['inferred', 'goal'],
    inferred: 1,
    confidence: 0.3,
    decay_rate: INFERRED_DECAY_RATE,
  });

  const model = graph.getUserModel({ limit: 2 });
  assert(Array.isArray(model), 'getUserModel devuelve array');
  assert(model.length === 2, 'respeta el limit', JSON.stringify(model.map((n) => n.label)));
  assert(
    model.every((n) => n.inferred === 1),
    'solo nodos inferidos'
  );
  assert(
    model[0].id === strong,
    'orden por confidence × importance (el fuerte primero)',
    JSON.stringify(model.map((n) => `[${n.label} ${n.confidence}]`))
  );
  assert(model[0].confidence >= model[1].confidence, 'confidence descendente');

  const wm = graph.getWorldModel();
  assert(!wm.some((n) => n.inferred === 1), 'getWorldModel NUNCA incluye inferencias');
  assert(
    wm.some((n) => n.label === 'nombre_usuario'),
    'getWorldModel sí incluye el hecho real'
  );

  const archived = graph.createNode({
    type: 'Belief',
    label: 'valor_musica',
    content: 'Le gusta la música clásica',
    importance: 0.7,
    tags: ['inferred', 'value'],
    inferred: 1,
    confidence: 0.8,
    decay_rate: INFERRED_DECAY_RATE,
  });
  graph.confirmInferred(archived, 'rejected');
  assert(
    !graph.getUserModel({ limit: 20 }).some((n) => n.id === archived),
    'archivado sale del modelo'
  );

  graph.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Run ─────────────────────────────────────────────────────────────────────

(async () => {
  await testCreatesInferredNode();
  await testRejectsConfidenceOutOfRange();
  await testRejectsFixedLabelCollision();
  await testRejectsDynamicPrefixCollision();
  await testRejectsInventedEpisodes();
  await testRejectsCommandContent();
  await testRejectsKindPrefixMismatch();
  await testNullResponse();
  await testNeverCallsContradictionResolver();
  await testMergeBySimilarity();
  await testConfirmAccepted();
  await testConfirmRejectedArchives();
  await testConfirmRejectsNonInferred();
  await testPiggybackDoesNotThrow();
  await testSkipsAlreadyModeled();
  await testExcludesConsolidatedEpisodes();
  await testSharedCandidateHelper();
  await testGetUserModelSeparation();

  console.log(`\n${C.bold(`Resultado: ${C.green(`${passed} ✓`)} / ${C.red(`${failed} ✗`)}`)}`);
  process.exit(failed ? 1 : 0);
})();
