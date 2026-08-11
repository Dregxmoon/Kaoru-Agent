'use strict';

/**
 * F3.1 — vigencia de hechos fijos (FactReasonerStore) + cascada de invalidación.
 *
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron tests/test_fact_reasoner.js
 *
 * Cubre:
 *   - staleness se detecta pasando el umbral (tag 'stale'),
 *   - NO se detecta antes del umbral,
 *   - labels fuera de STALENESS_DAYS nunca se marcan,
 *   - cascada: un overwrite de trabajo_usuario invalida proyecto_principal
 *     (verified_at = null),
 *   - verified_at se resetea correctamente tras el overwrite en cascada,
 *   - también se refresca verified_at del propio label overwriteado.
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
    console.log(`  ${C.red('✗')} ${label}${detail ? `\n    ${C.dim(detail)}` : ''}`);
    failed++;
  }
}

const { StateGraph } = require('../core/state-graph/StateGraph.js');
const { CASCADE_STALENESS, STALE_TAG } = require('../core/state-graph/stores/FactReasonerStore.js');
const { ContradictionResolver } = require('../core/state-graph/ContradictionResolver.js');

const DAY = 24 * 60 * 60 * 1000;

function makeGraph() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'far-test-'));
  const dbPath = path.join(dir, 'core.db');
  const graph = new StateGraph(dbPath).init();
  return { graph, dir };
}

function sqlGet(graph, sql, ...args) {
  return graph._db.prepare(sql).get(...args);
}

function tags(graph, id) {
  try {
    return JSON.parse(sqlGet(graph, 'SELECT tags FROM nodes WHERE id=?', id).tags);
  } catch {
    return [];
  }
}

function mkNode(graph, label, content, confirmedDaysAgo) {
  const id = graph.createNode({ type: 'User', label, content, importance: 0.8 });
  graph._db
    .prepare('UPDATE nodes SET verified_at=? WHERE id=?')
    .run(Date.now() - confirmedDaysAgo * DAY, id);
  return id;
}

// ── Test 1: staleness se detecta pasando el umbral ─────────────────────────
function testStaleDetected() {
  console.log(C.bold('\nTest 1: staleness se detecta pasado el umbral'));
  const { graph, dir } = makeGraph();

  // trabajo_usuario: umbral 150 días → verificado hace 200 días → stale
  const id = mkNode(graph, 'trabajo_usuario', 'Trabaja en una notaría', 200);
  const res = graph.runFactReasoner();
  assert(res.checked === 1, 'revisa 1 nodo candidato', JSON.stringify(res));
  assert(res.stale === 1, 'marca 1 nodo como stale', JSON.stringify(res));
  assert(tags(graph, id).includes(STALE_TAG), `nodo recibe tag '${STALE_TAG}'`);

  // Idempotencia: una 2ª pasada no cuenta de nuevo el mismo nodo.
  const again = graph.runFactReasoner();
  assert(again.stale === 0, 'idempotente: nodo ya marcado no se re-cuenta');

  graph.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Test 2: NO se detecta antes del umbral ────────────────────────────────
function testNotStaleBeforeThreshold() {
  console.log(C.bold('\nTest 2: NO se detecta antes del umbral'));
  const { graph, dir } = makeGraph();

  // trabajo_usuario verificado hace 10 días → muy por debajo de 150 → no stale
  const id = mkNode(graph, 'trabajo_usuario', 'Trabaja en una notaría', 10);
  const res = graph.runFactReasoner();
  assert(res.checked === 1, 'revisa el candidato');
  assert(res.stale === 0, 'no marca stale', JSON.stringify(res));
  assert(!tags(graph, id).includes(STALE_TAG), 'nodo NO tiene tag stale');

  graph.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Test 3: labels fuera de STALENESS_DAYS nunca se marcan ────────────────
function testLabelsOutsideMap() {
  console.log(C.bold('\nTest 3: labels fuera de STALENESS_DAYS nunca se marcan'));
  const { graph, dir } = makeGraph();

  // nombre_usuario y cumpleanos_usuario son permanentes: no están en el mapa.
  const permanentes = [
    mkNode(graph, 'nombre_usuario', 'El usuario se llama Luka', 800),
    mkNode(graph, 'cumpleanos_usuario', 'Cumpleaños: 15 de junio', 800),
    mkNode(graph, 'color_favorito', 'Colores favoritos: azul', 800),
  ];
  // Un label con umbral pero reciente tampoco.
  const fresh = mkNode(graph, 'ubicacion_usuario', 'Vive en CDMX', 1);

  const res = graph.runFactReasoner();
  assert(res.checked === 1, 'solo revisa labels del mapa (1 de 4)', JSON.stringify(res));
  assert(res.stale === 0, 'ninguno fuera del mapa se marca', JSON.stringify(res));
  for (const id of permanentes) {
    assert(!tags(graph, id).includes(STALE_TAG), `label permanente sin tag stale (id=${id})`);
  }
  assert(!tags(graph, fresh).includes(STALE_TAG), 'label fresco sin tag stale');

  graph.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Test 4: cascada marca el label relacionado ─────────────────────────────
function testCascade() {
  console.log(C.bold('\nTest 4: cascada — overwrite de trabajo invalida proyecto_principal'));
  const { graph, dir } = makeGraph();
  const resolver = new ContradictionResolver(graph);

  assert(
    Array.isArray(CASCADE_STALENESS.trabajo_usuario) &&
      CASCADE_STALENESS.trabajo_usuario.includes('proyecto_principal'),
    'CASCADE_STALENESS: trabajo_usuario → proyecto_principal'
  );

  const trabajo = mkNode(graph, 'trabajo_usuario', 'Trabaja en una notaría', 30);
  const proyecto = mkNode(graph, 'proyecto_principal', 'Proyecto: app de escritorio', 30);
  const antes = sqlGet(graph, 'SELECT verified_at FROM nodes WHERE id=?', proyecto).verified_at;
  assert(typeof antes === 'number', 'proyecto_principal tiene verified_at inicial');

  // El usuario corrige su trabajo → overwrite en el resolver.
  resolver.resolve({
    type: 'User',
    label: 'trabajo_usuario',
    content: 'Ahora trabaja en un estudio de diseño',
    importance: 0.9,
  });

  const proyAfter = sqlGet(graph, 'SELECT verified_at FROM nodes WHERE id=?', proyecto);
  assert(
    proyAfter.verified_at === null,
    'proyecto_principal queda verified_at=NULL',
    `got=${proyAfter.verified_at}`
  );
  assert(
    sqlGet(graph, 'SELECT content FROM nodes WHERE id=?', trabajo).content.includes('diseño'),
    'el overwrite de trabajo_usuario se aplicó'
  );

  graph.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Test 5: verified_at se resetea correctamente tras overwrite ─────────────
function testVerifiedAtResetOnOverwrite() {
  console.log(C.bold('\nTest 5: overwrite refresca verified_at del propio label'));
  const { graph, dir } = makeGraph();
  const resolver = new ContradictionResolver(graph);

  const old = Date.now() - 200 * DAY;
  const id = graph.createNode({
    type: 'User',
    label: 'trabajo_usuario',
    content: 'Trabaja en una notaría',
    importance: 0.8,
  });
  graph._db.prepare('UPDATE nodes SET verified_at=? WHERE id=?').run(old, id);

  resolver.resolve({
    type: 'User',
    label: 'trabajo_usuario',
    content: 'Trabaja en una fintech',
    importance: 0.9,
  });

  const after = sqlGet(graph, 'SELECT verified_at FROM nodes WHERE id=?', id).verified_at;
  assert(
    typeof after === 'number' && after > old,
    'overwrite refresca verified_at',
    `old=${old} now=${after}`
  );

  // Y tras el refresh ya no queda stale aunque no pase el tiempo del umbral.
  graph.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Test 6: un label invalidado por cascada se vuelve stale tras el umbral ─
function testCascadeThenStale() {
  console.log(C.bold('\nTest 6: nodo sin vigencia cae a created_at y puede quedar stale'));
  const { graph, dir } = makeGraph();

  // proyecto_principal creado hace 200 días y su vigencia se invalidó por
  // cascada → verified_at NULL → cae a created_at → 200 días > 90 → stale.
  const proyecto = graph.createNode({
    type: 'Project',
    label: 'proyecto_principal',
    content: 'Proyecto: app de escritorio',
    importance: 0.8,
  });
  graph._db
    .prepare('UPDATE nodes SET verified_at=NULL, created_at=? WHERE id=?')
    .run(Date.now() - 200 * DAY, proyecto);
  graph.createNode({
    type: 'User',
    label: 'trabajo_usuario',
    content: 'Trabaja en una notaría',
    importance: 0.8,
  });

  const res = graph.runFactReasoner();
  assert(res.checked === 2, 'revisa ambos candidatos');
  assert(res.stale === 1, 'proyecto_principal sin vigencia queda stale', JSON.stringify(res));
  assert(tags(graph, proyecto).includes(STALE_TAG), 'el tag stale se aplica al proyecto');

  graph.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Run ─────────────────────────────────────────────────────────────────────

testStaleDetected();
testNotStaleBeforeThreshold();
testLabelsOutsideMap();
testCascade();
testVerifiedAtResetOnOverwrite();
testCascadeThenStale();

console.log(`\n${C.bold(`Resultado: ${C.green(`${passed} ✓`)} / ${C.red(`${failed} ✗`)}`)}`);
process.exit(failed ? 1 : 0);
