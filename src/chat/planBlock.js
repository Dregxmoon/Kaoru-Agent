'use strict';

// @ts-check
/**
 * planBlock.js — HUD del plan explícito (plan-then-act) en el chat.
 *
 * AgentLoop genera un plan de pasos ANTES de ejecutar tareas complejas y lo
 * reenvía en vivo por el evento IPC 'agent-plan' (payload { kind, steps, done,
 * total }). Este módulo pinta un widget compacto con checkboxes que se tachan
 * a medida que el run completa pasos. Se inserta antes del ancla de actividad
 * (igual que los ActivityBlocks), así queda como panel persistente sobre el
 * feed de herramientas.
 */

/**
 * Paso de plan (texto o { description }).
 * @typedef {string | { description?: string; label?: string }} AgentPlanStep
 */

/**
 * Payload del evento agent-plan (tal cual lo emite AgentLoop).
 * @typedef {Object} AgentPlanPayload
 * @property {'created'|'progress'} kind
 * @property {AgentPlanStep[]} steps
 * @property {number} done
 * @property {number} total
 */

/** @type {HTMLDivElement | null} */
let _planEl = null; // el widget <div class="plan-block">
/** @type {Element | null} */
let _planAnchor = null; // ancla (bubble del asistente) — se inserta antes

/**
 * Marca el ancla donde se inserta el widget (junto al ancla de actividad).
 * @param {Element | null} anchor
 */
function setPlanAnchor(anchor) {
  _planAnchor = anchor;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function _escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Actualiza (o crea) el widget del plan con el payload recibido.
 * @param {AgentPlanPayload} payload
 */
function renderPlanBlock(payload) {
  if (!payload || !Array.isArray(payload.steps) || payload.steps.length === 0) return;
  const parent = _planAnchor ? _planAnchor.parentNode : document.getElementById('messages');
  if (!parent) return;

  if (!_planEl) {
    _planEl = document.createElement('div');
    _planEl.className = 'plan-block';
    parent.insertBefore(_planEl, _planAnchor || null);
  }

  const steps = payload.steps;
  const done = Math.max(0, Math.min(payload.done || 0, steps.length));
  const rows = steps
    .map((step, idx) => {
      const checked = idx < done;
      const label =
        typeof step === 'string' ? step : String((step && (step.description || step.label)) || '');
      return (
        '<div class="plan-step' +
        (checked ? ' done' : '') +
        '">' +
        '<span class="plan-check">' +
        (checked ? '✓' : '○') +
        '</span>' +
        '<span class="plan-label">' +
        _escapeHtml(label) +
        '</span>' +
        '</div>'
      );
    })
    .join('');

  _planEl.innerHTML =
    '<div class="plan-block-header">PLAN — ' + done + '/' + steps.length + '</div>' + rows;

  const feed = document.getElementById('messages');
  if (feed) feed.scrollTop = feed.scrollHeight;
}

/** Elimina el widget (llamar al terminar/cancelar el agent-run). */
function resetPlanBlock() {
  if (_planEl && _planEl.parentNode) _planEl.remove();
  _planEl = null;
  _planAnchor = null;
}
