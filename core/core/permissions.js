// permissions.js — reglas granulares de permisos (allow/ask/deny, patrón
// opencode) expuestas a la UI y al Control API.

const state = require('./state.js');

// ── Permisos granulares (allow/ask/deny) ─────────────────────────────────────

/**
 * @param {object} rule
 * @param {string} [rule.tool]
 * @param {string} [rule.path]
 * @param {string} rule.action - 'allow' | 'ask' | 'deny'
 */
function permissionsSetRule(rule) {
  if (!state.permissionManager) return { ok: false, error: 'permission manager no disponible' };
  try {
    const saved = state.permissionManager.setRule(rule);
    return { ok: true, rule: saved, list: state.permissionManager.list() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * @param {object} rule
 * @param {string} [rule.tool]
 * @param {string} [rule.path]
 */
function permissionsRemoveRule(rule) {
  if (!state.permissionManager) return { ok: false, error: 'permission manager no disponible' };
  const removed = state.permissionManager.removeRule(rule);
  return { ok: true, removed, list: state.permissionManager.list() };
}

function permissionsList() {
  if (!state.permissionManager) return [];
  return state.permissionManager.list();
}

module.exports = {
  permissionsSetRule,
  permissionsRemoveRule,
  permissionsList,
};
