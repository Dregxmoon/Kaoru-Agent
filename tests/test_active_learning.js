// @ts-check
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { StateGraph } = require('../core/state-graph/StateGraph.js');
const { ProactiveEngine } = require('../core/behavior/ProactiveEngine.js');
const { evaluate } = require('../core/decision/ContextGate.js');
const coreState = require('../core/core/state.js');

const DAY_MS = 24 * 60 * 60 * 1000;
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

function testPersistentQuestionLedger() {
  console.log('\nAprendizaje activo — ledger persistente y backoff');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoru-active-learning-'));
  const dbPath = path.join(dir, 'memory.db');
  let graph = new StateGraph(dbPath).init();
  const gap = { key: 'tono_conversacion', trait: 'el tono que prefiere', priority: 0.85 };
  try {
    const first = graph.listActiveLearningGaps([gap], 1_000);
    assert(first.length === 1 && first[0].askCount === 0, 'un hueco nuevo es elegible una vez');
    assert(
      graph.recordActiveLearningQuestion({
        key: gap.key,
        trait: gap.trait,
        proposalId: 'proposal-1',
        now: 1_000,
      }),
      'registra la pregunta emitida'
    );
    assert(
      graph.listActiveLearningGaps([gap], 1_001).length === 0,
      'el backoff evita repetirla inmediatamente'
    );

    graph.close();
    graph = new StateGraph(dbPath).init();
    assert(
      graph.listActiveLearningGaps([gap], 1_001).length === 0,
      'el anti-repetición sobrevive al reinicio'
    );
    graph.listActiveLearningGaps([], 2_000);
    const answered = graph._db
      .prepare('SELECT status FROM active_learning_questions WHERE gap_key=?')
      .get(gap.key);
    assert(answered.status === 'answered', 'cerrar el hueco lo marca como respondido');
    assert(
      graph.listActiveLearningGaps([gap], 2_001).length === 0,
      'si el hueco reaparece aplica una gracia y no interroga de inmediato'
    );
    assert(
      graph.listActiveLearningGaps([gap], 2_001 + 7 * DAY_MS).length === 1,
      'puede reabrirse después de la gracia si vuelve a faltar el dato'
    );
    assert(
      graph.exportMemorySnapshot().activeLearningQuestions.length === 1,
      'el usuario puede exportar también el historial de aprendizaje activo'
    );
  } finally {
    graph.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testCandidateAndNoAuthorization() {
  console.log('\nAprendizaje activo — oportunidad, pregunta y no autorización');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoru-active-candidate-'));
  const graph = new StateGraph(path.join(dir, 'memory.db')).init();
  const previousGraph = coreState.graph;
  coreState.graph = graph;
  const engine = new ProactiveEngine(graph);
  try {
    engine.setOSSensor({
      getCurrentContext: () => ({ idleSecs: 0, category: 'other', title: '' }),
      getTodaySummary: () => '',
    });
    engine._startedAt = Date.now();
    assert(
      !engine._collectCuriosityCandidates().some((candidate) => candidate.type === 'knowledge_gap'),
      'no convierte el primer arranque en una encuesta'
    );
    engine._startedAt = Date.now() - 4 * 60 * 60 * 1000;
    const candidates = engine._collectCuriosityCandidates();
    const gap = candidates.find((candidate) => candidate.type === 'knowledge_gap');
    assert(gap && gap.gapKey, 'convierte un hueco desconocido en candidato identificable');

    const context = engine._buildMemoryCuriosityContext(gap);
    assert(context.includes('todavía NO sabes'), 'el prompt declara el límite de conocimiento');
    assert(context.includes('no es autorización'), 'separa curiosidad de autorización operativa');

    const proposal = await engine._buildProposal(gap);
    assert(proposal.kind === 'question', 'la interfaz la distingue de una propuesta ejecutable');
    assert(proposal.action === null, 'la pregunta nunca contiene una acción ejecutable');
    assert(proposal.requiresConsent === null, 'no disfraza curiosidad como solicitud de permiso');
    const row = graph._db
      .prepare('SELECT ask_count, last_proposal_id FROM active_learning_questions WHERE gap_key=?')
      .get(gap.gapKey);
    assert(
      row.ask_count === 1 && row.last_proposal_id === proposal.id,
      'audita qué pregunta envió'
    );

    engine._connectCuriosityOutcome(proposal.id, 'knowledge_gap', 'rejected');
    const rejected = graph._db
      .prepare(
        'SELECT last_outcome, next_eligible_at FROM active_learning_questions WHERE gap_key=?'
      )
      .get(gap.gapKey);
    assert(rejected.last_outcome === 'rejected', 'un rechazo se registra sin inventar respuesta');
    assert(
      rejected.next_eligible_at > Date.now() + 20 * DAY_MS,
      'un rechazo amplía el descanso antes de volver a preguntar'
    );
    assert(graph.queryNodes({ limit: 20 }).length === 0, 'rechazar no crea ni modifica recuerdos');

    const chatUi = fs.readFileSync(path.join(__dirname, '../src/chat/ipc.js'), 'utf8');
    assert(
      chatUi.includes("isQuestion ? 'Responder' : 'Sí, hazlo'") &&
        chatUi.includes("isQuestion ? 'Ahora no' : 'No, gracias'"),
      'la UI usa lenguaje de conversación, no de ejecución'
    );
  } finally {
    engine.stop();
    coreState.graph = previousGraph;
    graph.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testInterruptionGuards() {
  console.log('\nAprendizaje activo — guardas de oportunidad');
  const candidate = {
    tipo: 'knowledge_gap',
    kind: 'trabajo',
    score: 0.8,
    isCritical: false,
    payload: {},
  };
  const base = {
    now: Date.now(),
    chatOpen: false,
    lastUserMsg: 0,
    idleSecs: 0,
    appElapsedSec: 60,
    recentSwitches: [],
    budgetUsed: 0,
    curiosityUsed: 0,
    receptivity: 0,
  };
  assert(
    evaluate(candidate, base).admit,
    'puede preguntar durante actividad ligera y sin chat reciente'
  );
  const deep = evaluate(candidate, { ...base, appElapsedSec: 20 * 60 });
  assert(
    !deep.admit && deep.queue && deep.decision.reason === 'user_in_deep_flow',
    'difiere la pregunta durante concentración profunda'
  );
  const absent = evaluate(candidate, { ...base, idleSecs: 120 });
  assert(
    !absent.admit && absent.queue && absent.decision.reason === 'user_not_present',
    'difiere la pregunta cuando el usuario no está presente'
  );
}

async function main() {
  testPersistentQuestionLedger();
  await testCandidateAndNoAuthorization();
  testInterruptionGuards();
  console.log(`\nResultado: ${passed} passed  ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
