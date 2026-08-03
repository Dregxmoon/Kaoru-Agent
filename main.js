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
const crypto = require('crypto');

const Core = require('./core/Core.js');
const KeychainManager = require('./infrastructure/keychain/KeychainManager.js');

// Fija el nombre interno de la app ANTES de que se lea userData: package.json
// ahora usa branding neutral (productName "Asistente Personal"), pero la carpeta
// de datos (config.json, core.db) se mantiene en ~/.config/vtuber-overlay para
// no perder la configuración y memoria existentes del usuario.
app.setName('vtuber-overlay');

// ── Manejo global de errores ──────────────────────────────────────────────────
// Antes no había NINGÚN handler de uncaughtException/unhandledRejection — un
// error async sin catch (p.ej. una promesa rechazada en un handler de IPC)
// podía tirar el proceso principal entero sin dejar rastro visible, porque
// esto corre casi siempre desde la bandeja del sistema sin consola abierta.
// Ahora se registra en un log persistente para poder diagnosticar qué pasó,
// pero NO se fuerza el cierre — la mayoría de estos errores son recuperables
// y el asistente es una app "siempre presente", no queremos que un solo handler
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
//   1. Variable de entorno ASISTENTE_PYTHON_BIN (override manual si hace falta)
//   2. El launcher estándar de Windows `py -3` (viene con casi cualquier
//      instalación oficial de Python en Windows)
//   3. `python` / `python3` si están en el PATH
//   4. Barrido de las carpetas de instalación típicas bajo el HOME del
//      usuario ACTUAL (os.homedir(), no un usuario fijo), tomando la versión
//      más alta encontrada
// Se resuelve una sola vez al arrancar y se cachea.
function resolvePythonBin() {
  if (process.env.ASISTENTE_PYTHON_BIN && fs.existsSync(process.env.ASISTENTE_PYTHON_BIN)) {
    console.log('[python] usando override ASISTENTE_PYTHON_BIN:', process.env.ASISTENTE_PYTHON_BIN);
    return process.env.ASISTENTE_PYTHON_BIN;
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

  console.warn('[python] no se encontró ningún intérprete de Python. La voz y el STT local no van a funcionar hasta que instales Python o definas ASISTENTE_PYTHON_BIN.');
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

const VIEW_NAMES = ['full', 'half', 'head'];

const savedConfig    = loadConfig();
chatTheme            = savedConfig.chatTheme ?? 'dark';

const maskedConfig = JSON.parse(JSON.stringify(savedConfig));
if (maskedConfig.llm?.apiKeys) {
  for (const k of Object.keys(maskedConfig.llm.apiKeys)) {
    if (maskedConfig.llm.apiKeys[k]) maskedConfig.llm.apiKeys[k] = '***';
  }
}
console.log('[asistente] config cargada:', maskedConfig);

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

function sendSpeak(text, emotion) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('speak', emotion ? { text, emotion } : text);
}

// Gestos Live2D: main traduce eventos globales (iniciativa, propuestas, planes)
// a moods y los reenvía al overlay. La ventana de chat gestiona los suyos en el
// renderer (tiene sus propios hooks de eventos del chat) — así cada ventana
// anima su modelo sin duplicar disparos.
function sendOverlayGesture(mood, meta = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('gesture', { mood, ...meta });
}

ipcMain.handle('gesture-config', () => savedConfig.gestures || null);

// ── Ventana overlay ───────────────────────────────────────────────────────────
function createWindow() {
  const mode = getModelViewMode(activeModelId);
  currentView = mode === 'random'
    ? VIEW_NAMES[Math.floor(Math.random() * VIEW_NAMES.length)]
    : mode;

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
      Core.setChatOpen(true);
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

  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();

  const sessionPromise = Core.startSession().catch(e => { console.error('[session] error:', e.message); return null; });
  Core.setChatOpen(true);

  chatWindow.webContents.once('did-finish-load', () => {
    chatWindow.webContents.send('init-theme', chatTheme);

    const usingFallback = Core.getGraph()?.usingFallback ?? false;
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

  chatWindow.on('closed', () => {
    Core.closeSession().catch(e => console.error('[session] close error:', e.message));
    Core.setChatOpen(false);
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
    Core.setChatOpen(false);
    if (tray) tray.setContextMenu(buildTrayMenu());
  } else {
    chatWindow.show(); chatWindow.focus();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
    Core.setChatOpen(true);
    if (tray) tray.setContextMenu(buildTrayMenu());
  }
}

// ── Tray ──────────────────────────────────────────────────────────────────────
function buildTrayMenu() {
  const chatOpen = chatWindow && !chatWindow.isDestroyed() && chatWindow.isVisible();
  const mode = getModelViewMode(activeModelId);
  return Menu.buildFromTemplate([
    { label: chatOpen ? 'Cerrar chat' : 'Abrir chat', click: toggleChatWindow },
    { type: 'separator' },
    { label: isClickThrough ? 'Bloquear (mover overlay)' : 'Pasar clics', click: () => setClickThrough(!isClickThrough) },
    { type: 'separator' },
    { label: `${mode === 'full' ? '> ' : ''}Cuerpo completo`, click: () => applyViewMode('full') },
    { label: `${mode === 'half' ? '> ' : ''}Medio cuerpo`,    click: () => applyViewMode('half') },
    { label: `${mode === 'head' ? '> ' : ''}Solo cabeza`,     click: () => applyViewMode('head') },
    { label: `${mode === 'random' ? '> ' : ''}Aleatorio`,     click: () => applyViewMode('random') },
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
  tray.setToolTip('Asistente personal');
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
  console.log('[main] chat cerrado — saliendo del asistente');
  app.quit();
});

ipcMain.on('chat-theme-changed', (e, theme) => { chatTheme = theme; saveConfig({ chatTheme: theme }); });

// ── IPC: modelo Live2D ─────────────────────────────────────────────────────────
const MODELS_DIR = path.join(__dirname, 'models');
let activeModelId = savedConfig.activeModel || 'March 7th';

function listModels() {
  const models = [];
  if (!fs.existsSync(MODELS_DIR)) return models;
  for (const entry of fs.readdirSync(MODELS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const folder = path.join(MODELS_DIR, entry.name);
    let model3 = null;
    try {
      model3 = fs.readdirSync(folder).find(f => f.endsWith('.model3.json')) || null;
    } catch {}
    if (model3) {
      models.push({
        id: entry.name,
        name: entry.name,
        model3Path: path.join(folder, model3),
        active: entry.name === activeModelId,
      });
    }
  }
  return models;
}

function getActiveModel() {
  const models = listModels();
  return models.find(m => m.active) || models[0] || null;
}

function setActiveModel(id) {
  if (!listModels().find(m => m.id === id)) return false;
  activeModelId = id;
  saveConfig({ activeModel: id });
  return true;
}

function broadcastModelChanged() {
  const info = getActiveModel();
  if (!info) return;
  const payload = { ...info, models: listModels() };
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('model-changed', payload);
  if (chatWindow && !chatWindow.isDestroyed()) chatWindow.webContents.send('model-changed', payload);
  broadcastViewsChanged();
}

ipcMain.handle('models-list', () => listModels());

ipcMain.handle('get-model-info', () => getActiveModel());

ipcMain.handle('model-set', (e, { id } = {}) => {
  if (!setActiveModel(id)) return { error: 'Modelo no encontrado: ' + id };
  broadcastModelChanged();
  return { ok: true, info: getActiveModel() };
});

ipcMain.handle('model-import', (e, { folderPath } = {}) => {
  if (!folderPath || typeof folderPath !== 'string') return { error: 'Ruta inválida.' };
  if (!fs.existsSync(folderPath)) return { error: 'La ruta no existe: ' + folderPath };

  let model3Rel = null;
  const walk = (dir, depth) => {
    if (depth > 2 || model3Rel) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (model3Rel) return;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), depth + 1);
      else if (entry.name.endsWith('.model3.json')) model3Rel = path.join(dir, entry.name);
    }
  };
  walk(folderPath, 0);
  if (!model3Rel) return { error: 'No se encontró un archivo .model3.json en la carpeta.' };

  const id = path.basename(folderPath);
  const dest = path.join(MODELS_DIR, id);
  try {
    fs.cpSync(folderPath, dest, { recursive: true });
  } catch (err) {
    return { error: 'No se pudo copiar el modelo: ' + err.message };
  }
  if (!setActiveModel(id)) return { error: 'No se pudo activar el modelo importado.' };
  broadcastModelChanged();
  return { ok: true, info: getActiveModel() };
});

// ── Modo de vista del modelo (full | half | head | random) ────────────────────
const VIEW_MODES = ['full', 'half', 'head', 'random'];

function getModelViewMode(id) {
  const saved = (savedConfig.modelViews && savedConfig.modelViews[id]) || {};
  const m = saved.mode;
  return VIEW_MODES.includes(m) ? m : 'random';
}

function saveModelViewMode(id, mode) {
  const cfg = loadConfig();
  const mv = cfg.modelViews || {};
  mv[id] = { mode };
  saveConfig({ modelViews: mv });
  savedConfig.modelViews = mv;
}

function currentViewsState() {
  return { modelId: activeModelId, mode: getModelViewMode(activeModelId), activeView: currentView };
}

function broadcastViewsChanged() {
  const payload = currentViewsState();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('views-changed', payload);
  if (chatWindow && !chatWindow.isDestroyed()) chatWindow.webContents.send('views-changed', payload);
}

function applyViewMode(mode, { broadcast = true } = {}) {
  if (!VIEW_MODES.includes(mode)) return { error: `Modo inválido: ${mode}` };
  saveModelViewMode(activeModelId, mode);
  if (mode !== 'random') {
    currentView = mode;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('set-view', mode);
  }
  if (broadcast) broadcastViewsChanged();
  if (tray) tray.setContextMenu(buildTrayMenu());
  return { ok: true, ...currentViewsState() };
}

ipcMain.handle('views-get', () => currentViewsState());

ipcMain.handle('views-set', (e, { mode } = {}) => applyViewMode(mode));

ipcMain.handle('views-reset', () => applyViewMode('random'));

// FIX — antes este handler duplicaba ~30 líneas de SQL (CREATE TABLE,
// DELETE, INSERT) que ya existían en init_vectors.js, y esa copia NO
// tenía el fix de rowid explícito (intent_vectors.rowid = intent_catalog.id)
// que sí tiene la v2 de init_vectors.js — es decir, esta copia inline
// podía desincronizar las tablas igual que la versión vieja del otro
// archivo. Ahora delega TODO a populateDatabase(), que vive en un solo
// lugar (init_vectors.js) y ya incluye ese fix.
ipcMain.handle('init-vectors', async () => {
  const { populateDatabase } = require('./infrastructure/database/init_vectors.js');
  const db = Core.getGraph()?._db;
  if (!db) throw new Error('DB no disponible');

  const result = await populateDatabase(db, { force: true });

  const count = result.populated
    ? result.inserted
    : result.existing;

  console.log(`[init-vectors] ${count} frases en ${Core.getGraph()?._dbPath ?? 'N/A'}`);
  return `${count} frases vectorizadas`;
});



// ── IPC: memoria ──────────────────────────────────────────────────────────────
ipcMain.on('memory-add-turn', (e, { role, content }) => {
  Core.addTurn(role, content);
  if (role === 'user') Core.detectInstant(content);
});

ipcMain.handle('memory-stats', () => Core.getStats());

// ── IPC: decisión de propuesta proactiva (Fase A) ────────────────────────────
// El renderer envía el voto del usuario (aceptar/descartar) sobre una
// propuesta proactiva. Core lo reenvía al ProactiveEngine, que persiste
// el feedback y ajusta la frecuencia futura de ese tipo.
ipcMain.on('initiative-decision', (e, decision) => {
  Core.handleProposalDecision(decision);
});

// ── IPC: grounding ────────────────────────────────────────────────────────────
// FIX Fase 3: async/await porque buildContext ahora es async
// (necesita await para IntentDetector.detect())
ipcMain.handle('grounding-build-context', async (e, { sessionHistory, activeProvider, mode, plan }) => {
  const ctx = await Core.buildContext(sessionHistory, activeProvider, { mode, plan });
  console.log('[grounding-ipc] provider:', activeProvider, '| mode:', mode || 'chat', '| systemPrompt:', ctx?.systemPrompt?.length, 'chars');
  return ctx;
});

// Genera un plan (fase 1 del sistema de dos fases). Usa Core.generatePlan()
// internamente: construye contexto en modo 'plan', llama al LLM y parsea el plan.
ipcMain.handle('generate-plan', async (e, { sessionHistory, userGoal }) => {
  const taskDetector = Core.getTaskDetector?.();
  const taskIntent = taskDetector ? taskDetector.detect(userGoal) : null;
  const result = await Core.generatePlan(userGoal, taskIntent, sessionHistory);
  return result;
});

// ── IPC: OS Sensor ────────────────────────────────────────────────────────────
ipcMain.handle('os-get-context', () => {
  return Core.getOSSensor()?.getCurrentContext() ?? null;
});

ipcMain.handle('os-get-today-history', () => {
  return Core.getOSSensor()?.getTodayHistory() ?? [];
});

ipcMain.handle('os-get-today-summary', () => {
  return Core.getOSSensor()?.getTodaySummary() ?? null;
});

ipcMain.handle('get-stats', () => {
  return Core.getStats();
});

// Fase C: /olvida X — archiva nodos de memoria que matcheen el texto.
ipcMain.handle('memory-forget', (e, { text } = {}) => Core.forgetMemory(text));

ipcMain.handle('list-skills', () => Core.listSkills());
ipcMain.handle('store-fact', (e, fact) => Core.storeFact(fact));

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
  Core.reloadLLMConfig();
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
  const msg = await Core.forceProactive(triggerType || 'long_silence');
  return msg || null;
});

// ── IPC: Fase 3 — OpenClaw ────────────────────────────────────────────────────

ipcMain.handle('openclaw-available', async () => {
  return Core.isOpenClawAvailable();
});

ipcMain.handle('openclaw-execute-tool', async (e, { tool, params }) => {
  console.log(`[main] openclaw-execute-tool: ${tool}`);
  try {
    const result = await Core.executeTool(tool, params);
    return result;
  } catch (err) {
    console.error('[main] error en executeTool:', err.message);
    return { ok: false, error: err.message, tool, result: null, elapsed: 0 };
  }
});

ipcMain.handle('openclaw-parse-plan', (e, { llmResponse, userGoal, toolIntent }) => {
  try {
    const plan = Core.parsePlanFromResponse(llmResponse, userGoal, toolIntent ?? null);
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
    const executedPlan = await Core.executePlan(plan, {

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

// ── IPC: agent-run (loop cerrado con herramientas; el modo fast/smart lo
//    elige Core automáticamente según la intención detectada)
ipcMain.handle('agent-run', async (e, { text }) => {
  console.log(`[main] agent-run: text="${text?.slice(0, 80)}"`);

  if (!text || !text.trim()) {
    return { response: null, iterations: 0, toolResults: [], error: 'texto vacío' };
  }

  try {
    const result = await Core.runAgent(text, {

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
  return Core.getPlanner()?.getHistory(20) ?? [];
});

// ── MCP ────────────────────────────────────────────────────────────────────────
// Independiente de OpenClaw — estos handlers funcionan aunque mock-openclaw
// no esté corriendo. La config (qué servidores hay, cuáles están enabled)
// vive en config.json bajo `mcp.servers`, igual que las apiKeys de LLM.

ipcMain.handle('pick-workspace-folder', async () => {
  const result = await dialog.showOpenDialog(chatWindow, { properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths.length) return null;
  return Core.setActiveWorkspace(result.filePaths[0]);
});

ipcMain.handle('get-workspace', () => {
  try { return Core.getWorkspace(); }
  catch (err) { console.warn('[main] error en get-workspace:', err.message); return null; }
});

ipcMain.handle('mcp-list-servers', async () => {
  try { return await Core.mcpListServers(); }
  catch (err) { console.error('[main] error en mcp-list-servers:', err.message); return { error: err.message }; }
});

ipcMain.handle('mcp-list-tools', () => {
  try { return Core.mcpListAllTools(); }
  catch (err) { console.error('[main] error en mcp-list-tools:', err.message); return { error: err.message }; }
});

ipcMain.handle('mcp-search-registry', async (e, { query }) => {
  try { return await Core.mcpSearchRegistry(query || ''); }
  catch (err) { console.error('[main] error en mcp-search-registry:', err.message); return { error: err.message }; }
});

// Agrega un servidor y lo persiste en config.json. `serverCfg` trae al
// menos { name, command, args, env? }. Se conecta de inmediato para poder
// mostrarle al usuario si funcionó o no.
ipcMain.handle('mcp-add-server', async (e, { serverCfg }) => {
  try {
    const status = await Core.mcpAddServer(serverCfg);
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
    await Core.mcpRemoveServer(id);
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

    await Core.mcpToggleServer(id, enabled, serverCfg);

    const updated = servers.map(s => s.id === id ? { ...s, enabled } : s);
    saveConfig({ mcp: { servers: updated } });
    return { ok: true };
  } catch (err) {
    console.error('[main] error en mcp-toggle-server:', err.message);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('telemetry-report', () => {
  return Core.getTelemetryReport();
});

ipcMain.handle('fase3-stats', () => {
  const stats = Core.getStats();
  return {
    openclaw: stats.openclaw,
    planner:  stats.planner,
    provider: stats.provider,
  };
});

ipcMain.handle('get-bridge-stats', () => {
  try {
    const stats = Core.getStats();
    return stats.openclaw || { error: 'no disponible' };
  } catch (e) {
    return { error: `Core no inicializado: ${e.message}` };
  }
});

// Antes: cualquier string llegaba directo a exec(). Solo /undo y /fix lo
// invocan hoy, y siempre con uno de estos 3 comandos fijos — pero el canal
// IPC en sí no sabía eso, aceptaba cualquier cosa. Con nodeIntegration:true
// (ver ticket de contextIsolation), cualquier XSS en el renderer puede
// llamar a ipcRenderer.invoke('exec-command', {...}) directamente sin
// pasar por /undo ni /fix — así que la restricción tiene que vivir acá,
// del lado main, no confiar en que solo la UI lo invoque bien.
const EXEC_COMMAND_ALLOWLIST = new Set([
  'git log --oneline -1',
  'git reset --soft HEAD~1',
  'npx eslint . --format compact 2>&1 || true',
]);

ipcMain.handle('exec-command', async (e, { command, timeout }) => {
  if (!EXEC_COMMAND_ALLOWLIST.has(command)) {
    return { exitCode: 1, stdout: '', stderr: `comando no permitido: ${JSON.stringify(command)}` };
  }
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
const VALID_VIEWS    = ['full','half','head','random'];

// Token generado al arrancar — sin esto, cualquier página web abierta en
// el navegador del usuario podía disparar estos endpoints en silencio con
// un simple <img src="http://localhost:3131/workspace?path=...">, porque
// eran GET sin auth, sin CORS y sin validar Origin. Se genera y se usa acá
// mismo, en la misma función — a propósito, para no repetir el bug de
// OpenClawBridge donde la key se leía de process.env en un momento
// distinto (require-time) a cuando se generaba (runtime), dejando al
// cliente con una key vieja/nula.
const CONTROL_API_TOKEN = crypto.randomBytes(24).toString('hex');

const HELP_TEXT = `
  Asistente personal — Control API (puerto 3131)
  Requiere ?token=${CONTROL_API_TOKEN} en cada request (ver consola al
  arrancar la app, o infrastructure/keychain para guardarlo vos mismo).

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
  // Capa 1: token obligatorio, comparación en tiempo constante.
  const provided = url.searchParams.get('token') || '';
  const bufA = Buffer.from(provided, 'utf8');
  const bufB = Buffer.from(CONTROL_API_TOKEN, 'utf8');
  const tokenOk = bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
  if (!tokenOk) return false;

  // Capa 2: si la request trae Origin/Referer, tiene que ser de una fuente
  // nuestra. curl y scripts normalmente no mandan Origin — una página web
  // en un navegador normal, sí. Esto bloquea el vector <img src="...">
  // aunque alguien filtrara el token (defensa en profundidad, no la
  // barrera principal).
  const origin = req.headers['origin'] || req.headers['referer'] || '';
  if (origin && !/^(https?:\/\/)?(localhost|127\.0\.0\.1)([:/]|$)/i.test(origin)) {
    return false;
  }
  return true;
}

function startControlServer() {
  console.log(`[asistente] Control API token: ${CONTROL_API_TOKEN}`);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost:3131');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    if (url.pathname !== '/help' && !_controlAuthOk(req, url)) {
      res.writeHead(401); res.end('unauthorized — falta o es inválido ?token='); return;
    }
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
      applyViewMode(v); res.writeHead(200); res.end(`ok: ${v}`); return;
    }
    if (url.pathname === '/chat') {
      const action = (url.searchParams.get('action') || '').toLowerCase();
      if (action === 'open') createChatWindow();
      else if (action === 'close') {
        console.log('[asistente] Control API: cerrando asistente');
        app.quit();
      } else toggleChatWindow();
      res.writeHead(200); res.end(`ok: chat ${action || 'toggled'}`); return;
    }
    if (url.pathname === '/workspace') {
      const p = url.searchParams.get('path');
      if (!p) { res.writeHead(400); res.end('falta ?path='); return; }
      Core.setActiveWorkspace(p).then(result => {
        res.writeHead(result.ok ? 200 : 400);
        res.end(result.ok ? `ok: workspace -> ${result.path}` : `error: ${result.error}`);
      }).catch(err => {
        res.writeHead(500); res.end(`error: ${err.message}`);
      });
      return;
    }
    // Debug del flujo proactivo (Fase B) — local y autenticado:
    //   /debug/git-scan → fuerza el scan del GitWatcher (dispara el trigger real)
    //   /debug/proposal?accept=1|0 → resuelve la última propuesta emitida
    if (url.pathname === '/debug/git-scan') {
      Core.debugGitScan().then(r => {
        res.writeHead(r.ok ? 200 : 500);
        res.end(r.ok ? `ok: scan git realizado\n${JSON.stringify(r.stats, null, 2)}` : `error: ${r.error}`);
      }).catch(err => {
        res.writeHead(500); res.end(`error: ${err.message}`);
      });
      return;
    }
    if (url.pathname === '/debug/proposal') {
      const accept = url.searchParams.get('accept') === '1';
      const r = Core.debugResolveLastProposal(accept);
      res.writeHead(r.ok ? 200 : 400);
      res.end(r.ok
        ? `ok: propuesta ${accept ? 'aceptada' : 'rechazada'} (${r.proposal.type})`
        : `error: ${r.error}`);
      return;
    }
    // Fase D: fuerza el scan de errores LSP (dispara el trigger real del sensor)
    if (url.pathname === '/debug/lsp-scan') {
      Core.debugLSPScan().then(r => {
        res.writeHead(r.ok ? 200 : 500);
        res.end(r.ok ? `ok: scan LSP realizado\n${JSON.stringify(r.stats, null, 2)}` : `error: ${r.error}`);
      }).catch(err => {
        res.writeHead(500); res.end(`error: ${err.message}`);
      });
      return;
    }
    // Fase E: reporte de telemetría "¿mejor que el mes pasado?" (datos locales)
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
    res.writeHead(200); res.end(HELP_TEXT);
  });
  server.listen(3131, '127.0.0.1', () => console.log('[asistente] API lista → http://localhost:3131/help'));
  server.on('error', (e) => { if (e.code === 'EADDRINUSE') console.log('[asistente] puerto 3131 ocupado.'); });
}

// ── Auto-init ─────────────────────────────────────────────────────────────────
// Escanea el proyecto activo al arrancar y guarda un nodo 'Project' con su
// contexto, para que el asistente recuerde sobre qué repo está trabajando sin que
// el usuario tenga que pedírselo. Fire-and-forget: cualquier fallo se loguea
// en crash.log pero nunca rompe el arranque (antes esta llamada estaba
// huérfana — apuntaba a una función inexistente y tiraba un ReferenceError).
async function _autoInitProject() {
  try {
    const userDataPath = app.getPath('userData');
    let workspace = process.env.ASISTENTE_WORKSPACE;
    if (!workspace && fs.existsSync(path.join(userDataPath, 'config.json'))) {
      try {
        const cfg = JSON.parse(fs.readFileSync(path.join(userDataPath, 'config.json'), 'utf-8'));
        if (cfg.activeWorkspace) workspace = cfg.activeWorkspace;
      } catch (_) { /* config inválida, seguir con default */ }
    }
    const root = workspace || app.getAppPath() || process.cwd();
    if (!root || !fs.existsSync(root)) return;

    let summary = `Proyecto activo: ${root}`;
    const pkgPath = path.join(root, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg.name)        summary += `\nNombre: ${pkg.name}`;
        if (pkg.description) summary += `\nDescripción: ${pkg.description}`;
      } catch (_) { /* no es un proyecto npm, ignorar */ }
    }

    const label = `Proyecto: ${path.basename(root)}`;

    // No recrear el nodo en cada arranque: si ya existe un nodo 'Project'
    // activo con esta etiqueta, lo actualizamos en vez de insertar otro
    // (antes cada boot insertaba uno nuevo que el dedup de
    // ContradictionResolver archivaba después — churn innecesario en la DB).
    const graph = Core.getGraph();
    if (graph?.isReady && graph._db) {
      const existing = graph.queryNodes({ type: 'Project', search: label, limit: 1 });
      if (existing && existing.length > 0) {
        try {
          graph.updateNode(existing[0].id, { content: summary, importance: 0.9 });
          return;
        } catch (_) { /* si falla la actualización, cae a crear de nuevo */ }
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
    console.warn('[asistente] auto-init de proyecto falló:', e.message);
  }
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

  Core.init(app);

  Core.getEventBus().on('openclaw:available', (payload) => {
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.webContents.send('openclaw-status', payload);
    }
  });

  Core.getEventBus().on('workspace:changed', (payload) => {
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.webContents.send('workspace-changed', payload);
    }
  });

  Core.getEventBus().on('plan:started', (payload) => {
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.webContents.send('plan-started', payload);
    }
    sendOverlayGesture('think', { source: 'plan-started' });
  });

  Core.getEventBus().on('plan:finished', (payload) => {
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.webContents.send('plan-finished', payload);
    }
    sendOverlayGesture('happy', { source: 'plan-finished' });
  });

  Core.onInitiative((payload) => {
    sendOverlayGesture('excited', { source: 'initiative' });
    const chatVisible = chatWindow && !chatWindow.isDestroyed() && chatWindow.isVisible();
    if (chatVisible) {
      chatWindow.webContents.send('initiative', payload);
      return;
    }
    if (payload.openChat) {
      createChatWindow();
      const sendWhenReady = () => {
        if (chatWindow && !chatWindow.isDestroyed()) {
          setTimeout(() => {
            if (chatWindow && !chatWindow.isDestroyed()) {
              chatWindow.webContents.send('initiative', payload);
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

  // Fase B: resultado real de ejecutar una propuesta proactiva — se muestra
  // en el bubble de la propuesta (solo si esa ventana existe).
  Core.onProposalResult((payload) => {
    sendOverlayGesture(payload.ok ? 'happy' : 'sad', { source: 'proposal-result' });
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.webContents.send('proposal-result', payload);
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
    console.warn('[asistente] no se pudo registrar el atajo global de salida (Ctrl/Cmd+Shift+Q) — probablemente ya lo usa otra app.');
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
  _quitting = true;
  (async () => {
    try { await withTimeout(Core.shutdown(), 8000); }
    catch (e) { console.error('[main] shutdown con errores:', e && e.message ? e.message : e); }
    app.quit();
  })();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// NUEVO: liberar el atajo global registrado arriba — buena práctica de
// Electron para no dejarlo "pegado" a nivel de SO si algo falla.
app.on('will-quit', () => { globalShortcut.unregisterAll(); });