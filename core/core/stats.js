// @ts-nocheck
const logger = require('../observability/Logger.js');
// stats.js — estadísticas del núcleo, telemetría y helpers de debug/testing
// (Control API local).

const LLMProvider = require('../llm/LLMProvider.js');

const state = require('./state.js');

// ── Stats ─────────────────────────────────────────────────────────────────────

function getStats() {
  let busEvents = {};
  try {
    if (typeof state.bus?.getActiveEvents === 'function') {
      busEvents = state.bus.getActiveEvents();
    } else if (typeof state.bus?.eventNames === 'function') {
      busEvents = state.bus.eventNames().reduce((acc, name) => {
        acc[name] = state.bus.listenerCount(name);
        return acc;
      }, {});
    }
  } catch (_) {}

  return {
    session: state.session?.getStats() ?? { error: 'no inicializado' },
    osSensor: state.osSensor?.getCurrentContext() ?? null,
    proactive: state.proactive?.getStats() ?? null,
    autonomy: state.proactive?.getAutonomyMode() ?? null,
    executor: state.proactiveExecutor?.getStats() ?? null,
    signals: {
      git: state.gitWatcher?.getStats() ?? null,
      system: state.systemWatcher?.getStats() ?? null,
      title: state.titleWatcher?.getStats() ?? null,
      clipboard: state.clipboardWatcher?.getStats() ?? null,
      events: state.eventsWatcher?.getStats() ?? null,
      lsp: state.lspErrorWatcher?.getStats() ?? null,
    },
    planner: state.planner?.getStats() ?? null,
    openclaw: state.bridge?.getStats() ?? null,
    intentDetector: state.detector ? { ready: state.detector.isReady() } : null,
    lsp: state.lspManager
      ? {
          running: state.lspManager.isRunning,
          filePatterns: state.lspManager.supportedFilePatterns,
        }
      : null,
    telemetry: state.telemetry?.getStats() ?? null,
    eventBus: busEvents,
    provider: LLMProvider.getActiveProvider() ?? 'groq',
    usingFallback: state.graph?.usingFallback ?? false,
  };
}

function scheduleDailyPrune() {
  const run = () => {
    try {
      state.graph?.pruneAppHistory(30);
    } catch (e) {
      logger.warn('stats', '[core] error en prune diario:', e.message);
    }
  };
  state.pruneInitTimer = setTimeout(run, 10_000);
  state.pruneTimer = setInterval(run, 24 * 60 * 60 * 1000);
}

// ── Fase E: reporte de telemetría ─────────────────────────────────────────────

/** "¿Estamos mejor que el mes pasado?" — métricas de uso real con baseline. */
function getTelemetryReport(opts = {}) {
  if (!state.telemetry) return { ok: false, error: 'telemetría no inicializada' };
  const decisions = state.proposalStore?.getDecisions?.() ?? [];
  return { ok: true, report: state.telemetry.report({ decisions, ...opts }) };
}

/** Snapshots diarios crudos (para el Control API / debugging). */
function getTelemetryStats() {
  return state.telemetry?.getStats() ?? null;
}

// ── Debug / testing (local, vía Control API) ──────────────────────────────────
// Permiten verificar el flujo Fase B en vivo: forzar el scan del GitWatcher
// (que dispara el trigger real del sensor) y resolver la última propuesta
// emitida como si el usuario hubiera clicado su botón.

function debugGitScan() {
  if (!state.gitWatcher) return { ok: false, error: 'GitWatcher no activo' };
  return state.gitWatcher
    .poll()
    .then(() => ({ ok: true, stats: state.gitWatcher.getStats() }))
    .catch((e) => ({ ok: false, error: e.message }));
}

function debugResolveLastProposal(accepted) {
  if (!state.lastProposal)
    return { ok: false, error: 'no hay una propuesta reciente para resolver' };
  const decision = accepted ? 'accepted' : 'rejected';
  const ok =
    state.proactive?.handleDecision({
      proposalId: state.lastProposal.id,
      type: state.lastProposal.type,
      decision,
    }) ?? false;
  return { ok, proposal: state.lastProposal, decision };
}

/** Fase D: fuerza un scan del LSPErrorWatcher (verificación en vivo). */
function debugLSPScan() {
  if (!state.lspErrorWatcher)
    return Promise.resolve({ ok: false, error: 'LSPErrorWatcher no activo' });
  return state.lspErrorWatcher
    .poll()
    .then(() => ({ ok: true, stats: state.lspErrorWatcher.getStats() }))
    .catch((e) => ({ ok: false, error: e.message }));
}

module.exports = {
  getStats,
  scheduleDailyPrune,
  getTelemetryReport,
  getTelemetryStats,
  debugGitScan,
  debugResolveLastProposal,
  debugLSPScan,
};
