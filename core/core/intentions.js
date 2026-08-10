// @ts-nocheck
const logger = require('../observability/Logger.js');
// intentions.js — metas persistentes (Fase 3, ítem 1).
// Fachada sobre el IntentionsStore del StateGraph: el stack de intenciones
// activas (metas en vuelo) sobrevive al reinicio y se re-inyecta al prompt
// del agente al reanudar (re-planificación).

const state = require('./state.js');

function _graph() {
  if (!state.graph || state.graph.usingFallback) return null;
  return state.graph;
}

/** Stack de intenciones activas, del tope (más reciente) hacia abajo. */
function listIntentions({ limit = 10 } = {}) {
  const g = _graph();
  if (!g) return [];
  try {
    return g.listActiveIntentions({ limit });
  } catch (e) {
    logger.warn('intentions', '[core] error listando intenciones:', e.message);
    return [];
  }
}

/** Empuja una intención activa al tope del stack (para la sesión actual). */
function addIntention({ goal, steps = [], lastProgress = '' } = {}) {
  const g = _graph();
  if (!g) return null;
  const sessionId = state.session?.getSessionId?.() || '';
  try {
    const id = g.createIntention({ sessionId, goal, steps, lastProgress });
    state.bus?.emit('intention:added', { id, goal });
    return id;
  } catch (e) {
    logger.warn('intentions', '[core] error creando intención:', e.message);
    return null;
  }
}

/** @param {number} id */
function completeIntention(id) {
  const g = _graph();
  if (!g) return false;
  try {
    const ok = g.completeIntention(id);
    if (ok) state.bus?.emit('intention:completed', { id });
    return ok;
  } catch (e) {
    logger.warn('intentions', '[core] error completando intención:', e.message);
    return false;
  }
}

/** @param {number} id */
function dropIntention(id) {
  const g = _graph();
  if (!g) return false;
  try {
    return g.dropIntention(id);
  } catch (e) {
    logger.warn('intentions', '[core] error descartando intención:', e.message);
    return false;
  }
}

function getIntentionsStats() {
  const g = _graph();
  if (!g) return { active: 0, done: 0, dropped: 0 };
  try {
    return g.intentionStats();
  } catch (e) {
    logger.warn('intentions', '[core] error en stats:', e.message);
    return { active: 0, done: 0, dropped: 0 };
  }
}

module.exports = {
  listIntentions,
  addIntention,
  completeIntention,
  dropIntention,
  getIntentionsStats,
};
