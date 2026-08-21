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
const { getToolRegistry } = require('../core/task/ToolRegistry.js');

// Tiempo máximo (ms) que el usuario tiene para responder a un card de
// aprobación. Configurable en config.json → agent.approvalTimeoutMs. 120s
// porque el usuario puede estar leyendo el resto de la respuesta del agente
// antes de llegar a la tarjeta.
const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;

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

    // Tiempo máximo de respuesta a un card de aprobación (configurable vía
    // config.json → agent.approvalTimeoutMs). El usuario puede estar leyendo
    // el resto de la respuesta del agente antes de llegar a la tarjeta; si
    // expira, la acción se deniega y la UI marca el card como expirado.
    let approvalTimeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS;
    let approvalConfig = { autoApprove: false };
    try {
      const cfg =
        typeof ctx.loadEffectiveConfig === 'function'
          ? ctx.loadEffectiveConfig()
          : ctx.savedConfig || {};
      const n = Number(cfg?.agent?.approvalTimeoutMs);
      if (Number.isFinite(n) && n > 0) approvalTimeoutMs = n;
      approvalConfig = { autoApprove: cfg?.agent?.autoApprove === true };
      // Subagentes por perfil (F1): agent.subagent.enabled (default true).
      // Apagado quita la tool subagent del catálogo que ve el agente.
      getToolRegistry().setSubagentsEnabled(cfg?.agent?.subagent?.enabled !== false);
    } catch (_) {}

    const abort = new AbortController();
    activeAbort = abort;
    try {
      const result = await Core.runAgent(text, {
        signal: abort.signal,
        // Progreso de subagentes por perfil: el run anidado reporta sus fases
        // (start/action/complete) y acá se re-emiten al chat para pintar el
        // bloque colapsable con el nombre del perfil.
        onSubagentProgress: (p) => {
          if (S.chatWindow && !S.chatWindow.isDestroyed()) {
            sendToChat('agent-subagent-progress', p);
          }
        },
        onApprovalNeeded: async (action) => {
          return new Promise((resolve) => {
            const pattern = approvalPattern(action);
            // Auto-aprobación global (config.json → agent.autoApprove): el
            // agente ejecuta acciones de alto impacto sin mostrar el card.
            if (approvalConfig.autoApprove) {
              resolve(true);
              return;
            }
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
              // Vista previa de diff (null cuando no se puede calcular: edit
              // ambiguo, patch que no aplica, write sin content). La UI debe
              // comunicar la ausencia explícitamente, nunca ocultarla.
              diff: action._diffPreview || null,
            });

            // `settled` garantiza que el promise se resuelve UNA sola vez
            // (respuesta del usuario O timeout), y que el timeout NO dispara
            // el evento de expiración si el usuario ya respondió a tiempo.
            let settled = false;
            const handler = (e2, { id, approved, always }) => {
              if (id !== actionId) return;
              clearTimeout(timer);
              if (settled) return;
              settled = true;
              ipcMain.removeListener('agent-approval-response', handler);
              if (always) addApproval(pattern);
              resolve(approved);
            };
            ipcMain.on('agent-approval-response', handler);

            const timer = setTimeout(() => {
              if (settled) return;
              settled = true;
              ipcMain.removeListener('agent-approval-response', handler);
              sendToChat('agent-approval-expired', { actionId });
              logger.info(
                'openclaw-handlers',
                `[main] aprobación ${actionId} expiró (${approvalTimeoutMs}ms) — acción denegada`
              );
              // Objeto rico: el AgentLoop distingue timeout (aprobacion_expirada)
              // de una denegación explícita (cancelada_por_usuario).
              resolve({ approved: false, reason: 'timeout' });
            }, approvalTimeoutMs);
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
    } catch (e) {
      logger.error('openclaw-handlers', '[main] error en agent-run:', e.message);
      return { response: null, iterations: 0, toolResults: [], error: e.message };
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
