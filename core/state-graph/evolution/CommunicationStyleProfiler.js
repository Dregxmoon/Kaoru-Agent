// @ts-check
'use strict';

/**
 * CommunicationStyleProfiler.js — EMA-based communication style adaptation.
 *
 * Builds a profile of the user's communication preferences over time:
 *   - Response length preference (brief vs detailed)
   - Formality level (casual vs formal)
 *   - Technical depth (layman vs expert)
 *   - Emoji/emoticon usage patterns
 *   - Question frequency
 *
 * Uses EMA (Exponential Moving Average) for smooth adaptation without
 * storing raw history. The profile adapts gradually to style changes.
 */

const logger = require('../../observability/Logger.js');

// ── Profile Keys ─────────────────────────────────────────────────────────────

const PROFILE_KEYS = {
  LENGTH: 'style_length',
  FORMALITY: 'style_formality',
  TECHNICAL: 'style_technicalDensity',
  EMOJI: 'style_emojiUsage',
  QUESTIONS: 'style_questionDensity',
};

// ── Style Thresholds ─────────────────────────────────────────────────────────

const STYLE_THRESHOLDS = {
  length: {
    brief: 0.3,
    normal: 0.6,
    detailed: 0.8,
  },
  formality: {
    casual: 0.3,
    neutral: 0.5,
    formal: 0.7,
  },
  technical: {
    layman: 0.3,
    moderate: 0.5,
    expert: 0.7,
  },
};

class CommunicationStyleProfiler {
  /**
   * @param {import('./EvolutionStore.js').EvolutionStore} evolutionStore
   */
  constructor(evolutionStore) {
    this._store = evolutionStore;
  }

  /**
   * Get the current communication style profile.
   * @returns {{
   *   preferredLength: 'brief' | 'normal' | 'detailed',
   *   formalityLevel: 'casual' | 'neutral' | 'formal',
   *   technicalLevel: 'layman' | 'moderate' | 'expert',
   *   emojiPreference: number,
   *   questionTendency: number,
   *   adaptationConfidence: number
   * }}
   */
  getProfile() {
    const profiles = this._store.getAllProfiles();

    const length = profiles.get(PROFILE_KEYS.LENGTH)?.ema_value ?? 0.5;
    const formality = profiles.get(PROFILE_KEYS.FORMALITY)?.ema_value ?? 0.5;
    const technical = profiles.get(PROFILE_KEYS.TECHNICAL)?.ema_value ?? 0.5;
    const emoji = profiles.get(PROFILE_KEYS.EMOJI)?.ema_value ?? 0.1;
    const questions = profiles.get(PROFILE_KEYS.QUESTIONS)?.ema_value ?? 0.3;

    // Calculate adaptation confidence based on sample count
    const totalSamples = Array.from(profiles.values())
      .reduce((sum, p) => sum + p.sample_count, 0);
    const adaptationConfidence = Math.min(1.0, totalSamples / 20); // Full confidence after 20 observations

    return {
      preferredLength: this._classifyLength(length),
      formalityLevel: this._classifyFormality(formality),
      technicalLevel: this._classifyTechnical(technical),
      emojiPreference: emoji,
      questionTendency: questions,
      adaptationConfidence,
    };
  }

  /**
   * Classify raw length score into category.
   * @param {number} score
   * @returns {'brief' | 'normal' | 'detailed'}
   * @private
   */
  _classifyLength(score) {
    if (score < STYLE_THRESHOLDS.length.brief) return 'brief';
    if (score < STYLE_THRESHOLDS.length.detailed) return 'normal';
    return 'detailed';
  }

  /**
   * Classify raw formality score into category.
   * @param {number} score
   * @returns {'casual' | 'neutral' | 'formal'}
   * @private
   */
  _classifyFormality(score) {
    if (score < STYLE_THRESHOLDS.formality.casual) return 'casual';
    if (score < STYLE_THRESHOLDS.formality.formal) return 'neutral';
    return 'formal';
  }

  /**
   * Classify raw technical score into category.
   * @param {number} score
   * @returns {'layman' | 'moderate' | 'expert'}
   * @private
   */
  _classifyTechnical(score) {
    if (score < STYLE_THRESHOLDS.technical.layman) return 'layman';
    if (score < STYLE_THRESHOLDS.technical.expert) return 'moderate';
    return 'expert';
  }

  /**
   * Generate a system prompt hint based on the user's style preferences.
   * Used by GroqSerializer to adapt the assistant's communication style.
   * @returns {string}
   */
  buildStyleHint() {
    const profile = this.getProfile();

    // Don't generate hints until we have enough data
    if (profile.adaptationConfidence < 0.2) return '';

    const hints = [];

    // Length adaptation
    switch (profile.preferredLength) {
      case 'brief':
        hints.push('El usuario prefiere respuestas CORTAS y directas. Máximo 2-3 oraciones.');
        break;
      case 'detailed':
        hints.push('El usuario prefiere respuestas DETALLADAS con explicaciones completas.');
        break;
      default:
        // normal — no hint needed
        break;
    }

    // Formality adaptation
    switch (profile.formalityLevel) {
      case 'casual':
        hints.push('El usuario usa un tono CASUAL. Puedes ser relajado y usar lenguaje coloquial.');
        break;
      case 'formal':
        hints.push('El usuario usa un tono FORMAL. Mantén un lenguaje profesional y respetuoso.');
        break;
      default:
        // neutral — no hint needed
        break;
    }

    // Technical adaptation
    switch (profile.technicalLevel) {
      case 'expert':
        hints.push('El usuario tiene nivel TÉCNICO alto. Usa terminología técnica sin explicar conceptos básicos.');
        break;
      case 'layman':
        hints.push('El usuario es NO TÉCNICO. Explica conceptos técnicos en términos simples.');
        break;
      default:
        // moderate — no hint needed
        break;
    }

    // Emoji preference (only if significant)
    if (profile.emojiPreference > 0.3) {
      hints.push('El usuario usa emojis con frecuencia. Puedes incluir algunos en tus respuestas.');
    }

    // Question tendency
    if (profile.questionTendency > 0.5) {
      hints.push('El usuario hace muchas preguntas. Sé proactivo al explicar contexto adicional.');
    }

    return hints.length > 0 ? hints.join('\n') : '';
  }

  /**
   * Get style adaptation statistics.
   * @returns {{ totalSamples: number, confidence: number, keyMetrics: string[] }}
   */
  getStats() {
    const profiles = this._store.getAllProfiles();
    const totalSamples = Array.from(profiles.values())
      .reduce((sum, p) => sum + p.sample_count, 0);
    const confidence = Math.min(1.0, totalSamples / 20);
    const keyMetrics = Array.from(profiles.keys()).filter(k => k.startsWith('style_'));

    return { totalSamples, confidence, keyMetrics };
  }
}

module.exports = { CommunicationStyleProfiler, PROFILE_KEYS, STYLE_THRESHOLDS };
