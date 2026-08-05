// OpenClaw badge
function updateOpenClawBadge(available) {
  openclawAvailable = available;
  const badge = document.getElementById('openclaw-badge');
  if (!badge) return;
  if (available) {
    badge.className = 'openclaw-badge';
    badge.textContent = 'TOOLS';
    badge.title = 'OpenClaw disponible — herramientas activas';
  } else {
    badge.className = 'openclaw-badge offline';
    badge.textContent = 'NO TOOLS';
    badge.title = 'OpenClaw no disponible';
  }
}

async function checkOpenClaw() {
  try {
    const available = await ipcRenderer.invoke('openclaw-available');
    updateOpenClawBadge(available);
  } catch (e) {
    updateOpenClawBadge(false);
  }
}

// MCP
// Panel de servidores MCP: lista de conectados/configurados + búsqueda en la
// biblioteca (registro oficial, con fallback a un catálogo estático si no
// hay internet) + alta manual por JSON. Todo pasa por IPC a Core/
// MCPManager — nada de esto depende de que OpenClaw esté corriendo.
const mcpModal = document.getElementById('mcp-modal');

function mcpStatusLabel(status) {
  if (status === 'connected') return 'conectado';
  if (status === 'connecting') return 'conectando...';
  if (status === 'reconnecting') return 'reconectando...';
  if (status === 'error') return 'error';
  return 'desconectado';
}

async function refreshMcpBadge() {
  try {
    const servers = await ipcRenderer.invoke('mcp-list-servers');
    const badge = document.getElementById('mcp-btn');
    const count = document.getElementById('mcp-count');
    if (servers && servers.error) {
      console.error('[mcp] no se pudo listar servidores:', servers.error);
      count.textContent = '?';
      badge.title = 'Error consultando servidores MCP';
      badge.classList.remove('active');
      return;
    }
    const connected = servers.filter((s) => s.status === 'connected').length;
    count.textContent = connected;
    badge.classList.toggle('active', connected > 0);
  } catch (e) {
    console.error('[mcp] error al listar servidores:', e.message || e);
  }
}

async function renderMcpServerList() {
  const listEl = document.getElementById('mcp-server-list');
  const emptyEl = document.getElementById('mcp-empty-msg');
  let servers = [];
  try {
    servers = await ipcRenderer.invoke('mcp-list-servers');
  } catch (e) {
    console.error('[mcp] error al listar servidores:', e.message || e);
  }

  if (servers && servers.error) {
    emptyEl.style.display = 'block';
    emptyEl.textContent = `No se pudieron cargar los servidores MCP: ${servers.error}`;
    listEl.innerHTML = '';
    return;
  }

  emptyEl.style.display = servers.length ? 'none' : 'block';
  emptyEl.textContent = 'Sin servidores MCP configurados.';
  listEl.innerHTML = servers
    .map(
      (s) => `
    <div class="mcp-server-row" data-id="${s.id}">
      <div class="mcp-status-dot ${s.status}" title="${mcpStatusLabel(s.status)}"></div>
      <div class="mcp-server-info">
        <div class="mcp-server-name">${s.name}</div>
        <div class="mcp-server-sub">${s.status === 'connected' ? s.toolCount + ' tools' : s.error || mcpStatusLabel(s.status)}</div>
      </div>
      <div class="mcp-switch ${s.status !== 'disconnected' && s.status !== 'error' ? 'on' : ''}" data-toggle="${s.id}" title="Activar/desactivar"></div>
      <button class="mcp-remove-btn" data-remove="${s.id}" title="Quitar">X</button>
    </div>
  `
    )
    .join('');

  listEl.querySelectorAll('[data-toggle]').forEach((el) => {
    el.addEventListener('click', async () => {
      const id = el.dataset.toggle;
      const enabling = !el.classList.contains('on');
      el.style.opacity = '.5';
      try {
        await ipcRenderer.invoke('mcp-toggle-server', { id, enabled: enabling });
      } catch (e) {
        console.error('[mcp] error toggle:', e.message);
      }
      await renderMcpServerList();
      await refreshMcpBadge();
    });
  });

  listEl.querySelectorAll('[data-remove]').forEach((el) => {
    el.addEventListener('click', async () => {
      const id = el.dataset.remove;
      el.closest('.mcp-server-row').style.opacity = '.4';
      try {
        await ipcRenderer.invoke('mcp-remove-server', { id });
      } catch (e) {
        console.error('[mcp] error al quitar:', e.message);
      }
      await renderMcpServerList();
      await refreshMcpBadge();
    });
  });
}

function openMcpModal() {
  mcpModal.classList.add('visible');
  document.getElementById('mcp-add-panel').classList.remove('visible');
  document.getElementById('mcp-status-msg').textContent = '';
  renderMcpServerList();
}
function closeMcpModal() {
  mcpModal.classList.remove('visible');
}

document.getElementById('mcp-btn').addEventListener('click', openMcpModal);

document.getElementById('workspace-btn').addEventListener('click', async () => {
  await ipcRenderer.invoke('pick-workspace-folder');
});

ipcRenderer.on('workspace-changed', (e, { path }) => {
  _applyWorkspaceUI(path);
});
mcpModal.addEventListener('click', (e) => {
  if (e.target === mcpModal) closeMcpModal();
});

document.getElementById('mcp-add-toggle-btn').addEventListener('click', () => {
  document.getElementById('mcp-add-panel').classList.toggle('visible');
});

// Tabs: buscar en biblioteca vs. JSON manual
document.getElementById('mcp-tab-browse').addEventListener('click', () => {
  document.getElementById('mcp-tab-browse').classList.add('active');
  document.getElementById('mcp-tab-manual').classList.remove('active');
  document.getElementById('mcp-browse-view').style.display = 'block';
  document.getElementById('mcp-manual-view').style.display = 'none';
});
document.getElementById('mcp-tab-manual').addEventListener('click', () => {
  document.getElementById('mcp-tab-manual').classList.add('active');
  document.getElementById('mcp-tab-browse').classList.remove('active');
  document.getElementById('mcp-manual-view').style.display = 'block';
  document.getElementById('mcp-browse-view').style.display = 'none';
});

function mcpSetStatus(msg, color) {
  const el = document.getElementById('mcp-status-msg');
  el.textContent = msg;
  el.style.color = color || 'var(--text-secondary)';
}

async function mcpAddFromRegistryEntry(entry, btnEl) {
  btnEl.disabled = true;
  btnEl.textContent = 'Agregando...';
  mcpSetStatus(
    `Conectando "${entry.name}"... si es la primera vez, npx puede tardar en descargarlo.`,
    'var(--text-secondary)'
  );
  try {
    const serverCfg = {
      name: entry.name,
      command: 'npx',
      args: ['-y', entry.identifier, ...(entry.args || []).filter((a) => !a.startsWith('<'))],
      env: {},
    };
    const res = await ipcRenderer.invoke('mcp-add-server', { serverCfg });
    if (res.ok && res.status?.status === 'connected') {
      mcpSetStatus(`"${entry.name}" conectado (${res.status.toolCount} tools).`, '#10b981');
    } else if (res.ok) {
      mcpSetStatus(
        `"${entry.name}" agregado pero no conectó: ${res.status?.error || 'error desconocido'}.`,
        '#f59e0b'
      );
    } else {
      mcpSetStatus(`Error: ${res.error}`, '#ef4444');
    }
    await renderMcpServerList();
    await refreshMcpBadge();
  } catch (e) {
    mcpSetStatus(`Error: ${e.message}`, '#ef4444');
  } finally {
    btnEl.disabled = false;
    btnEl.textContent = 'Agregar';
  }
}

async function mcpSearch(query) {
  const resultsEl = document.getElementById('mcp-search-results');
  resultsEl.innerHTML = '<div class="mcp-empty">Buscando...</div>';
  try {
    const results = await ipcRenderer.invoke('mcp-search-registry', { query });
    if (results && results.error) {
      resultsEl.innerHTML = `<div class="mcp-empty">Error buscando: ${escapeHtml(results.error)}</div>`;
      return;
    }
    if (!results.length) {
      resultsEl.innerHTML = '<div class="mcp-empty">Sin resultados.</div>';
      return;
    }
    resultsEl.innerHTML = results
      .map(
        (r, i) => `
      <div class="mcp-result-row" data-idx="${i}">
        <div class="mcp-result-info">
          <div class="mcp-result-name">${escapeHtml(r.name)}<span class="mcp-result-badge">${r.source === 'live' ? 'registro oficial' : 'catálogo local'}</span></div>
          <div class="mcp-result-desc">${escapeHtml(r.description || '')}</div>
        </div>
        <button class="mcp-add-result-btn">Agregar</button>
      </div>
    `
      )
      .join('');
    resultsEl.querySelectorAll('.mcp-result-row').forEach((row, i) => {
      row.querySelector('.mcp-add-result-btn').addEventListener('click', (ev) => {
        mcpAddFromRegistryEntry(results[i], ev.target);
      });
    });
  } catch (e) {
    resultsEl.innerHTML = `<div class="mcp-empty">Error buscando: ${e.message}</div>`;
  }
}

document.getElementById('mcp-search-btn').addEventListener('click', () => {
  mcpSearch(document.getElementById('mcp-search-input').value.trim());
});
document.getElementById('mcp-search-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') mcpSearch(e.target.value.trim());
});

document.getElementById('mcp-json-add-btn').addEventListener('click', async () => {
  const raw = document.getElementById('mcp-json-input').value.trim();
  if (!raw) {
    mcpSetStatus('Pega la config primero.', '#f59e0b');
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    mcpSetStatus('JSON inválido: ' + e.message, '#ef4444');
    return;
  }
  if (!parsed.name || !parsed.command) {
    mcpSetStatus('Falta "name" o "command" en la config.', '#f59e0b');
    return;
  }

  mcpSetStatus(`Conectando "${parsed.name}"...`, 'var(--text-secondary)');
  try {
    const res = await ipcRenderer.invoke('mcp-add-server', { serverCfg: parsed });
    if (res.ok && res.status?.status === 'connected') {
      mcpSetStatus(`"${parsed.name}" conectado (${res.status.toolCount} tools).`, '#10b981');
      document.getElementById('mcp-json-input').value = '';
    } else if (res.ok) {
      mcpSetStatus(
        `Agregado pero no conectó: ${res.status?.error || 'error desconocido'}.`,
        '#f59e0b'
      );
    } else {
      mcpSetStatus(`Error: ${res.error}`, '#ef4444');
    }
    await renderMcpServerList();
    await refreshMcpBadge();
  } catch (e) {
    mcpSetStatus('Error: ' + e.message, '#ef4444');
  }
});

// Estado inicial del badge — no hace falta abrir el panel para ver si hay algo conectado
refreshMcpBadge();
setInterval(refreshMcpBadge, 15000);
