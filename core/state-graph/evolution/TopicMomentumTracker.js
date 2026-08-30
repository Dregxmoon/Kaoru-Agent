// @ts-check
'use strict';

/**
 * TopicMomentumTracker.js — Hot/cold topic detection via momentum scoring.
 *
 * Tracks topic frequency over a sliding window (7 days) and computes a
 * momentum score that rises with frequent mentions and decays with time.
 *
 * Use cases:
 *   - Hot topics: recent passionate discussion → proactive engagement
 *   - Cold topics: previously active, now declining → curiosity triggers
 *   - Context boost: current OS context matches hot topic → higher priority
 */

const logger = require('../../observability/Logger.js');

// ── Topic Extraction ─────────────────────────────────────────────────────────

// Common Spanish/English stopwords to filter out
const STOPWORDS = new Set([
  // Spanish
  'el',
  'la',
  'los',
  'las',
  'un',
  'una',
  'unos',
  'unas',
  'de',
  'del',
  'al',
  'en',
  'con',
  'por',
  'para',
  'sin',
  'sobre',
  'entre',
  'que',
  'qué',
  'como',
  'cómo',
  'cuando',
  'cuándo',
  'donde',
  'dónde',
  'quien',
  'quién',
  'este',
  'esta',
  'estos',
  'estas',
  'ese',
  'esa',
  'esos',
  'esas',
  'aquel',
  'aquella',
  'yo',
  'tu',
  'él',
  'ella',
  'nosotros',
  'ustedes',
  'ellos',
  'ellas',
  'me',
  'te',
  'se',
  'nos',
  'les',
  'mi',
  'tu',
  'su',
  'mis',
  'tus',
  'sus',
  'este',
  'ser',
  'estar',
  'haber',
  'tener',
  'hacer',
  'poder',
  'querer',
  'saber',
  'decir',
  'dar',
  'ver',
  'venir',
  'poner',
  'salir',
  'seguir',
  'partir',
  'bien',
  'mal',
  'muy',
  'mucho',
  'poco',
  'algo',
  'nada',
  'todo',
  'cada',
  'otro',
  'otra',
  'otros',
  'otras',
  'mismo',
  'misma',
  'mismos',
  'mismas',
  // English
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'with',
  'by',
  'from',
  'as',
  'is',
  'was',
  'are',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'shall',
  'can',
  'this',
  'that',
  'these',
  'those',
  'i',
  'you',
  'he',
  'she',
  'it',
  'we',
  'they',
  'me',
  'him',
  'her',
  'us',
  'them',
  'my',
  'your',
  'his',
  'its',
  'our',
  'their',
  'what',
  'which',
  'who',
  'whom',
  'where',
  'when',
  'why',
  'how',
  'not',
  'no',
  'nor',
  'so',
  'if',
  'then',
  'than',
  'too',
  'very',
  // Technical/common fillers
  'thing',
  'things',
  'stuff',
  'way',
  'ways',
  'just',
  'like',
  'really',
  'actually',
  'basically',
  'literally',
  'probably',
  'definitely',
]);

// ── Topic Extraction Heuristics ──────────────────────────────────────────────

/**
 * Extract significant topic keywords from a user message.
 * Uses simple heuristics: nouns (capitalized or after articles), technical terms,
 * and repeated words.
 *
 * @param {string} text
 * @returns {string[]} Normalized topic keywords
 */
function extractTopics(text) {
  if (!text || typeof text !== 'string') return [];

  const normalized = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remove accents
    .replace(/[^a-z0-9\s]/g, ' ') // Keep only alphanumeric
    .replace(/\s+/g, ' ')
    .trim();

  const words = normalized.split(' ').filter((w) => w.length >= 3);

  // Filter stopwords and short words
  const meaningful = words.filter((w) => !STOPWORDS.has(w) && w.length >= 4);

  // Count word frequency to find emphasized terms
  const freq = new Map();
  for (const word of meaningful) {
    freq.set(word, (freq.get(word) || 0) + 1);
  }

  // Extract topics: words that appear at least once and are meaningful
  const topics = [];
  for (const [word, count] of freq) {
    // Boost words that appear multiple times (emphasis)
    if (count >= 1) {
      topics.push(word);
    }
  }

  // Also extract bigrams (two-word phrases) for compound topics
  for (let i = 0; i < words.length - 1; i++) {
    const w1 = words[i];
    const w2 = words[i + 1];
    if (w1.length >= 3 && w2.length >= 3 && !STOPWORDS.has(w1) && !STOPWORDS.has(w2)) {
      topics.push(`${w1}_${w2}`);
    }
  }

  // Deduplicate and limit
  return [...new Set(topics)].slice(0, 10);
}

// ── TopicMomentumTracker Class ───────────────────────────────────────────────

class TopicMomentumTracker {
  /**
   * @param {import('./EvolutionStore.js').EvolutionStore} evolutionStore
   */
  constructor(evolutionStore) {
    this._store = evolutionStore;
  }

  /**
   * Analyze a user message and track topic momentum.
   * Called per-turn by SessionManager.addTurn().
   *
   * @param {string} userMessage
   * @returns {{ topics: string[], hotTopics: Array<{topic: string, momentum: number}>, coldTopics: Array<{topic: string, momentum: number}> }}
   */
  analyzeTurn(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') {
      return { topics: [], hotTopics: [], coldTopics: [] };
    }

    // 1. Extract topics from message
    const topics = extractTopics(userMessage);

    // 2. Record each topic in EvolutionStore
    for (const topic of topics) {
      this._store.recordTopicMention(topic);
    }

    // 3. Get current hot/cold topics for context
    const hotTopics = this._store.getHotTopics({ limit: 3, minMomentum: 0.3 });
    const coldTopics = this._store.getColdTopics({ limit: 3, maxMomentum: 0.2 });

    return {
      topics,
      hotTopics: hotTopics.map((t) => ({ topic: t.topic_key, momentum: t.momentum_score })),
      coldTopics: coldTopics.map((t) => ({ topic: t.topic_key, momentum: t.momentum_score })),
    };
  }

  /**
   * Get topic momentum for a specific topic.
   * @param {string} topic
   * @returns {{ momentum: number, mentions: number } | null}
   */
  getTopicMomentum(topic) {
    const data = this._store.getTopicMomentum(topic);
    if (!data) return null;
    return { momentum: data.momentum_score, mentions: data.mention_count };
  }

  /**
   * Get all hot topics for proactive triggers.
   * @param {{ limit?: number, minMomentum?: number }} [opts]
   * @returns {Array<{ topic: string, momentum: number, mentions: number }>}
   */
  getHotTopics(opts = {}) {
    return this._store.getHotTopics(opts).map((t) => ({
      topic: t.topic_key,
      momentum: t.momentum_score,
      mentions: t.mention_count,
    }));
  }

  /**
   * Get all cold topics for curiosity triggers.
   * @param {{ limit?: number, maxMomentum?: number }} [opts]
   * @returns {Array<{ topic: string, momentum: number, mentions: number }>}
   */
  getColdTopics(opts = {}) {
    return this._store.getColdTopics(opts).map((t) => ({
      topic: t.topic_key,
      momentum: t.momentum_score,
      mentions: t.mention_count,
    }));
  }

  /**
   * Generate a system prompt hint based on current topic momentum.
   * Used by GroqSerializer to inject topic context.
   * @returns {string}
   */
  buildTopicHint() {
    const hotTopics = this.getHotTopics({ limit: 3, minMomentum: 0.4 });

    if (hotTopics.length === 0) return '';

    const topicList = hotTopics
      .map((t) => `"${t.topic.replace(/_/g, ' ')}" (mencionado ${t.mentions} veces recientemente)`)
      .join(', ');

    return `Temas de interés ACTIVO del usuario: ${topicList}. Conecta con estos temas cuando sea relevante.`;
  }

  /**
   * Get topic statistics for diagnostics.
   * @returns {{ totalTopics: number, hotCount: number, coldCount: number, avgMomentum: number }}
   */
  getStats() {
    const stats = this._store.getStats();
    return {
      totalTopics: stats.topics,
      hotCount: stats.hotTopics,
      coldCount: stats.coldTopics,
      avgMomentum: 0, // Would need a query to compute
    };
  }
}

module.exports = { TopicMomentumTracker, extractTopics, STOPWORDS };
