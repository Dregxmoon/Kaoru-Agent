// @ts-check
'use strict';

/**
 * adaptive-integration.js — Integración profunda de los componentes evolutivos
 * con el ProactiveEngine.
 *
 * Conecta:
 *   - FeedbackScorer → mide efectividad de adaptaciones
 *   - LLMEotionDetector → detecta emociones reales (no solo regex)
 *   - TopicMomentumTracker → usa momentum real para decidir QUÉ traer
 *
 * Este mixin se monta en ProactiveEngine.prototype y provee:
 *   - _buildEmotionalContext() → contexto emocional para el prompt
 *   - _buildTopicContext() → contexto de momentum para el prompt
 *   - _recordAdaptationFeedback() → feedback loop post-adaptación
 *   - _shouldAdaptStyle() → decide si vale la pena adaptar
 */

const logger = require('../../../observability/Logger.js');

// ── Helper: detección de engagement del usuario ─────────────────────────────

/**
 * Calcula un score de engagement para un turno del usuario.
 * @param {string} message
 * @returns {number} 0-1
 */
function _engagementScore(message) {
  if (!message || typeof message !== 'string') return 0.3;
  let score = 0.3;
  const len = message.length;
  if (len > 150) score += 0.3;
  else if (len > 50) score += 0.2;
  else if (len < 15) score += 0.1;
  if (/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u.test(message)) score += 0.1;
  if (/\?|¿/.test(message)) score += 0.15;
  if (/[!¡]/.test(message)) score += 0.05;
  return Math.min(1, score);
}

module.exports = {
  /**
   * Construye el contexto emocional para el prompt del LLM proactivo.
   * Usa LLMEotionDetector si está disponible, fallback a TraitLearner regex.
   * @param {Object} trigger
   * @returns {Promise<string>} sección de texto para el prompt
   */
  async _buildEmotionalContext(trigger) {
    try {
      const graph = this._graph;
      if (!graph?._ready) return '';

      // Obtener detector de emociones (LLM o fallback)
      const detector = graph._llmEmotionDetector || null;

      // Obtener los últimos 3 turnos del usuario para contexto
      const history = typeof graph.getRecentHistory === 'function'
        ? graph.getRecentHistory(3)
        : [];

      const lastUserMsg = history.filter((h) => h.role === 'user').pop();
      if (!lastUserMsg) return '';

      const emotions = detector
        ? await detector.detect(lastUserMsg.content, { history })
        : await this._detectEmotionsFallback(lastUserMsg.content);

      const parts = [];

      // Emociones dominantes
      const dominant = Object.entries(emotions)
        .filter(([k, v]) => typeof v === 'number' && v > 0.4 && !['tone', 'energy', 'implicitIntent'].includes(k))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2);

      if (dominant.length) {
        const emotionStr = dominant.map(([k, v]) => `${k} (${Math.round(v * 100)}%)`).join(', ');
        parts.push(`Estado emocional del usuario: ${emotionStr}`);
      }

      // Tono detectado
      if (emotions.tone) {
        parts.push(`Tono de la conversación: ${emotions.tone}`);
      }

      // Energía
      if (emotions.energy) {
        parts.push(`Energía: ${emotions.energy}`);
      }

      // Intención implícita
      if (emotions.implicitIntent && emotions.implicitIntent !== 'none') {
        const intentMap = {
          seeking_help: 'busca ayuda (no lo dice directamente)',
          venting: 'se está desahogando (no necesita solución, necesita que lo escuchen)',
          sharing_achievement: 'comparte un logro (celebra con él)',
          casual_chat: 'quiere charlar casual (no tiene agenda)',
          asking_question: 'hace una pregunta real (respóndele directamente)',
        };
        if (intentMap[emotions.implicitIntent]) {
          parts.push(`Intención implícita: ${intentMap[emotions.implicitIntent]}`);
        }
      }

      // Ajuste de comportamiento según emociones
      if (emotions.frustration > 0.6) {
        parts.push('INSTRUCCIÓN: El usuario está frustrado. Sé breve, empática y directa. No preguntes "¿cómo va?" — ve al grano.');
      }
      if (emotions.enthusiasm > 0.6) {
        parts.push('INSTRUCCIÓN: El usuario está entusiasmado. Celebra con él, muestra interés genuino.');
      }
      if (emotions.confusion > 0.5) {
        parts.push('INSTRUCCIÓN: El usuario está confundido. Explica de forma simple, paso a paso.');
      }
      if (emotions.urgency > 0.6) {
        parts.push('INSTRUCCIÓN: Hay urgencia. Sé ultra-breve y accionable.');
      }

      return parts.length ? `\nCONTEXTO EMOCIONAL:\n- ${parts.join('\n- ')}` : '';
    } catch (e) {
      logger.debug('adaptive-integration', `Error en emotional context: ${e.message}`);
      return '';
    }
  },

  /**
   * Construye el contexto de momentum de topics para el prompt.
   * @param {Object} trigger
   * @returns {string} sección de texto para el prompt
   */
  _buildTopicContext(trigger) {
    try {
      const graph = this._graph;
      if (!graph?._ready || !graph._topicMomentum) return '';

      const tracker = graph._topicMomentum;
      const hotTopics = tracker.getHotTopics(5);
      const coldTopics = tracker.getColdTopics(3);

      const parts = [];

      if (hotTopics.length) {
        const hotList = hotTopics.map((t) => `"${t.topic}" (momentum: ${Math.round(t.score * 100)}%)`).join(', ');
        parts.push(`Topics de los que ha hablado recientemente y le importan: ${hotList}`);
      }

      if (coldTopics.length) {
        const coldList = coldTopics.map((t) => `"${t.topic}"`).join(', ');
        parts.push(`Topics que mencionó antes pero dejó de lado: ${coldList}`);
      }

      // Contexto del trigger actual
      if (trigger?.type === 'topic_hot' && trigger.topic) {
        parts.push(`El usuario acaba de mencionar "${trigger.topic}" que es un topic caliente — conéctalo con algo de memoria.`);
      }

      if (trigger?.type === 'topic_cold' && trigger.topic) {
        parts.push(`El usuario no ha hablado de "${trigger.topic}" en un tiempo. Si es natural, retómalo.`);
      }

      return parts.length ? `\nMOMENTUM DE TOPICS:\n- ${parts.join('\n- ')}` : '';
    } catch (e) {
      return '';
    }
  },

  /**
   * Detecta emociones con fallback regex (sin LLM).
   * @param {string} message
   * @returns {Promise<Object>}
   */
  async _detectEmotionsFallback(message) {
    if (!message) return { frustration: 0, enthusiasm: 0, confusion: 0, calm: 0.5, urgency: 0, playfulness: 0, tone: 'casual', energy: 'medium', implicitIntent: 'none' };

    const m = message.toLowerCase();
    const emotions = { frustration: 0, enthusiasm: 0, confusion: 0, calm: 0, urgency: 0, playfulness: 0 };

    if (/no (me )?funciona|error|fallo|rompi|bug|crash|explot|uff|puta|mierda/.test(m)) emotions.frustration = 0.7;
    if (/¡¡|wow|genial|increíble|waaah|cool|awesome|logré|funcionó|terminé/.test(m)) emotions.enthusiasm = 0.8;
    if (/no (se|entiendo|comprendo)|confus|duda|¿cómo|qué es|por qué/.test(m)) emotions.confusion = 0.6;
    if (/[!]{2,}|[A-Z]{4,}|urgente|ahora|ya/.test(message)) emotions.urgency = 0.7;
    if (/jaja|jeje| XD|broma|chiste|juego/.test(m)) emotions.playfulness = 0.8;

    const hasAny = Object.values(emotions).some((v) => v > 0);
    if (!hasAny) emotions.calm = 0.6;

    const energy = emotions.frustration > 0.5 || emotions.enthusiasm > 0.5 ? 'high'
      : emotions.calm > 0.5 ? 'low' : 'medium';

    return {
      ...emotions,
      tone: 'casual',
      energy,
      implicitIntent: emotions.frustration > 0.5 ? 'venting'
        : emotions.enthusiasm > 0.5 ? 'sharing_achievement'
        : emotions.confusion > 0.5 ? 'seeking_help'
        : 'none',
    };
  },

  /**
   * Registra feedback de una adaptación aplicada.
   * Llamado después de que el LLM produce un mensaje y se envía al usuario.
   * @param {string} adaptationType
   * @param {string} styleHint
   */
  _recordAdaptationFeedback(adaptationType, styleHint) {
    try {
      const graph = this._graph;
      if (!graph?._feedbackScorer) return;
      graph._feedbackScorer.recordAdaptation(adaptationType, styleHint);
    } catch (e) {
      logger.debug('adaptive-integration', `Error recording adaptation: ${e.message}`);
    }
  },

  /**
   * Registra un turno del usuario y calcula engagement.
   * @param {string} message
   */
  _recordUserTurn(message) {
    try {
      const graph = this._graph;
      if (!graph?._feedbackScorer) return;
      graph._feedbackScorer.recordUserTurn(message);
    } catch (e) {
      logger.debug('adaptive-integration', `Error recording user turn: ${e.message}`);
    }
  },

  /**
   * Procesa el feedback post-adaptación.
   * Llamado después de recibir respuesta del usuario tras una adaptación.
   */
  _processAdaptationFeedback() {
    try {
      const graph = this._graph;
      if (!graph?._feedbackScorer) return;

      const delta = graph._feedbackScorer.computeAdaptationDelta();
      if (delta && delta.sampleSize >= 2) {
        graph._feedbackScorer.updateScore(delta.adaptationType, delta.delta);
        logger.info('adaptive-integration',
          `Feedback: ${delta.adaptationType} delta=${delta.delta.toFixed(3)} ` +
          `(pre=${delta.pre.toFixed(2)} post=${delta.post.toFixed(2)})`
        );
      }
    } catch (e) {
      logger.debug('adaptive-integration', `Error processing feedback: ${e.message}`);
    }
  },

  /**
   * Decide si vale la pena adaptar el estilo basado en el historial de efectividad.
   * @param {string} adaptationType
   * @returns {boolean}
   */
  _shouldAdaptStyle(adaptationType) {
    try {
      const graph = this._graph;
      if (!graph?._feedbackScorer) return true; // default: adaptar

      const effectiveness = graph._feedbackScorer.getEffectiveness(adaptationType);
      // Si la adaptación tiene <40% de efectividad, no aplicarla
      return effectiveness >= 0.4;
    } catch {
      return true;
    }
  },
};
