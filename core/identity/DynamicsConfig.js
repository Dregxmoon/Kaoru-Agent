// @ts-check
/**
 * DynamicsConfig.js — loader de `core/identity/identity.dynamics.json`.
 *
 * `identity.json` es "quién es Kaoru" (edición rara, alto cuidado); este
 * archivo es "cómo reacciona" (umbrales de histéresis, plantillas por
 * mood/relación) y se puede tunear sin tocar código. Mismo patrón que
 * IdentityStore: cache + fallback, nunca lanza.
 */

'use strict';

const path = require('path');
const { readJsonFile } = require('../utils/fsUtils.js');

const DYNAMICS_PATH = path.join(__dirname, 'identity.dynamics.json');

/**
 * Forma de la config dinámica (identity.dynamics.json). Los consumidores la
 * importan con `@typedef {import('./DynamicsConfig.js').DynamicsConfigShape}`
 * para acceder a sus campos sin que tsc los trate como `object`.
 * @typedef {{
 *   mood_engine?: {
 *     enabled?: boolean,
 *     window_ms?: number,
 *     hold_turns?: number,
 *     post_error?: { mood?: string, intensity?: number },
 *     notes?: Record<string, string[]>,
 *   },
 * }} DynamicsConfigShape
 */

/** @type {object | null} */
let _config = null;

/** @type {object} */
const FALLBACK = {
  mood_engine: {
    enabled: true,
    window_ms: 300000,
    hold_turns: 2,
    post_error: { mood: 'gentle', intensity: 0.6 },
    notes: {
      gentle: [
        "Acabo de equivocarme hace un momento. Sigo siendo yo: reconozco el error con la honestidad de siempre (tono 'was_wrong'), sin dramas ni disculpas exageradas, y sigo adelante.",
      ],
    },
  },
};

/**
 * Config dinámica de identidad (cacheada; nunca lanza).
 * @returns {DynamicsConfigShape}
 */
function getDynamicsConfig() {
  if (_config) return /** @type {DynamicsConfigShape} */ (_config);
  _config = readJsonFile(DYNAMICS_PATH, FALLBACK);
  return /** @type {DynamicsConfigShape} */ (_config);
}

/**
 * Seam de test: invalida la cache y devuelve la config recargada.
 * @returns {object}
 */
function _debug_resetDynamicsConfig() {
  _config = null;
  return getDynamicsConfig();
}

/**
 * Seam de test: sobreescribe la config en memoria (para casos disabled, etc.).
 * @param {object | null} config
 * @returns {void}
 */
function _debug_setDynamicsConfig(config) {
  _config = config;
}

module.exports = {
  getDynamicsConfig,
  DYNAMICS_PATH,
  _debug_resetDynamicsConfig,
  _debug_setDynamicsConfig,
};
