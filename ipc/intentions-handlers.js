// @ts-nocheck
'use strict';
const { ipcMain } = require('electron');

const Core = require('../core/Core.js');

/**
 * intentions-handlers.js — Fase 3, ítem 1: metas persistentes.
 * Expone al renderer el stack de intenciones activas para listarlo y
 * resolverlas (completar/descartar) desde la UI.
 */
function register() {
  ipcMain.handle('intentions-list', () => Core.listIntentions({ limit: 10 }));

  ipcMain.handle('intention-complete', (_e, { id } = {}) => {
    if (!Number.isInteger(id)) return { error: 'id inválido' };
    return { ok: Core.completeIntention(id) };
  });

  ipcMain.handle('intention-drop', (_e, { id } = {}) => {
    if (!Number.isInteger(id)) return { error: 'id inválido' };
    return { ok: Core.dropIntention(id) };
  });
}

module.exports = { register };
