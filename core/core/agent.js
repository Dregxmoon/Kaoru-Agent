// agent.js — ejecución del agente: el loop cerrado con tool-calling
// (AgentLoop), resolución de modo automático por intención y hooks de
// plugins (beforeAgentRun).

const { AgentLoop } = require('../planner/AgentLoop.js');
const { resolveToolset } = require('../task/ToolResolver.js');
const { buildContext } = require('./context.js');

const state = require('./state.js');

// ── AgentLoop (loop cerrado con tool-calling, skills y precedencia) ───────────

/**
 * Resuelve el modo de ejecución del agente.
 *
 * Sin override explícito (opts.mode) se elige automáticamente según la
 * intención detectada por TaskDetector: mensaje con tarea → 'smart' (modelo
 * potente, más iteraciones); conversación/saludo → 'fast' (rápido y barato).
 * El override sigue existiendo para llamadas internas/programáticas.
 *
 * @param {string} userMessage - Mensaje del usuario
 * @param {object} opts - Opciones de runAgent()
 * @returns {{mode: string, maxIterations: number}}
 */
function resolveAgentMode(userMessage, opts = {}) {
  if (opts.mode) {
    return {
      mode: opts.mode,
      maxIterations: opts.maxIterations || (opts.mode === 'fast' ? 8 : 25),
    };
  }

  let isTask = false;
  try {
    const intent = state.taskDetector?.detect(userMessage);
    isTask = !!(intent && intent.isTask && intent.confidence !== 'none');
  } catch (_) {
    // si el detector falla, se asume conversación (fast)
  }

  return isTask ? { mode: 'smart', maxIterations: 25 } : { mode: 'fast', maxIterations: 8 };
}

/**
 * Ejecuta el loop cerrado de agente para un mensaje del usuario.
 * Reemplaza el flujo plan→execute con un loop single-step donde el LLM
 * decide tool por tool, condicionado por el resultado real del paso anterior.
 *
 * @param {string} userMessage - Mensaje del usuario
 * @param {object} [opts] - Opciones
 * @param {function} [opts.onApprovalNeeded] - Callback de aprobación
 * @param {function} [opts.onProgress] - Callback de progreso
 * @param {number} [opts.maxIterations] - Máximo de iteraciones
 * @param {boolean} [opts.evalMode] - Modo benchmark: auto-aprueba toda tool de
 *   alto impacto y suprime la interacción con el usuario (sin onApprovalNeeded)
 * @returns {Promise<{response, iterations, toolResults, error}>}
 */
async function runAgent(userMessage, opts = {}) {
  const _t0 = Date.now();
  const sessionHistory = state.session?.getHistory() || [];

  // ── Hooks de plugins (patrón opencode): beforeAgentRun ──────────────────
  // Los plugins pueden registrar hooks con registerHook('beforeAgentRun', fn)
  // y reciben { userMessage, sessionHistory }. Pueden devolver:
  //   { userMessage: string }        → reemplaza el mensaje efectivo
  //   { systemPrompt: string }       → se anexa al system prompt
  //   { block: string }              → bloquea la ejecución y devuelve esto
  // Cualquier otro retorno se ignora. Los hooks nunca rompen el pipeline.
  let effectiveMessage = userMessage;
  let hookPrompt = null;
  let blockedReason = null;
  try {
    if (state.pluginManager && typeof state.pluginManager.runHook === 'function') {
      const hookOut = await state.pluginManager.runHook('beforeAgentRun', {
        userMessage,
        sessionHistory,
      });
      if (hookOut && typeof hookOut === 'object') {
        if (typeof hookOut.userMessage === 'string' && hookOut.userMessage.trim()) {
          effectiveMessage = hookOut.userMessage;
        }
        if (typeof hookOut.systemPrompt === 'string' && hookOut.systemPrompt.trim()) {
          hookPrompt = hookOut.systemPrompt;
        }
        if (typeof hookOut.block === 'string' && hookOut.block.trim()) {
          blockedReason = hookOut.block;
        }
      }
    }
  } catch (e) {
    console.warn('[core] hook beforeAgentRun falló:', e.message);
  }

  if (blockedReason) {
    return {
      response: blockedReason,
      iterations: 0,
      toolResults: [],
      error: 'blocked_by_plugin',
    };
  }

  const context = await buildContext(sessionHistory, null, {
    mode: 'agent',
  });
  console.log(`[agent-timing] buildContext ${Date.now() - _t0}ms`);

  if (hookPrompt && context?.systemPrompt) {
    context.systemPrompt = context.systemPrompt + '\n\n' + hookPrompt;
  }

  if (!context || !context.systemPrompt) {
    return {
      response: null,
      iterations: 0,
      toolResults: [],
      error: 'No se pudo construir contexto',
    };
  }

  // ── Modo automático por intención: sin override explícito, TaskDetector
  //    decide entre 'fast' (charla, barato/rápido) y 'smart' (tarea, potente).
  const { mode, maxIterations } = resolveAgentMode(effectiveMessage, opts);
  const loop = new AgentLoop({
    maxIterations,
    bridge: state.bridge,
    mode,
    lsp: state.lspManager,
    graph: state.graph && !state.graph.usingFallback ? state.graph : null,
  });

  const loopOpts = {
    ...opts,
    toolResolver: { resolveToolset },
    skillManager: state.skillManager || null,
    mcpManager: state.mcp || null,
    skillDb: state.graph && !state.graph.usingFallback && state.graph._db ? state.graph._db : null,
    pluginManager: state.pluginManager || null,
    permissionManager: state.permissionManager || null,
  };

  // evalMode: benchmark headless — toda tool de alto impacto se auto-aprueba,
  // sin callback de aprobación (el loop ya la ejecuta si no hay handler).
  if (opts.evalMode) {
    loopOpts.onApprovalNeeded = async () => true;
    loopOpts.evalMode = true;
  }

  const result = await loop.run(
    effectiveMessage,
    context.systemPrompt,
    context.messages || [],
    loopOpts
  );

  state.bus.emit('agent:completed', { iterations: result.iterations, error: result.error });
  console.log(`[agent-timing] loop total ${Date.now() - _t0}ms (${result.iterations} iteraciones)`);
  return result;
}

module.exports = {
  runAgent,
  resolveAgentMode,
};
