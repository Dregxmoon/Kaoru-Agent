// @ts-check
'use strict';

/**
 * LLMEotionDetector.js — Detección de emociones basada en LLM.
 *
 * Reemplaza el TraitLearner regex por un análisis semántico real.
 * Usa el LLM para detectar:
 *   - Emociones del usuario (frustración, entusiasmo, confusión, calma, etc.)
 *   - Tono de la conversación (casual, serio, técnico, juguetón)
 *   - Energía (alta, media, baja)
 *   - Intención implícita (buscar ayuda, desahogarse, compartir logro, etc.)
 *
 * Diseño:
 *   - Fallback a regex si el LLM no está disponible (degradación graceful)
 *   - Cache por sesión para no repetir análisis en mensajes similares
 *   - Timeout corto (2s) para no bloquear el flujo
 */

const logger = require('../../observability/Logger.js');

// ── Prompt para detección emocional ─────────────────────────────────────────

const EMOTION_SYSTEM = `Eres un analizador de emociones para un asistente personal de vtuber.
Analiza el mensaje del usuario y devuelve SOLO un JSON con esta estructura:
{
  "emotions": {
    "frustration": 0.0-1.0,
    "enthusiasm": 0.0-1.0,
    "confusion": 0.0-1.0,
    "calm": 0.0-1.0,
    "urgency": 0.0-1.0,
    "playfulness": 0.0-1.0
  },
  "tone": "casual" | "serious" | "technical" | "playful" | "emotional",
  "energy": "low" | "medium" | "high",
  "implicitIntent": "seeking_help" | "venting" | "sharing_achievement" | "casual_chat" | "asking_question" | "none"
}

Reglas:
- frustration: enojo, molestia, "no funciona", errores, UFF, PUTA
- enthusiasm: emoción, logros, descubrimientos, ¡¡¡, WAAAH
- confusion: no entender algo, preguntas que revelan duda
- calm: conversación relajada, sin prisa
- urgency: necesita algo rápido, AHORA, URGENTE
- playfulness: bromas, chistes, tono ligero
- NO inventes emociones que no estén presentes
- Si no hay emoción clara, pon 0.0 en todos y "none" en implicitIntent
- Responde SOLO el JSON, sin explicaciones`;

// ── Cache por sesión ────────────────────────────────────────────────────────

const CACHE_MAX = 50;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min

// ── Emociones por defecto (fallback regex) ──────────────────────────────────

const DEFAULT_EMOTIONS = {
  frustration: 0,
  enthusiasm: 0,
  confusion: 0,
  calm: 0.5,
  urgency: 0,
  playfulness: 0,
};

/**
 * Detección regex de fallback (misma que TraitLearner pero expuesta).
 * @param {string} message
 * @returns {Object} emociones
 */
function _fallbackEmotionDetection(message) {
  if (!message) return { ...DEFAULT_EMOTIONS, tone: 'casual', energy: 'medium', implicitIntent: 'none' };

  const m = message.toLowerCase();
  const emotions = { ...DEFAULT_EMOTIONS };

  if (/no (me )?funciona|error|fallo|rompi|bug|crash|explot|uff|puta|mierda/.test(m)) {
    emotions.frustration = 0.7;
  }
  if (/¡¡|wow|genial|increíble|waaah|cool|awesome|logré|funcionó|terminé/.test(m)) {
    emotions.enthusiasm = 0.8;
  }
  if (/no (se|entiendo|comprendo)|confus|duda|¿cómo|qué es|por qué/.test(m)) {
    emotions.confusion = 0.6;
  }
  if (/[!]{2,}|[A-Z]{4,}|urgente|ahora|ya/.test(message)) {
    emotions.urgency = 0.7;
  }
  if (/jaja|jeje| XD|broma|chiste|juego/.test(m)) {
    emotions.playfulness = 0.8;
  }

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
}

class LLMEotionDetector {
  /**
   * @param {import('../../llm/LLMProvider.js')} llmProvider
   * @param {Object} [opts]
   * @param {number} [opts.timeoutMs]  timeout para la llamada al LLM
   * @param {boolean} [opts.enabled]   false = solo regex
   */
  constructor(llmProvider, opts = {}) {
    this._llm = llmProvider;
    this._timeoutMs = opts.timeoutMs ?? 2000;
    this._enabled = opts.enabled !== false;

    // Cache
    this._cache = new Map(); // key → { result, timestamp }
  }

  /**
   * Analiza un mensaje y devuelve emociones detectadas.
   * @param {string} message
   * @param {Object} [context]  contexto adicional (historial, OS, etc.)
   * @returns {Promise<Object>} emociones + tone + energy + implicitIntent
   */
  async detect(message, context = {}) {
    if (!message || typeof message !== 'string') {
      return _fallbackEmotionDetection('');
    }

    // Cache check
    const cacheKey = this._cacheKey(message);
    const cached = this._cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.result;
    }

    // Si el LLM no está habilitado o no hay provider, usar fallback
    if (!this._enabled || !this._llm) {
      const result = _fallbackEmotionDetection(message);
      this._cacheSet(cacheKey, result);
      return result;
    }

    try {
      const result = await this._analyzeWithLLM(message, context);
      this._cacheSet(cacheKey, result);
      return result;
    } catch (e) {
      logger.debug('LLMEotionDetector', `LLM fallback: ${e.message}`);
      const result = _fallbackEmotionDetection(message);
      this._cacheSet(cacheKey, result);
      return result;
    }
  }

  /**
   * Análisis con LLM.
   * @param {string} message
   * @param {Object} context
   * @returns {Promise<Object>}
   */
  async _analyzeWithLLM(message, context) {
    const contextStr = context.history?.length
      ? `\nHistorial reciente: ${context.history.slice(-3).map((h) => `${h.role}: ${h.content.slice(0, 80)}`).join('\n')}`
      : '';

    const userPrompt = `Mensaje del usuario: "${message.slice(0, 500)}"${contextStr}

Analiza las emociones y responde SOLO con el JSON.`;

    // Timeout race
    const response = await Promise.race([
      this._llm.complete(
        [{ role: 'user', content: userPrompt }],
        EMOTION_SYSTEM,
        { disableThinking: true, maxTokens: 200 }
      ),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), this._timeoutMs)
      ),
    ]);

    return this._parseResponse(response);
  }

  /**
   * Parsea la respuesta del LLM.
   * @param {string} response
   * @returns {Object}
   */
  _parseResponse(response) {
    if (!response) return _fallbackEmotionDetection('');

    // Limpiar fences de código
    let text = response.trim();
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && parsed.emotions) {
        // Validar que todos los campos existan
        return {
          frustration: Math.max(0, Math.min(1, parsed.emotions.frustration ?? 0)),
          enthusiasm: Math.max(0, Math.min(1, parsed.emotions.enthusiasm ?? 0)),
          confusion: Math.max(0, Math.min(1, parsed.emotions.confusion ?? 0)),
          calm: Math.max(0, Math.min(1, parsed.emotions.calm ?? 0)),
          urgency: Math.max(0, Math.min(1, parsed.emotions.urgency ?? 0)),
          playfulness: Math.max(0, Math.min(1, parsed.emotions.playfulness ?? 0)),
          tone: ['casual', 'serious', 'technical', 'playful', 'emotional'].includes(parsed.tone)
            ? parsed.tone : 'casual',
          energy: ['low', 'medium', 'high'].includes(parsed.energy)
            ? parsed.energy : 'medium',
          implicitIntent: ['seeking_help', 'venting', 'sharing_achievement', 'casual_chat', 'asking_question', 'none']
            .includes(parsed.implicitIntent) ? parsed.implicitIntent : 'none',
        };
      }
    } catch {
      // JSON inválido
    }

    return _fallbackEmotionDetection('');
  }

  /**
   * Genera una clave de cache basada en el contenido del mensaje.
   * @param {string} message
   * @returns {string}
   */
  _cacheKey(message) {
    // Normalizar: lowercase, quitar puntuación, primeros 100 chars
    return message
      .toLowerCase()
      .replace(/[¿?¡!.,:;]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100);
  }

  _cacheSet(key, result) {
    this._cache.set(key, { result, timestamp: Date.now() });
    // Podar si excede el máximo
    if (this._cache.size > CACHE_MAX) {
      const oldest = this._cache.keys().next().value;
      this._cache.delete(oldest);
    }
  }
}

module.exports = { LLMEotionDetector, _fallbackEmotionDetection };
