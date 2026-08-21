// @ts-nocheck
'use strict';
const logger = require('../core/observability/Logger.js');

const { ipcMain, dialog } = require('electron');

function register(ctx) {
  const { Core, S, loadConfig, saveConfig } = ctx;

  ipcMain.handle('pick-workspace-folder', async () => {
    const result = await dialog.showOpenDialog(S.chatWindow, { properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths.length) return null;
    return Core.setActiveWorkspace(result.filePaths[0]);
  });

  ipcMain.handle('get-workspace', () => {
    try {
      return Core.getWorkspace();
    } catch (e) {
      logger.warn('mcp-handlers', '[main] error en get-workspace:', e.message);
      return null;
    }
  });

  ipcMain.handle('mcp-list-servers', async () => {
    try {
      return await Core.mcpListServers();
    } catch (e) {
      logger.error('mcp-handlers', '[main] error en mcp-list-servers:', e.message);
      return { error: e.message };
    }
  });

  ipcMain.handle('mcp-search-registry', async (e, { query }) => {
    try {
      return await Core.mcpSearchRegistry(query || '');
    } catch (e) {
      logger.error('mcp-handlers', '[main] error en mcp-search-registry:', e.message);
      return { error: e.message };
    }
  });

  ipcMain.handle('mcp-add-server', async (e, { serverCfg }) => {
    try {
      const status = await Core.mcpAddServer(serverCfg);
      const cfg = loadConfig();
      const servers = cfg?.mcp?.servers || [];
      const withoutDup = servers.filter((s) => s.id !== status.id);
      saveConfig({
        mcp: { servers: [...withoutDup, { ...serverCfg, id: status.id, enabled: true }] },
      });
      return { ok: true, status };
    } catch (e) {
      logger.error('mcp-handlers', '[main] error en mcp-add-server:', e.message);
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('mcp-remove-server', async (e, { id }) => {
    try {
      await Core.mcpRemoveServer(id);
      const cfg = loadConfig();
      const servers = (cfg?.mcp?.servers || []).filter((s) => s.id !== id);
      saveConfig({ mcp: { servers } });
      return { ok: true };
    } catch (e) {
      logger.error('mcp-handlers', '[main] error en mcp-remove-server:', e.message);
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('mcp-toggle-server', async (e, { id, enabled }) => {
    try {
      const cfg = loadConfig();
      const servers = cfg?.mcp?.servers || [];
      const serverCfg = servers.find((s) => s.id === id);
      if (!serverCfg) return { ok: false, error: 'Servidor no encontrado en config' };

      await Core.mcpToggleServer(id, enabled, serverCfg);

      const updated = servers.map((s) => (s.id === id ? { ...s, enabled } : s));
      saveConfig({ mcp: { servers: updated } });
      return { ok: true };
    } catch (e) {
      logger.error('mcp-handlers', '[main] error en mcp-toggle-server:', e.message);
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('telemetry-report', () => {
    return Core.getTelemetryReport();
  });

  ipcMain.handle('get-bridge-stats', () => {
    try {
      const stats = Core.getStats();
      return stats.openclaw || { error: 'no disponible' };
    } catch (e) {
      return { error: `Core no inicializado: ${e.message}` };
    }
  });
}

module.exports = { register };
