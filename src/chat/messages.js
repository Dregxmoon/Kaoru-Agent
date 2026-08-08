// @ts-nocheck
// Mensajes
const messagesEl = document.getElementById('messages');

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
  messagesEl.scrollTop = messagesEl.scrollHeight;
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
    messagesEl.scrollTop = messagesEl.scrollHeight;
    await new Promise((r) => setTimeout(r, delay + Math.random() * 8));
  }
  bubble.classList.remove('typewriter-cursor');
  bubble.classList.add('markdown');
  bubble.innerHTML = renderMarkdown(text);
  bubble.querySelectorAll('.mermaid').forEach((el) => _renderMermaid(el));
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function showThinking() {
  const div = document.createElement('div');
  div.className = 'msg assistant';
  div.id = 'thinking-msg';
  div.innerHTML = `<div class="msg-avatar">AP</div><div class="msg-body"><div class="msg-name">Asistente</div><div class="msg-bubble thinking-text">pensando...</div></div>`;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
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
      LLMProvider.configure(cfg);
      updateKeysBanner(LLMProvider.getActiveProvider());
      _providerNames = LLMProvider.getAvailableProviders()
        .filter((p) => p.hasKey)
        .map((p) => p.id);
      updateLlmHint();
    } else {
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

// FIX QW-1 (UI): muestra/oculta el banner de memoria no persistente.
// main.js envía esto una sola vez, justo cuando esta ventana termina de
// cargar (ver did-finish-load de chatWindow en main.js), leyendo el flag
// usingFallback directamente de StateGraph.
ipcRenderer.on('memory-status', (e, { usingFallback }) => {
  const banner = document.getElementById('memory-banner');
  if (!banner) return;
  banner.classList.toggle('visible', !!usingFallback);
  if (usingFallback) {
    console.warn('[asistente] memoria no persistente — better-sqlite3 no cargó, usando MemoryDB');
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
});

// Settings modal
const settingsModal = document.getElementById('settings-modal');
const settingsStatus = document.getElementById('settings-status');

function openSettings() {
  const providers = LLMProvider.getAvailableProviders();
  const listEl = document.getElementById('settings-providers-list');
  const hasAnyKey = providers.some((p) => p.hasKey);
  const guideEl = document.getElementById('settings-guide');
  guideEl.style.display = hasAnyKey ? 'none' : 'block';

  listEl.innerHTML = providers
    .map((p) => {
      const isActive = LLMProvider.getActiveProvider() === p.id;
      const badges = [];
      if (isActive) badges.push('<span class="pill primary">ACTIVO</span>');
      if (p.free) badges.push('<span class="pill free">GRATIS</span>');
      if (p.builtin) badges.push('<span class="pill builtin">BUILT-IN</span>');
      if (p.custom) badges.push('<span class="pill custom">CUSTOM</span>');

      // Selector de modelo: el catálogo del proveedor (estático o refrescado)
      // con el modelo activo por modo preseleccionado. El usuario elige qué
      // modelo usa cada proveedor en fast y smart.
      const catalog = (p.catalog && p.catalog.length ? p.catalog : [])
        .concat(Object.values(p.activeModel || {}))
        .filter((m, i, arr) => m && arr.indexOf(m) === i);
      const fastSel = p.activeModel?.fast || p.models?.fast || '';
      const smartSel = p.activeModel?.smart || p.models?.smart || '';
      const modelSelects = catalog.length
        ? `<div class="settings-model-row">
             <label class="settings-model-label">fast</label>
             <select class="settings-input settings-model provider-model-fast" data-provider="${escapeHtml(p.id)}">${catalog
               .map(
                 (m) =>
                   `<option value="${escapeHtml(m)}"${m === fastSel ? ' selected' : ''}>${escapeHtml(m)}</option>`
               )
               .join('')}</select>
             <label class="settings-model-label">smart</label>
             <select class="settings-input settings-model provider-model-smart" data-provider="${escapeHtml(p.id)}">${catalog
               .map(
                 (m) =>
                   `<option value="${escapeHtml(m)}"${m === smartSel ? ' selected' : ''}>${escapeHtml(m)}</option>`
               )
               .join('')}</select>
           </div>`
        : '';
      return `<div class="settings-field">
      <div class="settings-label">${escapeHtml(p.name)} ${badges.join(' ')}</div>
      <input class="settings-input provider-key" data-provider="${escapeHtml(p.id)}" type="password" value="${p.hasKey ? '***' : ''}" placeholder="${p.free ? 'API key (tier gratis — créala en el sitio del proveedor)' : 'API key...'}" title="${p.hasKey ? 'Guardada (oculta). Deja en blanco para borrarla o escribe una nueva.' : ''}">
      ${modelSelects}
    </div>`;
    })
    .join('');

  ipcRenderer.invoke('get-key-source').then((info) => {
    const el = document.getElementById('settings-source');
    const keychainRow = document.getElementById('settings-keychain-row');
    const useKeychainChk = document.getElementById('use-keychain');
    if (info.keychainAvailable) {
      keychainRow.style.display = '';
      useKeychainChk.checked = info.source === 'llavero del sistema';
    } else {
      keychainRow.style.display = 'none';
    }
    let label = 'config.json';
    if (info.source === 'llavero del sistema') label = 'llavero del sistema';
    else if (info.source === '.env / variable de entorno') label = '.env';
    el.textContent = 'Fuente activa: ' + label;
  });

  settingsModal.classList.add('visible');
}
function closeSettings() {
  settingsModal.classList.remove('visible');
}

document.getElementById('open-settings-btn').addEventListener('click', openSettings);
document.getElementById('cancel-settings').addEventListener('click', closeSettings);
settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) closeSettings();
});

document.getElementById('save-settings').addEventListener('click', async () => {
  const keyInputs = document.querySelectorAll('.provider-key');
  const providers = {};
  let hasAny = false;
  for (const inp of keyInputs) {
    const val = inp.value.trim();
    providers[inp.dataset.provider] = val;
    if (val) hasAny = true;
  }
  if (!hasAny) {
    settingsStatus.textContent = 'Necesitas al menos una key.';
    settingsStatus.style.color = '#f59e0b';
    return;
  }
  settingsStatus.textContent = 'Guardando...';
  settingsStatus.style.color = 'var(--text-secondary)';
  try {
    // Fase Q: recoger el modelo elegido por proveedor (fast/smart).
    const models = {};
    for (const sel of document.querySelectorAll('.provider-model-fast')) {
      models[sel.dataset.provider] = {
        fast: sel.value,
        smart:
          document.querySelector(`.provider-model-smart[data-provider="${sel.dataset.provider}"]`)
            ?.value || sel.value,
      };
    }
    const useKeychain = document.getElementById('use-keychain').checked;
    await ipcRenderer.invoke('save-llm-keys', { providers, useKeychain, models });
    await loadLLMConfig();
    settingsStatus.textContent = 'Keys guardadas. El asistente está listo.';
    settingsStatus.style.color = '#10b981';
    setTimeout(closeSettings, 1200);
  } catch (e) {
    settingsStatus.textContent = 'Error: ' + e.message;
    settingsStatus.style.color = '#ef4444';
  }
});
