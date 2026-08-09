'use strict';

/**
 * F2.1 — Memoria funcional.
 *
 * Cubre:
 *   - decay que NO cuenta getWorldModel (las lecturas de world model no
 *     refrescan recencia → los nodos estables pueden decaer/archivarse)
 *   - limpieza de vectores de nodos archivados (al archivar y tras applyDecay)
 *   - presupuesto de la sección de memoria del system prompt (GroqSerializer)
 *
 * Correr bajo Electron: ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron tests/test_memory_f2.js
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
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
const { GroqSerializer } = require('../core/grounding/serializers/GroqSerializer.js');

function makeGraph() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-f2-'));
  const graph = new StateGraph(path.join(dir, 'core.db')).init();
  return { graph, dir };
}

function sqlAll(graph, sql, ...args) {
  return graph._db.prepare(sql).all(...args);
}

// Embedder falso determinista (mismo patrón que test_state_graph): vector por
// frecuencia de caracteres, 384 dims normalizado.
function fakeEmbed(text) {
  const vec = new Array(384).fill(0);
  const t = String(text || '').toLowerCase();
  for (const ch of t) {
    if (/\s/.test(ch)) continue;
    vec[ch.charCodeAt(0) % 384] += 1;
  }
  const norm = Math.sqrt(vec.reduce((a, b) => a + b * b, 0)) || 1;
  return vec.map((v) => v / norm);
}
function fakeFloat32ToBuffer(arr) {
  const buf = Buffer.alloc(arr.length * 4);
  for (let i = 0; i < arr.length; i++) buf.writeFloatLE(arr[i], i * 4);
  return buf;
}
function patchEmbedder() {
  const EmbedService = require('../core/grounding/EmbedService.js');
  const orig = {
    embedText: EmbedService.embedText,
    float32ToBuffer: EmbedService.float32ToBuffer,
  };
  EmbedService.embedText = async (t) => fakeEmbed(t);
  EmbedService.float32ToBuffer = fakeFloat32ToBuffer;
  return () => {
    EmbedService.embedText = orig.embedText;
    EmbedService.float32ToBuffer = orig.float32ToBuffer;
  };
}

function vectorCount(graph) {
  try {
    return sqlAll(graph, 'SELECT rowid FROM node_vectors').length;
  } catch {
    return -1;
  }
}

const waitForVectors = async (graph, min) => {
  for (let i = 0; i < 50; i++) {
    if (vectorCount(graph) >= min) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return vectorCount(graph) >= min;
};

// ── Test 1: decay no cuenta el getWorldModel ────────────────────────────────
function testDecayWorldModel() {
  console.log(C.bold('\nTest 1: getWorldModel NO refresca recencia'));
  const { graph, dir } = makeGraph();

  const id = graph.createNode({
    type: 'User',
    label: 'usuario_base',
    content: 'Dato estable de contexto',
    importance: 0.9,
  });

  const before = sqlAll(
    graph,
    'SELECT last_accessed_at, access_count FROM nodes WHERE id=?',
    id
  )[0];

  // Tres lecturas de world model no deben mover last_accessed_at ni access_count.
  graph.getWorldModel();
  graph.getWorldModel();
  graph.getWorldModel();
  const after = sqlAll(graph, 'SELECT last_accessed_at, access_count FROM nodes WHERE id=?', id)[0];

  assert(
    after.last_accessed_at === before.last_accessed_at,
    'world model no toca last_accessed_at'
  );
  assert(after.access_count === before.access_count, 'world model no suma access_count');

  // Un recall intencional SÍ refresca recencia.
  const touched = graph.queryNodes({ type: 'User', limit: 5 });
  assert(
    touched.some((n) => n.id === id),
    'queryNodes devuelve el nodo User'
  );
  const afterTouch = sqlAll(graph, 'SELECT last_accessed_at FROM nodes WHERE id=?', id)[0];
  assert(afterTouch.last_accessed_at > after.last_accessed_at, 'queryNodes sí refresca recencia');

  graph.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Test 2: archivar purga el vector del nodo ───────────────────────────────
async function testArchivePurgesVector() {
  console.log(C.bold('\nTest 2: archivar purga el vector del nodo'));
  const restore = patchEmbedder();
  const { graph, dir } = makeGraph();

  try {
    const sqliteVec = require('sqlite-vec');
    sqliteVec.load(graph._db);
    assert(graph.enableVectorSearch() === true, 'enableVectorSearch habilita node_vectors');

    const id = graph.createNode({
      type: 'Belief',
      label: 'dato_purgable',
      content: 'Contenido a archivar con su vector',
      importance: 0.8,
    });

    assert(await waitForVectors(graph, 1), 'nodo embeddeado (vector presente)');

    graph.forget('dato_purgable');
    const node = graph.getNode(id);
    assert(node.archived === 1, 'forget archiva el nodo');
    assert(vectorCount(graph) === 0, 'vector del nodo archivado fue purgado');
  } finally {
    graph.close();
    fs.rmSync(dir, { recursive: true, force: true });
    restore();
  }
}

// ── Test 3: applyDecay purga vectores de nodos archivados ───────────────────
async function testDecayPurgesVectors() {
  console.log(C.bold('\nTest 3: applyDecay purga vectores archivados'));
  const restore = patchEmbedder();
  const { graph, dir } = makeGraph();

  try {
    const sqliteVec = require('sqlite-vec');
    sqliteVec.load(graph._db);
    assert(graph.enableVectorSearch() === true, 'enableVectorSearch habilita node_vectors');

    const idOld = graph.createNode({
      type: 'Belief',
      label: 'dato_decae',
      content: 'Algo que se va a archivar por decay',
      importance: 0.5,
    });
    graph.createNode({
      type: 'Belief',
      label: 'dato_nuevo',
      content: 'Algo que se mantiene',
      importance: 0.5,
    });

    assert(await waitForVectors(graph, 2), 'ambos nodos embeddeados');

    // El nodo viejo no se accede hace 130 días → 0.5*0.98^130 ≈ 0.036 < 0.05
    const oldTs = Date.now() - 130 * 24 * 60 * 60 * 1000;
    graph._db.prepare('UPDATE nodes SET last_accessed_at=? WHERE id=?').run(oldTs, idOld);

    const vectorsBefore = vectorCount(graph);
    const res = graph.applyDecay();
    assert(graph.getNode(idOld).archived === 1, 'decay archiva el nodo viejo');
    assert(res.archived === 1, 'applyDecay reporta 1 archivado');
    assert(
      vectorCount(graph) === vectorsBefore - 1,
      `vector purgado tras decay (${vectorsBefore} → ${vectorCount(graph)})`
    );
  } finally {
    graph.close();
    fs.rmSync(dir, { recursive: true, force: true });
    restore();
  }
}

// ── Test 4: presupuesto de la sección de memoria ────────────────────────────
function memorySection(systemPrompt) {
  const parts = systemPrompt.split('\n\n---\n\n');
  return parts.find((p) => p.startsWith('## Lo que sé del usuario')) || '';
}

function testMemoryBudget() {
  console.log(C.bold('\nTest 4: presupuesto de la sección de memoria'));
  const serializer = new GroqSerializer();

  const countNodeLines = (systemPrompt) =>
    (memorySection(systemPrompt).match(/^- \(Belief\):/gm) || []).length;

  // Caso A: nodos cortos → caben TODOS (el presupuesto permite más de 8).
  {
    const shortNodes = Array.from({ length: 20 }, (_, i) => ({
      type: 'Belief',
      label: `dato_corto_${i}`,
      content: `Dato corto numero ${i}`,
      importance: 1,
    }));
    const { systemPrompt } = serializer.serialize(
      { identity: null, persistentMemory: { nodes: shortNodes, episodes: [] } },
      { includeMemory: true }
    );
    const n = countNodeLines(systemPrompt);
    assert(n >= 18, `nodos cortos: entran casi todos (20 enviados, se muestran ${n})`);
  }

  // Caso B: nodos largos → se recortan a 200 chars cada uno y caben muchos menos.
  {
    const longNodes = Array.from({ length: 20 }, (_, i) => ({
      type: 'Belief',
      label: `dato_largo_${i}`,
      content: 'X'.repeat(5000),
      importance: 1,
    }));
    const { systemPrompt } = serializer.serialize(
      { identity: null, persistentMemory: { nodes: longNodes, episodes: [] } },
      { includeMemory: true }
    );
    const n = countNodeLines(systemPrompt);
    assert(n < 20, `nodos largos: no entran los 20 (se muestran ${n})`);
    assert(n >= 1, `nodos largos: al menos 1 entra (se muestran ${n})`);
    const section = memorySection(systemPrompt);
    assert(section.length <= 2700, `sección de memoria acotada (${section.length} chars)`);
  }

  // Caso C: sección vacía → sin sección.
  {
    const { systemPrompt } = serializer.serialize(
      { identity: null, persistentMemory: null },
      { includeMemory: true }
    );
    assert(memorySection(systemPrompt) === '', 'sin nodos, sin sección de memoria');
  }
}

(async function main() {
  testDecayWorldModel();
  testMemoryBudget();
  await testArchivePurgesVector();
  await testDecayPurgesVectors();

  console.log(
    `\n${C.bold('test_memory_f2')}: ${C.green(passed + ' pasaron')}${
      failed ? ', ' + C.red(failed + ' fallaron') : ''
    }`
  );
  process.exit(failed > 0 ? 1 : 0);
})();
