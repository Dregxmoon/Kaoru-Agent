// @ts-check
/**
 * MoodEngine.js — estado emocional transitorio del asistente (Fase B del
 * motor de identidad).
 *
 * Dado un evento del turno devuelve un mood + intensidad con histéresis: no
 * salta de un extremo al otro en un solo turno y decae hacia `default` con el
 * tiempo y con los turnos si no hay nuevos eventos.
 *
 * Fuentes de evento: los payloads `agent-progress` que ya emite AgentLoop
 * (`phase: 'start' | 'end'`, `status: 'ok' | 'error'`), mapeados por
 * `agentStates.stateFromProgress()`. En Fase B solo hay dos moods:
 * `default` y `gentle` (post-error, tono `uncertainty_behaviors.was_wrong`).
 *
 * La config (ventanas, plantillas) vive en `identity.dynamics.json` y es
 * tuneable sin tocar código. Los moods emitidos comparten vocabulario con
 * `GestureLexicon.MOODS` / `STATE_TO_MOOD` — el mismo concepto que ya usa el
 * avatar Live2D, unificado para el texto.
 */

'use strict';

const { AGENT_STATES, stateFromProgress } = require('../behavior/agentStates.js');
const { getDynamicsConfig } = require('./DynamicsConfig.js');

/**
 * @typedef {import('./DynamicsConfig.js').DynamicsConfigShape} DynamicsConfigShape
 * @typedef {NonNullable<DynamicsConfigShape['mood_engine']>} MoodEngineConfig
 */

const MAX_EVENTS = 16;

/**
 * @typedef {{
 *   mood: string,
 *   intensity: number,
 *   reason: string | null,
 * }} MoodSnapshot
 */

class MoodEngine {
  /**
   * @param {MoodEngineConfig | null} [config] - sección `mood_engine`.
   */
  constructor(config = null) {
    /** @type {MoodEngineConfig} */
    this._cfg = config || getDynamicsConfig().mood_engine || {};
    this._turns = 0;
    this._lastErrorTs = 0;
    this._lastErrorTurn = -1;
    /** @type {Array<{state: string, ts: number}>} */
    this._events = [];
  }

  /**
   * Alimenta el motor con un evento de progreso del agente (payload
   * `agent-progress`). Deriva el estado con `stateFromProgress`.
   *
   * @param {{phase?: string, status?: string}} progress
   * @param {number} [ts] - timestamp del evento (seam de test).
   */
  noteProgress(progress = {}, ts = Date.now()) {
    const state = stateFromProgress(progress);
    this._events.push({ state, ts });
    if (this._events.length > MAX_EVENTS) this._events.shift();
    if (state === AGENT_STATES.ERROR) {
      this._lastErrorTs = ts;
      this._lastErrorTurn = this._turns;
    }
  }

  /** Marca el fin de un turno: alimenta la histéresis por turnos. */
  noteTurn() {
    this._turns += 1;
  }

  /**
   * Estado emocional actual. Histéresis: el mood solo se sostiene mientras el
   * evento siga dentro de la ventana temporal (`window_ms`) Y no hayan pasado
   * `hold_turns` turnos sin nuevos errores; la intensidad decae con la edad
   * del evento en lugar de saltar a 0 de golpe.
   *
   * @param {{now?: number, turns?: number}} [opts] - seams de test.
   * @returns {MoodSnapshot}
   */
  resolve(opts = {}) {
    const now = opts.now ?? Date.now();
    const turns = opts.turns ?? this._turns;
    const windowMs = this._cfg.window_ms ?? 300_000;
    const holdTurns = this._cfg.hold_turns ?? 2;

    if (this._lastErrorTs === 0) return this._default();

    const ageMs = now - this._lastErrorTs;
    const turnsSinceError = this._lastErrorTurn >= 0 ? turns - this._lastErrorTurn : holdTurns + 1;
    if (ageMs > windowMs || turnsSinceError >= holdTurns) return this._default();

    const base = this._cfg.post_error || { mood: 'gentle', intensity: 0.6 };
    const intensity = Math.max(0, (1 - ageMs / windowMs) * (base.intensity ?? 0.6));
    return {
      mood: base.mood || 'gentle',
      intensity: Math.round(intensity * 100) / 100,
      reason: 'error_reciente',
    };
  }

  /**
   * Snapshot actual (alias de resolve sin argumentos).
   * @returns {MoodSnapshot}
   */
  snapshot() {
    return this.resolve();
  }

  /**
   * @returns {MoodSnapshot}
   */
  _default() {
    return { mood: 'default', intensity: 0, reason: null };
  }
}

/** @type {MoodEngine | null} */
let _singleton = null;

/**
 * Instancia compartida del proceso: un solo estado emocional por app.
 * @returns {MoodEngine}
 */
function getMoodEngine() {
  if (!_singleton) _singleton = new MoodEngine();
  return _singleton;
}

/**
 * Seam de test: reinicia la instancia compartida.
 * @returns {MoodEngine}
 */
function _debug_resetMoodEngine() {
  _singleton = null;
  return getMoodEngine();
}

module.exports = { MoodEngine, getMoodEngine, _debug_resetMoodEngine };
