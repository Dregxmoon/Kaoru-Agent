/**
 * IdentityStore.js — loader único de la identidad del asistente.
 *
 * Centraliza la lectura de `core/identity/identity.json` que antes estaba
 * duplicada en 4 sitios (GroqSerializer, ContextAssembler, GroundingEngine,
 * GroundingMinimo): todos hacían el mismo JSON.parse con cache + fallback.
 *
 *   - getIdentity(): lectura cacheada, nunca lanza (fallback al perfil
 *     mínimo si el archivo no existe o no parsea).
 *   - setIdentityOverride(): override en runtime (editar la personalidad sin
 *     reiniciar). Invalida la cache; los consumidores que cachean versiones
 *     derivadas (ej. la sección serializada) se encargan de invalidar la suya.
 */

'use strict';

const path = require('path');
const { readJsonFile } = require('../utils/fsUtils.js');

const IDENTITY_PATH = path.join(__dirname, 'identity.json');

/** @type {object | null} */
let _identity = null;

/** @type {object} */
const FALLBACK = { name: 'asistente', core: 'Soy tu asistente personal.' };

/**
 * Identidad completa (objeto raw del JSON). Cacheada; nunca lanza.
 * @returns {object}
 */
function getIdentity() {
  if (_identity) return _identity;
  _identity = readJsonFile(IDENTITY_PATH, FALLBACK);
  return _identity;
}

/**
 * Override de identidad en runtime (editar la personalidad sin reiniciar).
 * @param {object} identity - Objeto de identidad nuevo (o raw del JSON).
 * @returns {boolean} true si el override se aplicó.
 */
function setIdentityOverride(identity) {
  if (!identity || typeof identity !== 'object') return false;
  _identity = identity;
  return true;
}

module.exports = { getIdentity, setIdentityOverride, IDENTITY_PATH };
