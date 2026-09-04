// @ts-check
'use strict';

const {
  assessTriggerAlignment,
  buildFocusContext,
  memoryAllowedForFocus,
} = require('../core/behavior/proactive/ContextAlignment.js');
const { ProactiveEngine } = require('../core/behavior/ProactiveEngine.js');

let passed = 0;
let failed = 0;

/** @param {unknown} condition @param {string} label */
function assert(condition, label) {
  if (condition) {
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
    passed++;
  } else {
    console.log(`  \x1b[31m✗\x1b[0m ${label}`);
    failed++;
  }
}

function testFocusClassification() {
  console.log('\nAlineación contextual — clasificación del foco');
  const search = buildFocusContext({
    osContext: { category: 'browser', app: 'firefox', title: 'auriculares - Google Search' },
    workspace: '/projects/kaoru-agent',
  });
  assert(search.mode === 'search', 'reconoce una búsqueda aunque exista un workspace activo');
  assert(!search.terms.includes('kaoru'), 'una búsqueda no hereda términos del workspace');

  const media = buildFocusContext({
    osContext: { category: 'browser', app: 'firefox', title: 'Documental espacial - YouTube' },
  });
  assert(media.mode === 'media', 'reconoce vídeo/stream dentro del navegador');

  const work = buildFocusContext({
    osContext: { category: 'code', app: 'Code', title: 'message-gen.js — kaoru-agent' },
    workspace: '/projects/kaoru-agent',
  });
  assert(work.mode === 'work' && work.terms.includes('kaoru'), 'identifica el proyecto visible');
}

function testProjectIsolation() {
  console.log('\nAlineación contextual — aislamiento entre proyectos');
  const focus = buildFocusContext({
    osContext: { category: 'code', app: 'Code', title: 'ContextAlignment.js — kaoru-agent' },
    workspace: '/projects/kaoru-agent',
  });
  const kaoru = { type: 'Project', label: 'proyecto_principal', content: 'Proyecto: Kaoru Agent' };
  const finance = {
    type: 'Project',
    label: 'proyecto_finanzas',
    content: 'Proyecto: panel de finanzas Acme Ledger',
  };
  assert(memoryAllowedForFocus(kaoru, focus), 'permite memoria del proyecto que está en foco');
  assert(!memoryAllowedForFocus(finance, focus), 'oculta memoria de otro proyecto');

  const unrelated = assessTriggerAlignment(
    { type: 'intention_stale', goal: 'terminar el panel Acme Ledger' },
    focus
  );
  const related = assessTriggerAlignment(
    { type: 'intention_stale', goal: 'mejorar la memoria de Kaoru Agent' },
    focus
  );
  assert(!unrelated.allow && unrelated.reason === 'different_context', 'bloquea otra meta activa');
  assert(related.allow && related.affinity > 0, 'permite apoyar el proyecto actual');

  const scopedGenericGoal = assessTriggerAlignment(
    {
      type: 'intention_stale',
      goal: 'mejorar el sistema de memoria',
      workspace: '/projects/kaoru-agent',
    },
    focus
  );
  const scopedOtherProject = assessTriggerAlignment(
    {
      type: 'intention_stale',
      goal: 'mejorar el sistema de memoria',
      workspace: '/projects/otro-asistente',
    },
    focus
  );
  assert(scopedGenericGoal.allow, 'el workspace vincula una meta aunque su texto sea genérico');
  assert(!scopedOtherProject.allow, 'el workspace bloquea una meta idéntica de otro proyecto');

  const otherVisibleProject = buildFocusContext({
    osContext: { category: 'code', app: 'Code', title: 'dashboard.js — Acme Ledger' },
    workspace: '/projects/kaoru-agent',
  });
  assert(
    !assessTriggerAlignment(
      {
        type: 'intention_stale',
        goal: 'mejorar el sistema de memoria',
        workspace: '/projects/kaoru-agent',
      },
      otherVisibleProject
    ).allow,
    'el título de otro proyecto prevalece sobre un workspace configurado pero no visible'
  );

  const personal = assessTriggerAlignment(
    { type: 'knowledge_gap', trait: 'qué música le gusta' },
    focus
  );
  assert(!personal.allow, 'una pregunta personal ajena espera mientras trabaja');
  const workRelatedGap = assessTriggerAlignment(
    {
      type: 'knowledge_gap',
      gapKey: 'lenguaje_programacion',
      trait: 'su lenguaje de programación favorito',
    },
    focus
  );
  assert(workRelatedGap.allow, 'una pregunta personal relacionada sí encaja con el trabajo');
  const neutralPersonal = assessTriggerAlignment(
    { type: 'knowledge_gap', trait: 'qué música le gusta' },
    buildFocusContext({})
  );
  assert(neutralPersonal.allow, 'la curiosidad personal reaparece en un momento neutral');
}

function testDistractingContexts() {
  console.log('\nAlineación contextual — búsqueda y contenido');
  for (const focus of [
    buildFocusContext({
      osContext: { category: 'browser', app: 'firefox', title: 'cafeteras - Google Search' },
      workspace: '/projects/kaoru-agent',
    }),
    buildFocusContext({
      osContext: { category: 'media', app: 'vlc', title: 'Película.mkv' },
      workspace: '/projects/kaoru-agent',
    }),
  ]) {
    const result = assessTriggerAlignment(
      { type: 'intention_stale', goal: 'continuar Kaoru Agent' },
      focus
    );
    assert(!result.allow, `no menciona proyectos durante foco ${focus.mode}`);
  }
}

/** @param {string} title @param {string} category */
function makeEngine(title, category) {
  const now = Date.now();
  const nodes = [
    {
      id: 1,
      type: 'Project',
      label: 'proyecto_kaoru',
      content: 'Proyecto Kaoru Agent: asistente de escritorio',
      importance: 0.8,
      updated_at: now,
      tags: '[]',
    },
    {
      id: 2,
      type: 'Project',
      label: 'proyecto_finanzas',
      content: 'Proyecto Acme Ledger: panel financiero',
      importance: 0.95,
      updated_at: now,
      tags: '[]',
    },
  ];
  const graph = {
    _ready: true,
    usingFallback: false,
    getWorldModel: () => nodes,
    queryNodes: () => [],
    queryNodesSemantic: async () => [],
    getRecentEpisodes: () => [
      { content: 'Seguimos trabajando en Acme Ledger y su panel financiero.' },
      { content: 'Mejoramos la memoria contextual de Kaoru Agent.' },
    ],
    getLastSessions: () => [
      { started_at: now, summary: 'Pendiente revisar Acme Ledger.' },
      { started_at: now, summary: 'Se trabajó en Kaoru Agent.' },
    ],
    getTopicTracker: () => null,
    getTensions: () => [],
    getUserModel: () => [],
    listStaleIntentions: () => [
      { id: 10, goal: 'terminar el panel Acme Ledger', last_progress: '' },
      { id: 11, goal: 'mejorar la memoria de Kaoru Agent', last_progress: '' },
    ],
  };
  const engine = new ProactiveEngine(graph, {
    getWorkspace: () => '/projects/kaoru-agent',
  });
  engine.setOSSensor({
    getCurrentContext: () => ({
      app: 'Code',
      friendlyName: 'VS Code',
      title,
      category,
      idleSecs: 0,
    }),
    getTodaySummary: () => '',
  });
  return engine;
}

async function testIntegratedFiltering() {
  console.log('\nAlineación contextual — integración con memoria y curiosidad');
  const engine = makeEngine('ContextAlignment.js — kaoru-agent', 'code');
  const memory = await engine._buildMemoryContext({
    type: 'focus_block_end',
    context: 'Kaoru Agent',
  });
  assert(memory.includes('Kaoru Agent'), 'el prompt conserva el proyecto alineado');
  assert(!memory.includes('Acme Ledger'), 'el prompt elimina proyecto, episodio y sesión ajenos');

  const candidates = engine
    ._collectCuriosityCandidates()
    .filter((item) => item.type === 'intention_stale');
  assert(candidates.length === 1, 'solo queda una intención de proyecto candidata');
  assert(candidates[0].goal.includes('Kaoru'), 'la intención candidata pertenece al foco actual');

  const searching = makeEngine('cafeteras - Google Search', 'browser');
  const searchCandidates = searching
    ._collectCuriosityCandidates()
    .filter((item) => item.type === 'intention_stale');
  assert(searchCandidates.length === 0, 'buscar algo ajeno elimina recordatorios de proyectos');
  assert(
    searching._lastContextAlignment.rejected === 2,
    'el diagnóstico registra los candidatos rechazados por contexto'
  );
}

async function main() {
  testFocusClassification();
  testProjectIsolation();
  testDistractingContexts();
  await testIntegratedFiltering();
  console.log(`\nResultado: ${passed} passed  ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
