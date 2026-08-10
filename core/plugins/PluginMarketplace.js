// @ts-check
'use strict';

/**
 * PluginMarketplace — marketplace local firmado de plugins.
 *
 * Estructura del directorio del marketplace:
 *   marketplace/
 *     key.pub        → llave pública Ed25519 de confianza (PEM, opcional si se
 *                      pasa `publicKey` por config)
 *     index.json     → { generated, plugins: [{ id, name, version, description,
 *                      sha256, path }] }
 *     index.sig      → firma Ed25519 (base64) del JSON canónico de index.json
 *     packages/<id>/ → paquete del plugin (plugin.json firmado + index.js + …)
 *
 * Garantías:
 *   - `index.json` debe estar firmado por la key de confianza (un índice
 *     adulterado o firmado por otra key se rechaza).
 *   - Cada paquete debe estar firmado por la misma key (PluginSigner) y su
 *     sha256 debe coincidir con el del índice.
 *   - `install()` copia el paquete a `plugins/` y el PluginManager lo vuelve a
 *     verificar al cargar (defensa en profundidad).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { verifyPlugin } = require('./PluginSigner.js');

/** @typedef {{ id: string, name: string, version: string, description: string, sha256: string, path: string }} MarketplaceEntry */

class PluginMarketplace {
  /**
   * @param {object} [opts]
   * @param {string} [opts.marketplaceDir]
   * @param {string} [opts.publicKey]  llave pública PEM (si no está key.pub)
   */
  constructor(opts = {}) {
    this._dir = opts.marketplaceDir || DEFAULT_DIR;
    this._publicKey = opts.publicKey || this._readKeyFile(path.join(this._dir, 'key.pub'));
  }

  /** @returns {string|null} la llave pública configurada, o null */
  getPublicKey() {
    return this._publicKey || null;
  }

  /**
   * Lee la key pública desde un archivo PEM (si existe).
   * @private
   * @param {string} keyPath
   * @returns {string|null}
   */
  _readKeyFile(keyPath) {
    try {
      if (fs.existsSync(keyPath)) return fs.readFileSync(keyPath, 'utf8');
    } catch (_) {}
    return null;
  }

  /**
   * Verifica la firma del índice contra la key de confianza.
   * @returns {{ ok: boolean, reason: string }}
   */
  verifyIndex() {
    if (!this._publicKey) {
      return {
        ok: false,
        reason: 'llave pública del marketplace no configurada (key.pub o opts.publicKey)',
      };
    }
    const indexPath = path.join(this._dir, 'index.json');
    const sigPath = path.join(this._dir, 'index.sig');
    if (!fs.existsSync(indexPath)) return { ok: false, reason: 'no existe index.json' };
    if (!fs.existsSync(sigPath)) return { ok: false, reason: 'no existe index.sig' };
    try {
      const payload = fs.readFileSync(indexPath, 'utf8');
      const sig = Buffer.from(fs.readFileSync(sigPath, 'utf8').trim(), 'base64');
      const valid = crypto.verify(null, Buffer.from(payload), this._publicKey, sig);
      return valid
        ? { ok: true, reason: 'índice firmado correctamente' }
        : { ok: false, reason: 'firma del índice inválida' };
    } catch (e) {
      return {
        ok: false,
        reason: `verificación del índice falló: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  /**
   * Lista los plugins publicados (con el índice verificado).
   * @returns {{ ok: boolean, plugins: MarketplaceEntry[], error?: string }}
   */
  list() {
    const v = this.verifyIndex();
    if (!v.ok) return { ok: false, plugins: [], error: v.reason };
    let index;
    try {
      index = JSON.parse(fs.readFileSync(path.join(this._dir, 'index.json'), 'utf8'));
    } catch (e) {
      return {
        ok: false,
        plugins: [],
        error: `index.json inválido: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    return { ok: true, plugins: Array.isArray(index.plugins) ? index.plugins : [] };
  }

  /**
   * Hash determinista de una carpeta: ruta + contenido de cada archivo.
   * @param {string} dir
   * @returns {string}
   */
  computePackageHash(dir) {
    const hash = crypto.createHash('sha256');
    const walk = (/** @type {string} */ rel) => {
      const abs = path.join(dir, rel);
      const entries = fs
        .readdirSync(abs, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const relPath = rel ? path.join(rel, entry.name) : entry.name;
        if (entry.isDirectory()) {
          walk(relPath);
        } else {
          hash.update(relPath.replace(/\\/g, '/'));
          hash.update('\x00');
          hash.update(fs.readFileSync(path.join(dir, relPath)));
          hash.update('\x00');
        }
      }
    };
    walk('');
    return hash.digest('hex');
  }

  /**
   * Verifica un paquete: índice firmado + hash coincidente + firma del plugin.
   * @param {string} id
   * @returns {{ ok: boolean, reason: string, entry?: MarketplaceEntry }}
   */
  verifyPackage(id) {
    const v = this.verifyIndex();
    if (!v.ok) return { ok: false, reason: v.reason };
    const { plugins } = this.list();
    const entry = plugins.find((p) => p.id === id);
    if (!entry) return { ok: false, reason: `plugin "${id}" no está publicado` };
    if (!this._publicKey) return { ok: false, reason: 'llave pública no configurada' };

    const pkgDir = path.join(this._dir, entry.path || path.join('packages', id));
    if (!fs.existsSync(path.join(pkgDir, 'plugin.json'))) {
      return { ok: false, reason: `paquete de "${id}" no existe en el marketplace` };
    }
    const actualHash = this.computePackageHash(pkgDir);
    if (actualHash !== entry.sha256) {
      return {
        ok: false,
        reason: `el paquete no coincide con el índice (sha256 ${actualHash} != ${entry.sha256})`,
      };
    }
    const sig = verifyPlugin(pkgDir, this._publicKey);
    if (!sig.ok) return { ok: false, reason: `firma del paquete inválida: ${sig.reason}` };
    return { ok: true, reason: 'paquete verificado', entry };
  }

  /**
   * Instala un plugin del marketplace en `plugins/`.
   * @param {string} id
   * @param {string} pluginsDir
   * @returns {{ ok: boolean, id?: string, error?: string, reason?: string }}
   */
  install(id, pluginsDir) {
    const v = this.verifyPackage(id);
    if (!v.ok) return { ok: false, error: v.reason };
    const entry = v.entry;
    if (!entry) return { ok: false, error: 'entrada de índice ausente' };

    const src = path.join(this._dir, entry.path || path.join('packages', id));
    const dest = path.join(pluginsDir, id);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    const copyDir = (/** @type {string} */ from, /** @type {string} */ to) => {
      for (const entry2 of fs.readdirSync(from, { withFileTypes: true })) {
        const s = path.join(from, entry2.name);
        const d = path.join(to, entry2.name);
        if (entry2.isDirectory()) {
          fs.mkdirSync(d, { recursive: true });
          copyDir(s, d);
        } else {
          fs.copyFileSync(s, d);
        }
      }
    };
    copyDir(src, dest);
    return { ok: true, id, reason: `instalado "${id}" en ${dest}` };
  }
}

const DEFAULT_DIR = path.join(__dirname, '..', '..', 'marketplace');

/** @typedef {InstanceType<typeof PluginMarketplace>} PluginMarketplaceInstance */

module.exports = { PluginMarketplace };
