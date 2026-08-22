// @ts-check
'use strict';

/**
 * EmotionalTrendTracker.js — Detecta tendencias emocionales en una sesión.
 *
 * A diferencia de LLMEotionDetector (que analiza cada mensaje fresco),
 * este tracker:
 *   - Mantiene un historial de emociones por sesión
 *   - Detecta TENDENCIAS: ¿la frustración sube o baja?
 *   - Detecta RECUPERACIÓN: ¿el usuario se calmó?
 *   - Detecta PATRONES: "este usuario siempre se frustra con X"
 *   - Calcula VELOCIDAD de cambio emocional
 *
 * Persiste en SQLite para análisis cross-sesión.
 */

const logger = require('../../observability/Logger.js');

// ── Schema ──────────────────────────────────────────────────────────────────

const EMOTIONAL_HISTORY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS emotional_history (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT    NOT NULL,
    turn_index      INTEGER NOT NULL,
    frustration     REAL    NOT NULL DEFAULT 0,
    enthusiasm      REAL    NOT NULL DEFAULT 0,
    confusion       REAL    NOT NULL DEFAULT 0,
    calm            REAL    NOT NULL DEFAULT 0.5,
    urgency         REAL    NOT NULL DEFAULT 0,
    playfulness     REAL    NOT NULL DEFAULT 0,
    tone            TEXT    NOT NULL DEFAULT 'casual',
    energy          TEXT    NOT NULL DEFAULT 'medium',
    implicit_intent TEXT    NOT NULL DEFAULT 'none',
    message_preview TEXT,
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
  );
  CREATE INDEX IF NOT EXISTS idx_emotional_history_session ON emotional_history(session_id);
  CREATE INDEX IF NOT EXISTS idx_emotional_history_turn ON emotional_history(session_id, turn_index);
`;

// ── Constantes ──────────────────────────────────────────────────────────────

const TREND_WINDOW = 5; // últimos N turnos para calcular tendencia
const VELOCITY_THRESHOLD = 0.1; // cambio mínimo para considerar tendencia
const RECOVERY_THRESHOLD = 0.3; // reducción para considerar recuperación
const ESCALATION_THRESHOLD = 0.15; // aumento para considerar escalación

// ── Emociones rastreadas ────────────────────────────────────────────────────

const TRACKED_EMOTIONS = ['frustration', 'enthusiasm', 'confusion', 'calm', 'urgency', 'playfulness'];

class EmotionalTrendTracker {
  /**
   * @param {import('../evolution/EvolutionStore.js').EvolutionStore} store
   */
  constructor(store) {
    this._store = store;
    this._db = store._db;

    // Estado en memoria por sesión
    this._sessionHistory = new Map(); // sessionId → Array<{ emotions, timestamp }>
    this._currentSessionId = null;
    this._turnIndex = 0;

    this._initSchema();
  }

  _initSchema() {
    try {
      this._db.exec(EMOTIONAL_HISTORY_SCHEMA);
    } catch (e) {
      logger.warn('EmotionalTrendTracker', `Error creando schema: ${e.message}`);
    }
  }

  /**
   * Inicia una nueva sesión de tracking.
   * @param {string} sessionId
   */
  startSession(sessionId) {
    this._currentSessionId = sessionId;
    this._turnIndex = 0;
    
    // Cargar historial existente de SQLite si la sesión ya tiene datos
    const existingHistory = this._loadSessionHistory(sessionId);
    this._sessionHistory.set(sessionId, existingHistory);
    
    // Actualizar turnIndex basado en el historial existente
    if (existingHistory.length > 0) {
      this._turnIndex = existingHistory[existingHistory.length - 1].turnIndex + 1;
    }
  }

  /**
   * Carga el historial de emociones de una sesión desde SQLite.
   * @param {string} sessionId
   * @returns {Array}
   */
  _loadSessionHistory(sessionId) {
    try {
      const rows = this._db.prepare(`
        SELECT turn_index, frustration, enthusiasm, confusion, calm, urgency, playfulness, 
               tone, energy, implicit_intent, message_preview, created_at
        FROM emotional_history 
        WHERE session_id = ?
        ORDER BY turn_index ASC
      `).all(sessionId);
      
      return rows.map(row => ({
        turnIndex: row.turn_index,
        emotions: {
          frustration: row.frustration,
          enthusiasm: row.enthusiasm,
          confusion: row.confusion,
          calm: row.calm,
          urgency: row.urgency,
          playfulness: row.playfulness,
          tone: row.tone,
          energy: row.energy,
          implicitIntent: row.implicit_intent,
        },
        timestamp: row.created_at,
        messagePreview: row.message_preview || '',
      }));
    } catch (e) {
      logger.debug('EmotionalTrendTracker', `Error cargando historial: ${e.message}`);
      return [];
    }
  }

  /**
   * Registra las emociones de un turno.
   * @param {string} sessionId
   * @param {Object} emotions  resultado de LLMEotionDetector.detect()
   * @param {string} messagePreview  primeros 100 chars del mensaje
   */
  recordTurn(sessionId, emotions, messagePreview = '') {
    if (!sessionId || !emotions) return;

    const entry = {
      turnIndex: this._turnIndex++,
      emotions: { ...emotions },
      timestamp: Date.now(),
      messagePreview: messagePreview.slice(0, 100),
    };

    // Agregar al historial en memoria
    if (!this._sessionHistory.has(sessionId)) {
      this._sessionHistory.set(sessionId, []);
    }
    const history = this._sessionHistory.get(sessionId);
    history.push(entry);

    // Mantener solo los últimos TURN_WINDOW en memoria
    if (history.length > TREND_WINDOW * 2) {
      this._sessionHistory.set(sessionId, history.slice(-TREND_WINDOW * 2));
    }

    // Persistir en SQLite
    this._persistTurn(sessionId, entry);
  }

  /**
   * Persiste un turno en SQLite.
   * @param {string} sessionId
   * @param {Object} entry
   */
  _persistTurn(sessionId, entry) {
    try {
      this._db.prepare(`
        INSERT INTO emotional_history (session_id, turn_index, frustration, enthusiasm, confusion, calm, urgency, playfulness, tone, energy, implicit_intent, message_preview)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        sessionId,
        entry.turnIndex,
        entry.emotions.frustration ?? 0,
        entry.emotions.enthusiasm ?? 0,
        entry.emotions.confusion ?? 0,
        entry.emotions.calm ?? 0.5,
        entry.emotions.urgency ?? 0,
        entry.emotions.playfulness ?? 0,
        entry.emotions.tone ?? 'casual',
        entry.emotions.energy ?? 'medium',
        entry.emotions.implicitIntent ?? 'none',
        entry.messagePreview
      );
    } catch (e) {
      logger.debug('EmotionalTrendTracker', `Error persistiendo turno: ${e.message}`);
    }
  }

  /**
   * Obtiene la tendencia de una emoción específica.
   * @param {string} sessionId
   * @param {string} emotion
   * @returns {{ trend: 'rising'|'falling'|'stable'|'volatile', velocity: number, current: number, average: number, samples: number }}
   */
  getEmotionTrend(sessionId, emotion) {
    const history = this._sessionHistory.get(sessionId) || [];
    const recent = history.slice(-TREND_WINDOW);

    if (recent.length < 2) {
      return { trend: 'stable', velocity: 0, current: 0, average: 0, samples: recent.length };
    }

    const values = recent.map((e) => e.emotions[emotion] ?? 0);
    const current = values[values.length - 1];
    const average = values.reduce((a, b) => a + b, 0) / values.length;

    // Calcular velocidad de cambio (pendiente de la regresión lineal simple)
    const n = values.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += values[i];
      sumXY += i * values[i];
      sumX2 += i * i;
    }
    const velocity = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX) || 0;

    // Determinar tendencia
    let trend = 'stable';
    if (Math.abs(velocity) > VELOCITY_THRESHOLD) {
      trend = velocity > 0 ? 'rising' : 'falling';
    }

    // Detectar volatilidad (cambios frecuentes de dirección)
    if (recent.length >= 3) {
      let directionChanges = 0;
      for (let i = 2; i < values.length; i++) {
        const prev = values[i - 1] - values[i - 2];
        const curr = values[i] - values[i - 1];
        if ((prev > 0 && curr < 0) || (prev < 0 && curr > 0)) {
          directionChanges++;
        }
      }
      if (directionChanges >= 2) trend = 'volatile';
    }

    return { trend, velocity, current, average, samples: recent.length };
  }

  /**
   * Obtiene el resumen de tendencias para todas las emociones.
   * @param {string} sessionId
   * @returns {Object}
   */
  getAllTrends(sessionId) {
    const trends = {};
    for (const emotion of TRACKED_EMOTIONS) {
      trends[emotion] = this.getEmotionTrend(sessionId, emotion);
    }
    return trends;
  }

  /**
   * Detecta si hay una recuperación emocional (el usuario se calmó).
   * @param {string} sessionId
   * @returns {{ recovered: boolean, from: string, to: string, improvement: number }}
   */
  detectRecovery(sessionId) {
    const history = this._sessionHistory.get(sessionId) || [];
    if (history.length < 3) {
      return { recovered: false, from: 'unknown', to: 'unknown', improvement: 0 };
    }

    const recent = history.slice(-3);
    const prevAvg = (recent[0].emotions.frustration + recent[1].emotions.frustration) / 2;
    const currAvg = recent[2].emotions.frustration;

    if (prevAvg - currAvg >= RECOVERY_THRESHOLD) {
      return {
        recovered: true,
        from: 'frustrated',
        to: 'calmer',
        improvement: prevAvg - currAvg,
      };
    }

    // Detectar recuperación de confusión
    const prevConfusion = (recent[0].emotions.confusion + recent[1].emotions.confusion) / 2;
    const currConfusion = recent[2].emotions.confusion;
    if (prevConfusion - currConfusion >= RECOVERY_THRESHOLD) {
      return {
        recovered: true,
        from: 'confused',
        to: 'clearer',
        improvement: prevConfusion - currConfusion,
      };
    }

    return { recovered: false, from: 'unknown', to: 'unknown', improvement: 0 };
  }

  /**
   * Detecta si hay una escalación emocional (el usuario se enoja más).
   * @param {string} sessionId
   * @returns {{ escalated: boolean, emotion: string, severity: number, velocity: number }}
   */
  detectEscalation(sessionId) {
    const trends = this.getAllTrends(sessionId);

    // Verificar frustración creciente
    if (trends.frustration.trend === 'rising' && trends.frustration.velocity > ESCALATION_THRESHOLD) {
      return {
        escalated: true,
        emotion: 'frustration',
        severity: trends.frustration.current,
        velocity: trends.frustration.velocity,
      };
    }

    // Verificar urgencia creciente
    if (trends.urgency.trend === 'rising' && trends.urgency.velocity > ESCALATION_THRESHOLD) {
      return {
        escalated: true,
        emotion: 'urgency',
        severity: trends.urgency.current,
        velocity: trends.urgency.velocity,
      };
    }

    return { escalated: false, emotion: 'none', severity: 0, velocity: 0 };
  }

  /**
   * Genera un resumen para el system prompt.
   * @param {string} sessionId
   * @returns {string}
   */
  buildTrendHint(sessionId) {
    const parts = [];

    // Tendencias principales
    const frustrationTrend = this.getEmotionTrend(sessionId, 'frustration');
    const enthusiasmTrend = this.getEmotionTrend(sessionId, 'enthusiasm');
    const recovery = this.detectRecovery(sessionId);
    const escalation = this.detectEscalation(sessionId);

    if (escalation.escalated) {
      parts.push(`ALERTA: ${escalation.emotion} está ESCALANDO (velocidad: ${escalation.velocity.toFixed(2)}). Reduce tensión.`);
    }

    if (recovery.recovered) {
      parts.push(`El usuario se recuperó de estar ${recovery.from}. Puedes ser más detallada ahora.`);
    }

    if (frustrationTrend.trend === 'falling' && frustrationTrend.samples >= 3) {
      parts.push('La frustración está bajando. Mantén el tono actual.');
    }

    if (frustrationTrend.trend === 'rising' && frustrationTrend.samples >= 3) {
      parts.push('La frustración está subiendo. Sé más concisa y empática.');
    }

    if (enthusiasmTrend.trend === 'rising' && enthusiasmTrend.samples >= 3) {
      parts.push('El entusiasmo está subiendo. Matchea la energía.');
    }

    if (frustrationTrend.trend === 'volatile') {
      parts.push('El estado emocional es inestable. Sé flexible y adaptable.');
    }

    return parts.length ? `\nTENDENCIA EMOCIONAL:\n- ${parts.join('\n- ')}` : '';
  }

  /**
   * Obtiene estadísticas de la sesión.
   * @param {string} sessionId
   * @returns {Object}
   */
  getSessionStats(sessionId) {
    const history = this._sessionHistory.get(sessionId) || [];
    if (!history.length) return { turns: 0 };

    const avgFrustration = history.reduce((s, e) => s + (e.emotions.frustration ?? 0), 0) / history.length;
    const avgEnthusiasm = history.reduce((s, e) => s + (e.emotions.enthusiasm ?? 0), 0) / history.length;
    const avgCalm = history.reduce((s, e) => s + (e.emotions.calm ?? 0), 0) / history.length;

    return {
      turns: history.length,
      avgFrustration,
      avgEnthusiasm,
      avgCalm,
      dominantEmotion: avgFrustration > 0.5 ? 'frustration' : avgEnthusiasm > 0.5 ? 'enthusiasm' : 'calm',
    };
  }
}

module.exports = { EmotionalTrendTracker, TRACKED_EMOTIONS, TREND_WINDOW };
