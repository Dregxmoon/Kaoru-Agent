// @ts-nocheck
'use strict';
const logger = require('../core/observability/Logger.js');
const fs = require('fs');

const { ipcMain, dialog } = require('electron');

function register(ctx) {
  const { Core } = ctx;
  const trustedSender = (event) => {
    const chat = ctx.S?.chatWindow;
    return Boolean(chat && !chat.isDestroyed() && event.sender === chat.webContents);
  };
  const owner = () => {
    const chat = ctx.S?.chatWindow;
    return chat && !chat.isDestroyed() ? chat : undefined;
  };
  const confirmWithNativeDialog = (options) => {
    const window = owner();
    return window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);
  };
  const chooseExportPath = (options) => {
    const window = owner();
    return window ? dialog.showSaveDialog(window, options) : dialog.showSaveDialog(options);
  };

  // IPC: memoria
  ipcMain.on('memory-add-turn', (e, { role, content }) => {
    Core.addTurn(role, content);
    if (role === 'user') Core.detectInstant(content);
  });

  // IPC: sesiones pasadas (panel con picker en el chat)
  ipcMain.handle('sessions-list', (e, { limit } = {}) => Core.listSessions(limit));
  ipcMain.handle('session-load', (e, { id } = {}) => Core.loadSession(id));

  // IPC: nodos de memoria (vista local /memoria). Devuelve nodos + conteo por tipo.
  ipcMain.handle('nodes-list', (e, { type, limit } = {}) => {
    try {
      const nodes = Core.listNodes({ type, limit });
      const graph = Core.getGraph();
      let byType = [];
      if (graph && !graph.usingFallback) {
        try {
          byType = graph.getStats().byType || [];
        } catch {}
      }
      return { nodes, byType, usingFallback: graph?.usingFallback ?? false };
    } catch (e) {
      logger.warn('memory-handlers', '[nodes-list] error:', e.message);
      return { nodes: [], byType: [], usingFallback: true };
    }
  });

  // IPC: grafo de memoria (conexiones implícitas derivadas) — vista /memoria.
  ipcMain.handle('nodes-graph', (e, { limit } = {}) => {
    try {
      const graph = Core.getGraph();
      const { nodes, edges } = Core.listNodeGraph({ limit });
      const gaps = Core.getMemoryGaps();
      return { nodes, edges, gaps, usingFallback: graph?.usingFallback ?? false };
    } catch (e) {
      logger.warn('memory-handlers', '[nodes-graph] error:', e.message);
      return { nodes: [], edges: [], gaps: [], usingFallback: true };
    }
  });

  // IPC: gaps de conocimiento del usuario (para proactividad / vista).
  ipcMain.handle('memory-gaps', () => {
    try {
      return { gaps: Core.getMemoryGaps() };
    } catch (e) {
      logger.warn('memory-handlers', '[memory-gaps] error:', e.message);
      return { gaps: [] };
    }
  });

  // IPC: stats de la sesión activa (id real) — lo usa el footer del chat.
  ipcMain.handle('session-stats', () => {
    try {
      const stats = Core.getStats();
      return (stats && stats.session) || null;
    } catch {
      return null;
    }
  });

  // IPC: decisión de propuesta proactiva (Fase A)
  ipcMain.on('initiative-decision', (e, decision) => {
    Core.handleProposalDecision(decision);
  });

  // IPC: grounding
  ipcMain.handle(
    'grounding-build-context',
    async (e, { sessionHistory, activeProvider, mode, plan }) => {
      const ctxRes = await Core.buildContext(sessionHistory, activeProvider, { mode, plan });
      logger.info(
        'memory-handlers',
        '[grounding-ipc] provider:',
        activeProvider,
        '| mode:',
        mode || 'chat',
        '| systemPrompt:',
        ctxRes?.systemPrompt?.length,
        'chars'
      );
      return ctxRes;
    }
  );

  // IPC: OS Sensor
  ipcMain.handle('memory-forget', (e, { text } = {}) => Core.forgetMemory(text));

  ipcMain.handle('memory-inspect', (event, { nodeId } = {}) => {
    if (!trustedSender(event)) return { ok: false, error: 'untrusted_sender' };
    return Core.inspectMemory(Number(nodeId));
  });

  ipcMain.handle('memory-correct', async (event, payload = {}) => {
    if (!trustedSender(event)) return { ok: false, error: 'untrusted_sender' };
    const nodeId = Number(payload.nodeId);
    const content = String(payload.content || '').trim();
    if (!Number.isInteger(nodeId) || nodeId <= 0 || content.length < 2 || content.length > 12000) {
      return { ok: false, error: 'invalid_input' };
    }
    const confirmation = await confirmWithNativeDialog({
      type: 'question',
      title: 'Corregir memoria',
      message: '¿Guardar esta corrección en la memoria de Kaoru?',
      detail: content.slice(0, 500),
      buttons: ['Cancelar', 'Guardar corrección'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (confirmation.response !== 1) return { ok: false, cancelled: true };
    const expectedUpdatedAt = Number(payload.expectedUpdatedAt);
    return Core.correctMemory({
      nodeId,
      content,
      reason: String(payload.reason || '').slice(0, 1000),
      expectedUpdatedAt: Number.isFinite(expectedUpdatedAt) ? expectedUpdatedAt : undefined,
    });
  });

  ipcMain.handle('memory-delete', async (event, payload = {}) => {
    if (!trustedSender(event)) return { ok: false, error: 'untrusted_sender' };
    const nodeId = Number(payload.nodeId);
    if (!Number.isInteger(nodeId) || nodeId <= 0) return { ok: false, error: 'invalid_input' };
    const confirmation = await confirmWithNativeDialog({
      type: 'warning',
      title: 'Eliminar memoria',
      message: '¿Eliminar esta memoria y todas sus versiones?',
      detail: 'También se eliminarán sus evidencias que no estén vinculadas a otros recuerdos.',
      buttons: ['Cancelar', 'Eliminar definitivamente'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (confirmation.response !== 1) return { ok: false, cancelled: true };
    const expectedUpdatedAt = Number(payload.expectedUpdatedAt);
    return Core.deleteMemoryLineage({
      nodeId,
      expectedUpdatedAt: Number.isFinite(expectedUpdatedAt) ? expectedUpdatedAt : undefined,
      includeEvidence: true,
    });
  });

  ipcMain.handle('memory-export', async (event) => {
    if (!trustedSender(event)) return { ok: false, error: 'untrusted_sender' };
    try {
      const chosen = await chooseExportPath({
        title: 'Exportar memoria de Kaoru',
        defaultPath: `memoria-kaoru-${new Date().toISOString().slice(0, 10)}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
        properties: ['createDirectory', 'showOverwriteConfirmation'],
      });
      if (chosen.canceled || !chosen.filePath) return { ok: false, cancelled: true };
      const snapshot = Core.exportMemorySnapshot();
      await fs.promises.writeFile(chosen.filePath, JSON.stringify(snapshot, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      });
      if (process.platform !== 'win32') await fs.promises.chmod(chosen.filePath, 0o600);
      return { ok: true, exportedAt: snapshot.exportedAt };
    } catch (error) {
      logger.warn(
        'memory-handlers',
        '[memory-export] no se pudo completar la exportación:',
        error?.code || 'error'
      );
      return { ok: false, error: 'export_failed' };
    }
  });

  ipcMain.handle('list-skills', () => Core.listSkills());
  ipcMain.handle('store-fact', (e, fact) => Core.storeFact(fact));

  ipcMain.on('set-provider', (e, { primary }) => {
    if (!primary) return;
    const LLMProvider = require('../core/llm/LLMProvider.js');
    LLMProvider.configure({ llm: { primary } });
    // Fase C: persistir el provider activo en config.json (antes quedaba solo
    // en memoria; se acabó la disociación entre provider y modelo).
    try {
      if (ctx && typeof ctx.loadConfig === 'function' && typeof ctx.saveConfig === 'function') {
        const cfg = ctx.loadConfig() || {};
        const providers = { ...(cfg.llm?.providers || {}) };
        ctx.saveConfig({
          llm: {
            primary,
            fallback: cfg.llm?.fallback || ['gemini'],
            providers,
            apiKeys: cfg.llm?.apiKeys || {},
          },
        });
      }
    } catch (e) {
      logger.warn('memory-handlers', '[config] no se pudo persistir el provider:', e.message);
    }
    logger.info('memory-handlers', '[config] provedor cambiado a:', primary);
  });
}

module.exports = { register };
