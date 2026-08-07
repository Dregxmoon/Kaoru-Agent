// @ts-nocheck
const logger = require('../observability/Logger.js');
// session.js — gestión de sesiones de chat (SessionManager): arranque,
// cierre, historial, snapshots (checkpoints) y registro de turnos.

const state = require('./state.js');

// ── Sesión ────────────────────────────────────────────────────────────────────

async function startSession() {
  if (!state.session) {
    logger.warn('session', '[core] no inicializado');
    return null;
  }
  const result = await state.session.start(state.app);
  state.bus.emit('session:started', { sessionId: result.sessionId, resumed: result.resumed });
  return result; // { sessionId, resumed, history }
}

async function closeSession() {
  if (state.session) {
    await state.session.close();
    state.bus.emit('session:closed', { sessionId: null });
  }
}

/** Historial de la sesión activa (para checkpoints del CLI). */
function getSessionHistory() {
  return state.session?.getHistory() ?? [];
}

/**
 * Restaura una sesión desde un snapshot (checkpoint). Reemplaza el historial
 * de la sesión activa (o crea una nueva si sessionId es null). El resultado
 * devuelve { sessionId, turnCount } para que el llamador lo guarde en el
 * snapshot junto con el historial.
 * @param {Array<{ role: string, content: string }>} history
 * @param {string | null} [sessionId]
 */
function restoreSessionHistory(history, sessionId = null) {
  if (!state.session) {
    logger.warn('session', '[core] no inicializado');
    return null;
  }
  return state.session.restore(history, sessionId);
}

/**
 * Lista las sesiones pasadas (cerradas) más recientes, para el picker de
 * sesiones de la UI. Devuelve metadatos + historial de cada una.
 * @param {number} limit
 */
function listSessions(limit = 10) {
  if (!state.graph || state.graph.usingFallback) return [];
  try {
    return state.graph.getLastSessions(limit).map((s) => {
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
    logger.warn('session', '[core] error listando sesiones:', e.message);
    return [];
  }
}

/**
 * Carga el historial de una sesión pasada por id (para el picker).
 * @param {number} sessionId
 */
function loadSession(sessionId) {
  if (!state.graph || state.graph.usingFallback || !sessionId) return null;
  try {
    const row = state.graph._sessions?._db
      ? state.graph._sessions._db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId)
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
    logger.warn('session', '[core] error cargando sesión:', e.message);
    return null;
  }
}

function addTurn(role, content) {
  state.session?.addTurn(role, content);
  state.telemetry?.recordTurn(role);
  state.bus.emit('memory:turn-added', { role, content });
}

function detectInstant(userMessage) {
  if (!state.updater) return;
  state.updater.detectAndSaveInstant(userMessage);
}

module.exports = {
  startSession,
  closeSession,
  getSessionHistory,
  restoreSessionHistory,
  listSessions,
  loadSession,
  addTurn,
  detectInstant,
};
