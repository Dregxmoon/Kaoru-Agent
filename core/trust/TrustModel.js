// @ts-check
'use strict';

/**
 * TrustModel.js — Fase 3, ítem 4: modelo de confianza dinámico (costo×éxito).
 *
 * Aprende del historial de tareas (los outcomes que registra LearningEngine +
 * el coste real del UsageTracker) qué configuración (proveedor/modelo/modo)
 * resuelve tareas con el mejor balance costo×éxito, y recomienda el modo
 * (smart/fast) de forma CONSERVADORA.
 *
 * Score de confianza por clave (additive-smoothed, acotado [0,1]):
 *   trust = p_ajustada · dificultadFactor · costFactor · latencyFactor · recentFactor
 *
 *   - p_ajustada: tasa de éxito con suavizado hacia 0.5 (no aprende de 1 dato).
 *   - dificultadFactor: resolver tareas difíciles con éxito vale más.
 *   - costFactor:      eficiencia en $ (presupuesto por modo / coste real por tarea).
 *   - latencyFactor:   eficiencia en latencia (presupuesto por modo / ms reales).
 *   - recentFactor:    rachas de fallos consecutivos lo castigan (y se recupera
 *                      con el primer éxito).
 *
 * Se guardan 3 granularidades por outcome:
 *   "provider/model/mode"   → confianza fina
 *   "provider + mode"       → confianza por proveedor (modelo comodin "*")
 *   "mode"                  → confianza por modo
 * (el operador de comodin evita secuencias de cierre de comentario).
 *
 * Persistencia JSON con el patrón nunca-lanza (como LearningEngine/ProposalStore).
 */

const fs = require('fs');
const path = require('path');
const logger = require('../observability/Logger.js');

const DEFAULT_PATH = path.join(__dirname, '..', '..', 'data', 'trust_feedback.json');

// Presupuestos por modo (costo×éxito): "para este modo, qué esperar de una
// tarea normal". Usados como denominador de costFactor/latencyFactor.
/**
 * @type {Record<string, {costUsd: number, latencyMs: number, maxIterations: number}>}
 */
const MODE_BUDGET = {
  smart: { costUsd: 0.02, latencyMs: 90000, maxIterations: 25 },
  fast: { costUsd: 0.003, latencyMs: 25000, maxIterations: 8 },
};

// Muestras mínimas antes de recomendar; umbral de confianza para que la
// recomendación se tenga en cuenta; ventaja mínima para sobreescribir el modo.
const MIN_ATTEMPTS = 3;
const RECOMMEND_THRESHOLD = 0.55;
const MODE_ADVANTAGE = 0.15;
const SMOOTHING_K = 2; // suavizado aditivo de la tasa de éxito

/**
 * @typedef {object} TrustKeyStats
 * @property {number} attempts
 * @property {number} success
 * @property {number} costUsd
 * @property {number} elapsedMsSum
 * @property {number} iterationsSum
 * @property {number} difficultySum
 * @property {number} consecFails
 * @property {number} maxConsecFails
 * @property {number} lastTs
 * @property {string|null} lastError
 */

/**
 * @typedef {object} TrustOutcome
 * @property {string} [mode]
 * @property {string} [provider]
 * @property {string|null} [model]
 * @property {boolean} [success]
 * @property {string|null} [error]
 * @property {number} [elapsedMs]
 * @property {number} [iterations]
 * @property {number} [difficulty]
 * @property {number} [costUsd]
 * @property {number} [ts]
 */

/**
 * Mensaje seguro de un `catch` (tipo `unknown` con el tsconfig actual).
 * @param {unknown} e
 * @returns {string}
 */
function _errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}

class TrustModel {
  /**
   * @param {object} [opts]
   * @param {string} [opts.filePath] Ruta del JSON (inyectable en tests).
   */
  constructor({ filePath } = {}) {
    this._filePath = filePath || DEFAULT_PATH;
    /** @type {Record<string, TrustKeyStats>} */
    this._keys = {};
    this._updatedAt = null;
    this._inMem = false;
    this._load();
  }

  _load() {
    try {
      if (this._filePath && fs.existsSync(this._filePath)) {
        const raw = JSON.parse(fs.readFileSync(this._filePath, 'utf-8'));
        if (raw && typeof raw === 'object' && raw.keys && typeof raw.keys === 'object') {
          this._keys = raw.keys;
          this._updatedAt = raw.updatedAt || null;
        }
      }
    } catch (e) {
      logger.warn('TrustModel', '[trust] no se pudo leer feedback previo:', _errMsg(e));
      this._inMem = true;
    }
  }

  _persist() {
    if (this._inMem || !this._filePath) return;
    try {
      fs.mkdirSync(path.dirname(this._filePath), { recursive: true });
      fs.writeFileSync(
        this._filePath,
        JSON.stringify({ keys: this._keys, updatedAt: this._updatedAt }, null, 2)
      );
    } catch (e) {
      logger.warn('TrustModel', '[trust] no se pudo persistir feedback:', _errMsg(e));
      this._inMem = true;
    }
  }

  /**
   * @param {string} provider
   * @param {string|null} model
   * @param {string} mode
   * @returns {string}
   */
  _key(provider, model, mode) {
    return `${provider}/${model}/${mode}`;
  }

  /**
   * @param {string} key
   * @param {TrustOutcome} outcome
   */
  _touch(key, outcome) {
    const s = this._keys[key] || {
      attempts: 0,
      success: 0,
      costUsd: 0,
      elapsedMsSum: 0,
      iterationsSum: 0,
      difficultySum: 0,
      consecFails: 0,
      maxConsecFails: 0,
      lastTs: 0,
      lastError: null,
    };
    s.attempts += 1;
    s.costUsd += outcome.costUsd || 0;
    s.elapsedMsSum += outcome.elapsedMs || 0;
    s.iterationsSum += outcome.iterations || 0;
    s.difficultySum += outcome.difficulty || 0;
    s.lastTs = outcome.ts || Date.now();
    if (outcome.success) {
      s.success += 1;
      s.consecFails = 0;
    } else {
      s.consecFails += 1;
      s.maxConsecFails = Math.max(s.maxConsecFails, s.consecFails);
      s.lastError = outcome.error || s.lastError;
    }
    this._keys[key] = s;
  }

  /**
   * Registra el outcome de una tarea en las 3 granularidades.
   * @param {TrustOutcome} [outcome]
   * @returns {TrustKeyStats | undefined}
   */
  recordOutcome(outcome = {}) {
    const mode = outcome.mode || 'fast';
    const provider = outcome.provider || 'unknown';
    const model = outcome.model || null;
    this._touch(this._key(provider, model, mode), outcome);
    this._touch(this._key(provider, '*', mode), outcome);
    this._touch(this._key('*', '*', mode), outcome);
    this._updatedAt = outcome.ts || Date.now();
    this._persist();
    return this._keys[this._key(provider, model, mode)];
  }

  /**
   * Score de confianza de una clave. Devuelve null si la clave no existe.
   * @param {string} key  `${provider}/${model}/${mode}` (model puede ser '*').
   * @returns {{ trust: number, confidence: number, stats: TrustKeyStats } | null}
   */
  trustScore(key) {
    const s = this._keys[key];
    if (!s) return null;
    const mode = key.split('/')[2] || 'fast';
    const budget = MODE_BUDGET[mode] || MODE_BUDGET.fast;
    const p = (s.success + SMOOTHING_K) / (s.attempts + 2 * SMOOTHING_K);
    const avgDifficulty = s.attempts ? s.difficultySum / s.attempts : 0;
    const difficultyFactor = 0.5 + 0.5 * clamp(avgDifficulty, 0, 1);
    const costPerTask = s.costUsd / s.attempts;
    const costFactor = costPerTask > 0 ? clamp(budget.costUsd / costPerTask, 0.2, 1) : 1;
    const avgElapsed = s.elapsedMsSum / s.attempts;
    const latencyFactor = avgElapsed > 0 ? clamp(budget.latencyMs / avgElapsed, 0.2, 1) : 1;
    const recentFactor = clamp(1 - s.consecFails * 0.15, 0.3, 1);
    const trust = clamp(p * difficultyFactor * costFactor * latencyFactor * recentFactor, 0, 1);
    const confidence = 1 - 1 / (1 + s.attempts / MIN_ATTEMPTS);
    return { trust, confidence, stats: s };
  }

  /**
   * Recomienda el mejor modo/configuración para una tarea. Conservador: solo
   * devuelve algo si hay suficientes muestras Y el score supera el umbral.
   *
   * @param {object} [opts]
   * @param {boolean} [opts.isTask]        true = tarea, false = charla
   * @param {number} [opts.difficulty]     estimacion 0..1 (difficulty.js)
   * @param {string|null} [opts.explicitMode] modo pedido explicitamente
   * @returns {{ mode: string, provider: string, model: string|null, trust: number, confidence: number, costPerTask: number, rationale: string } | null}
   */
  recommendMode({ isTask = false, difficulty = 0, explicitMode = null } = {}) {
    const preferSmart = isTask || difficulty >= 0.6;
    const modes = explicitMode
      ? [explicitMode]
      : preferSmart
        ? ['smart', 'fast']
        : ['fast', 'smart'];

    let best = null;
    for (const mode of modes) {
      // Mejor clave fina de este modo con suficientes muestras.
      const candidates = Object.keys(this._keys).filter(
        (k) =>
          k.endsWith(`/${mode}`) &&
          k.split('/')[1] !== '*' &&
          this._keys[k].attempts >= MIN_ATTEMPTS
      );
      for (const k of candidates) {
        const sc = this.trustScore(k);
        if (!sc) continue;
        const [provider, model] = k.split('/');
        if (!best || sc.trust > best.trust) {
          best = {
            mode,
            provider,
            model: model === '*' ? null : model,
            trust: sc.trust,
            confidence: sc.confidence,
            costPerTask: sc.stats.costUsd / sc.stats.attempts,
            rationale: `${provider}/${model} en modo ${mode} (${sc.stats.attempts} tareas, ${sc.stats.success} ok, $${(sc.stats.costUsd / sc.stats.attempts).toFixed(4)}/tarea)`,
          };
        }
      }
    }

    if (!best || (best.trust < RECOMMEND_THRESHOLD && !explicitMode)) return null;
    return best;
  }

  getData() {
    return {
      keys: this._keys,
      updatedAt: this._updatedAt,
      filePath: this._filePath,
      inMemoryOnly: this._inMem,
    };
  }

  getStats() {
    /** @type {Record<string, object>} */
    const summary = {};
    for (const [k, s] of Object.entries(this._keys)) {
      const sc = this.trustScore(k);
      summary[k] = {
        attempts: s.attempts,
        success: s.success,
        trust: sc ? Number(sc.trust.toFixed(3)) : null,
        confidence: sc ? Number(sc.confidence.toFixed(3)) : null,
        costPerTask: Number((s.costUsd / s.attempts).toFixed(5)),
        avgElapsedMs: Math.round(s.elapsedMsSum / s.attempts),
        consecFails: s.consecFails,
        lastError: s.lastError,
      };
    }
    return { summary, updatedAt: this._updatedAt };
  }

  reset() {
    this._keys = {};
    this._updatedAt = null;
    this._inMem = false;
    if (this._filePath) {
      try {
        fs.rmSync(this._filePath, { force: true });
      } catch {}
    }
  }
}

/**
 * @param {number} v
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

module.exports = { TrustModel, MODE_BUDGET, MIN_ATTEMPTS, RECOMMEND_THRESHOLD, MODE_ADVANTAGE };
