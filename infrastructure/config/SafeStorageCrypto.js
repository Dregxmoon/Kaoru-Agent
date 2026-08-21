'use strict';

/**
 * SafeStorageCrypto — cifrado de API keys vía electron.safeStorage.
 *
 * Cuando KeychainManager no está disponible (Linux sin libsecret, macOS sin
 * Keychain acceso, etc.), las API keys quedan en config.json en texto plano.
 * Este módulo ofrece una capa intermedia: cifrar con safeStorage antes de
 * guardar, descifrar al leer. safeStorage usa el keyring del SO por debajo
 * (DPAPI en Windows, Keychain en macOS, libsecret/kwallet en Linux) — es
 * mejor que texto plano y no agrega dependencias nuevas.
 *
 * Formato en config.json: "enc:v1:<base64>"
 * Compatibilidad: keys sin prefijo se leen como texto plano (versión anterior).
 */

const ENC_PREFIX = 'enc:v1:';

let _safeStorage = null;
try {
  _safeStorage = require('electron').safeStorage;
} catch {
  // Fuera de Electron (tests, CLI) — safeStorage no disponible.
}

/**
 * @returns {boolean} true si safeStorage está disponible y puede cifrar.
 */
function isAvailable() {
  if (!_safeStorage) return false;
  try {
    return typeof _safeStorage.isEncryptionAvailable === 'function'
      && _safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/**
 * Cifra un string con safeStorage.
 * @param {string} plaintext
 * @returns {string} "enc:v1:<base64>" o el texto original si safeStorage no está disponible.
 */
function encrypt(plaintext) {
  if (!plaintext) return plaintext;
  if (!isAvailable()) return plaintext;
  try {
    const buf = _safeStorage.encryptString(plaintext);
    return ENC_PREFIX + buf.toString('base64');
  } catch {
    return plaintext;
  }
}

/**
 * Descifra un valor que fue cifrado con encrypt().
 * @param {string} value puede ser "enc:v1:<base64>" (cifrado) o texto plano (legacy).
 * @returns {string} texto descifrado.
 */
function decrypt(value) {
  if (!value || typeof value !== 'string') return value;
  if (!value.startsWith(ENC_PREFIX)) return value; // compat: texto plano legacy
  if (!isAvailable()) return value; // no se puede descifrar
  try {
    const b64 = value.slice(ENC_PREFIX.length);
    const buf = Buffer.from(b64, 'base64');
    return _safeStorage.decryptString(buf);
  } catch {
    return value;
  }
}

/**
 * Procesa un mapa de API keys: cifra las que estén en texto plano,
 * preserva las ya cifradas.
 * @param {Record<string, string>} apiKeys
 * @returns {Record<string, string>} mapa con keys cifradas.
 */
function encryptAllKeys(apiKeys) {
  if (!apiKeys || typeof apiKeys !== 'object') return apiKeys || {};
  const result = {};
  for (const [k, v] of Object.entries(apiKeys)) {
    if (v && typeof v === 'string' && !v.startsWith(ENC_PREFIX)) {
      result[k] = encrypt(v);
    } else {
      result[k] = v;
    }
  }
  return result;
}

/**
 * Procesa un mapa de API keys: descifra las que tengan el prefijo.
 * @param {Record<string, string>} apiKeys
 * @returns {Record<string, string>} mapa con keys en texto plano.
 */
function decryptAllKeys(apiKeys) {
  if (!apiKeys || typeof apiKeys !== 'object') return apiKeys || {};
  const result = {};
  for (const [k, v] of Object.entries(apiKeys)) {
    result[k] = decrypt(v);
  }
  return result;
}

module.exports = {
  isAvailable,
  encrypt,
  decrypt,
  encryptAllKeys,
  decryptAllKeys,
  ENC_PREFIX,
  // Para tests: permitir inyectar un safeStorage falso.
  _setSafeStorage(ss) { _safeStorage = ss; },
};
