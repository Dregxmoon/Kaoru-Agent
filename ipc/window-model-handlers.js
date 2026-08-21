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

  ipcMain.on('chat-close', () => {
    logger.info('window-model-handlers', '[main] chat cerrado — saliendo del asistente');
    app.quit();
  });

  ipcMain.on('chat-theme-changed', (e, theme) => {
    S.chatTheme = theme;
    saveConfig({ chatTheme: theme });
  });

  // IPC: modelo Live2D
  const MODELS_DIR = path.join(__dirname, '..', 'models');

  function listModels() {
    const models = [];
    if (!fs.existsSync(MODELS_DIR)) return models;
    for (const entry of fs.readdirSync(MODELS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const folder = path.join(MODELS_DIR, entry.name);
      let model3 = null;
      try {
        model3 = fs.readdirSync(folder).find((f) => f.endsWith('.model3.json')) || null;
      } catch {}
      if (model3) {
        models.push({
          id: entry.name,
          name: entry.name,
          model3Path: path.join(folder, model3),
          active: entry.name === S.activeModelId,
        });
      }
    }
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
    if (!fs.existsSync(folderPath)) return { error: 'La ruta no existe: ' + folderPath };

    let model3Rel = null;
    const walk = (dir, depth) => {
      if (depth > 2 || model3Rel) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
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
    } catch (e) {
      return { error: 'No se pudo copiar el modelo: ' + e.message };
    }
    if (!setActiveModel(id)) return { error: 'No se pudo activar el modelo importado.' };
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
