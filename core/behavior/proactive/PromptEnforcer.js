// @ts-check
'use strict';

/**
 * PromptEnforcer.js — Forza comportamiento en el system prompt basado en
 * contexto emocional, efectividad de adaptaciones y momentum de topics.
 *
 * A diferencia de "sugerir" al LLM, este módulo genera REGLAS DUROS que
 * el system prompt debe seguir. El LLM no puede ignorarlas.
 *
 * Flujo:
 *   1. Recibe emotionalCtx + topicCtx + effectivenessData
 *   2. Genera reglas de comportamiento forzadas
 *   3. Inyecta en el system prompt como "REGLAS OBLIGATORIAS"
 *   4. After-response evaluator mide si se cumplió
 */

const logger = require('../../observability/Logger.js');

// ── Reglas de comportamiento por emoción ────────────────────────────────────

const EMOTION_RULES = {
  frustration: {
    hard: [
      'NO preguntes "¿cómo va?" o "¿en qué puedo ayudarte?"',
      'Ve directo al grano. Sin preámbulos.',
      'Sé concisa (1-2 oraciones máximo)',
      'Empatía: reconoce el problema antes de proponer solución',
    ],
    forbidden: ['¡Claro!', '¡Por supuesto!', '¿En qué puedo ayudarte?'],
    maxTokens: 80,
  },
  enthusiasm: {
    hard: [
      'Celebra el logro con ella. Sé genuina, no protocolar',
      'Muestra interés: haz una pregunta sobre cómo lo logró',
      'Matchea su energía: usa un tono positivo',
    ],
    forbidden: ['Qué bien', 'Genial', 'Interesante'],
    maxTokens: 120,
  },
  confusion: {
    hard: [
      'Explica paso a paso. No des por sentado nada',
      'Usa ejemplos concretos',
      'Verifica que entendió antes de continuar',
    ],
    forbidden: ['Es obvio', 'Solo tienes que', 'Es fácil'],
    maxTokens: 200,
  },
  urgency: {
    hard: [
      'RESPUESTA ULTRA-BREVE (1 oración si es posible)',
      'Solo la acción necesaria. Nada de contexto',
      'Si hay múltiples pasos, dame el primero y espera',
    ],
    forbidden: ['Déjame explicarte', 'Antes de empezar', 'Para entender mejor'],
    maxTokens: 60,
  },
  calm: {
    hard: [
      'Puedes ser más detallada si es necesario',
      'Mantén un tono relajado',
    ],
    forbidden: [],
    maxTokens: 150,
  },
  playfulness: {
    hard: [
      'Matchea el tono ligero',
      'Puedes usar humor si es natural',
      'No seas demasiado seria',
    ],
    forbidden: ['Eso no es apropiado', 'Deberíamos ser serios'],
    maxTokens: 120,
  },
};

// ── Reglas de comportamiento por efectividad ────────────────────────────────

const EFFECTIVENESS_RULES = {
  low_effectiveness: {
    // Si una adaptación tiene <40% de efectividad, INVERTIR el comportamiento
    instruction: 'La adaptación anterior no funcionó. Invierte el comportamiento.',
    examples: {
      responseLength: 'Si estabas siendo breve, sé más detallada',
      formality: 'Si estabas siendo formal, sé más casual',
      technicalLevel: 'Si estabas siendo técnica, usa lenguaje más simple',
    },
  },
  high_effectiveness: {
    // Si una adaptación tiene >70% de efectividad, MANTENER el comportamiento
    instruction: 'La adaptación anterior funcionó. Mantén ese estilo.',
  },
};

// ── Reglas de comportamiento por momentum de topics ─────────────────────────

const TOPIC_RULES = {
  hot_topic: {
    hard: [
      'Conecta tu respuesta con este topic si es natural',
      'Puedes hacer preguntas sobre este topic',
    ],
  },
  cold_topic: {
    hard: [
      'Si es natural, retoma este topic',
      'Pregúntale cómo va sin ser intrusiva',
    ],
  },
};

class PromptEnforcer {
  /**
   * @param {import('../state-graph/evolution/FeedbackScorer.js').FeedbackScorer} feedbackScorer
   */
  constructor(feedbackScorer) {
    this._feedbackScorer = feedbackScorer;
  }

  /**
   * Genera reglas de comportamiento forzadas basado en el contexto actual.
   * @param {Object} emotionalCtx  resultado de LLMEotionDetector.detect()
   * @param {Object} topicCtx      resultado de TopicMomentumTracker
   * @param {string} adaptationType  tipo de adaptación aplicada
   * @returns {{ rules: string[], forbidden: string[], maxTokens: number, reason: string }}
   */
  enforce(emotionalCtx, topicCtx = null, adaptationType = null) {
    const rules = [];
    const forbidden = [];
    let maxTokens = 150; // default
    const reasons = [];

    // 1. Reglas emocionales (HARD - no opcionales)
    if (emotionalCtx) {
      const dominantEmotion = this._getDominantEmotion(emotionalCtx);
      if (dominantEmotion && EMOTION_RULES[dominantEmotion]) {
        const emotionRules = EMOTION_RULES[dominantEmotion];
        rules.push(...emotionRules.hard);
        forbidden.push(...emotionRules.forbidden);
        maxTokens = Math.min(maxTokens, emotionRules.maxTokens);
        reasons.push(`emoción dominante: ${dominantEmotion}`);
      }
    }

    // 2. Reglas de efectividad (si hay historial)
    if (adaptationType && this._feedbackScorer) {
      const effectiveness = this._feedbackScorer.getEffectiveness(adaptationType);
      if (effectiveness < 0.4) {
        // Adaptación inefectiva - invertir comportamiento
        const effRules = EFFECTIVENESS_RULES.low_effectiveness;
        rules.push(effRules.instruction);
        if (effRules.examples[adaptationType]) {
          rules.push(effRules.examples[adaptationType]);
        }
        reasons.push(`efectividad baja: ${(effectiveness * 100).toFixed(0)}%`);
      } else if (effectiveness > 0.7) {
        // Adaptación efectiva - mantener
        rules.push(EFFECTIVENESS_RULES.high_effectiveness.instruction);
        reasons.push(`efectividad alta: ${(effectiveness * 100).toFixed(0)}%`);
      }
    }

    // 3. Reglas de momentum de topics
    if (topicCtx) {
      if (topicCtx.hotTopics?.length) {
        rules.push(...TOPIC_RULES.hot_topic.hard);
        reasons.push(`topics calientes: ${topicCtx.hotTopics.join(', ')}`);
      }
      if (topicCtx.coldTopics?.length) {
        rules.push(...TOPIC_RULES.cold_topic.hard);
        reasons.push(`topics fríos: ${topicCtx.coldTopics.join(', ')}`);
      }
    }

    return {
      rules,
      forbidden,
      maxTokens,
      reason: reasons.join(' | ') || 'sin reglas especiales',
    };
  }

  /**
   * Serializa las reglas para inyectar en el system prompt.
   * @param {Object} enforcement  resultado de enforce()
   * @returns {string} sección de texto para el prompt
   */
  serialize(enforcement) {
    if (!enforcement.rules.length) return '';

    const lines = ['# REGLAS OBLIGATORIAS (el usuario no debe ver esto)'];

    for (let i = 0; i < enforcement.rules.length; i++) {
      lines.push(`${i + 1}. ${enforcement.rules[i]}`);
    }

    if (enforcement.forbidden.length) {
      lines.push(`\nNUNCA uses estas frases: ${enforcement.forbidden.join(', ')}`);
    }

    lines.push(`\nExtensión máxima: ~${enforcement.maxTokens} tokens`);

    return lines.join('\n');
  }

  /**
   * Obtiene la emoción dominante del contexto emocional.
   * @param {Object} emotionalCtx
   * @returns {string|null}
   */
  _getDominantEmotion(emotionalCtx) {
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
}

module.exports = { PromptEnforcer, EMOTION_RULES, EFFECTIVENESS_RULES };
