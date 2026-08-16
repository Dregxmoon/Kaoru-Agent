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
 *
 * El widget es un panel colapsable estilo "pensamiento": por defecto se
 * muestra minimizado (solo el encabezado "▸ PLAN — N/M") y al hacer clic se
 * despliega el detalle de pasos con checkboxes. Mientras el run sigue, se
 * mantiene el estado abierto/cerrado que eligió el usuario: no se fuerza a
 * abrir en cada actualización de progreso.
 * @param {AgentPlanPayload} payload
 */
function renderPlanBlock(payload) {
  if (!payload || !Array.isArray(payload.steps) || payload.steps.length === 0) return;
  const parent = _planAnchor ? _planAnchor.parentNode : document.getElementById('messages');
  if (!parent) return;

  if (!_planEl) {
    const el = document.createElement('div');
    el.className = 'plan-block';
    const header = document.createElement('div');
    header.className = 'plan-block-header';
    header.setAttribute('role', 'button');
    header.addEventListener('click', () => {
      el.classList.toggle('open');
    });
    el.appendChild(header);
    const stepsEl = document.createElement('div');
    stepsEl.className = 'plan-steps';
    el.appendChild(stepsEl);
    parent.insertBefore(el, _planAnchor || null);
    _planEl = el;
  }

  const header = _planEl.querySelector('.plan-block-header');
  const stepsEl = _planEl.querySelector('.plan-steps');
  const steps = payload.steps;
  const done = Math.max(0, Math.min(payload.done || 0, steps.length));

  if (header) header.textContent = '▸ PLAN — ' + done + '/' + steps.length;
  if (stepsEl) {
    const rows = steps
      .map((step, idx) => {
        const checked = idx < done;
        const label =
          typeof step === 'string'
            ? step
            : String((step && (step.description || step.label)) || '');
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
    stepsEl.innerHTML = rows;
  }

  const feed = document.getElementById('messages');
  if (feed) feed.scrollTop = feed.scrollHeight;
}

/** Elimina el widget (llamar al terminar/cancelar el agent-run). */
function resetPlanBlock() {
  if (_planEl && _planEl.parentNode) _planEl.remove();
  _planEl = null;
  _planAnchor = null;
}
