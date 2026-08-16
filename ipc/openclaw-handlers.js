// @ts-nocheck
'use strict';
const logger = require('../core/observability/Logger.js');
const {
  approvalPattern,
  isApproved,
  addApproval,
  resetApprovals,
} = require('../core/security/SessionApprovals.js');

const { ipcMain } = require('electron');

function register(ctx) {
  const { Core, S, sendToChat } = ctx;

  // IPC: Fase 3 — OpenClaw
  ipcMain.handle('openclaw-available', async () => {
    return Core.isOpenClawAvailable();
  });

  // Estado completo (disponibilidad + aislamiento de proceso bwrap). El
  // renderer lo consulta al arrancar; luego vive con el evento 'openclaw-status'.
  ipcMain.handle('openclaw-status', async () => {
    return Core.getOpenClawStatus();
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
            const pattern = approvalPattern(action);
            // Aprobación "Siempre" ya registrada en esta sesión → se aprueba
            // directo, sin mostrar el card (patrón opencode).
            if (isApproved(pattern)) {
              resolve(true);
              return;
            }

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

            const handler = (e2, { id, approved, always }) => {
              if (id === actionId) {
                ipcMain.removeListener('agent-approval-response', handler);
                if (always) addApproval(pattern);
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

        // Plan explícito (HUD del chat): cada cambio de progreso del plan se
        // reenvía al renderer para pintar el widget de pasos en vivo.
        onPlan: (plan) => {
          sendToChat('agent-plan', plan);
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

module.exports = { register, resetSessionApprovals };

/** Limpia las aprobaciones "Siempre" de la sesión (al cerrar el chat). */
function resetSessionApprovals() {
  resetApprovals();
}
