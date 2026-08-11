// @ts-nocheck
'use strict';
const logger = require('../core/observability/Logger.js');

const { ipcMain } = require('electron');

function register(ctx) {
  const { Core } = ctx;

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
    } catch (err) {
      logger.warn('memory-handlers', '[nodes-list] error:', err.message);
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
    } catch (err) {
      logger.warn('memory-handlers', '[nodes-graph] error:', err.message);
      return { nodes: [], edges: [], gaps: [], usingFallback: true };
    }
  });

  // IPC: gaps de conocimiento del usuario (para proactividad / vista).
  ipcMain.handle('memory-gaps', () => {
    try {
      return { gaps: Core.getMemoryGaps() };
    } catch (err) {
      logger.warn('memory-handlers', '[memory-gaps] error:', err.message);
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

  ipcMain.handle('list-skills', () => Core.listSkills());
  ipcMain.handle('store-fact', (e, fact) => Core.storeFact(fact));

  ipcMain.on('set-provider', (e, { primary }) => {
    if (!primary) return;
    const LLMProvider = require('../core/llm/LLMProvider.js');
    LLMProvider.configure({ llm: { primary } });
    logger.info('memory-handlers', '[config] provedor cambiado a:', primary);
  });
}

module.exports = { register };
