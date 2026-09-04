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

/** Stack de intenciones activas del workspace actual, salvo petición explícita global. */
function listIntentions({ limit = 10, workspace, all = false } = {}) {
  const g = _graph();
  if (!g) return [];
  try {
    const scope = all ? null : workspace || state.activeWorkspace || null;
    return g.listActiveIntentions({ limit, workspace: scope });
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
    const id = g.createIntention({
      sessionId,
      goal,
      workspace: state.activeWorkspace,
      steps,
      lastProgress,
    });
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

function getIntentionPlan(id) {
  const g = _graph();
  return g?.getGoalPlan?.(Number(id)) || [];
}

function getIntentionResumePoint(id) {
  const g = _graph();
  return g?.getGoalResumePoint?.(Number(id)) || null;
}

function updateIntentionStep(id, ordinal, update) {
  const g = _graph();
  if (!g?.updateGoalStep) return false;
  try {
    const ok = g.updateGoalStep(Number(id), Number(ordinal), update || {});
    if (ok) state.bus?.emit('intention:step-updated', { id, ordinal });
    return ok;
  } catch (e) {
    logger.warn('intentions', '[core] error actualizando paso:', e.message);
    return false;
  }
}

function listIntentionEvents(id, opts) {
  const g = _graph();
  return g?.listGoalEvents?.(Number(id), opts || {}) || [];
}

module.exports = {
  listIntentions,
  addIntention,
  completeIntention,
  dropIntention,
  getIntentionsStats,
  getIntentionPlan,
  getIntentionResumePoint,
  updateIntentionStep,
  listIntentionEvents,
};
