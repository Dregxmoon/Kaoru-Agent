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

// ── Runtime del ProactiveEngine (comando /proactive) ───────────────────────

/** Stats en vivo del engine (getStats de testing.js). */
function getProactiveStats() {
  return state.proactive?.getStats() ?? null;
}

/** Cambia el modo de autonomía (observe | suggest | act) en runtime. */
function setAutonomyMode(mode) {
  if (!state.proactive) return { ok: false, error: 'engine no inicializado' };
  state.proactive.setAutonomyMode(mode);
  return { ok: true, mode: state.proactive.getAutonomyMode() };
}

/** Cambia el shadow mode (gate/audit corren, nada se envía) en runtime. */
function setShadowMode(on) {
  if (!state.proactive) return { ok: false, error: 'engine no inicializado' };
  state.proactive.setShadowMode(on);
  return { ok: true, shadowMode: state.proactive.getShadowMode() };
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
  getProactiveStats,
  setAutonomyMode,
  setShadowMode,
  getGraph,
  getOSSensor,
  getEventBus: getEventBus_,
  getPlanner: getPlanner_,
  getBridge,
  listSkills,
  storeFact,
};
