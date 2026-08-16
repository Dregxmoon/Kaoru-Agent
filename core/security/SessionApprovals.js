// @ts-check
'use strict';

const path = require('path');

// ── Aprobaciones "Siempre" de sesión (estilo opencode once/always/reject) ────
// El botón "Siempre" del card de aprobación registra un patrón aquí; mientras
// la sesión viva, cualquier action que matchee el patrón se auto-aprueba sin
// volver a mostrar el card. Se limpia al cerrar la ventana de chat
// (resetApprovals).

const _sessionApprovals = new Set();

/**
 * @typedef {object} ApprovalAction
 * @property {string} tool
 * @property {object} [params]
 * @property {string} [params.command]
 * @property {string} [params.path]
 * @property {string} [params.filePath]
 * @property {object} [params.args]
 * @property {string} [params.args.path]
 * @property {string} [params.server]
 * @property {string} [params.tool]
 */

/**
 * Patrón de sesión para un action. Intenta ser lo más acotado posible:
 *  - mcp  → "mcp:<server>:<tool>" (p.ej. mcp:filesystem:write_file)
 *  - exec → prefijo del comando (2 primeros tokens, p.ej. "exec:git status")
 *  - path → "path:<directorio>" para tools con path (read/write/edit...)
 *  - resto → "tool:<tool>"
 * @param {ApprovalAction|null|undefined} action
 * @returns {string|null}
 */
function approvalPattern(action) {
  if (!action) return null;
  const tool = action.tool;
  const params = action.params || {};
  if (tool === 'mcp' && params.server && params.tool) {
    return `mcp:${params.server}:${params.tool}`;
  }
  if (tool === 'exec' && typeof params.command === 'string' && params.command.trim()) {
    return `exec:${params.command.trim().split(/\s+/).slice(0, 2).join(' ')}`;
  }
  const p = params.path || params.filePath || (params.args && params.args.path);
  if (typeof p === 'string' && p.trim()) {
    try {
      return `path:${path.dirname(p)}`;
    } catch (_) {
      return `tool:${tool}`;
    }
  }
  return `tool:${tool}`;
}

/** @param {string|null} pattern */
function isApproved(pattern) {
  return Boolean(pattern) && _sessionApprovals.has(pattern);
}

/** @param {string|null} pattern */
function addApproval(pattern) {
  if (pattern) _sessionApprovals.add(pattern);
}

function resetApprovals() {
  _sessionApprovals.clear();
}

module.exports = { approvalPattern, isApproved, addApproval, resetApprovals };
