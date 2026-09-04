// @ts-nocheck
'use strict';

// proactive-handlers.js — canal de control en runtime del ProactiveEngine.
//
// Expone al renderer (y al comando /proactive, que corre en el chat) cuatro
// operaciones vía IPC:
//   - proactive:get-stats       → stats en vivo (running, autonomía, shadow,
//                                 presupuesto dinámico, cola QUEUE, SLO...).
//   - proactive:set-autonomy     → observe | suggest | act (slider en runtime).
//   - proactive:set-shadow-mode  → on|off: el gate corre pero nada se envía.
//   - proactive:set-context-preference → presencia por tipo de foco.
//
// Los canales se validan en ipc/channel-whitelist.js (INVOKE_ALLOWLIST); un
// renderer comprometido no puede tocar canales fuera de esa lista.

const logger = require('../core/observability/Logger.js');

function register(ctx) {
  const { ipcMain } = require('electron');
  const { Core } = ctx;

  ipcMain.handle('proactive:get-stats', () => Core.getProactiveStats());

  ipcMain.handle('proactive:set-autonomy', (_e, mode) => {
    if (!['observe', 'suggest', 'act'].includes(mode)) {
      return { ok: false, error: `Modo de autonomía inválido: ${mode}` };
    }
    const res = Core.setAutonomyMode(mode);
    logger.info('proactive', `[main] autonomía → ${res.mode} (${mode})`);
    return res;
  });

  ipcMain.handle('proactive:set-shadow-mode', (_e, on) => {
    const res = Core.setShadowMode(!!on);
    logger.info('proactive', `[main] shadow mode → ${res.shadowMode ? 'ON' : 'OFF'}`);
    return res;
  });

  ipcMain.handle('proactive:set-context-preference', (_e, context, level) => {
    if (!['work', 'browser', 'search', 'media', 'neutral'].includes(context)) {
      return { ok: false, error: `Contexto inválido: ${context}` };
    }
    if (!['auto', 'quiet', 'balanced', 'engaged'].includes(level)) {
      return { ok: false, error: `Nivel inválido: ${level}` };
    }
    const result = Core.setProactiveContextPreference(context, level);
    logger.info('proactive', `[main] contexto ${context} → ${level}`);
    return result;
  });
}

module.exports = { register };
