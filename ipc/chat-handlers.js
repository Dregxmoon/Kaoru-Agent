// @ts-check
'use strict';

/**
 * chat-handlers.js — sandbox:true del chat (src/chat.html).
 *
 * Con `sandbox:true` el preload del chat (src/chat/preload.js) es fino: ya no
 * puede `require` fs/path/child_process ni los módulos core. Toda la lógica
 * Node que antes vivía ahí se mueve al proceso main y se expone como canales
 * IPC whitelisteados (ver ipc/channel-whitelist.js). El renderer conserva los
 * mismos nombres (LLMProvider, CommandRegistry, FileResolver, ModelAugmenter,
 * renderMarkdown, ttsStream, loader de módulos core).
 *
 * PIEZA CLAVE — roundtrip de funciones de página:
 * `CommandRegistry.execute` recibe un `ctx` con callbacks de la página
 * (openNodes, addMessage, gestureEngine.play, pickWorkspace, ...) que no
 * pueden cruzar el contextBridge (son funciones del renderer). El handler
 * `chat-run-command` construye ese ctx en main donde cada callback es un stub
 * que hace una llamada de ida y vuelta: main envía `chat-ui-call` a la página
 * (con un id), la página ejecuta la función real vía su dispatcher
 * (`assistant.onUiCall`) y responde `chat-ui-call-result`. Así el main puede
 * pedirle a la página abrir modales, reproducir gestos o reenviar IPC
 * whitelisteados, y la página nunca recibe fs/path/child_process crudos.
 *
 * El AbortController del flujo simple (chat sin openclaw) también vive aquí:
 * `chat-llm-complete` crea un controller y `chat-llm-cancel` lo aborta (el
 * renderer no puede pasar su AbortSignal por el contextBridge).
 */

const path = require('path');
const fs = require('fs');
const cp = require('child_process');
const { ipcMain } = require('electron');

const logger = require('../core/observability/Logger.js');
const LLMProvider = require('../core/llm/LLMProvider.js');
const CommandRegistry = require('../core/commands/CommandRegistry.js');
const FileResolver = require('../core/commands/FileResolver.js');
const AgentManager = require('../core/agents/AgentManager.js');
const ModelAugmenter = require('../core/behavior/ModelAugmenter.js');

/** @param {unknown} e @returns {string} */
function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}

// Fuentes de los módulos core que la página necesita EJECUTAR en su propio
// mundo (GestureEngine recibe el objeto Live2D real creado por PIXI, que no
// puede cruzar el contextBridge). Se entregan en un lote: el loader de la
// página hace `require()` síncronos al ejecutarlos, así que necesita todos los
// fuentes disponibles de una vez. ModelAugmenter NO va en el lote: se expone
// como proxy IPC (métodos acotados), igual que en el overlay.
const CORE_SOURCES = {
  GestureLexicon: 'GestureLexicon.js',
  GestureHeuristic: 'GestureHeuristic.js',
  GestureEngine: 'GestureEngine.js',
  agentStates: 'agentStates.js',
};

// Estado del roundtrip main → renderer (chat-ui-call / chat-ui-call-result).
/** @type {(channel: string, payload: any) => void} */
let _sendToChat = () => {};
/** @type {AbortController | null} */
let _simpleAbort = null;
let _uiCallSeq = 0;
/** @type {Map<string, {resolve: (v: any) => void, reject: (e: Error) => void, timer: NodeJS.Timeout}>} */
const _uiCallPending = new Map();

const UI_CALL_TIMEOUT_MS = 30000;

/**
 * Llama a una función de la página por ida y vuelta. Resuelve con el valor
 * que la página devuelva (structured clone) o rechaza si la página no
 * responde a tiempo o si la ventana de chat se destruyó.
 * @param {string} fn
 * @param {unknown[]} args
 * @returns {Promise<any>}
 */
function _uiCall(fn, args) {
  return new Promise((resolve, reject) => {
    const id = `u${++_uiCallSeq}`;
    const timer = setTimeout(() => {
      _uiCallPending.delete(id);
      reject(new Error(`[chat] la página no respondió a '${fn}' (timeout)`));
    }, UI_CALL_TIMEOUT_MS);
    _uiCallPending.set(id, { resolve, reject, timer });
    try {
      _sendToChat('chat-ui-call', { id, fn, args });
    } catch (e) {
      clearTimeout(timer);
      _uiCallPending.delete(id);
      reject(new Error(`[chat] no se pudo enviar '${fn}' a la página: ${errMsg(e)}`));
    }
  });
}

/**
 * Registra los handlers IPC del chat. El `_ctx.sendToChat` (main.js) se usa
 * para el roundtrip chat-ui-call: envía al renderer del chat sin exponerle
 * ningún privilegio (el canal lo filtra la allowlist del preload).
 * @param {any} _ctx Estado compartido del proceso main.
 */
function register(_ctx) {
  _sendToChat = (_ctx && typeof _ctx.sendToChat === 'function')
    ? _ctx.sendToChat
    : () => {};

  const coreBehaviorDir = path.join(__dirname, '..', 'core', 'behavior');

  ipcMain.on('chat-ui-call-result', (_e, payload = {}) => {
    const p = _uiCallPending.get(String(payload.id || ''));
    if (!p) return;
    _uiCallPending.delete(payload.id);
    clearTimeout(p.timer);
    if (payload.result && payload.result.__error) {
      p.reject(new Error(String(payload.result.__error)));
    } else {
      p.resolve(payload.result);
    }
  });

  // ── Comandos / ────────────────────────────────────────────────────────────
  // Construye el ctx de CommandRegistry en main con fs/path/process reales y
  // stubs de roundtrip para las funciones de página. Devuelve el sessionHistory
  // mutado (los comandos hacen push/splice) para que la página sincronice su
  // array al final.

  /**
   * @typedef {Object} ChatPageCtx
   * @property {Array<{role: string, content: string}>} sessionHistory
   * @property {(role: string, content: string) => void} pushToSession
   * @property {typeof LLMProvider} LLMProvider
   * @property {(channel: string, data?: any) => void} sendIPC
   * @property {(...args: any[]) => void} addMessage
   * @property {(...args: any[]) => void} processMessage
   * @property {() => void} openSettings
   * @property {() => void} openSessions
   * @property {() => void} openNodes
   * @property {() => void} hideNodes
   * @property {() => void} openMcp
   * @property {() => void} openPerms
   * @property {() => Promise<any>} pickWorkspace
   * @property {(next: boolean) => void} setTtsMuted
   * @property {() => boolean} isTtsMuted
   * @property {any} gestureConfig
   * @property {{play: (mood: any, opts?: any) => Promise<any>} | null} gestureEngine
   * @property {typeof import('fs')} fs
   * @property {typeof import('path')} path
   * @property {{cwd: () => string}} process
   * @property {{invoke: (...args: any[]) => Promise<any>, send: (...args: any[]) => void}} ipcRenderer
   */
  ipcMain.handle('chat-run-command', async (_e, payload = {}) => {
    /** @type {{text?: string, pageData?: any}} */
    const { text, pageData = {} } = payload;
    const sessionHistory = Array.isArray(pageData.sessionHistory)
      ? pageData.sessionHistory.map((/** @type {any} */ m) => ({ role: m.role, content: m.content }))
      : [];

    /** @type {ChatPageCtx} */
    const ctx = {
      sessionHistory,
      pushToSession: (role, content) => {
        ctx.sessionHistory.push({ role, content });
      },
      LLMProvider,
      sendIPC: (channel, data) => {
        _uiCall('ipc-send', [channel, data]);
      },
      addMessage: (...args) => {
        _uiCall('addMessage', args);
      },
      processMessage: (...args) => {
        _uiCall('processMessage', args);
      },
      openSettings: () => {
        _uiCall('openSettings', []);
      },
      openSessions: () => {
        _uiCall('openSessions', []);
      },
      openNodes: () => {
        _uiCall('openNodes', []);
      },
      hideNodes: () => {
        _uiCall('hideNodes', []);
      },
      openMcp: () => {
        _uiCall('openMcp', []);
      },
      openPerms: () => {
        _uiCall('openPerms', []);
      },
      pickWorkspace: () => _uiCall('pickWorkspace', []),
      setTtsMuted: (next) => {
        _uiCall('setTtsMuted', [!!next]);
      },
      isTtsMuted: () => !!pageData.ttsMuted,
      gestureConfig: pageData.gestureConfig || null,
      gestureEngine: pageData.gestureAvailable
        ? { play: (mood, opts) => _uiCall('gesture-play', [mood, opts || {}]) }
        : null,
      fs,
      path,
      process: { cwd: () => pageData.workspacePath || process.cwd() },
      ipcRenderer: {
        invoke: (...args) => _uiCall('ipc-invoke', args),
        send: (...args) => {
          _uiCall('ipc-send', args);
        },
      },
    };

    let cmdResult;
    try {
      cmdResult = await CommandRegistry.execute(String(text || ''), ctx);
    } catch (e) {
      cmdResult = { error: `Error ejecutando comando: ${errMsg(e)}` };
    }
    return { result: cmdResult, sessionHistory };
  });

  // ── Módulos core (lote) ───────────────────────────────────────────────────
  ipcMain.handle('chat-core-sources', () => {
    /** @type {Record<string, string>} */
    const out = {};
    for (const [name, file] of Object.entries(CORE_SOURCES)) {
      try {
        out[name] = fs.readFileSync(path.join(coreBehaviorDir, file), 'utf8');
      } catch (e) {
        logger.warn('chat-handlers', `[chat] no se pudo leer ${file}:`, errMsg(e));
      }
    }
    return out;
  });

  // ── FS / path (los métodos síncronos que usaba la página) ────────────────
  ipcMain.handle('chat-fs-exists', (_e, p) => {
    try {
      return fs.existsSync(String(p || ''));
    } catch {
      return false;
    }
  });

  ipcMain.handle('chat-fs-stat-dir', (_e, p) => {
    try {
      return fs.statSync(String(p || '')).isDirectory();
    } catch {
      return false;
    }
  });

  ipcMain.handle('chat-cwd', () => process.cwd());

  ipcMain.handle('chat-path-join', (_e, parts) => {
    try {
      return path.join(...(Array.isArray(parts) ? parts.map(String) : []));
    } catch {
      return '';
    }
  });

  // ── ModelAugmenter (mini-avatar del chat) ─────────────────────────────────
  ipcMain.handle('chat-augment-model', (_e, model3Path) => {
    try {
      return ModelAugmenter.augmentModel(model3Path);
    } catch (e) {
      logger.warn('chat-handlers', '[chat] augmentModel falló:', errMsg(e));
      return { settings: null, gestures: { modelName: '', expressions: [], motions: [] } };
    }
  });

  ipcMain.handle('chat-list-gestures', (_e, model3Path) => {
    try {
      return ModelAugmenter.listGestures(model3Path);
    } catch (e) {
      logger.warn('chat-handlers', '[chat] listGestures falló:', errMsg(e));
      return { modelName: '', expressions: [], motions: [] };
    }
  });

  // ── TTS: misma mecánica que el overlay con los parámetros fijos del chat ──
  ipcMain.handle(
    'chat-tts-stream',
    (_e, args = {}) =>
      new Promise((resolve, reject) => {
        if (!args.pythonBin) {
          reject(new Error('pythonBin requerido'));
          return;
        }
        /** @type {Buffer[]} */
        const chunks = [];
        const proc = cp.spawn(args.pythonBin, [
          path.join(__dirname, '..', 'tts_stream.py'),
          '--voice',
          args.voice || 'ja-JP-NanamiNeural',
          '--rate',
          args.rate || '+10%',
          '--pitch',
          args.pitch || '+20Hz',
          '--text',
          args.text || '',
        ]);
        proc.stdout.on('data', (c) => chunks.push(c));
        proc.on('close', (code) => {
          if (code !== 0 || chunks.length === 0) {
            reject(new Error('TTS failed'));
            return;
          }
          resolve(Buffer.concat(chunks));
        });
        proc.on('error', reject);
      })
  );

  // ── LLM: estado + configuración + llamada simple con abort ───────────────
  ipcMain.handle('chat-llm-state', () => ({
    active: LLMProvider.getActiveProvider(),
    providers: LLMProvider.getAvailableProviders(),
  }));

  ipcMain.handle('chat-llm-configure', (_e, cfg) => {
    try {
      LLMProvider.configure(cfg);
    } catch (e) {
      logger.warn('chat-handlers', '[chat] configure falló:', errMsg(e));
    }
    return LLMProvider.getActiveProvider();
  });

  ipcMain.handle('chat-llm-complete', async (_e, { messages, systemPrompt, opts } = {}) => {
    const controller = new AbortController();
    _simpleAbort = controller;
    try {
      const response = await LLMProvider.complete(messages, systemPrompt, {
        ...(opts || {}),
        signal: controller.signal,
      });
      return { response };
    } catch (/** @type {any} */ e) {
      // AbortError se serializa mal por IPC (code/name se pierden), así que el
      // abort se devuelve como marcador explícito que process.js entiende.
      if (e && (e.code === 'ABORTED' || e.name === 'AbortError')) {
        return { aborted: true };
      }
      return { error: errMsg(e) };
    } finally {
      _simpleAbort = null;
    }
  });

  ipcMain.on('chat-llm-cancel', () => {
    if (_simpleAbort) {
      _simpleAbort.abort();
      _simpleAbort = null;
    }
  });

  // ── CommandRegistry (autocompletado de /) ─────────────────────────────────
  ipcMain.handle('chat-commands-names', () => CommandRegistry.getNames());

  ipcMain.handle('chat-commands-index', () =>
    CommandRegistry.getNames().map((name) => {
      const def = CommandRegistry.getCommand(name);
      return {
        name,
        usage: def && def.usage ? def.usage : `/${name}`,
        description: def && def.description ? def.description : '',
        completions: def && def.completions ? def.completions : null,
      };
    })
  );

  // ── FileResolver (@archivo) ───────────────────────────────────────────────
  ipcMain.handle('chat-files-list', (_e, { cwd, pattern } = {}) =>
    FileResolver.listProjectFiles(String(cwd || process.cwd()), String(pattern || ''))
  );

  ipcMain.handle('chat-files-context', (_e, { text, cwd } = {}) =>
    FileResolver.buildFileContext(String(text || ''), String(cwd || process.cwd()))
  );

  // ── AgentManager (system prompt del agente) ───────────────────────────────
  ipcMain.handle('chat-agents-prompt', (_e, { name } = {}) => {
    try {
      return AgentManager.getSystemPrompt(name);
    } catch (e) {
      logger.warn('chat-handlers', '[chat] getSystemPrompt falló:', errMsg(e));
      return null;
    }
  });
}

module.exports = { register };