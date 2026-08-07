// @ts-nocheck
const logger = require('../observability/Logger.js');
// misc.js — funciones varias del núcleo: callbacks del bus de iniciativa,
// canal del chat, memoria y getters expuestos a main.js / IPC.

const state = require('./state.js');

function onInitiative(cb) {
  state.onInitiative = cb;
}

function onProposalResult(cb) {
  state.onProposalResult = cb;
}

function setChatOpen(open) {
  state.proactive?.setChatOpen(open);
}

// Fase A: el usuario respondió a una propuesta (aceptar/descartar) desde el
// chat. Se reenvía al ProactiveEngine, que persiste el feedback y ajusta la
// frecuencia futura de ese tipo de iniciativa.
function handleProposalDecision(decision) {
  return state.proactive?.handleDecision(decision) ?? false;
}

async function isOpenClawAvailable() {
  if (!state.bridge) return false;
  return state.bridge.isAvailable();
}

// ── Fase C: compañero persistente ─────────────────────────────────────────────

/** /olvida X — archiva los nodos de memoria que matcheen el texto. */
function forgetMemory(text) {
  if (!state.graph) return { found: 0, archived: 0, error: 'grafo no inicializado' };
  return state.graph.forget(text);
}

/** Al arrancar: ofrece retomar lo pendiente (recordatorios guardados). */
function pendingRecap() {
  return state.proactive?.pendingRecap() ?? Promise.resolve(null);
}

// ── Getters ───────────────────────────────────────────────────────────────────

function getGraph() {
  return state.graph;
}
function getOSSensor() {
  return state.osSensor;
}
function getEventBus_() {
  return state.bus;
}
function getPlanner_() {
  return state.planner;
}
function getBridge() {
  return state.bridge;
}
function listSkills() {
  if (!state.skillManager) return [];
  return state.skillManager.getAllSkills();
}

function storeFact({ type, label, content, importance = 0.85, tags = [] }) {
  if (!state.graph?.isReady) return null;
  try {
    return state.graph.createNode({ type, label, content, importance, tags });
  } catch (e) {
    logger.warn('misc', '[core] error guardando hecho:', e.message);
    return null;
  }
}

module.exports = {
  onInitiative,
  onProposalResult,
  setChatOpen,
  handleProposalDecision,
  isOpenClawAvailable,
  forgetMemory,
  pendingRecap,
  getGraph,
  getOSSensor,
  getEventBus: getEventBus_,
  getPlanner: getPlanner_,
  getBridge,
  listSkills,
  storeFact,
};
