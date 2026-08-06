// @ts-check
'use strict';

/**
 * PermissionManager — permisos granulares allow/ask/deny por herramienta y
 * carpeta (patrón opencode), persistidos en un archivo JSON local.
 *
 * Cada regla es { id, tool, path, action }:
 *   - tool:   nombre de la herramienta ('exec', 'write', 'git_commit', ...)
 *             o '*' para todas.
 *   - path:   prefijo de ruta (directorio) al que aplica, o ''/null para todas.
 *   - action: 'allow' | 'ask' | 'deny'
 *
 * Resolución por especificidad (la regla más específica gana):
 *   1. tool exacto + path que sea prefijo de la ruta en cuestión.
 *   2. tool exacto + path vacío.
 *   3. tool '*' + path que sea prefijo.
 *   4. tool '*' + path vacío.
 *   5. default (el que el llamador decida: por defecto 'ask' para alto impacto).
 *
 * Nunca rompe el arranque: si el archivo no existe o está corrupto, arranca
 * vacío y las escrituras fallan silenciosamente (best-effort).
 */

const fs = require('fs');
const path = require('path');

/** @typedef {'allow'|'ask'|'deny'} PermissionAction */

/**
 * @typedef {object} PermissionRule
 * @property {string} id
 * @property {string} tool
 * @property {string} path
 * @property {PermissionAction} action
 */

const VALID_ACTIONS = new Set(['allow', 'ask', 'deny']);

class PermissionManager {
  /**
   * @param {object} opts
   * @param {string|null} [opts.filePath] - ruta del JSON de persistencia.
   *   null = solo memoria (tests).
   * @param {PermissionAction} [opts.defaultAction] - acción por defecto para
   *   herramientas sin regla. El llamador decide según highImpact.
   */
  constructor({ filePath = null, defaultAction = 'ask' } = {}) {
    /** @type {Array<PermissionRule>} */
    this._rules = [];
    this._filePath = filePath;
    this._defaultAction = defaultAction;
    this._load();
  }

  _load() {
    if (!this._filePath || !fs.existsSync(this._filePath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this._filePath, 'utf-8'));
      if (Array.isArray(raw.rules)) {
        this._rules = /** @type {Array<PermissionRule>} */ (raw.rules).filter(
          /** @param {PermissionRule} r */
          (r) =>
            r &&
            typeof r.action === 'string' &&
            VALID_ACTIONS.has(r.action) &&
            typeof r.tool === 'string'
        );
      }
    } catch (_) {
      this._rules = [];
    }
  }

  _save() {
    if (!this._filePath) return;
    try {
      fs.mkdirSync(path.dirname(this._filePath), { recursive: true });
      fs.writeFileSync(this._filePath, JSON.stringify({ rules: this._rules }, null, 2), 'utf-8');
    } catch (_) {
      /* best-effort */
    }
  }

  /**
   * Añade o reemplaza una regla. tool '*', path '' → global.
   * @param {object} input
   * @param {string} [input.tool]
   * @param {string} [input.path]
   * @param {PermissionAction} input.action
   * @returns {PermissionRule}
   */
  setRule({ tool = '*', path: rulePath = '', action }) {
    if (!VALID_ACTIONS.has(action)) {
      throw new Error(`Acción de permiso inválida: ${action}`);
    }
    const id = `${tool}:${rulePath || ''}`;
    const idx = this._rules.findIndex((r) => r.id === id);
    const rule = /** @type {PermissionRule} */ ({ id, tool, path: rulePath || '', action });
    if (idx >= 0) this._rules[idx] = rule;
    else this._rules.push(rule);
    this._save();
    return rule;
  }

  /**
   * @param {object} input
   * @param {string} [input.tool]
   * @param {string} [input.path]
   * @returns {boolean} true si se eliminó una regla
   */
  removeRule({ tool = '*', path: rulePath = '' }) {
    const id = `${tool}:${rulePath || ''}`;
    const before = this._rules.length;
    this._rules = this._rules.filter((r) => r.id !== id);
    if (this._rules.length !== before) {
      this._save();
      return true;
    }
    return false;
  }

  /** @returns {Array<PermissionRule>} */
  list() {
    return this._rules.map((r) => ({ ...r }));
  }

  /**
   * Resuelve la acción para una (tool, path) según la regla más específica.
   * @param {object} input
   * @param {string} input.tool
   * @param {string} [input.path]
   * @param {PermissionAction} [input.defaultAction] - fallback si no hay regla
   * @returns {{ action: PermissionAction, rule: PermissionRule|null }}
   */
  check({ tool, path: targetPath = '', defaultAction = this._defaultAction }) {
    const t = tool || '';
    const tp = targetPath ? path.resolve(targetPath) : '';

    /** @param {string} rulePath */
    const matches = (rulePath) => {
      if (!rulePath) return true; // regla global
      if (!tp) return false; // no hay path objetivo, regla de path no aplica
      return tp === rulePath || tp.startsWith(rulePath.endsWith('/') ? rulePath : rulePath + '/');
    };

    const candidates = this._rules.filter(
      /** @param {PermissionRule} r */
      (r) => (r.tool === t || r.tool === '*') && matches(r.path)
    );

    // Ordenar por especificidad: tool exacto antes que '*', path más largo primero.
    candidates.sort((a, b) => {
      /** @param {string} tool */
      const toolRank = (tool) => (tool === t ? 2 : 1);
      const aR = toolRank(a.tool) * 1000 + (a.path ? a.path.length : 0);
      const bR = toolRank(b.tool) * 1000 + (b.path ? b.path.length : 0);
      return bR - aR;
    });

    const rule = candidates[0] || null;
    return { action: rule ? rule.action : defaultAction, rule };
  }

  /** @returns {PermissionAction} */
  get defaultAction() {
    return this._defaultAction;
  }

  /** @param {PermissionAction} action */
  setDefaultAction(action) {
    if (VALID_ACTIONS.has(action)) this._defaultAction = action;
  }
}

module.exports = { PermissionManager };
