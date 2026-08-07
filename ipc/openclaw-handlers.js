// @ts-nocheck
'use strict';
const logger = require('../core/observability/Logger.js');

const { ipcMain } = require('electron');

function register(ctx) {
  const { Core, S, sendToChat } = ctx;

  // IPC: Fase 3 — OpenClaw
  ipcMain.handle('openclaw-available', async () => {
    return Core.isOpenClawAvailable();
  });

  // Cancelación del agent-run en curso: el renderer envía 'agent-cancel' y el
  // AbortController rompe el stream HTTP del LLM y el loop del agente.
  let activeAbort = null;

  ipcMain.on('agent-cancel', () => {
    if (activeAbort) {
      activeAbort.abort();
      activeAbort = null;
      logger.info('openclaw-handlers', '[main] agent-run cancelado por el usuario');
    }
  });

  ipcMain.handle('agent-run', async (e, { text }) => {
    logger.info('openclaw-handlers', `[main] agent-run: text="${text?.slice(0, 80)}"`);
    const _t = (l) => logger.info('openclaw-handlers', `[agent-timing] ${Date.now() - _t0}ms ${l}`);
    const _t0 = Date.now();

    if (!text || !text.trim()) {
      return { response: null, iterations: 0, toolResults: [], error: 'texto vacío' };
    }

    const abort = new AbortController();
    activeAbort = abort;
    try {
      const result = await Core.runAgent(text, {
        signal: abort.signal,
        onApprovalNeeded: async (action) => {
          return new Promise((resolve) => {
            if (!S.chatWindow || S.chatWindow.isDestroyed()) {
              resolve(false);
              return;
            }

            const actionId = `agent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            sendToChat('agent-approval-needed', {
              actionId,
              tool: action.tool,
              params: action.params,
              description:
                action.description ||
                `${action.tool}: ${JSON.stringify(action.params).slice(0, 100)}`,
            });

            const handler = (e2, { id, approved }) => {
              if (id === actionId) {
                ipcMain.removeListener('agent-approval-response', handler);
                resolve(approved);
              }
            };
            ipcMain.on('agent-approval-response', handler);

            setTimeout(() => {
              ipcMain.removeListener('agent-approval-response', handler);
              resolve(false);
            }, 60_000);
          });
        },

        onProgress: (progress) => {
          sendToChat('agent-progress', progress);
        },

        // Streaming: cada fragmento de texto que genera el LLM se reenvía al
        // chat para pintarlo en vivo mientras se produce (patrón opencode).
        onToken: (token) => {
          sendToChat('agent-token', token);
        },
      });

      return {
        response: result.response,
        iterations: result.iterations,
        toolResults: result.toolResults,
        error: result.error,
        truncated: result.truncated || false,
        cancelled: result.cancelled || false,
      };
    } catch (err) {
      logger.error('openclaw-handlers', '[main] error en agent-run:', err.message);
      return { response: null, iterations: 0, toolResults: [], error: err.message };
    } finally {
      if (activeAbort === abort) activeAbort = null;
    }
  });
}

module.exports = { register };
