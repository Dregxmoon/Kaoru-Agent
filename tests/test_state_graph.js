'use strict';

/**
 * Verificación real de la memoria persistente (state-graph).
 *
 * IMPORTANTE: correr con ELECTRON_RUN_AS_NODE=1 (ABI de Electron), porque
 * better-sqlite3 está compilado para Electron y bajo `node` del sistema
 * StateGraph cae a MemoryDB y NO se verifica la persistencia real.
 *
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron tests/test_state_graph.js
 *
 * Cubre: schema, CRUD, resolver (overwrite/archive/append/dedup), decay,
 * ciclo de vida de sesiones (incl. resume tras crash), detectAndSaveInstant,
 * recall semántico con vectores, cleanup de artefactos y vectores huérfanos.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

let passed = 0;
let failed = 0;
let skipped = 0;

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

const { StateGraph, NODE_TYPES } = require('../core/state-graph/StateGraph.js');
const { SessionManager } = require('../core/state-graph/SessionManager.js');
const { StateUpdater, isValidLabel } = require('../core/state-graph/StateUpdater.js');
const {
  ContradictionResolver,
  MAX_APPEND_SEGMENTS,
} = require('../core/state-graph/ContradictionResolver.js');
const LLMProvider = require('../core/llm/LLMProvider.js');

function makeGraph() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-test-'));
  const dbPath = path.join(dir, 'core.db');
  const graph = new StateGraph(dbPath).init();
  return { graph, dbPath, dir };
}

// ── Helpers de DB directa (para inspeccionar estados internos) ──────────────
function sqlAll(graph, sql, ...args) {
  return graph._db.prepare(sql).all(...args);
}
function sqlGet(graph, sql, ...args) {
  return graph._db.prepare(sql).get(...args);
}

// ── Embedder falso determinista ──────────────────────────────────────────────
// No depende del modelo ONNX: vector de 384 dims por FRECUENCIA de caracteres
// (independiente de posición). Similaridad ≈ solapamiento de caracteres →
// permite probar el pipeline de ranking (no la calidad del modelo real).
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
  return orig;
}

// Mock del LLM para processSession — controla lo que "extrae" la memoria.
function mockLLM(extraction) {
  const orig = { complete: LLMProvider.complete, completeTask: LLMProvider.completeTask };
  LLMProvider.complete = async () => JSON.stringify(extraction);
  LLMProvider.completeTask = async () => JSON.stringify(extraction);
  return orig;
}

// ── Test 1: Schema ──────────────────────────────────────────────────────────
function testSchema() {
  console.log(C.bold('\nTest 1: Schema y migración'));
  const { graph } = makeGraph();

  const tables = sqlAll(graph, "SELECT name FROM sqlite_master WHERE type='table'").map(
    (r) => r.name
  );
  for (const t of ['nodes', 'sessions', 'app_history']) {
    assert(tables.includes(t), `tabla ${t} existe`);
  }
  assert(
    !tables.includes('episodes'),
    'NO existe tabla "episodes" (los episodios viven en nodes type=Episode)'
  );

  const cols = sqlAll(graph, 'PRAGMA table_info(nodes)').map((c) => c.name);
  for (const c of [
    'id',
    'type',
    'label',
    'content',
    'importance',
    'decay_rate',
    'access_count',
    'tags',
    'archived',
    'created_at',
    'updated_at',
    'last_accessed_at',
  ]) {
    assert(cols.includes(c), `columna nodes.${c} existe`);
  }

  const sessionCols = sqlAll(graph, 'PRAGMA table_info(sessions)').map((c) => c.name);
  assert(sessionCols.includes('history_json'), 'sessions.history_json existe (resume tras crash)');

  const vecExists = sqlGet(
    graph,
    "SELECT name FROM sqlite_master WHERE type='table' AND name='node_vectors'"
  );
  assert(!vecExists, 'node_vectors NO existe antes de enableVectorSearch()');

  graph.close();
  fs.rmSync(path.dirname(graph._dbPath), { recursive: true, force: true });
}

// ── Test 2: CRUD básico ────────────────────────────────────────────────────
function testCRUD() {
  console.log(C.bold('\nTest 2: CRUD de nodos'));
  const { graph } = makeGraph();

  const id = graph.createNode({
    type: 'User',
    label: 'nombre_usuario',
    content: 'El usuario se llama Luka',
    importance: 0.95,
    tags: ['nombre'],
  });
  assert(typeof id === 'number' && id > 0, 'createNode devuelve id numérico', `id=${id}`);

  let threw = false;
  try {
    graph.createNode({ type: 'Alien', label: 'x', content: 'y' });
  } catch (e) {
    threw = true;
  }
  assert(threw, 'createNode rechaza tipo inválido');

  const node = graph.getNode(id);
  assert(node.content === 'El usuario se llama Luka', 'getNode devuelve el contenido');
  assert(node.decay_rate === 0.005, 'decay_rate por tipo (User=0.005)', `got=${node.decay_rate}`);
  assert(node.archived === 0, 'nodo nace activo');

  assert(graph.getNode(99999) === null, 'getNode inexistente → null');

  assert(
    graph.updateNode(id, { content: 'El usuario se llama Lucas', importance: 0.97 }),
    'updateNode devuelve true'
  );
  const updated = graph.getNode(id);
  assert(updated.content === 'El usuario se llama Lucas', 'updateNode actualiza contenido');
  assert(updated.access_count === 1, 'updateNode incrementa access_count');

  assert(graph.updateNode(99999, { content: 'x' }) === false, 'updateNode inexistente → false');

  const uid = graph.upsertNode({
    type: 'Preference',
    label: 'preferencia_anime',
    content: 'Le gusta Evangelion',
    importance: 0.7,
  });
  const uid2 = graph.upsertNode({
    type: 'Preference',
    label: 'preferencia_anime',
    content: 'Le gusta Evangelion y Frieren',
    importance: 0.7,
  });
  assert(uid === uid2, 'upsertNode reusa nodo existente del mismo label');
  assert(
    graph.getNode(uid).content === 'Le gusta Evangelion y Frieren',
    'upsertNode actualiza contenido'
  );

  graph.close();
  fs.rmSync(path.dirname(graph._dbPath), { recursive: true, force: true });
}

// ── Test 3: Resolver (reconciliación) ──────────────────────────────────────
function testResolver() {
  console.log(C.bold('\nTest 3: ContradictionResolver (overwrite/archive/append/dedup)'));
  const { graph } = makeGraph();
  const resolver = new ContradictionResolver(graph);

  // crear nuevo
  const id1 = resolver.resolve({
    type: 'User',
    label: 'edad_usuario',
    content: 'El usuario tiene 30 años',
    importance: 0.85,
  });
  assert(id1 > 0, 'resolve crea nodo nuevo si no existe');

  // contenido idéntico → no-op, mismo id, sin inflar importance
  const id1b = resolver.resolve({
    type: 'User',
    label: 'edad_usuario',
    content: 'El usuario tiene 30 años',
    importance: 0.85,
  });
  assert(id1b === id1, 'contenido idéntico → no duplica');

  // overwrite: usuario corrige su edad
  resolver.resolve({
    type: 'User',
    label: 'edad_usuario',
    content: 'El usuario tiene 31 años',
    importance: 0.9,
  });
  const ed = graph.getNode(id1);
  assert(ed.content === 'El usuario tiene 31 años', 'overwrite reemplaza contenido');
  assert(ed.archived === 0, 'overwrite mantiene activo');
  assert(
    graph.queryNodes({ search: '30 años' }).length === 0,
    'overwrite no deja el valor viejo por ningún lado'
  );

  // archive_and_replace: color favorito cambia
  const c1 = resolver.resolve({
    type: 'Preference',
    label: 'color_favorito',
    content: 'Colores favoritos: azul',
    importance: 0.8,
  });
  resolver.resolve({
    type: 'Preference',
    label: 'color_favorito',
    content: 'Colores favoritos: rojo',
    importance: 0.8,
  });
  assert(graph.getNode(c1).archived === 1, 'archive_and_replace archiva el viejo');
  const active = graph._findActiveNodeByLabel('color_favorito');
  assert(active && active.content.includes('rojo'), 'archive_and_replace activa el nuevo');
  assert(active.id !== c1, 'archive_and_replace crea id nuevo');

  // append con cap: label dinámico proyecto_* (el principal usa overwrite por diseño)
  const p1 = resolver.resolve({
    type: 'Project',
    label: 'proyecto_secundario',
    content: 'Proyecto: Asistente Vtuber',
    importance: 0.8,
  });
  const p2 = resolver.resolve({
    type: 'Project',
    label: 'proyecto_secundario',
    content: 'Mejora de memoria',
    importance: 0.8,
  });
  const p3 = resolver.resolve({
    type: 'Project',
    label: 'proyecto_secundario',
    content: 'Integración LSP',
    importance: 0.8,
  });
  const p4 = resolver.resolve({
    type: 'Project',
    label: 'proyecto_secundario',
    content: 'Nuevo tema de UI',
    importance: 0.8,
  });
  assert(p1 === p2 && p2 === p3 && p3 === p4, 'append conserva el mismo nodo');
  const segs = graph.getNode(p1).content.split(' | Actualizado: ');
  assert(
    segs.length === MAX_APPEND_SEGMENTS,
    `append respeta cap (${MAX_APPEND_SEGMENTS} segmentos)`,
    `got=${segs.length}: ${graph.getNode(p1).content}`
  );

  // append descarta contenido tipo comando
  const before = graph.getNode(p1).content;
  resolver.resolve({
    type: 'Project',
    label: 'proyecto_secundario',
    content: 'Ejecutar: git status',
    importance: 0.8,
  });
  assert(graph.getNode(p1).content === before, 'append descarta contenido tipo comando');

  // dedup: dos nodos activos del mismo label → archiva el más viejo
  const d1 = graph.createNode({
    type: 'Belief',
    label: 'preferencia_juego',
    content: 'Le gusta el café',
    importance: 0.6,
  });
  graph.createNode({
    type: 'Belief',
    label: 'preferencia_juego',
    content: 'Le gusta el té',
    importance: 0.7,
  });
  graph.createNode({
    type: 'Belief',
    label: 'preferencia_juego',
    content: 'Le gusta la miel',
    importance: 0.8,
  });
  const activeBefore = sqlAll(
    graph,
    "SELECT COUNT(*) c FROM nodes WHERE label='preferencia_juego' AND archived=0"
  )[0].c;
  assert(activeBefore === 3, 'setup: 3 nodos activos duplicados', `got=${activeBefore}`);
  resolver.deduplicateNodes();
  const activeAfter = sqlAll(
    graph,
    "SELECT COUNT(*) c FROM nodes WHERE label='preferencia_juego' AND archived=0"
  )[0].c;
  assert(activeAfter === 1, 'deduplicateNodes deja 1 activo', `got=${activeAfter}`);

  graph.close();
  fs.rmSync(path.dirname(graph._dbPath), { recursive: true, force: true });
}

// ── Test 4: Decay y archivado ──────────────────────────────────────────────
function testDecay() {
  console.log(C.bold('\nTest 4: Decay temporal y archivado'));
  const { graph } = makeGraph();

  const idOld = graph.createNode({
    type: 'Belief',
    label: 'preferencia_vieja',
    content: 'Algo que ya no se usa',
    importance: 0.5,
  });
  const idNew = graph.createNode({
    type: 'Belief',
    label: 'preferencia_nueva',
    content: 'Algo que se usa',
    importance: 0.5,
  });

  // Simular: el nodo viejo no se accede hace 130 días → 0.5*0.98^130 ≈ 0.036 < umbral 0.05
  const oldTs = Date.now() - 130 * 24 * 60 * 60 * 1000;
  graph._db.prepare('UPDATE nodes SET last_accessed_at=? WHERE id=?').run(oldTs, idOld);

  graph.applyDecay();
  assert(graph.getNode(idOld).archived === 1, 'nodo sin acceso 130 días se archiva');
  assert(graph.getNode(idNew).archived === 0, 'nodo reciente sigue activo');
  assert(graph.getNode(idNew).importance === 0.5, 'nodo con last_accessed hoy no decae');

  // Decay por acceso: un nodo tocado ayer no debería archivarse aunque sea viejo
  const idTouched = graph.createNode({
    type: 'Episode',
    label: 'sesion_x',
    content: 'Episodio',
    importance: 0.4,
  });
  graph._db
    .prepare('UPDATE nodes SET last_accessed_at=? WHERE id=?')
    .run(Date.now() - 36 * 60 * 60 * 1000, idTouched);
  graph._touchNodes([idTouched], 'test');
  graph.applyDecay();
  assert(graph.getNode(idTouched).archived === 0, 'nodo tocado recientemente NO se archiva (QW-2)');

  graph.close();
  fs.rmSync(path.dirname(graph._dbPath), { recursive: true, force: true });
}

// ── Test 5: Sesiones + resume tras crash ───────────────────────────────────
function testSessions() {
  console.log(C.bold('\nTest 5: Ciclo de vida de sesiones y resume'));
  const { graph, dir } = makeGraph();

  const sid = graph.startSession();
  assert(sid > 0, 'startSession crea sesión');

  graph.updateSessionHistory(sid, [
    { role: 'user', content: 'hola' },
    { role: 'assistant', content: 'hola!' },
  ]);
  const row = sqlGet(graph, 'SELECT history_json, turn_count FROM sessions WHERE id=?', sid);
  const parsed = JSON.parse(row.history_json);
  assert(
    parsed.length === 2 && parsed[0].content === 'hola',
    'updateSessionHistory persiste history_json'
  );

  // resumible antes de cerrar
  const resumable = graph.findResumableSession(12);
  assert(
    resumable && resumable.id === sid,
    'findResumableSession encuentra sesión interrumpida (ended_at NULL)'
  );
  assert(resumable.history.length === 2, 'findResumableSession devuelve historial');

  // tras cerrar, ya no es resumible
  graph.endSession(sid, { turnCount: 2, summary: 'resumen' });
  assert(graph.findResumableSession(12) === null, 'sesión cerrada ya no es resumible');
  const last = graph.getLastSessions(5);
  assert(
    last.length === 1 && last[0].id === sid && last[0].summary === 'resumen',
    'getLastSessions devuelve sesión cerrada'
  );

  // ── SessionManager: flujo nuevo → crash → resume → close ──
  const g1 = new StateGraph(path.join(dir, 'session.db')).init();
  const sm1 = new SessionManager(g1, null, { resumeMaxAgeHours: 48 });
  const restore = mockLLM({ episode_summary: null, episode_importance: 0, nodes: [] });

  return (async () => {
    const s1 = await sm1.start(null);
    assert(s1.resumed === false, 'SessionManager.start arranca sesión nueva');
    sm1.addTurn('user', 'me llamo luka');
    sm1.addTurn('assistant', 'encantada');
    sm1.addTurn('user', 'mi color favorito es el verde');

    // simular crash: NO llamar close(), crear SessionManager nuevo sobre la misma DB
    const persisted = sqlGet(
      g1,
      'SELECT history_json, ended_at FROM sessions ORDER BY started_at DESC LIMIT 1'
    );
    assert(
      persisted.history_json && JSON.parse(persisted.history_json).length === 3,
      'tras crash, history_json tiene los 3 turnos'
    );
    assert(persisted.ended_at === null, 'tras crash, ended_at sigue NULL');

    const sm2 = new SessionManager(g1, null, { resumeMaxAgeHours: 48 });
    const s2 = await sm2.start(null);
    assert(s2.resumed === true, 'SessionManager.start RETOMA la sesión interrumpida');
    assert(s2.history.length === 3, 'resume con historial completo', `got=${s2.history.length}`);
    assert(s2.sessionId === s1.sessionId, 'resume reutiliza el mismo sessionId');

    // la sesión retomada sigue acumulando
    sm2.addTurn('user', 'sigo hablando tras el reinicio');
    const after = sqlGet(g1, 'SELECT history_json FROM sessions WHERE id=?', s1.sessionId);
    assert(JSON.parse(after.history_json).length === 4, 'tras resume, sigue persistiendo');

    // close() procesa la memoria y cierra la sesión
    const closeResult = await sm2.close();
    assert(typeof closeResult.saved === 'number', 'close() procesa sesión (saved=número)');
    const closed = sqlGet(g1, 'SELECT ended_at FROM sessions WHERE id=?', s1.sessionId);
    assert(closed.ended_at !== null, 'close() marca ended_at');

    // verify instant nodes were saved by detectAndSaveInstant
    const nombre = g1._findActiveNodeByLabel('nombre_usuario');
    assert(nombre && nombre.content.includes('luka'), 'detectAndSaveInstant guardó el nombre');
    const color = g1._findActiveNodeByLabel('color_favorito');
    assert(color && color.content.includes('verde'), 'detectAndSaveInstant guardó el color');

    g1.close();
    graph.close();
    fs.rmSync(dir, { recursive: true, force: true });
    LLMProvider.complete = restore.complete;
    LLMProvider.completeTask = restore.completeTask;
  })();
}

// ── Test 6: detectAndSaveInstant ───────────────────────────────────────────
function testInstant() {
  console.log(C.bold('\nTest 6: Guardado inmediato por regex (sin LLM)'));
  const { graph } = makeGraph();
  const updater = new StateUpdater(graph);

  assert(updater.detectAndSaveInstant('hola me llamo Panfilo') === 1, 'detecta nombre');
  assert(
    graph._findActiveNodeByLabel('nombre_usuario').content.includes('Panfilo'),
    'nombre guardado'
  );

  assert(updater.detectAndSaveInstant('tengo 42 años') === 1, 'detecta edad');
  assert(graph._findActiveNodeByLabel('edad_usuario').content.includes('42'), 'edad guardada');

  assert(
    updater.detectAndSaveInstant('en realidad mi color favorito es el rojo') === 1,
    'detecta corrección de color'
  );
  assert(
    graph._findActiveNodeByLabel('color_favorito').content.includes('rojo'),
    'corrección aplicada'
  );

  assert(updater.detectAndSaveInstant('vivo en Ciudad de México') === 1, 'detecta ubicación');

  assert(
    updater.detectAndSaveInstant('estoy desarrollando un asistente vtuber') === 1,
    'detecta proyecto principal'
  );

  // recordar_ → label debe ser válido y node tipo Belief
  const beforeCount = sqlAll(graph, "SELECT COUNT(*) c FROM nodes WHERE label LIKE 'recordar_%'")[0]
    .c;
  assert(
    updater.detectAndSaveInstant('recuerda que odio el cilantro') === 1,
    'detecta "recuerda que..."'
  );
  const rem = sqlAll(graph, "SELECT * FROM nodes WHERE label LIKE 'recordar_%' AND archived=0");
  assert(rem.length === beforeCount + 1, 'crea nodo recordar_*', `got=${rem.length}`);
  assert(rem[0].type === 'Belief', 'recordar_* es Belief');
  assert(isValidLabel(rem[0].label), 'recordar_* label es VÁLIDO según isValidLabel', rem[0].label);

  // no detecta mensajes vacíos o basura
  assert(updater.detectAndSaveInstant('') === 0, 'mensaje vacío no guarda nada');
  assert(updater.detectAndSaveInstant('qué hora es?') === 0, 'pregunta casual no guarda nada');

  graph.close();
  fs.rmSync(path.dirname(graph._dbPath), { recursive: true, force: true });
}

// ── Test 7: Recall semántico (vectores) ────────────────────────────────────
function testSemanticRecall() {
  console.log(C.bold('\nTest 7: Recall semántico (queryNodesSemantic)'));
  const { graph } = makeGraph();
  const sqliteVec = require('sqlite-vec');
  sqliteVec.load(graph._db);
  assert(graph.enableVectorSearch() === true, 'enableVectorSearch habilita node_vectors');

  const restore = patchEmbedder();

  return (async () => {
    const projId = graph.createNode({
      type: 'Project',
      label: 'proyecto_principal',
      content: 'Estoy desarrollando un videojuego de rol con combate por turnos',
      importance: 0.9,
    });
    const animeId = graph.createNode({
      type: 'Preference',
      label: 'preferencia_anime',
      content: 'Le gusta el anime de romance escolar',
      importance: 0.7,
    });
    // esperar a que la cola de embeddings procese ambos nodos
    for (let i = 0; i < 50; i++) {
      if (graph._embeddingInFlight === 0 && graph._embeddingQueue.length === 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const vecs = sqlAll(graph, 'SELECT rowid FROM node_vectors ORDER BY rowid');
    assert(vecs.length === 2, 'ambos nodos tienen vector', `got=${vecs.length}`);

    const results = await graph.queryNodesSemantic('que videojuego estoy desarrollando', {
      limit: 5,
    });
    assert(results.length >= 1, 'queryNodesSemantic devuelve resultados');
    const top = results[0];
    assert(
      top.id === projId,
      'el nodo de proyecto rankea PRIMERO para la query',
      `top=${top.id} (${top.label})`
    );

    const results2 = await graph.queryNodesSemantic('que anime me gusta', { limit: 5 });
    assert(
      results2[0].id === animeId,
      'el nodo de anime rankea PRIMERO para su query',
      `top=${results2[0].id}`
    );

    const filtered = await graph.queryNodesSemantic('que videojuego estoy desarrollando', {
      type: 'Project',
      limit: 5,
    });
    assert(
      filtered.every((n) => n.type === 'Project'),
      'filtro por type se aplica'
    );

    // includeArchived: el nodo archivado NO aparece por defecto
    const old = graph.createNode({
      type: 'Belief',
      label: 'preferencia_ciudad',
      content: 'Quiere mudarse a Guadalajara',
      importance: 0.5,
    });
    graph._archiveNode(old);
    const noArch = await graph.queryNodesSemantic('mudarse a Guadalajara', { limit: 5 });
    assert(!noArch.some((n) => n.id === old), 'nodo archivado no aparece en recall por defecto');

    // fallback: sin searchText cae a queryNodes sin explotar
    const empty = await graph.queryNodesSemantic('', {});
    assert(Array.isArray(empty), 'searchText vacío no truena');

    // backfill: nodo sin vector (creado antes de enableVectorSearch) se embedea
    const nv = graph.createNode({
      type: 'User',
      label: 'ubicacion_usuario',
      content: 'Vive en Monterrey',
      importance: 0.7,
    });
    graph._db.prepare('DELETE FROM node_vectors WHERE rowid=?').run(BigInt(nv));
    const bf = await graph.backfillEmbeddings(10);
    assert(bf.embedded >= 1, 'backfillEmbeddings embedea nodos pendientes', JSON.stringify(bf));
    const vecs2 = sqlAll(graph, 'SELECT rowid FROM node_vectors');
    assert(
      vecs2.some((r) => r.rowid === nv),
      'nodo backfilleado tiene vector'
    );

    // orphan cleanup: vector sin nodo → backfill lo elimina
    graph._db
      .prepare('INSERT INTO node_vectors (rowid, embedding) VALUES (?, ?)')
      .run(BigInt(9999), fakeFloat32ToBuffer(fakeEmbed('huérfano')));
    const bf2 = await graph.backfillEmbeddings(10);
    const orphans = sqlAll(
      graph,
      `SELECT nv.rowid FROM node_vectors nv LEFT JOIN nodes n ON n.id=nv.rowid WHERE n.id IS NULL`
    );
    assert(orphans.length === 0, 'backfill limpia vectores huérfanos', `got=${orphans.length}`);

    graph.close();
    fs.rmSync(path.dirname(graph._dbPath), { recursive: true, force: true });
    IntentDetectorRestore(restore);
  })();
}

// ── Test 7b: Recall ponderado por recencia + importancia ────────────────────
// Fase 2, ítem 3: el recall semántico NO es solo similitud — combina
// similitud × importancia × boost de recencia. Con contenido idéntico, la
// importancia rankea primero; con importancia igual, la recencia desempata.
function testWeightedRecall() {
  console.log(C.bold('\nTest 7b: Recall ponderado por recencia + importancia'));
  const { graph } = makeGraph();
  const sqliteVec = require('sqlite-vec');
  sqliteVec.load(graph._db);
  assert(graph.enableVectorSearch() === true, 'enableVectorSearch habilita node_vectors');

  const restore = patchEmbedder();
  const waitEmbeddings = async () => {
    for (let i = 0; i < 50; i++) {
      if (graph._embeddingInFlight === 0 && graph._embeddingQueue.length === 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  return (async () => {
    const CONTENT = 'Le gusta jugar videojuegos de rol con historias profundas';
    const highId = graph.createNode({
      type: 'Preference',
      label: 'preferencia_high',
      content: CONTENT,
      importance: 0.9,
    });
    const lowId = graph.createNode({
      type: 'Preference',
      label: 'preferencia_low',
      content: CONTENT,
      importance: 0.3,
    });
    await waitEmbeddings();

    // Importancia: misma similitud (contenido idéntico) → rankea el de 0.9.
    let top = await graph.queryNodesSemantic('videojuegos de rol', { limit: 5 });
    assert(
      top[0].id === highId,
      'mayor importancia rankea primero a igual similitud',
      `top=${top[0]?.id}`
    );

    // Recencia: con importancia igual, un nodo viejo cae frente a uno fresco.
    graph.updateNode(lowId, { importance: 0.6 });
    graph.updateNode(highId, { importance: 0.6 });
    graph._db
      .prepare('UPDATE nodes SET last_accessed_at=? WHERE id=?')
      .run(Date.now() - 200 * 24 * 60 * 60 * 1000, highId); // 200 días sin acceso
    top = await graph.queryNodesSemantic('videojuegos de rol', { limit: 5 });
    assert(
      top[0].id === lowId,
      'recencia reciente vence a nodo viejo a igual importancia',
      `top=${top[0]?.id}`
    );

    // Ambos tienen _semanticScore calculado (ponderado), no solo _similarity.
    const scored = await graph.queryNodesSemantic('videojuegos de rol', { limit: 5 });
    assert(
      scored.every((n) => typeof n._semanticScore === 'number'),
      'cada resultado expone _semanticScore ponderado'
    );

    graph.close();
    fs.rmSync(path.dirname(graph._dbPath), { recursive: true, force: true });
    IntentDetectorRestore(restore);
  })();
}

function IntentDetectorRestore(orig) {
  const EmbedService = require('../core/grounding/EmbedService.js');
  EmbedService.embedText = orig.embedText;
  EmbedService.float32ToBuffer = orig.float32ToBuffer;
}

// ── Test 8: cleanupMemoryArtifacts ─────────────────────────────────────────
function testCleanup() {
  console.log(C.bold('\nTest 8: Limpieza de artefactos de comandos'));
  const { graph } = makeGraph();
  const updater = new StateUpdater(graph);

  const dirty = graph.createNode({
    type: 'Project',
    label: 'proyecto_principal',
    content: 'Ejecutar: git status | Actualizado: Lo siento, no pude completar la acción',
    importance: 0.6,
  });
  const mixed = graph.createNode({
    type: 'Preference',
    label: 'preferencia_editor',
    content: 'Usa VS Code | Actualizado: No encontré el archivo',
    importance: 0.6,
  });
  const clean = graph.createNode({
    type: 'Preference',
    label: 'preferencia_te',
    content: 'Le gusta el té de jengibre',
    importance: 0.6,
  });

  const result = updater.cleanupMemoryArtifacts();
  assert(result.archived === 1, 'nodo 100% basura de comando se archiva', JSON.stringify(result));
  assert(graph.getNode(dirty).archived === 1, 'nodo sucio archivado');
  assert(graph.getNode(mixed).archived === 0, 'nodo mezclado NO se archiva');
  assert(
    graph.getNode(mixed).content === 'Usa VS Code',
    'nodo mezclado limpia solo el segmento de comando'
  );
  assert(graph.getNode(clean).content === 'Le gusta el té de jengibre', 'nodo limpio no se toca');

  graph.close();
  fs.rmSync(path.dirname(graph._dbPath), { recursive: true, force: true });
}

// ── Test 9: Relaciones y fallback MemoryDB ─────────────────────────────────
async function testFallbackMemoryMode() {
  console.log(C.bold('\nTest 9: Modo memoria (fallback) sin better-sqlite3'));

  // MemoryDB fallback: mejor-sqlite3 no disponible → no debe truar nada.
  // Se borra el cache del módulo StateGraph y de better-sqlite3, se fuerza
  // Database=null y se re-require el módulo fresco para capturar el fallback.
  const sgKey = require.resolve('../core/state-graph/StateGraph.js');
  const bsqKey = require.resolve('better-sqlite3');
  const sgCache = require.cache[sgKey];
  const bsqCache = require.cache[bsqKey];
  delete require.cache[sgKey];
  delete require.cache[bsqKey];
  require.cache[bsqKey] = { exports: null };
  try {
    const { StateGraph: SG2 } = require('../core/state-graph/StateGraph.js');
    const sg = new SG2('/tmp/opencode/never.db').init();
    assert(sg.usingFallback === true, 'sin better-sqlite3 → usingFallback=true');
    const id = sg.createNode({
      type: 'User',
      label: 'nombre_usuario',
      content: 'memoria en RAM',
      importance: 0.5,
    });
    assert(id > 0, 'MemoryDB permite createNode');
    assert(sg.getNode(id).content === 'memoria en RAM', 'MemoryDB permite getNode');
    assert(Array.isArray(sg.queryNodes({ type: 'User' })), 'MemoryDB permite queryNodes');
    assert(
      sg.queryNodes({ type: 'User' }).length === 1,
      'MemoryDB recupera nodos (recall real en RAM)'
    );

    // La memoria en RAM también debe soportar el ciclo de vida de sesión:
    // start → addTurn → crash → resume → close (antes esto era imposible:
    // get() siempre undefined, all() siempre []).
    const restore2 = mockLLM({ episode_summary: null, episode_importance: 0, nodes: [] });
    const sm = new SessionManager(sg, null, { resumeMaxAgeHours: 48 });
    const sA = await sm.start(null);
    sm.addTurn('user', 'recuerda que tengo reunion a las 5');
    sm.addTurn('assistant', 'anotado');
    const sB = await new SessionManager(sg, null, { resumeMaxAgeHours: 48 }).start(null);
    assert(sB.resumed === true, 'MemoryDB: sesión interrumpida se retoma en RAM');
    assert(sB.history.length === 2, 'MemoryDB: historial completo en RAM');
    const closed = await sm.close();
    assert(typeof closed.saved === 'number', 'MemoryDB: close() procesa y devuelve resultado');
    const rem = sg.queryNodes({ type: 'Belief' });
    assert(
      rem.some((n) => n.content.includes('reunion')),
      'MemoryDB: recuerda el recordatorio',
      JSON.stringify(rem)
    );
    sg.close();
    LLMProvider.complete = restore2.complete;
    LLMProvider.completeTask = restore2.completeTask;
  } finally {
    delete require.cache[bsqKey];
    require.cache[sgKey] = sgCache;
    require.cache[bsqKey] = bsqCache;
  }
}

// ── Test 10: RetrievalPlanner — fallback a keywords sin recall vectorial ────
function testRetrievalKeywordFallback() {
  console.log(C.bold('\nTest 10: RetrievalPlanner — fallback keywords sin vectores'));
  const { graph } = makeGraph();
  const { RetrievalPlanner } = require('../core/grounding/RetrievalPlanner.js');
  // NO llamar enableVectorSearch → _vectorReady=false → queryNodesSemantic cae a
  // un LIKE del mensaje completo que casi nunca coincide → devolvería VACÍO.
  // El fix: RetrievalPlanner debe caer a las keywords extraídas en ese caso.
  graph.createNode({
    type: 'Project',
    label: 'proyecto_videojuego',
    content: 'El proyecto es un videojuego de rol por turnos',
    importance: 0.9,
  });
  graph.createNode({
    type: 'Preference',
    label: 'preferencia_anime',
    content: 'Le gusta el anime de romance escolar',
    importance: 0.7,
  });

  const planner = new RetrievalPlanner(graph);
  return (async () => {
    // mensaje SIN patrón de intención → no pasa por el paso 2 (intents)
    const r = await planner.plan('oye, qué me decías de aquello del videojuego', null);
    const labels = r.nodes.map((n) => n.label);
    assert(
      labels.includes('proyecto_videojuego'),
      'recall sin vectores cae a keywords y encuentra el proyecto',
      `labels=[${labels.join(',')}]`
    );

    // el nodo de anime NO debe colarse por la keyword (no comparte términos)
    const animeHit = r.nodes.filter((n) => n.label === 'preferencia_anime');
    assert(
      animeHit.length <= 1,
      'el recall keyword no devuelve coincidencias falsas',
      `anime=${animeHit.length}`
    );

    graph.close();
    fs.rmSync(path.dirname(graph._dbPath), { recursive: true, force: true });
  })();
}

// ── Test 11: Consolidación episodio→semántica (Fase 2, ítem 2) ─────────────
function testConsolidation() {
  console.log(C.bold('\nTest 11: ConsolidationStore — episodios viejos → hechos'));
  const { graph } = makeGraph();
  const OLD = Date.now() - 30 * 24 * 60 * 60 * 1000;

  const mkOldEpisode = (label, content) => {
    const id = graph.createNode({ type: 'Episode', label, content, importance: 0.3 });
    graph._db.prepare('UPDATE nodes SET created_at=? WHERE id=?').run(OLD, id);
    return id;
  };

  // Tres episodios viejos que comparten UN solo término: "videojuego".
  const e1 = mkOldEpisode('ep_sem1', 'Avanzamos con el videojuego del cliente principal');
  const e2 = mkOldEpisode('ep_sem2', 'Arreglamos bug del videojuego esta manana');
  const e3 = mkOldEpisode('ep_sem3', 'Planificamos la venta del videojuego al equipo');
  // Dos episodios viejos de tema único (cada término aparece 1 sola vez).
  const e4 = mkOldEpisode('ep_uni1', 'Instalamos un plugin de electron');
  const e5 = mkOldEpisode('ep_uni2', 'Revisamos el presupuesto de la oficina');

  const res = graph.runConsolidation({ minAgeDays: 7, minOccurrences: 2 });
  assert(res.facts.length === 1, 'consolida solo el tema recurrente', JSON.stringify(res));
  assert(res.episodes === 3, 'reporta 3 episodios consolidados', `episodes=${res.episodes}`);
  assert(res.facts[0].term === 'videojuego', 'el hecho corresponde al término recurrente');

  const fact = graph.getNode(res.facts[0].id);
  assert(fact.type === 'Belief', 'el hecho es un Belief persistente');
  assert(fact.label === 'consolidacion_videojuego', 'label del hecho es consolidacion_<termino>');
  assert(
    Math.abs(fact.importance - 0.65) < 1e-9,
    'importancia proporcional a la recurrencia (3×0.05+0.5=0.65)',
    `importance=${fact.importance}`
  );
  assert(fact.content.includes('videojuego'), 'el contenido menciona el término');

  const rels = graph.getNodeRelations(res.facts[0].id).filter((r) => r.type === 'CONSOLIDA');
  assert(
    rels.length === 3,
    'registra 3 relaciones CONSOLIDA (hecho → episodios)',
    `rels=${rels.length}`
  );

  const tag = (id) => {
    try {
      return JSON.parse(sqlGet(graph, 'SELECT tags FROM nodes WHERE id=?', id).tags);
    } catch {
      return [];
    }
  };
  assert(tag(e1).includes('consolidated'), 'episodio fuente 1 marcado consolidated');
  assert(tag(e3).includes('consolidated'), 'episodio fuente 3 marcado consolidated');
  assert(!tag(e4).includes('consolidated'), 'episodio de tema único NO se marca');
  assert(!tag(e5).includes('consolidated'), 'episodio de tema único NO se marca');

  const rows = sqlAll(graph, 'SELECT COUNT(*) c FROM node_relations');
  assert(rows[0].c === 3, 'node_relations tiene 3 filas');

  const again = graph.runConsolidation({ minAgeDays: 7, minOccurrences: 2 });
  assert(
    again.episodes === 0 && again.facts.length === 0,
    'idempotente: 2ª pasada no re-consolida'
  );

  const still = graph.getNode(res.facts[0].id);
  assert(still.importance === fact.importance, 'la 2ª pasada no duplica el hecho (upsert)');

  graph.close();
  fs.rmSync(path.dirname(graph._dbPath), { recursive: true, force: true });
}

// ── Runner ─────────────────────────────────────────────────────────────────
async function main() {
  const started = Date.now();
  testSchema();
  testCRUD();
  testResolver();
  testDecay();
  await testSessions();
  testInstant();
  await testSemanticRecall();
  await testWeightedRecall();
  testCleanup();
  await testFallbackMemoryMode();
  await testRetrievalKeywordFallback();
  testConsolidation();

  console.log(
    C.bold(
      `\n  Resultado: ${C.green(`${passed} passed`)}  ${failed > 0 ? C.red(`${failed} failed`) : ''}  ${skipped > 0 ? C.yellow(`${skipped} skipped`) : ''}  / ${passed + failed + skipped} total`
    )
  );
  console.log(C.dim(`  (${((Date.now() - started) / 1000).toFixed(1)}s)\n`));
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(C.red('[test_state_graph] ERROR inesperado:'), e);
  process.exit(1);
});
