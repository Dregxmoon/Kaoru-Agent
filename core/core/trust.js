// @ts-nocheck
// trust.js — API pública del modelo de confianza (Fase 3, ítem 4). Expone el
// TrustModel a main.js / IPC sin romper la fachada de Core.js.

const state = require('./state.js');

function getTrustData() {
  if (!state.trust || typeof state.trust.getData !== 'function') {
    return { available: false, error: 'modelo de confianza no inicializado' };
  }
  return { available: true, ...state.trust.getData() };
}

function getTrustStats() {
  if (!state.trust || typeof state.trust.getStats !== 'function') {
    return { available: false, error: 'modelo de confianza no inicializado' };
  }
  return { available: true, ...state.trust.getStats() };
}

function trustScore(key) {
  if (!state.trust || typeof state.trust.trustScore !== 'function') return null;
  return state.trust.trustScore(key);
}

function recommendMode(opts) {
  if (!state.trust || typeof state.trust.recommendMode !== 'function') return null;
  return state.trust.recommendMode(opts || {});
}

function recordTrustOutcome(outcome) {
  if (!state.trust || typeof state.trust.recordOutcome !== 'function') return null;
  return state.trust.recordOutcome(outcome || {});
}

function resetTrust() {
  if (!state.trust || typeof state.trust.reset !== 'function') return { ok: false };
  state.trust.reset();
  return { ok: true };
}

module.exports = {
  getTrustData,
  getTrustStats,
  trustScore,
  recommendMode,
  recordTrustOutcome,
  resetTrust,
};
