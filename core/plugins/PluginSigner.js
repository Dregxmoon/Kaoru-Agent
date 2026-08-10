// @ts-check
'use strict';

/**
 * PluginSigner — firma y verificación de paquetes de plugin con Ed25519.
 *
 * Un paquete de plugin es una carpeta (`plugin.json` + `index.js` + helpers).
 * La firma cubre: el manifest (sin el campo `signature`) + el hash sha256 de
 * TODOS los archivos del paquete (excepto `plugin.json`). Así, tocar cualquier
 * archivo del plugin o cualquier campo del manifest invalida la firma.
 *
 * Uso:
 *   const { generateKeyPair, signPlugin, verifyPlugin } = require('./PluginSigner.js');
 *   const { publicKey, privateKey } = generateKeyPair();
 *   signPlugin(pluginDir, privateKey);
 *   verifyPlugin(pluginDir, publicKey); // → { ok: true }
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SIGNATURE_FIELD = 'signature';
const ALGORITHM = 'ed25519';

/**
 * Genera un par de llaves Ed25519 en PEM.
 * @returns {{ publicKey: string, privateKey: string }}
 */
function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

/**
 * Lista todos los archivos de la carpeta (recursivo), con su sha256 en hex.
 * Excluye `plugin.json` (su hash depende del propio campo firma) y metadatos.
 * @param {string} dir
 * @returns {Record<string, string>}
 */
function collectFileHashes(dir) {
  /** @type {Record<string, string>} */
  const files = {};
  const walk = (/** @type {string} */ rel) => {
    const abs = path.join(dir, rel);
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const relPath = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        walk(relPath);
      } else if (relPath !== 'plugin.json') {
        files[relPath] = crypto
          .createHash('sha256')
          .update(fs.readFileSync(path.join(dir, relPath)))
          .digest('hex');
      }
    }
  };
  walk('');
  return files;
}

/**
 * Construye el descriptor canónico que se firma/verifica.
 * @param {string} pluginDir
 * @returns {object}
 */
function buildDescriptor(pluginDir) {
  const manifestPath = path.join(pluginDir, 'plugin.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`[signer] no existe plugin.json en ${pluginDir}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const { [SIGNATURE_FIELD]: _omit, ...manifestCore } = manifest;
  return {
    manifest: manifestCore,
    files: collectFileHashes(pluginDir),
  };
}

/**
 * Firma un paquete: escribe `plugin.json.signature` dentro del manifest.
 * @param {string} pluginDir
 * @param {string} privateKeyPem
 * @param {string} [signedBy]
 * @returns {{ algorithm: string, value: string, signedBy: string }}
 */
function signPlugin(pluginDir, privateKeyPem, signedBy = 'plugin-signer') {
  const descriptor = buildDescriptor(pluginDir);
  const value = crypto
    .sign(null, Buffer.from(JSON.stringify(descriptor)), privateKeyPem)
    .toString('base64');
  const manifestPath = path.join(pluginDir, 'plugin.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest[SIGNATURE_FIELD] = { algorithm: ALGORITHM, value, signedBy };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return { algorithm: ALGORITHM, value, signedBy };
}

/**
 * Verifica la firma de un paquete contra una llave pública.
 * @param {string} pluginDir
 * @param {string} publicKeyPem
 * @returns {{ ok: boolean, reason: string }}
 */
function verifyPlugin(pluginDir, publicKeyPem) {
  const manifestPath = path.join(pluginDir, 'plugin.json');
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, reason: 'no existe plugin.json' };
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    return { ok: false, reason: 'plugin.json no es JSON válido' };
  }
  const sig = manifest[SIGNATURE_FIELD];
  if (!sig || typeof sig.value !== 'string') {
    return { ok: false, reason: 'plugin sin firma (signature)' };
  }
  if (sig.algorithm && sig.algorithm !== ALGORITHM) {
    return { ok: false, reason: `algoritmo de firma inesperado: ${sig.algorithm}` };
  }
  try {
    const descriptor = buildDescriptor(pluginDir);
    const valid = crypto.verify(
      null,
      Buffer.from(JSON.stringify(descriptor)),
      publicKeyPem,
      Buffer.from(sig.value, 'base64')
    );
    return valid
      ? { ok: true, reason: 'firma válida' }
      : { ok: false, reason: 'firma inválida o contenido modificado' };
  } catch (e) {
    return {
      ok: false,
      reason: `verificación falló: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

module.exports = { generateKeyPair, signPlugin, verifyPlugin, buildDescriptor, ALGORITHM };
