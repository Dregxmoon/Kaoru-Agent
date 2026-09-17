// @ts-nocheck
// Mensajes
const messagesEl = document.getElementById('messages');

// Auto-scroll "pegajoso": si el usuario subió a leer historial, el streaming y
// las actualizaciones NO lo obligan a bajar. Solo se sigue al fondo mientras
// ya estaba ahí (o dentro del margen de tolerancia).
let _stickToBottom = true;
const _SCROLL_STICKY_EPSILON = 60;

function _updateStickToBottom() {
  _stickToBottom =
    messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight <
    _SCROLL_STICKY_EPSILON;
}

function _scrollMessagesToBottom() {
  if (_stickToBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
}

messagesEl.addEventListener('scroll', _updateStickToBottom, { passive: true });

function addMessage(role, text, files = []) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.textContent = role === 'assistant' ? 'AP' : '';
  const body = document.createElement('div');
  body.className = 'msg-body';
  const name = document.createElement('div');
  name.className = 'msg-name';
  name.textContent = role === 'assistant' ? 'Asistente' : '';
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';

  if (role === 'assistant' && text) {
    bubble.classList.add('markdown');
    bubble.innerHTML = renderMarkdown(text);
    bubble.querySelectorAll('.mermaid').forEach((el) => _renderMermaid(el));
  } else {
    bubble.textContent = text;
  }

  files.forEach((f) => {
    const chip = document.createElement('div');
    chip.className = 'file-chip';
    chip.innerHTML = `<span>${escapeHtml(f.name)}</span>`;
    bubble.appendChild(chip);
  });

  body.appendChild(bubble);

  const time = document.createElement('div');
  time.className = 'msg-time';
  time.textContent = now();
  body.appendChild(time);

  div.appendChild(avatar);
  div.appendChild(body);
  messagesEl.appendChild(div);
  _scrollMessagesToBottom();
  refreshFooterSession();
  updateHeaderModel();
  return { div, bubble };
}

// Typewriter que termina renderizando markdown
async function typewriterMarkdown(bubble, text, delay = 14) {
  bubble.classList.remove('markdown');
  bubble.classList.add('typewriter-cursor');
  bubble.textContent = '';
  let buffer = '';
  for (const char of text) {
    buffer += char;
    bubble.textContent = buffer;
    _scrollMessagesToBottom();
    await new Promise((r) => setTimeout(r, delay + Math.random() * 8));
  }
  bubble.classList.remove('typewriter-cursor');
  bubble.classList.add('markdown');
  bubble.innerHTML = renderMarkdown(text);
  bubble.querySelectorAll('.mermaid').forEach((el) => _renderMermaid(el));
  _scrollMessagesToBottom();
}

function showThinking() {
  const div = document.createElement('div');
  div.className = 'msg assistant';
  div.id = 'thinking-msg';
  div.innerHTML = `<div class="msg-avatar">AP</div><div class="msg-body"><div class="msg-name">Asistente</div><div class="msg-bubble thinking-text"><span class="loading-spinner">⠋</span> pensando...</div></div>`;
  messagesEl.appendChild(div);
  _scrollMessagesToBottom();
  startSpinner(div.querySelector('.loading-spinner'));
  setAgentState('thinking', 'Pensando');
}
function removeThinking() {
  const t = document.getElementById('thinking-msg');
  if (t) t.remove();
}

// Config LLM
// Nombre corto de un workspace: solo el último segmento de la ruta
// ("/home/panfilo/Projects/sae" -> "sae"). Sirve tanto para rutas con /
// como con \\ (por si algún día corre en Windows).
function _workspaceName(fullPath) {
  if (!fullPath) return '~';
  const parts = fullPath.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : fullPath;
}

function _applyWorkspaceUI(fullPath) {
  _workspacePath = fullPath;
  _atProjectFiles = null;
  _atProjectFilesPromise = null;
  const btn = document.getElementById('workspace-btn');
  if (btn) {
    const name = _workspaceName(fullPath);
    btn.textContent = name;
    btn.title = fullPath;
  }
  const title = document.getElementById('workspace-title');
  if (title) {
    title.textContent = '~/' + _workspaceName(fullPath);
  }
}

ipcRenderer
  .invoke('get-workspace')
  .then((p) => {
    if (p) _applyWorkspaceUI(p);
  })
  .catch((e) => console.error('[chat] no se pudo obtener workspace:', (e && e.message) || e));

async function loadLLMConfig() {
  try {
    const cfg = await ipcRenderer.invoke('get-config');
    if (cfg && cfg.llm) {
      // configure refresca los caches de estado LLM + índice de comandos del
      // preload fino, así que getActiveProvider/getAvailableProviders (SÍNCRONOS)
      // leen datos reales a partir de aquí.
      await LLMProvider.configure(cfg);
      updateKeysBanner(LLMProvider.getActiveProvider());
      _providerNames = LLMProvider.getAvailableProviders()
        .filter((p) => p.hasKey)
        .map((p) => p.id);
      updateLlmHint();
      updateHeaderModel();
      refreshFooterSession();
    } else {
      await assistant.refreshCapabilities();
      updateKeysBanner(null);
    }
    // NOTA: el workspace de la UI se aplica en la línea 92 vía 'get-workspace'
    // (el valor activo real). No se lee cfg.activeWorkspace: quedó obsoleto
    // desde que el workspace sigue el directorio de lanzamiento.
  } catch (e) {
    console.warn('[llm] error cargando config:', e.message);
    updateKeysBanner(null);
  }
}

function updateKeysBanner(activeProvider) {
  document.getElementById('keys-banner').classList.toggle('visible', !activeProvider);
}

// ── Header: modelo/provider activo (dato real) ───────────────────────────────
// Formato "provider/modelo" (p.ej. "nvidia/minimax-m3"). Sin keys o sin LLM
// activo, cae a "sin modelo".
function updateHeaderModel() {
  const el = document.getElementById('header-model');
  if (!el) return;
  const active = LLMProvider.getActiveProvider();
  if (!active) {
    el.textContent = 'sin modelo';
    el.title = '';
    return;
  }
  const p = LLMProvider.getAvailableProviders().find((x) => x.id === active);
  const model = p?.activeModel?.smart || p?.models?.smart || '';
  el.textContent = model ? `${p.id}/${model}` : p.id;
  el.title = `${p?.name || active} · ${p?.free ? 'gratis' : 'pago'}`;
}

async function refreshFooterSession() {
  const el = document.getElementById('footer-session');
  if (!el) return;
  try {
    const status = await ipcRenderer.invoke('chat-context-status', {
      mode: document.body.dataset.executionMode || 'smart',
    });
    const formatTokens = (value) => {
      if (value >= 1000000) return `${(value / 1000000).toFixed(1).replace(/\.0$/, '')}M`;
      if (value >= 1000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`;
      return String(value);
    };
    if (status?.promptTokens != null && status.maxContext > 0) {
      const pct = Math.min(100, Math.round((status.promptTokens / status.maxContext) * 100));
      el.textContent = `Contexto de la última solicitud: ${formatTokens(status.promptTokens)} / ${formatTokens(status.maxContext)} tokens (${pct}%)`;
      el.title = `Uso informado por ${status.provider} para ${status.model}`;
    } else if (status?.maxContext > 0) {
      el.textContent = `Contexto máximo del modelo: ${formatTokens(status.maxContext)} tokens`;
      el.title = 'El proveedor todavía no informó el uso de una solicitud en esta ejecución.';
    } else {
      el.textContent = 'Contexto del modelo: sin datos del proveedor';
      el.title = '';
    }
  } catch {
    el.textContent = 'Contexto del modelo: no disponible';
  }
}

// FIX QW-1 (UI): muestra/oculta el banner de memoria no persistente.
// main.js envía esto justo cuando esta ventana termina de cargar (ver
// did-finish-load de chatWindow en main.js), leyendo usingFallback +
// fallbackReason directamente de StateGraph. El texto muestra la CAUSA real
// (módulo faltante, schema legacy, etc.), no un mensaje genérico.
ipcRenderer.on('memory-status', (e, { usingFallback, reason }) => {
  const banner = document.getElementById('memory-banner');
  if (!banner) return;
  banner.classList.toggle('visible', !!usingFallback);
  if (usingFallback) {
    const cause = reason ? String(reason).split('\n')[0].slice(0, 120) : 'motivo desconocido';
    banner.textContent = `Memoria no persistente — ${cause}. Lo que hablen hoy se perderá al cerrar la app.`;
    console.warn('[asistente] memoria no persistente:', cause);
  }
});

// Mejora #6 — la sesión anterior se cerró sin pasar por close() (crash,
// apagón, cierre forzado) y SessionManager la retomó con su historial
// completo. Repuebla la ventana visualmente y el array que se manda al
// LLM, para que la conversación siga exactamente donde se quedó.
ipcRenderer.on('resumed-session', (e, { history }) => {
  if (!Array.isArray(history) || !history.length) return;
  console.log(`sesión retomada: ${history.length} mensajes en contexto`);

  for (const turn of history) {
    if (!turn?.content) continue;
    sessionHistory.push(turn);
  }
  refreshFooterSession();
});

// ── Select model: picker modelo-first (nivel opencode) ───────────────────────
// Reemplaza el modal de providers: lista TODOS los modelos de IA (curado +
// models.dev), busca, marca favoritos y conecta el provider al elegir (si no
// tiene key, la pide inline). Atajos solo con el modal enfocado:
// ↑/↓ + Enter navegan/usan, Ctrl+A conecta provider, Ctrl+F favorito.
const pickerModal = document.getElementById('settings-modal');
const pickerStatus = document.getElementById('settings-status');
const pickerSearch = document.getElementById('picker-search');
const pickerList = document.getElementById('picker-list');
const pickerCloseBtn = document.getElementById('picker-close');

const _picker = {
  data: null, // payload de get-model-picker
  view: [], // filas visibles en orden de render (favoritos primero)
  selected: -1,
  mode: 'models', // 'models' | 'providers'
  expanded: null, // { providerId, modelId } | { providerId } expandido
  remoteQuery: null, // término ofrecido para búsqueda remota acotada
};

function _fmtCtx(n) {
  if (!n) return '';
  if (n >= 1000000) return `${(n / 1000000).toFixed(1).replace(/\.0$/, '')}M ctx`;
  if (n >= 1000) return `${Math.round(n / 1000)}k ctx`;
  return `${n} ctx`;
}

function _fmtCost(cIn, cOut) {
  if (!cIn && !cOut) return '';
  return `$${cIn}/${cOut} por M`;
}

function _modelKey(m) {
  return `${m.providerId}/${m.modelId}`;
}

function _providerMap() {
  return new Map(((_picker.data && _picker.data.providers) || []).map((p) => [p.id, p]));
}

function _expandedPanel() {
  if (!_picker.expanded) return '';
  const { mode } = _picker;
  const p = _providerMap().get(_picker.expanded.providerId) || {};
  if (mode === 'providers') {
    if (p.hasKey) return '';
    return `<div class="picker-expanded">
      ${p.doc ? `<a class="picker-doc" href="${escapeHtml(p.doc)}" target="_blank" rel="noreferrer">Docs del provider ↗</a>` : ''}
      ${
        p.connectable === false
          ? `<div class="picker-warn">No conectable automáticamente.</div>`
          : `<input class="picker-key-input" type="password" placeholder="${escapeHtml(p.name)} API key" autocomplete="off" />
           <div class="picker-exp-actions"><button class="picker-btn" data-act="connect-provider">Conectar provider</button></div>`
      }
    </div>`;
  }
  const m = _picker.view.find((x) => _modelKey(x) === _modelKey(_picker.expanded));
  if (!m) return '';
  const isFav = (_picker.data.favorites || []).includes(_modelKey(m));
  const effortControl =
    Array.isArray(m.effortOptions) && m.effortOptions.length > 0
      ? `<label class="picker-effort">Esfuerzo de razonamiento
          <select class="picker-effort-select">
            ${m.effortOptions.map((value) => `<option value="${value}"${value === (m.reasoningEffort || 'medium') ? ' selected' : ''}>${value === 'low' ? 'bajo' : value === 'high' ? 'alto' : 'medio'}</option>`).join('')}
          </select>
        </label>`
      : '';
  if (p.hasKey) {
    return `<div class="picker-expanded">
      ${effortControl}
      <div class="picker-exp-actions">
        <button class="picker-btn" data-act="use" data-mode="fast">Usar para respuestas rápidas</button>
        <button class="picker-btn" data-act="use" data-mode="smart">Usar para acciones y razonamiento</button>
        <button class="picker-btn ghost" data-act="fav">${isFav ? '★ Quitar favorito' : '☆ Favorito'}</button>
      </div>
    </div>`;
  }
  const env = (p.env && p.env[0]) || 'API key';
  return `<div class="picker-expanded">
    ${effortControl}
    ${p.doc ? `<a class="picker-doc" href="${escapeHtml(p.doc)}" target="_blank" rel="noreferrer">Docs del provider ↗</a>` : ''}
    ${
      p.connectable === false
        ? `<div class="picker-warn">No conectable automáticamente. Usá /provider add.</div>`
        : `<input class="picker-key-input" type="password" placeholder="${escapeHtml(p.name)} ${escapeHtml(env)}" autocomplete="off" />
         <div class="picker-exp-actions">
           <button class="picker-btn" data-act="connect" data-mode="fast">Conectar para respuestas rápidas</button>
           <button class="picker-btn" data-act="connect" data-mode="smart">Conectar para acciones y razonamiento</button>
         </div>`
    }
  </div>`;
}

function _renderPickerList() {
  if (!_picker.data) return;
  const favs = new Set(_picker.data.favorites || []);
  const rows = [];
  if (_picker.mode === 'models') {
    const favRows = _picker.view.filter((m) => favs.has(_modelKey(m)));
    const rest = _picker.view.filter((m) => !favs.has(_modelKey(m)));
    const order = [...favRows, ...rest].slice(0, 80);
    _picker.view = order;
    if (favRows.length) rows.push('<div class="picker-group">FAVORITOS</div>');
    order.forEach((m, i) => {
      const p = _providerMap().get(m.providerId) || {};
      const key = _modelKey(m);
      const fav = favs.has(key) ? '★' : '☆';
      const chips = [];
      if (m.tools) chips.push('tools');
      if (m.vision) chips.push('visión');
      if (m.reasoning) chips.push('razonamiento');
      const ctx = _fmtCtx(m.context);
      if (ctx) chips.push(ctx);
      const cost = _fmtCost(m.costIn, m.costOut);
      if (cost) chips.push(cost);
      const active = _picker.selected === i ? ' active' : '';
      const dot = p.hasKey
        ? '<span class="picker-dot on" title="conectado"></span>'
        : '<span class="picker-dot" title="sin conectar"></span>';
      const expanded =
        _picker.expanded && _modelKey(_picker.expanded) === key ? _expandedPanel() : '';
      rows.push(`<div class="picker-row${active}" data-i="${i}">
        <span class="picker-fav">${fav}</span>
        <span class="picker-model">${escapeHtml(m.label)}</span>
        <span class="picker-badge">${escapeHtml(p.name || m.providerId)}${dot}</span>
        ${chips.length ? `<span class="picker-chips">${chips.map((c) => `<span class="picker-chip">${escapeHtml(c)}</span>`).join('')}</span>` : ''}
      </div>${expanded}`);
    });
    if (!order.length)
      rows.push('<div class="picker-empty">Sin resultados — probá otro término.</div>');
  } else {
    const order = _picker.view.slice(0, 60);
    order.forEach((p, i) => {
      const active = _picker.selected === i ? ' active' : '';
      const dot = p.hasKey
        ? '<span class="picker-dot on" title="conectado"></span>'
        : '<span class="picker-dot" title="sin conectar"></span>';
      const note =
        p.connectable === false ? ' <span class="picker-chip warn">no conectable</span>' : '';
      const expanded =
        _picker.expanded && _picker.expanded.providerId === p.id ? _expandedPanel() : '';
      rows.push(`<div class="picker-row picker-provider${active}" data-i="${i}">
        <span class="picker-fav">${p.hasKey ? '✓' : ''}</span>
        <span class="picker-model">${escapeHtml(p.name)}</span>
        <span class="picker-badge">${escapeHtml(p.type)}${dot}</span>${note}
      </div>${expanded}`);
    });
    if (!order.length) {
      rows.push('<div class="picker-empty">Sin providers — probá otro término.</div>');
      // Catálogo remoto acotado: si la búsqueda local no da nada, ofrece UNA
      // búsqueda explícita (máx 12, nunca miles) con el mismo UI de conexión.
      if (_picker.remoteQuery) {
        rows.push(
          `<div class="picker-row" data-remote-search="${escapeHtml(_picker.remoteQuery)}"><span class="picker-model">＋ Buscar '${escapeHtml(_picker.remoteQuery)}' en catálogo remoto</span></div>`
        );
      }
    }
  }
  pickerList.innerHTML = rows.join('');
  const remoteBtn = pickerList.querySelector('[data-remote-search]');
  if (remoteBtn) {
    remoteBtn.addEventListener('click', () => _searchRemote(remoteBtn.dataset.remoteSearch));
  }
}

async function _searchRemote(query) {
  pickerStatus.textContent = 'Buscando en catálogo remoto...';
  pickerStatus.style.color = 'var(--text-secondary)';
  try {
    const found = await ipcRenderer.invoke('search-remote-providers', { query, limit: 12 });
    if (!Array.isArray(found) || !found.length) {
      pickerStatus.textContent = 'Sin resultados remotos — probá otro término.';
      return;
    }
    const known = new Set((_picker.data.providers || []).map((p) => p.id));
    for (const p of found) {
      if (!known.has(p.id)) {
        _picker.data.providers.push({ ...p, remote: true });
        known.add(p.id);
      }
      for (const m of p.models || []) {
        if (
          !_picker.data.models.some((x) => x.providerId === m.providerId && x.modelId === m.modelId)
        ) {
          _picker.data.models.push(m);
        }
      }
    }
    _picker.remoteQuery = null;
    _applyFilter();
    pickerStatus.textContent = `${found.length} remotos — elegí uno para conectar.`;
  } catch (e) {
    pickerStatus.textContent = 'Error buscando remoto: ' + ((e && e.message) || e);
    pickerStatus.style.color = '#ef4444';
  }
}

function _applyFilter() {
  if (!_picker.data) return;
  const q = (pickerSearch.value || '').trim().toLowerCase();
  if (_picker.mode === 'models') {
    _picker.view = q
      ? _picker.data.models.filter((m) => {
          const p = _providerMap().get(m.providerId) || {};
          const aliases = m.providerId === 'openai' ? 'chatgpt gpt' : '';
          return (
            m.label.toLowerCase().includes(q) ||
            m.modelId.toLowerCase().includes(q) ||
            (p.name || '').toLowerCase().includes(q) ||
            aliases.includes(q)
          );
        })
      : _picker.data.models;
    if (q) {
      const seenModels = new Set();
      _picker.view = _picker.view.filter((m) => {
        const canonical = String(m.label || m.modelId)
          .trim()
          .toLowerCase();
        if (seenModels.has(canonical)) return false;
        seenModels.add(canonical);
        return true;
      });
    }
  } else {
    _picker.view = q
      ? _picker.data.providers.filter((p) => p.name.toLowerCase().includes(q))
      : _picker.data.providers;
    // Oferta de búsqueda remota solo cuando lo local no alcanza (y una vez
    // por término: tras fusionar, el término ya matchea y no se re-ofrece).
    _picker.remoteQuery = q && _picker.view.length === 0 ? q : null;
  }
  _picker.selected = -1;
  _picker.expanded = null;
  _renderPickerList();
}

function _move(delta) {
  if (!_picker.view.length) return;
  _picker.selected = (_picker.selected + delta + _picker.view.length) % _picker.view.length;
  _renderPickerList();
  const el = pickerList.querySelector('.picker-row.active');
  if (el) el.scrollIntoView({ block: 'nearest' });
}

function _enter() {
  const row = _picker.view[_picker.selected];
  if (!row) return;
  if (_picker.mode === 'models') {
    _toggleExpandModel(row);
  } else {
    _toggleExpandProvider(row);
  }
}

function _toggleExpandModel(m) {
  const key = _modelKey(m);
  _picker.expanded = _picker.expanded && _modelKey(_picker.expanded) === key ? null : m;
  _renderPickerList();
}

function _toggleExpandProvider(p) {
  if (p.hasKey) {
    // Ya conectado: pasá a buscar modelos de este provider.
    _picker.mode = 'models';
    _picker.expanded = null;
    pickerSearch.value = p.name;
    _applyFilter();
    pickerSearch.focus();
    return;
  }
  _picker.expanded = _picker.expanded && _picker.expanded.providerId === p.id ? null : p;
  _renderPickerList();
}

async function _useModel(m, mode) {
  const p = _providerMap().get(m.providerId) || {};
  const role = (_picker.data.roles && _picker.data.roles[mode]) || mode;
  const effortSelect = pickerList.querySelector('.picker-effort-select');
  const reasoningEffort = effortSelect ? effortSelect.value : m.reasoningEffort;
  if (p.hasKey) {
    await ipcRenderer.invoke('set-llm-model', {
      provider: m.providerId,
      mode,
      model: m.modelId,
      reasoningEffort,
    });
    if (reasoningEffort) m.reasoningEffort = reasoningEffort;
    if (_picker.data.active.provider !== m.providerId) {
      ipcRenderer.send('set-provider', { primary: m.providerId });
    }
    await loadLLMConfig();
    pickerStatus.textContent = `✓ ${m.label} activo en ${role}`;
    pickerStatus.style.color = '#10b981';
    setTimeout(closePicker, 700);
    return;
  }
  const input = pickerList.querySelector('.picker-key-input');
  const apiKey = input ? input.value.trim() : '';
  if (!apiKey) {
    pickerStatus.textContent = 'Pegá la API key para conectar.';
    pickerStatus.style.color = '#f59e0b';
    return;
  }
  pickerStatus.textContent = 'Conectando...';
  pickerStatus.style.color = 'var(--text-secondary)';
  const res = await ipcRenderer.invoke('connect-llm-provider', {
    providerId: m.providerId,
    apiKey,
    modelId: m.modelId,
    mode,
    useKeychain: document.getElementById('use-keychain').checked,
  });
  if (!res.ok) {
    pickerStatus.textContent = 'Error: ' + (res.error || 'no se pudo conectar');
    pickerStatus.style.color = '#ef4444';
    return;
  }
  if (reasoningEffort) {
    await ipcRenderer.invoke('set-llm-model', {
      provider: m.providerId,
      mode,
      model: m.modelId,
      reasoningEffort,
    });
    m.reasoningEffort = reasoningEffort;
  }
  await loadLLMConfig();
  pickerStatus.textContent = `✓ ${m.label} conectado y activo en ${role}`;
  pickerStatus.style.color = '#10b981';
  setTimeout(closePicker, 700);
}

async function _connectProvider(p) {
  const input = pickerList.querySelector('.picker-key-input');
  const apiKey = input ? input.value.trim() : '';
  if (!apiKey) {
    pickerStatus.textContent = 'Pegá la API key para conectar.';
    pickerStatus.style.color = '#f59e0b';
    return;
  }
  pickerStatus.textContent = 'Conectando...';
  pickerStatus.style.color = 'var(--text-secondary)';
  const res = await ipcRenderer.invoke('connect-llm-provider', {
    providerId: p.id,
    apiKey,
    useKeychain: document.getElementById('use-keychain').checked,
  });
  if (!res.ok) {
    pickerStatus.textContent = 'Error: ' + (res.error || 'no se pudo conectar');
    pickerStatus.style.color = '#ef4444';
    return;
  }
  await loadLLMConfig();
  _picker.data = await ipcRenderer.invoke('get-model-picker');
  _picker.mode = 'models';
  _picker.expanded = null;
  pickerSearch.value = p.name;
  _applyFilter();
  pickerSearch.focus();
  pickerStatus.textContent = `✓ ${p.name} conectado. Elegí un modelo.`;
  pickerStatus.style.color = '#10b981';
}

async function _toggleFav(m) {
  const key = _modelKey(m);
  const on = !(_picker.data.favorites || []).includes(key);
  const ok = await ipcRenderer.invoke('favorite-model', { modelKey: key, on });
  if (ok) {
    if (on) _picker.data.favorites.push(key);
    else _picker.data.favorites = (_picker.data.favorites || []).filter((f) => f !== key);
    _renderPickerList();
  }
}

function _openProvidersMode() {
  _picker.mode = 'providers';
  _picker.expanded = null;
  _picker.selected = -1;
  pickerSearch.value = '';
  _applyFilter();
  pickerStatus.textContent = 'Elegí un provider para conectarlo (Ctrl+A cierra este panel).';
  pickerStatus.style.color = 'var(--text-secondary)';
}

function openPicker() {
  _picker.mode = 'models';
  _picker.expanded = null;
  _picker.selected = -1;
  pickerStatus.textContent = '';
  ipcRenderer
    .invoke('get-model-picker')
    .then((data) => {
      _picker.data = data;
      pickerModal.classList.add('visible');
      _applyFilter();
      pickerSearch.focus();
    })
    .catch((e) => {
      pickerStatus.textContent = 'Error cargando modelos: ' + ((e && e.message) || e);
      pickerStatus.style.color = '#ef4444';
    });
}

function openSettings() {
  openPicker();
}

function closePicker() {
  pickerModal.classList.remove('visible');
  pickerStatus.textContent = '';
}

pickerCloseBtn.addEventListener('click', closePicker);
document.getElementById('open-settings-btn').addEventListener('click', openSettings);
const headerModelEl = document.getElementById('header-model');
if (headerModelEl) {
  headerModelEl.addEventListener('click', openPicker);
  headerModelEl.style.cursor = 'pointer';
}
const modelsBtn = document.getElementById('models-btn');
if (modelsBtn) modelsBtn.addEventListener('click', openPicker);
pickerModal.addEventListener('click', (e) => {
  if (e.target === pickerModal) closePicker();
});

pickerSearch.addEventListener('input', _applyFilter);
pickerSearch.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    _move(1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    _move(-1);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    _enter();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closePicker();
  }
});

// Atajos capturados SOLO con el picker abierto (ctrl+a/ctrl+f no deben
// interferir con el input del chat).
pickerModal.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    if (_picker.mode === 'models') {
      e.preventDefault();
      _openProvidersMode();
    }
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    const m = _picker.view[_picker.selected];
    if (m && _picker.mode === 'models') _toggleFav(m);
  }
});

pickerList.addEventListener('click', async (e) => {
  const btn = e.target.closest('.picker-btn');
  if (btn) {
    const { act, mode } = btn.dataset;
    const row = _picker.view[_picker.selected];
    if (act === 'use' && row && _picker.mode === 'models') await _useModel(row, mode);
    else if (act === 'connect' && row && _picker.mode === 'models') await _useModel(row, mode);
    else if (act === 'fav' && row && _picker.mode === 'models') await _toggleFav(row);
    else if (act === 'connect-provider') await _connectProvider(_picker.expanded);
    return;
  }
  const row = e.target.closest('.picker-row');
  if (!row) return;
  const i = Number(row.dataset.i);
  if (Number.isNaN(i) || !_picker.view[i]) return;
  _picker.selected = i;
  if (_picker.mode === 'models') _toggleExpandModel(_picker.view[i]);
  else _toggleExpandProvider(_picker.view[i]);
});
