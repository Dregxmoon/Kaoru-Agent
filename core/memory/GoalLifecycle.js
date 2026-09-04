// @ts-check
'use strict';

/**
 * Ciclo durable de objetivos del agente.
 *
 * Esta capa no autoriza herramientas ni interpreta promesas del LLM. Sólo une
 * el objetivo con evidencia producida por AgentLoop/OutcomeEvaluator, conserva
 * el punto de reanudación y proyecta el estado al compañero del workspace.
 */

/** @param {unknown} value @param {number} [max] */
function text(value, max = 1000) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, max);
}

/**
 * @typedef {{
 *   usingFallback?:boolean,
 *   listActiveIntentions?:(opts?:object)=>Array<any>,
 *   createIntention?:(opts:object)=>number|null,
 *   updateIntention?:(id:number,opts:object)=>boolean,
 *   completeIntention?:(id:number)=>boolean,
 *   getGoalPlan?:(id:number)=>Array<any>,
 *   createGoalPlan?:(id:number,steps:Array<any>)=>Array<any>,
 *   recordGoalRunProgress?:(id:number,plan:object)=>object,
 *   getGoalResumePoint?:(id:number)=>any,
 *   completeGoalPlan?:(id:number,verification:object)=>boolean,
 *   recordGoalEvent?:(id:number,ordinal:number|null,type:string,metadata?:object)=>number|null,
 *   updateProjectCompanion?:(opts:object)=>any,
 * }} GoalGraph
 * @typedef {{id:number, goal:string, resumed:boolean}} GoalCommitment
 * @typedef {{
 *   terminalSuccess:boolean,
 *   success:boolean,
 *   verificationStatus:string,
 *   verificationReason:string,
 *   mutationCount:number,
 * }} GoalEvaluation
 */

/**
 * Abre o retoma el compromiso exacto del workspace.
 * @param {{graph:GoalGraph|null|undefined,sessionId:string,workspace:string,goal:string}} input
 * @returns {GoalCommitment|null}
 */
function beginGoal({ graph, sessionId, workspace, goal }) {
  const normalizedGoal = text(goal);
  if (!graph || graph.usingFallback || !sessionId || !workspace || !normalizedGoal) return null;
  const active = graph.listActiveIntentions?.({ limit: 50, workspace }) || [];
  const prior = active.find((item) => text(item?.goal) === normalizedGoal);
  let id = Number(prior?.id) || 0;
  if (!id) {
    id = Number(
      graph.createIntention?.({
        sessionId,
        workspace,
        goal: normalizedGoal,
        steps: [],
        lastProgress: 'Objetivo registrado; esperando el primer resultado observable.',
      })
    );
  }
  if (!id) return null;
  graph.recordGoalEvent?.(id, null, prior ? 'goal_resumed' : 'goal_started', {
    workspace,
    source: 'agent_run',
  });
  graph.updateProjectCompanion?.({
    workspace,
    objective: normalizedGoal,
    phase: 'building',
    blocker: null,
    eventType: prior ? 'goal_resumed' : 'goal_started',
  });
  return { id, goal: normalizedGoal, resumed: Boolean(prior) };
}

/** @param {GoalGraph} graph @param {number} id @param {any} plan */
function attachPlan(graph, id, plan) {
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  if (!steps.length || (graph.getGoalPlan?.(id) || []).length) return;
  graph.createGoalPlan?.(id, steps);
}

/**
 * Cierra una corrida con evidencia externa al texto del modelo. Una mutación
 * sin verificación permanece activa y vuelve exactamente al paso pendiente.
 * @param {{graph:GoalGraph|null|undefined,commitment:GoalCommitment|null,workspace:string,result:any,evaluation:GoalEvaluation}} input
 * @returns {{state:'ignored'|'completed'|'active',resumePoint?:any}}
 */
function settleGoal({ graph, commitment, workspace, result, evaluation }) {
  if (!graph || !commitment) return { state: 'ignored' };
  const id = commitment.id;
  attachPlan(graph, id, result?.plan);
  if (result?.plan) graph.recordGoalRunProgress?.(id, result.plan);

  const verifiedCompletion =
    evaluation.success &&
    evaluation.terminalSuccess &&
    (evaluation.verificationStatus === 'verified' ||
      (evaluation.verificationStatus === 'not_applicable' && evaluation.mutationCount === 0));
  const verification = {
    status: evaluation.verificationStatus,
    reason: evaluation.verificationReason,
    source: 'agent_run',
    at: Date.now(),
  };

  if (verifiedCompletion) {
    graph.completeGoalPlan?.(id, verification);
    graph.completeIntention?.(id);
    graph.recordGoalEvent?.(id, null, 'goal_completed', verification);
    graph.updateProjectCompanion?.({
      workspace,
      objective: null,
      blocker: null,
      nextStep: null,
      lastProgress: `Objetivo completado con evidencia ${evaluation.verificationStatus}: ${commitment.goal}`,
      phase: 'paused',
      eventType: 'goal_completed',
    });
    return { state: 'completed' };
  }

  const resumePoint = graph.getGoalResumePoint?.(id) || null;
  const interrupted = Boolean(result?.cancelled || result?.truncated || result?.error);
  const needsVerification = ['unverified', 'failed'].includes(evaluation.verificationStatus);
  const progress = interrupted
    ? `Ejecución interrumpida: ${text(result?.error || 'cancelled', 200)}.`
    : `La ejecución terminó, pero el objetivo requiere verificación: ${text(
        evaluation.verificationReason,
        300
      )}.`;
  graph.updateIntention?.(id, { workspace, lastProgress: progress });
  graph.recordGoalEvent?.(id, resumePoint?.step?.ordinal || null, 'goal_needs_attention', {
    error: result?.error || null,
    verification: evaluation.verificationStatus,
    reason: evaluation.verificationReason,
  });
  graph.updateProjectCompanion?.({
    workspace,
    objective: commitment.goal,
    blocker: needsVerification || result?.error ? text(evaluation.verificationReason, 500) : null,
    nextStep:
      resumePoint?.step?.description ||
      'Revisar el resultado y continuar desde la evidencia disponible',
    lastProgress: progress,
    phase: needsVerification ? 'verifying' : interrupted ? 'paused' : 'building',
    eventType: 'goal_needs_attention',
  });
  return { state: 'active', resumePoint };
}

module.exports = { beginGoal, settleGoal, attachPlan };
