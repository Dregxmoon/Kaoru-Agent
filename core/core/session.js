// @ts-nocheck
const logger = require('../observability/Logger.js');
// session.js — gestión de sesiones de chat (SessionManager): arranque,
// cierre, historial, snapshots (checkpoints) y registro de turnos.

const state = require('./state.js');
const fs = require('fs');
const path = require('path');
const { setActiveWorkspace } = require('./workspace.js');
let _switching = false;

function conversationRow(row) {
  let history = [];
  try {
    history = JSON.parse(row.history_json || '[]');
  } catch {}
  if (!Array.isArray(history)) history = [];
  const firstUser = history.find((turn) => turn.role === 'user');
  return {
    id: row.id,
    workspace: row.workspace || null,
    title: (row.summary || firstUser?.content || 'Nuevo chat').split('\n')[0].slice(0, 80),
    startedAt: row.started_at,
    lastActiveAt: row.last_active_at || row.started_at,
    turnCount: row.turn_count || 0,
    missingWorkspace: Boolean(row.workspace && !fs.existsSync(row.workspace)),
  };
}

function listConversations(limit = 100) {
  if (!state.graph?._sessions) return [];
  return state.graph._sessions
    .listConversations(Math.min(200, Math.max(1, Number(limit) || 100)))
    .map(conversationRow);
}

function activeConversation() {
  const id = state.session?.getSessionId();
  const row = id && state.graph?._sessions?.getSession(id);
  if (!row) return null;
  let history = [];
  try {
    history = JSON.parse(row.history_json || '[]');
  } catch {}
  return { ...conversationRow(row), history: Array.isArray(history) ? history : [] };
}

async function switchConversation({ id = null, workspace = null } = {}) {
  if (_switching) return { ok: false, error: 'Cambio de conversación en curso' };
  if (!state.session || !state.graph?._sessions)
    return { ok: false, error: 'Sesiones no disponibles' };
  const store = state.graph._sessions;
  const row = id == null ? null : store.getSession(Number(id));
  if (id != null && !row) return { ok: false, error: 'Conversación inexistente' };
  const target = workspace || row?.workspace || null;
  if (!target) return { ok: false, error: 'Elige una carpeta para esta conversación' };
  const resolved = path.resolve(target);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return { ok: false, error: `La carpeta no existe: ${resolved}` };
  }
  const current = state.session.getSessionId();
  if (row && current === row.id && row.workspace === resolved) {
    return { ok: true, unchanged: true, conversation: activeConversation() };
  }
  _switching = true;
  try {
    const previous = current ? store.getSession(current) : null;
    await state.session.close();
    let activated;
    try {
      activated = await setActiveWorkspace(resolved);
    } catch (error) {
      if (previous) state.session.openExisting(previous);
      throw error;
    }
    if (!activated.ok) {
      if (previous) state.session.openExisting(previous);
      return activated;
    }
    const result = row ? state.session.openExisting(row) : state.session.startNew(resolved);
    store.touchConversation(result.sessionId, resolved);
    if (previous && previous.id !== result.sessionId) store.deleteEmptyConversation(previous.id);
    state.bus.emit('session:started', { sessionId: result.sessionId, resumed: Boolean(row) });
    return { ok: true, conversation: activeConversation() };
  } finally {
    _switching = false;
  }
}

async function startChatConversation(requestedWorkspace = null) {
  state.session?.prepareChatStart(state.app);
  state.graph?._sessions?.pruneEmptyConversations(state.session?.getSessionId() || null);
  const rows = listConversations();
  const requested = requestedWorkspace ? path.resolve(requestedWorkspace) : null;
  const recent = rows.find(
    (row) => row.workspace && !row.missingWorkspace && (!requested || row.workspace === requested)
  );
  if (recent) return switchConversation({ id: recent.id });
  if (requested) return switchConversation({ workspace: requested });
  return { ok: true, conversation: null };
}

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
    const closingId = state.session.getSessionId();
    await state.session.close();
    if (closingId) state.graph?._sessions?.deleteEmptyConversation(closingId);
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
  // `memory:turn-added` es la única ruta hacia ProactiveEngine: además de
  // alimentar la guardia de conversación, puede vincular una respuesta con
  // una pregunta pendiente. Evitar una llamada directa impide contar dos veces.
  state.bus.emit('memory:turn-added', { role, content });
}

function detectInstant(userMessage) {
  if (!state.updater) return;
  state.updater.detectAndSaveInstant(userMessage, {
    sessionId: state.session?.getSessionId?.() ?? null,
  });
}

module.exports = {
  listConversations,
  activeConversation,
  switchConversation,
  startChatConversation,
  startSession,
  closeSession,
  getSessionHistory,
  restoreSessionHistory,
  listSessions,
  loadSession,
  addTurn,
  detectInstant,
};
