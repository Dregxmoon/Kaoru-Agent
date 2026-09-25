'use strict';

// @ts-check
/**
 * planBlock.js — HUD del plan explícito (plan-then-act) en el chat.
 *
 * AgentLoop genera un plan de pasos ANTES de ejecutar tareas complejas y lo
 * reenvía en vivo por el evento IPC 'agent-plan' (payload { kind, steps, done,
 * total }). Este módulo pinta un widget compacto con checkboxes que se tachan
 * a medida que el run completa pasos. Se ancla sobre el editor para seguir
 * visible aunque el feed crezca con herramientas.
 */

/**
 * Paso de plan (texto o { description }).
 * @typedef {string | { description?: string; label?: string }} AgentPlanStep
 */

/**
 * Payload del evento agent-plan (tal cual lo emite AgentLoop).
 * @typedef {Object} AgentPlanPayload
 * @property {'created'|'replaced'|'resumed'|'progress'|'mission'} kind
 * @property {number|null} [goalId]
 * @property {AgentPlanStep[]} steps
 * @property {number} done
 * @property {number} total
 * @property {'running'|'completed'|'paused'|'cancelled'} [status]
 * @property {Array<{ordinal?:number,status?:string}>} [stepStates]
 */

/** @type {HTMLDivElement | null} */
let _planEl = null; // el widget <div class="plan-block">
/** @type {Element | null} */
let _planAnchor = null; // ancla (bubble del asistente) — se inserta antes
/** @type {AgentPlanPayload | null} */
let _lastPlan = null;

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
 * El widget empieza abierto, con el avance y los pasos visibles. Mantiene el
 * estado abierto/cerrado que eligió el usuario durante la ejecución.
 * @param {AgentPlanPayload} payload
 */
function renderPlanBlock(payload) {
  if (!payload || !Array.isArray(payload.steps) || payload.steps.length === 0) return;
  const dock = document.getElementById('task-dock');
  const parent =
    dock || (_planAnchor ? _planAnchor.parentNode : document.getElementById('messages'));
  if (!parent) return;

  if (!_planEl) {
    const el = document.createElement('div');
    el.className = 'plan-block open';
    const header = document.createElement('button');
    header.className = 'plan-block-header';
    header.type = 'button';
    header.setAttribute('aria-expanded', 'true');
    header.addEventListener('click', () => {
      el.classList.toggle('open');
      header.setAttribute('aria-expanded', String(el.classList.contains('open')));
    });
    el.appendChild(header);
    const stepsEl = document.createElement('div');
    stepsEl.className = 'plan-steps';
    el.appendChild(stepsEl);
    if (dock) {
      dock.hidden = false;
      dock.appendChild(el);
    } else {
      parent.insertBefore(el, _planAnchor || null);
    }
    _planEl = el;
  }

  const header = _planEl.querySelector('.plan-block-header');
  const stepsEl = _planEl.querySelector('.plan-steps');
  const steps = payload.steps;
  const done = Math.max(0, Math.min(payload.done || 0, steps.length));
  _lastPlan = { ...payload, steps: [...steps], done, total: steps.length };

  if (header) {
    const label =
      payload.kind === 'mission'
        ? payload.status === 'paused' || payload.status === 'cancelled'
          ? 'MISIÓN PAUSADA · '
          : done >= steps.length
            ? 'MISIÓN COMPLETADA · '
            : 'MISIÓN DE ESCRITORIO · '
        : done >= steps.length
          ? 'PLAN COMPLETADO · '
          : 'PLAN DE EJECUCIÓN · ';
    header.textContent = label + done + '/' + steps.length;
  }
  _planEl.classList.toggle('complete', done >= steps.length);
  _planEl.classList.toggle(
    'paused',
    payload.kind === 'mission' && ['paused', 'cancelled'].includes(payload.status || '')
  );
  if (stepsEl) {
    const rows = steps
      .map((step, idx) => {
        const state = payload.stepStates?.find((item) => Number(item.ordinal) === idx + 1);
        const checked = state ? state.status === 'completed' : idx < done;
        const active =
          state && ['in_progress', 'awaiting_verification'].includes(state.status || '');
        const label =
          typeof step === 'string'
            ? step
            : String((step && (step.description || step.label)) || '');
        return (
          '<div class="plan-step' +
          (checked ? ' done' : active ? ' running' : '') +
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

/** Conserva el plan pendiente al comenzar otro mensaje. */
function preservePlanBlock() {
  if (!_planEl || !_lastPlan) return;
  const done = Math.max(0, Math.min(_lastPlan.done || 0, _lastPlan.steps.length));
  if (done >= _lastPlan.steps.length) return;
  const header = _planEl.querySelector('.plan-block-header');
  if (header)
    header.textContent = `${_lastPlan.kind === 'mission' ? 'MISIÓN' : 'PLAN'} PENDIENTE · ${done}/${_lastPlan.steps.length}`;
  _planEl.classList.add('paused');
}

/** Marca un plan incompleto como pausado tras cancelación o fallo del run. */
function pausePlanBlock() {
  if (!_planEl || !_lastPlan) return;
  const done = Math.max(0, Math.min(_lastPlan.done || 0, _lastPlan.steps.length));
  if (done >= _lastPlan.steps.length) return;
  const header = _planEl.querySelector('.plan-block-header');
  if (header)
    header.textContent = `${_lastPlan.kind === 'mission' ? 'MISIÓN PAUSADA' : 'PLAN PAUSADO'} · ${done}/${_lastPlan.steps.length}`;
  _planEl.classList.add('paused');
}

/** Elimina el widget de forma explícita al cambiar de sesión o workspace. */
function resetPlanBlock() {
  if (_planEl && _planEl.parentNode) _planEl.remove();
  _planEl = null;
  _planAnchor = null;
  _lastPlan = null;
  const dock = document.getElementById('task-dock');
  if (dock) dock.hidden = true;
}
