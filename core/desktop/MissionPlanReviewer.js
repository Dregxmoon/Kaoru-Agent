// @ts-check
'use strict';

const LLMProvider = require('../llm/LLMProvider.js');
const { validateMission } = require('./DesktopMissionLoop.js');

const REVIEW_TOOL = {
  name: 'mission_plan_review',
  description: 'Evaluación independiente de la cobertura y fuerza de las evidencias de la misión.',
  inputSchema: {
    type: 'object',
    properties: {
      covered: { type: 'boolean', description: 'Cada resultado pedido tiene un paso verificable' },
      gaps: {
        type: 'array',
        items: { type: 'string' },
        description: 'Resultados del usuario ausentes en los pasos',
      },
      weakSteps: {
        type: 'array',
        items: { type: 'number' },
        description: 'Ordinales cuya postcondición no demuestra el resultado descrito',
      },
    },
    required: ['covered', 'gaps', 'weakSteps'],
  },
};

/** @typedef {{covered:boolean,gaps:string[],weakSteps:number[],error:string|null}} PlanReview */

/** @param {unknown} value @param {number} max */
function text(value, max) {
  return String(value || '')
    .trim()
    .slice(0, max);
}

/** @param {unknown} raw @param {number} total @returns {PlanReview} */
function validatePlanReview(raw, total) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { covered: false, gaps: [], weakSteps: [], error: 'review_missing' };
  }
  const review = /** @type {Record<string,unknown>} */ (raw);
  if (
    typeof review.covered !== 'boolean' ||
    !Array.isArray(review.gaps) ||
    !Array.isArray(review.weakSteps)
  ) {
    return { covered: false, gaps: [], weakSteps: [], error: 'review_invalid' };
  }
  const malformedGaps = review.gaps.some((gap) => typeof gap !== 'string' || !gap.trim());
  const malformedWeakSteps = review.weakSteps.some(
    (ordinal) =>
      typeof ordinal !== 'number' || !Number.isInteger(ordinal) || ordinal < 1 || ordinal > total
  );
  if (malformedGaps || malformedWeakSteps) {
    return { covered: false, gaps: [], weakSteps: [], error: 'review_invalid' };
  }
  const gaps = review.gaps.map((gap) => text(gap, 200)).slice(0, 12);
  const weakSteps = review.weakSteps.slice(0, 12);
  const covered =
    review.covered === true && review.gaps.length === 0 && review.weakSteps.length === 0;
  return {
    covered,
    gaps,
    weakSteps,
    error: covered
      ? null
      : typeof review.error === 'string'
        ? text(review.error, 100)
        : 'mission_plan_incomplete',
  };
}

/**
 * Revisión focal de resultados, separada del modelo que construyó el plan.
 * Solo evalúa; el permiso y la ejecución siguen en el gate de AgentLoop.
 * @param {unknown} plan
 * @param {{model?:(messages:any[],systemPrompt:string,tools:any[],mode:string,opts:any)=>Promise<any>,
 * signal?:AbortSignal|null}} [options]
 * @returns {Promise<PlanReview>}
 */
async function reviewMissionPlan(plan, options = {}) {
  let mission;
  try {
    mission = validateMission(plan);
  } catch (cause) {
    return {
      covered: false,
      gaps: [cause instanceof Error ? text(cause.message, 200) : 'Plan inválido'],
      weakSteps: [],
      error: 'mission_plan_invalid',
    };
  }
  if (options.signal?.aborted) {
    return { covered: false, gaps: [], weakSteps: [], error: 'cancelled' };
  }
  const model = options.model || LLMProvider.completeWithTools;
  const systemPrompt = [
    'Revisa una misión de escritorio como auditor independiente del planificador.',
    'Interpreta la petición en su idioma original; no dependas de palabras clave ni traducción fija.',
    'Cada resultado solicitado debe aparecer en un paso y tener una postcondición que demuestre el resultado.',
    'Un control que permite actuar (p. ej. un botón de envío) no demuestra que la acción ocurrió.',
    'No ejecutes herramientas del escritorio. Emite exactamente mission_plan_review.',
    'Si una tarea se omitió o la evidencia es débil, covered=false y explica gaps/weakSteps.',
  ].join('\n');
  try {
    const result = await model(
      [{ role: 'user', content: JSON.stringify(mission) }],
      systemPrompt,
      [REVIEW_TOOL],
      'smart',
      { signal: options.signal || null }
    );
    if (options.signal?.aborted) {
      return { covered: false, gaps: [], weakSteps: [], error: 'cancelled' };
    }
    const calls = Array.isArray(result?.toolCalls) ? result.toolCalls : [];
    if (calls.length !== 1 || calls[0].tool !== REVIEW_TOOL.name) {
      return { covered: false, gaps: [], weakSteps: [], error: 'review_missing' };
    }
    return validatePlanReview(calls[0].params, mission.steps.length);
  } catch (cause) {
    return {
      covered: false,
      gaps: [],
      weakSteps: [],
      error: options.signal?.aborted
        ? 'cancelled'
        : text(cause instanceof Error ? cause.message : cause, 200) || 'review_failed',
    };
  }
}

module.exports = { REVIEW_TOOL, reviewMissionPlan, validatePlanReview };
