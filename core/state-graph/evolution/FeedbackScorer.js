// @ts-check
'use strict';

/**
 * FeedbackScorer.js — Mide si las adaptaciones de estilo mejoraron la respuesta del usuario.
 *
 * Rastrea:
 *   - Longitud de respuestas del usuario post-adaptación vs pre-adaptación
 *   - Engagement (si el usuario continuó la conversación vs la abandonó)
 *   - Frecuencia de preguntas del usuario (más preguntas = más interesado)
 *   - Uso de emojis/reakciones (señal de engagement positivo)
 *
 * El scoring es determinístico (sin LLM) y usa EMA para suavizar.
 * Los scores se almacenan en EvolutionStore para aprendizaje cross-sesión.
 */

const logger = require('../../observability/Logger.js');

// ── Constantes ──────────────────────────────────────────────────────────────

const EMA_ALPHA = 0.2;
const MIN_TURNS_FOR_SIGNAL = 2; // mínimo de turnos para calcular engagement
const ENGAGEMENT_WINDOW_MS = 5 * 60 * 1000; // 5 min ventana para medir respuesta

// ── Schema ──────────────────────────────────────────────────────────────────

const FEEDBACK_SCORES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS feedback_scores (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    adaptation_type TEXT    NOT NULL,
    metric_key      TEXT    NOT NULL,
    ema_value       REAL    NOT NULL DEFAULT 0.5,
    sample_count    INTEGER NOT NULL DEFAULT 0,
    last_updated_at INTEGER NOT NULL,
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
  );
  CREATE INDEX IF NOT EXISTS idx_feedback_adaptation ON feedback_scores(adaptation_type);
`;

// ── Métricas de engagement ──────────────────────────────────────────────────

/**
 * Calcula un score de engagement para un turno del usuario.
 * Factores:
 *   - Longitud del mensaje (>50 chars = +0.2, >150 chars = +0.3)
 *   - Presencia de emojis (+0.1)
 *   - Es una pregunta (+0.15)
 *   - Continuación de conversación (+0.1)
 * @param {string} message
 * @param {boolean} isFollowUp  true si hay turnos previos en la ventana
 * @returns {number} score entre 0 y 1
 */
function _computeTurnEngagement(message, isFollowUp) {
  if (!message || typeof message !== 'string') return 0.3;
  let score = 0.3; // base

  const len = message.length;
  if (len > 150) score += 0.3;
  else if (len > 50) score += 0.2;
  else if (len < 15) score += 0.1; // respuestas muy cortas = bajo engagement

  // Emojis
  if (
    /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u.test(
      message
    )
  ) {
    score += 0.1;
  }

  // Preguntas del usuario (señal de interés)
  if (/\?|¿/.test(message)) score += 0.15;

  // Follow-up (el usuario continuó hablando)
  if (isFollowUp) score += 0.1;

  // Exclamaciones (energía)
  if (/[!¡]/.test(message)) score += 0.05;

  return Math.min(1, score);
}

/**
 * Detecta si el usuario parece frustrado o molesto.
 * @param {string} message
 * @returns {number} 0-1 (0 = no frustrado, 1 = muy frustrado)
 */
function _detectFrustration(message) {
  if (!message) return 0;
  const m = message.toLowerCase();
  let score = 0;

  if (/no (me )?funciona|error|fallo|rompi|bug|crash|exploto/.test(m)) score += 0.3;
  if (/molesto|frustrad|cansad|harto|fastidi/.test(m)) score += 0.4;
  if (/\bpor favor\b/.test(m)) score += 0.1; // puede ser cortesía o desesperación
  if (/[!]{2,}|[A-Z]{3,}/.test(message)) score += 0.2; // énfasis

  return Math.min(1, score);
}

class FeedbackScorer {
  /**
   * @param {import('./EvolutionStore.js').EvolutionStore} store
   */
  constructor(store) {
    this._store = store;
    this._db = store._db;

    // Estado en memoria para cálculos en tiempo real
    this._lastAdaptation = null; // { type, timestamp, styleHint }
    this._preAdaptationEngagement = []; // últimos N scores antes de adaptar
    this._postAdaptationEngagement = []; // últimos N scores después de adaptar

    this._initSchema();
  }

  _initSchema() {
    try {
      this._db.exec(FEEDBACK_SCORES_SCHEMA);
    } catch (e) {
      logger.warn('FeedbackScorer', `Error creando schema: ${e.message}`);
    }
  }

  /**
   * Registra que se aplicó una adaptación de estilo.
   * Llamado por AdaptiveResponseEngine cuando inyecta un hint.
   * @param {string} adaptationType  'responseLength' | 'questionFrequency' | 'emojiStyle' | 'energyLevel'
   * @param {string} styleHint  el texto del hint aplicado
   */
  recordAdaptation(adaptationType, styleHint) {
    this._lastAdaptation = {
      type: adaptationType,
      timestamp: Date.now(),
      styleHint,
    };
    this._preAdaptationEngagement = [];
    this._postAdaptationEngagement = [];
  }

  /**
   * Registra un turno del usuario y calcula engagement.
   * Llamado por SessionManager.addTurn() para cada mensaje del usuario.
   * @param {string} message
   */
  recordUserTurn(message) {
    const engagement = _computeTurnEngagement(message, this._preAdaptationEngagement.length > 0);
    const frustration = _detectFrustration(message);

    if (this._lastAdaptation) {
      const elapsed = Date.now() - this._lastAdaptation.timestamp;
      if (elapsed < ENGAGEMENT_WINDOW_MS) {
        // Turno post-adaptación
        this._postAdaptationEngagement.push(engagement);
      } else {
        // Turno pre-adaptación (nueva ventana)
        this._preAdaptationEngagement.push(engagement);
      }
    } else {
      // Sin adaptación activa, acumular como baseline
      this._preAdaptationEngagement.push(engagement);
    }

    return { engagement, frustration };
  }

  /**
   * Calcula el delta de engagement post vs pre adaptación.
   * @returns {{ delta: number, pre: number, post: number, sampleSize: number, adaptationType: string }}
   */
  computeAdaptationDelta() {
    if (!this._lastAdaptation) return null;
    if (this._postAdaptationEngagement.length < MIN_TURNS_FOR_SIGNAL) return null;

    const pre = this._preAdaptationEngagement.length
      ? this._preAdaptationEngagement.reduce((a, b) => a + b, 0) /
        this._preAdaptationEngagement.length
      : 0.5;
    const post =
      this._postAdaptationEngagement.reduce((a, b) => a + b, 0) /
      this._postAdaptationEngagement.length;
    const delta = post - pre;

    return {
      delta,
      pre,
      post,
      sampleSize: this._postAdaptationEngagement.length,
      adaptationType: this._lastAdaptation.type,
    };
  }

  /**
   * Actualiza el score EMA de una adaptación con un nuevo delta.
   * @param {string} adaptationType
   * @param {number} delta  -1 a 1 (negativo = empeoró, positivo = mejoró)
   */
  updateScore(adaptationType, delta) {
    const key = adaptationType;
    try {
      const existing = this._db
        .prepare('SELECT * FROM feedback_scores WHERE adaptation_type = ?')
        .get(key);
      if (existing) {
        const newEma = existing.ema_value * (1 - EMA_ALPHA) + (0.5 + delta * 0.5) * EMA_ALPHA;
        this._db
          .prepare(
            'UPDATE feedback_scores SET ema_value = ?, sample_count = sample_count + 1, last_updated_at = ? WHERE adaptation_type = ?'
          )
          .run(Math.max(0, Math.min(1, newEma)), Date.now(), key);
      } else {
        this._db
          .prepare(
            'INSERT INTO feedback_scores (adaptation_type, metric_key, ema_value, sample_count, last_updated_at) VALUES (?, ?, ?, 1, ?)'
          )
          .run(key, key, 0.5 + delta * 0.5, Date.now());
      }
    } catch (e) {
      logger.warn('FeedbackScorer', `Error actualizando score: ${e.message}`);
    }
  }

  /**
   * Obtiene el score de efectividad de una adaptación.
   * @param {string} adaptationType
   * @returns {number} 0-1 (0.5 = neutral, >0.5 = efectivo, <0.5 = inefectivo)
   */
  getEffectiveness(adaptationType) {
    try {
      const row = this._db
        .prepare('SELECT ema_value FROM feedback_scores WHERE adaptation_type = ?')
        .get(adaptationType);
      return row ? row.ema_value : 0.5;
    } catch {
      return 0.5;
    }
  }

  /**
   * Obtiene un reporte completo de efectividad.
   * @returns {Object}
   */
  getReport() {
    try {
      const rows = this._db.prepare('SELECT * FROM feedback_scores ORDER BY ema_value DESC').all();
      const report = {};
      for (const r of rows) {
        report[r.adaptation_type] = {
          effectiveness: r.ema_value,
          samples: r.sample_count,
          lastUpdated: r.last_updated_at,
        };
      }
      return report;
    } catch {
      return {};
    }
  }
}

module.exports = { FeedbackScorer, _computeTurnEngagement, _detectFrustration };
