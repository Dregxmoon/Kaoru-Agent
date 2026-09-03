'use strict';

// @ts-check

// Whitelist de canales IPC que los renderers (chat y overlay) pueden usar
// vía el bridge. Cualquier canal que NO esté aquí se rechaza en el preload
// con un error — el renderer (y cualquier script comprometido) no puede
// invocar canales internos no previstos.
//
// La lista cubre:
//   - canales que el renderer llama directamente (src/chat/*.js, src/index.html)
//   - canales que los comandos / usan vía ctx.ipcRenderer (CommandRegistry,
//     core/commands/*.js), porque esos comandos corren con el bridge del chat.
//
// Añadir un canal nuevo aquí es una decisión consciente, no un "just works".

/** Canales permitidos para ipcRenderer.invoke(). */
const INVOKE_ALLOWLIST = new Set([
  // Config / keys
  'get-config',
  'get-key-source',
  'save-llm-keys',
  'set-llm-model',
  // Settings (§9) / PIN (§11.1)
  'set-config',
  'github-status',
  'pin-status',
  'pin-set',
  'pin-check',
  'pin-clear',
  // Selector modelo-first (nivel opencode)
  'get-model-picker',
  'connect-llm-provider',
  'favorite-model',
  // Workspace
  'get-workspace',
  'pick-workspace-folder',
  // Contexto / agente
  'grounding-build-context',
  'agent-run',
  // Modelo 3D / vistas
  'get-model-info',
  'models-list',
  'model-import',
  'model-set',
  'views-get',
  'views-set',
  'gesture-config',
  'gesture-mappings-get',
  'gesture-mappings-set',
  'gesture-mappings-remove',
  // Python / TTS
  'get-python-bin',
  // Overlay sandbox:true (Fase 2, ítem 6) — capacidades del overlay vía main
  'overlay-core-sources',
  'overlay-fs-exists',
  'overlay-augment-model',
  'overlay-list-gestures',
  'overlay-tts-stream',
  // Skills / plugins
  'list-skills',
  // MCP
  'mcp-add-server',
  'mcp-list-servers',
  'mcp-remove-server',
  'mcp-search-registry',
  'mcp-toggle-server',
  'mcp-get-featured',
  'mcp-get-categories',
  'mcp-get-oauth-providers',
  'mcp-oauth-start',
  'mcp-oauth-check',
  // Permisos
  'permissions-list',
  'permissions-remove',
  'permissions-set',
  // Sesiones / memoria
  'sessions-list',
  'session-load',
  'session-stats',
  'nodes-list',
  'nodes-graph',
  'memory-gaps',
  'memory-forget',
  'memory-inspect',
  'memory-correct',
  'memory-delete',
  'memory-export',
  'store-fact',
  // Metas persistentes (Fase 3, ítem 1)
  'intentions-list',
  'intention-complete',
  'intention-drop',
  // OpenClaw / exec (vía comandos /)
  'openclaw-available',
  'openclaw-status',
  'exec-command',
  // GitHub (vía comandos /)
  'github-client-id',
  // Stats / telemetría (vía comandos /)
  'get-bridge-stats',
  'telemetry-report',
  // ProactiveEngine (vía comando /proactive)
  'proactive:get-stats',
  'proactive:set-autonomy',
  'proactive:set-shadow-mode',
  // Chat sandbox:true — lógica del chat movida a main (ipc/chat-handlers.js)
  'chat-run-command',
  'chat-core-sources',
  'chat-fs-exists',
  'chat-fs-stat-dir',
  'chat-cwd',
  'chat-path-join',
  'chat-augment-model',
  'chat-list-gestures',
  'chat-tts-stream',
  'chat-asr-stream',
  'chat-llm-state',
  'chat-llm-configure',
  'chat-llm-complete',
  'chat-commands-names',
  'chat-commands-index',
  'chat-files-list',
  'chat-files-context',
  'chat-agents-prompt',
]);

/** Canales permitidos para ipcRenderer.send(). */
const SEND_ALLOWLIST = new Set([
  'agent-approval-response',
  'agent-cancel',
  'chat-close',
  'chat-theme-changed',
  'drag-move',
  'drag-start',
  'initiative-decision',
  'memory-add-turn',
  'model-dblclick',
  'model-hover',
  'set-provider',
  'view-changed',
  // Chat sandbox:true (roundtrip main→página + cancel del flujo simple)
  'chat-llm-cancel',
  'chat-ui-call-result',
]);

/** Canales permitidos para ipcRenderer.on() (solo escucha, de main→renderer). */
const ON_ALLOWLIST = new Set([
  'agent-approval-needed',
  'agent-approval-expired',
  'agent-plan',
  'agent-progress',
  'agent-subagent-progress',
  'agent-result-meta',
  'agent-token',
  'chat-message',
  'gesture',
  'gesture-mappings',
  'init-theme',
  'initiative',
  'memory-status',
  'model-changed',
  'openclaw-status',
  'proposal-result',
  'resumed-session',
  'startup-notice',
  'set-view',
  'speak',
  'update-status',
  'views-changed',
  'workspace-changed',
  // Chat sandbox:true (main envía funciones de página vía roundtrip)
  'chat-ui-call',
]);

/**
 * @param {'invoke'|'send'|'on'} kind
 * @param {unknown} channel
 */
function _checkChannel(kind, channel) {
  if (typeof channel !== 'string' || channel.length === 0) {
    throw new Error(`[ipc-whitelist] canal ${kind} inválido`);
  }
}

/**
 * Comprueba si un canal está permitido para invoke/send/on. Lanza si no.
 * @param {'invoke'|'send'|'on'} kind
 * @param {string} channel
 */
function assertAllowed(kind, channel) {
  _checkChannel(kind, channel);
  const list =
    kind === 'invoke' ? INVOKE_ALLOWLIST : kind === 'send' ? SEND_ALLOWLIST : ON_ALLOWLIST;
  if (!list.has(channel)) {
    throw new Error(
      `[ipc-whitelist] canal '${channel}' no permitido para ${kind}() desde el renderer`
    );
  }
}

module.exports = { assertAllowed, INVOKE_ALLOWLIST, SEND_ALLOWLIST, ON_ALLOWLIST };
