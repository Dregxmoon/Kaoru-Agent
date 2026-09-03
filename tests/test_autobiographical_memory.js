// @ts-check
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { StateGraph } = require('../core/state-graph/StateGraph.js');
const { StateUpdater } = require('../core/state-graph/StateUpdater.js');
const {
  AutobiographicalMemoryStore,
  resolveTemporalWindow,
} = require('../core/state-graph/stores/AutobiographicalMemoryStore.js');
const { RetrievalPlanner } = require('../core/grounding/RetrievalPlanner.js');
const { GroqSerializer } = require('../core/grounding/serializers/GroqSerializer.js');

let passed = 0;
let failed = 0;

/** @param {unknown} condition @param {string} label @param {string} [detail] */
function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
    passed++;
  } else {
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

/** @param {any} graph @param {string} content @param {number} at @param {number} [importance] */
function episode(graph, content, at, importance = 0.7) {
  const id = graph.createNode({
    type: 'Episode',
    label: `episode_${at}_${Math.random()}`,
    content,
    importance,
    tags: ['sesion'],
  });
  graph._db.prepare('UPDATE nodes SET created_at=?, updated_at=? WHERE id=?').run(at, at, id);
  return Number(id);
}

function testTemporalResolver() {
  console.log('\nMemoria autobiográfica — lenguaje temporal');
  const now = new Date(2026, 8, 3, 12, 0, 0).getTime();
  const today = new Date(2026, 8, 3, 0, 0, 0).getTime();
  assert(
    resolveTemporalWindow('¿qué hicimos ayer?', now)?.from === today - 86400e3,
    'resuelve ayer'
  );
  assert(resolveTemporalWindow('durante esta semana', now)?.to === now + 1, 'resuelve esta semana');
  const lastMonth = resolveTemporalWindow('recuérdame el mes pasado', now);
  assert(
    lastMonth?.from === new Date(2026, 7, 1).getTime() &&
      lastMonth.to === new Date(2026, 8, 1).getTime(),
    'resuelve mes pasado como intervalo calendario'
  );
  assert(
    resolveTemporalWindow('el 2026-08-14', now)?.from === new Date(2026, 7, 14).getTime(),
    'resuelve una fecha ISO válida'
  );
  assert(resolveTemporalWindow('el 2026-13-44', now) === null, 'rechaza fechas imposibles');
}

async function testTimelineAndRetrieval() {
  console.log('\nMemoria autobiográfica — continuidad y recall contextual');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoru-autobiographical-'));
  const dbPath = path.join(dir, 'memory.db');
  let graph = new StateGraph(dbPath).init();
  const now = new Date(2026, 8, 3, 12, 0, 0).getTime();
  try {
    const sessionId = graph.startSession();
    const yesterday = now - 30 * 60 * 60 * 1000;
    const oldProject = now - 60 * 86400e3;
    const recentOther = now - 2 * 86400e3;
    const updater = new StateUpdater(graph);
    const yesterdayId = Number(
      updater._createEpisodeNode(
        { episode_summary: 'Arreglamos el despliegue de Kaoru', episode_importance: 0.8 },
        {
          sessionId,
          occurredAt: yesterday,
          evidenceCount: 4,
        }
      )
    );
    const oldId = episode(graph, 'Diseñamos el motor de recuerdos lunares', oldProject, 0.9);
    const recentId = episode(graph, 'Conversamos sobre recetas de pasta', recentOther, 0.5);
    graph.registerAutobiographicalEpisode(oldId, { occurredAt: oldProject, salience: 0.9 });
    graph.registerAutobiographicalEpisode(recentId, { occurredAt: recentOther, salience: 0.5 });

    const temporal = graph.recallAutobiographical({ query: '¿qué hicimos ayer?', now, limit: 5 });
    assert(temporal.length === 1 && temporal[0].id === yesterdayId, 'ayer filtra el día correcto');
    assert(yesterdayId > 0, 'StateUpdater indexa cada episodio al crearlo');
    assert(
      temporal[0].memory_context.evidenceCount === 4,
      'expone procedencia sin copiar evidencia'
    );

    const thematic = graph.recallAutobiographical({ query: 'recuerdos lunares', now, limit: 3 });
    assert(thematic[0]?.id === oldId, 'un tema antiguo vence a un episodio reciente irrelevante');
    assert(
      !thematic.some((row) => row.id === recentId),
      'excluye recuerdos sin coincidencia temática'
    );

    graph.updateNode(oldId, { content: 'Diseñamos la cronología de recuerdos lunares' });
    assert(
      graph.recallAutobiographical({ query: 'cronología lunares', now })[0]?.id === oldId,
      'el índice referencia el episodio canónico sin duplicar su contenido'
    );

    graph.endSession(sessionId, { summary: 'fin', turnCount: 2, episodeId: yesterdayId });
    assert(
      graph.recallAutobiographical({ query: 'ayer', now })[0].memory_context.endedAt != null,
      'cerrar sesión completa el intervalo autobiográfico'
    );

    const planner = new RetrievalPlanner(graph);
    const planned = await planner.plan('¿recuerdas el despliegue de ayer?', null);
    assert(planned.episodeNodes[0]?.id === yesterdayId, 'RetrievalPlanner usa el recall temporal');
    assert(
      !planned.nodes.some((node) => node.type === 'Episode'),
      'un episodio nunca se mezcla con hechos estables'
    );
    const emptyToday = await planner.plan('¿recuerdas recuerdos lunares hoy?', null);
    assert(
      emptyToday.episodeNodes.length === 0,
      'una fecha explícita sin recuerdos no filtra episodios de otro día'
    );

    const serialized = new GroqSerializer().serialize(
      { identity: null, persistentMemory: { nodes: [], episodes: temporal } },
      { includeMemory: true }
    ).systemPrompt;
    assert(
      serialized.includes('resúmenes, no hechos independientes'),
      'el prompt declara el estatus epistémico'
    );
    assert(serialized.includes('con evidencia'), 'el prompt conserva señal de procedencia');

    const legacyId = episode(graph, 'Episodio legado sobre acuarelas', now - 90 * 86400e3);
    graph.close();
    graph = new StateGraph(dbPath).init();
    assert(
      graph.recallAutobiographical({ query: 'acuarelas', now })[0]?.id === legacyId,
      'el arranque indexa episodios de versiones anteriores'
    );
  } finally {
    graph.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testFallback() {
  console.log('\nMemoria autobiográfica — degradación segura');
  const nodes = [
    { id: 1, type: 'Episode', content: 'Viaje a Kioto', importance: 0.8, created_at: 1000 },
  ];
  const graph = { usingFallback: true, _nodes: { getRecentEpisodes: () => nodes } };
  const store = new AutobiographicalMemoryStore(null, graph);
  store.registerEpisode(1, { occurredAt: 1000, evidenceCount: 1 });
  const result = store.recall({ query: 'Kioto', now: 2000 });
  assert(result.length === 1, 'el fallback conserva recall temático');
  assert(result[0].memory_context.source === 'session_summary', 'el fallback conserva metadatos');
}

async function main() {
  testTemporalResolver();
  await testTimelineAndRetrieval();
  testFallback();
  console.log(`\nResultado: ${passed} passed  ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
