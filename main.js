const {
  app, BrowserWindow, ipcMain, screen,
  Tray, Menu, nativeImage, session
} = require('electron');
const path = require('path');
const http = require('http');
const fs   = require('fs');
const os   = require('os');
const { URL } = require('url');
const { spawnSync } = require('child_process');

const MarchCore = require('./core/MarchCore.js');

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

function saveConfig(data) {
  try {
    const merged = { ...loadConfig(), ...data };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf-8');
  } catch (e) { console.log('[config] error guardando config.json:', e.message); }
}

function ensureLLMConfig() {
  const cfg = loadConfig();
  if (!cfg.llm) {
    saveConfig({ llm: { primary: 'groq', apiKeys: { groq: '', gemini: '', openai: '' }, fallback: ['gemini', 'openai'] } });
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
let selectedMicIndex = savedConfig.micIndex  ?? null;
let selectedMicLabel = savedConfig.micLabel  ?? 'default';
chatTheme            = savedConfig.chatTheme ?? 'dark';
chatMode             = savedConfig.chatMode  ?? 'conversational';

console.log('[march7th] config cargada:', savedConfig);

if (process.platform === 'linux')
  app.commandLine.appendSwitch('enable-transparent-visuals');

// ── Permisos globales de micrófono ────────────────────────────────────────────
function setupMicPermissions() {
  const ses = session.defaultSession;

  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = ['media', 'microphone', 'audioCapture', 'getUserMedia'];
    console.log(`[permisos] ${permission} → ${allowed.includes(permission) ? 'OK' : 'deny'}`);
    callback(allowed.includes(permission));
  });

  ses.setPermissionCheckHandler((webContents, permission) => {
    const allowed = ['media', 'microphone', 'audioCapture', 'getUserMedia'];
    return allowed.includes(permission);
  });

  console.log('[march7th] permisos de micrófono configurados');
}

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
  mainWindow.webContents.on('console-message', (e, level, msg) => console.log(`[overlay] ${msg}`));
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
  chatWindow.webContents.on('console-message', (e, level, msg) => console.log(`[chat] ${msg}`));

  chatWindow.webContents.once('did-finish-load', () => {
    chatWindow.webContents.send('init-theme', chatTheme);
    chatWindow.webContents.send('init-mode', chatMode);
    if (selectedMicIndex !== null)
      chatWindow.webContents.send('restore-mic', { index: selectedMicIndex, label: selectedMicLabel });

    const usingFallback = MarchCore.getGraph()?.usingFallback ?? false;
    chatWindow.webContents.send('memory-status', { usingFallback });
  });

  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();

  MarchCore.startSession().catch(e => console.error('[session] error:', e.message));
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
    { label: chatOpen ? '💬 Cerrar chat' : '💬 Abrir chat', click: toggleChatWindow },
    { type: 'separator' },
    { label: isClickThrough ? '🔒 Bloquear (mover overlay)' : '🖱️ Pasar clics', click: () => setClickThrough(!isClickThrough) },
    { type: 'separator' },
    { label: `${currentView === 'full' ? '✓ ' : ''}Cuerpo completo`, click: () => sendView('full') },
    { label: `${currentView === 'half' ? '✓ ' : ''}Medio cuerpo`,    click: () => sendView('half') },
    { label: `${currentView === 'head' ? '✓ ' : ''}Solo cabeza`,     click: () => sendView('head') },
    { type: 'separator' },
    { label: '🔊 Prueba de voz', submenu: [
      { label: 'Saludo',      click: () => sendSpeak('Hola! Estoy aqui para ayudarte!') },
      { label: 'Emocion sad', click: () => sendSpeak('Lo siento, hubo un error.', 'sad') },
      { label: 'Excited',     click: () => sendSpeak('Perfecto, todo salio bien!', 'excited') },
    ]},
    { type: 'separator' },
    { label: `🎙 Mic: ${selectedMicLabel}`, enabled: false },
    { type: 'separator' },
    { label: '📌 Volver a esquina', click: () => { userHasMoved = false; mainWindow.setBounds(getBottomRightBounds()); } },
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

ipcMain.on('voice-command', (e, { action, text }) => {
  console.log(`[march7th] voice-command: ${action}`, text || '');
  if (action === 'open-chat') {
    if (!chatWindow || chatWindow.isDestroyed() || !chatWindow.isVisible()) createChatWindow();
  } else if (action === 'close-chat') {
    if (chatWindow && !chatWindow.isDestroyed() && chatWindow.isVisible()) {
      chatWindow.hide();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
      MarchCore.setChatOpen(false);
      if (tray) tray.setContextMenu(buildTrayMenu());
    }
  } else if (action === 'message' && text) {
    if (chatWindow && !chatWindow.isDestroyed()) chatWindow.webContents.send('chat-message', text);
  }
});

ipcMain.on('set-mic-index', (e, { index, label }) => {
  console.log(`[march7th] micrófono: [${index}] ${label}`);
  selectedMicIndex = index; selectedMicLabel = label;
  saveConfig({ micIndex: index, micLabel: label });
  if (tray) tray.setContextMenu(buildTrayMenu());
  restartVoiceListener(index);
});

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
  const db = MarchCore.getGraph()._db;
  if (!db) throw new Error('DB no disponible');

  const result = await populateDatabase(db, { force: true });

  const count = result.populated
    ? result.inserted
    : result.existing;

  console.log(`[init-vectors] ${count} frases en ${MarchCore.getGraph()._dbPath}`);
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
ipcMain.handle('grounding-build-context', async (e, { sessionHistory, activeProvider }) => {
  const ctx = await MarchCore.buildContext(sessionHistory, activeProvider);
  console.log('[grounding-ipc] provider:', activeProvider, '| systemPrompt:', ctx?.systemPrompt?.length, 'chars');
  return ctx;
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

// ── IPC: config y keys ────────────────────────────────────────────────────────
ipcMain.handle('get-config', () => loadConfig());

ipcMain.handle('save-llm-keys', (e, { groq, gemini, openai }) => {
  saveConfig({ llm: { primary: 'groq', apiKeys: { groq, gemini, openai }, fallback: ['gemini', 'openai'] } });
  console.log('[config] keys LLM actualizadas');
  MarchCore.reloadLLMConfig();
  return true;
});

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

ipcMain.handle('openclaw-plan-history', () => {
  return MarchCore.getPlanner()?.getHistory(20) ?? [];
});

ipcMain.handle('fase3-stats', () => {
  const stats = MarchCore.getStats();
  return {
    openclaw: stats.openclaw,
    planner:  stats.planner,
    provider: stats.provider,
  };
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
    if (url.pathname === '/mic') {
      const idx = parseInt(url.searchParams.get('index') || '-1', 10);
      if (idx >= 0) restartVoiceListener(idx);
      res.writeHead(200); res.end(`ok: mic index ${idx}`); return;
    }
    res.writeHead(200); res.end(HELP_TEXT);
  });
  server.listen(3131, '127.0.0.1', () => console.log('[march7th] API lista → http://localhost:3131/help'));
  server.on('error', (e) => { if (e.code === 'EADDRINUSE') console.log('[march7th] puerto 3131 ocupado.'); });
}

// ── Voice Listener (Python) ───────────────────────────────────────────────────
const { spawn } = require('child_process');
const VOICE_COMMANDS_OPEN  = ['abre el chat','abre chat','abrir chat','muestra el chat','abre la ventana','chat'];
const VOICE_COMMANDS_CLOSE = ['cierra el chat','cierra chat','cerrar chat','oculta el chat'];
let voiceProc = null, voiceRestartTimer = null;

function startVoiceListener(micIndex = null) {
  const scriptPath = path.join(__dirname, 'voice_listener.py');
  if (!fs.existsSync(scriptPath)) { console.log('[voice] voice_listener.py no encontrado.'); return; }
  const args = [scriptPath];
  if (micIndex !== null && micIndex >= 0) args.push('--mic-index', String(micIndex));
  voiceProc = spawn(PYTHON_BIN, args, {
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
  });
  voiceProc.stdout.on('data', (data) => {
    data.toString().split('\n').filter(l => l.trim()).forEach(line => {
      try { handleVoiceEvent(JSON.parse(line)); } catch(_) {}
    });
  });
  voiceProc.stderr.on('data', (d) => console.log('[voice stderr]', d.toString().trim()));
  voiceProc.on('close', (code) => {
    console.log(`[voice] proceso terminado (code ${code}), reiniciando en 3s...`);
    voiceProc = null;
    if (voiceRestartTimer) clearTimeout(voiceRestartTimer);
    voiceRestartTimer = setTimeout(() => startVoiceListener(selectedMicIndex), 3000);
  });
  voiceProc.on('error', (e) => console.log('[voice] error:', e.message));
  console.log(`[voice] listener iniciado${micIndex !== null ? ` (mic ${micIndex})` : ''}`);
}

function restartVoiceListener(micIndex) {
  console.log(`[voice] reiniciando con mic ${micIndex}...`);
  if (voiceRestartTimer) { clearTimeout(voiceRestartTimer); voiceRestartTimer = null; }
  if (voiceProc && !voiceProc.killed) { voiceProc.removeAllListeners('close'); voiceProc.kill(); voiceProc = null; }
  setTimeout(() => startVoiceListener(micIndex), 500);
}

function handleVoiceEvent(msg) {
  switch (msg.type) {
    case 'log':        console.log('[voice]', msg.msg); break;
    case 'ready':      console.log('[voice] micrófono listo, calibrando...'); break;
    case 'calibrated': console.log('[voice] calibrado, escuchando wake word'); break;
    case 'wake':
      console.log('[voice] wake word!');
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('voice-wake'); break;
    case 'listening':
      console.log('[voice] esperando comando...');
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('voice-listening'); break;
    case 'command': {
      const text = msg.text.toLowerCase();
      console.log('[voice] comando:', text);
      if (VOICE_COMMANDS_OPEN.some(c => text.includes(c))) {
        if (!chatWindow || chatWindow.isDestroyed() || !chatWindow.isVisible()) createChatWindow();
      } else if (VOICE_COMMANDS_CLOSE.some(c => text.includes(c))) {
        if (chatWindow && !chatWindow.isDestroyed() && chatWindow.isVisible()) {
          chatWindow.hide();
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
          MarchCore.setChatOpen(false);
          if (tray) tray.setContextMenu(buildTrayMenu());
        }
      } else {
        if (chatWindow && !chatWindow.isDestroyed()) chatWindow.webContents.send('chat-message', text);
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('speak', 'Entendido!');
      }
      break;
    }
    case 'timeout':
      console.log('[voice] timeout');
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('voice-idle'); break;
    case 'error': console.log('[voice] error:', msg.msg); break;
  }
}

// ── STT local (Python / Vosk) ─────────────────────────────────────────────────
let sttProc = null;

ipcMain.on('stt-start', (e, { micIndex, lang }) => {
  if (sttProc && !sttProc.killed) {
    console.log('[stt] ya hay un proceso activo, ignorando stt-start');
    return;
  }

  const scriptPath = path.join(__dirname, 'stt_transcribe.py');
  if (!fs.existsSync(scriptPath)) {
    console.log('[stt] stt_transcribe.py no encontrado');
    if (chatWindow && !chatWindow.isDestroyed())
      chatWindow.webContents.send('stt-error', 'stt_transcribe.py no encontrado junto a main.js');
    return;
  }

  const args = [scriptPath, '--lang', lang || 'es'];
  if (micIndex !== null && micIndex >= 0)
    args.push('--mic-index', String(micIndex));

  console.log(`[stt] iniciando: python ${args.join(' ')}`);
  sttProc = spawn(PYTHON_BIN, args, {
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
  });

  sttProc.stdout.on('data', (data) => {
    const lines = data.toString().split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        console.log('[stt]', JSON.stringify(msg));
        if (!chatWindow || chatWindow.isDestroyed()) continue;

        if (msg.type === 'ready' || msg.type === 'recording') {
          chatWindow.webContents.send('stt-status', msg.type);
        } else if (msg.type === 'partial') {
          chatWindow.webContents.send('stt-partial', msg.text || '');
        } else if (msg.type === 'sentence') {
          chatWindow.webContents.send('stt-sentence', msg.text || '');
        } else if (msg.type === 'result') {
          chatWindow.webContents.send('stt-result', msg.text || '');
        } else if (msg.type === 'error') {
          chatWindow.webContents.send('stt-error', msg.msg);
        }
      } catch(_) {}
    }
  });

  sttProc.stderr.on('data', (d) => console.log('[stt stderr]', d.toString().trim()));

  sttProc.on('close', (code) => {
    console.log(`[stt] proceso cerrado (code ${code})`);
    sttProc = null;
  });

  sttProc.on('error', (err) => {
    console.log('[stt] error al lanzar proceso:', err.message);
    if (chatWindow && !chatWindow.isDestroyed())
      chatWindow.webContents.send('stt-error', `No se pudo lanzar Python: ${err.message}`);
    sttProc = null;
  });
});

ipcMain.on('stt-stop', () => {
  if (!sttProc || sttProc.killed) {
    console.log('[stt] no hay proceso activo');
    return;
  }
  const stopFile = path.join(__dirname, 'stt_transcribe.stop');
  console.log('[stt] creando archivo de parada:', stopFile);
  try {
    fs.writeFileSync(stopFile, 'stop');
  } catch(e) {
    console.log('[stt] error creando stop file:', e.message);
    sttProc.kill();
  }
});

// ── App init ──────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  ensureLLMConfig();
  setupMicPermissions();

  MarchCore.init(app);

  MarchCore.getEventBus().on('openclaw:available', (payload) => {
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.webContents.send('openclaw-status', payload);
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
  startVoiceListener(selectedMicIndex);
  createChatWindow();

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
    if (voiceProc) { voiceProc.kill(); voiceProc = null; }
    _quitting = true;
    app.quit();
  })();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
