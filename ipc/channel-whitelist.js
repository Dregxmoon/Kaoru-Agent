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
  // Python / TTS
  'get-python-bin',
  // Skills / plugins
  'list-skills',
  // MCP
  'mcp-add-server',
  'mcp-list-servers',
  'mcp-remove-server',
  'mcp-search-registry',
  'mcp-toggle-server',
  // Permisos
  'permissions-list',
  'permissions-remove',
  'permissions-set',
  // Sesiones / memoria
  'sessions-list',
  'session-load',
  'memory-forget',
  'store-fact',
  // OpenClaw / exec (vía comandos /)
  'openclaw-available',
  'exec-command',
  // GitHub (vía comandos /)
  'github-client-id',
  // Stats / telemetría (vía comandos /)
  'get-bridge-stats',
  'telemetry-report',
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
]);

/** Canales permitidos para ipcRenderer.on() (solo escucha, de main→renderer). */
const ON_ALLOWLIST = new Set([
  'agent-approval-needed',
  'agent-progress',
  'agent-token',
  'chat-message',
  'gesture',
  'init-theme',
  'initiative',
  'memory-status',
  'model-changed',
  'openclaw-status',
  'proposal-result',
  'resumed-session',
  'set-view',
  'speak',
  'update-status',
  'views-changed',
  'workspace-changed',
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
