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
const { AgentRunController } = require('../core/planner/AgentRunController.js');
let _hasActiveRun = () => false;

// Tiempo máximo (ms) que el usuario tiene para responder a un card de
// aprobación. Configurable en config.json → agent.approvalTimeoutMs. 120s
// porque el usuario puede estar leyendo el resto de la respuesta del agente
// antes de llegar a la tarjeta.
const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;

/** Electron siempre entrega sender.id; el fallback conserva compatibilidad con harnesses aislados. */
function senderId(event) {
  return Number(event?.sender?.id) || 0;
}

function describeMissionApproval(params) {
  const goal = String(params?.goal || '').slice(0, 1000);
  const applications = (Array.isArray(params?.applications) ? params.applications : [])
    .map((application) => String(application).slice(0, 120))
    .join(', ');
  const steps = (Array.isArray(params?.steps) ? params.steps : [])
    .map((step, index) => `${index + 1}. ${String(step?.description || '').slice(0, 500)}`)
    .join('\n');
  return `Misión de escritorio: ${goal}\nAplicaciones: ${applications}\nResultados:\n${steps}\nAlcance temporal: hasta 60 acciones semánticas durante 15 minutos. Las acciones fuera del paso y la aplicación autorizados se consultan por separado.`;
}

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
  const activeRuns = new Map();
  _hasActiveRun = () => activeRuns.size > 0;
  const recentRuns = new Map();

  const rememberRun = (senderId, snapshot) => {
    const history = recentRuns.get(senderId) || [];
    history.unshift(snapshot);
    recentRuns.set(senderId, history.slice(0, 20));
  };

  ipcMain.handle('agent-run-status', async (event, input = {}) => {
    const ownerId = senderId(event);
    const active = activeRuns.get(ownerId);
    if (active && (!input.runId || input.runId === active.runId)) return active.snapshot();
    const history = recentRuns.get(ownerId) || [];
    if (input.runId) return history.find((run) => run.runId === input.runId) || null;
    return history[0] || null;
  });

  ipcMain.on('agent-steer', (event, input = {}) => {
    const active = activeRuns.get(senderId(event));
    if (!active || (input.runId && input.runId !== active.runId)) return;
    const queued = active.steer(input.text);
    sendToChat('agent-steer-status', { runId: active.runId, ...queued });
  });

  ipcMain.on('agent-cancel', (event) => {
    const active = activeRuns.get(senderId(event));
    if (active) {
      active.cancel();
      logger.info('openclaw-handlers', '[main] agent-run cancelado por el usuario');
    }
  });

  ipcMain.handle('agent-run', async (e, { text }) => {
    if (!Core.activeConversation()) {
      return {
        response: null,
        iterations: 0,
        toolResults: [],
        error: 'Elige una carpeta para comenzar',
      };
    }
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
    let approvalConfig = { autoApprove: false, rollbackOnVerificationFailure: false };
    try {
      const cfg =
        typeof ctx.loadEffectiveConfig === 'function'
          ? ctx.loadEffectiveConfig()
          : ctx.savedConfig || {};
      const n = Number(cfg?.agent?.approvalTimeoutMs);
      if (Number.isFinite(n) && n > 0) approvalTimeoutMs = n;
      approvalConfig = {
        autoApprove: cfg?.agent?.autoApprove === true,
        rollbackOnVerificationFailure: cfg?.agent?.rollbackOnVerificationFailure === true,
      };
      // Subagentes por perfil (F1): agent.subagent.enabled (default true).
      // Apagado quita la tool subagent del catálogo que ve el agente.
      getToolRegistry().setSubagentsEnabled(cfg?.agent?.subagent?.enabled !== false);
    } catch (_) {}

    const ownerId = senderId(e);
    const abort = new AbortController();
    const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const priorRun = activeRuns.get(ownerId);
    if (priorRun) {
      return {
        runId: priorRun.runId,
        response: null,
        iterations: 0,
        toolResults: [],
        error: 'run_in_progress',
        execution: priorRun.snapshot(),
      };
    }
    const controller = new AgentRunController({ runId, abortController: abort });
    activeRuns.set(ownerId, controller);
    controller.start();
    // Gesto: Kaoru "piensa" mientras la tarea agéntica corre.
    ctx.gestureEvents?.emit('task-start');
    try {
      const result = await Core.runAgent(text, {
        signal: abort.signal,
        consumeSteering: () => controller.consumeSteering(),
        rollbackOnVerificationFailure: approvalConfig.rollbackOnVerificationFailure,
        // Progreso de subagentes por perfil: el run anidado reporta sus fases
        // (start/action/complete) y acá se re-emiten al chat para pintar el
        // bloque colapsable con el nombre del perfil.
        onSubagentProgress: (p) => {
          if (S.chatWindow && !S.chatWindow.isDestroyed()) {
            sendToChat('agent-subagent-progress', { ...p, runId });
          }
        },
        onApprovalNeeded: async (action) => {
          controller.noteProgress({ phase: 'approval', tool: action.tool, status: 'waiting' });
          if (abort.signal.aborted) return { approved: false, reason: 'cancelled' };
          return new Promise((resolve) => {
            const pattern = approvalPattern(action);
            const missionAction =
              action.tool === 'desktop_mission' || action._desktopMission === true;
            const { isAlwaysPrompt } = require('../core/security/ToolPolicy.js');
            const { isIrreversible } = require('../core/security/IrreversiblePolicy.js');
            const irreversible = isIrreversible(action);
            // Auto-aprobación global (config.json → agent.autoApprove): el
            // agente ejecuta acciones de alto impacto sin mostrar el card.
            // El control interactivo queda excluido: contenido web o una UI
            // comprometida no puede convertir una preferencia global antigua
            // en acceso silencioso al escritorio.
            if (
              approvalConfig.autoApprove &&
              !missionAction &&
              !isAlwaysPrompt(action.tool) &&
              !irreversible
            ) {
              resolve(true);
              return;
            }
            // Aprobación "Siempre" ya registrada en esta sesión → se aprueba
            // directo, sin mostrar el card (patrón opencode).
            if (!missionAction && !irreversible && isApproved(pattern)) {
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
              allowAlways: !missionAction,
              description:
                action.tool === 'desktop_mission'
                  ? describeMissionApproval(action.params)
                  : missionAction
                    ? `Acción fuera del permiso automático de la misión: ${action.description || `${action.tool}: ${JSON.stringify(action.params).slice(0, 100)}`}`
                    : action.description ||
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
              const expectedSenderId = Number(S.chatWindow?.webContents?.id) || ownerId;
              if (expectedSenderId && senderId(e2) !== expectedSenderId) return;
              clearTimeout(timer);
              abort.signal.removeEventListener('abort', onAbort);
              if (settled) return;
              settled = true;
              ipcMain.removeListener('agent-approval-response', handler);
              if (always && !missionAction) addApproval(pattern);
              resolve(approved);
            };
            ipcMain.on('agent-approval-response', handler);

            const timer = setTimeout(() => {
              if (settled) return;
              settled = true;
              abort.signal.removeEventListener('abort', onAbort);
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
            const onAbort = () => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              ipcMain.removeListener('agent-approval-response', handler);
              sendToChat('agent-approval-cancelled', { actionId });
              resolve({ approved: false, reason: 'cancelled' });
            };
            abort.signal.addEventListener('abort', onAbort, { once: true });
          });
        },

        onProgress: (progress) => {
          controller.noteProgress(progress);
          sendToChat('agent-progress', { ...progress, runId });
          // Gesto espontáneo según fase de la tarea (think al trabajar,
          // happy/sad al terminar).
          ctx.gestureEvents?.emit('agent-progress', { status: progress?.status });
        },

        // Plan explícito (HUD del chat): cada cambio de progreso del plan se
        // reenvía al renderer para pintar el widget de pasos en vivo.
        onPlan: (plan) => {
          controller.notePlan(plan);
          sendToChat('agent-plan', { ...plan, runId });
        },

        // Streaming: cada fragmento de texto que genera el LLM se reenvía al
        // chat para pintarlo en vivo mientras se produce (patrón opencode).
        onToken: (token) => {
          sendToChat('agent-token', token);
        },
      });

      const taskOk = !result.error && !result.truncated && !result.cancelled;
      const lifecycle = controller.finish(result);
      const execution = {
        ...lifecycle,
        ...(result.execution || {}),
        runId,
        active: false,
        createdAt: lifecycle.createdAt,
        startedAt: lifecycle.startedAt,
        finishedAt: lifecycle.finishedAt,
        steering: lifecycle.steering,
      };
      ctx.gestureEvents?.emit('task-result', { ok: taskOk, error: result.error });

      // Chips de resultado para la UI: skills usadas + verificación de
      // artefactos. El renderer los pinta como fila bajo la respuesta.
      sendToChat('agent-result-meta', {
        ok: taskOk,
        cancelled: result.cancelled || false,
        skills: Array.isArray(result.skillsUsed) ? result.skillsUsed : [],
        artifactRounds: result.artifactRounds || 0,
        verified:
          result.verify && result.verify.status
            ? result.verify.status
            : result.unverifiedEdits
              ? 'unverified'
              : null,
      });

      return {
        runId,
        response: result.response,
        iterations: result.iterations,
        toolResults: result.toolResults,
        error: result.error,
        truncated: result.truncated || false,
        cancelled: result.cancelled || false,
        verify: result.verify || null,
        plan: result.plan || null,
        checkpoint: result.checkpoint || null,
        mutationJournal: result.mutationJournal || null,
        steering: result.steering || null,
        execution,
        rollback: result.rollback || null,
        executionMode: result.executionMode || null,
      };
    } catch (e) {
      logger.error('openclaw-handlers', '[main] error en agent-run:', e.message);
      ctx.gestureEvents?.emit('task-result', { ok: false, error: e.message });
      return { response: null, iterations: 0, toolResults: [], error: e.message };
    } finally {
      const active = activeRuns.get(ownerId);
      if (active?.runId === runId) {
        if (active.snapshot().active) active.finish({ error: 'agent_exception' });
        rememberRun(ownerId, active.snapshot());
        activeRuns.delete(ownerId);
      }
    }
  });
}

module.exports = { register, resetSessionApprovals, hasActiveRun: () => _hasActiveRun() };

/** Limpia las aprobaciones "Siempre" de la sesión (al cerrar el chat). */
function resetSessionApprovals() {
  resetApprovals();
}
