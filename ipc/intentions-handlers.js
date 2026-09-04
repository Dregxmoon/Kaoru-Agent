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

  ipcMain.handle('intention-governance-set', (_e, input = {}) => {
    const id = Number(input.id);
    if (!Number.isInteger(id)) return { error: 'id inválido' };
    const update = {
      autonomy: input.autonomy,
      priority: input.priority,
      maxAttempts: input.maxAttempts,
      maxRuntimeMs: input.maxRuntimeMs,
      nextRunAt: input.nextRunAt,
    };
    const governance = Core.configureGoalGovernance(id, update);
    return governance ? { ok: true, governance } : { ok: false, error: 'objetivo no encontrado' };
  });
}

module.exports = { register };
