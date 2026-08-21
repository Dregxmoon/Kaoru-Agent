// @ts-check
'use strict';

/**
 * AdaptiveResponseEngine.js — Applies communication style adaptations to responses.
 *
 * Combines insights from:
 *   - TraitLearner (emotional state)
 *   - CommunicationStyleProfiler (style preferences)
 *   - TopicMomentumTracker (topic context)
 *
 * Produces an adaptation profile that BehaviorModel and GroqSerializer use
 * to tailor responses to the user's current state and preferences.
 */

const logger = require('../../observability/Logger.js');

// ── Adaptation Profile ───────────────────────────────────────────────────────

/**
 * @typedef {object} AdaptationProfile
 * @property {'brief' | 'normal' | 'detailed'} responseLength
 * @property {'casual' | 'neutral' | 'formal'} formality
 * @property {'layman' | 'moderate' | 'expert'} technicalLevel
 * @property {string} emotionalContext - Dominant emotion if any
 * @property {number} emotionalIntensity - [0, 1]
 * @property {string[]} activeTopics - Hot topics to connect with
 * @property {string[]} decliningTopics - Cold topics for curiosity
 * @property {string} styleHint - Complete style hint for system prompt
 * @property {string} topicHint - Topic context hint for system prompt
 * @property {number} confidence - Adaptation confidence [0, 1]
 */

// ── Default Profile ──────────────────────────────────────────────────────────

const DEFAULT_PROFILE = {
  responseLength: 'normal',
  formality: 'neutral',
  technicalLevel: 'moderate',
  emotionalContext: null,
  emotionalIntensity: 0,
  activeTopics: [],
  decliningTopics: [],
  styleHint: '',
  topicHint: '',
  confidence: 0,
};

class AdaptiveResponseEngine {
  /**
   * @param {import('./TraitLearner.js').TraitLearner} traitLearner
   * @param {import('./CommunicationStyleProfiler.js').CommunicationStyleProfiler} styleProfiler
   * @param {import('./TopicMomentumTracker.js').TopicMomentumTracker} topicTracker
   * @param {import('./FeedbackScorer.js').FeedbackScorer} [feedbackScorer]
   */
  constructor(traitLearner, styleProfiler, topicTracker, feedbackScorer = null) {
    this._traitLearner = traitLearner;
    this._styleProfiler = styleProfiler;
    this._topicTracker = topicTracker;
    this._feedbackScorer = feedbackScorer;
  }

  /**
   * Build the complete adaptation profile for the current turn.
   * Called by BehaviorModel.evaluate() to get adaptation context.
   *
   * @returns {AdaptationProfile}
   */
  buildAdaptationProfile() {
    try {
      // 1. Get emotional state from TraitLearner
      const emotionalState = this._traitLearner.getEmotionalState();

      // 2. Get style preferences from CommunicationStyleProfiler
      const styleProfile = this._styleProfiler.getProfile();

      // 3. Get topic momentum from TopicMomentumTracker
      const hotTopics = this._topicTracker.getHotTopics({ limit: 5, minMomentum: 0.3 });
      const coldTopics = this._topicTracker.getColdTopics({ limit: 3, maxMomentum: 0.2 });

      // 4. Combine into adaptation profile
      const profile = {
        responseLength: styleProfile.preferredLength,
        formality: styleProfile.formalityLevel,
        technicalLevel: styleProfile.technicalLevel,
        emotionalContext: emotionalState.dominant,
        emotionalIntensity: emotionalState.intensity,
        activeTopics: hotTopics.map(t => t.topic),
        decliningTopics: coldTopics.map(t => t.topic),
        styleHint: this._styleProfiler.buildStyleHint(),
        topicHint: this._topicTracker.buildTopicHint(),
        confidence: styleProfile.adaptationConfidence,
      };

      // 5. Apply emotional adjustments
      return this._applyEmotionalAdjustments(profile, emotionalState);
    } catch (e) {
      logger.warn('AdaptiveResponseEngine', '[adaptive] error building profile:', e.message);
      return { ...DEFAULT_PROFILE };
    }
  }

  /**
   * Apply emotional state adjustments to the adaptation profile.
   * @param {AdaptationProfile} profile
   * @param {object} emotionalState
   * @returns {AdaptationProfile}
   * @private
   */
  _applyEmotionalAdjustments(profile, emotionalState) {
    const adjusted = { ...profile };

    // Frustration → more concise, more empathic
    if (emotionalState.recent.includes('frustration')) {
      if (adjusted.responseLength === 'detailed') {
        adjusted.responseLength = 'normal';
      }
      adjusted.styleHint += '\nEl usuario parece frustrado. Sé conciso y empático.';
    }

    // Confusion → more detailed explanations
    if (emotionalState.recent.includes('confusion')) {
      if (adjusted.responseLength === 'brief') {
        adjusted.responseLength = 'normal';
      }
      adjusted.styleHint += '\nEl usuario está confundido. Explica con más detalle y ejemplos.';
    }

    // Urgency → very brief, action-oriented
    if (emotionalState.recent.includes('urgency')) {
      adjusted.responseLength = 'brief';
      adjusted.styleHint += '\nEl usuario tiene prisa. Ve al grano sin preámbulos.';
    }

    // Enthusiasm → match energy, be positive
    if (emotionalState.recent.includes('enthusiasm')) {
      adjusted.styleHint += '\nEl usuario está entusiasmado. Mantén un tono positivo y energético.';
    }

    // Curiosity → provide more context
    if (emotionalState.recent.includes('curiosity')) {
      if (adjusted.responseLength === 'brief') {
        adjusted.responseLength = 'normal';
      }
      adjusted.styleHint += '\nEl usuario está curioso. Proporciona contexto adicional.';
    }

    return adjusted;
  }

  /**
   * Check if a specific adaptation type should be applied based on feedback history.
   * If an adaptation has been ineffective (<40% success rate), it won't be applied.
   * @param {string} adaptationType  'responseLength' | 'formality' | 'technicalLevel' | 'emotionalContext'
   * @returns {boolean} true if adaptation should be applied
   */
  shouldAdapt(adaptationType) {
    if (!this._feedbackScorer) return true; // default: adapt
    return this._feedbackScorer.getEffectiveness(adaptationType) >= 0.4;
  }

  /**
   * Record that an adaptation was applied (for feedback tracking).
   * @param {string} adaptationType
   * @param {string} hint
   */
  recordAdaptation(adaptationType, hint) {
    if (this._feedbackScorer) {
      this._feedbackScorer.recordAdaptation(adaptationType, hint);
    }
  }

  /**
   * Serialize the adaptation profile for the system prompt.
   * Used by GroqSerializer to inject adaptation hints.
   * @param {AdaptationProfile} profile
   * @returns {string}
   */
  static serialize(profile) {
    if (!profile || profile.confidence < 0.1) return '';

    const lines = ['# ADAPTACIÓN AL USUARIO'];

    // Response length
    const lengthDesc = {
      brief: 'Respuesta breve (2-3 oraciones máximo)',
      normal: 'Longitud normal',
      detailed: 'Respuesta detallada (explica con ejemplos)',
    };
    lines.push(`Extensión: ${lengthDesc[profile.responseLength] || 'Normal'}`);

    // Formality
    const formalityDesc = {
      casual: 'Tono casual y relajado',
      neutral: 'Tono neutral',
      formal: 'Tono formal y profesional',
    };
    lines.push(`Tono: ${formalityDesc[profile.formality] || 'Neutral'}`);

    // Technical level
    const techDesc = {
      layman: 'Nivel técnico bajo — explica conceptos simples',
      moderate: 'Nivel técnico medio',
      expert: 'Nivel técnico alto — usa terminología especializada',
    };
    lines.push(`Nivel técnico: ${techDesc[profile.technicalLevel] || 'Medio'}`);

    // Emotional context
    if (profile.emotionalContext && profile.emotionalIntensity > 0.3) {
      const emotionDesc = {
        frustration: 'El usuario está frustrado — sé empático y directo',
        confusion: 'El usuario está confudido — aclara con ejemplos',
        urgency: 'El usuario tiene prisa — ve al grano',
        enthusiasm: 'El usuario está entusiasmado — mantén energía positiva',
        curiosity: 'El usuario está curioso — profundiza en la explicación',
        relief: 'El usuario aliviado — reconoce el logro',
        satisfaction: 'El usuario satisfecho — celebra el éxito',
        gratitude: 'El usuario agradecido — acepta y sigue',
      };
      const desc = emotionDesc[profile.emotionalContext];
      if (desc) lines.push(`Estado emocional: ${desc}`);
    }

    // Active topics
    if (profile.activeTopics.length > 0) {
      lines.push(`Temas activos: ${profile.activeTopics.join(', ')}`);
    }

    return lines.join('\n');
  }

  /**
   * Get adaptation statistics.
   * @returns {{ confidence: number, activeTopics: number, emotionalState: string | null }}
   */
  getStats() {
    const profile = this.buildAdaptationProfile();
    return {
      confidence: profile.confidence,
      activeTopics: profile.activeTopics.length,
      emotionalState: profile.emotionalContext,
    };
  }
}

module.exports = { AdaptiveResponseEngine, DEFAULT_PROFILE };
