// @ts-nocheck
'use strict';

// Handlers IPC del sistema de permisos granulares (allow/ask/deny).
// Expone la gestión de reglas al renderer del chat (panel de Permisos).

const { ipcMain } = require('electron');

function register(ctx) {
  const { Core } = ctx;

  ipcMain.handle('permissions-list', () => {
    return Core.permissionsList();
  });

  ipcMain.handle('permissions-set', (e, rule) => {
    return Core.permissionsSetRule(rule || {});
  });

  ipcMain.handle('permissions-remove', (e, rule) => {
    return Core.permissionsRemoveRule(rule || {});
  });
}

module.exports = { register };
