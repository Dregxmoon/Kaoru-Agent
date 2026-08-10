'use strict';

// test_trust.js — Fase 3, ítem 4: modelo de confianza dinámico (costo×éxito).
// Verifica el scoring (suavizado, costo×éxito, rachas), la persistencia, la
// recomendación conservadora de modo y el routing dinámico en resolveAgentMode.

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

const {
  TrustModel,
  MODE_BUDGET,
  MIN_ATTEMPTS,
  RECOMMEND_THRESHOLD,
} = require('../core/trust/TrustModel.js');
const { resolveAgentMode } = require('../core/core/agent.js');
const Core = require('../core/Core.js');
const state = require('../core/core/state.js');

function tmpPath(prefix) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')), 'trust.json');
}

function goodOutcome(overrides) {
  return {
    mode: 'fast',
    provider: 'groq',
    model: 'llama-fast',
    success: true,
    elapsedMs: 800,
    iterations: 2,
    difficulty: 0.7,
    costUsd: 0.0005,
    ...overrides,
  };
}

// ── Test 1: scoring costo×éxito ─────────────────────────────────────────────
function testScoring() {
  console.log(C.bold('\nTest 1: trustScore — suavizado, costo y latencia'));

  const t = new TrustModel({ filePath: tmpPath('trust-score') });
  assert(t.trustScore('groq/llama-fast/fast') === null, 'clave inexistente → null');

  // 1 tarea exitosa barata → score alto pero con poca confianza.
  t.recordOutcome(goodOutcome());
  const sc1 = t.trustScore('groq/llama-fast/fast');
  assert(
    sc1 !== null && sc1.trust > 0.5,
    '1 éxito barato → confianza razonable',
    `trust=${sc1?.trust?.toFixed(3)}`
  );
  assert(sc1.confidence < 0.6, '1 muestra → confianza baja', `confidence=${sc1?.confidence}`);

  // Más éxitos → confianza sube.
  for (let i = 0; i < 4; i++) t.recordOutcome(goodOutcome());
  const sc5 = t.trustScore('groq/llama-fast/fast');
  assert(sc5.confidence >= 0.6, '5 muestras → confianza alta', `confidence=${sc5?.confidence}`);
  assert(sc5.trust > sc1.trust, 'más éxitos → más trust', `${sc5?.trust} vs ${sc1?.trust}`);

  // Coste alto penaliza (costo×éxito): mismo rendimiento pero carísimo.
  const t2 = new TrustModel({ filePath: tmpPath('trust-cost') });
  for (let i = 0; i < 5; i++) t2.recordOutcome(goodOutcome({ costUsd: 0.5 }));
  const scCost = t2.trustScore('groq/llama-fast/fast');
  assert(scCost.trust < sc5.trust, 'coste alto → menos trust', `${scCost?.trust} vs ${sc5?.trust}`);

  // Latencia alta penaliza.
  const t3 = new TrustModel({ filePath: tmpPath('trust-lat') });
  for (let i = 0; i < 5; i++) t3.recordOutcome(goodOutcome({ elapsedMs: 5 * 60 * 1000 }));
  const scLat = t3.trustScore('groq/llama-fast/fast');
  assert(
    scLat.trust < sc5.trust,
    'latencia alta → menos trust',
    `${scLat?.trust} vs ${sc5?.trust}`
  );

  // Rachas de fallos castigan y el primer éxito recupera.
  const t4 = new TrustModel({ filePath: tmpPath('trust-streak') });
  for (let i = 0; i < 5; i++) t4.recordOutcome(goodOutcome());
  const beforeStreak = t4.trustScore('groq/llama-fast/fast').trust;
  for (let i = 0; i < 3; i++) t4.recordOutcome(goodOutcome({ success: false, error: 'timeout' }));
  const afterFails = t4.trustScore('groq/llama-fast/fast');
  assert(
    afterFails.trust < beforeStreak,
    '3 fallos seguidos → baja el trust',
    `${afterFails.trust} vs ${beforeStreak}`
  );
  assert(
    afterFails.stats.consecFails === 3,
    'consecFails rastreado',
    String(afterFails.stats.consecFails)
  );
  t4.recordOutcome(goodOutcome());
  const recovered = t4.trustScore('groq/llama-fast/fast');
  assert(recovered.stats.consecFails === 0, 'el éxito resetea la racha');

  // Determinismo: misma historia → mismo score.
  const t5 = new TrustModel({ filePath: tmpPath('trust-det') });
  for (let i = 0; i < 5; i++) t5.recordOutcome(goodOutcome());
  assert(
    t5.trustScore('groq/llama-fast/fast').trust === sc5.trust,
    'determinista para la misma historia',
    `${t5.trustScore('groq/llama-fast/fast').trust} vs ${sc5.trust}`
  );
}

// ── Test 2: persistencia y granularidades ───────────────────────────────────
function testPersistence() {
  console.log(C.bold('\nTest 2: persistencia y 3 granularidades'));

  const file = tmpPath('trust-persist');
  const t = new TrustModel({ filePath: file });
  t.recordOutcome(
    goodOutcome({ mode: 'smart', provider: 'groq', model: 'llama-smart', costUsd: 0.01 })
  );
  t.recordOutcome(
    goodOutcome({
      mode: 'smart',
      provider: 'groq',
      model: 'llama-smart',
      success: false,
      error: 'boom',
    })
  );

  const t2 = new TrustModel({ filePath: file });
  const fine = t2.trustScore('groq/llama-smart/smart');
  const prov = t2.trustScore('groq/*/smart');
  const mode = t2.trustScore('*/*/smart');
  assert(fine !== null && fine.stats.attempts === 2, 'la clave fina persiste');
  assert(prov !== null && prov.stats.attempts === 2, 'la granularidad por proveedor persiste');
  assert(mode !== null && mode.stats.attempts === 2, 'la granularidad por modo persiste');
  assert(mode.stats.lastError === 'boom', 'lastError persistido', String(mode.stats.lastError));

  t2.reset();
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
}

// ── Test 3: recomendación conservadora de modo ──────────────────────────────
function testRecommend() {
  console.log(C.bold('\nTest 3: recommendMode — costo×éxito conservador'));

  const t = new TrustModel({ filePath: tmpPath('trust-reco') });
  assert(t.recommendMode({ isTask: true, difficulty: 0.8 }) === null, 'sin muestras → null');

  // fast es excelente (barato, rápido, acierta); smart es malo (falla seguido).
  for (let i = 0; i < 5; i++) {
    t.recordOutcome(
      goodOutcome({
        mode: 'fast',
        provider: 'groq',
        model: 'llama-fast',
        costUsd: 0.0005,
        elapsedMs: 800,
        difficulty: 0.7,
      })
    );
  }
  for (let i = 0; i < 5; i++) {
    t.recordOutcome(
      goodOutcome({
        mode: 'smart',
        provider: 'groq',
        model: 'llama-smart',
        success: false,
        error: 'timeout',
        costUsd: 0.02,
        elapsedMs: 120000,
        difficulty: 0.7,
      })
    );
  }

  const rec = t.recommendMode({ isTask: true, difficulty: 0.8 });
  assert(rec !== null, 'con muestras suficientes → recomendación', rec?.rationale || 'null');
  assert(rec.mode === 'fast', 'recomienda fast (mejor costo×éxito)', rec?.rationale);
  assert(rec.trust >= RECOMMEND_THRESHOLD, 'trust supera el umbral', String(rec?.trust));
  assert(
    rec.provider === 'groq' && rec.model === 'llama-fast',
    'recomienda el mejor proveedor/modelo'
  );

  // Modo explícito respetado: el peor modo se recomienda igual (solo ese modo).
  const explicit = t.recommendMode({ isTask: true, difficulty: 0.8, explicitMode: 'smart' });
  assert(
    explicit !== null && explicit.mode === 'smart',
    'explicitMode respetado',
    explicit?.rationale || 'null'
  );

  // Modos por defecto disponibles.
  assert(
    typeof MODE_BUDGET.fast.maxIterations === 'number' &&
      typeof MODE_BUDGET.smart.maxIterations === 'number',
    'MODE_BUDGET expuesto'
  );
  assert(MIN_ATTEMPTS >= 3, 'MIN_ATTEMPTS mínimo de muestras');
}

// ── Test 4: Core facade ─────────────────────────────────────────────────────
function testCoreFacade() {
  console.log(C.bold('\nTest 4: Core — fachada del modelo de confianza'));

  const file = tmpPath('trust-facade');
  const t = new TrustModel({ filePath: file });
  const prev = state.trust;
  state.trust = t;
  try {
    for (let i = 0; i < 3; i++) Core.recordTrustOutcome(goodOutcome());
    const stats = Core.getTrustStats();
    assert(
      stats.available === true && stats.summary && stats.summary['groq/llama-fast/fast'],
      'getTrustStats vía Core'
    );
    const sc = Core.trustScore('groq/llama-fast/fast');
    assert(sc !== null && typeof sc.trust === 'number', 'trustScore vía Core');
    assert(Core.recommendMode({ isTask: true }) !== null, 'recommendMode vía Core');
    const data = Core.getTrustData();
    assert(data.available === true && data.filePath === file, 'getTrustData vía Core');
    assert(Core.resetTrust().ok === true, 'resetTrust vía Core');
    assert(
      Core.getTrustStats().summary && Object.keys(Core.getTrustStats().summary).length === 0,
      'reset limpió las claves'
    );
  } finally {
    state.trust = prev;
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

// ── Test 5: routing dinámico en resolveAgentMode ────────────────────────────
function testRouting() {
  console.log(C.bold('\nTest 5: resolveAgentMode — routing por confianza'));

  const prevTrust = state.trust;
  const prevDetector = state.taskDetector;
  state.taskDetector = { detect: () => ({ isTask: true, confidence: 'high' }) };
  try {
    // Sin TrustModel → comportamiento actual (smart para tareas).
    state.trust = null;
    assert(resolveAgentMode('refactoriza algo').mode === 'smart', 'sin trust → tarea = smart');

    // fast mucho mejor que smart (costo×éxito) → la tarea baja a fast.
    const t = new TrustModel({ filePath: tmpPath('trust-routing') });
    for (let i = 0; i < 5; i++) {
      t.recordOutcome(
        goodOutcome({
          mode: 'fast',
          provider: 'groq',
          model: 'llama-fast',
          costUsd: 0.0005,
          elapsedMs: 800,
          difficulty: 0.8,
        })
      );
    }
    for (let i = 0; i < 5; i++) {
      t.recordOutcome(
        goodOutcome({
          mode: 'smart',
          provider: 'groq',
          model: 'llama-smart',
          success: false,
          error: 'timeout',
          costUsd: 0.02,
          elapsedMs: 120000,
          difficulty: 0.8,
        })
      );
    }
    state.trust = t;
    const routed = resolveAgentMode('refactoriza el módulo auth y corre los tests');
    assert(
      routed.mode === 'fast',
      'routing baja a fast (smart falla seguido)',
      `mode=${routed.mode}`
    );

    // Modo explícito SIEMPRE gana (no se sobreescribe).
    assert(
      resolveAgentMode('x', { mode: 'smart' }).mode === 'smart',
      'opts.mode explícito no se toca'
    );

    // trustRouting=false deshabilita el routing.
    const disabled = resolveAgentMode('refactoriza algo', { trustRouting: false });
    assert(disabled.mode === 'smart', 'trustRouting=false → sin routing', `mode=${disabled.mode}`);
  } finally {
    state.trust = prevTrust;
    state.taskDetector = prevDetector;
  }
}

// ── Runner ─────────────────────────────────────────────────────────────────
async function main() {
  testScoring();
  testPersistence();
  testRecommend();
  testCoreFacade();
  testRouting();

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
  console.error(C.red('[test_trust] ERROR inesperado:'), e);
  process.exit(1);
});
