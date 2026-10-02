// @ts-nocheck
'use strict';
const logger = require('../core/observability/Logger.js');

const path = require('path');
const fs = require('fs');
const { app, ipcMain } = require('electron');

function register(ctx) {
  const { S, savedConfig, loadConfig, saveConfig, sendToChat } = ctx;
  const coreState = require('../core/core/state.js');

  // Sincroniza el model3.json activo al estado del núcleo, para que el
  // grounding pueda construir el vocabulario de gestos dinámico (nombres
  // reales del modelo, en cualquier idioma).
  function syncActiveModel3Path() {
    try {
      const info = getActiveModel();
      coreState.activeModel3Path = info ? info.model3Path : null;
    } catch {
      coreState.activeModel3Path = null;
    }
  }

  // IPC: overlay
  ipcMain.on('drag-start', () => {
    S.userHasMoved = true;
  });
  ipcMain.on('drag-move', (e, { x, y }) => {
    if (!S.mainWindow || S.mainWindow.isDestroyed()) return;
    const size = S.mainWindow.getSize();
    S.mainWindow.setPosition(Math.round(x - size[0] / 2), Math.round(y - size[1] / 2));
  });
  ipcMain.on('model-hover', (e, hovering) => {
    if (!S.mainWindow || S.mainWindow.isDestroyed()) return;
    S.mainWindow.setIgnoreMouseEvents(!hovering, { forward: true });
  });
  ipcMain.on('view-changed', (e, view) => {
    S.currentView = view;
    if (S.tray) S.tray.setContextMenu(ctx.buildTrayMenu());
  });
  ipcMain.on('model-dblclick', () => ctx.toggleChatWindow());

  ipcMain.on('chat-close', (event) => {
    const chat = S.chatWindow;
    if (!chat || chat.isDestroyed() || event.sender !== chat.webContents) return;
    logger.info('window-model-handlers', '[main] chat cerrado — saliendo del asistente');
    app.quit();
  });

  ipcMain.on('chat-window-control', (event, action) => {
    const chat = S.chatWindow;
    if (!chat || chat.isDestroyed() || event.sender !== chat.webContents) return;
    if (action === 'minimize') chat.minimize();
    else if (action === 'maximize') {
      if (chat.isMaximized()) chat.unmaximize();
      else chat.maximize();
    }
  });

  ipcMain.on('chat-theme-changed', (e, theme) => {
    S.chatTheme = theme;
    saveConfig({ chatTheme: theme });
  });

  // IPC: modelo Live2D
  //
  // Dos orígenes de modelos:
  //  - BUNDLED_MODELS_DIR: modelos incluidos en el release. En builds empaquetados
  //    vive dentro de app.asar → SOLO LECTURA (nunca se escribe ahí).
  //  - userData/models: modelos importados por el usuario. Es escribible, no
  //    depende de la ruta de instalación (Program Files) y sobrevive a updates.
  const BUNDLED_MODELS_DIR = path.join(__dirname, '..', 'models');
  const MODEL3_MAX_DEPTH = 2;

  // Resuelta de forma perezosa: `app.getPath` puede no existir en mocks de tests.
  function getUserModelsDir() {
    try {
      return path.join(app.getPath('userData'), 'models');
    } catch {
      return null;
    }
  }

  // Busca un *.model3.json hasta MODEL3_MAX_DEPTH niveles. Prioriza los archivos
  // del nivel actual antes de bajar a subcarpetas (p. ej. `runtime/`). Es la ÚNICA
  // búsqueda usada por listModels() y por model-import, para que ambos coincidan.
  function findModel3(dir, depth = 0) {
    if (depth > MODEL3_MAX_DEPTH) return null;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    const file = entries.find((e) => e.isFile() && e.name.endsWith('.model3.json'));
    if (file) return path.join(dir, file.name);
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const found = findModel3(path.join(dir, e.name), depth + 1);
      if (found) return found;
    }
    return null;
  }

  // Limpieza best-effort: un fallo al borrar nunca debe escapar del handler IPC.
  function removeQuietly(target) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch {}
  }

  function listModelsIn(root, imported, seen, out) {
    if (!root || !fs.existsSync(root)) return;
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || seen.has(entry.name)) continue;
      const model3Path = findModel3(path.join(root, entry.name));
      if (!model3Path) continue;
      seen.add(entry.name);
      out.push({
        id: entry.name,
        name: entry.name,
        model3Path,
        imported,
        active: entry.name === S.activeModelId,
      });
    }
  }

  function listModels() {
    const models = [];
    const seen = new Set();
    // Los importados van primero: si comparten id con uno incluido, ganan.
    listModelsIn(getUserModelsDir(), true, seen, models);
    listModelsIn(BUNDLED_MODELS_DIR, false, seen, models);
    return models;
  }

  function getActiveModel() {
    const models = listModels();
    return models.find((m) => m.active) || models[0] || null;
  }

  function setActiveModel(id) {
    if (!listModels().find((m) => m.id === id)) return false;
    S.activeModelId = id;
    saveConfig({ activeModel: id });
    syncActiveModel3Path();
    return true;
  }

  function broadcastModelChanged() {
    const info = getActiveModel();
    if (!info) return;
    syncActiveModel3Path();
    const payload = { ...info, models: listModels() };
    if (S.mainWindow && !S.mainWindow.isDestroyed())
      S.mainWindow.webContents.send('model-changed', payload);
    sendToChat('model-changed', payload);
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
    const src = path.resolve(folderPath);
    let stat;
    try {
      stat = fs.statSync(src);
    } catch {
      return { error: 'La ruta no existe: ' + folderPath };
    }
    if (!stat.isDirectory()) return { error: 'La ruta no es una carpeta: ' + folderPath };

    const id = path.basename(src);
    // Raíz de unidad (C:\) o similar: basename vacío → no hay nombre de modelo.
    // Se valida antes de buscar para no recorrer una unidad entera.
    if (!id || src === path.parse(src).root) {
      return { error: 'Elige la carpeta del modelo, no la raíz de una unidad.' };
    }

    if (!findModel3(src)) {
      return { error: 'No se encontró un archivo .model3.json en la carpeta.' };
    }

    const userDir = getUserModelsDir();
    if (!userDir) return { error: 'No se pudo resolver la carpeta de datos de la app.' };
    const dest = path.join(userDir, id);

    // Ya es el modelo importado: solo se activa. Copiar una carpeta sobre sí
    // misma (o dentro de sí misma) fallaría o duplicaría datos.
    const isSelf = src === dest;
    if (!isSelf && (dest.startsWith(src + path.sep) || userDir.startsWith(src + path.sep))) {
      return { error: 'La carpeta contiene el directorio de datos de la app; elige otra.' };
    }

    const existed = fs.existsSync(dest);
    if (!isSelf) {
      try {
        fs.mkdirSync(userDir, { recursive: true });
        fs.cpSync(src, dest, { recursive: true, force: true });
      } catch (err) {
        if (!existed) removeQuietly(dest);
        return { error: 'No se pudo copiar el modelo: ' + err.message };
      }
    }

    if (!setActiveModel(id)) {
      // No dejar una carpeta huérfana si la importación no llegó a activarse.
      if (!existed && !isSelf) removeQuietly(dest);
      return { error: 'No se pudo activar el modelo importado.' };
    }
    broadcastModelChanged();
    return { ok: true, info: getActiveModel() };
  });

  // Modo de vista del modelo (full | half | head | random)
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
    return {
      modelId: S.activeModelId,
      mode: getModelViewMode(S.activeModelId),
      activeView: S.currentView,
    };
  }

  function broadcastViewsChanged() {
    const payload = currentViewsState();
    if (S.mainWindow && !S.mainWindow.isDestroyed())
      S.mainWindow.webContents.send('views-changed', payload);
    sendToChat('views-changed', payload);
  }

  ipcMain.handle('views-get', () => currentViewsState());
  ipcMain.handle('views-set', (e, { mode } = {}) => ctx.applyViewMode(mode));

  // Exponer al resto de main.js
  ctx.listModels = listModels;
  ctx.getActiveModel = getActiveModel;
  ctx.setActiveModel = setActiveModel;
  ctx.getModelViewMode = getModelViewMode;
  ctx.saveModelViewMode = saveModelViewMode;
  ctx.currentViewsState = currentViewsState;
  ctx.broadcastViewsChanged = broadcastViewsChanged;

  syncActiveModel3Path();
}

module.exports = { register };
