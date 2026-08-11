'use strict';

/**
 * Segmentación temática de sesiones (F3.2) — _segmentByTopic + processSession.
 *
 * Un session entera con 2-3 temas distintos debe generar >=2 Episode nodes
 * (uno por segmento), con resúmenes separados por tema. La sesión corta o
 * monotemática sigue generando EXACTAMENTE 1 Episode (regresión del caso común).
 *
 * IMPORTANTE: correr con ELECTRON_RUN_AS_NODE=1 (ABI de Electron) porque
 * better-sqlite3 está compilado para Electron.
 *
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron tests/test_session_segmentation.js
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
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
const { StateUpdater } = require('../core/state-graph/StateUpdater.js');
const LLMProvider = require('../core/llm/LLMProvider.js');

function makeGraph() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seg-test-'));
  const dbPath = path.join(dir, 'core.db');
  const graph = new StateGraph(dbPath).init();
  return { graph, dbPath, dir };
}

function sqlAll(graph, sql, ...args) {
  return graph._db.prepare(sql).all(...args);
}

// ── Embedder determinista por tema ───────────────────────────────────────────
// Vectores one-hot por tema: la similitud coseno entre turnos del MISMO tema es
// 1 (coseno de vectores iguales) y entre temas distintos es 0 — muy por debajo
// del umbral SEGMENT_COSINE_THRESHOLD (0.4). Esto hace que el corte por tema sea
// determinista y no dependa del modelo ONNX real.
const TOPIC_MARKERS = [
  [/trabajo|empresa|oficina|desarrollo|proyecto de la empresa/i, 0],
  [/zelda|nintendo|videojuego|mario|consola|juego/i, 1],
  [/paella|comida|pizza|taco|cocina|ingrediente/i, 2],
];
function topicEmbed(text) {
  const v = new Array(384).fill(0);
  const marker = TOPIC_MARKERS.find(([re]) => re.test(text));
  v[marker ? marker[1] : 3] = 1;
  return v;
}

function patchEmbedder() {
  const EmbedService = require('../core/grounding/EmbedService.js');
  const orig = {
    embedText: EmbedService.embedText,
    float32ToBuffer: EmbedService.float32ToBuffer,
  };
  EmbedService.embedText = async (t) => topicEmbed(t);
  EmbedService.float32ToBuffer = (arr) => Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
  return orig;
}

// ── Mock del LLM por tema ────────────────────────────────────────────────────
// Devuelve un episode_summary QUE LLEVA EL TEMA del historial que recibe, para
// poder asertar que cada Episode quedó separado por tema.
function topicSummary(text) {
  const s = String(text);
  for (const [re, idx] of TOPIC_MARKERS) {
    if (re.test(s)) return `Resumen sobre tema ${idx} (coherente con el segmento)`;
  }
  return 'Resumen sobre tema generico';
}
function mockTopicLLM() {
  const orig = { complete: LLMProvider.complete, completeTask: LLMProvider.completeTask };
  LLMProvider.completeTask = async (messages) => {
    const content = messages[0].content;
    return JSON.stringify({
      episode_summary: topicSummary(content),
      episode_importance: 0.7,
      nodes: [],
      relations: [],
    });
  };
  LLMProvider.complete = LLMProvider.completeTask;
  return orig;
}

function restoreLLM(orig) {
  LLMProvider.complete = orig.complete;
  LLMProvider.completeTask = orig.completeTask;
}

// Fixture: 3 temas de 4 turnos cada uno = 12 turnos.
function makeMultiTopicHistory() {
  return [
    // Tema 0: trabajo
    { role: 'user', content: 'hoy arranque un nuevo proyecto en la empresa' },
    { role: 'assistant', content: 'cuentame mas del proyecto de la empresa' },
    { role: 'user', content: 'estoy en el desarrollo del backend de la oficina' },
    { role: 'assistant', content: 'suena a un desafio interesante en el trabajo' },
    // Tema 1: videojuego
    { role: 'user', content: 'me pase todo el finde jugando al nuevo zelda' },
    { role: 'assistant', content: 'el ultimo zelda de nintendo es increible' },
    { role: 'user', content: 'llevo 40 horas de juego y aun no lo termino' },
    { role: 'assistant', content: 'ese videojuego da para muchisimas horas' },
    // Tema 2: comida
    { role: 'user', content: 'cene una paella con mariscos muy rica' },
    { role: 'assistant', content: 'la paella siempre es una buena eleccion' },
    { role: 'user', content: 'quise probar una receta de pizza casera y salio bien' },
    { role: 'assistant', content: 'la pizza casera nunca falla en la cocina' },
  ];
}

// Fixture monotemática: 8 turnos sobre el mismo tema (trabajo en la empresa).
function makeSingleTopicHistory() {
  const lines = [
    'mañana tengo reunion en la empresa',
    'preparo el informe del desarrollo',
    'el desarrollo avanza bien',
    'mande el avance a la oficina',
    'la oficina cambio de metodologia',
    'estamos con el despliegue del desarrollo',
    'queda poco del desarrollo de la empresa',
    'coordino el cierre con la oficina',
  ];
  return lines.map((c, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: c }));
}

// Fixture corta: 4 turnos (menos del mínimo de segmentación).
function makeShortHistory() {
  return [
    { role: 'user', content: 'hola, hoy me prepare un cafe' },
    { role: 'assistant', content: 'que rico, buen cafe' },
    { role: 'user', content: 'tambien probe una medialuna' },
    { role: 'assistant', content: 'las medialunas van bien con el cafe' },
  ];
}

// ── Test 1: _segmentByTopic corta por tema (fixture 3 temas) ────────────────

async function testSegmentMultiTopic() {
  console.log(C.bold('\nTest 1: _segmentByTopic separa 3 temas en 3 segmentos'));
  const { graph } = makeGraph();
  const embedOrig = patchEmbedder();
  const updater = new StateUpdater(graph);

  const segments = await updater._segmentByTopic(makeMultiTopicHistory());
  assert(segments.length === 3, '3 temas −> 3 segmentos', `got=${segments.length}`);

  // Cada segmento es monotemático: el primer turno de cada segmento define el
  // tema y no se mezcla con el siguiente.
  const joinSeg = (seg) => seg.map((t) => t.content).join(' ');
  assert(
    /trabajo|empresa|oficina|desarrollo/i.test(joinSeg(segments[0])) &&
      !/zelda|paella/i.test(joinSeg(segments[0])),
    'segmento 1: solo tema trabajo'
  );
  assert(
    /zelda|nintendo|videojuego|juego/i.test(joinSeg(segments[1])) &&
      !/paella|empresa/i.test(joinSeg(segments[1])),
    'segmento 2: solo tema videojuego'
  );
  assert(
    /paella|pizza|comida|cocina/i.test(joinSeg(segments[2])) &&
      !/empresa|zelda/i.test(joinSeg(segments[2])),
    'segmento 3: solo tema comida'
  );

  // Cada segmento conserva sus 4 turnos.
  assert(
    segments.every((s) => s.length === 4),
    'cada segmento conserva 4 turnos',
    segments.map((s) => s.length).join(',')
  );

  graph.close();
  fs.rmSync(path.dirname(graph._dbPath), { recursive: true, force: true });
  const EmbedService = require('../core/grounding/EmbedService.js');
  EmbedService.embedText = embedOrig.embedText;
  EmbedService.float32ToBuffer = embedOrig.float32ToBuffer;
}

// ── Test 2: sesión corta o monotemática NO se segmenta ──────────────────────

async function testNoOverSegmentation() {
  console.log(C.bold('\nTest 2: sesiones cortas/monotemáticas NO se over-segmentan'));
  const { graph } = makeGraph();
  const embedOrig = patchEmbedder();
  const updater = new StateUpdater(graph);

  // Menos de 6 turnos → un solo segmento aunque haya cambio de tema.
  const short = await updater._segmentByTopic(makeShortHistory());
  assert(short.length === 1, 'sesión de 4 turnos → 1 segmento', `got=${short.length}`);
  assert(short[0].length === 4, 'el segmento conserva los 4 turnos');

  // Monotemática (8 turnos, un solo tema) → 1 segmento: no hay corte con
  // similitud < umbral porque todos los turnos comparten el mismo vector.
  const single = await updater._segmentByTopic(makeSingleTopicHistory());
  assert(
    single.length === 1,
    'sesión monotemática de 8 turnos → 1 segmento',
    `got=${single.length}`
  );
  assert(single[0].length === 8, 'el segmento conserva los 8 turnos');

  graph.close();
  fs.rmSync(path.dirname(graph._dbPath), { recursive: true, force: true });
  const EmbedService = require('../core/grounding/EmbedService.js');
  EmbedService.embedText = embedOrig.embedText;
  EmbedService.float32ToBuffer = embedOrig.float32ToBuffer;
}

// ── Test 3: processSession multi-tema → >=2 Episodes separados ──────────────

async function testProcessSessionMultiSegment() {
  console.log(C.bold('\nTest 3: processSession genera un Episode por segmento'));
  const { graph } = makeGraph();
  const embedOrig = patchEmbedder();
  const llmOrig = mockTopicLLM();

  const sid = graph.startSession();
  const updater = new StateUpdater(graph);
  const res = await updater.processSession(sid, makeMultiTopicHistory(), 12);

  const episodes = sqlAll(
    graph,
    "SELECT content FROM nodes WHERE type='Episode' AND archived=0 ORDER BY id"
  );
  assert(
    episodes.length >= 2,
    '>=2 Episodes desde una sesión de 3 temas',
    `got=${episodes.length}`
  );

  const contents = episodes.map((e) => e.content).join('\n');
  assert(/tema 0/.test(contents), 'hay un Episode del tema trabajo');
  assert(/tema 1/.test(contents), 'hay un Episode del tema videojuego');
  assert(/tema 2/.test(contents), 'hay un Episode del tema comida');

  // Un solo resumen lo cubre: todos los temas están en Episodes DISTINTOS.
  const tema0 = episodes.filter((e) => /tema 0/.test(e.content));
  const tema1 = episodes.filter((e) => /tema 1/.test(e.content));
  assert(
    tema0.length === 1 && tema1.length === 1,
    'el tema trabajo y el videojuego viven en Episodes separados'
  );

  // sessions.summary a nivel sesión NO desaparece (cubre la sesión completa).
  const session = graph._db.prepare('SELECT summary FROM sessions WHERE id=?').get(sid);
  assert(
    typeof session.summary === 'string' && session.summary.length > 0,
    'sessions.summary sigue presente'
  );
  assert(
    res.segments === 3,
    'el resultado reporta la cantidad de segmentos',
    `got=${res.segments}`
  );

  graph.close();
  fs.rmSync(path.dirname(graph._dbPath), { recursive: true, force: true });
  const EmbedService = require('../core/grounding/EmbedService.js');
  EmbedService.embedText = embedOrig.embedText;
  EmbedService.float32ToBuffer = embedOrig.float32ToBuffer;
  restoreLLM(llmOrig);
}

// ── Test 4: regresión — sesión corta/monotemática → 1 solo Episode ──────────

async function testProcessSessionSingleSegment() {
  console.log(C.bold('\nTest 4: sesión corta sigue generando 1 solo Episode (regresión)'));
  const { graph } = makeGraph();
  const embedOrig = patchEmbedder();
  const llmOrig = mockTopicLLM();

  const sid = graph.startSession();
  const updater = new StateUpdater(graph);
  await updater.processSession(sid, makeShortHistory(), 4);

  const episodes = sqlAll(graph, "SELECT content FROM nodes WHERE type='Episode' AND archived=0");
  assert(episodes.length === 1, 'sesión corta → 1 solo Episode', `got=${episodes.length}`);

  const session = graph._db.prepare('SELECT summary FROM sessions WHERE id=?').get(sid);
  assert(
    typeof session.summary === 'string' && session.summary.length > 0,
    'sessions.summary generado'
  );

  graph.close();
  fs.rmSync(path.dirname(graph._dbPath), { recursive: true, force: true });
  const EmbedService = require('../core/grounding/EmbedService.js');
  EmbedService.embedText = embedOrig.embedText;
  EmbedService.float32ToBuffer = embedOrig.float32ToBuffer;
  restoreLLM(llmOrig);
}

// ── Test 5: processSession monotemática larga → 1 Episode (sin over-seg) ────

async function testProcessSessionSingleTopicLong() {
  console.log(C.bold('\nTest 5: sesión larga monotemática → 1 solo Episode'));
  const { graph } = makeGraph();
  const embedOrig = patchEmbedder();
  const llmOrig = mockTopicLLM();

  const sid = graph.startSession();
  const updater = new StateUpdater(graph);
  const res = await updater.processSession(sid, makeSingleTopicHistory(), 8);

  const episodes = sqlAll(graph, "SELECT content FROM nodes WHERE type='Episode' AND archived=0");
  assert(res.segments === 1, 'el pipeline reporta 1 segmento', `got=${res.segments}`);
  assert(episodes.length === 1, 'monotemática → 1 solo Episode', `got=${episodes.length}`);

  graph.close();
  fs.rmSync(path.dirname(graph._dbPath), { recursive: true, force: true });
  const EmbedService = require('../core/grounding/EmbedService.js');
  EmbedService.embedText = embedOrig.embedText;
  EmbedService.float32ToBuffer = embedOrig.float32ToBuffer;
  restoreLLM(llmOrig);
}

// ── Runner ──────────────────────────────────────────────────────────────────

async function main() {
  console.log(C.bold('\n═══ Segmentación temática de sesiones ═══'));
  await testSegmentMultiTopic();
  await testNoOverSegmentation();
  await testProcessSessionMultiSegment();
  await testProcessSessionSingleSegment();
  await testProcessSessionSingleTopicLong();

  console.log(
    C.bold(`\n  Resultado: ${C.green(`${passed} ✓`)}${failed ? ` / ${C.red(`${failed} ✗`)}` : ''}`)
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(C.red('[test_session_segmentation] ERROR inesperado:'), e);
  process.exit(1);
});
