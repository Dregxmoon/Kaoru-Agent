// @ts-check
'use strict';

/**
 * Logger centralizado — niveles, timestamps, scope y transporte opcional a
 * archivo con rotación.
 *
 * Objetivo: reemplazar de forma incremental los `console.*` dispersos por el
 * pipeline por una vía única, silenciable y persistible. API mínima:
 *
 *   const log = require('../observability/Logger.js');
 *   log.info('core', 'arrancando', { pid: process.pid });
 *   const sub = log.scope('planner');      // prefija automáticamente el scope
 *   sub.warn('plan sin pasos');
 *
 * Niveles (de menor a mayor severidad): debug < info < warn < error.
 * Por defecto `info`; `setLevel('debug')` activa verbose, `setQuiet(true)`
 * silencia todo salvo errores.
 *
 * Transporte a archivo: `log.attachFile(ruta, maxBytes?)`. Cuando el archivo
 * supera `maxBytes` se rota a `<ruta>.1` (se sobreescribe). No se bloquea
 * nada crítico: un fallo de escritura solo se reporta una vez.
 */

const fs = require('fs');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
/** @type {Record<number, string>} */
const LEVEL_NAMES = { 10: 'DEBUG', 20: 'INFO', 30: 'WARN', 40: 'ERROR' };

class Logger {
  /**
   * @param {object} [opts]
   * @param {number} [opts.level]
   * @param {boolean} [opts.quiet]
   */
  constructor(opts = {}) {
    this._level = opts.level ?? LEVELS.info;
    this._quiet = opts.quiet === true;
    /** @type {{ filePath: string, maxBytes: number } | null} */
    this._file = null;
    this._fileWarned = false;
    /** @type {string | undefined} */
    this._scope = undefined;
  }

  /**
   * @param {number} level
   */
  setLevel(level) {
    this._level = level;
  }

  /**
   * @param {boolean} quiet
   */
  setQuiet(quiet) {
    this._quiet = quiet;
  }

  /**
   * Adjunta un transporte a archivo (append) con rotación best-effort.
   * @param {string} filePath
   * @param {number} [maxBytes]
   */
  attachFile(filePath, maxBytes = 5 * 1024 * 1024) {
    this._file = { filePath, maxBytes };
  }

  detachFile() {
    this._file = null;
  }

  /**
   * Devuelve un logger con scope fijo.
   * @param {string} scope
   * @returns {Logger}
   */
  scope(scope) {
    const child = new Logger({ level: this._level, quiet: this._quiet });
    child._file = this._file;
    child._scope = scope;
    return child;
  }

  /**
   * @param {number} level
   * @param {string} scope
   * @param {string} msg
   * @param {unknown[]} args
   */
  _write(level, scope, msg, args) {
    if (this._quiet && level < LEVELS.warn) return;
    if (level < this._level) return;

    const now = new Date();
    const ts = now.toISOString();
    const levelName = LEVEL_NAMES[level] || 'INFO';
    const scoped = this._scope ? `${this._scope}/${scope}` : scope;
    const line = `[${ts}] [${levelName}] [${scoped}] ${msg}`;

    if (this._file) {
      try {
        const extra = args.length > 0 ? ' ' + args.map((a) => _stringify(a)).join(' ') : '';
        fs.appendFileSync(this._file.filePath, line + extra + '\n', 'utf-8');
        if (fs.statSync(this._file.filePath).size > this._file.maxBytes) {
          fs.renameSync(this._file.filePath, this._file.filePath + '.1');
        }
      } catch (e) {
        if (!this._fileWarned) {
          this._fileWarned = true;
          const m = e instanceof Error ? e.message : String(e);
          console.error(`[logger] no se pudo escribir ${this._file.filePath}: ${m}`);
        }
      }
    }

    const toConsole =
      level >= LEVELS.warn ? console.error : level === LEVELS.debug ? console.debug : console.log;
    const extra = args.length > 0 ? ' ' + args.map((a) => _stringify(a)).join(' ') : '';
    toConsole(line + extra);
  }

  /** @param {string} scope @param {string} msg @param {unknown[]} args */
  debug(scope, msg, ...args) {
    this._write(LEVELS.debug, scope, msg, args);
  }
  /** @param {string} scope @param {string} msg @param {unknown[]} args */
  info(scope, msg, ...args) {
    this._write(LEVELS.info, scope, msg, args);
  }
  /** @param {string} scope @param {string} msg @param {unknown[]} args */
  warn(scope, msg, ...args) {
    this._write(LEVELS.warn, scope, msg, args);
  }
  /** @param {string} scope @param {string} msg @param {unknown[]} args */
  error(scope, msg, ...args) {
    this._write(LEVELS.error, scope, msg, args);
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function _stringify(value) {
  if (typeof value === 'string') return value;
  try {
    const s = JSON.stringify(value);
    return s === undefined ? String(value) : s;
  } catch (_) {
    return String(value);
  }
}

// Singleton por defecto — los módulos comparten una única instancia.
const defaultLogger = new Logger();
module.exports = defaultLogger;
/** @type {any} */ (module.exports).Logger = Logger;
/** @type {any} */ (module.exports).LEVELS = LEVELS;
