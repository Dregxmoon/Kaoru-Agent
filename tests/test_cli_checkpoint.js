'use strict';

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

function assertEqual(a, b, label) {
  const ok = a === b;
  assert(ok, label, ok ? '' : `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const { SessionManager } = require('../core/state-graph/SessionManager.js');

// ── Mock del state graph ────────────────────────────────────────────────────
function makeMockGraph() {
  let nextId = 1;
  /** @type {Map<string, Array<object>>} */
  const historyBySession = new Map();
  return {
    _sessions: null,
    findResumableSession: () => null,
    startSession: () => `mock-${nextId++}`,
    updateSessionHistory: (id, history) => {
      historyBySession.set(id, [...history]);
    },
    endSession: (_id, _opts) => {},
    getStats: () => ({ usingFallback: true }),
    _mockHistory: historyBySession,
  };
}

// ── Test 1: restore crea sesión nueva y persiste ────────────────────────────
function testRestoreNewSession() {
  console.log(C.bold('\n── SessionManager.restore (sesión nueva) ─────────────'));

  const graph = makeMockGraph();
  const sm = new SessionManager(graph, {}, { resumeMaxAgeHours: 1 });

  const history = [
    { role: 'user', content: 'hola' },
    { role: 'assistant', content: 'hola kaoru' },
    { role: 'user', content: 'cuéntame un chiste' },
  ];
  const out = sm.restore(history, null);

  assert(out.sessionId && out.sessionId.startsWith('mock-'), 'crea sesión nueva');
  assertEqual(out.turnCount, 3, 'turnCount = 3');
  assertEqual(sm.getHistory().length, 3, 'historial restaurado en memoria');
  assertEqual(graph._mockHistory.get(out.sessionId).length, 3, 'historial persistido al graph');
  assertEqual(sm.getHistory()[0].content, 'hola', 'primer mensaje conservado');
}

// ── Test 2: restore con sessionId dado ──────────────────────────────────────
function testRestoreGivenId() {
  console.log(C.bold('\n── SessionManager.restore (sessionId dado) ───────────'));

  const graph = makeMockGraph();
  const sm = new SessionManager(graph, {}, { resumeMaxAgeHours: 1 });

  const out = sm.restore([{ role: 'user', content: 'x' }], 'sesion-fija');

  assertEqual(out.sessionId, 'sesion-fija', 'usa el sessionId dado');
  assertEqual(sm.getHistory().length, 1, 'historial restaurado');
}

// ── Test 3: restore no válido ───────────────────────────────────────────────
function testRestoreInvalid() {
  console.log(C.bold('\n── SessionManager.restore (input inválido) ───────────'));

  const graph = makeMockGraph();
  const sm = new SessionManager(graph, {}, { resumeMaxAgeHours: 1 });

  const out = sm.restore(null, null);
  assertEqual(out.turnCount, 0, 'history no-array → 0 turnos');
  assertEqual(sm.getHistory().length, 0, 'historial vacío');

  sm.restore('no soy array', null);
  assertEqual(sm.getHistory().length, 0, 'string no rompe');
}

// ── Test 4: restore + addTurn conviven ──────────────────────────────────────
function testRestoreThenAddTurn() {
  console.log(C.bold('\n── restore + addTurn ─────────────────────────────────'));

  const graph = makeMockGraph();
  const sm = new SessionManager(graph, {}, { resumeMaxAgeHours: 1 });

  sm.restore(
    [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ],
    null
  );
  sm.addTurn('user', 'c');
  const hist = sm.getHistory();
  assertEqual(hist.length, 3, 'addTurn se anexa al historial restaurado');
  assertEqual(hist[2].content, 'c', 'último mensaje es el turno nuevo');
}

// ── Test 5: cap de historial a 40 ───────────────────────────────────────────
function testRestoreCap() {
  console.log(C.bold('\n── restore respeta el cap de 40 mensajes ─────────────'));

  const graph = makeMockGraph();
  const sm = new SessionManager(graph, {}, { resumeMaxAgeHours: 1 });

  const big = Array.from({ length: 100 }, (_, i) => ({ role: 'user', content: `m${i}` }));
  const out = sm.restore(big, null);
  assertEqual(out.turnCount, 40, 'turnCount capado a 40');
  assertEqual(sm.getHistory().length, 40, 'historial capado a 40');
  assertEqual(sm.getHistory()[0].content, 'm60', 'se conservan los MÁS recientes');
}

// ── Test 6: checkpoints del CLI (snapshot round-trip en disco) ──────────────
function testCheckpointFileRoundTrip() {
  console.log(C.bold('\n── Checkpoint CLI: round-trip en disco ───────────────'));

  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-'));
  const oldEnv = process.env.ASISTENTE_CHECKPOINTS;
  process.env.ASISTENTE_CHECKPOINTS = dir;
  try {
    // Misma lógica de saneado/ruta que bin/cli.js
    const safe = (name) => String(name).replace(/[^a-zA-Z0-9._-]/g, '_');
    const ckpt = (name) => path.join(dir, `${safe(name)}.json`);

    const name = 'mi-proyecto';
    const snap = {
      name,
      history: [{ role: 'user', content: 'hola' }],
      ts: new Date().toISOString(),
    };
    fs.writeFileSync(ckpt(name), JSON.stringify(snap, null, 2), 'utf-8');

    assert(fs.existsSync(ckpt(name)), 'checkpoint escrito en disco');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    assertEqual(files.length, 1, 'un solo archivo de checkpoint');
    assert(files[0].startsWith('mi-proyecto'), 'nombre saneado en el archivo');

    const back = JSON.parse(fs.readFileSync(ckpt(name), 'utf-8'));
    assertEqual(back.history[0].content, 'hola', 'round-trip conserva el historial');

    assertEqual(safe('uno/dos:tres'), 'uno_dos_tres', 'nombres peligrosos se sanean');
  } finally {
    if (oldEnv === undefined) delete process.env.ASISTENTE_CHECKPOINTS;
    else process.env.ASISTENTE_CHECKPOINTS = oldEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────

console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
console.log(C.bold(C.cyan('  Kaoru — Test Suite: CLI + Checkpoints de sesión')));
console.log(C.bold(C.cyan('════════════════════════════════════════════════════════')));

function main() {
  testRestoreNewSession();
  testRestoreGivenId();
  testRestoreInvalid();
  testRestoreThenAddTurn();
  testRestoreCap();
  testCheckpointFileRoundTrip();

  console.log(C.bold('\n════════════════════════════════════════════════════════'));
  const total = passed + failed + skipped;
  const skipNote = skipped > 0 ? `  ${C.yellow(`${skipped} skipped`)}` : '';
  if (failed === 0) {
    console.log(
      `  ${C.green('Resultado')}: ${C.green(`${passed} passed`)}  ${C.dim(`0 failed`)}${skipNote}  / ${total} total`
    );
  } else {
    console.log(
      `  Resultado: ${C.green(`${passed} passed`)}  ${C.red(`${failed} failed`)}${skipNote}  / ${total} total`
    );
  }
  console.log(C.bold('════════════════════════════════════════════════════════'));

  if (failed > 0) process.exit(1);
}

main();
