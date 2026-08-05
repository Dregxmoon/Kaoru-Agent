'use strict';

const { ipcMain } = require('electron');

function register(ctx) {
  const { Core, S, serializeResult } = ctx;

  // IPC: Fase 3 — OpenClaw
  ipcMain.handle('openclaw-available', async () => {
    return Core.isOpenClawAvailable();
  });

  ipcMain.handle('openclaw-execute-tool', async (e, { tool, params }) => {
    console.log(`[main] openclaw-execute-tool: ${tool}`);
    try {
      const result = await Core.executeTool(tool, params);
      return result;
    } catch (err) {
      console.error('[main] error en executeTool:', err.message);
      return { ok: false, error: err.message, tool, result: null, elapsed: 0 };
    }
  });

  ipcMain.handle('openclaw-parse-plan', (e, { llmResponse, userGoal, toolIntent }) => {
    try {
      const plan = Core.parsePlanFromResponse(llmResponse, userGoal, toolIntent ?? null);
      return plan ?? null;
    } catch (err) {
      console.error('[main] error en parsePlanFromResponse:', err.message);
      return null;
    }
  });

  ipcMain.handle('openclaw-execute-plan', async (e, { plan }) => {
    console.log(`[main] ejecutando plan: ${plan?.id} (${plan?.steps?.length} pasos)`);

    if (!plan || !plan.steps?.length) {
      return { ok: false, error: 'Plan inválido o sin pasos', plan };
    }

    try {
      const executedPlan = await Core.executePlan(plan, {
        onStepStart: (step) => {
          if (S.chatWindow && !S.chatWindow.isDestroyed()) {
            S.chatWindow.webContents.send('plan-step-start', {
              planId: plan.id,
              stepId: step.id,
              description: step.description,
              tool: step.tool,
            });
          }
        },

        onStepDone: (step, result) => {
          if (S.chatWindow && !S.chatWindow.isDestroyed()) {
            S.chatWindow.webContents.send('plan-step-done', {
              planId: plan.id,
              stepId: step.id,
              description: step.description,
              tool: step.tool,
              status: step.status,
              result: serializeResult(result),
              error: step.error,
            });
          }
        },

        onApprovalNeeded: (step) => {
          return new Promise((resolve) => {
            if (!S.chatWindow || S.chatWindow.isDestroyed()) {
              resolve(false);
              return;
            }

            S.chatWindow.webContents.send('plan-approval-needed', {
              planId: plan.id,
              stepId: step.id,
              description: step.description,
              tool: step.tool,
              params: step.params,
            });

            const handler = (e2, { stepId, approved }) => {
              if (stepId === step.id) {
                ipcMain.removeListener('plan-approval-response', handler);
                resolve(approved);
              }
            };
            ipcMain.on('plan-approval-response', handler);

            setTimeout(() => {
              ipcMain.removeListener('plan-approval-response', handler);
              resolve(false);
            }, 60_000);
          });
        },
      });

      return {
        ok: executedPlan.status === 'done',
        plan: executedPlan,
        result: serializeResult(executedPlan.result),
        error: executedPlan.error,
      };
    } catch (err) {
      console.error('[main] error ejecutando plan:', err.message);
      return { ok: false, error: err.message, plan };
    }
  });

  // Cancelación del agent-run en curso: el renderer envía 'agent-cancel' y el
  // AbortController rompe el stream HTTP del LLM y el loop del agente.
  let activeAbort = null;

  ipcMain.on('agent-cancel', () => {
    if (activeAbort) {
      activeAbort.abort();
      activeAbort = null;
      console.log('[main] agent-run cancelado por el usuario');
    }
  });

  ipcMain.handle('agent-run', async (e, { text }) => {
    console.log(`[main] agent-run: text="${text?.slice(0, 80)}"`);
    const _t = (l) => console.log(`[agent-timing] ${Date.now() - _t0}ms ${l}`);
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
            S.chatWindow.webContents.send('agent-approval-needed', {
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
          if (S.chatWindow && !S.chatWindow.isDestroyed()) {
            S.chatWindow.webContents.send('agent-progress', progress);
          }
        },

        // Streaming: cada fragmento de texto que genera el LLM se reenvía al
        // chat para pintarlo en vivo mientras se produce (patrón opencode).
        onToken: (token) => {
          if (S.chatWindow && !S.chatWindow.isDestroyed()) {
            S.chatWindow.webContents.send('agent-token', token);
          }
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
      console.error('[main] error en agent-run:', err.message);
      return { response: null, iterations: 0, toolResults: [], error: err.message };
    } finally {
      if (activeAbort === abort) activeAbort = null;
    }
  });

  ipcMain.handle('openclaw-plan-history', () => {
    return Core.getPlanner()?.getHistory(20) ?? [];
  });
}

module.exports = { register };
