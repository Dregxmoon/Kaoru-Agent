/**
 * Core.js — punto de entrada y fachada pública del núcleo.
 *
 * La lógica del núcleo se divide en módulos por dominio bajo `core/core/`:
 *
 *   - core/core/state.js       → estado mutable compartido (variables de módulo).
 *   - core/core/init.js        → secuencia de arranque (init).
 *   - core/core/shutdown.js    → cierre ordenado (shutdown).
 *   - core/core/config.js      → carga de config (LLM, MCP, sensores, autonomía).
 *   - core/core/context.js     → buildContext (system prompt + modos).
 *   - core/core/agent.js       → runAgent (loop cerrado con tool-calling).
 *   - core/core/session.js     → sesiones de chat (start/close/history/checkpoints).
 *   - core/core/workspace.js   → workspace activo.
 *   - core/core/openclaw.js    → ciclo de vida de openclaw-server.
 *   - core/core/mcp.js         → API pública de servidores MCP.
 *   - core/core/stats.js       → estadísticas, telemetría y debug.
 *   - core/core/permissions.js → permisos granulares (allow/ask/deny).
 *   - core/core/misc.js        → callbacks, memoria y getters.
 *
 * Este archivo solo re-exporta la API pública; main.js, bin/cli.js y los IPC
 * handlers siguen consumiendo `require('./core/Core.js')` sin cambios.
 */

const { init } = require('./core/init.js');
const { shutdown } = require('./core/shutdown.js');
const { buildContext } = require('./core/context.js');
const { runAgent } = require('./core/agent.js');
const {
  startSession,
  closeSession,
  listSessions,
  loadSession,
  getSessionHistory,
  restoreSessionHistory,
  addTurn,
  detectInstant,
} = require('./core/session.js');
const { setActiveWorkspace, getWorkspace } = require('./core/workspace.js');
const {
  mcpListServers,
  mcpAddServer,
  mcpRemoveServer,
  mcpToggleServer,
  mcpSearchRegistry,
} = require('./core/mcp.js');
const { reloadLLMConfig } = require('./core/config.js');
const {
  listIntentions,
  addIntention,
  completeIntention,
  dropIntention,
  getIntentionsStats,
} = require('./core/intentions.js');
const {
  getStats,
  getTelemetryReport,
  getTelemetryStats,
  debugGitScan,
  debugResolveLastProposal,
  debugLSPScan,
} = require('./core/stats.js');
const {
  permissionsSetRule,
  permissionsRemoveRule,
  permissionsList,
} = require('./core/permissions.js');
const {
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
  getEventBus,
  getPlanner,
  getBridge,
  listSkills,
  storeFact,
} = require('./core/misc.js');
const {
  getLearningData,
  getTaskOutcomes,
  getLearnedWeights,
  recordTaskOutcome,
  resetLearning,
} = require('./core/learning.js');
const {
  getTrustData,
  getTrustStats,
  trustScore,
  recommendMode,
  recordTrustOutcome,
  resetTrust,
} = require('./core/trust.js');

module.exports = {
  init,
  shutdown,
  startSession,
  closeSession,
  listSessions,
  loadSession,
  getSessionHistory,
  restoreSessionHistory,
  addTurn,
  detectInstant,
  buildContext,
  getStats,
  getGraph,
  getOSSensor,
  getEventBus,
  getPlanner,
  getBridge,
  onInitiative,
  onProposalResult,
  setChatOpen,
  handleProposalDecision,
  debugGitScan,
  debugResolveLastProposal,
  debugLSPScan,
  getTelemetryReport,
  getTelemetryStats,
  forgetMemory,
  pendingRecap,
  getProactiveStats,
  setAutonomyMode,
  setShadowMode,
  reloadLLMConfig,
  isOpenClawAvailable,
  runAgent,
  mcpListServers,
  mcpAddServer,
  mcpRemoveServer,
  mcpToggleServer,
  mcpSearchRegistry,
  setActiveWorkspace,
  getWorkspace,
  listSkills,
  storeFact,
  permissionsSetRule,
  permissionsRemoveRule,
  permissionsList,
  getUsageTracker: () => require('./llm/LLMProvider.js').getUsageTracker(),
  listIntentions,
  addIntention,
  completeIntention,
  dropIntention,
  getIntentionsStats,
  getLearningData,
  getTaskOutcomes,
  getLearnedWeights,
  recordTaskOutcome,
  resetLearning,
  getTrustData,
  getTrustStats,
  trustScore,
  recommendMode,
  recordTrustOutcome,
  resetTrust,
};
