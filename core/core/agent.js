// @ts-nocheck
const logger = require('../observability/Logger.js');
// agent.js — ejecución del agente: el loop cerrado con tool-calling
// (AgentLoop), resolución de modo automático por intención y hooks de
// plugins (beforeAgentRun).

const { AgentLoop } = require('../planner/AgentLoop.js');
const { resolveVerifyPlan } = require('../commands/verify.js');
const { resolveToolset } = require('../task/ToolResolver.js');
const { buildContext } = require('./context.js');
const LLMProvider = require('../llm/LLMProvider.js');
const { estimateDifficulty } = require('../learning/difficulty.js');
const { MODE_ADVANTAGE } = require('../trust/TrustModel.js');
const { evaluateTaskOutcome } = require('../learning/OutcomeEvaluator.js');
const { beginGoal, settleGoal } = require('../memory/GoalLifecycle.js');

const state = require('./state.js');

// Guard de routing de confianza: tareas con dificultad cruda ≥ a este umbral
// no se bajan a modo fast (modelo barato que no llama tools de forma fiable y
// desactiva plan/reflexión/auto-corrección). Es el MISMO umbral que usa la
// planificación explícita del AgentLoop (PLANNING_DIFFICULTY_THRESHOLD = 0.5):
// si la tarea merece plan, merece el modelo de tarea.
const ROUTING_COMPLEXITY_GUARD = 0.5;

/**
 * Dificultad de una tarea usando la calibración del LearningEngine (heurístico
 * base + ajuste por outcomes reales del modo) si está disponible. Nunca lanza.
 * @param {{ message: string, taskIntent?: object|null, messageCount?: number }} p
 * @returns {number}
 */
function _estimateDifficultyFor({ message, taskIntent = null, messageCount = 0 }) {
  try {
    if (state.learning && typeof state.learning.calibratedDifficulty === 'function') {
      return state.learning.calibratedDifficulty({
        message,
        taskIntent,
        messageCount,
        mode: 'smart',
      });
    }
  } catch (_) {}
  return estimateDifficulty({ message, taskIntent, messageCount });
}

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

  let baseMode = isTask ? 'smart' : 'fast';
  // Fase 3, ítem 4: routing dinámico de confianza (costo×éxito). Conservador:
  // solo se cambia el modo si el TrustModel tiene muestras suficientes, la
  // recomendación es confiable y la ventaja sobre el modo actual supera
  // MODE_ADVANTAGE. Deshabilitable con opts.trustRouting=false; si no hay
  // TrustModel (tests) es un no-op.
  if (
    opts.trustRouting !== false &&
    state.trust &&
    typeof state.trust.recommendMode === 'function'
  ) {
    try {
      let taskIntent = null;
      try {
        taskIntent = state.taskDetector?.detect(userMessage) || null;
      } catch (_) {}
      const difficulty = _estimateDifficultyFor({
        message: userMessage,
        taskIntent,
        messageCount: 0,
      });
      const rec = state.trust.recommendMode({ isTask, difficulty, explicitMode: null });
      if (rec && rec.mode !== baseMode) {
        // Confianza del mejor candidato del modo actual (para comparar).
        const currentBest = state.trust.recommendMode({
          isTask,
          difficulty,
          explicitMode: baseMode,
        });
        const currentTrust = currentBest && currentBest.mode === baseMode ? currentBest.trust : 0;
        // Guard de routing: tareas complejas (heurístico crudo ≥ umbral de
        // planificación) NO bajan a fast. El modo barato no llama tools de
        // forma fiable y termina "planeando" en prosa sin ejecutar; además
        // fast desactiva plan/reflexión/auto-corrección. El heurístico crudo
        // (no calibrado) evita que un modo con buen historial arrastre tareas
        // de código a un modelo débil.
        const rawDifficulty = estimateDifficulty({ message: userMessage, taskIntent });
        const downgradeToFast = rec.mode === 'fast' && rawDifficulty >= ROUTING_COMPLEXITY_GUARD;
        if (
          rec.confidence >= 0.6 &&
          rec.trust - currentTrust >= MODE_ADVANTAGE &&
          !downgradeToFast
        ) {
          logger.info(
            'agent',
            `[trust] routing ${baseMode} → ${rec.mode} (${rec.rationale}, ventaja ${(rec.trust - currentTrust).toFixed(2)})`
          );
          baseMode = rec.mode;
        } else if (downgradeToFast) {
          logger.info(
            'agent',
            `[trust] routing ${baseMode} → ${rec.mode} BLOQUEADO (tarea compleja ≥ ${ROUTING_COMPLEXITY_GUARD}, se mantiene ${baseMode})`
          );
        }
      }
    } catch (_) {}
  }

  return baseMode === 'fast'
    ? { mode: 'fast', maxIterations: 8 }
    : { mode: 'smart', maxIterations: 25 };
}

/**
 * Garantiza que una intención durable nunca quede sin un itinerario mínimo,
 * incluso si el contexto, el proveedor o la planificación fallan antes de
 * entrar al AgentLoop.
 * @param {any} graph
 * @param {any} commitment
 * @param {string} goal
 * @returns {{steps:string[],criteria:string[]}|null}
 */
function ensureFallbackGoalPlan(graph, commitment, goal) {
  if (!graph || !commitment?.id || typeof graph.createGoalPlan !== 'function') return null;
  const existing = graph.getGoalPlan?.(commitment.id) || [];
  if (Array.isArray(existing) && existing.length) return null;
  const subject = String(goal || 'la tarea')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  const plan = {
    steps: [
      `Inspeccionar el contexto real de ${subject}.`,
      'Ejecutar la acción autorizada y registrar su resultado observable.',
      'Verificar el resultado y cerrar sólo con evidencia; si falla, conservar el bloqueo para reanudarlo.',
    ],
    criteria: [
      'Existe evidencia real del contexto y del problema.',
      'La herramienta ejecutada devuelve un resultado observable.',
      'La verificación confirma el objetivo o deja un motivo explícito de reanudación.',
    ],
  };
  graph.createGoalPlan(
    Number(commitment.id),
    plan.steps.map((description, index) => ({
      description,
      successCriteria: [plan.criteria[index]],
    }))
  );
  return plan;
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
 * @param {()=>Array<{text:string,at?:number}>} [opts.consumeSteering] - Correcciones
 *   del usuario que el loop consume entre iteraciones
 * @param {boolean} [opts.rollbackOnVerificationFailure] - Revierte el checkpoint
 *   si falla la verificación; opt-in, nunca lo decide el modelo
 * @param {number} [opts.maxIterations] - Máximo de iteraciones
 * @param {boolean} [opts.evalMode] - Modo benchmark: auto-aprueba toda tool de
 *   alto impacto y suprime la interacción con el usuario (sin onApprovalNeeded)
 * @returns {Promise<{response, iterations, toolResults, error}>}
 */
async function runAgent(userMessage, opts = {}) {
  const _t0 = Date.now();
  const sessionHistory = state.session?.getHistory() || [];
  const sessionId = state.session?.getSessionId?.() || '';
  const workingScope = sessionId ? `session:${sessionId}` : null;

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
    logger.warn('agent', '[core] hook beforeAgentRun falló:', e.message);
  }

  if (blockedReason) {
    return {
      response: blockedReason,
      iterations: 0,
      toolResults: [],
      error: 'blocked_by_plugin',
    };
  }

  // Memoria de trabajo efímera: mantiene el foco ejecutivo de esta sesión.
  // Es contexto, no una concesión de permisos, y expira aunque el proceso siga vivo.
  if (workingScope && state.graph?.setWorkingMemory) {
    state.graph.setWorkingMemory({
      scope: workingScope,
      key: 'current_goal',
      value: { goal: effectiveMessage.slice(0, 1000), status: 'active', startedAt: _t0 },
      ttlMs: 24 * 60 * 60 * 1000,
    });
  }

  // Modo automático por intención; el compromiso durable nace antes de
  // construir contexto para que sobreviva a fallos de grounding/proveedor.
  let { mode, maxIterations } = resolveAgentMode(effectiveMessage, opts);
  const projectCwd =
    state.activeWorkspace ||
    state.openclawWorkspace ||
    require('../planner/ActionParser.js').PROJECT_CWD;
  const continuationHint =
    /^(?:contin[uú]a|continuar|sigue|prosigue|retoma|reanuda|intenta de nuevo|prueba otra vez|corrige lo que falta)\b/i.test(
      String(effectiveMessage || '').trim()
    );
  const resumableIntentions = continuationHint
    ? state.graph?.listActiveIntentions?.({ limit: 50, workspace: projectCwd }) || []
    : [];
  const goalTextMatch = /(?:^|\n)Objetivo:\s*(.+?)\s*$/m.exec(String(effectiveMessage || ''));
  const durableGoal = beginGoal({
    graph:
      mode === 'smart' || (continuationHint && resumableIntentions.length) ? state.graph : null,
    sessionId,
    workspace: projectCwd,
    goal: goalTextMatch?.[1] || effectiveMessage,
    source: opts.executiveRun ? 'governor' : 'interactive',
    governanceClaimed: Boolean(opts.governanceClaimed),
  });
  if (durableGoal && !durableGoal.claimed) {
    return {
      response: 'Ese objetivo ya está en ejecución. Conservaré el progreso actual sin duplicarlo.',
      iterations: 0,
      toolResults: [],
      error: 'goal_already_running',
    };
  }
  // "continúa" debe retomar una tarea activa con el mismo runtime de trabajo,
  // aunque el detector de intención clasifique esa frase aislada como charla.
  if (durableGoal?.resumed && !opts.mode) {
    mode = 'smart';
    maxIterations = 25;
  }

  const context = await buildContext(sessionHistory, null, {
    mode: 'agent',
  });
  logger.info('agent', `[agent-timing] buildContext ${Date.now() - _t0}ms`);

  if (hookPrompt && context?.systemPrompt) {
    context.systemPrompt = context.systemPrompt + '\n\n' + hookPrompt;
  }

  if (!context || !context.systemPrompt) {
    const fallbackPlan = ensureFallbackGoalPlan(state.graph, durableGoal, effectiveMessage);
    const contextFailure = {
      response: null,
      iterations: 0,
      toolResults: [],
      error: 'No se pudo construir contexto',
      plan: fallbackPlan
        ? {
            steps: fallbackPlan.steps,
            criteria: fallbackPlan.criteria,
            stepStates: fallbackPlan.steps.map((_, index) => ({
              ordinal: index + 1,
              status: 'pending',
              evidence: [],
            })),
            done: 0,
            total: fallbackPlan.steps.length,
            coverageComplete: false,
          }
        : null,
    };
    try {
      settleGoal({
        graph: state.graph,
        commitment: durableGoal,
        workspace: projectCwd,
        result: contextFailure,
        evaluation: evaluateTaskOutcome(contextFailure),
      });
    } catch (_) {}
    return contextFailure;
  }

  const { WorkspaceCheckpoint } = require('../git/WorkspaceCheckpoint.js');
  const checkpoint = new WorkspaceCheckpoint({ cwd: projectCwd });
  const loop = new AgentLoop({
    maxIterations,
    bridge: state.bridge,
    mode,
    lsp: state.lspManager,
    repositoryIntelligence: state.repositoryIntelligence,
    graph: state.graph && !state.graph.usingFallback ? state.graph : null,
    checkpoint,
    telemetry: state.telemetry || null,
  });

  // Idioma inferido del turno (GroundingEngine → context.language): el loop
  // lo usa para la línea de respuesta y el locale del navegador managed.
  // Si el caller ya trae uno explícito (tests, SDK), ese manda.
  const responseLanguage =
    opts.responseLanguage || (context.language?.source !== 'default' ? context.language : null);

  const loopOpts = {
    ...opts,
    originalUserMessage: userMessage,
    sessionId,
    workspace: projectCwd,
    responseLanguage,
    taskIntent: context.taskIntent || null,
    tools: context.nativeToolSchemas || null,
    allowedToolNames: context.allowedToolNames || null,
    nativeMcpMap: context.nativeMcpMap || {},
    toolCatalog: context.toolCatalog || null,
    matchedSkills: context.resolvedSkills || null,
    toolResolver: context.nativeToolSchemas ? null : { resolveToolset },
    skillManager: state.skillManager || null,
    mcpManager: state.mcp || null,
    capabilityStatsProvider:
      state.learning && typeof state.learning.capabilityStats === 'function'
        ? () => state.learning.capabilityStats({ minUses: 2 })
        : null,
    skillDb: state.graph && !state.graph.usingFallback && state.graph._db ? state.graph._db : null,
    pluginManager: state.pluginManager || null,
    // La fachada ya ejecutó beforeAgentRun y aplicó sus transformaciones/bloqueo.
    // AgentLoop conserva el hook para usos directos (tests, SDK interno), pero
    // no debe invocarlo dos veces en la ruta normal de Core.runAgent.
    beforeAgentRunHandled: true,
    // En una tarea real el plan es un contrato de ejecución, no una mejora
    // opcional del prompt. AgentLoop conserva el opt-in antiguo para usos
    // directos, pero Core exige plan y cierre con evidencia.
    planning: opts.planning === undefined ? true : opts.planning,
    requirePlan: mode === 'smart',
    strictCompletion: mode === 'smart',
    permissionManager: state.permissionManager || null,
    contextWindowTokens:
      Number(opts.contextWindowTokens) || LLMProvider.getContextStatus?.(mode)?.maxContext || 0,
  };

  // Snapshot mínimo del progreso observable. No guarda params/resultados de
  // tools porque pueden contener rutas privadas, tokens o contenido sensible.
  if (workingScope && state.graph?.setWorkingMemory) {
    const callerOnProgress = loopOpts.onProgress;
    loopOpts.onProgress = (progress) => {
      state.graph.setWorkingMemory({
        scope: workingScope,
        key: 'last_progress',
        value: {
          iteration: Number(progress?.iteration) || 0,
          tool: String(progress?.tool || '').slice(0, 80),
          phase: String(progress?.phase || '').slice(0, 20),
          status: String(progress?.status || '').slice(0, 20),
          at: Date.now(),
        },
        ttlMs: 24 * 60 * 60 * 1000,
      });
      if (typeof callerOnProgress === 'function') callerOnProgress(progress);
    };
  }

  // ── Fase 3 ítem 1: metas persistentes ────────────────────────────────────
  // Si el caller no las inyecta explícitamente, se toman del stack de
  // intenciones activas pendientes (sobreviven al reinicio) y se pasan al
  // loop para que re-planifique al retomar la sesión.
  if (!opts.activeIntentions) {
    try {
      let pending =
        state.graph?.listActiveIntentions?.({
          limit: 10,
          workspace: projectCwd,
        }) || [];
      if (durableGoal && !durableGoal.resumed) {
        pending = pending.filter((item) => Number(item.id) !== durableGoal.id);
      }
      loopOpts.activeIntentions = pending;
    } catch (_) {}
  }
  loopOpts.currentGoalId = durableGoal?.id || null;
  if (durableGoal?.id) {
    try {
      loopOpts.currentGoalPlan = state.graph?.getGoalPlan?.(durableGoal.id) || [];
    } catch (_) {
      loopOpts.currentGoalPlan = [];
    }
  }

  // ── Fase 3 ítem 2: lo aprendido (feedback de proactividad + outcomes de
  //    tareas) entra al loop como sección corta. El loop la recorta primero
  //    bajo presión de presupuesto (es lo menos importante).
  try {
    const detected = state.taskDetector?.detect?.(effectiveMessage) || null;
    const learningSection = state.learning?.buildPromptSection?.({
      domain:
        typeof detected?.domain === 'string'
          ? detected.domain
          : detected?.domain?.id || detected?.domain?.label || null,
    });
    const causalSection = state.graph?.buildCausalMemorySection?.();
    const learnedSections = [learningSection, causalSection].filter(Boolean);
    if (learnedSections.length) loopOpts.learningSection = learnedSections.join('\n\n');
  } catch (_) {}

  try {
    const workingMemorySection = workingScope
      ? state.graph?.buildWorkingMemorySection?.(workingScope)
      : null;
    if (workingMemorySection) loopOpts.workingMemorySection = workingMemorySection;
  } catch (_) {}

  // Self-critique: en modo tarea (smart), al terminar el run con una respuesta
  // de texto el loop compara el resultado contra la intención original del
  // usuario y corrige si hay brecha (acotado a SELF_CRITIQUE_MAX_ROUNDS).
  // No aplica en conversación rápida (fast): duplicaría la latencia de una
  // charla sin herramientas que ejecutar.
  if (opts.selfCritique === undefined && mode === 'smart') {
    loopOpts.selfCritique = true;
  }

  // Reflexión intermedia: en modo tarea (smart), cuando las herramientas
  // empiezan a fallar en cadena el loop se detiene a evaluar el plan
  // ("¿esto funcionó, debo cambiar de plan?") antes de seguir reintentando a
  // ciegas. Igual que selfCritique, no aplica en conversación rápida.
  if (opts.reflection === undefined && mode === 'smart') {
    loopOpts.reflection = true;
  }

  // Plan explícito: en modo tarea (smart) y con dificultad alta, el loop
  // genera un plan de pasos ANTES de actuar, lo inyecta al prompt y devuelve
  // el progreso en el resultado. Igual que selfCritique/reflection, no aplica
  // en conversación rápida (charla simple no necesita planificar).
  if (opts.planning === undefined && mode === 'smart') {
    loopOpts.planning = true;
  }

  // Verificación forzada: en modo tarea (smart), el loop corre el comando de
  // verificación del proyecto (agent.verify.command en config.json, o
  // auto-detect de package.json scripts typecheck→lint→test→build) al cerrar
  // el run tras una mutación. Nunca bloquea la tarea: si no hay nada
  // configurado o el comando no existe, el run cierra igual. Igual que
  // selfCritique/reflection, no aplica en conversación rápida y los
  // subagentes no la reciben (el loop solo verifica con opts.verify presente).
  if (opts.verify === undefined && mode === 'smart') {
    loopOpts.verify = resolveVerifyPlan(state.configPath, projectCwd);
  }
  if (opts.verifyRepair === undefined && mode === 'smart') {
    loopOpts.verifyRepair = true;
  }

  // evalMode: benchmark headless — toda tool de alto impacto se auto-aprueba,
  // sin callback de aprobación (el loop ya la ejecuta si no hay handler).
  if (opts.evalMode) {
    loopOpts.onApprovalNeeded = async () => true;
    loopOpts.evalMode = true;
  }

  // Fase 3, ítem 4: snapshot del UsageTracker antes del run para atribuir a
  // ESTA tarea el coste real (el tracker acumula en memoria, no es por-llamada).
  const usageTracker = LLMProvider.getUsageTracker?.() || null;
  const usageBefore = usageTracker ? usageTracker.recent(0) : [];

  let result;
  try {
    result = await loop.run(
      effectiveMessage,
      context.systemPrompt,
      context.messages || [],
      loopOpts
    );
  } catch (e) {
    logger.error('agent', '[core] excepción no controlada en AgentLoop:', e.message);
    const fallbackPlan =
      (loop._plan && {
        steps: loop._plan.steps || [],
        criteria: loop._plan.criteria || [],
      }) ||
      ensureFallbackGoalPlan(state.graph, durableGoal, effectiveMessage);
    result = {
      response:
        'La ejecución se interrumpió por un evento extraordinario. No voy a afirmar que la tarea terminó; el objetivo queda activo para reanudarlo desde el plan pendiente.',
      iterations: 0,
      toolResults: [],
      error: 'agent_exception',
      plan: fallbackPlan
        ? {
            steps: fallbackPlan.steps,
            criteria: fallbackPlan.criteria,
            stepStates: fallbackPlan.steps.map((_, index) => ({
              ordinal: index + 1,
              status: 'pending',
              evidence: [],
            })),
            done: 0,
            total: fallbackPlan.steps.length,
            coverageComplete: false,
          }
        : null,
    };
  }

  // Registrar la respuesta de Kaoru para evaluación (feedback loop)
  if (result.response && state.graph) {
    try {
      const evaluator = state.graph.getResponseEvaluator?.();
      if (evaluator) {
        // Importar _prevTurnContext de context.js
        const { _prevTurnContext } = require('./context.js');
        evaluator.recordResponse(
          result.response,
          _prevTurnContext.enforcement,
          _prevTurnContext.emotionalCtx,
          _prevTurnContext.adaptationType,
          state.session?.getSessionId?.() ?? null
        );
      }
    } catch (e) {
      logger.debug('agent', '[core] error registrando respuesta para evaluación:', e.message);
    }
  }

  // ── Checkpoint de la tarea: si hubo mutaciones, se ofrece deshacer SOLO los
  //    cambios de este run (ver core/git/WorkspaceCheckpoint.js y el comando
  //    /revertir-tarea). Se adjunta metadata al resultado y un hint al texto.
  const cpMeta = checkpoint.metadata();
  if (cpMeta && cpMeta.canRevert) {
    result.checkpoint = result.rollback?.ok ? { ...cpMeta, rolledBack: true } : cpMeta;
    if (
      !result.rollback?.ok &&
      typeof result.response === 'string' &&
      result.response.trim() &&
      !result.cancelled
    ) {
      const hint = `\n\n[Checkpoint de la tarea creado (${cpMeta.files.length} archivo(s) tocados). Si querés deshacer SOLO los cambios de esta tarea, escribí: \`/revertir-tarea\`]`;
      result.response += hint;
    }
  }

  /**
   * Cierra o conserva el objetivo con la misma evaluación para cualquier vía
   * de salida, incluido el modo degradado.
   * @param {any} finalResult
   */
  const settleDurableGoal = (finalResult) => {
    const evaluation = evaluateTaskOutcome(finalResult);
    try {
      settleGoal({
        graph: state.graph,
        commitment: durableGoal,
        workspace: projectCwd,
        result: finalResult,
        evaluation,
      });
    } catch (e) {
      logger.warn('agent', '[core] no se pudo cerrar el ciclo durable del objetivo:', e.message);
    }
    return evaluation;
  };

  // Si el proveedor falla antes de elegir una herramienta, se devuelve un
  // diagnóstico determinista. No se le pide al mismo LLM caído que explique
  // un supuesto "modo degradado": eso producía negativas inventadas y hacía
  // parecer que Kaoru había perdido capacidades locales que siguen presentes.
  if (result.error === 'llm_failure' && (result.toolResults || []).length === 0) {
    const degradedResult = {
      ...result,
      degraded: true,
      degradedReason: 'provider_unavailable',
      response:
        'No pude iniciar la acción porque el proveedor activo rechazó la solicitud antes de ejecutar el plan. ' +
        'Las herramientas locales de Kaoru siguen disponibles. Reintenta la tarea o elige en Modelos ' +
        'otro modelo compatible con herramientas.',
    };
    settleDurableGoal(degradedResult);
    return degradedResult;
  }

  const evaluatedOutcome = settleDurableGoal(result);

  // Toda tarea smart se registra desde el inicio y se cierra únicamente con
  // evidencia observable. También actualiza el hilo del proyecto activo; las
  // tareas de otros workspaces nunca entran en este ciclo ni en el prompt.
  // ── Fase 3 ítem 1: si la meta queda en vuelo (se agotaron iteraciones o el
  //    usuario canceló), se persiste como intención activa para retomarla al
  //    reanudar la sesión (re-planificación). Las terminadas bien se limpian.
  //    Si el run tuvo un plan explícito, se persisten SUS pasos (no vacío).
  if (
    !durableGoal &&
    (result.error === 'max_iterations_reached' || result.error === 'cancelled' || result.truncated)
  ) {
    try {
      const g = state.graph;
      if (g && !g.usingFallback && typeof g.createIntention === 'function') {
        const planSteps = (result.plan && result.plan.steps) || [];
        const progress =
          `Se interrumpió tras ${result.iterations || 0} iteraciones ` +
          `(${result.error || 'truncado'})${planSteps.length ? ` — plan ${result.plan.done}/${result.plan.total}` : ''}.`;
        const goalMatch = /(?:^|\n)Objetivo:\s*(.+?)\s*$/m.exec(String(effectiveMessage || ''));
        const resumed = goalMatch
          ? (loopOpts.activeIntentions || []).find(
              (item) => String(item.goal || '').trim() === goalMatch[1].trim()
            )
          : null;
        let intentionId = null;
        if (resumed) {
          g.updateIntention(resumed.id, { lastProgress: progress, workspace: projectCwd });
          intentionId = resumed.id;
        } else {
          intentionId = g.createIntention({
            sessionId: state.session?.getSessionId?.() || '',
            goal: userMessage,
            workspace: projectCwd,
            steps: planSteps,
            lastProgress: progress,
          });
        }
        if (intentionId && result.plan && typeof g.recordGoalRunProgress === 'function') {
          g.recordGoalRunProgress(intentionId, result.plan);
        }
      }
    } catch (e) {
      logger.warn('agent', '[core] no se pudo persistir la intención pendiente:', e.message);
    }
  }

  state.bus.emit('agent:completed', { iterations: result.iterations, error: result.error });

  // ── Reanudación por /reanudar-tarea: si el run SÍ completó la tarea que el
  //    comando marcó como "Objetivo: <goal>", se cierra esa intención activa
  //    (ya no queda en vuelo). Solo aplica cuando el prompt efectivo menciona
  //    explícitamente "Objetivo:" — una tarea nueva e independiente no
  //    dispara esto ni completa intenciones ajenas.
  if (!durableGoal && evaluatedOutcome.terminalSuccess && loopOpts.activeIntentions?.length) {
    try {
      const goalMatch = /(?:^|\n)Objetivo:\s*(.+?)\s*$/m.exec(String(effectiveMessage || ''));
      if (goalMatch) {
        const resumeGoal = goalMatch[1].trim();
        const match = loopOpts.activeIntentions.find(
          (it) => String(it.goal || '').trim() === resumeGoal
        );
        if (match) {
          const g = state.graph;
          if (g && !g.usingFallback) {
            const storedPlan = g.getGoalPlan?.(match.id) || [];
            const hasCompletionEvidence =
              evaluatedOutcome.verificationStatus === 'verified' ||
              (storedPlan.length === 0 && evaluatedOutcome.verificationStatus === 'not_applicable');
            if (
              evaluatedOutcome.success &&
              hasCompletionEvidence &&
              typeof g.completeIntention === 'function'
            ) {
              g.completeGoalPlan?.(match.id, {
                status: evaluatedOutcome.verificationStatus,
                reason: evaluatedOutcome.verificationReason,
                source: 'agent_run',
                at: Date.now(),
              });
              g.completeIntention(match.id);
              logger.info(
                'agent',
                `[core] intención #${match.id} completada con evidencia ${evaluatedOutcome.verificationStatus}`
              );
            } else {
              g.updateIntention?.(match.id, {
                lastProgress: `La ejecución terminó, pero requiere verificación (${evaluatedOutcome.verificationReason}).`,
              });
              g.recordGoalEvent?.(match.id, null, 'verification_required', {
                status: evaluatedOutcome.verificationStatus,
                reason: evaluatedOutcome.verificationReason,
              });
            }
          }
        }
      }
    } catch (e) {
      logger.warn('agent', '[core] no se pudo completar la intención reanudada:', e.message);
    }
  }

  // ── Fase 3 ítem 2/4: la evaluación de la tarea alimenta el aprendizaje
  //    (LearningEngine → prompt) y el modelo de confianza (TrustModel →
  //    routing costo×éxito). Se atribuye a esta corrida el delta de tokens y
  //    coste real del UsageTracker. Nunca rompe el flujo.
  try {
    const usageAfter = usageTracker ? usageTracker.recent(0) : [];
    const costUsd = usageAfter.slice(usageBefore.length).reduce((a, e) => a + (e.costUsd || 0), 0);
    const provider = LLMProvider.getActiveProvider() || 'unknown';
    const model = LLMProvider.getActiveModel(mode) || null;
    const evaluated = evaluatedOutcome;
    const elapsedMs = Date.now() - _t0;
    const taskIntent = state.taskDetector?.detect(effectiveMessage);
    const difficulty = _estimateDifficultyFor({
      message: effectiveMessage,
      taskIntent,
      messageCount: sessionHistory.length,
    });
    const toolSequence = (result.toolResults || [])
      .filter((item) => item?.ok)
      .map((item) => String(item.tool || item._action?.tool || ''))
      .filter(Boolean);
    const capabilities = (result.toolResults || []).filter(Boolean).map((item) => {
      const tool = String(item._action?.tool || item.tool || 'unknown');
      const action = item._action || {};
      if (tool === 'mcp') {
        return `mcp:${String(action.params?.server || 'unknown')}/${String(action.params?.tool || 'unknown')}`;
      }
      if (tool.startsWith('github_')) return `github:${tool}`;
      if (tool.startsWith('git_')) return `git:${tool}`;
      return `openclaw:${tool}`;
    });
    const outcome = {
      mode,
      provider,
      model,
      success: evaluated.success,
      terminalSuccess: evaluated.terminalSuccess,
      verificationStatus: evaluated.verificationStatus,
      verificationReason: evaluated.verificationReason,
      mutationCount: evaluated.mutationCount,
      successfulTools: evaluated.successfulTools,
      rollbackAvailable: Boolean(result.checkpoint?.canRevert && !result.checkpoint?.rolledBack),
      sessionId: sessionId || null,
      error: result.error || null,
      iterations: result.iterations,
      elapsedMs,
      difficulty,
      costUsd,
      goal: effectiveMessage,
      taskDomain:
        typeof taskIntent?.domain === 'string'
          ? taskIntent.domain
          : taskIntent?.domain?.id || taskIntent?.domain?.label || null,
      toolSequence,
      capabilities,
      // Loop de feedback de SKILLS: qué skills estaban inyectadas en ESTE run.
      // Guard de frescura (15 min) por si una ejecución concurrente pisó el
      // lastInjection del manager entre la inyección y este punto.
      skills:
        state.skillManager?.lastInjection &&
        Date.now() - state.skillManager.lastInjection.ts < 15 * 60 * 1000
          ? state.skillManager.lastInjection.names
          : [],
    };

    if (state.learning && typeof state.learning.recordTaskOutcome === 'function') {
      state.learning.recordTaskOutcome(outcome);
    }
    if (state.trust && typeof state.trust.recordOutcome === 'function') {
      state.trust.recordOutcome(outcome);
    }
    state.graph?.recordTaskOutcomeEvidence?.(outcome);
    if (workingScope && state.graph?.setWorkingMemory) {
      state.graph.setWorkingMemory({
        scope: workingScope,
        key: 'current_goal',
        value: {
          goal: effectiveMessage.slice(0, 1000),
          status: evaluated.success ? 'completed' : 'needs_attention',
          verification: evaluated.verificationStatus,
          reason: evaluated.verificationReason,
          finishedAt: Date.now(),
        },
        ttlMs: 24 * 60 * 60 * 1000,
      });
      if (result.plan) {
        state.graph.setWorkingMemory({
          scope: workingScope,
          key: 'last_plan',
          value: {
            steps: Array.isArray(result.plan.steps) ? result.plan.steps.slice(0, 20) : [],
            done: Number(result.plan.done) || 0,
            total: Number(result.plan.total) || 0,
          },
          ttlMs: 24 * 60 * 60 * 1000,
        });
      }
    }
  } catch (_) {}

  logger.info(
    'agent',
    `[agent-timing] loop total ${Date.now() - _t0}ms (${result.iterations} iteraciones)`
  );
  result.executionMode = mode;
  result.memoryContextIds = (context.memoryReferences || [])
    .filter((ref) => context.systemPrompt.includes(ref.line))
    .map((ref) => ref.id);
  return result;
}

module.exports = {
  runAgent,
  resolveAgentMode,
};
