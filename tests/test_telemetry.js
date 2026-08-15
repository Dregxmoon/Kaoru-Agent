'use strict';

/**
 * Fase E — evaluación continua: telemetría local que responde "¿estamos
 * mejor que el mes pasado?" con datos reales.
 *
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron tests/test_telemetry.js
 *
 * Cubre:
 *   - TelemetryStore: conteo de turnos user/assistant (mensajes/día).
 *   - Tiempo de respuesta: solo cuando el assistant sigue a un user reciente
 *     (una iniciativa proactiva no infla el promedio).
 *   - Silencios: gap grande entre mensajes del usuario se registra.
 *   - Reuso: sesiones por día (gap largo → sesión nueva).
 *   - Persistencia en disco y reset.
 *   - monthSummary y acceptanceForMonth (tasa por tipo con baseline).
 *   - report(): veredicto "mejor que el mes pasado" con deltas.
 *   - Core.getTelemetryReport: wiring con ProposalStore + Control API.
 *   - Comando /telemetria: registrado, en /help y devuelve el reporte.
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

const { TelemetryStore, RESPONSE_WINDOW_MS } = require('../core/telemetry/TelemetryStore.js');
const { ProposalStore } = require('../core/behavior/ProposalStore.js');
const {
  execute: executeCommand,
  getCommand,
  getHelp,
} = require('../core/commands/CommandRegistry.js');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-'));

// Clock mutable — nos deja "viajar" entre días/meses sin esperar.
let now = 0;
function setNow(ts) {
  now = ts;
}

function makeStore(extra = {}) {
  const filePath = path.join(
    tmpDir,
    `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`
  );
  return new TelemetryStore({ filePath, now: () => now, ...extra });
}

// ── Test 1: turnos y mensajes/día ────────────────────────────────────────────

function testTurns() {
  console.log(C.bold('\nTest 1: turnos — mensajes/día, respuesta y sesiones'));

  const store = makeStore();
  setNow(new Date(2026, 6, 1, 9, 0, 0).getTime());

  store.recordTurn('user'); // primera actividad → 1 sesión, sin silencio (no hay previo)
  store.recordTurn('assistant');
  store.recordTurn('user'); // 1 min después → misma sesión
  setNow(now + 5000);
  store.recordTurn('assistant'); // respuesta en 5s

  const day = store.monthSummary('2026-7');
  assert(day.userMessages === 2, '2 mensajes de usuario');
  assert(day.assistantMessages === 2, '2 mensajes de assistant');
  assert(day.activeDays === 1, '1 día activo');
  assert(day.sessions === 1, 'ráfaga corta → 1 sola sesión');
  assert(day.silenceCount === 0, 'sin gaps largos → sin silencios');

  // Tiempo de respuesta: el 2º assistant siguió al 2º user a los 5s.
  assert(day.responseCount === 1, '1 tiempo de respuesta medido');
  assert(day.avgResponseMs === 5000, 'avg de respuesta = 5000 ms', `got=${day.avgResponseMs}`);
  assert(day.p50ResponseMs === 5000, 'p50 = 5000 ms');
  assert(day.p90ResponseMs === 5000, 'p90 = 5000 ms');

  store.reset();
}

// ── Test 2: proactivo no infla el tiempo de respuesta ─────────────────────────

function testProactiveNotAResponse() {
  console.log(C.bold('\nTest 2: una iniciativa proactiva NO es una respuesta'));

  const store = makeStore();
  setNow(new Date(2026, 6, 1, 9, 0, 0).getTime());

  // user a las 9:00; 35 min después llega un mensaje proactivo (assistant)
  // sin que el usuario haya pedido nada en ese rango (fuera de la ventana de
  // respuesta).
  store.recordTurn('user');
  setNow(now + 35 * 60 * 1000);
  store.recordTurn('assistant'); // iniciativa proactiva

  const day = store.monthSummary('2026-7');
  assert(day.assistantMessages === 1, 'el mensaje proactivo sí se cuenta como assistant');
  assert(day.responseCount === 0, 'NO cuenta como tiempo de respuesta');

  // Silencio y sesión se miden entre turnos del USUARIO: un segundo user
  // 40 min después del proactivo → silencio (gap > 30 min) y sesión nueva.
  setNow(now + 40 * 60 * 1000);
  store.recordTurn('user');
  const day2 = store.monthSummary('2026-7');
  assert(day2.silenceCount === 1, 'sí registra el silencio de 40+ min', `got=${day2.silenceCount}`);
  assert(day2.sessions === 2, 'volver tras el gap → sesión nueva (reuso)');

  store.reset();
}

// ── Test 3: silencios y poda ─────────────────────────────────────────────────

function testSilencesAndPrune() {
  console.log(C.bold('\nTest 3: silencios acumulados y poda de días viejos'));

  const store = makeStore();
  setNow(new Date(2026, 6, 1, 8, 0, 0).getTime());
  store.recordTurn('user');
  setNow(new Date(2026, 6, 1, 12, 0, 0).getTime()); // 4h después
  store.recordTurn('user');

  const day = store.monthSummary('2026-7');
  assert(day.silenceCount === 1, '1 silencio (gap de 4h)');
  assert(day.silenceHours === 4, '4 horas de silencio acumuladas');

  // Poda: inyectar 100 días previos y verificar que se recortan a MAX_DAYS.
  const base = new Date(2025, 0, 1, 8, 0, 0).getTime();
  for (let i = 0; i < 100; i++) {
    setNow(base + i * 24 * 3600 * 1000);
    store.recordTurn('user');
  }
  const keys = Object.keys(store.getStats().days).length;
  assert(keys <= 90, 'días retenidos ≤ 90 (poda)');

  store.reset();
}

// ── Test 4: persistencia y reset ─────────────────────────────────────────────

function testPersistence() {
  console.log(C.bold('\nTest 4: persistencia en disco y reset'));

  const filePath = path.join(tmpDir, 't-persist.json');
  const store = new TelemetryStore({
    filePath,
    now: () => new Date(2026, 6, 5, 10, 0, 0).getTime(),
  });
  store.reset();
  store.recordTurn('user');
  store.recordTurn('assistant');

  const reloaded = new TelemetryStore({
    filePath,
    now: () => new Date(2026, 6, 5, 10, 0, 0).getTime(),
  });
  const day = reloaded.monthSummary('2026-7');
  assert(day.userMessages === 1, 'recargado conserva userMessages');
  assert(day.assistantMessages === 1, 'recargado conserva assistantMessages');

  reloaded.reset();
  assert(
    Object.keys(new TelemetryStore({ filePath, now: () => Date.now() }).getStats().days).length ===
      0,
    'reset limpia el historial'
  );
}

// ── Test 5: acceptanceForMonth — tasa por tipo ────────────────────────────────

function testAcceptance() {
  console.log(C.bold('\nTest 5: tasa de aceptación por tipo (baseline desde Fase A)'));

  const store = makeStore();
  const decisions = [
    {
      proposalId: 'p1',
      type: 'git_redflag',
      decision: 'accepted',
      ts: new Date(2026, 6, 2).getTime(),
    },
    {
      proposalId: 'p2',
      type: 'git_redflag',
      decision: 'rejected',
      ts: new Date(2026, 6, 3).getTime(),
    },
    {
      proposalId: 'p3',
      type: 'system_warning',
      decision: 'accepted',
      ts: new Date(2026, 6, 4).getTime(),
    },
    {
      proposalId: 'p4',
      type: 'long_silence',
      decision: 'accepted',
      ts: new Date(2026, 5, 20).getTime(),
    }, // mes anterior
  ];

  const acc = store.acceptanceForMonth('2026-7', decisions);
  assert(acc.rate === 67, 'julio: 2 de 3 aceptadas → 67%', `got=${acc.rate}`);
  assert(acc.total === 3, 'total de decisiones en julio = 3');
  assert(
    acc.byType.git_redflag.accepted === 1 && acc.byType.git_redflag.rejected === 1,
    'git_redflag: 1/1 en julio'
  );

  const prev = store.acceptanceForMonth('2026-6', decisions);
  assert(prev.rate === 100, 'junio: 1/1 → 100%');

  const none = store.acceptanceForMonth('2026-1', decisions);
  assert(none.rate === null && none.total === 0, 'mes sin decisiones → rate null');

  store.reset();
}

// ── Test 6: report() — "¿mejor que el mes pasado?" ───────────────────────────

function testReport() {
  console.log(C.bold('\nTest 6: report() — veredicto mensual con deltas'));

  const store = makeStore();
  // Junio (baseline, peor): 1 día activo, pocos mensajes, respuestas de 10s,
  // 1 silencio de 3h (gap al mediodía).
  setNow(new Date(2026, 5, 10, 9, 0, 0).getTime());
  store.recordTurn('user');
  setNow(now + 10_000);
  store.recordTurn('assistant'); // resp 10s
  setNow(now + 1000);
  store.recordTurn('user');
  setNow(now + 10_000);
  store.recordTurn('assistant'); // resp 10s
  setNow(new Date(2026, 5, 10, 12, 0, 0).getTime()); // gap ~3h → silencio + sesión
  store.recordTurn('user');
  setNow(now + 10_000);
  store.recordTurn('assistant'); // resp 10s

  // Julio (mejor): 2 días activos, más mensajes/día, respuestas ~400ms,
  // sesiones con gaps de ~25 min (sesión nueva pero SIN silencio).
  setNow(new Date(2026, 6, 1, 9, 0, 0).getTime());
  store.recordTurn('user');
  setNow(now + 500);
  store.recordTurn('assistant'); // resp 500
  setNow(now + 1000);
  store.recordTurn('user');
  setNow(now + 400);
  store.recordTurn('assistant'); // resp 400
  setNow(new Date(2026, 6, 1, 9, 25, 0).getTime()); // gap 25 min → sesión, sin silencio
  store.recordTurn('user');
  setNow(now + 300);
  store.recordTurn('assistant'); // resp 300
  setNow(now + 1000);
  store.recordTurn('user');
  setNow(now + 300);
  store.recordTurn('assistant'); // resp 300
  setNow(new Date(2026, 6, 2, 9, 0, 0).getTime()); // día 2 → sesión nueva, sin silencio (cruza medianoche)
  store.recordTurn('user');
  setNow(now + 400);
  store.recordTurn('assistant'); // resp 400
  setNow(now + 1000);
  store.recordTurn('user');
  setNow(now + 400);
  store.recordTurn('assistant'); // resp 400
  setNow(new Date(2026, 6, 2, 9, 25, 0).getTime());
  store.recordTurn('user');
  setNow(now + 300);
  store.recordTurn('assistant'); // resp 300

  const rep = store.report({ monthKey: '2026-7' });
  assert(rep.compareMonthKey === '2026-6', 'compara contra el mes anterior');
  assert(rep.current.activeDays === 2, 'julio: 2 días activos');
  assert(rep.previous.activeDays === 1, 'junio: 1 día activo');
  assert(
    rep.current.messagesPerDay > rep.previous.messagesPerDay,
    'más mensajes/día en julio',
    `jul=${rep.current.messagesPerDay} jun=${rep.previous.messagesPerDay}`
  );
  assert(
    rep.current.p50ResponseMs < rep.previous.p50ResponseMs,
    'respuesta más rápida en julio',
    `jul=${rep.current.p50ResponseMs} jun=${rep.previous.p50ResponseMs}`
  );
  assert(
    rep.current.silenceHours < rep.previous.silenceHours,
    'menos horas de silencio',
    `jul=${rep.current.silenceHours} jun=${rep.previous.silenceHours}`
  );
  assert(
    rep.current.sessionsPerDay >= rep.previous.sessionsPerDay,
    'sesiones/día no empeora (reuso)',
    `jul=${rep.current.sessionsPerDay} jun=${rep.previous.sessionsPerDay}`
  );
  assert(rep.verdict === 'improved', `veredicto = improved (${rep.verdict})`);
  assert(typeof rep.deltas.messagesPerDay === 'number', 'delta de mensajes/día presente');
  assert(typeof rep.deltas.avgResponseMs === 'number', 'delta de respuesta presente');

  store.reset();
}

// ── Test 7: wiring con Core ─────────────────────────────────────────────

async function testCoreWiring() {
  console.log(C.bold('\nTest 7: wiring — Core.getTelemetryReport'));

  const { TelemetryStore: TS2 } = require('../core/telemetry/TelemetryStore.js');
  assert(typeof TS2 === 'function', 'TelemetryStore exportado');
  assert(
    typeof RESPONSE_WINDOW_MS === 'number' && RESPONSE_WINDOW_MS > 0,
    'RESPONSE_WINDOW_MS exportado'
  );

  // ProposalStore: getDecisions() expone el historial con ts.
  const pStore = new ProposalStore({ filePath: path.join(tmpDir, 't-proposals.json') });
  pStore.reset();
  pStore.record({ proposalId: 'p1', type: 'git_redflag', decision: 'accepted' });
  pStore.record({ proposalId: 'p2', type: 'git_redflag', decision: 'rejected' });
  const dec = pStore.getDecisions();
  assert(dec.length === 2, 'getDecisions devuelve el historial completo');
  assert(typeof dec[0].ts === 'number', 'decisiones con ts (para el reporte mensual)');

  // Core debe exportar getTelemetryReport (integración real).
  const Core = require('../core/Core.js');
  assert(typeof Core.getTelemetryReport === 'function', 'Core.getTelemetryReport exportado');
  assert(typeof Core.getTelemetryStats === 'function', 'Core.getTelemetryStats exportado');
}

// ── Test 8: comando /telemetria ──────────────────────────────────────────────

function testTelemetriaCommand() {
  console.log(C.bold('\nTest 8: comando /telemetria'));

  assert(!!getCommand('telemetria'), '/telemetria registrado');
  assert(getHelp().includes('/telemetria'), '/telemetria aparece en /help');

  const fakeReport = {
    monthKey: '2026-7',
    compareMonthKey: '2026-6',
    verdict: 'improved',
    current: {
      activeDays: 2,
      messagesPerDay: 3,
      p50ResponseMs: 600,
      sessionsPerDay: 1.5,
      silenceCount: 1,
      silenceHours: 1,
      userMessages: 6,
      agentRuns: 4,
      agentToolCalls: 12,
      agentErrors: 1,
      agentApprovalRequests: 2,
      agentApprovalsGranted: 2,
      agentCancelled: 0,
      avgRunDurationMs: 5000,
      p50RunDurationMs: 4000,
      p90RunDurationMs: 9000,
    },
    previous: {
      monthKey: '2026-6',
      activeDays: 1,
      messagesPerDay: 3,
      p50ResponseMs: 10000,
      sessionsPerDay: 1,
      silenceCount: 1,
      silenceHours: 2,
      userMessages: 3,
      agentRuns: 1,
      agentToolCalls: 2,
      agentErrors: 0,
      agentApprovalRequests: 0,
      agentApprovalsGranted: 0,
      agentCancelled: 1,
      avgRunDurationMs: 1000,
      p50RunDurationMs: 1000,
      p90RunDurationMs: 1500,
    },
    deltas: {
      messagesPerDay: 0,
      p50ResponseMs: -94,
      sessionsPerDay: 50,
      silenceCount: 0,
      activeDays: 100,
      acceptanceRate: null,
    },
    acceptance: { rate: null },
    prevAcceptance: { rate: null },
  };
  const ctx = {
    ipcRenderer: { invoke: async () => ({ ok: true, report: fakeReport }) },
  };

  return executeCommand('/telemetria', ctx)
    .then((r) => {
      assert(!r.error, '/telemetria no falla');
      assert(r.result.includes('mejor que el mes pasado'), 'resultado responde "¿mejor?"');
      assert(r.result.includes('2026-6'), 'compara contra el mes anterior');
      assert(r.result.includes('Respuesta p50'), 'incluye tiempo de respuesta');
      assert(r.result.includes('Runs agente'), 'incluye runs del agente');
      assert(r.result.includes('Tools/run'), 'incluye tools por run');
      assert(r.result.includes('Errores: 1'), 'incluye errores de tools');
      assert(r.result.includes('Duracion p90'), 'incluye duracion p90');
    })
    .then(() => {
      return executeCommand('/telemetria', {
        ipcRenderer: { invoke: async () => ({ ok: false, error: 'no' }) },
      });
    })
    .then((r) => {
      assert(r.result.includes('no disponible'), 'error → mensaje claro');
    });
}

// ── Runner ────────────────────────────────────────────────────────────────────

(async () => {
  console.log(C.cyan(C.bold('Fase E — evaluación continua: telemetría local')));

  testTurns();
  testProactiveNotAResponse();
  testSilencesAndPrune();
  testPersistence();
  testAcceptance();
  testReport();
  await testCoreWiring();
  await testTelemetriaCommand();

  // Los asserts async corren por microtareas; esperar un tick.
  await new Promise((r) => setImmediate(r));

  console.log('');
  console.log(C.bold(`Resultado: ${C.green(passed + ' ✓')} / ${C.red(failed + ' ✗')}`));
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(C.red('Fallo en la ejecución de la suite:'), e);
  process.exit(1);
});
