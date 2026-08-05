'use strict';

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
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

const fs = require('fs');
const os = require('os');
const path = require('path');
const { StateGraph } = require('../core/state-graph/StateGraph.js');
const { SessionManager } = require('../core/state-graph/SessionManager.js');

function makeGraph() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ses-'));
  const dbPath = path.join(dir, 'core.db');
  const graph = new StateGraph(dbPath).init();
  return { graph, dir };
}

// Replica exactamente la lógica de Core.listSessions / Core.loadSession pero
// sin el ciclo de vida completo del Core (que requiere Electron/app).
function listSessionsLikeCore(graph, limit = 10) {
  if (!graph || graph.usingFallback) return [];
  try {
    return graph.getLastSessions(limit).map((s) => {
      let history = [];
      try {
        history = JSON.parse(s.history_json || '[]') || [];
      } catch {}
      return {
        id: s.id,
        startedAt: s.started_at,
        endedAt: s.ended_at,
        summary: s.summary || null,
        turnCount: s.turn_count || 0,
        history,
      };
    });
  } catch (e) {
    return [];
  }
}

function loadSessionLikeCore(graph, sessionId) {
  if (!graph || graph.usingFallback || !sessionId) return null;
  try {
    const row = graph._sessions?._db
      ? graph._sessions._db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId)
      : null;
    if (!row) return null;
    let history = [];
    try {
      history = JSON.parse(row.history_json || '[]') || [];
    } catch {}
    return {
      id: row.id,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      summary: row.summary || null,
      turnCount: row.turn_count || 0,
      history,
    };
  } catch (e) {
    return null;
  }
}

async function main() {
  console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
  console.log(C.bold(C.cyan('  Test Suite: Sesiones — listado y carga (picker UI)')));
  console.log(C.bold(C.cyan('════════════════════════════════════════════════════════')));

  const { graph, dir } = makeGraph();

  // ── 1. Sin sesiones → lista vacía ─────────────────────────────────────────
  assert(listSessionsLikeCore(graph).length === 0, 'sin sesiones cerradas → lista vacía');

  // ── 2. Crear y cerrar sesiones ────────────────────────────────────────────
  // ── 2. Crear y cerrar sesiones (con graph.endSession directo: el
  //     SessionManager.close() dispara el StateUpdater que espera al LLM) ───
  const sm1 = new SessionManager(graph, null, { resumeMaxAgeHours: 48 });
  const s1 = await sm1.start(null);
  assert(s1.resumed === false, 'primera sesión arranca nueva');
  sm1.addTurn('user', 'hola, qué tal?');
  sm1.addTurn('assistant', 'hola! todo bien');
  graph.updateSessionHistory(s1.sessionId, sm1.getHistory());
  graph.endSession(s1.sessionId, { turnCount: 2, summary: 'primer resumen' });

  const sm2 = new SessionManager(graph, null, { resumeMaxAgeHours: 48 });
  const s2 = await sm2.start(null);
  sm2.addTurn('user', 'segunda conversación');
  sm2.addTurn('assistant', 'ok');
  graph.updateSessionHistory(s2.sessionId, sm2.getHistory());
  graph.endSession(s2.sessionId, { turnCount: 2, summary: 'segundo resumen' });

  const sessions = listSessionsLikeCore(graph);
  assert(sessions.length === 2, 'dos sesiones cerradas listadas');
  assert(sessions[0].history.length === 2, 'el historial de la sesión viene incluido');
  assert(sessions[0].turnCount === 2, 'turnCount reportado');
  assert(
    sessions[1].history[0].content === 'hola, qué tal?',
    'orden cronológico (más reciente primero)'
  );

  // ── 3. Carga por id ───────────────────────────────────────────────────────
  const loaded = loadSessionLikeCore(graph, sessions[1].id);
  assert(loaded !== null, 'session-load devuelve la sesión');
  assert(
    loaded.history.length === 2 && loaded.history[0].role === 'user',
    'historial de la sesión cargada'
  );
  assert(loadSessionLikeCore(graph, 99999) === null, 'id inexistente → null');
  assert(loadSessionLikeCore(graph, null) === null, 'id null → null');

  // ── 4. limit ──────────────────────────────────────────────────────────────
  const limited = listSessionsLikeCore(graph, 1);
  assert(limited.length === 1, 'limit funciona (1 sesión)');

  fs.rmSync(dir, { recursive: true, force: true });

  console.log(C.bold('\n════════════════════════════════════════════════════════'));
  const total = passed + failed;
  if (failed === 0) {
    console.log(
      `  ${C.green('Resultado')}: ${C.green(`${passed} passed`)}  ${C.dim(`0 failed`)}  / ${total} total`
    );
  } else {
    console.log(
      `  Resultado: ${C.green(`${passed} passed`)}  ${C.red(`${failed} failed`)}  / ${total} total`
    );
  }
  console.log(C.bold('════════════════════════════════════════════════════════'));

  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
