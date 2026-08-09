'use strict';

/**
 * activityBlock.js — Cambio 2/3 del rediseño "Claude Code + AI Agent + VTuber".
 *
 * Bloques de actividad por-tool con el formato de llamada de función:
 *
 *   Read(core/planner/AgentLoop.js)                  ok · 180L
 *   Bash(git status)                                 ok · 32ms
 *   Edit(core/planner/AgentLoop.js)                  err · no hay match
 *
 * Mientras la tool corre, el marcador derecho es '⋮' (faint); al terminar se
 * reemplaza por 'ok · <timing>' (éxito) o 'err · <motivo>' (fallo). Un clic en
 * el encabezado despliega el detalle indentado a la izquierda; para
 * Edit/apply_patch el detalle se pinta como diff coloreado.
 *
 * También es el módulo que expone el estado del agente (setAgentState/
 * getAgentState), el spinner del indicador de "pensando" y el revelado
 * progresivo de texto — funciones que antes vivían en ui.js, ya no cargado.
 * Reusa el payload de agent-progress tal cual lo emite AgentLoop (phase, tool,
 * params, status, result, error) y agentStates (core/behavior) como taxonomía
 * compartida — no inventa una estructura de datos paralela.
 */

/**
 * Evento agent-progress tal cual lo emite AgentLoop (payload crudo).
 * @typedef {Object} AgentProgress
 * @property {number} iteration
 * @property {string} tool
 * @property {string} phase
 * @property {string} [status]
 * @property {Record<string, *>} [params]
 * @property {*} [result]
 * @property {*} [error]
 */

// ── Estado del agente ───────────────────────────────────────────────────────
const AGENT_STATES = ['idle', 'thinking', 'working', 'streaming', 'speaking', 'done', 'error'];
let _currentAgentState = 'idle';
const _stateListeners = new Set();

/**
 * Actualiza el estado del agente en UI (dataset del body) y notifica a los
 * listeners registrados (gestos del avatar, etc.). Ya no pinta texto de
 * estado (#agent-status se eliminó del panel del modelo).
 * @param {string} state - uno de AGENT_STATES ('idle', 'thinking', 'working', ...)
 * @param {string} [label] - etiqueta informativa para los listeners
 * @returns {string}
 */
function setAgentState(state, label) {
  if (!AGENT_STATES.includes(state)) state = 'idle';
  _currentAgentState = state;
  document.body.dataset.agentState = state;
  _stateListeners.forEach((fn) => fn(state, label));
  return state;
}

function getAgentState() {
  return _currentAgentState;
}

// ── Spinner (indicador "pensando") ──────────────────────────────────────────
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Anima el indicador "pensando" con frames braille hasta que el elemento deja
 * de estar conectado. Devuelve el id del interval para poder limpiarlo.
 * @param {HTMLElement | null} el
 * @returns {ReturnType<typeof setInterval>}
 */
function startSpinner(el) {
  let i = 0;
  const interval = setInterval(() => {
    if (!el || !el.isConnected) {
      clearInterval(interval);
      return;
    }
    el.textContent = SPINNER_FRAMES[i++ % SPINNER_FRAMES.length];
  }, 90);
  return interval;
}

// ── Revelado de texto progresivo (typewriter por rAF) ───────────────────────
// Escribe text en el elemento con un cursor parpadeante. Devuelve { done, stop }.
// Al terminar elimina el cursor; el llamador decide si renderiza markdown.
/**
 * @param {HTMLElement} el - contenedor del texto (debe estar en el DOM)
 * @param {string} text
 * @param {{ step?: number }} [opts] - caracteres por frame (default: ~500/frame)
 */
function revealText(el, text, opts = {}) {
  let i = 0;
  let raf = 0;
  let stopped = false;
  const max = String(text || '').length;
  const step = opts.step || Math.max(1, Math.round(max / 500));
  const cursor = document.createElement('span');
  cursor.className = 'stream-cursor';
  el.textContent = '';
  el.appendChild(cursor);
  /** @type {(value?: void | PromiseLike<void>) => void} */
  let doneResolve = () => {};
  const done = new Promise((r) => {
    doneResolve = r;
  });
  const tick = () => {
    if (stopped) return;
    i = Math.min(i + step, max);
    el.textContent = String(text).slice(0, i);
    el.appendChild(cursor);
    _scrollFeed();
    if (i < max) {
      raf = requestAnimationFrame(tick);
    } else {
      cursor.remove();
      doneResolve();
    }
  };
  raf = requestAnimationFrame(tick);
  return {
    done,
    stop() {
      if (stopped) return;
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
      if (cursor.parentNode) cursor.remove();
      doneResolve();
    },
  };
}

function _scrollFeed() {
  const el = document.getElementById('messages');
  if (el) el.scrollTop = el.scrollHeight;
}

// ── Bloques de actividad ────────────────────────────────────────────────────
// key: `${iteration}:${tool}` → { el, startedAt }
const _blocks = new Map();
// Los bloques se insertan ANTES de _activityAnchor (el bubble del asistente en
// curso) para que el log de tools quede encima de la respuesta en streaming.
/** @type {HTMLElement | null} */
let _activityAnchor = null;

/**
 * @param {AgentProgress} progress
 */
function _keyFor(progress) {
  return `${progress.iteration}:${progress.tool}`;
}

/**
 * @param {HTMLElement | null} el - bubble del asistente en curso
 */
function setActivityAnchor(el) {
  _activityAnchor = el;
}

/**
 * @param {string} s
 */
function _escapeHtml(s) {
  /** @type {Record<string, string>} */
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(s).replace(/[&<>"']/g, (c) => map[c] ?? c);
}

/**
 * Argumento principal de la llamada (el que lee la UI).
 * @param {AgentProgress} progress
 */
function _argLabel(progress) {
  const p = progress.params || {};
  const target = p.path || p.command || p.url || p.query || p.glob || p.file_path;
  return target != null ? String(target).slice(0, 60) : '';
}

/**
 * Marcador derecho: '⋮' mientras corre; 'ok · <timing>' / 'err · <motivo>'.
 * @param {AgentProgress} progress
 * @param {number} startedAt
 */
function _timingLabel(progress, startedAt) {
  if (progress.status !== 'ok') {
    const reason = progress.error ? String(progress.error).split('\n')[0].slice(0, 60) : 'fallo';
    return `err · ${reason}`;
  }
  const r = progress.result;
  if (typeof r === 'string' && /^(read|glob|grep|webfetch|web_search)$/i.test(progress.tool)) {
    return `ok · ${r.split('\n').length}L`;
  }
  const elapsed = Date.now() - (startedAt || Date.now());
  return elapsed >= 1000 ? `ok · ${(elapsed / 1000).toFixed(1)}s` : `ok · ${elapsed}ms`;
}

// ¿El resultado parece un diff real (Edit/apply_patch)?
/**
 * @param {*} result
 */
function _looksLikeDiff(result) {
  if (typeof result !== 'string') return false;
  const lines = result.split('\n');
  let add = 0;
  let del = 0;
  let ctx = 0;
  for (const l of lines) {
    if (l.startsWith('+') && !l.startsWith('+++')) add++;
    else if (l.startsWith('-') && !l.startsWith('---')) del++;
    else if (l.trim() && !l.startsWith('@@')) ctx++;
  }
  return add + del >= 2 && add + del > ctx;
}

/**
 * @param {string} text
 */
function _diffHtml(text) {
  return text
    .split('\n')
    .map((l) => {
      const esc = _escapeHtml(l);
      if (l.startsWith('+') && !l.startsWith('+++')) return `<span class="diff-add">${esc}</span>`;
      if (l.startsWith('-') && !l.startsWith('---')) return `<span class="diff-del">${esc}</span>`;
      if (l.startsWith('@@')) return `<span class="diff-hunk">${esc}</span>`;
      return `<span class="diff-ctx">${esc}</span>`;
    })
    .join('\n');
}

// Detalle expandible del bloque (texto plano o diff coloreado).
/**
 * @param {AgentProgress} progress
 */
function _detailHtml(progress) {
  if (progress.status !== 'ok') {
    const msg = progress.error != null ? String(progress.error) : 'Fallo';
    return `<div class="activity-block-detail">${_escapeHtml(msg.slice(0, 500))}</div>`;
  }
  const r = progress.result;
  if (r == null) return '';
  let text;
  if (typeof r === 'string') text = r;
  else {
    try {
      text = JSON.stringify(r, null, 2);
    } catch {
      text = String(r);
    }
  }
  text = text.slice(0, 3000);
  if (/^(edit|apply_patch)$/i.test(progress.tool) && _looksLikeDiff(text)) {
    return `<div class="activity-block-detail"><div class="activity-block-diff">${_diffHtml(text)}</div></div>`;
  }
  return `<div class="activity-block-detail">${_escapeHtml(text)}</div>`;
}

/**
 * Crea (en 'start') o actualiza (en 'end') el ActivityBlock correspondiente
 * a un evento de agent-progress, dentro de containerEl.
 * @param {HTMLElement} containerEl - dónde van los bloques (uno por tool)
 * @param {AgentProgress} progress
 */
function renderActivityBlock(containerEl, progress) {
  if (!containerEl || !progress || !progress.tool) return;
  const key = _keyFor(progress);

  if (progress.phase === 'start') {
    const block = document.createElement('div');
    block.className = 'activity-block';
    const arg = _argLabel(progress);
    block.innerHTML =
      '<div class="activity-block-header">' +
      `<span class="activity-block-tool">${_escapeHtml(progress.tool)}</span>` +
      (arg
        ? `<span class="activity-block-paren">(</span><span class="activity-block-arg">${_escapeHtml(arg)}</span><span class="activity-block-paren">)</span>`
        : '') +
      '<span class="activity-block-status running">⋮</span>' +
      '</div>';

    const header = block.querySelector('.activity-block-header');
    if (header) {
      header.addEventListener('click', () => {
        const detail = block.querySelector('.activity-block-detail');
        if (!detail) return;
        if (detail.hasAttribute('hidden')) detail.removeAttribute('hidden');
        else detail.setAttribute('hidden', '');
      });
    }

    const parent = _activityAnchor ? _activityAnchor.parentNode : containerEl;
    if (!parent) return;
    if (_activityAnchor) parent.insertBefore(block, _activityAnchor);
    else parent.appendChild(block);
    _blocks.set(key, { el: block, startedAt: Date.now() });
    _scrollFeed();
    return;
  }

  if (progress.phase === 'end') {
    const entry = _blocks.get(key);
    if (!entry) return; // llegó 'end' sin 'start' previo — no romper, ignorar
    _blocks.delete(key);

    const status = entry.el.querySelector('.activity-block-status');
    const label = _timingLabel(progress, entry.startedAt);
    status.classList.remove('running');
    status.classList.add(progress.status === 'ok' ? 'ok' : 'err');
    status.textContent = label;

    const detailHtml = _detailHtml(progress);
    if (detailHtml) {
      const detail = document.createElement('div');
      detail.innerHTML = detailHtml;
      entry.el.appendChild(detail);
    }
    _scrollFeed();
  }
}

/** Limpia los bloques activos y el ancla (llamar al terminar/cancelar agent-run). */
function resetActivities() {
  _activityAnchor = null;
  _blocks.clear();
}

/** Alias de resetActivities para quien use el nombre antiguo del módulo. */
function resetActivityBlocks() {
  resetActivities();
}

// ── Init ────────────────────────────────────────────────────────────────────
setAgentState('idle', 'Listo');
