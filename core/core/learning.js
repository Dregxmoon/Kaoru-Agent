// @ts-nocheck
// learning.js — API pública del aprendizaje (Fase 3, ítem 2). Expone el
// LearningEngine a main.js / IPC sin romper la fachada de Core.js.

const state = require('./state.js');

function getLearningData() {
  if (!state.learning || typeof state.learning.getData !== 'function') {
    return { available: false, error: 'aprendizaje no inicializado' };
  }
  return { available: true, ...state.learning.getData() };
}

function getTaskOutcomes(opts) {
  if (!state.learning || typeof state.learning.getTaskOutcomes !== 'function') return [];
  return state.learning.getTaskOutcomes(opts || {});
}

function getLearnedWeights() {
  return state.learning ? state.learning.getLearnedWeights() : null;
}

function recordTaskOutcome(outcome) {
  if (!state.learning || typeof state.learning.recordTaskOutcome !== 'function') return null;
  return state.learning.recordTaskOutcome(outcome || {});
}

function listReflectionProposals(opts) {
  if (!state.learning || typeof state.learning.listReflectionProposals !== 'function') return [];
  return state.learning.listReflectionProposals(opts || {});
}

function decideReflection(id, decision) {
  if (!state.learning || typeof state.learning.decideReflection !== 'function') return false;
  return state.learning.decideReflection(String(id), decision);
}

function resetLearning() {
  if (!state.learning || typeof state.learning.reset !== 'function') return { ok: false };
  state.learning.reset();
  return { ok: true };
}

module.exports = {
  getLearningData,
  getTaskOutcomes,
  getLearnedWeights,
  recordTaskOutcome,
  listReflectionProposals,
  decideReflection,
  resetLearning,
};
