// @ts-check
'use strict';

/**
 * EvolutionStore.js — Persistent storage for the evolutionary memory system.
 *
 * Manages two new tables:
 *   - communication_profiles: EMA-based communication style metrics per user
 *   - topic_momentum: Topic frequency tracking with momentum (hot/cold detection)
 *
 * Design principles:
 *   - Deterministic: no LLM calls, pure regex/stats
 *   - Graceful degradation: works without LLM (TraitLearner is optional)
 *   - Low overhead: EMA updates are O(1), topic tracking is bounded
 */

const logger = require('../../observability/Logger.js');

// ── Schema constants ────────────────────────────────────────────────────────

const COMMUNICATION_PROFILES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS communication_profiles (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    metric_key      TEXT    NOT NULL UNIQUE,
    ema_value       REAL    NOT NULL DEFAULT 0.5,
    sample_count    INTEGER NOT NULL DEFAULT 0,
    last_updated_at INTEGER NOT NULL,
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
  );
  CREATE INDEX IF NOT EXISTS idx_comm_profiles_key ON communication_profiles(metric_key);
`;

const TOPIC_MOMENTUM_SCHEMA = `
  CREATE TABLE IF NOT EXISTS topic_momentum (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_key       TEXT    NOT NULL,
    mention_count   INTEGER NOT NULL DEFAULT 1,
    window_start    INTEGER NOT NULL,
    last_mention_at INTEGER NOT NULL,
    momentum_score  REAL    NOT NULL DEFAULT 0.0,
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
  );
  CREATE INDEX IF NOT EXISTS idx_topic_momentum_key ON topic_momentum(topic_key);
  CREATE INDEX IF NOT EXISTS idx_topic_momentum_score ON topic_momentum(momentum_score DESC);
`;

// ── EMA configuration ───────────────────────────────────────────────────────

const EMA_ALPHA = 0.15; // Communication profile smoothing factor
const TOPIC_EMA_ALPHA = 0.2; // Topic momentum smoothing factor
const TOPIC_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7-day sliding window
const MAX_TRACKED_TOPICS = 50; // Bounded topic history

/**
 * Subconjunto de la API de better-sqlite3 que usa esta clase.
 * (typedef local: el paquete no publica declaraciones y un
 * import('better-sqlite3') genera TS7016 bajo checkJs estricto.)
 * @typedef {{
 *   prepare(sql: string): {
 *     get(...args: any[]): any;
 *     all(...args: any[]): any[];
 *     run(...args: any[]): unknown;
 *   };
 *   exec(sql: string): void;
 * }} MinimalDatabase
 */

/** Fila de communication_profiles tal como viene de SQLite.
 * @typedef {{
 *   metric_key: string,
 *   ema_value: number,
 *   sample_count: number,
 *   last_updated_at?: number,
 *   created_at?: number
 * }} ProfileRow
 */

/** Registro resumido de un perfil de comunicación.
 * @typedef {{
 *   ema_value: number,
 *   sample_count: number
 * }} ProfileRecord
 */

/** Fila de topic_momentum con score/menciones dentro de la ventana.
 * @typedef {{
 *   topic_key?: string,
 *   id?: number,
 *   momentum_score: number,
 *   mention_count: number
 * }} TopicRecord
 */

/** Resumen de diagnóstico de la evolución.
 * @typedef {{
 *   profiles: number,
 *   topics: number,
 *   hotTopics: number,
 *   coldTopics: number
 * }} EvolutionStats
 */

class EvolutionStore {
  /**
   * @param {MinimalDatabase} db
   */
  constructor(db) {
    /** @type {MinimalDatabase} */
    this._db = db;
  }

  /**
   * Initialize schema (idempotent). Called during StateGraph._createSchema().
   * @returns {void}
   */
  createSchema() {
    try {
      this._db.exec(COMMUNICATION_PROFILES_SCHEMA);
      this._db.exec(TOPIC_MOMENTUM_SCHEMA);
    } catch (e) {
      logger.warn('EvolutionStore', '[evolution] schema creation failed:', (/** @type {Error} */ (e)).message);
    }
  }

  // ── Communication Profile CRUD ──────────────────────────────────────────

  /**
   * Get a communication profile metric by key.
   * @param {string} metricKey
   * @returns {ProfileRecord & { last_updated_at: number } | null}
   */
  getProfile(metricKey) {
    try {
      return this._db
        .prepare('SELECT ema_value, sample_count, last_updated_at FROM communication_profiles WHERE metric_key=?')
        .get(metricKey) || null;
    } catch (e) {
      logger.warn('EvolutionStore', '[evolution] getProfile error:', (/** @type {Error} */ (e)).message);
      return null;
    }
  }

  /**
   * Update a communication profile with a new observation (EMA update).
   * @param {string} metricKey
   * @param {number} newValue - The new observation value [0, 1]
   * @param {number} [alpha] - EMA smoothing factor (default: EMA_ALPHA)
   */
  updateProfile(metricKey, newValue, alpha = EMA_ALPHA) {
    try {
      const existing = this.getProfile(metricKey);
      const now = Date.now();

      if (existing) {
        const newEma = alpha * newValue + (1 - alpha) * existing.ema_value;
        this._db
          .prepare('UPDATE communication_profiles SET ema_value=?, sample_count=sample_count+1, last_updated_at=? WHERE metric_key=?')
          .run(newEma, now, metricKey);
      } else {
        this._db
          .prepare('INSERT INTO communication_profiles (metric_key, ema_value, sample_count, last_updated_at, created_at) VALUES (?, ?, 1, ?, ?)')
          .run(metricKey, newValue, now, now);
      }
    } catch (e) {
      logger.warn('EvolutionStore', '[evolution] updateProfile error:', (/** @type {Error} */ (e)).message);
    }
  }

  /**
   * Get all communication profiles as a map.
   * @returns {Map<string, ProfileRecord>}
   */
  getAllProfiles() {
    const profiles = new Map();
    try {
      const rows = this._db
        .prepare('SELECT metric_key, ema_value, sample_count FROM communication_profiles')
        .all();
      for (const row of rows) {
        profiles.set(row.metric_key, {
          ema_value: row.ema_value,
          sample_count: row.sample_count,
        });
      }
    } catch (e) {
      logger.warn('EvolutionStore', '[evolution] getAllProfiles error:', (/** @type {Error} */ (e)).message);
    }
    return profiles;
  }

  // ── Topic Momentum CRUD ────────────────────────────────────────────────

  /**
   * Record a topic mention and update momentum score.
   * @param {string} topicKey - Normalized topic keyword
   */
  recordTopicMention(topicKey) {
    try {
      const now = Date.now();
      const windowStart = now - TOPIC_WINDOW_MS;

      // Clean old entries outside the window
      this._db
        .prepare('DELETE FROM topic_momentum WHERE last_mention_at < ?')
        .run(windowStart);

      // Check if topic exists in current window
      const existing = this._db
        .prepare('SELECT id, mention_count, momentum_score FROM topic_momentum WHERE topic_key=? AND last_mention_at >= ?')
        .get(topicKey, windowStart);

      if (existing) {
        // Update existing: increment count, update momentum with EMA
        const newCount = existing.mention_count + 1;
        const timeFactor = Math.min(1.0, newCount / 10); // Normalize by expected frequency
        const newMomentum = TOPIC_EMA_ALPHA * timeFactor + (1 - TOPIC_EMA_ALPHA) * existing.momentum_score;

        this._db
          .prepare('UPDATE topic_momentum SET mention_count=?, last_mention_at=?, momentum_score=? WHERE id=?')
          .run(newCount, now, newMomentum, existing.id);
      } else {
        // New topic in window
        this._db
          .prepare('INSERT INTO topic_momentum (topic_key, mention_count, window_start, last_mention_at, momentum_score, created_at) VALUES (?, 1, ?, ?, 0.1, ?)')
          .run(topicKey, windowStart, now, now);
      }

      // Enforce bounded history
      this._pruneOldTopics();
    } catch (e) {
      logger.warn('EvolutionStore', '[evolution] recordTopicMention error:', (/** @type {Error} */ (e)).message);
    }
  }

  /**
   * Get hot topics (high momentum) for proactive triggers.
   * @param {{ limit?: number, minMomentum?: number }} [opts]
   * @returns {TopicRecord[]}
   */
  getHotTopics({ limit = 5, minMomentum = 0.3 } = {}) {
    try {
      return this._db
        .prepare(
          'SELECT topic_key, momentum_score, mention_count FROM topic_momentum WHERE momentum_score >= ? ORDER BY momentum_score DESC LIMIT ?'
        )
        .all(minMomentum, limit);
    } catch (e) {
      logger.warn('EvolutionStore', '[evolution] getHotTopics error:', (/** @type {Error} */ (e)).message);
      return [];
    }
  }

  /**
   * Get cold topics (low momentum, declining interest).
   * @param {{ limit?: number, maxMomentum?: number }} [opts]
   * @returns {TopicRecord[]}
   */
  getColdTopics({ limit = 5, maxMomentum = 0.2 } = {}) {
    try {
      return this._db
        .prepare(
          'SELECT topic_key, momentum_score, mention_count FROM topic_momentum WHERE momentum_score <= ? AND mention_count >= 2 ORDER BY momentum_score ASC LIMIT ?'
        )
        .all(maxMomentum, limit);
    } catch (e) {
      logger.warn('EvolutionStore', '[evolution] getColdTopics error:', (/** @type {Error} */ (e)).message);
      return [];
    }
  }

  /**
   * Get topic momentum for a specific topic.
   * @param {string} topicKey
   * @returns {TopicRecord | null}
   */
  getTopicMomentum(topicKey) {
    try {
      const now = Date.now();
      const windowStart = now - TOPIC_WINDOW_MS;
      return this._db
        .prepare(
          'SELECT momentum_score, mention_count FROM topic_momentum WHERE topic_key=? AND last_mention_at >= ?'
        )
        .get(topicKey, windowStart) || null;
    } catch (e) {
      logger.warn('EvolutionStore', '[evolution] getTopicMomentum error:', (/** @type {Error} */ (e)).message);
      return null;
    }
  }

  /**
   * Prune topics outside the sliding window and enforce max count.
   * @private
   */
  _pruneOldTopics() {
    try {
      const now = Date.now();
      const windowStart = now - TOPIC_WINDOW_MS;

      // Remove old entries
      this._db
        .prepare('DELETE FROM topic_momentum WHERE last_mention_at < ?')
        .run(windowStart);

      // Enforce bounded history (keep top MAX_TRACKED_TOPICS by momentum)
      const count = this._db
        .prepare('SELECT COUNT(*) as c FROM topic_momentum')
        .get()?.c ?? 0;

      if (count > MAX_TRACKED_TOPICS) {
        this._db
          .prepare(
            `DELETE FROM topic_momentum WHERE id NOT IN (
              SELECT id FROM topic_momentum ORDER BY momentum_score DESC LIMIT ?
            )`
          )
          .run(MAX_TRACKED_TOPICS);
      }
    } catch (e) {
      logger.warn('EvolutionStore', '[evolution] pruneOldTopics error:', (/** @type {Error} */ (e)).message);
    }
  }

  /**
   * Get evolution statistics for diagnostics.
   * @returns {EvolutionStats}
   */
  getStats() {
    try {
      const profiles = this._db
        .prepare('SELECT COUNT(*) as c FROM communication_profiles')
        .get()?.c ?? 0;
      const topics = this._db
        .prepare('SELECT COUNT(*) as c FROM topic_momentum')
        .get()?.c ?? 0;
      const hotTopics = this._db
        .prepare('SELECT COUNT(*) as c FROM topic_momentum WHERE momentum_score >= 0.3')
        .get()?.c ?? 0;
      const coldTopics = this._db
        .prepare('SELECT COUNT(*) as c FROM topic_momentum WHERE momentum_score <= 0.2 AND mention_count >= 2')
        .get()?.c ?? 0;

      return { profiles, topics, hotTopics, coldTopics };
    } catch (e) {
      return { profiles: 0, topics: 0, hotTopics: 0, coldTopics: 0 };
    }
  }
}

// Named exports explícitos: los queries de tipo import() en JSDoc de otros
// módulos siguen semántica ESM y solo ven miembros nombrados así.
exports.EvolutionStore = EvolutionStore;
exports.EMA_ALPHA = EMA_ALPHA;
exports.TOPIC_EMA_ALPHA = TOPIC_EMA_ALPHA;
exports.TOPIC_WINDOW_MS = TOPIC_WINDOW_MS;
exports.MAX_TRACKED_TOPICS = MAX_TRACKED_TOPICS;
