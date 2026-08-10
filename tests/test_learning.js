'use strict';

// test_learning.js — Fase 3, ítem 2: aprendizaje que cierra el círculo.
// Feedback de proactividad → pesos recalibrados (gate) y evaluación de tareas
// → sección "# LO APRENDIDO" en el prompt. Verifica deriveWeights,
// LearningEngine (persistencia + prompt), la integración con ProposalStore y
// que el gate aplique los pesos aprendidos.

const fs = require('fs');
const os = require('os');
const path = require('path');

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

const DecisionCore = require('../core/decision/DecisionCore.js');
const { estimateDifficulty } = require('../core/learning/difficulty.js');
const { LearningEngine, MAX_TASK_OUTCOMES } = require('../core/learning/LearningEngine.js');
const { ProposalStore } = require('../core/behavior/ProposalStore.js');
const { ProactiveEngine } = require('../core/behavior/ProactiveEngine.js');
const Core = require('../core/Core.js');
const state = require('../core/core/state.js');

function tmpPath(prefix) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')), 'feedback.json');
}

// ── Test 1: deriveWeights ───────────────────────────────────────────────────
function testDeriveWeights() {
  console.log(C.bold('\nTest 1: deriveWeights — pesos recalibrados del feedback'));

  // Sin muestras suficientes → identidad (no cambia el comportamiento actual).
  const ident = DecisionCore.deriveWeights({ byType: {} }, {});
  const { weights: defaultWeights } = DecisionCore.DEFAULT_POLICY;
  const sum = ident.severity + ident.actionability + ident.salience + ident.costOfIgnore;
  assert(Math.abs(sum - 1) < 1e-9, 'los pesos devueltos suman 1', `sum=${sum}`);
  assert(
    Math.abs(ident.actionability - defaultWeights.actionability) < 1e-9,
    'sin muestras → identidad (actionability sin cambio)',
    JSON.stringify(ident)
  );

  // Feedback mayoritariamente ACEPTADO → sube el peso de los componentes
  // pro-activos (actionability/salience).
  const accepted = {
    byType: {
      reminder: { accepted: 9, rejected: 1, ignored: 0, rejectsInRow: 0 },
      alert: { accepted: 8, rejected: 2, ignored: 0, rejectsInRow: 0 },
    },
  };
  const wHigh = DecisionCore.deriveWeights(accepted, {});
  assert(
    wHigh.actionability > defaultWeights.actionability,
    'alta aceptación → más actionability',
    `${wHigh.actionability} vs ${defaultWeights.actionability}`
  );
  assert(
    wHigh.salience > defaultWeights.salience,
    'alta aceptación → más salience',
    `${wHigh.salience} vs ${defaultWeights.salience}`
  );

  // Feedback mayoritariamente RECHAZADO → baja los componentes pro-activos.
  const rejected = {
    byType: {
      reminder: { accepted: 1, rejected: 9, ignored: 0, rejectsInRow: 4 },
      alert: { accepted: 2, rejected: 8, ignored: 0, rejectsInRow: 3 },
    },
  };
  const wLow = DecisionCore.deriveWeights(rejected, {});
  assert(
    wLow.actionability < defaultWeights.actionability,
    'baja aceptación → menos actionability',
    `${wLow.actionability} vs ${defaultWeights.actionability}`
  );
  assert(
    wLow.salience < defaultWeights.salience,
    'baja aceptación → menos salience',
    `${wLow.salience} vs ${defaultWeights.salience}`
  );

  // Determinismo: misma entrada → misma salida.
  assert(
    JSON.stringify(DecisionCore.deriveWeights(accepted, {})) === JSON.stringify(wHigh),
    'determinista para la misma entrada'
  );

  // Entradas malformadas no rompen.
  const junk = DecisionCore.deriveWeights({ byType: { x: null } }, {});
  assert(
    typeof junk.actionability === 'number' && isFinite(junk.actionability),
    'entradas basura no rompen'
  );
}

// ── Test 2: difficulty.js ───────────────────────────────────────────────────
function testDifficulty() {
  console.log(C.bold('\nTest 2: estimateDifficulty — heurístico acotado'));

  assert(estimateDifficulty({ message: 'hola' }) >= 0, 'mensaje corto → en rango');
  assert(estimateDifficulty({ message: 'hola' }) <= 1, 'acotado a 1');
  const hard = estimateDifficulty({
    message:
      'Refactoriza el módulo de auth en core/, escribe tests para el flujo de login con node:test y ejecuta npm test al final. ' +
      'Asegúrate de cubrir los casos de error y de mantener la compatibilidad con el resto del sistema.',
    taskIntent: { domain: 'code' },
    messageCount: 12,
  });
  const easy = estimateDifficulty({ message: 'hola', taskIntent: null });
  assert(hard > easy, 'tarea larga con código > saludo corto', `${hard} vs ${easy}`);
  assert(hard >= 0.5, 'tarea compleja alta dificultad', `hard=${hard}`);
}

// ── Test 3: LearningEngine — persistencia y outcomes ────────────────────────
function testLearningEngine() {
  console.log(C.bold('\nTest 3: LearningEngine — outcomes de tareas persistentes'));

  const store = new ProposalStore({ filePath: tmpPath('le-proposal') });
  const file = tmpPath('le');
  const eng = new LearningEngine({ filePath: file, proposalStore: store });

  // Sin muestras: nada significativo en el prompt.
  assert(eng.buildPromptSection() === null, 'sin feedback → no hay sección de prompt');
  assert(eng.successRate({ mode: 'smart' }) === null, 'sin muestras → tasa null');

  eng.recordTaskOutcome({
    mode: 'smart',
    success: true,
    iterations: 3,
    elapsedMs: 500,
    difficulty: 0.6,
    goal: 'Refactorizar auth',
  });
  eng.recordTaskOutcome({
    mode: 'smart',
    success: true,
    iterations: 5,
    elapsedMs: 800,
    difficulty: 0.8,
    goal: 'Migrar a TS',
  });
  eng.recordTaskOutcome({
    mode: 'smart',
    success: false,
    error: 'timeout',
    iterations: 25,
    elapsedMs: 1200,
    difficulty: 0.9,
    goal: 'Depurar el deadlock',
  });
  eng.recordTaskOutcome({
    mode: 'fast',
    success: true,
    iterations: 2,
    elapsedMs: 200,
    difficulty: 0.2,
    goal: 'Saludo',
  });

  assert(
    eng.successRate({ mode: 'smart', minSamples: 3 }) === 2 / 3,
    'tasa smart = 2/3',
    String(eng.successRate({ mode: 'smart' }))
  );
  assert(
    eng.successRate({ mode: 'fast', minSamples: 5 }) === null,
    'fast: menos de minSamples → null'
  );
  assert(eng.getTaskOutcomes({ mode: 'smart' }).length === 3, 'filtra por modo');

  // Persistencia real: nueva instancia sobre el mismo archivo.
  const eng2 = new LearningEngine({ filePath: file, proposalStore: store });
  assert(eng2.getTaskOutcomes({ limit: 10 }).length === 4, 'los outcomes sobreviven a la recarga');
  assert(eng2.successRate({ mode: 'smart', minSamples: 3 }) === 2 / 3, 'la tasa persiste');

  // Completar smart hasta 5 muestras (minSamples por defecto de successRate en
  // buildPromptSection) para que la sección del prompt mencione las tareas.
  eng.recordTaskOutcome({
    mode: 'smart',
    success: true,
    iterations: 4,
    elapsedMs: 600,
    difficulty: 0.5,
    goal: 'Añadir tests',
  });
  eng.recordTaskOutcome({
    mode: 'smart',
    success: true,
    iterations: 6,
    elapsedMs: 900,
    difficulty: 0.7,
    goal: 'Documentar API',
  });

  // Con outcomes + preferencias → sección de prompt.
  store.record({ proposalId: 'p1', type: 'reminder', decision: 'rejected' });
  store.record({ proposalId: 'p2', type: 'reminder', decision: 'rejected' });
  store.record({ proposalId: 'p3', type: 'reminder', decision: 'rejected' });
  store.record({ proposalId: 'p4', type: 'alert', decision: 'accepted' });
  const section = eng.buildPromptSection();
  assert(
    section !== null && section.includes('# LO APRENDIDO (FEEDBACK)'),
    'sección con encabezado',
    section || 'null'
  );
  assert(section.includes('reminder'), 'menciona el tipo rechazado', section || 'null');
  assert(section.includes('smart'), 'incluye tasa de éxito de tareas smart', section || 'null');

  // Tope circular (después del chequeo de prompt: los smart outcomes se
  // expulsarían al llenar el buffer con fast).
  for (let i = 0; i < MAX_TASK_OUTCOMES + 50; i++) {
    eng.recordTaskOutcome({ mode: 'fast', success: true });
  }
  assert(
    eng.getTaskOutcomes({ limit: MAX_TASK_OUTCOMES + 10 }).length === MAX_TASK_OUTCOMES,
    'tope FIFO de outcomes'
  );

  // buildPromptSection no pisa datos (solo lee).
  const data = eng.getData();
  assert(data.taskOutcomes.length > 0 && data.filePath === file, 'getData expone el estado');

  eng.reset();
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
}

// ── Test 4: calibrate → ProposalStore → gate ────────────────────────────────
function testCalibrateAndGate() {
  console.log(C.bold('\nTest 4: calibrate alimenta el gate vía ProposalStore'));

  function fakeGraph() {
    return { _ready: true, queryNodes: () => [], getWorldModel: () => [], queryAll: () => [] };
  }

  const { candidateFromTrigger } = require('../core/decision/SignalNormalizer.js');

  // La misma señal (env sin ignorar = crítica). El gate debe puntuarla con los
  // pesos aprendidos: score del gate == scoreRelevancia(signal, {weights}).
  const trigger = {
    type: 'git_redflag',
    kind: 'env_unignored',
    file: '.env',
    context: 'El archivo .env existe y no está en .gitignore.',
  };
  const candidate = candidateFromTrigger(trigger);

  function gateScore(engine, t) {
    const g = engine._evaluateTrigger(t);
    return g ? g.score : null;
  }

  // Sin store (sin aprendizaje) → scoring por defecto.
  const engineDefault = new ProactiveEngine(fakeGraph());
  const sDefault = gateScore(engineDefault, trigger);
  assert(sDefault !== null, 'el gate evalúa la señal', `default=${sDefault}`);
  assert(
    Math.abs(sDefault - DecisionCore.scoreRelevancia(candidate.signal, {})) < 1e-9,
    '…con los pesos por defecto',
    `${sDefault} vs ${DecisionCore.scoreRelevancia(candidate.signal, {})}`
  );

  // Con store vacío → igual que default (identidad).
  const storeEmpty = new ProposalStore({ filePath: tmpPath('gate-empty') });
  const engineNoLearn = new ProactiveEngine(fakeGraph(), { store: storeEmpty });
  const sNoLearn = gateScore(engineNoLearn, trigger);
  assert(
    sNoLearn === sDefault,
    'sin muestras → score idéntico al default',
    `${sNoLearn} vs ${sDefault}`
  );

  // Con feedback mayoritariamente rechazado → pesos aprendidos conservadores.
  const store = new ProposalStore({ filePath: tmpPath('gate-proposal') });
  for (let i = 0; i < 8; i++) {
    store.record({ proposalId: `r${i}`, type: 'reminder', decision: 'rejected' });
  }
  store.record({ proposalId: 'a1', type: 'alert', decision: 'accepted' });
  store.record({ proposalId: 'a2', type: 'alert', decision: 'accepted' });

  const eng = new LearningEngine({ filePath: tmpPath('gate-le'), proposalStore: store });
  const weights = eng.calibrate();
  assert(weights && typeof weights.actionability === 'number', 'calibrate devuelve pesos');
  assert(store.getLearnedWeights() !== null, 'los pesos se mueven al ProposalStore');

  const engineLearned = new ProactiveEngine(fakeGraph(), { store });
  const sLearned = gateScore(engineLearned, trigger);
  const sExpected = DecisionCore.scoreRelevancia(candidate.signal, { weights });
  assert(sLearned !== null, 'el gate evalúa con pesos aprendidos', `learned=${sLearned}`);
  assert(
    Math.abs(sLearned - sExpected) < 1e-9,
    'el gate puntúa con los pesos aprendidos (== scoreRelevancia con override)',
    `gate=${sLearned?.toFixed(4)} esperado=${sExpected?.toFixed(4)}`
  );
  assert(
    sLearned !== sDefault,
    'los pesos aprendidos CAMBIAN la puntuación',
    `default=${sDefault?.toFixed(4)} learned=${sLearned?.toFixed(4)}`
  );

  eng.reset();
  for (const p of [store._filePath, storeEmpty._filePath]) {
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
  }
}

// ── Test 5: Core facade ─────────────────────────────────────────────────────
function testCoreFacade() {
  console.log(C.bold('\nTest 5: Core — fachada de aprendizaje'));

  const file = tmpPath('facade-le');
  const store = new ProposalStore({ filePath: tmpPath('facade-proposal') });
  const eng = new LearningEngine({ filePath: file, proposalStore: store });
  const prev = state.learning;
  state.learning = eng;
  try {
    Core.recordTaskOutcome({ mode: 'smart', success: true, goal: 'Meta de fachada' });
    Core.recordTaskOutcome({ mode: 'smart', success: false, error: 'boom' });
    const list = Core.getTaskOutcomes({ mode: 'smart' });
    assert(list.length === 2, 'recordTaskOutcome + getTaskOutcomes vía Core');
    const weights = Core.getLearnedWeights();
    assert(weights === null, 'sin calibrar → getLearnedWeights null');
    const data = Core.getLearningData();
    assert(data.available === true && data.taskOutcomes.length === 2, 'getLearningData vía Core');
    assert(Core.resetLearning().ok === true, 'resetLearning vía Core');
    assert(Core.getLearningData().taskOutcomes.length === 0, 'reset limpió los outcomes');
  } finally {
    state.learning = prev;
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

// ── Runner ─────────────────────────────────────────────────────────────────
async function main() {
  testDeriveWeights();
  testDifficulty();
  testLearningEngine();
  testCalibrateAndGate();
  testCoreFacade();

  const total = passed + failed;
  console.log(C.bold('\n═══════════════════════════════════════════'));
  console.log(
    C.bold(
      `  Resultado: ${C.green(`${passed} passed`)}  ${failed > 0 ? C.red(`${failed} failed`) : C.dim('0 failed')}  / ${total} total`
    )
  );
  console.log(C.bold('═══════════════════════════════════════════\n'));
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(C.red('[test_learning] ERROR inesperado:'), e);
  process.exit(1);
});
