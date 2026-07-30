const {
  app, BrowserWindow, ipcMain, screen,
  Tray, Menu, nativeImage, session, globalShortcut, dialog
} = require('electron');
const path = require('path');
const http = require('http');
const fs   = require('fs');
const os   = require('os');
const { URL } = require('url');
const { spawnSync } = require('child_process');

const MarchCore = require('./core/MarchCore.js');
const KeychainManager = require('./infrastructure/keychain/KeychainManager.js');

// ── Manejo global de errores ──────────────────────────────────────────────────
// Antes no había NINGÚN handler de uncaughtException/unhandledRejection — un
// error async sin catch (p.ej. una promesa rechazada en un handler de IPC)
// podía tirar el proceso principal entero sin dejar rastro visible, porque
// esto corre casi siempre desde la bandeja del sistema sin consola abierta.
// Ahora se registra en un log persistente para poder diagnosticar qué pasó,
// pero NO se fuerza el cierre — la mayoría de estos errores son recuperables
// y March es una app "siempre presente", no queremos que un solo handler
// roto tumbe toda la sesión.
const CRASH_LOG_PATH = path.join(app.getPath('userData'), 'crash.log');

function logCrash(label, err) {
  const line = `[${new Date().toISOString()}] ${label}: ${err?.stack || err}\n`;
  console.error(line);
  try { fs.appendFileSync(CRASH_LOG_PATH, line); } catch (_) { /* best-effort */ }
}

process.on('uncaughtException', (err) => logCrash('uncaughtException', err));
process.on('unhandledRejection', (reason) => logCrash('unhandledRejection', reason));

// ── Python executable ─────────────────────────────────────────────────────────
// FIX: antes esto era una ruta absoluta hardcodeada a un usuario y versión de
// Python específicos ('C:/Users/lukal/.../Python311/python.exe'). Se rompe en
// cualquier máquina distinta a la tuya actual — incluido tu propio PC si
// reinstalas Windows, cambias de versión de Python, o si algún día generas el
// build portable (`npm run build-portable`) para alguien más, ya que ese exe
// jamás va a tener esa ruta exacta. Ahora se resuelve dinámicamente:
//   1. Variable de entorno MARCH_PYTHON_BIN (override manual si hace falta)
//   2. El launcher estándar de Windows `py -3` (viene con casi cualquier
//      instalación oficial de Python en Windows)
//   3. `python` / `python3` si están en el PATH
//   4. Barrido de las carpetas de instalación típicas bajo el HOME del
//      usuario ACTUAL (os.homedir(), no un usuario fijo), tomando la versión
//      más alta encontrada
// Se resuelve una sola vez al arrancar y se cachea.
function resolvePythonBin() {
  if (process.env.MARCH_PYTHON_BIN && fs.existsSync(process.env.MARCH_PYTHON_BIN)) {
    console.log('[python] usando override MARCH_PYTHON_BIN:', process.env.MARCH_PYTHON_BIN);
    return process.env.MARCH_PYTHON_BIN;
  }

  // Resuelve el comando a la ruta ABSOLUTA real del ejecutable (en vez de
  // devolver 'py' o 'python' tal cual) para que los spawn(PYTHON_BIN, args)
  // que ya existen más abajo no necesiten cambiar — siguen recibiendo un
  // solo binario + sus args normales, sin tener que anteponer '-3' etc.
  const resolveViaCommand = (cmd, extraArgs = []) => {
    try {
      const res = spawnSync(cmd, [...extraArgs, '-c', 'import sys; print(sys.executable)'], {
        timeout: 4000, windowsHide: true, encoding: 'utf-8',
      });
      if (res.status === 0) {
        const out = (res.stdout || '').trim().split(/\r?\n/).pop().trim();
        if (out && fs.existsSync(out)) return out;
      }
    } catch (_) { /* comando no existe */ }
    return null;
  };

  // Launcher oficial de Windows — resuelve él mismo la versión instalada
  if (process.platform === 'win32') {
    const viaLauncher = resolveViaCommand('py', ['-3']);
    if (viaLauncher) { console.log('[python] resuelto vía "py -3":', viaLauncher); return viaLauncher; }
  }

  const viaPython = resolveViaCommand('python');
  if (viaPython) { console.log('[python] resuelto vía "python" del PATH:', viaPython); return viaPython; }

  const viaPython3 = resolveViaCommand('python3');
  if (viaPython3) { console.log('[python] resuelto vía "python3" del PATH:', viaPython3); return viaPython3; }

  // Barrido de carpetas típicas de instalación en Windows, bajo el HOME real
  if (process.platform === 'win32') {
    const home = os.homedir();
    const searchDirs = [
      path.join(home, 'AppData', 'Local', 'Programs', 'Python'),
      'C:\\Program Files\\',
      'C:\\',
    ];
    for (const dir of searchDirs) {
      try {
        const entries = fs.readdirSync(dir).filter(n => /^Python3\d\d?$/i.test(n)).sort().reverse();
        for (const entry of entries) {
          const candidate = path.join(dir, entry, 'python.exe');
          if (fs.existsSync(candidate)) {
            console.log('[python] encontrado por barrido de carpetas:', candidate);
            return candidate;
          }
        }
      } catch (_) { /* carpeta no existe, seguir */ }
    }
  }

  console.warn('[python] no se encontró ningún intérprete de Python. La voz y el STT local no van a funcionar hasta que instales Python o definas MARCH_PYTHON_BIN.');
  return null;
}

const PYTHON_BIN = resolvePythonBin();

// ── Cargar .env (múltiples ubicaciones) ─────────────────────────────────────
// Busca .env en el directorio del proyecto y en userData (si app ya está lista).
// dotenv no sobreescribe vars ya definidas — la primera fuente gana.
const dotenv = require('dotenv');
const _appRoot = __dirname;
dotenv.config({ path: path.join(_appRoot, '.env'), override: false });
// Nota: también se cargará desde userData en app.whenReady() más abajo.

// ── Fuente de keys activa — para el IPC get-key-source ──────────────────────
let _keySource = 'config.json';
let _keySourcesByProvider = {}; // { groq: 'config.json'|'.env'|'keychain', ... }

// ── Constantes ────────────────────────────────────────────────────────────────
const MARGIN  = 12;
const WIN_W   = 380;
const WIN_H   = 580;
const CHAT_W  = 900;
const CHAT_H  = 600;

// ── Config persistente ────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH))
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (e) { console.log('[config] error leyendo config.json:', e.message); }
  return {};
}

function loadEffectiveConfig() {
  const cfg = loadConfig();

  if (!cfg.llm) cfg.llm = {};
  if (!cfg.llm.apiKeys) cfg.llm.apiKeys = {};
  if (!cfg.llm.providers) cfg.llm.providers = {};

  // Merge all env vars (LLM_KEY_{PROVIDER_ID})
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

  // Merge with system keychain (highest priority)
  const builtinProviders = ['groq', 'gemini', 'openai', 'anthropic', 'xai', 'nvidia', 'huggingface', 'deepseek'];
  const keychainKeys = KeychainManager.getAllKeys(builtinProviders);
  for (const [k, v] of Object.entries(keychainKeys)) {
    if (v) {
      cfg.llm.apiKeys[k] = v;
      if (!cfg.llm.providers[k]) cfg.llm.providers[k] = {};
      cfg.llm.providers[k].apiKey = v;
      _keySourcesByProvider[k] = 'llavero del sistema';
    }
  }

  // For providers without explicit source, assume config.json
  for (const provider of builtinProviders) {
    if (!_keySourcesByProvider[provider]) _keySourcesByProvider[provider] = 'config.json';
  }

  const uniqueSources = [...new Set(Object.values(_keySourcesByProvider))];
  _keySource = uniqueSources.length === 1 ? uniqueSources[0] : 'mixto';

  return cfg;
}

function saveConfig(data) {
  try {
    const merged = { ...loadConfig(), ...data };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf-8');
  } catch (e) { console.log('[config] error guardando config.json:', e.message); }
}

function ensureLLMConfig() {
  const cfg = loadConfig();
  if (!cfg.llm) {
    saveConfig({ llm: {
      primary: 'groq',
      fallback: ['gemini'],
      apiKeys: {},
      providers: {},
    } });
    console.log('[config] bloque llm inicializado');
  }
}

// ── Estado global ─────────────────────────────────────────────────────────────
let mainWindow     = null;
let chatWindow     = null;
let tray           = null;
let isClickThrough = true;
let currentView    = 'full';
let userHasMoved   = false;
let chatTheme      = 'dark';
let chatMode       = 'conversational';

const savedConfig    = loadConfig();
chatTheme            = savedConfig.chatTheme ?? 'dark';
chatMode             = savedConfig.chatMode  ?? 'conversational';

const maskedConfig = JSON.parse(JSON.stringify(savedConfig));
if (maskedConfig.llm?.apiKeys) {
  for (const k of Object.keys(maskedConfig.llm.apiKeys)) {
    if (maskedConfig.llm.apiKeys[k]) maskedConfig.llm.apiKeys[k] = '***';
  }
}
console.log('[march7th] config cargada:', maskedConfig);

if (process.platform === 'linux')
  app.commandLine.appendSwitch('enable-transparent-visuals');

// ── Posiciones ────────────────────────────────────────────────────────────────
function getBottomRightBounds() {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: Math.round(workArea.x + workArea.width  - WIN_W - MARGIN),
    y: Math.round(workArea.y + workArea.height - WIN_H - MARGIN),
    width: WIN_W, height: WIN_H,
  };
}

function getChatBounds() {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: Math.round(workArea.x + (workArea.width  - CHAT_W) / 2),
    y: Math.round(workArea.y + (workArea.height - CHAT_H) / 2),
    width: CHAT_W, height: CHAT_H,
  };
}

// ── Click-through ─────────────────────────────────────────────────────────────
function setClickThrough(enabled) {
  isClickThrough = enabled;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setIgnoreMouseEvents(enabled, { forward: true });
  if (tray) tray.setContextMenu(buildTrayMenu());
}

function sendView(view) {
  currentView = view;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('set-view', view);
  if (tray) tray.setContextMenu(buildTrayMenu());
}

function sendSpeak(text, emotion) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('speak', emotion ? { text, emotion } : text);
}

// ── Ventana overlay ───────────────────────────────────────────────────────────
function createWindow() {
  const views = ['full', 'half', 'head'];
  currentView = views[Math.floor(Math.random() * views.length)];

  mainWindow = new BrowserWindow({
    ...getBottomRightBounds(),
    transparent: true, backgroundColor: '#00000000',
    frame: false, alwaysOnTop: true, skipTaskbar: true,
    resizable: false, hasShadow: false, thickFrame: false,
    focusable: false, show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false, webSecurity: false },
  });

  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.setIgnoreMouseEvents(true, { forward: true });
  mainWindow.webContents.on('console-message', (e, level, msg) => {
    if (msg.includes('PixiJS') || msg.includes('Live2D Cubism Core') || msg.includes('CubismFramework.') || msg.startsWith(' %c') || msg.includes('Electron Security Warning')) return;
    console.log(`[overlay] ${msg}`);
  });
  mainWindow.loadFile(path.join(__dirname, 'src/index.html'));
  mainWindow.webContents.once('did-finish-load', () => {
    setTimeout(() => mainWindow.webContents.send('set-view', currentView), 1500);
  });
}

// ── Ventana de chat ───────────────────────────────────────────────────────────
function createChatWindow() {
  if (chatWindow && !chatWindow.isDestroyed()) {
    if (!chatWindow.isVisible()) {
      chatWindow.show(); chatWindow.focus();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
      MarchCore.setChatOpen(true);
      if (tray) tray.setContextMenu(buildTrayMenu());
    } else {
      chatWindow.focus();
    }
    return;
  }

  chatWindow = new BrowserWindow({
    ...getChatBounds(),
    frame: false, transparent: false, backgroundColor: '#0d0f14',
    resizable: true, minWidth: 700, minHeight: 480,
    skipTaskbar: false, alwaysOnTop: false, hasShadow: true, show: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false,
      allowRunningInsecureContent: true,
    },
  });

  chatWindow.setMenuBarVisibility(false);
  chatWindow.loadFile(path.join(__dirname, 'src/chat.html'));
  chatWindow.webContents.openDevTools({ mode: 'detach' });
  chatWindow.webContents.on('console-message', (e, level, msg) => {
    if (msg.includes('PixiJS') || msg.includes('Live2D Cubism Core') || msg.includes('CubismFramework.') || msg.startsWith(' %c') || msg.includes('Electron Security Warning')) return;
    console.log(`[chat] ${msg}`);
  });

  chatWindow.webContents.once('did-finish-load', () => {
    chatWindow.webContents.send('init-theme', chatTheme);
    chatWindow.webContents.send('init-mode', chatMode);

    const usingFallback = MarchCore.getGraph()?.usingFallback ?? false;
    chatWindow.webContents.send('memory-status', { usingFallback });

    // Mejora #6 — si sessionPromise resolvió con una sesión RETOMADA
    // (ended_at NULL de un cierre no-limpio anterior), repobla la ventana
    // con los mensajes recuperados en vez de arrancar en blanco.
    sessionPromise.then(result => {
      if (result?.resumed && result.history?.length && chatWindow && !chatWindow.isDestroyed()) {
        console.log(`[main] enviando sesión resumida al chat: ${result.history.length} mensajes`);
        chatWindow.webContents.send('resumed-session', { history: result.history });
      }
    }).catch(() => {});
  });

  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();

  const sessionPromise = MarchCore.startSession().catch(e => { console.error('[session] error:', e.message); return null; });
  MarchCore.setChatOpen(true);

  chatWindow.on('closed', () => {
    MarchCore.closeSession().catch(e => console.error('[session] close error:', e.message));
    MarchCore.setChatOpen(false);
    chatWindow = null;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
    if (tray) tray.setContextMenu(buildTrayMenu());
  });

  if (tray) tray.setContextMenu(buildTrayMenu());
}

function toggleChatWindow() {
  if (!chatWindow || chatWindow.isDestroyed()) {
    createChatWindow();
  } else if (chatWindow.isVisible()) {
    chatWindow.hide();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
    MarchCore.setChatOpen(false);
    if (tray) tray.setContextMenu(buildTrayMenu());
  } else {
    chatWindow.show(); chatWindow.focus();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
    MarchCore.setChatOpen(true);
    if (tray) tray.setContextMenu(buildTrayMenu());
  }
}

// ── Tray ──────────────────────────────────────────────────────────────────────
function buildTrayMenu() {
  const chatOpen = chatWindow && !chatWindow.isDestroyed() && chatWindow.isVisible();
  return Menu.buildFromTemplate([
    { label: chatOpen ? 'Cerrar chat' : 'Abrir chat', click: toggleChatWindow },
    { type: 'separator' },
    { label: isClickThrough ? 'Bloquear (mover overlay)' : 'Pasar clics', click: () => setClickThrough(!isClickThrough) },
    { type: 'separator' },
    { label: `${currentView === 'full' ? '> ' : ''}Cuerpo completo`, click: () => sendView('full') },
    { label: `${currentView === 'half' ? '> ' : ''}Medio cuerpo`,    click: () => sendView('half') },
    { label: `${currentView === 'head' ? '> ' : ''}Solo cabeza`,     click: () => sendView('head') },
    { type: 'separator' },
    { label: 'Prueba de voz', submenu: [
      { label: 'Saludo',      click: () => sendSpeak('Hola! Estoy aqui para ayudarte!') },
      { label: 'Emocion sad', click: () => sendSpeak('Lo siento, hubo un error.', 'sad') },
      { label: 'Excited',     click: () => sendSpeak('Perfecto, todo salio bien!', 'excited') },
    ]},
    { type: 'separator' },
    { label: 'Volver a esquina', click: () => { userHasMoved = false; mainWindow.setBounds(getBottomRightBounds()); } },
    { label: 'Mostrar / ocultar overlay', click: () => mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show() },
    { type: 'separator' },
    { label: 'Cerrar todo', click: () => app.quit() },
  ]);
}

function createTray() {
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip('March 7th — Sentinel-Pi');
  tray.setContextMenu(buildTrayMenu());
}

// ── IPC: overlay ──────────────────────────────────────────────────────────────
ipcMain.on('drag-start', () => { userHasMoved = true; });
ipcMain.on('drag-move', (e, { x, y }) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const size = mainWindow.getSize();
  mainWindow.setPosition(Math.round(x - size[0] / 2), Math.round(y - size[1] / 2));
});
ipcMain.on('model-hover', (e, hovering) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setIgnoreMouseEvents(!hovering, { forward: true });
});
ipcMain.on('view-changed', (e, view) => { currentView = view; if (tray) tray.setContextMenu(buildTrayMenu()); });
ipcMain.on('model-dblclick', () => toggleChatWindow());

ipcMain.on('chat-close', () => {
  if (chatWindow && !chatWindow.isDestroyed()) chatWindow.hide();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  MarchCore.setChatOpen(false);
  if (tray) tray.setContextMenu(buildTrayMenu());
});

ipcMain.on('chat-theme-changed', (e, theme) => { chatTheme = theme; saveConfig({ chatTheme: theme }); });

ipcMain.on('chat-mode-changed', (e, mode) => {
  if (mode !== 'conversational' && mode !== 'task') return;
  chatMode = mode;
  saveConfig({ chatMode: mode });
  console.log('[march7th] modo de chat cambiado a:', mode);
});



// FIX — antes este handler duplicaba ~30 líneas de SQL (CREATE TABLE,
// DELETE, INSERT) que ya existían en init_vectors.js, y esa copia NO
// tenía el fix de rowid explícito (intent_vectors.rowid = intent_catalog.id)
// que sí tiene la v2 de init_vectors.js — es decir, esta copia inline
// podía desincronizar las tablas igual que la versión vieja del otro
// archivo. Ahora delega TODO a populateDatabase(), que vive en un solo
// lugar (init_vectors.js) y ya incluye ese fix.
ipcMain.handle('init-vectors', async () => {
  const { populateDatabase } = require('./infrastructure/database/init_vectors.js');
  const db = MarchCore.getGraph()?._db;
  if (!db) throw new Error('DB no disponible');

  const result = await populateDatabase(db, { force: true });

  const count = result.populated
    ? result.inserted
    : result.existing;

  console.log(`[init-vectors] ${count} frases en ${MarchCore.getGraph()?._dbPath ?? 'N/A'}`);
  return `${count} frases vectorizadas`;
});



// ── IPC: aprobación de planes (Fase 3) ───────────────────────────────────────
ipcMain.on('plan-approval-response', () => {});

// ── IPC: memoria ──────────────────────────────────────────────────────────────
ipcMain.on('memory-add-turn', (e, { role, content }) => {
  MarchCore.addTurn(role, content);
  if (role === 'user') MarchCore.detectInstant(content);
});

ipcMain.handle('memory-stats', () => MarchCore.getStats());

// ── IPC: grounding ────────────────────────────────────────────────────────────
// FIX Fase 3: async/await porque buildContext ahora es async
// (necesita await para IntentDetector.detect())
ipcMain.handle('grounding-build-context', async (e, { sessionHistory, activeProvider, mode, plan }) => {
  const ctx = await MarchCore.buildContext(sessionHistory, activeProvider, { mode, plan });
  console.log('[grounding-ipc] provider:', activeProvider, '| mode:', mode || 'chat', '| systemPrompt:', ctx?.systemPrompt?.length, 'chars');
  return ctx;
});

// Genera un plan (fase 1 del sistema de dos fases). Usa MarchCore.generatePlan()
// internamente: construye contexto en modo 'plan', llama al LLM y parsea el plan.
ipcMain.handle('march-generate-plan', async (e, { sessionHistory, userGoal }) => {
  const taskDetector = MarchCore.getTaskDetector?.();
  const taskIntent = taskDetector ? taskDetector.detect(userGoal) : null;
  const result = await MarchCore.generatePlan(userGoal, taskIntent, sessionHistory);
  return result;
});

// ── IPC: OS Sensor ────────────────────────────────────────────────────────────
ipcMain.handle('os-get-context', () => {
  return MarchCore.getOSSensor()?.getCurrentContext() ?? null;
});

ipcMain.handle('os-get-today-history', () => {
  return MarchCore.getOSSensor()?.getTodayHistory() ?? [];
});

ipcMain.handle('os-get-today-summary', () => {
  return MarchCore.getOSSensor()?.getTodaySummary() ?? null;
});

ipcMain.handle('march-get-stats', () => {
  return MarchCore.getStats();
});

ipcMain.handle('list-skills', () => MarchCore.listSkills());
ipcMain.handle('store-fact', (e, fact) => MarchCore.storeFact(fact));

ipcMain.on('set-provider', (e, { primary }) => {
  if (!primary) return;
  const LLMProvider = require('./core/llm/LLMProvider.js');
  LLMProvider.configure({ llm: { primary } });
  console.log('[config] provedor cambiado a:', primary);
});

// ── IPC: config y keys ────────────────────────────────────────────────────────
ipcMain.handle('get-config', () => loadEffectiveConfig());

ipcMain.handle('save-llm-keys', (e, { providers, useKeychain }) => {
  const currentCfg = loadConfig();
  const existingPrimary = currentCfg.llm?.primary || 'groq';
  const existingFallback = currentCfg.llm?.fallback || ['gemini'];

  // Build new providers config from the submitted keys
  const newProviders = { ...(currentCfg.llm?.providers || {}) };
  for (const [id, key] of Object.entries(providers || {})) {
    newProviders[id] = { ...(newProviders[id] || {}), apiKey: key };
  }

  saveConfig({ llm: {
    primary: existingPrimary,
    fallback: existingFallback,
    providers: newProviders,
    apiKeys: providers,
  } });

  // Keychain
  if (useKeychain && KeychainManager.isAvailable()) {
    for (const [id, key] of Object.entries(providers || {})) {
      if (key) KeychainManager.setKey(id, key);
    }
  }

  console.log('[config] keys LLM actualizadas');
  MarchCore.reloadLLMConfig();
  return true;
});

ipcMain.handle('get-key-source', () => {
  return {
    source: _keySource,
    byProvider: _keySourcesByProvider,
    keychainAvailable: KeychainManager.isAvailable(),
  };
});

// ── IPC: ruta de Python ya resuelta (ver resolvePythonBin arriba) ─────────────
// chat.html necesita spawnear Python directo para el TTS (línea con cp.spawn)
// y antes traía su PROPIA copia hardcodeada de la misma ruta absoluta que
// arreglamos en main.js — mismo bug, dos lugares. Ahora lo pide por IPC en
// vez de duplicar la lógica de resolución en el renderer.
ipcMain.handle('get-python-bin', () => PYTHON_BIN);

// ── IPC: testing proactivo ────────────────────────────────────────────────────
ipcMain.handle('force-proactive', async (e, triggerType) => {
  console.log('[main] force-proactive:', triggerType);
  const msg = await MarchCore.forceProactive(triggerType || 'long_silence');
  return msg || null;
});

// ── IPC: Fase 3 — OpenClaw ────────────────────────────────────────────────────

ipcMain.handle('openclaw-available', async () => {
  return MarchCore.isOpenClawAvailable();
});

ipcMain.handle('openclaw-execute-tool', async (e, { tool, params }) => {
  console.log(`[main] openclaw-execute-tool: ${tool}`);
  try {
    const result = await MarchCore.executeTool(tool, params);
    return result;
  } catch (err) {
    console.error('[main] error en executeTool:', err.message);
    return { ok: false, error: err.message, tool, result: null, elapsed: 0 };
  }
});

ipcMain.handle('openclaw-parse-plan', (e, { llmResponse, userGoal, toolIntent }) => {
  try {
    const plan = MarchCore.parsePlanFromResponse(llmResponse, userGoal, toolIntent ?? null);
    return plan ?? null;
  } catch (err) {
    console.error('[main] error en parsePlanFromResponse:', err.message);
    return null;
  }
});

ipcMain.handle('openclaw-execute-plan', async (e, { plan }) => {
  console.log(`[main] ejecutando plan: ${plan?.id} (${plan?.steps?.length} pasos)`);

  if (!plan || !plan.steps?.length) {
    return { ok: false, error: 'Plan inválido o sin pasos', plan };
  }

  try {
    const executedPlan = await MarchCore.executePlan(plan, {

      onStepStart: (step) => {
        if (chatWindow && !chatWindow.isDestroyed()) {
          chatWindow.webContents.send('plan-step-start', {
            planId:      plan.id,
            stepId:      step.id,
            description: step.description,
            tool:        step.tool,
          });
        }
      },

      onStepDone: (step, result) => {
        if (chatWindow && !chatWindow.isDestroyed()) {
          chatWindow.webContents.send('plan-step-done', {
            planId:      plan.id,
            stepId:      step.id,
            description: step.description,
            tool:        step.tool,
            status:      step.status,
            result:      _serializeResult(result),
            error:       step.error,
          });
        }
      },

      onApprovalNeeded: (step) => {
        return new Promise((resolve) => {
          if (!chatWindow || chatWindow.isDestroyed()) {
            resolve(false);
            return;
          }

          chatWindow.webContents.send('plan-approval-needed', {
            planId:      plan.id,
            stepId:      step.id,
            description: step.description,
            tool:        step.tool,
            params:      step.params,
          });

          const handler = (e2, { stepId, approved }) => {
            if (stepId === step.id) {
              ipcMain.removeListener('plan-approval-response', handler);
              resolve(approved);
            }
          };
          ipcMain.on('plan-approval-response', handler);

          setTimeout(() => {
            ipcMain.removeListener('plan-approval-response', handler);
            resolve(false);
          }, 60_000);
        });
      },
    });

    return {
      ok:     executedPlan.status === 'done',
      plan:   executedPlan,
      result: _serializeResult(executedPlan.result),
      error:  executedPlan.error,
    };

  } catch (err) {
    console.error('[main] error ejecutando plan:', err.message);
    return { ok: false, error: err.message, plan };
  }
});

// ── IPC: agent-run (Fase 2 — reemplaza processMessage → complete → parse → execute)
ipcMain.handle('agent-run', async (e, { text, mode }) => {
  console.log(`[main] agent-run: mode=${mode}, text="${text.slice(0, 80)}"`);

  if (!text || !text.trim()) {
    return { response: null, iterations: 0, toolResults: [], error: 'texto vacío' };
  }

  try {
    const result = await MarchCore.runAgent(text, {
      mode: mode || 'smart',
      maxIterations: mode === 'conversational' ? 8 : 25,

      onApprovalNeeded: async (action) => {
        return new Promise((resolve) => {
          if (!chatWindow || chatWindow.isDestroyed()) {
            resolve(false);
            return;
          }

          const actionId = `agent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          chatWindow.webContents.send('agent-approval-needed', {
            actionId,
            tool: action.tool,
            params: action.params,
            description: action.description || `${action.tool}: ${JSON.stringify(action.params).slice(0, 100)}`,
          });

          const handler = (e2, { id, approved }) => {
            if (id === actionId) {
              ipcMain.removeListener('agent-approval-response', handler);
              resolve(approved);
            }
          };
          ipcMain.on('agent-approval-response', handler);

          setTimeout(() => {
            ipcMain.removeListener('agent-approval-response', handler);
            resolve(false);
          }, 60_000);
        });
      },

      onProgress: (progress) => {
        if (chatWindow && !chatWindow.isDestroyed()) {
          chatWindow.webContents.send('agent-progress', progress);
        }
      },
    });

    return {
      response: result.response,
      iterations: result.iterations,
      toolResults: result.toolResults,
      error: result.error,
      truncated: result.truncated || false,
    };
  } catch (err) {
    console.error('[main] error en agent-run:', err.message);
    return { response: null, iterations: 0, toolResults: [], error: err.message };
  }
});

ipcMain.handle('openclaw-plan-history', () => {
  return MarchCore.getPlanner()?.getHistory(20) ?? [];
});

// ── MCP ────────────────────────────────────────────────────────────────────────
// Independiente de OpenClaw — estos handlers funcionan aunque mock-openclaw
// no esté corriendo. La config (qué servidores hay, cuáles están enabled)
// vive en config.json bajo `mcp.servers`, igual que las apiKeys de LLM.

ipcMain.handle('pick-workspace-folder', async () => {
  const result = await dialog.showOpenDialog(chatWindow, { properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths.length) return null;
  return MarchCore.setActiveWorkspace(result.filePaths[0]);
});

ipcMain.handle('mcp-list-servers', async () => {
  try { return await MarchCore.mcpListServers(); }
  catch (err) { console.error('[main] error en mcp-list-servers:', err.message); return []; }
});

ipcMain.handle('mcp-list-tools', () => {
  try { return MarchCore.mcpListAllTools(); }
  catch (err) { console.error('[main] error en mcp-list-tools:', err.message); return []; }
});

ipcMain.handle('mcp-search-registry', async (e, { query }) => {
  try { return await MarchCore.mcpSearchRegistry(query || ''); }
  catch (err) { console.error('[main] error en mcp-search-registry:', err.message); return []; }
});

// Agrega un servidor y lo persiste en config.json. `serverCfg` trae al
// menos { name, command, args, env? }. Se conecta de inmediato para poder
// mostrarle al usuario si funcionó o no.
ipcMain.handle('mcp-add-server', async (e, { serverCfg }) => {
  try {
    const status = await MarchCore.mcpAddServer(serverCfg);
    const cfg = loadConfig();
    const servers = cfg?.mcp?.servers || [];
    const withoutDup = servers.filter(s => s.id !== status.id);
    saveConfig({ mcp: { servers: [...withoutDup, { ...serverCfg, id: status.id, enabled: true }] } });
    return { ok: true, status };
  } catch (err) {
    console.error('[main] error en mcp-add-server:', err.message);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('mcp-remove-server', async (e, { id }) => {
  try {
    await MarchCore.mcpRemoveServer(id);
    const cfg = loadConfig();
    const servers = (cfg?.mcp?.servers || []).filter(s => s.id !== id);
    saveConfig({ mcp: { servers } });
    return { ok: true };
  } catch (err) {
    console.error('[main] error en mcp-remove-server:', err.message);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('mcp-toggle-server', async (e, { id, enabled }) => {
  try {
    const cfg = loadConfig();
    const servers = cfg?.mcp?.servers || [];
    const serverCfg = servers.find(s => s.id === id);
    if (!serverCfg) return { ok: false, error: 'Servidor no encontrado en config' };

    await MarchCore.mcpToggleServer(id, enabled, serverCfg);

    const updated = servers.map(s => s.id === id ? { ...s, enabled } : s);
    saveConfig({ mcp: { servers: updated } });
    return { ok: true };
  } catch (err) {
    console.error('[main] error en mcp-toggle-server:', err.message);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('fase3-stats', () => {
  const stats = MarchCore.getStats();
  return {
    openclaw: stats.openclaw,
    planner:  stats.planner,
    provider: stats.provider,
  };
});

ipcMain.handle('get-bridge-stats', () => {
  try {
    const stats = MarchCore.getStats();
    return stats.openclaw || { error: 'no disponible' };
  } catch (e) {
    return { error: `MarchCore no inicializado: ${e.message}` };
  }
});

ipcMain.handle('exec-command', async (e, { command, timeout }) => {
  const util = require('util');
  const exec = util.promisify(require('child_process').exec);
  const safeTimeout = Math.min(timeout || 10, 60) * 1000;
  try {
    const { stdout, stderr } = await exec(command, { timeout: safeTimeout, maxBuffer: 1024 * 1024 });
    return { exitCode: 0, stdout: stdout || '', stderr: stderr || '' };
  } catch (err) {
    return {
      exitCode: err.code || 1,
      stdout: err.stdout || '',
      stderr: err.stderr || err.message || '',
    };
  }
});

const IPC_RESULT_LIMIT = 512 * 1024;

function _serializeResult(result) {
  if (!result) return null;
  if (typeof result === 'string') return result;
  if (typeof result === 'object') {
    try {
      const str = JSON.stringify(result);
      if (str.length > IPC_RESULT_LIMIT) {
        console.warn(`[main] resultado muy grande (${str.length} chars), truncando para IPC`);
        return { _truncated: true, preview: str.slice(0, IPC_RESULT_LIMIT), totalLength: str.length };
      }
      return result;
    } catch {
      return String(result);
    }
  }
  return result;
}

// ── Servidor HTTP local ───────────────────────────────────────────────────────
const VALID_EMOTIONS = ['happy','excited','sad','tired','gentle','default'];
const VALID_VIEWS    = ['full','half','head'];
const HELP_TEXT = `
  March 7th — Control API (puerto 3131)
  curl "http://localhost:3131/speak?text=hola"
  curl "http://localhost:3131/speak?text=lo+siento&emotion=sad"
  curl "http://localhost:3131/view?v=half"
  curl "http://localhost:3131/chat?action=open"
  curl "http://localhost:3131/chat?action=close"
  curl "http://localhost:3131/mic?index=0"
  curl "http://localhost:3131/workspace?path=/ruta/al/proyecto"
`;

function startControlServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost:3131');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    if (url.pathname === '/speak') {
      const text = url.searchParams.get('text') || '';
      const rawEmo = (url.searchParams.get('emotion') || '').toLowerCase();
      const emotion = VALID_EMOTIONS.includes(rawEmo) ? rawEmo : null;
      if (!text) { res.writeHead(400); res.end('falta ?text='); return; }
      sendSpeak(text, emotion);
      if (chatWindow && !chatWindow.isDestroyed()) chatWindow.webContents.send('chat-message', text);
      res.writeHead(200); res.end(`ok: ${text}`); return;
    }
    if (url.pathname === '/view') {
      const v = (url.searchParams.get('v') || '').toLowerCase();
      if (!VALID_VIEWS.includes(v)) { res.writeHead(400); res.end(`validos: ${VALID_VIEWS.join(', ')}`); return; }
      sendView(v); res.writeHead(200); res.end(`ok: ${v}`); return;
    }
    if (url.pathname === '/chat') {
      const action = (url.searchParams.get('action') || '').toLowerCase();
      if (action === 'open') createChatWindow();
      else if (action === 'close') {
        if (chatWindow && !chatWindow.isDestroyed()) {
          chatWindow.hide();
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
          MarchCore.setChatOpen(false);
        }
      } else toggleChatWindow();
      res.writeHead(200); res.end(`ok: chat ${action || 'toggled'}`); return;
    }
    if (url.pathname === '/workspace') {
      const p = url.searchParams.get('path');
      if (!p) { res.writeHead(400); res.end('falta ?path='); return; }
      MarchCore.setActiveWorkspace(p).then(result => {
        res.writeHead(result.ok ? 200 : 400);
        res.end(result.ok ? `ok: workspace -> ${result.path}` : `error: ${result.error}`);
      });
      return;
    }
    res.writeHead(200); res.end(HELP_TEXT);
  });
  server.listen(3131, '127.0.0.1', () => console.log('[march7th] API lista → http://localhost:3131/help'));
  server.on('error', (e) => { if (e.code === 'EADDRINUSE') console.log('[march7th] puerto 3131 ocupado.'); });
}

// ── App init ──────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  // Cargar .env desde el directorio userData (además del que ya se cargó
  // desde __dirname al inicio del módulo). Las vars de userData tienen
  // prioridad sobre las del proyecto (override=true para esta segunda carga).
  const userDataPath = app.getPath('userData');
  dotenv.config({ path: path.join(userDataPath, '.env'), override: true });

  ensureLLMConfig();

  const keychainAvail = KeychainManager.isAvailable();
  console.log(`[config] fuente de keys: ${_keySource} | llavero del SO: ${keychainAvail ? 'disponible' : 'no disponible'}`);

  MarchCore.init(app);

  MarchCore.getEventBus().on('openclaw:available', (payload) => {
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.webContents.send('openclaw-status', payload);
    }
  });

  MarchCore.getEventBus().on('workspace:changed', (payload) => {
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.webContents.send('workspace-changed', payload);
    }
  });

  MarchCore.getEventBus().on('plan:started', (payload) => {
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.webContents.send('plan-started', payload);
    }
  });

  MarchCore.getEventBus().on('plan:finished', (payload) => {
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.webContents.send('plan-finished', payload);
    }
  });

  MarchCore.onInitiative((payload) => {
    const chatVisible = chatWindow && !chatWindow.isDestroyed() && chatWindow.isVisible();
    if (chatVisible) {
      chatWindow.webContents.send('march-initiative', payload);
      return;
    }
    if (payload.openChat) {
      createChatWindow();
      const sendWhenReady = () => {
        if (chatWindow && !chatWindow.isDestroyed()) {
          setTimeout(() => {
            if (chatWindow && !chatWindow.isDestroyed()) {
              chatWindow.webContents.send('march-initiative', payload);
            }
          }, 800);
        }
      };
      if (chatWindow && !chatWindow.isDestroyed()) {
        chatWindow.webContents.once('did-finish-load', sendWhenReady);
        setTimeout(sendWhenReady, 1000);
      }
    } else {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('speak', payload.suggestion);
      }
    }
  });

  createWindow();
  createTray();
  startControlServer();
  createChatWindow();

  // Auto-init: escanear proyecto al arrancar y guardar contexto
  _autoInitProject();

  // NUEVO (multiplataforma): en Linux con GNOME (el escritorio más común,
  // p.ej. Ubuntu de fábrica), Electron NO puede mostrar el ícono de la
  // bandeja del sistema sin que el usuario instale la extensión "AppIndicator
  // and KStatusNotifierItem Support" — sin eso, el tray de arriba
  // (createTray()) queda invisible y el usuario se queda sin forma de
  // llegar a "Cerrar todo". Este atajo es un respaldo para no dejar a
  // nadie sin poder cerrar la app. También sirve en Windows/macOS como
  // atajo rápido — no reemplaza al tray, solo evita que sea la ÚNICA
  // salida en Linux/GNOME.
  const shortcutOk = globalShortcut.register('CommandOrControl+Shift+Q', () => app.quit());
  if (!shortcutOk) {
    console.warn('[march7th] no se pudo registrar el atajo global de salida (Ctrl/Cmd+Shift+Q) — probablemente ya lo usa otra app.');
  }

  screen.on('display-metrics-changed', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!userHasMoved) mainWindow.setBounds(getBottomRightBounds());
  });
});

// ── Cierre limpio ─────────────────────────────────────────────────────────────
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(resolve, ms)),
  ]);
}

let _quitting = false;

app.on('before-quit', (event) => {
  if (_quitting) return;
  event.preventDefault();
  (async () => {
    try { await withTimeout(MarchCore.closeSession(), 8000); } catch(_) {}
    try { await withTimeout(MarchCore.shutdown(), 8000); } catch(_) {}
    _quitting = true;
    app.quit();
  })();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// NUEVO: liberar el atajo global registrado arriba — buena práctica de
// Electron para no dejarlo "pegado" a nivel de SO si algo falla.
app.on('will-quit', () => { globalShortcut.unregisterAll(); });
