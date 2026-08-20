// @ts-nocheck
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Preload thin del chat (src/chat.html) con sandbox:true.
//
// Con el sandbox de Chromium habilitado, el preload corre en un contexto
// aislado donde SOLO puede require('electron') (contextBridge/ipcRenderer) —
// nada de fs/path/child_process, ni módulos core, ni módulos de la app. Toda
// la lógica Node del chat vive ahora en el proceso main
// (ipc/chat-handlers.js) y este preload solo expone:
//   - la firma invoke/send/on con una allowlist local por ventana
//   - wrappers de los métodos que la página consume (LLMProvider,
//     CommandRegistry, FileResolver, AgentManager, ModelAugmenter, ttsStream)
//   - el puente de roundtrip onUiCall/uiCallResult (chat-ui-call ↔
//     chat-ui-call-result) que el main usa para pedirle funciones a la página
//   - caches de estado LLM e índice de comandos, porque getActiveProvider/
//     getAvailableProviders/getNames se leen SÍNCRONO en la página y un IPC
//     no puede ser síncrono.
//
// La lista de canales de abajo es el subconjunto del chat de
// ipc/channel-whitelist.js (que sigue siendo la fuente documentada): si la
// página (o un script comprometido) intenta llamar un canal que no está aquí,
// el preload lo rechaza antes de tocar ipcRenderer.
const INVOKE_ALLOWLIST = new Set([
  // Config / keys / modelo-first
  'get-config',
  'get-key-source',
  'save-llm-keys',
  'set-llm-model',
  'get-model-picker',
  'connect-llm-provider',
  'favorite-model',
  // Settings (§9) / PIN (§11.1)
  'set-config',
  'github-status',
  'pin-status',
  'pin-set',
  'pin-check',
  'pin-clear',
  // Workspace / contexto / agente
  'get-workspace',
  'pick-workspace-folder',
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
  // Python / skills
  'get-python-bin',
  'list-skills',
  // MCP / permisos
  'mcp-add-server',
  'mcp-list-servers',
  'mcp-remove-server',
  'mcp-search-registry',
  'mcp-toggle-server',
  'permissions-list',
  'permissions-remove',
  'permissions-set',
  // Sesiones / memoria / intenciones
  'sessions-list',
  'session-load',
  'session-stats',
  'nodes-list',
  'nodes-graph',
  'memory-gaps',
  'memory-forget',
  'store-fact',
  'intentions-list',
  'intention-complete',
  'intention-drop',
  // OpenClaw / GitHub / stats / proactive
  'openclaw-available',
  'openclaw-status',
  'exec-command',
  'github-client-id',
  'get-bridge-stats',
  'telemetry-report',
  'proactive:get-stats',
  'proactive:set-autonomy',
  'proactive:set-shadow-mode',
  // Capacidades del chat movidas a main (sandbox:true)
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

const SEND_ALLOWLIST = new Set([
  'agent-approval-response',
  'agent-cancel',
  'chat-close',
  'chat-theme-changed',
  'initiative-decision',
  'memory-add-turn',
  'set-provider',
  'chat-llm-cancel',
  'chat-ui-call-result',
]);

const ON_ALLOWLIST = new Set([
  'agent-approval-needed',
  'agent-approval-expired',
  'agent-plan',
  'agent-progress',
  'agent-subagent-progress',
  'agent-token',
  'chat-message',
  'init-theme',
  'initiative',
  'memory-status',
  'model-changed',
  'openclaw-status',
  'proposal-result',
  'resumed-session',
  'update-status',
  'views-changed',
  'workspace-changed',
  'chat-ui-call',
]);

function assertAllowed(kind, channel) {
  const list =
    kind === 'invoke' ? INVOKE_ALLOWLIST : kind === 'send' ? SEND_ALLOWLIST : ON_ALLOWLIST;
  if (typeof channel !== 'string' || !list.has(channel)) {
    throw new Error(`[ipc-whitelist] canal '${String(channel)}' no permitido para ${kind}()`);
  }
}

// ── Caches del estado LLM e índice de comandos ─────────────────────────────
// getActiveProvider/getAvailableProviders (LLMProvider) y getNames/getCommand
// (CommandRegistry) se leen SÍNCRONO en la página (messages.js, input.js). Un
// IPC no puede ser síncrono, así que estos caches se cargan con `invoke` en
// background y `refreshCapabilities` los actualiza de forma explícita cuando
// la página configura el LLM (loadLLMConfig).
let _llmCache = { active: null, providers: [] };
let _cmdIndex = []; // { name, usage, description, completions }

async function _refreshLlmCache() {
  try {
    _llmCache = await ipcRenderer.invoke('chat-llm-state');
  } catch {
    // mantener el último estado conocido
  }
}

async function _refreshCmdIndex() {
  try {
    _cmdIndex = await ipcRenderer.invoke('chat-commands-index');
  } catch {
    // mantener el último índice conocido
  }
}

async function refreshCapabilities() {
  await Promise.all([_refreshLlmCache(), _refreshCmdIndex()]);
}
refreshCapabilities();

// Bridge acotado: la página SOLO recibe las funciones concretas que usa el
// chat, nunca el módulo completo. LLMProvider entero expone _getApiKey/
// _config con las API keys en claro; CommandRegistry entero expone todos los
// comandos y su motor de ejecución. Aquí se envuelve cada método de forma
// explícita y únicamente los que el renderer consume (comprobado contra
// src/chat/*.js). Si el renderer necesita algo nuevo, se añade aquí — no se
// desbloquea el módulo completo.

// TTS: lanza tts_stream.py en main y devuelve el audio (Buffer → Uint8Array).
const ttsStream = (args = {}) => ipcRenderer.invoke('chat-tts-stream', args);

// ASR: transcribe un WAV (PCM 16k mono) en main con Vosk y devuelve el texto.
const asrStream = (args = {}) => ipcRenderer.invoke('chat-asr-stream', args);

contextBridge.exposeInMainWorld('assistant', {
  // IPC con whitelist de canales: el renderer (o un script comprometido) no
  // puede invocar canales internos fuera de la allowlist local.
  invoke: (channel, ...args) => {
    assertAllowed('invoke', channel);
    return ipcRenderer.invoke(channel, ...args);
  },
  send: (channel, ...args) => {
    assertAllowed('send', channel);
    return ipcRenderer.send(channel, ...args);
  },
  on: (channel, listener) => {
    assertAllowed('on', channel);
    const wrapped = (_e, ...args) => listener(_e, ...args);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },

  // Comandos /: el handler corre en main (chat-run-command) con fs/path reales
  // y un ctx donde las funciones de página son stubs de roundtrip (chat-ui-call
  // → chat-ui-call-result). La página solo envía datos serializables (pageData)
  // y sincroniza el sessionHistory devuelto.
  runCommand: (text, pageData = {}) => ipcRenderer.invoke('chat-run-command', { text, pageData }),

  // Roundtrip main → página (ver ipc/chat-handlers.js).
  onUiCall: (handler) => {
    ipcRenderer.on('chat-ui-call', (_e, payload) => {
      handler(payload);
    });
  },
  uiCallResult: (id, result) => {
    ipcRenderer.send('chat-ui-call-result', { id, result });
  },

  // FS / path: antes eran llamadas síncronas del preload; ahora son IPC.
  pathJoin: (...parts) => ipcRenderer.invoke('chat-path-join', parts),
  existsSync: (p) => ipcRenderer.invoke('chat-fs-exists', p),
  statIsDir: (p) => ipcRenderer.invoke('chat-fs-stat-dir', p),
  cwd: () => ipcRenderer.invoke('chat-cwd'),

  // Markdown (marked + DOMPurify) se renderiza AHORA EN LA PÁGINA: con
  // sandbox:true el preload no puede require('marked')/('dompurify'), así que
  // chat.html los carga como <script> locales (UMD expone window.marked /
  // window.DOMPurify) y core.js implementa renderMarkdown (incl. el frame de
  // preview de HTML crudo). Este preload ya no lo expone.
  ttsStream,
  asrStream,

  // Módulos core SOLO como bridge acotado (funciones concretas por dominio),
  // nunca los módulos completos. Los métodos que la página usa en SÍNCRONO
  // (getActiveProvider/getAvailableProviders/getNames/getCommand) leen de los
  // caches de arriba; refreshCapabilities los actualiza tras configurar el LLM.
  LLMProvider: {
    complete: (messages, systemPrompt, opts) =>
      ipcRenderer.invoke('chat-llm-complete', { messages, systemPrompt, opts }),
    cancelSimple: () => ipcRenderer.send('chat-llm-cancel'),
    configure: async (cfg) => {
      try {
        await ipcRenderer.invoke('chat-llm-configure', cfg);
      } catch {
        // config inválida: se deja el estado anterior
      }
      await refreshCapabilities();
    },
    getActiveProvider: () => _llmCache.active,
    getAvailableProviders: () => _llmCache.providers,
  },
  CommandRegistry: {
    getNames: () => _cmdIndex.map((c) => c.name),
    getCommand: (name) => _cmdIndex.find((c) => c.name === name) || null,
  },
  FileResolver: {
    listProjectFiles: (cwd, pattern) => ipcRenderer.invoke('chat-files-list', { cwd, pattern }),
    buildFileContext: (text, cwd) => ipcRenderer.invoke('chat-files-context', { text, cwd }),
  },
  AgentManager: {
    getSystemPrompt: (name) => ipcRenderer.invoke('chat-agents-prompt', { name }),
  },
  // ModelAugmenter se usa como objeto de métodos (augmentModel devuelve
  // objetos planos serializables) y la página necesita listGestures para el
  // mini-avatar.
  ModelAugmenter: {
    augmentModel: (model3Path) => ipcRenderer.invoke('chat-augment-model', model3Path),
    listGestures: (model3Path) => ipcRenderer.invoke('chat-list-gestures', model3Path),
  },

  // Fuente de los módulos core que la página necesita EJECUTAR en su propio
  // mundo (GestureEngine, agentStates): llegan en un lote vía chat-core-sources
  // y la página los carga con su loader mínimo (mismo patrón que el overlay).
  coreSources: () => ipcRenderer.invoke('chat-core-sources'),

  // Refresca los caches de estado LLM + índice de comandos (llamado por la
  // página tras configurar el LLM).
  refreshCapabilities,
});
