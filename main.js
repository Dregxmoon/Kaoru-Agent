const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  Tray,
  Menu,
  nativeImage,
  session,
  globalShortcut,
} = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const os = require('os');
const { URL } = require('url');
const { spawnSync } = require('child_process');
const crypto = require('crypto');

const Core = require('./core/Core.js');
const KeychainManager = require('./infrastructure/keychain/KeychainManager.js');
const SafeStorageCrypto = require('./infrastructure/config/SafeStorageCrypto.js');
const { ConfigManager } = require('./core/config/ConfigManager.js');
const { initUpdater } = require('./updater.js');

const { createSharedState } = require('./ipc/state.js');
const logger = require('./core/observability/Logger.js');

app.setName('vtuber-overlay');

// Fase 1: webSecurity pasó a true en todas las ventanas (las libs de
// pixi/live2d ya se sirven locales desde node_modules, sin CDN). El modelo
// Live2D y sus texturas viven en `models/` y se cargan por file:// desde
// una página file:// — sin este switch Chromium bloquea ese XHR por CORS.
app.commandLine.appendSwitch('allow-file-access-from-files');

// G.1: endurecimiento de seguridad. Las ventanas cargan SOLO archivos locales;
// se bloquea toda navegación a URLs remotas, window.open y webviews. Con
// nodeIntegration:false + contextIsolation:true y preloads (src/preload.js y
// src/chat/preload.js) que exponen SOLO una API acotada vía contextBridge, la
// página —incluidos los scripts remotos de PixiJS/Live2D— ya no tiene acceso
// a Node; este lockdown elimina ese vector de entrada de defensa en profundidad.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file:')) {
      event.preventDefault();
      logger.warn('main', `navegación a URL remota bloqueada: ${url}`);
    }
  });
  contents.setWindowOpenHandler(({ url }) => {
    logger.warn('main', `window.open bloqueado: ${url}`);
    return { action: 'deny' };
  });
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
    logger.warn('main', 'webview attach bloqueado');
  });
});

const CRASH_LOG_PATH = path.join(app.getPath('userData'), 'crash.log');

// Guard de reentrancia: logCrash puede llamarse desde un handler de
// excepciones; si el proceso sale con `npm start` (stdout pipeado a grep)
// y grep se cierra, console.error() dispara EPIPE → uncaughtException →
// logCrash → console.error → … bucle infinito que llenó crash.log con GB.
// Este flag corta esa recursión, y además rotamos crash.log para que no
// vuelva a crecer sin límite.
let _crashGuard = false;
let _crashBytes = 0;

const CRASH_LOG_MAX_BYTES = 5 * 1024 * 1024;

// Timeouts y límites (extraídos de magic numbers)
const CRASH_GUARD_COOLDOWN_MS = 1000;
const PYTHON_PROBE_TIMEOUT_MS = 4000;
const OVERLAY_INITIAL_DELAY_MS = 1500;
const MAX_CRASH_RETRIES = 3;
const CRASH_RELOAD_DELAY_MS = 1500;
const CHAT_MIN_WIDTH = 700;
const CHAT_MIN_HEIGHT = 480;
const CONTROL_API_PORT = 3131;
const INITIATIVE_FALLBACK_DELAY_MS = 1000;
const SHUTDOWN_TIMEOUT_MS = 8000;

function _crashSerialize(err) {
  if (err instanceof Error) return err.stack || err.message;
  if (typeof err === 'object' && err !== null) {
    try {
      return JSON.stringify(err);
    } catch (_) {
      return String(err);
    }
  }
  return String(err);
}

function logCrash(label, err) {
  const line = `[${new Date().toISOString()}] ${label}: ${_crashSerialize(err)}\n`;
  try {
    fs.appendFileSync(CRASH_LOG_PATH, line, 'utf-8');
    _crashBytes += line.length;
    if (_crashBytes > CRASH_LOG_MAX_BYTES) {
      _crashBytes = 0;
      try {
        fs.copyFileSync(CRASH_LOG_PATH, CRASH_LOG_PATH + '.1');
        fs.truncateSync(CRASH_LOG_PATH, 0);
      } catch (_) {
        /* best-effort */
      }
    }
  } catch (_) {
    /* best-effort */
  }
  if (_crashGuard) return;
  _crashGuard = true;
  try {
    console.error(line);
  } catch (_) {
    /* pipe cerrado — no relanzar el bucle */
  } finally {
    setTimeout(() => {
      _crashGuard = false;
    }, CRASH_GUARD_COOLDOWN_MS);
  }
}

process.on('uncaughtException', (err) => logCrash('uncaughtException', err));
process.on('unhandledRejection', (reason) => logCrash('unhandledRejection', reason));

// Python executable
function resolvePythonBin() {
  if (process.env.ASISTENTE_PYTHON_BIN && fs.existsSync(process.env.ASISTENTE_PYTHON_BIN)) {
    logger.info(
      'python',
      `usando override ASISTENTE_PYTHON_BIN: ${process.env.ASISTENTE_PYTHON_BIN}`
    );
    return process.env.ASISTENTE_PYTHON_BIN;
  }

  const resolveViaCommand = (cmd, extraArgs = []) => {
    try {
      const res = spawnSync(cmd, [...extraArgs, '-c', 'import sys; print(sys.executable)'], {
        timeout: PYTHON_PROBE_TIMEOUT_MS,
        windowsHide: true,
        encoding: 'utf-8',
      });
      if (res.status === 0) {
        const out = (res.stdout || '').trim().split(/\r?\n/).pop().trim();
        if (out && fs.existsSync(out)) return out;
      }
    } catch (_) {
      /* comando no existe */
    }
    return null;
  };

  if (process.platform === 'win32') {
    const viaLauncher = resolveViaCommand('py', ['-3']);
    if (viaLauncher) {
      logger.info('python', `resuelto vía "py -3": ${viaLauncher}`);
      return viaLauncher;
    }
  }

  const viaPython = resolveViaCommand('python');
  if (viaPython) {
    logger.info('python', `resuelto vía "python" del PATH: ${viaPython}`);
    return viaPython;
  }

  const viaPython3 = resolveViaCommand('python3');
  if (viaPython3) {
    logger.info('python', `resuelto vía "python3" del PATH: ${viaPython3}`);
    return viaPython3;
  }

  if (process.platform === 'win32') {
    const home = os.homedir();
    const searchDirs = [
      path.join(home, 'AppData', 'Local', 'Programs', 'Python'),
      'C:\\Program Files\\',
      'C:\\',
    ];
    for (const dir of searchDirs) {
      try {
        const entries = fs
          .readdirSync(dir)
          .filter((n) => /^Python3\d\d?$/i.test(n))
          .sort()
          .reverse();
        for (const entry of entries) {
          const candidate = path.join(dir, entry, 'python.exe');
          if (fs.existsSync(candidate)) {
            logger.info('python', `encontrado por barrido de carpetas: ${candidate}`);
            return candidate;
          }
        }
      } catch (_) {
        /* carpeta no existe, seguir */
      }
    }
  }

  logger.warn(
    'python',
    'no se encontró ningún intérprete de Python. La voz y el STT local no van a funcionar hasta que instales Python o definas ASISTENTE_PYTHON_BIN.'
  );
  return null;
}

const PYTHON_BIN = resolvePythonBin();

const dotenv = require('dotenv');
const _appRoot = __dirname;
dotenv.config({ path: path.join(_appRoot, '.env'), override: false });

// Fuente de keys activa — para el IPC get-key-source
let _keySource = 'config.json';
let _keySourcesByProvider = {};

// Constantes
const MARGIN = 12;
const WIN_W = 380;
const WIN_H = 580;
const CHAT_W = 900;
const CHAT_H = 600;

// Config persistente — gestionada por ConfigManager (schema + defaults +
// validación + cache). loadConfig/saveConfig se mantienen como API hacia
// el resto del proceso (ipc/config-handlers los usa por su nombre).
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
// Issues de validación de config al arranque: se calculan en whenReady (donde
// el llavero ya está disponible) y se leen en createChatWindow() para mostrar
// la burbuja en la ventana — scopes distintos, por eso el contenedor compartido.
const startupConfigState = { issues: [] };

const configManager = new ConfigManager(CONFIG_PATH);

function loadConfig() {
  return configManager.load();
}

// Valor con el que se sustituyen las API keys cuando se entregan al renderer.
// El renderer solo necesita saber si hay key (hasKey) y mostrar el prefill del
// input de settings; la key real nunca sale del main process.
const MASKED_KEY_VALUE = '***';

// Devuelve una copia de la config con TODAS las API keys redactadas
// (cfg.llm.apiKeys y cfg.llm.providers[*].apiKey).
function redactKeys(cfg) {
  const copy = JSON.parse(JSON.stringify(cfg));
  const llm = copy.llm;
  if (!llm) return copy;
  if (llm.apiKeys && typeof llm.apiKeys === 'object') {
    for (const k of Object.keys(llm.apiKeys)) {
      if (llm.apiKeys[k]) llm.apiKeys[k] = MASKED_KEY_VALUE;
    }
  }
  if (llm.providers && typeof llm.providers === 'object') {
    for (const p of Object.values(llm.providers)) {
      if (p && p.apiKey) p.apiKey = MASKED_KEY_VALUE;
    }
  }
  return copy;
}

function loadEffectiveConfig() {
  const cfg = loadConfig();

  if (!cfg.llm) cfg.llm = {};
  if (!cfg.llm.apiKeys) cfg.llm.apiKeys = {};
  if (!cfg.llm.providers) cfg.llm.providers = {};

  // Descifrar keys que estén en formato safeStorage (enc:v1:...) — vienen
  // de config.json cuando KeychainManager no estaba disponible al guardar.
  // Keys de env vars y keychain ya están en texto plano.
  for (const [k, v] of Object.entries(cfg.llm.apiKeys)) {
    if (v && typeof v === 'string') {
      const decrypted = SafeStorageCrypto.decrypt(v);
      if (decrypted !== v) {
        cfg.llm.apiKeys[k] = decrypted;
        _keySourcesByProvider[k] = 'config.json (cifrado)';
      }
    }
  }

  for (const envKey of Object.keys(process.env)) {
    const match = envKey.match(/^LLM_KEY_(.+)$/);
    if (!match) continue;
    const providerId = match[1].toLowerCase();
    const val = process.env[envKey];
    if (val && val.trim()) {
      cfg.llm.apiKeys[providerId] = val.trim();
      if (!cfg.llm.providers[providerId]) cfg.llm.providers[providerId] = {};
      cfg.llm.providers[providerId].apiKey = val.trim();
      _keySourcesByProvider[providerId] = '.env / variable de entorno';
    }
  }

  const builtinProviders = [
    'groq',
    'gemini',
    'openai',
    'anthropic',
    'xai',
    'nvidia',
    'huggingface',
    'deepseek',
  ];
  const keychainKeys = KeychainManager.getAllKeys(builtinProviders);
  for (const [k, v] of Object.entries(keychainKeys)) {
    if (v) {
      cfg.llm.apiKeys[k] = v;
      if (!cfg.llm.providers[k]) cfg.llm.providers[k] = {};
      cfg.llm.providers[k].apiKey = v;
      _keySourcesByProvider[k] = 'llavero del sistema';
    }
  }

  for (const provider of builtinProviders) {
    if (!_keySourcesByProvider[provider]) _keySourcesByProvider[provider] = 'config.json';
  }

  const uniqueSources = [...new Set(Object.values(_keySourcesByProvider))];
  _keySource = uniqueSources.length === 1 ? uniqueSources[0] : 'mixto';

  return cfg;
}

function saveConfig(data) {
  const result = configManager.save(data);
  for (const err of result.errors) logger.info('config', `error guardando config.json: ${err}`);
}

function migratePlaintextApiKeysToKeychain() {
  const cfg = loadConfig();
  if (!KeychainManager.isAvailable()) {
    logger.info('config', 'llavero del sistema no disponible — keys de LLM en config.json');
    return;
  }
  const llm = cfg.llm || {};
  const candidates = { ...(llm.apiKeys || {}) };
  for (const [id, p] of Object.entries(llm.providers || {})) {
    if (p && p.apiKey && p.apiKey.trim()) candidates[id] = p.apiKey;
  }
  if (Object.keys(candidates).length === 0) return;

  const migrated = [];
  let toStrip = false;
  for (const [id, key] of Object.entries(candidates)) {
    if (!key || !key.trim()) continue;
    // Descifrar si estaba en formato safeStorage antes de migrar al keychain.
    const plainKey = SafeStorageCrypto.decrypt(key);
    if (KeychainManager.getKey(id)) {
      toStrip = true;
    } else if (KeychainManager.setKey(id, plainKey.trim())) {
      migrated.push(id);
      toStrip = true;
    }
  }
  if (!toStrip) return;

  const newCfg = { ...cfg };
  newCfg.llm = { ...(cfg.llm || {}) };
  delete newCfg.llm.apiKeys;
  newCfg.llm.providers = {};
  for (const [id, p] of Object.entries(llm.providers || {})) {
    const clean = { ...p };
    delete clean.apiKey;
    newCfg.llm.providers[id] = clean;
  }
  try {
    configManager.save(newCfg);
    logger.info(
      'config',
      `keys LLM migradas al llavero y quitadas de config.json: ${migrated.join(', ')}`
    );
  } catch (e) {
    logger.info('config', `error persistiendo config sin keys: ${e.message}`);
  }
}

function ensureLLMConfig() {
  const cfg = loadConfig();
  if (!cfg.llm) {
    saveConfig({
      llm: {
        primary: 'groq',
        fallback: ['gemini'],
        apiKeys: {},
        providers: {},
      },
    });
    logger.info('config', 'bloque llm inicializado');
  }
}

// Estado global compartido
const savedConfig = loadConfig();
migratePlaintextApiKeysToKeychain();

const S = createSharedState({
  chatTheme: savedConfig.chatTheme ?? 'dark',
  activeModelId: savedConfig.activeModel || 'March 7th',
});

const maskedConfig = JSON.parse(JSON.stringify(savedConfig));
if (maskedConfig.llm?.apiKeys) {
  for (const k of Object.keys(maskedConfig.llm.apiKeys)) {
    if (maskedConfig.llm.apiKeys[k]) maskedConfig.llm.apiKeys[k] = '***';
  }
}
logger.info('asistente', `config cargada: ${maskedConfig}`);

if (process.platform === 'linux') app.commandLine.appendSwitch('enable-transparent-visuals');

const VIEW_NAMES = ['full', 'half', 'head'];

// Posiciones
function getBottomRightBounds() {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: Math.round(workArea.x + workArea.width - WIN_W - MARGIN),
    y: Math.round(workArea.y + workArea.height - WIN_H - MARGIN),
    width: WIN_W,
    height: WIN_H,
  };
}

function getChatBounds() {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: Math.round(workArea.x + (workArea.width - CHAT_W) / 2),
    y: Math.round(workArea.y + (workArea.height - CHAT_H) / 2),
    width: CHAT_W,
    height: CHAT_H,
  };
}

// Click-through
function setClickThrough(enabled) {
  S.isClickThrough = enabled;
  if (!S.mainWindow || S.mainWindow.isDestroyed()) return;
  S.mainWindow.setIgnoreMouseEvents(enabled, { forward: true });
  if (S.tray) S.tray.setContextMenu(buildTrayMenu());
}

function sendSpeak(text, emotion) {
  if (!S.mainWindow || S.mainWindow.isDestroyed()) return;
  S.mainWindow.webContents.send('speak', emotion ? { text, emotion } : text);
}

function sendOverlayGesture(mood, meta = {}) {
  if (!S.mainWindow || S.mainWindow.isDestroyed()) return;
  S.mainWindow.webContents.send('gesture', { mood, ...meta });
}

function sendToChat(channel, payload) {
  if (!S.chatWindow || S.chatWindow.isDestroyed()) return;
  S.chatWindow.webContents.send(channel, payload);
}

// ── Gestos espontáneos (módulo independiente) ────────────────────────────────
// Traduce eventos del sistema a moods y los difunde a AMBAS ventanas
// (overlay + mini-avatar del chat) para que Kaoru reaccione viva en las dos.
const { GestureEvents } = require('./core/behavior/GestureEvents.js');
const gestureEvents = new GestureEvents({
  send: (mood, meta = {}) => {
    sendOverlayGesture(mood, meta);
    sendToChat('gesture', { mood, source: meta.source || 'system' });
  },
});

ipcMain.handle('gesture-config', () => savedConfig.gestures || null);

// /gestos mapa: persistir mapping mood → gesto y aplicarlo en vivo en
// ambas ventanas (overlay + mini-avatar del chat).
ipcMain.handle('gesture-mappings-get', () => savedConfig.gestures?.mappings || {});
ipcMain.handle('gesture-mappings-set', (_e, { mood, gesture } = {}) => {
  const { hasMood } = require('./core/behavior/GestureLexicon.js');
  const m = String(mood || '').trim();
  const g = String(gesture || '').trim();
  if (!hasMood(m)) return { ok: false, error: `mood inválido: "${m}". Ver moods con /gestos mapa` };
  if (!g) return { ok: false, error: 'falta el nombre del gesto' };

  const current = savedConfig.gestures || {};
  const mappings = { ...(current.mappings || {}), [m]: g };
  saveConfig({ gestures: { ...current, mappings } });
  savedConfig.gestures = { ...current, mappings };

  // Aplicación en vivo (los engines tienen setMappings()).
  if (S.mainWindow && !S.mainWindow.isDestroyed()) {
    S.mainWindow.webContents.send('gesture-mappings', mappings);
  }
  sendToChat('gesture-mappings', mappings);
  logger.info('main', `[gestos] mapping persistido: ${m} → ${g}`);
  return { ok: true, mood: m, gesture: g };
});
ipcMain.handle('gesture-mappings-remove', (_e, { mood } = {}) => {
  const current = savedConfig.gestures || {};
  const mappings = { ...(current.mappings || {}) };
  delete mappings[String(mood || '')];
  saveConfig({ gestures: { ...current, mappings } });
  savedConfig.gestures = { ...current, mappings };
  if (S.mainWindow && !S.mainWindow.isDestroyed()) {
    S.mainWindow.webContents.send('gesture-mappings', mappings);
  }
  sendToChat('gesture-mappings', mappings);
  return { ok: true };
});

// Contexto compartido para los handlers
const serializeResult = (result) => {
  const IPC_RESULT_LIMIT = 512 * 1024;
  if (!result) return null;
  if (typeof result === 'string') return result;
  if (typeof result === 'object') {
    try {
      const str = JSON.stringify(result);
      if (str.length > IPC_RESULT_LIMIT) {
        logger.warn('main', `resultado muy grande (${str.length} chars), truncando para IPC`);
        return {
          _truncated: true,
          preview: str.slice(0, IPC_RESULT_LIMIT),
          totalLength: str.length,
        };
      }
      return result;
    } catch {
      return String(result);
    }
  }
  return result;
};

const ctx = {
  S,
  savedConfig,
  loadConfig,
  loadEffectiveConfig,
  redactKeys,
  saveConfig,
  Core,
  KeychainManager,
  PYTHON_BIN,
  serializeResult,
  getBottomRightBounds,
  setClickThrough,
  sendSpeak,
  sendToChat,
  gestureEvents,
  sendOverlayGesture,
  keySource: () => _keySource,
  keySourcesByProvider: () => _keySourcesByProvider,
};

// Filtro de console-message compartido por overlay y chat: silencia logs de
// PixiJS/Live2D/Electron que ensucian la consola sin valor diagnóstico.
function _createConsoleMessageFilter(label) {
  return (_e, _level, msg) => {
    if (
      msg.includes('PixiJS') ||
      msg.includes('Live2D Cubism Core') ||
      msg.includes('CubismFramework.') ||
      msg.startsWith(' %c') ||
      msg.includes('Electron Security Warning')
    )
      return;
    console.log(`[${label}] ${msg}`);
  };
}

// Ventana overlay
function createWindow() {
  const mode = ctx.getModelViewMode(S.activeModelId);
  S.currentView =
    mode === 'random' ? VIEW_NAMES[Math.floor(Math.random() * VIEW_NAMES.length)] : mode;

  S.mainWindow = new BrowserWindow({
    ...getBottomRightBounds(),
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    thickFrame: false,
    focusable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'src/preload.js'),
      nodeIntegration: false,
      contextIsolation: true, // sandbox: la página (y los CDN) no ven Node
      webSecurity: true, // Fase 1: libs (pixi/live2d) ya se sirven locales; CSP plena
      sandbox: true, // Fase 2 ítem 6: preload fino (solo contextBridge+ipcRenderer);
      // la lógica Node del overlay vive en ipc/overlay-handlers.js
      webviewTag: false,
      allowRunningInsecureContent: false,
    },
  });

  S.mainWindow.setAlwaysOnTop(true, 'screen-saver');
  S.mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  S.mainWindow.setMenuBarVisibility(false);
  S.mainWindow.setIgnoreMouseEvents(true, { forward: true });
  S.mainWindow.webContents.on('console-message', _createConsoleMessageFilter('overlay'));
  S.mainWindow.loadFile(path.join(__dirname, 'src/index.html'));
  S.mainWindow.webContents.once('did-finish-load', () => {
    setTimeout(
      () => S.mainWindow.webContents.send('set-view', S.currentView),
      OVERLAY_INITIAL_DELAY_MS
    );
  });
  attachCrashWatchdog(S.mainWindow, 'overlay');
}

// Watchdog de renderer: si el proceso de una ventana muere (crash/OOM), se
// registra en crash.log y la ventana se recarga sola (con tope para no
// entrar en bucle infinito de reinicio).
function attachCrashWatchdog(win, label) {
  let crashes = 0;
  win.webContents.on('render-process-gone', (_e, details) => {
    crashes++;
    logCrash(`render-process-gone [${label}]`, {
      reason: details.reason,
      exitCode: details.exitCode,
    });
    if (crashes > MAX_CRASH_RETRIES) {
      logCrash(`render-process-gone [${label}]`, 'demasiados crashes — sin auto-reload');
      return;
    }
    setTimeout(() => {
      if (!win.isDestroyed()) {
        try {
          win.reload();
        } catch (e) {
          logCrash(`reload [${label}]`, e);
        }
      }
    }, CRASH_RELOAD_DELAY_MS);
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    logCrash(`did-fail-load [${label}]`, `${code}: ${desc}`);
  });
}

// Ventana de chat
function createChatWindow() {
  if (S.chatWindow && !S.chatWindow.isDestroyed()) {
    if (!S.chatWindow.isVisible()) {
      S.chatWindow.show();
      S.chatWindow.focus();
      if (S.mainWindow && !S.mainWindow.isDestroyed()) S.mainWindow.hide();
      Core.setChatOpen(true);
      if (S.tray) S.tray.setContextMenu(buildTrayMenu());
    } else {
      S.chatWindow.focus();
    }
    return;
  }

  S.chatWindow = new BrowserWindow({
    ...getChatBounds(),
    frame: false,
    transparent: false,
    backgroundColor: '#0d0f14',
    resizable: true,
    minWidth: CHAT_MIN_WIDTH,
    minHeight: CHAT_MIN_HEIGHT,
    skipTaskbar: false,
    alwaysOnTop: false,
    hasShadow: true,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'src/chat/preload.js'),
      nodeIntegration: false,
      contextIsolation: true, // sandbox: la página (y los CDN) no ven Node
      webSecurity: true,
      sandbox: true, // preload fino (solo contextBridge+ipcRenderer); la lógica
      // Node del chat vive en ipc/chat-handlers.js
      webviewTag: false,
      allowRunningInsecureContent: false,
    },
  });

  S.chatWindow.setMenuBarVisibility(false);
  S.chatWindow.loadFile(path.join(__dirname, 'src/chat.html'));
  attachCrashWatchdog(S.chatWindow, 'chat');
  S.chatWindow.webContents.on('console-message', _createConsoleMessageFilter('chat'));

  if (S.mainWindow && !S.mainWindow.isDestroyed()) S.mainWindow.hide();

  const sessionPromise = Core.startSession().catch((e) => {
    logger.error('session', `error: ${e.message}`);
    return null;
  });
  Core.setChatOpen(true);

  S.chatWindow.webContents.once('did-finish-load', () => {
    S.chatWindow.webContents.send('init-theme', S.chatTheme);

    const graph = Core.getGraph();
    const usingFallback = graph?.usingFallback ?? false;
    S.chatWindow.webContents.send('memory-status', {
      usingFallback,
      reason: usingFallback ? graph.fallbackReason || null : null,
    });

    // Validación temprana de config: mostrar issues EN LA VENTANA (burbuja
    // visual, fuera del historial que ve el LLM) antes del primer mensaje.
    for (const issue of startupConfigState.issues) {
      S.chatWindow.webContents.send('startup-notice', { message: issue.message });
      if (!S.mainWindow || S.mainWindow.isDestroyed()) continue;
      S.mainWindow.webContents.send('speak', issue.message.replace(/\*\*/g, '').slice(0, 220));
    }

    sessionPromise
      .then((result) => {
        if (
          result?.resumed &&
          result.history?.length &&
          S.chatWindow &&
          !S.chatWindow.isDestroyed()
        ) {
          sendToChat('resumed-session', { history: result.history });
        }
      })
      .catch(() => {});
  });

  S.chatWindow.on('closed', () => {
    try {
      require('./ipc/openclaw-handlers.js').resetSessionApprovals();
    } catch (_) {}
    Core.closeSession().catch((e) => logger.error('session', `close error: ${e.message}`));
    Core.setChatOpen(false);
    S.chatWindow = null;
    if (S.mainWindow && !S.mainWindow.isDestroyed()) S.mainWindow.show();
    if (S.tray) S.tray.setContextMenu(buildTrayMenu());
  });

  if (S.tray) S.tray.setContextMenu(buildTrayMenu());
}

function toggleChatWindow() {
  if (!S.chatWindow || S.chatWindow.isDestroyed()) {
    createChatWindow();
  } else if (S.chatWindow.isVisible()) {
    S.chatWindow.hide();
    if (S.mainWindow && !S.mainWindow.isDestroyed()) S.mainWindow.show();
    Core.setChatOpen(false);
    if (S.tray) S.tray.setContextMenu(buildTrayMenu());
  } else {
    S.chatWindow.show();
    S.chatWindow.focus();
    if (S.mainWindow && !S.mainWindow.isDestroyed()) S.mainWindow.hide();
    Core.setChatOpen(true);
    if (S.tray) S.tray.setContextMenu(buildTrayMenu());
  }
}

// Tray
function buildTrayMenu() {
  const chatOpen = S.chatWindow && !S.chatWindow.isDestroyed() && S.chatWindow.isVisible();
  const mode = ctx.getModelViewMode(S.activeModelId);
  return Menu.buildFromTemplate([
    { label: chatOpen ? 'Cerrar chat' : 'Abrir chat', click: toggleChatWindow },
    { type: 'separator' },
    {
      label: S.isClickThrough ? 'Bloquear (mover overlay)' : 'Pasar clics',
      click: () => setClickThrough(!S.isClickThrough),
    },
    { type: 'separator' },
    { label: `${mode === 'full' ? '> ' : ''}Cuerpo completo`, click: () => applyViewMode('full') },
    { label: `${mode === 'half' ? '> ' : ''}Medio cuerpo`, click: () => applyViewMode('half') },
    { label: `${mode === 'head' ? '> ' : ''}Solo cabeza`, click: () => applyViewMode('head') },
    { label: `${mode === 'random' ? '> ' : ''}Aleatorio`, click: () => applyViewMode('random') },
    { type: 'separator' },
    {
      label: 'Prueba de voz',
      submenu: [
        { label: 'Saludo', click: () => sendSpeak('Hola! Estoy aqui para ayudarte!') },
        { label: 'Emocion sad', click: () => sendSpeak('Lo siento, hubo un error.', 'sad') },
        { label: 'Excited', click: () => sendSpeak('Perfecto, todo salio bien!', 'excited') },
      ],
    },
    { type: 'separator' },
    {
      label: 'Volver a esquina',
      click: () => {
        S.userHasMoved = false;
        S.mainWindow.setBounds(getBottomRightBounds());
      },
    },
    {
      label: 'Mostrar / ocultar overlay',
      click: () => (S.mainWindow.isVisible() ? S.mainWindow.hide() : S.mainWindow.show()),
    },
    { type: 'separator' },
    { label: 'Cerrar todo', click: () => app.quit() },
  ]);
}

function createTray() {
  S.tray = new Tray(nativeImage.createEmpty());
  S.tray.setToolTip('Asistente personal');
  S.tray.setContextMenu(buildTrayMenu());
}

// Modo de vista del modelo (delegado al handler de ventana)
function applyViewMode(mode, { broadcast = true } = {}) {
  const VIEW_MODES = ['full', 'half', 'head', 'random'];
  if (!VIEW_MODES.includes(mode)) return { error: `Modo inválido: ${mode}` };
  ctx.saveModelViewMode(S.activeModelId, mode);
  if (mode !== 'random') {
    S.currentView = mode;
    if (S.mainWindow && !S.mainWindow.isDestroyed())
      S.mainWindow.webContents.send('set-view', mode);
  }
  if (broadcast) ctx.broadcastViewsChanged();
  if (S.tray) S.tray.setContextMenu(buildTrayMenu());
  return { ok: true, ...ctx.currentViewsState() };
}

// Registrar handlers IPC
ctx.buildTrayMenu = buildTrayMenu;
ctx.toggleChatWindow = toggleChatWindow;
ctx.applyViewMode = applyViewMode;

require('./ipc/window-model-handlers.js').register(ctx);
require('./ipc/memory-handlers.js').register(ctx);
require('./ipc/config-handlers.js').register(ctx);
require('./ipc/init-vectors-handlers.js').register(ctx);
require('./ipc/openclaw-handlers.js').register(ctx);
require('./ipc/mcp-handlers.js').register(ctx);
require('./ipc/github-handlers.js').register(ctx);
require('./ipc/security-handlers.js').register(ctx);
require('./ipc/proactive-handlers.js').register(ctx);
require('./ipc/overlay-handlers.js').register(ctx);
require('./ipc/chat-handlers.js').register(ctx);
require('./ipc/intentions-handlers.js').register();

// Servidor HTTP local
const VALID_EMOTIONS = ['happy', 'excited', 'sad', 'tired', 'gentle', 'default'];
const VALID_VIEWS = ['full', 'half', 'head', 'random'];

const CONTROL_API_TOKEN = crypto.randomBytes(24).toString('hex');

// C2 (seguridad): el token NO se incrusta en el texto de /help. Antes HELP_TEXT
// viajaba con ?token= literal y la ruta /help se servía SIN autenticación —
// cualquier página web que el usuario visitara podía leer localhost:3131/help
// (sin check de Origin en esa ruta) y robar el token de control. Ahora:
//   - /help exige autenticación igual que el resto de rutas.
//   - El help con ejemplos autenticados se imprime SOLO en consola (dueño del
//     proceso) al arrancar.
//   - El check de Origin/Referer de _controlAuthOk aplica a todas las rutas.
const HELP_TEXT = `
  Asistente personal — Control API (puerto 3131)
  Autenticación: incluye ?token=<TOKEN> en CADA request (el token se imprime
  en la consola al arrancar la app, o consúltalo en infrastructure/keychain).

  Endpoints (todos requieren token):
    GET /speak?text=<texto>[&emotion=<emotion>]
    GET /view?v=<full|half|head|random>
    GET /chat?action=<open|close|toggle>
    GET /workspace?path=<ruta>
    GET /telemetry/report
    GET /telemetry/stats
    GET /debug/git-scan
    GET /debug/proposal?accept=0|1
    GET /debug/lsp-scan
    GET /help
`;

const HELP_TEXT_PRIVATE = `
  Asistente personal — Control API (puerto 3131)
  Token: ${CONTROL_API_TOKEN}

  curl "http://localhost:3131/speak?text=hola&token=${CONTROL_API_TOKEN}"
  curl "http://localhost:3131/speak?text=lo+siento&emotion=sad&token=${CONTROL_API_TOKEN}"
  curl "http://localhost:3131/view?v=half&token=${CONTROL_API_TOKEN}"
  curl "http://localhost:3131/chat?action=open&token=${CONTROL_API_TOKEN}"   # abre el chat
  curl "http://localhost:3131/chat?action=close&token=${CONTROL_API_TOKEN}"  # cierra y sale
  curl "http://localhost:3131/workspace?path=/ruta/al/proyecto&token=${CONTROL_API_TOKEN}"
  curl "http://localhost:3131/telemetry/report&token=${CONTROL_API_TOKEN}"
  curl "http://localhost:3131/telemetry/stats&token=${CONTROL_API_TOKEN}"
`;

function _controlAuthOk(req, url) {
  const provided = url.searchParams.get('token') || '';
  const bufA = Buffer.from(provided, 'utf8');
  const bufB = Buffer.from(CONTROL_API_TOKEN, 'utf8');
  const tokenOk = bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
  if (!tokenOk) return false;

  const origin = req.headers['origin'] || req.headers['referer'] || '';
  if (origin && !/^(https?:\/\/)?(localhost|127\.0\.0\.1)([:/]|$)/i.test(origin)) {
    return false;
  }
  return true;
}

function startControlServer() {
  // Escribir HELP_TEXT_PRIVATE a archivo con permisos restrictivos en vez de
  // imprimirlo a stdout — el token no debe quedar en logs de proceso/terminal.
  const helpFilePath = path.join(app.getPath('userData'), 'control-api-help.txt');
  try {
    fs.writeFileSync(helpFilePath, HELP_TEXT_PRIVATE, { mode: 0o600 });
  } catch {
    // Si falla la escritura, solo loguear sin exponer el token.
    logger.info('control', 'no se pudo escribir control-api-help.txt');
  }
  const maskedToken = '****' + CONTROL_API_TOKEN.slice(-4);
  logger.info('control', `Token: ${maskedToken} — comandos completos en ${helpFilePath}`);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost:3131');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    // Todas las rutas (incluida /help) exigen token válido + Origin local.
    if (!_controlAuthOk(req, url)) {
      res.writeHead(401);
      res.end('unauthorized — falta o es inválido ?token=');
      return;
    }
    if (url.pathname === '/speak') {
      const text = url.searchParams.get('text') || '';
      const rawEmo = (url.searchParams.get('emotion') || '').toLowerCase();
      const emotion = VALID_EMOTIONS.includes(rawEmo) ? rawEmo : null;
      if (!text) {
        res.writeHead(400);
        res.end('falta ?text=');
        return;
      }
      sendSpeak(text, emotion);
      sendToChat('chat-message', text);
      res.writeHead(200);
      res.end(`ok: ${text}`);
      return;
    }
    if (url.pathname === '/view') {
      const v = (url.searchParams.get('v') || '').toLowerCase();
      if (!VALID_VIEWS.includes(v)) {
        res.writeHead(400);
        res.end(`validos: ${VALID_VIEWS.join(', ')}`);
        return;
      }
      applyViewMode(v);
      res.writeHead(200);
      res.end(`ok: ${v}`);
      return;
    }
    if (url.pathname === '/chat') {
      const action = (url.searchParams.get('action') || '').toLowerCase();
      if (action === 'open') createChatWindow();
      else if (action === 'close') {
        logger.info('asistente', 'Control API: cerrando asistente');
        app.quit();
      } else toggleChatWindow();
      res.writeHead(200);
      res.end(`ok: chat ${action || 'toggled'}`);
      return;
    }
    if (url.pathname === '/workspace') {
      const p = url.searchParams.get('path');
      if (!p) {
        res.writeHead(400);
        res.end('falta ?path=');
        return;
      }
      Core.setActiveWorkspace(p)
        .then((result) => {
          res.writeHead(result.ok ? 200 : 400);
          res.end(result.ok ? `ok: workspace -> ${result.path}` : `error: ${result.error}`);
        })
        .catch((err) => {
          res.writeHead(500);
          res.end(`error: ${err.message}`);
        });
      return;
    }
    if (url.pathname === '/debug/git-scan') {
      Core.debugGitScan()
        .then((r) => {
          res.writeHead(r.ok ? 200 : 500);
          res.end(
            r.ok
              ? `ok: scan git realizado\n${JSON.stringify(r.stats, null, 2)}`
              : `error: ${r.error}`
          );
        })
        .catch((err) => {
          res.writeHead(500);
          res.end(`error: ${err.message}`);
        });
      return;
    }
    if (url.pathname === '/debug/proposal') {
      const accept = url.searchParams.get('accept') === '1';
      const r = Core.debugResolveLastProposal(accept);
      res.writeHead(r.ok ? 200 : 400);
      res.end(
        r.ok
          ? `ok: propuesta ${accept ? 'aceptada' : 'rechazada'} (${r.proposal.type})`
          : `error: ${r.error}`
      );
      return;
    }
    if (url.pathname === '/debug/lsp-scan') {
      Core.debugLSPScan()
        .then((r) => {
          res.writeHead(r.ok ? 200 : 500);
          res.end(
            r.ok
              ? `ok: scan LSP realizado\n${JSON.stringify(r.stats, null, 2)}`
              : `error: ${r.error}`
          );
        })
        .catch((err) => {
          res.writeHead(500);
          res.end(`error: ${err.message}`);
        });
      return;
    }
    if (url.pathname === '/telemetry/report') {
      const r = Core.getTelemetryReport();
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.writeHead(r.ok ? 200 : 500);
      res.end(JSON.stringify(r, null, 2));
      return;
    }
    if (url.pathname === '/telemetry/stats') {
      const s = Core.getTelemetryStats();
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.writeHead(s ? 200 : 500);
      res.end(JSON.stringify(s, null, 2));
      return;
    }
    res.writeHead(200);
    res.end(HELP_TEXT);
  });
  server.listen(CONTROL_API_PORT, '127.0.0.1', () =>
    logger.info('asistente', `API lista → http://localhost:${CONTROL_API_PORT}/help`)
  );
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') logger.info('asistente', `puerto ${CONTROL_API_PORT} ocupado.`);
  });
}

// Auto-init
async function _autoInitProject() {
  try {
    // El workspace sigue el directorio de la app (o ASISTENTE_WORKSPACE);
    // ya no se impone el activeWorkspace persistido de config.json.
    const workspace = process.env.ASISTENTE_WORKSPACE;
    const root = workspace || app.getAppPath() || process.cwd();
    if (!root || !fs.existsSync(root)) return;

    let summary = `Proyecto activo: ${root}`;
    const pkgPath = path.join(root, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg.name) summary += `\nNombre: ${pkg.name}`;
        if (pkg.description) summary += `\nDescripción: ${pkg.description}`;
      } catch (_) {
        /* no es un proyecto npm, ignorar */
      }
    }

    const label = `Proyecto: ${path.basename(root)}`;

    const graph = Core.getGraph();
    if (graph?.isReady && graph._db) {
      const existing = graph.queryNodes({ type: 'Project', search: label, limit: 1 });
      if (existing && existing.length > 0) {
        try {
          graph.updateNode(existing[0].id, { content: summary, importance: 0.9 });
          return;
        } catch (_) {
          /* si falla la actualización, cae a crear de nuevo */
        }
      }
    }

    Core.storeFact({
      type: 'Project',
      label,
      content: summary,
      importance: 0.9,
      tags: ['workspace', 'auto-init'],
    });
  } catch (e) {
    logger.warn('asistente', `auto-init de proyecto falló: ${e.message}`);
  }
}

// App init
app.whenReady().then(() => {
  const userDataPath = app.getPath('userData');
  dotenv.config({ path: path.join(userDataPath, '.env'), override: true });

  ensureLLMConfig();

  const keychainAvail = KeychainManager.isAvailable();
  logger.info(
    'config',
    `fuente de keys: ${_keySource} | llavero del SO: ${keychainAvail ? 'disponible' : 'no disponible'}`
  );

  Core.init(app);

  if (global.__mcpOAuthSetup) global.__mcpOAuthSetup(app);

  // ── Validación temprana de config.json ────────────────────────────────────
  // ConfigManager.load() degrada en silencio (ausente/corrupto → defaults),
  // así que sin esto el usuario no se entera hasta que su primer mensaje
  // falla con un críptico 'Sin API key'. Se calcula acá (keychain ya
  // conocido) y se entrega en el did-finish-load del chat, antes de que el
  // usuario pueda escribir.
  startupConfigState.issues = [];
  try {
    const { validateStartupConfig } = require('./core/config/startupCheck.js');
    const keychainKeys =
      keychainAvail && typeof KeychainManager.getAllKeys === 'function'
        ? KeychainManager.getAllKeys(['groq', 'gemini', 'openai', 'nvidia', 'anthropic'])
        : {};
    const keychainHasKeys = Object.values(keychainKeys).some((v) => !!v);
    const check = validateStartupConfig({
      configPath: CONFIG_PATH,
      examplePath: path.join(path.dirname(CONFIG_PATH), '..', 'config.example.json'),
      keychainHasKeys,
    });
    startupConfigState.issues = check.issues || [];
    for (const issue of startupConfigState.issues) {
      logger.warn('main', `[config] ${issue.type}: ${issue.message.replace(/\n/g, ' ')}`);
    }
    if (startupConfigState.issues.length === 0) {
      logger.info('main', '[config] validación de arranque OK');
    }
  } catch (e) {
    logger.warn('main', `[config] validación temprana falló (no bloquea): ${e.message}`);
  }

  Core.getEventBus().on('openclaw:available', (payload) => {
    sendToChat('openclaw-status', payload);
  });

  Core.getEventBus().on('workspace:changed', (payload) => {
    sendToChat('workspace-changed', payload);
  });

  Core.onInitiative((payload) => {
    // Mood según tipo de iniciativa: un error LSP sorprende, lo demás entusiasma.
    gestureEvents.emit(payload.reason === 'lsp_error' ? 'lsp-error' : 'proactive', {
      reason: payload.reason,
    });
    const chatVisible = S.chatWindow && !S.chatWindow.isDestroyed() && S.chatWindow.isVisible();
    if (chatVisible) {
      sendToChat('initiative', payload);
      return;
    }
    if (payload.openChat) {
      createChatWindow();
      // Guard idempotente: la ventana puede cargar antes o después del timeout,
      // pero la iniciativa se entrega UNA sola vez (evita bubble duplicado).
      let sent = false;
      const sendWhenReady = () => {
        if (sent || !S.chatWindow || S.chatWindow.isDestroyed()) return;
        sent = true;
        sendToChat('initiative', payload);
      };
      if (S.chatWindow && !S.chatWindow.isDestroyed()) {
        S.chatWindow.webContents.once('did-finish-load', sendWhenReady);
        setTimeout(sendWhenReady, INITIATIVE_FALLBACK_DELAY_MS);
      }
    } else {
      if (S.mainWindow && !S.mainWindow.isDestroyed()) {
        S.mainWindow.webContents.send('speak', payload.suggestion);
      }
    }
  });

  // Resultado de ejecutar una propuesta aceptada (Fase A/B): sin esto el
  // outcome era invisible — el executor se negaba (p.ej. archivo abierto en
  // el editor) o aplicaba el parche y el usuario nunca se enteraba.
  Core.getEventBus().on('proposal:executed', (payload = {}) => {
    let text;
    if (payload.ok && payload.skipped) {
      text = 'Ese cambio ya estaba aplicado, no toqué nada.';
    } else if (payload.ok && payload.appliedWhileOpen) {
      const diffNote =
        payload.diff && payload.diff.length < 1200
          ? `\n\n\`\`\`diff\n${payload.diff.trim()}\n\`\`\``
          : '';
      const focusWarning = payload.wasFocused
        ? `⚠️ **Tenías el archivo ENFOCADO en tu editor**: recargalo ANTES de guardar, si no vas a pisar el parche con la versión vieja (y si tenés cambios sin guardar, resolvé el conflicto que te va a ofrecer).`
        : `⚠️ El archivo está abierto en tu editor: recargalo antes de guardar.`;
      text = `Listo, apliqué el cambio en tu archivo${
        payload.type === 'lsp_error' ? ' — el error debería estar resuelto' : ''
      }. ✅\n\n${focusWarning}${diffNote}`;
    } else if (payload.ok) {
      text = `Listo, apliqué el cambio${
        payload.type === 'lsp_error' ? ' — el error debería estar resuelto' : ''
      }. ✅`;
    } else {
      text = `No pude aplicar el cambio automáticamente: ${
        payload.detail || 'motivo desconocido'
      }.`;
    }
    logger.info(
      'main',
      `[proactive] propuesta ${payload.type}: ${payload.ok ? 'ejecutada' : 'falló'}${
        payload.detail ? ` (${payload.detail})` : ''
      }${payload.appliedWhileOpen ? ' [archivo abierto]' : ''}`
    );
    if (payload.type === 'lsp_error') {
      logger.info(
        'main',
        `[lsp-ciclo] resultado: ${payload.ok ? (payload.fixed === false ? 'aplicado-pero-no-bastó' : 'aplicado-y-verificado') : 'falló'}${
          payload.attempt ? ` (intento ${payload.attempt})` : ''
        }${payload.appliedWhileOpen ? ' con-archivo-abierto' : ''}`
      );
    }
    const chatVisible = S.chatWindow && !S.chatWindow.isDestroyed() && S.chatWindow.isVisible();
    if (chatVisible) {
      sendToChat('initiative', {
        reason: payload.type || 'proposal_result',
        suggestion: text,
        actionType: 'proactive',
        canHelp: false,
        openChat: true,
      });
    } else if (S.mainWindow && !S.mainWindow.isDestroyed()) {
      S.mainWindow.webContents.send('speak', text);
    }
  });

  Core.onProposalResult((payload) => {
    gestureEvents.emit(payload.ok ? 'proposal-accepted' : 'proposal-rejected', { ok: payload.ok });
    sendToChat('proposal-result', payload);
  });

  createWindow();
  createTray();
  startControlServer();
  createChatWindow();

  initUpdater({
    sendToWindows: (channel, payload) => {
      for (const w of [S.chatWindow, S.mainWindow]) {
        if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
      }
    },
  });

  _autoInitProject();

  // Atajo global de salida con fallback: si Ctrl/Cmd+Shift+Q está tomado por
  // otra app, se intenta Alt+Shift+Q antes de rendirse (el usuario siempre
  // necesita una vía de teclado para cerrar todo).
  let registeredShortcut = 'Ctrl/Cmd+Shift+Q';
  let shortcutOk = globalShortcut.register('CommandOrControl+Shift+Q', () => app.quit());
  if (!shortcutOk) {
    shortcutOk = globalShortcut.register('Alt+Shift+Q', () => app.quit());
    if (shortcutOk) registeredShortcut = 'Alt+Shift+Q';
  }
  if (shortcutOk) {
    logger.info('main', `[main] atajo global de salida registrado: ${registeredShortcut}`);
  } else {
    logger.warn(
      'main',
      'ningún atajo global de salida disponible (Ctrl/Cmd+Shift+Q y Alt+Shift+Q ocupados) — usá el menú del overlay ("Cerrar todo").'
    );
  }

  screen.on('display-metrics-changed', () => {
    if (!S.mainWindow || S.mainWindow.isDestroyed()) return;
    if (!S.userHasMoved) S.mainWindow.setBounds(getBottomRightBounds());
  });
});

// Cierre limpio
function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms))]);
}

let _quitting = false;

app.on('before-quit', (event) => {
  if (_quitting) return;
  event.preventDefault();
  _quitting = true;
  (async () => {
    try {
      await withTimeout(Core.shutdown(), SHUTDOWN_TIMEOUT_MS);
    } catch (e) {
      logger.error('main', `shutdown con errores: ${e && e.message ? e.message : e}`);
    }
    app.quit();
  })();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
