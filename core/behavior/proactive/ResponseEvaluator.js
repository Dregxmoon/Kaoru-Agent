// @ts-check
'use strict';

/**
 * ResponseEvaluator.js — Evalúa la calidad de las respuestas de Kaoru
 * y alimenta el FeedbackScorer con datos de efectividad.
 *
 * Métricas:
 *   1. ¿Se cumplió el enforcement? (reglas obligatorias)
 *   2. ¿El usuario respondió mejor? (engagement delta)
 *   3. ¿La respuesta fue apropiada para la emoción?
 *   4. ¿Se evitaron las frases prohibidas?
 *
 * El evaluator corre DESPUÉS de que Kaoru responde y el usuario responde.
 * No bloquea el flujo — es asíncrono y solo registra datos.
 */

const logger = require('../../observability/Logger.js');

// ── Patrones de respuesta inapropiada ──────────────────────────────────────

const INAPPROPRIATE_PATTERNS = {
  frustration: [
    /^(¡Claro|¡Por supuesto|¿En qué puedo ayudarte|Como asistente)/i,
    /¿cómo va todo\?/i,
    /¿en qué te puedo ayudar\?/i,
  ],
  urgency: [
    /déjame explicarte/i,
    /antes de empezar/i,
    /para entender mejor/i,
    /primero necesito que/i,
  ],
  confusion: [
    /es obvio/i,
    /solo tienes que/i,
    /es fácil/i,
    /cualquier persona sabe/i,
  ],
};

// ── Score de calidad de respuesta ───────────────────────────────────────────

/**
 * Evalúa si una respuesta de Kaoru cumple con las reglas de enforcement.
 * @param {string} kaoruResponse  respuesta de Kaoru
 * @param {Object} enforcement    resultado de PromptEnforcer.enforce()
 * @param {Object} emotionalCtx   contexto emocional detectado
 * @returns {{ score: number, violations: string[], passed: boolean }}
 */
function _evaluateResponse(kaoruResponse, enforcement, emotionalCtx) {
  if (!kaoruResponse || !enforcement) {
    return { score: 0.5, violations: [], passed: true };
  }

  const violations = [];
  let score = 1.0;

  // 1. Verificar frases prohibidas
  if (enforcement.forbidden?.length) {
    for (const phrase of enforcement.forbidden) {
      if (kaoruResponse.toLowerCase().includes(phrase.toLowerCase())) {
        violations.push(`frase prohibida: "${phrase}"`);
        score -= 0.2;
      }
    }
  }

  // 2. Verificar patrones inapropiados para la emoción
  if (emotionalCtx) {
    const dominant = _getDominant(emotionalCtx);
    if (dominant && INAPPROPRIATE_PATTERNS[dominant]) {
      for (const pattern of INAPPROPRIATE_PATTERNS[dominant]) {
        if (pattern.test(kaoruResponse)) {
          violations.push(`patrón inapropiado para ${dominant}`);
          score -= 0.3;
        }
      }
    }
  }

  // 3. Verificar extensión máxima
  if (enforcement.maxTokens) {
    const estimatedTokens = Math.ceil(kaoruResponse.length / 4); // estimación rough
    if (estimatedTokens > enforcement.maxTokens * 1.5) {
      violations.push(`respuesta muy larga: ~${estimatedTokens} tokens (máx: ${enforcement.maxTokens})`);
      score -= 0.1;
    }
  }

  // 4. Verificar que no sea demasiado corta (si no es urgency)
  if (kaoruResponse.length < 5 && emotionalCtx?.urgency < 0.5) {
    violations.push('respuesta demasiado corta');
    score -= 0.1;
  }

  return {
    score: Math.max(0, Math.min(1, score)),
    violations,
    passed: violations.length === 0,
  };
}

/**
 * Obtiene la emoción dominante.
 * @param {Object} emotionalCtx
 * @returns {string|null}
 */
function _getDominant(emotionalCtx) {
  const emotions = ['frustration', 'enthusiasm', 'confusion', 'urgency', 'calm', 'playfulness'];
  let max = 0;
  let dominant = null;
  for (const e of emotions) {
    if (emotionalCtx[e] > 0.5 && emotionalCtx[e] > max) {
      max = emotionalCtx[e];
      dominant = e;
    }
  }
  return dominant;
}

/**
 * Calcula el delta de engagement entre dos turnos del usuario.
 * @param {number} preEngagement  engagement antes de la adaptación
 * @param {number} postEngagement  engagement después de la adaptación
 * @returns {{ delta: number, improved: boolean }}
 */
function _computeEngagementDelta(preEngagement, postEngagement) {
  const delta = postEngagement - preEngagement;
  return {
    delta,
    improved: delta > 0.05, // 5% de mejora se considera significativa
  };
}

class ResponseEvaluator {
  /**
   * @param {import('../state-graph/evolution/FeedbackScorer.js').FeedbackScorer} feedbackScorer
   */
  constructor(feedbackScorer) {
    this._feedbackScorer = feedbackScorer;
    this._pendingEvaluation = null;
  }

  /**
   * Registra una respuesta de Kaoru para evaluación posterior.
   * @param {string} kaoruResponse
   * @param {Object} enforcement
   * @param {Object} emotionalCtx
   * @param {string} adaptationType
   */
  recordResponse(kaoruResponse, enforcement, emotionalCtx, adaptationType) {
    this._pendingEvaluation = {
      response: kaoruResponse,
      enforcement,
      emotionalCtx,
      adaptationType,
      timestamp: Date.now(),
    };
  }

  /**
   * Evalúa la calidad de la respuesta y actualiza el FeedbackScorer.
   * Llamado después de que el usuario responde.
   * @param {number} userEngagement  engagement del turno del usuario
   * @returns {{ quality: number, feedbackApplied: boolean }}
   */
  evaluate(userEngagement) {
    if (!this._pendingEvaluation) {
      return { quality: 0.5, feedbackApplied: false };
    }

    const { response, enforcement, emotionalCtx, adaptationType } = this._pendingEvaluation;

    // Evaluar calidad de la respuesta
    const evaluation = _evaluateResponse(response, enforcement, emotionalCtx);

    // Calcular delta de engagement
    const engagementImproved = userEngagement > 0.5; // threshold simple

    // Combinar scores
    const combinedScore = evaluation.score * 0.6 + (engagementImproved ? 0.4 : 0);

    // Actualizar FeedbackScorer
    if (adaptationType && this._feedbackScorer) {
      const delta = combinedScore - 0.5; // normalizar a [-0.5, 0.5]
      this._feedbackScorer.updateScore(adaptationType, delta);
    }

    this._pendingEvaluation = null;

    return {
      quality: combinedScore,
      feedbackApplied: !!adaptationType,
      violations: evaluation.violations,
    };
  }

  /**
   * Evalúa una respuesta sin actualizar el FeedbackScorer (dry-run).
   * @param {string} kaoruResponse
   * @param {Object} enforcement
   * @param {Object} emotionalCtx
   * @returns {{ score: number, violations: string[], passed: boolean }}
   */
  evaluateDryRun(kaoruResponse, enforcement, emotionalCtx) {
    return _evaluateResponse(kaoruResponse, enforcement, emotionalCtx);
  }
}

module.exports = { ResponseEvaluator, _evaluateResponse, _computeEngagementDelta };
