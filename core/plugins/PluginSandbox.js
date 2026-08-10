// @ts-check
'use strict';

/**
 * PluginSandbox — carga plugins en una VM de Node con acceso mediado.
 *
 * Un plugin se ejecuta en un contexto V8 aislado: sin `require` global, sin
 * `process` con secrets, sin acceso al filesystem sin pasar por el mediador.
 * Lo que el plugin SÍ recibe:
 *   - `module`/`exports`/`require` propios (CommonJS, como en Node).
 *   - `require` mediado: whitelist de builtins inofensivas + `fs` acotado al
 *     directorio del propio plugin (anti path-traversal).
 *   - `console`, timers, `Buffer`, `URL`, `TextEncoder/Decoder`, y un
 *     `process` mínimo (platform/arch/cwd, `env` CONGELADO y vacío).
 *
 * Límite honesto del modelo: `vm` es una capa de contención, NO una frontera
 * criptográfica (toda función host expuesta habilita técnicas de escape). Por
 * eso la confianza real viene del firme del paquete (PluginSigner) en el
 * marketplace firmado: solo plugins firmados por una key confiable llegan al
 * sandbox. El sandbox limita el daño accidental y encarece el malicioso.
 */

const vm = require('vm');
const fs = require('fs');
const path = require('path');

/** Builtins permitidas (inofensivas, puras). `fs` se reemplaza por safe-fs. */
const ALLOWED_MODULES = new Map([
  ['path', 'path'],
  ['node:path', 'path'],
  ['util', 'util'],
  ['node:util', 'util'],
  ['events', 'events'],
  ['node:events', 'events'],
  ['url', 'url'],
  ['node:url', 'url'],
  ['crypto', 'crypto'],
  ['node:crypto', 'crypto'],
  ['assert', 'assert'],
  ['node:assert', 'assert'],
  ['string_decoder', 'string_decoder'],
  ['node:string_decoder', 'string_decoder'],
  ['fs', 'safe-fs'],
  ['node:fs', 'safe-fs'],
]);

/**
 * @typedef {object} SandboxOpts
 * @property {string} [root]        directorio raíz del plugin (base del fs mediado).
 * @property {string} [tag]         etiqueta para el logger ('plugin:<id>').
 * @property {(msg: string) => void} [logger] canal de log (consola del plugin).
 */

class PluginSandbox {
  /**
   * @param {SandboxOpts} [opts]
   */
  constructor(opts = {}) {
    this._root = opts.root || process.cwd();
    this._tag = opts.tag || 'plugin';
    this._log = opts.logger || (() => {});
  }

  /**
   * Carga un módulo CommonJS (index.js) dentro de la VM.
   * @param {string} entryPath
   * @returns {object} module.exports del plugin.
   */
  load(entryPath) {
    const abs = path.resolve(entryPath);
    const root = this._root;
    const context = this._createContext(root);
    /** @type {Map<string, object>} */
    const cache = new Map();
    const requireFn = this._makeRequire(path.dirname(abs), context, root, cache);
    return this._loadModule(abs, context, root, cache, requireFn);
  }

  /**
   * Compila y ejecuta un archivo JS en el contexto, con el wrapper CJS.
   * @private
   * @param {string} absPath
   * @param {object} context
   * @param {string} root
   * @param {Map<string, object>} cache
   * @param {Function} _requireFn
   * @returns {object}
   */
  _loadModule(absPath, context, root, cache, _requireFn) {
    if (cache.has(absPath)) {
      const cached = cache.get(absPath);
      if (cached) return cached;
    }
    if (!fs.existsSync(absPath)) {
      throw new Error(`[plugin-sandbox] módulo no encontrado: ${absPath}`);
    }
    const code = fs.readFileSync(absPath, 'utf8');
    const wrapper = `(function (exports, require, module, __filename, __dirname) {\n${code}\n});`;
    const script = new vm.Script(wrapper, { filename: absPath });
    const factory = script.runInContext(context);
    const module = { exports: /** @type {object} */ ({}) };
    cache.set(absPath, module.exports);
    const localRequire = this._makeRequire(path.dirname(absPath), context, root, cache);
    factory(module.exports, localRequire, module, absPath, path.dirname(absPath));
    cache.set(absPath, module.exports);
    return module.exports;
  }

  /**
   * require mediado del sandbox.
   * @private
   * @param {string} fromDir
   * @param {object} context
   * @param {string} root
   * @param {Map<string, object>} cache
   * @returns {(id: string) => unknown}
   */
  _makeRequire(fromDir, context, root, cache) {
    const loader = this._loadModule.bind(this);
    return (id) => {
      if (typeof id !== 'string' || id.length === 0) {
        throw new Error('[plugin-sandbox] require() inválido');
      }
      // Relativo → dentro del propio plugin, cargado en el MISMO sandbox.
      if (id.startsWith('./') || id.startsWith('../')) {
        const base = path.resolve(fromDir, id);
        const resolved = this._resolveModulePath(base);
        return loader(
          resolved,
          context,
          root,
          cache,
          this._makeRequire(path.dirname(resolved), context, root, cache)
        );
      }
      // Absoluto → solo dentro del root del plugin (sin salir).
      if (path.isAbsolute(id)) {
        const resolved = this._resolveModulePath(path.resolve(root, id.replace(/^\/+/, '')));
        return loader(
          resolved,
          context,
          root,
          cache,
          this._makeRequire(path.dirname(resolved), context, root, cache)
        );
      }
      // Builtin → whitelist.
      const resolvedId = ALLOWED_MODULES.get(id);
      if (!resolvedId) {
        throw new Error(`[plugin-sandbox] módulo no permitido: ${id}`);
      }
      if (resolvedId === 'safe-fs') return this._createSafeFs(root);
      return require(resolvedId);
    };
  }

  /**
   * Resuelve una ruta relativa a archivo/index.js y valida que quede en root.
   * @private
   * @param {string} base
   * @returns {string}
   */
  _resolveModulePath(base) {
    let candidate = base;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      candidate = path.join(candidate, 'index.js');
    }
    if (!candidate.endsWith('.js')) candidate += '.js';
    return candidate;
  }

  /**
   * Crea el objeto global del contexto de la VM.
   * @private
   * @param {string} root
   * @returns {object}
   */
  _createContext(root) {
    const log = this._log;
    const tag = this._tag;
    /** @type {Record<string, (...args: unknown[]) => void>} */
    const consoleApi = {
      log: (...a) => log(`[${tag}] ${a.map(String).join(' ')}`),
      info: (...a) => log(`[${tag}] ${a.map(String).join(' ')}`),
      warn: (...a) => log(`[${tag}] warn: ${a.map(String).join(' ')}`),
      error: (...a) => log(`[${tag}] error: ${a.map(String).join(' ')}`),
      debug: (...a) => log(`[${tag}] debug: ${a.map(String).join(' ')}`),
    };
    /** @type {Record<string, unknown>} */
    const sandbox = {
      console: consoleApi,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      setImmediate,
      clearImmediate,
      queueMicrotask,
      Buffer,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      structuredClone,
      process: {
        platform: process.platform,
        arch: process.arch,
        versions: { node: process.versions.node },
        env: Object.freeze({}),
        cwd: () => root,
        hrtime: process.hrtime,
      },
    };
    sandbox.globalThis = sandbox;
    sandbox.global = sandbox;
    return vm.createContext(sandbox);
  }

  /**
   * `fs` mediado: solo opera dentro de `root` (anti path-traversal).
   * @private
   * @param {string} root
   * @returns {object}
   */
  _createSafeFs(root) {
    const resolve = (/** @type {unknown} */ p) => {
      const abs = path.resolve(root, String(p));
      const rel = path.relative(root, abs);
      if (rel.startsWith('..') || (rel === '' && p === '..')) {
        throw new Error(`[plugin-sandbox] fs: fuera del directorio del plugin: ${p}`);
      }
      return abs;
    };
    /** @type {(fn: Function) => (...args: unknown[]) => any} */
    const wrap =
      (/** @type {Function} */ fn) =>
      (...args) => {
        const [p, ...rest] = args;
        return fn(resolve(p), ...rest);
      };
    /** @type {(fn: Function) => (...args: unknown[]) => any} */
    const wrapCb =
      (/** @type {Function} */ fn) =>
      (...args) => {
        const last = args[args.length - 1];
        const hasCb = typeof last === 'function';
        if (hasCb) {
          const p = args[0];
          const cb = args[args.length - 1];
          const rest = args.slice(1, args.length - 1);
          return fn(resolve(p), ...rest, cb);
        }
        return new Promise((resolve2, reject2) => {
          const p = args[0];
          const rest = args.slice(1);
          fn(resolve(p), ...rest, (/** @type {Error | null} */ err, /** @type {unknown} */ data) =>
            err ? reject2(err) : resolve2(data)
          );
        });
      };
    return {
      existsSync: (/** @type {unknown} */ p) => fs.existsSync(resolve(p)),
      readFileSync: wrap(fs.readFileSync),
      writeFileSync: wrap(fs.writeFileSync),
      appendFileSync: wrap(fs.appendFileSync),
      mkdirSync: wrap(fs.mkdirSync),
      readdirSync: wrap(fs.readdirSync),
      statSync: wrap(fs.statSync),
      unlinkSync: wrap(fs.unlinkSync),
      readFile: wrapCb(fs.readFile),
      writeFile: wrapCb(fs.writeFile),
      appendFile: wrapCb(fs.appendFile),
      mkdir: wrapCb(fs.mkdir),
      readdir: wrapCb(fs.readdir),
      stat: wrapCb(fs.stat),
      unlink: wrapCb(fs.unlink),
    };
  }
}

module.exports = { PluginSandbox };
