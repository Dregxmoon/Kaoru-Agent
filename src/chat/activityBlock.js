'use strict';

// renderMarkdown (de core.js/preload) es global y carga ANTES que este archivo.
// La declaración var SIN inicializador de abajo NO pisa la función ya definida
// en core.js (un var hoisted sin valor no reasigna una global existente); solo
// le da tipo al LSP. Nunca asignar aquí — la implementación real vive en
// preload.js/core.js y un stub con el mismo nombre la rompería.
/**
 * Renderiza markdown a HTML saneado (implementación real en preload.js/core.js).
 * @type {(md: string, opts?: { streaming?: boolean }) => string}
 */
var renderMarkdown;

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
 * @property {Record<string, *>|null} [meta] - datos extra de la tool (p. ej.
 *   oldContent/newContent de edit/apply_patch) para vistas enriquecidas.
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
 * @param {{ step?: number, markdown?: boolean, gestures?: Array<{ pos: number, mood: string }>, onGesture?: (mood: string) => void }} [opts] - caracteres por frame
 *   (default: ~500/frame). Con markdown:true el texto se renderiza con
 *   renderMarkdown de forma progresiva (throttle ~60ms) en lugar de texto
 *   plano, para que el markdown no se vea en crudo mientras se escribe.
 *   Con gestures se disparan los marcadores (gesto: x) en vivo cuando el
 *   cursor revelado los alcanza, llamando a onGesture(mood).
 */
function revealText(el, text, opts = {}) {
  let i = 0;
  let raf = 0;
  let stopped = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let mdTimer = null;
  const isMd = !!opts.markdown;
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
  // Gestos del LLM: markers[{ pos, mood }] se disparan en vivo cuando el cursor
  // revelado los alcanza, una sola vez cada uno (se van consumiendo).
  const gestures = (opts.gestures || []).slice().sort((a, b) => a.pos - b.pos);
  const onGesture = opts.onGesture || null;
  const fireGesturesUpTo = (/** @type {number} */ idx) => {
    if (!onGesture || !gestures.length) return;
    while (gestures.length && gestures[0].pos <= idx) {
      /** @type {{ pos: number, mood: string }} */
      const g = /** @type {{ pos: number, mood: string }} */ (gestures.shift());
      try {
        onGesture(g.mood);
      } catch (e) {
        console.warn('[gesto] onGesture falló:', /** @type {Error} */ (e).message);
      }
    }
  };
  const paint = () => {
    fireGesturesUpTo(i);
    if (isMd) {
      el.innerHTML = renderMarkdown(String(text).slice(0, i), { streaming: true });
      el.appendChild(cursor);
    } else {
      el.textContent = String(text).slice(0, i);
      el.appendChild(cursor);
    }
    _scrollFeed();
  };
  const tick = () => {
    if (stopped) return;
    i = Math.min(i + step, max);
    if (isMd) {
      if (!mdTimer) {
        mdTimer = setTimeout(() => {
          mdTimer = null;
          paint();
        }, 60);
      }
    } else {
      paint();
    }
    if (i < max) {
      raf = requestAnimationFrame(tick);
    } else {
      if (mdTimer) {
        clearTimeout(mdTimer);
        mdTimer = null;
      }
      fireGesturesUpTo(max);
      paint();
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
      if (mdTimer) {
        clearTimeout(mdTimer);
        mdTimer = null;
      }
      fireGesturesUpTo(max);
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

// Nombre amigable por tool para el label del bloque (exec → Bash, etc.). Si la
// tool no está en el mapa se muestra el nombre interno tal cual.
/** @type {Record<string, string>} */
const TOOL_LABELS = {
  exec: 'Bash',
  run_command: 'Bash',
  read: 'Read',
  read_file: 'Read',
  write: 'Write',
  edit: 'Edit',
  edit_file: 'Edit',
  apply_patch: 'Apply Patch',
  grep: 'Grep',
  glob: 'Glob',
  code_execution: 'Python',
  web_search: 'Web Search',
  websearch: 'Web Search',
  webfetch: 'Web Fetch',
  browser: 'Browser',
  get_diagnostics: 'Diagnósticos',
  go_to_definition: 'Go to Def',
  find_references: 'Find Ref',
  get_symbols: 'Symbols',
  hover: 'Hover',
  rename: 'Rename',
  code_actions: 'Code Actions',
  git_status: 'Git Status',
  git_diff: 'Git Diff',
  git_log: 'Git Log',
  git_branch: 'Git Branch',
  git_commit: 'Git Commit',
  git_push: 'Git Push',
  git_stash: 'Git Stash',
  git_merge: 'Git Merge',
  git_rebase: 'Git Rebase',
  github_repo_info: 'GitHub Repo',
  github_issue_list: 'GitHub Issues',
  github_issue_create: 'GitHub Issue',
  github_issue_comment: 'GitHub Comment',
  github_issue_close: 'GitHub Close',
  github_pr_list: 'GitHub PRs',
  github_pr_create: 'GitHub PR',
  github_pr_review: 'GitHub Review',
  github_actions_status: 'GitHub Actions',
  subagent: 'Subagente',
  task: 'Subagente',
  mcp: 'MCP',
  plugin: 'Plugin',
};

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

// ── Frame de código (Write) ─────────────────────────────────────────────────
// Muestra el código generado en un recuadro con el nombre de archivo y la ruta
// arriba. Colapsable: por defecto muestra hasta CODE_FRAME_VISIBLE_LINES y un
// botón "ver todo" que expande el resto.
const CODE_FRAME_VISIBLE_LINES = 30;
const CODE_FRAME_MAX_CHARS = 20000;

/**
 * @param {string} filePath
 * @returns {string}
 */
function _baseName(filePath) {
  const p = String(filePath || '');
  return p.split(/[\\/]/).pop() || p;
}

/**
 * @param {string} filePath
 * @param {string} content
 * @returns {string}
 */
function _codeFrameHtml(filePath, content) {
  const name = _baseName(filePath);
  const esc = _escapeHtml(content);
  const totalLines = content.split('\n').length;
  const needsExpand =
    totalLines > CODE_FRAME_VISIBLE_LINES || content.length > CODE_FRAME_MAX_CHARS;
  return (
    '<div class="activity-code-frame">' +
    `<div class="activity-code-frame-head">` +
    `<span class="activity-code-file">${_escapeHtml(name)}</span>` +
    `<span class="activity-code-path">${_escapeHtml(filePath)}</span>` +
    `<span class="activity-code-lines">${totalLines} líneas</span>` +
    `</div>` +
    `<pre class="activity-code-body${needsExpand ? ' collapsed' : ''}">${esc}</pre>` +
    (needsExpand ? '<div class="activity-code-toggle" data-collapsed="1">Ver todo ▾</div>' : '') +
    '</div>'
  );
}

// ── Split viejo/actualizado (Edit/apply_patch) ─────────────────────────────
// Dos paneles: el archivo antes (izquierda) y después (derecha). Las líneas
// que se añadieron se marcan en verde y las que se quitaron en rojo, con el
// número de línea alineado para que el cambio sea visual.
/**
 * @param {string} filePath
 * @param {string} oldContent
 * @param {string} newContent
 * @param {number[]} addedLines
 * @param {number[]} removedLines
 * @returns {string}
 */
function _editSplitHtml(filePath, oldContent, newContent, addedLines, removedLines) {
  const name = _baseName(filePath);
  const added = new Set(addedLines || []);
  const removed = new Set(removedLines || []);
  /** @param {string} lines @param {Set<number>} mark @returns {string} */
  const col = (lines, mark) =>
    lines
      .split('\n')
      .map((line, idx) => {
        const n = idx + 1;
        const cls = mark.has(n) ? ' changed' : '';
        return (
          `<div class="activity-split-line${cls}">` +
          `<span class="activity-split-num">${n}</span>` +
          `<span class="activity-split-text">${_escapeHtml(line) || ' '}</span>` +
          '</div>'
        );
      })
      .join('');
  return (
    '<div class="activity-split">' +
    `<div class="activity-split-head">` +
    `<span class="activity-code-file">${_escapeHtml(name)}</span>` +
    `<span class="activity-split-label old">ANTES</span>` +
    `<span class="activity-split-label new">ACTUALIZADO</span>` +
    `</div>` +
    `<div class="activity-split-cols">` +
    `<div class="activity-split-col old">${col(oldContent, removed)}</div>` +
    `<div class="activity-split-col new">${col(newContent, added)}</div>` +
    '</div>' +
    '</div>'
  );
}

// Detalle expandible del bloque (texto plano, diff coloreado o stdout/stderr).
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

  // Write: frame con el código completo generado + archivo/ruta arriba. El
  // contenido completo llega en params.content (se pintó al escribir).
  if (
    /^(write)$/i.test(progress.tool) &&
    progress.params &&
    typeof progress.params.content === 'string'
  ) {
    return `<div class="activity-block-detail">${_codeFrameHtml(
      progress.params.path || progress.params.file_path || '',
      progress.params.content
    )}</div>`;
  }

  // Edit/apply_patch con meta (oldContent/newContent + líneas): split visual
  // viejo/actualizado con las líneas cambiadas resaltadas.
  if (
    /^(edit|apply_patch)$/i.test(progress.tool) &&
    progress.meta &&
    typeof progress.meta.oldContent === 'string' &&
    typeof progress.meta.newContent === 'string'
  ) {
    return `<div class="activity-block-detail">${_editSplitHtml(
      progress.params && (progress.params.path || progress.params.file_path)
        ? progress.params.path || progress.params.file_path
        : '',
      progress.meta.oldContent,
      progress.meta.newContent,
      progress.meta.addedLines,
      progress.meta.removedLines
    )}</div>`;
  }

  // Resultado de exec ({stdout, stderr, exitCode, ...}): mostrar SOLO el stdout
  // limpio formateado, el stderr aparte en color de error y el exit code si no
  // fue 0 — nunca el JSON crudo del objeto.
  if (typeof r === 'object' && 'stdout' in r) {
    const stdout = String(r.stdout || '').trim();
    const stderr = String(r.stderr || '').trim();
    const exitCode = r.exitCode;
    let out = '';
    if (stdout) {
      out += `<div class="activity-block-exec">${_escapeHtml(stdout.slice(0, 3000))}</div>`;
    }
    if (stderr) {
      out += `<div class="activity-block-stderr">${_escapeHtml(stderr.slice(0, 2000))}</div>`;
    }
    if (exitCode != null && exitCode !== 0) {
      out += `<div class="activity-block-exit">exit ${_escapeHtml(String(exitCode))}</div>`;
    }
    if (!out) {
      out = `<div class="activity-block-exec">${_escapeHtml(String(r).slice(0, 3000))}</div>`;
    }
    return `<div class="activity-block-detail">${out}</div>`;
  }

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
      `<span class="activity-block-tool">${_escapeHtml(TOOL_LABELS[progress.tool] || progress.tool)}</span>` +
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
      // Toggle "Ver todo ▾" de los frames de código: expande/colapsa el <pre>.
      const toggle = detail.querySelector('.activity-code-toggle');
      if (toggle) {
        toggle.addEventListener('click', () => {
          const body = detail.querySelector('.activity-code-body');
          if (!body) return;
          const collapsed = body.classList.toggle('collapsed');
          toggle.textContent = collapsed ? 'Ver todo ▾' : 'Ver menos ▴';
        });
      }
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
