// @ts-check
'use strict';

/**
 * TraitLearner.js — Deterministic behavioral/emotional trait inference.
 *
 * Runs per-turn (unlike UserModelBuilder which is LLM+batch on episodes).
 * Uses regex patterns and statistical counters to extract:
 *   - Emotional patterns (frustration, enthusiasm, confusion, etc.)
 *   - Communication style traits (verbosity, formality, emoji usage, etc.)
 *   - Behavioral signals (urgency, focus, engagement level)
 *
 * All traits are stored as EvolutionStore profiles (EMA-smoothed).
 * No LLM calls — deterministic and fast.
 */

const logger = require('../../observability/Logger.js');

// ── Emotional Pattern Rules ──────────────────────────────────────────────────

const EMOTION_RULES = [
  // Frustration signals
  {
    pattern: /no\s+(me\s+)?funciona|error|fallo|rompi|bug|crash|exploto|por\s+qu[eé]/i,
    trait: 'frustration',
    weight: 0.7,
  },
  {
    pattern: /maldita|esto\s+no\s+anda|ya\s+casi|por\s+fin|gracias\s+a\s+ Dios/i,
    trait: 'relief',
    weight: 0.5,
  },
  // Enthusiasm
  {
    pattern: /genial|excelente|incre[ií]ble|perfecto|bien\s+hecho|cool|nice|awesome/i,
    trait: 'enthusiasm',
    weight: 0.6,
  },
  {
    pattern: /me\s+encanta|lo\s+quiero|esto\s+es\s+perfecto/i,
    trait: 'satisfaction',
    weight: 0.7,
  },
  // Confusion
  {
    pattern: /no\s+entiendo|confundido|no\s+comprendo|qu[eé]\s+quiere\s+decir/i,
    trait: 'confusion',
    weight: 0.6,
  },
  {
    pattern: /cu[aá]ndo?\s+entonces|pero\s+c[oó]mo|no\s+me\s+quedo\s+claro/i,
    trait: 'confusion',
    weight: 0.5,
  },
  // Urgency
  {
    pattern: /urgente|r[aá]pido|ahora\s+mismo|inmediatamente|ya\s+mismo|ASAP/i,
    trait: 'urgency',
    weight: 0.8,
  },
  // Engagement
  {
    pattern: /cu[eé]ntame\s+m[aá]s|expl[ií]came|detalles|c[oó]mo\s+funciona|por\s+qu[eé]/i,
    trait: 'curiosity',
    weight: 0.6,
  },
  // Positive feedback
  {
    pattern: /gracias|te\s+agradezco|thanks|perfecto|bien/i,
    trait: 'gratitude',
    weight: 0.4,
  },
];

// ── Communication Style Metrics ──────────────────────────────────────────────

const STYLE_METRICS = {
  // Message length category
  _measureLength(text) {
    const len = text.length;
    if (len < 30) return 0.2; // brief
    if (len < 100) return 0.4; // short
    if (len < 300) return 0.6; // normal
    if (len < 600) return 0.8; // detailed
    return 1.0; // very detailed
  },

  // Question density (questions per sentence)
  _measureQuestionDensity(text) {
    const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
    const questions = (text.match(/[?¿]/g) || []).length;
    if (sentences.length === 0) return 0;
    return Math.min(1.0, questions / sentences.length);
  },

  // Emoji/emoticon usage
  _measureEmojiUsage(text) {
    const emojiPattern = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu;
    const emoticonPattern = /[:;]-?[)D(P/\\|]/g;
    const emojis = (text.match(emojiPattern) || []).length;
    const emoticons = (text.match(emoticonPattern) || []).length;
    const total = emojis + emoticons;
    const perChar = text.length > 0 ? total / text.length : 0;
    return Math.min(1.0, perChar * 100); // Normalize to [0,1]
  },

  // Formality indicators
  _measureFormality(text) {
    const informalMarkers = /\b(oye|hey|hola|buenas|qué\s+tal|c[oó]mo\s+est[aá]s|gracias|por\s+fa|xD|lol|jaja|jeje)\b/i;
    const formalMarkers = /\b(por\s+favor|agradecer[ií]a|ser[ií]a\s+amable|le\s+agradezco|estimado|disculpe)\b/i;

    const informalCount = (text.match(informalMarkers) || []).length;
    const formalCount = (text.match(formalMarkers) || []).length;

    if (informalCount + formalCount === 0) return 0.5; // neutral
    return formalCount / (informalCount + formalCount);
  },

  // Technical vocabulary density
  _measureTechnicalDensity(text) {
    const techPatterns = /\b(c[oó]digo|funci[oó]n|clase|m[eé]todo|variable|import|export|async|await|const|let|var|git|npm|node|python|api|endpoint|query|database|server|client|deploy|build|test|debug)\b/gi;
    const matches = (text.match(techPatterns) || []).length;
    const words = text.split(/\s+/).length;
    if (words === 0) return 0;
    return Math.min(1.0, matches / words * 5); // Scale up for visibility
  },
};

// ── TraitLearner Class ───────────────────────────────────────────────────────

class TraitLearner {
  /**
   * @param {import('./EvolutionStore.js').EvolutionStore} evolutionStore
   */
  constructor(evolutionStore) {
    this._store = evolutionStore;
  }

  /**
   * Analyze a user turn and update evolution profiles.
   * Called per-turn by SessionManager.addTurn().
   *
   * @param {string} userMessage - The user's message text
   * @returns {{ emotions: string[], styleMetrics: object }}
   */
  analyzeTurn(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') {
      return { emotions: [], styleMetrics: {} };
    }

    const text = userMessage.trim();
    if (!text) return { emotions: [], styleMetrics: {} };

    // 1. Detect emotional signals
    const emotions = this._detectEmotions(text);

    // 2. Measure communication style
    const styleMetrics = this._measureStyle(text);

    // 3. Update EvolutionStore profiles
    this._updateProfiles(emotions, styleMetrics);

    return { emotions, styleMetrics };
  }

  /**
   * Detect emotional signals from text using regex patterns.
   * @param {string} text
   * @returns {string[]}
   * @private
   */
  _detectEmotions(text) {
    const detected = [];
    for (const rule of EMOTION_RULES) {
      if (rule.pattern.test(text)) {
        detected.push(rule.trait);
      }
    }
    return [...new Set(detected)]; // Deduplicate
  }

  /**
   * Measure communication style metrics.
   * @param {string} text
   * @returns {object}
   * @private
   */
  _measureStyle(text) {
    return {
      length: STYLE_METRICS._measureLength(text),
      questionDensity: STYLE_METRICS._measureQuestionDensity(text),
      emojiUsage: STYLE_METRICS._measureEmojiUsage(text),
      formality: STYLE_METRICS._measureFormality(text),
      technicalDensity: STYLE_METRICS._measureTechnicalDensity(text),
    };
  }

  /**
   * Update EvolutionStore profiles with new observations.
   * @param {string[]} emotions
   * @param {object} styleMetrics
   * @private
   */
  _updateProfiles(emotions, styleMetrics) {
    // Update emotion profiles (binary: present or not)
    const emotionTraits = ['frustration', 'relief', 'enthusiasm', 'satisfaction',
      'confusion', 'urgency', 'curiosity', 'gratitude'];

    for (const trait of emotionTraits) {
      const value = emotions.includes(trait) ? 1.0 : 0.0;
      this._store.updateProfile(`emotion_${trait}`, value);
    }

    // Update style profiles (continuous values)
    for (const [metric, value] of Object.entries(styleMetrics)) {
      this._store.updateProfile(`style_${metric}`, value);
    }
  }

  /**
   * Get the current emotional state summary.
   * @returns {object} { dominant: string|null, intensity: number, recent: string[] }
   */
  getEmotionalState() {
    const profiles = this._store.getAllProfiles();
    const emotions = {};

    for (const [key, value] of profiles) {
      if (key.startsWith('emotion_')) {
        const trait = key.replace('emotion_', '');
        emotions[trait] = value.ema_value;
      }
    }

    // Find dominant emotion
    let dominant = null;
    let maxIntensity = 0;
    for (const [trait, intensity] of Object.entries(emotions)) {
      if (intensity > maxIntensity && intensity > 0.3) {
        dominant = trait;
        maxIntensity = intensity;
      }
    }

    // Get recent emotions (above threshold)
    const recent = Object.entries(emotions)
      .filter(([, v]) => v > 0.2)
      .sort(([, a], [, b]) => b - a)
      .map(([trait]) => trait);

    return { dominant, intensity: maxIntensity, recent };
  }

  /**
   * Get communication style preferences.
   * @returns {object} { preferredLength, formalityLevel, emojiStyle, technicalLevel }
   */
  getStylePreferences() {
    const profiles = this._store.getAllProfiles();

    return {
      preferredLength: profiles.get('style_length')?.ema_value ?? 0.5,
      questionDensity: profiles.get('style_questionDensity')?.ema_value ?? 0.3,
      emojiStyle: profiles.get('style_emojiUsage')?.ema_value ?? 0.1,
      formalityLevel: profiles.get('style_formality')?.ema_value ?? 0.5,
      technicalLevel: profiles.get('style_technicalDensity')?.ema_value ?? 0.3,
    };
  }
}

module.exports = { TraitLearner, EMOTION_RULES, STYLE_METRICS };
