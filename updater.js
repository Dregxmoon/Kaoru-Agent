'use strict';

// Auto-update del asistente (electron-updater → GitHub Releases).
//
// Solo funciona en la app empaquetada (app.isPackaged): en desarrollo el
// autoUpdater de electron-updater lanza "Skip checkForUpdates because
// application is not packed", así que en dev este módulo es un no-op.
//
// Flujo:
//   1. initUpdater() registra los IPC handlers y escucha los eventos.
//   2. checkForUpdates() silencioso al arrancar (update-not-available no avisa).
//   3. update-available → dialogo "Descargar / Más tarde" + evento IPC a la UI.
//   4. update-downloaded → dialogo "Reiniciar ahora / Después" + evento IPC.
//   5. La UI (ventana de chat) muestra un banner y permite descargar/reiniciar.
//
// El renderer recibe eventos vía 'update-status' (payload con state + info).

const { app, dialog, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');

let _sendToWindows = null;
let _manualRequested = false;
let _lastInfo = null;
let _lastError = null;

/** @param {string} state @param {object} [extra] */
function emit(state, extra = {}) {
  const payload = { state, info: _lastInfo, error: _lastError, ...extra };
  if (_sendToWindows) _sendToWindows('update-status', payload);
  console.log(`[updater] ${state}`, extra.percent != null ? `${extra.percent}%` : '');
}

/** @param {string} title @param {string} body @param {string} yesLabel @param {string} noLabel */
async function askUser(title, body, yesLabel, noLabel) {
  const win = getFocusedWindow();
  const opts = {
    type: 'info',
    title,
    message: title,
    detail: body,
    buttons: [yesLabel, noLabel],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
  const { response } = win
    ? await dialog.showMessageBox(win, opts)
    : await dialog.showMessageBox(opts);
  return response === 0;
}

function getFocusedWindow() {
  return require('electron')
    .BrowserWindow.getAllWindows()
    .find((w) => w.isFocused());
}

function startDownload() {
  emit('downloading');
  autoUpdater.downloadUpdate().catch((e) => {
    _lastError = String(e && e.message ? e.message : e);
    emit('error');
    console.error('[updater] descarga falló:', _lastError);
  });
}

async function handleCheck() {
  if (!app.isPackaged) return { status: 'disabled' };
  try {
    const result = await autoUpdater.checkForUpdates();
    return {
      status: result ? result.updateInfo.version : 'none',
      current: app.getVersion(),
    };
  } catch (e) {
    _lastError = String(e && e.message ? e.message : e);
    emit('error');
    return { status: 'error', error: _lastError };
  }
}

/**
 * Inicializa el auto-update.
 * @param {object} deps
 * @param {(channel: string, payload: object) => void} deps.sendToWindows
 */
function initUpdater(deps) {
  _sendToWindows = deps.sendToWindows;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => emit('checking'));
  autoUpdater.on('update-available', (info) => {
    _lastInfo = info;
    _manualRequested = false;
    emit('available', { version: info.version });
    askUser(
      `Actualización disponible v${info.version}`,
      `Hay una versión nueva del asistente (actual: v${app.getVersion()}). ¿Descargarla ahora?`,
      'Descargar',
      'Más tarde'
    ).then((yes) => {
      if (yes) startDownload();
      else emit('postponed');
    });
  });
  autoUpdater.on('update-not-available', () => {
    emit('not-available');
    if (_manualRequested) {
      _manualRequested = false;
    }
  });
  autoUpdater.on('download-progress', (p) =>
    emit('downloading', {
      percent: Math.round((p.transferred / p.total) * 100),
      bytesPerSecond: p.bytesPerSecond,
    })
  );
  autoUpdater.on('update-downloaded', (info) => {
    _lastInfo = info;
    emit('downloaded', { version: info.version });
    askUser(
      `v${info.version} descargada`,
      'La nueva versión está lista. ¿Reiniciar ahora para aplicarla?',
      'Reiniciar ahora',
      'Después'
    ).then((yes) => {
      if (yes) autoUpdater.quitAndInstall(false, true);
      else emit('postponed');
    });
  });
  autoUpdater.on('error', (e) => {
    _lastError = String(e && e.message ? e.message : e);
    emit('error');
  });

  // La UI puede pedir un check manual (banner "buscar actualizaciones").
  ipcMain.handle('update:check', () => {
    _manualRequested = true;
    return handleCheck();
  });
  ipcMain.handle('update:download', () => {
    if (!app.isPackaged) return { status: 'disabled' };
    startDownload();
    return { status: 'downloading' };
  });
  ipcMain.handle('update:install', () => {
    if (!app.isPackaged) return { status: 'disabled' };
    autoUpdater.quitAndInstall(false, true);
    return { status: 'installing' };
  });
  ipcMain.handle('update:status', () => {
    if (!app.isPackaged) return { status: 'disabled', current: app.getVersion() };
    return {
      status: _lastInfo ? 'available' : 'none',
      current: app.getVersion(),
      info: _lastInfo,
      error: _lastError,
    };
  });

  // Check silencioso al arrancar (solo app empaquetada).
  if (app.isPackaged) {
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch(() => {});
    }, 10000);
  }
}

module.exports = { initUpdater };
