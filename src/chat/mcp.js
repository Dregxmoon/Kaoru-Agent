// @ts-nocheck
// OpenClaw — sin badge en la UI; el flag openclawAvailable solo decide el
// flujo del agent loop (proceso.js). El estado en vivo llega por el canal
// 'openclaw-status' (ipc.js). Aquí se consulta el estado completo al arrancar
// (disponibilidad + aislamiento de proceso bwrap).
async function checkOpenClaw() {
  try {
    const status = await assistant.invoke('openclaw-status');
    if (status) {
      openclawAvailable = Boolean(status.available);
      openclawSandbox =
        status.sandbox === undefined || status.sandbox === null ? null : Boolean(status.sandbox);
      openclawSandboxReason = status.sandboxReason || null;
      updateSandboxBanner();
    }
  } catch {
    openclawAvailable = false;
  }
}

// MCP Store — Visual "app store" para servidores MCP
// Panel de servidores conectados + Store visual con categorías, populares,
// búsqueda, autenticación OAuth/API key, instalación one-click.

const mcpModal = document.getElementById('mcp-modal');

let mcpState = {
  currentView: 'store', // 'store' | 'installed' | 'auth'
  selectedCategory: 'all',
  searchQuery: '',
  sortBy: 'popular',
  featuredServers: [],
  categories: [],
  authFlow: null, // { server, step, data }
};

function mcpStatusLabel(status) {
  if (status === 'connected') return 'conectado';
  if (status === 'connecting') return 'conectando...';
  if (status === 'reconnecting') return 'reconectando...';
  if (status === 'error') return 'error';
  return 'desconectado';
}

function categoryIcon(catId) {
  const icons = {
    code: '[CODE]',
    data: '[DATA]',
    web: '[WEB]',
    files: '[FILE]',
    comm: '[CHAT]',
    cloud: '[CLD]',
    ai: '[AI]',
    productivity: '[PRD]',
    security: '[SEC]',
    other: '[TOOL]',
  };
  return icons[catId] || '[TOOL]';
}

function categoryName(catId) {
  const names = {
    code: 'Código',
    data: 'Datos',
    web: 'Web',
    files: 'Archivos',
    comm: 'Comunicación',
    cloud: 'Cloud/DevOps',
    ai: 'IA/ML',
    productivity: 'Productividad',
    security: 'Seguridad',
    other: 'Otros',
  };
  return names[catId] || 'Otros';
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"')
    .replace(/'/g, '&#039;');
}

async function refreshMcpBadge() {
  try {
    const servers = await assistant.invoke('mcp-list-servers');
    const badge = document.getElementById('mcp-btn');
    const count = document.getElementById('mcp-count');
    if (!badge || !count) return;
    if (servers && servers.error) {
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

async function loadInitialData() {
  try {
    const [featured, categories] = await Promise.all([
      assistant.invoke('mcp-get-featured', 24),
      assistant.invoke('mcp-get-categories'),
    ]);
    // Handle error responses from IPC handlers
    if (featured?.error) {
      console.error('[mcp] featured servers error:', featured.error);
      mcpState.featuredServers = [];
    } else {
      mcpState.featuredServers = featured || [];
    }
    if (categories?.error) {
      console.error('[mcp] categories error:', categories.error);
      mcpState.categories = [];
    } else {
      mcpState.categories = categories || [];
    }
    renderCategories();
    renderFeatured();
  } catch (e) {
    console.error('[mcp] error cargando datos iniciales:', e.message);
    mcpState.featuredServers = [];
    mcpState.categories = [];
    renderCategories();
    renderFeatured();
  }
}

function renderCategories() {
  const container = document.getElementById('mcp-category-tabs');
  if (!container) return;
  const allCat = { id: 'all', name: 'Todos', icon: '[STR]' };
  const cats = [allCat, ...mcpState.categories];
  container.innerHTML = cats
    .map(
      (cat) => `
    <button class="mcp-cat-tab ${cat.id === mcpState.selectedCategory ? 'active' : ''}" data-cat="${cat.id}">
      <span class="mcp-cat-icon">${cat.icon}</span>
      <span class="mcp-cat-name">${cat.name}</span>
    </button>
  `
    )
    .join('');
  container.querySelectorAll('.mcp-cat-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      mcpState.selectedCategory = btn.dataset.cat;
      renderCategories();
      if (mcpState.currentView === 'store') renderFeatured();
    });
  });
}

function renderServerCard(server, isInstalled = false) {
  const authBadge = server.auth?.needsAuth
    ? `
    <span class="mcp-auth-badge ${server.auth.type}">
      ${server.auth.type === 'oauth' ? '[OAUTH] OAuth' : '[KEY] API Key'}
    </span>
  `
    : '<span class="mcp-auth-badge none">Sin auth</span>';

  const popularBadge = server.popularReason
    ? `
    <span class="mcp-popular-badge" title="${escapeHtml(server.popularReason)}">[POP] Popular</span>
  `
    : '';

  const installedBadge = isInstalled
    ? '<span class="mcp-installed-badge">[OK] Instalado</span>'
    : '';
  const connected = isInstalled && server.status === 'connected';

  const toolsPreview =
    server.tools
      ?.slice(0, 3)
      .map((t) => escapeHtml(t.name))
      .join(', ') || '';
  const toolsCount = server.toolCount || server.tools?.length || 0;

  return `
    <article class="mcp-server-card ${connected ? 'connected' : ''} ${isInstalled ? 'installed' : ''}" data-id="${server.id || server.identifier}" data-category="${server.category || 'other'}">
      <div class="mcp-card-header">
        <div class="mcp-card-icon">${getServerIcon(server.name, server.identifier)}</div>
        <div class="mcp-card-meta">
          <h3 class="mcp-card-name">${escapeHtml(server.name)}</h3>
          <div class="mcp-card-badges">${popularBadge}${authBadge}${installedBadge}</div>
        </div>
      </div>
      <p class="mcp-card-desc">${escapeHtml(server.description || 'Sin descripción')}</p>
      ${toolsPreview ? `<div class="mcp-card-tools">[TLS] ${escapeHtml(toolsPreview)}${toolsCount > 3 ? ` +${toolsCount - 3} más` : ''}</div>` : ''}
      <div class="mcp-card-footer">
        <span class="mcp-card-category">${categoryIcon(server.category)} ${categoryName(server.category)}</span>
        ${
          !isInstalled
            ? `
          <button class="mcp-install-btn" data-action="install" data-server='${escapeHtml(JSON.stringify(server))}'>
            <span class="btn-text">Instalar</span>
            <span class="btn-loader" style="display:none">[...]</span>
          </button>
        `
            : `
          <div class="mcp-installed-actions">
            <button class="mcp-toggle-btn ${connected ? 'on' : ''}" data-action="toggle" data-id="${server.id}" title="${connected ? 'Desconectar' : 'Conectar'}">
              ${connected ? '[ON]' : '[OFF]'}
            </button>
            <button class="mcp-remove-btn" data-action="remove" data-id="${server.id}" title="Desinstalar">[X]</button>
          </div>
        `
        }
      </div>
      ${
        server.auth?.needsAuth && !isInstalled
          ? `
        <div class="mcp-auth-hint">Requiere ${server.auth.type === 'oauth' ? 'OAuth' : 'API Key'} — se te guiará al instalar</div>
      `
          : ''
      }
    </article>
  `;
}

function getServerIcon(name, identifier) {
  const nameLower = (name || '').toLowerCase();
  const idLower = (identifier || '').toLowerCase();
  if (nameLower.includes('github') || idLower.includes('github')) return '[GIT]';
  if (nameLower.includes('gitlab') || idLower.includes('gitlab')) return '[GLB]';
  if (nameLower.includes('filesystem') || idLower.includes('filesystem')) return '[FS]';
  if (nameLower.includes('memory') || idLower.includes('memory')) return '[MEM]';
  if (nameLower.includes('sequential') || idLower.includes('thinking')) return '[SEQ]';
  if (nameLower.includes('brave') || idLower.includes('search')) return '[SRC]';
  if (nameLower.includes('fetch')) return '[FCH]';
  if (nameLower.includes('sqlite') || idLower.includes('sqlite')) return '[SQL]';
  if (nameLower.includes('postgres') || idLower.includes('postgres')) return '[PGS]';
  if (nameLower.includes('redis')) return '[RDS]';
  if (nameLower.includes('slack')) return '[SLK]';
  if (nameLower.includes('gdrive') || nameLower.includes('drive')) return '[GDR]';
  if (nameLower.includes('notion')) return '[NOT]';
  if (nameLower.includes('linear')) return '[LIN]';
  if (nameLower.includes('jira')) return '[JRA]';
  if (nameLower.includes('aws')) return '[AWS]';
  if (nameLower.includes('kubernetes') || nameLower.includes('k8s')) return '[K8S]';
  if (nameLower.includes('docker')) return '[DKR]';
  if (nameLower.includes('everything')) return '[ALL]';
  return '[MCP]';
}

async function renderFeatured() {
  const container = document.getElementById('mcp-store-grid');
  if (!container) return;

  let servers = mcpState.featuredServers;

  if (mcpState.searchQuery) {
    const q = mcpState.searchQuery.toLowerCase();
    servers = servers.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        (s.tags || []).some((t) => t.toLowerCase().includes(q))
    );
  }

  if (mcpState.selectedCategory !== 'all') {
    servers = servers.filter((s) => s.category === mcpState.selectedCategory);
  }

  if (mcpState.sortBy === 'popular') {
    servers.sort((a, b) => (b.popularReason ? 1 : 0) - (a.popularReason ? 1 : 0));
  } else if (mcpState.sortBy === 'name') {
    servers.sort((a, b) => a.name.localeCompare(b.name));
  }

  const installedServers = await getInstalledServerIds();

  if (!servers.length) {
    container.innerHTML = '<div class="mcp-empty-state">No hay servidores que coincidan</div>';
    return;
  }

  container.innerHTML = servers
    .map((s) => renderServerCard(s, installedServers.has(s.identifier)))
    .join('');
  attachCardListeners();
}

async function getInstalledServerIds() {
  try {
    const servers = await assistant.invoke('mcp-list-servers');
    return new Set(servers.map((s) => s.identifier || s.name).filter(Boolean));
  } catch {
    return new Set();
  }
}

function attachCardListeners() {
  document.querySelectorAll('.mcp-install-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const server = JSON.parse(btn.dataset.server);
      await installServer(server, btn);
    });
  });

  document.querySelectorAll('.mcp-toggle-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const enabling = !btn.classList.contains('on');
      btn.style.opacity = '0.5';
      try {
        await assistant.invoke('mcp-toggle-server', { id, enabled: enabling });
        await renderInstalled();
        await refreshMcpBadge();
      } catch (e) {
        console.error('[mcp] error toggle:', e.message);
      } finally {
        btn.style.opacity = '1';
      }
    });
  });

  document.querySelectorAll('.mcp-remove-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      if (!confirm('¿Desinstalar este servidor MCP?')) return;
      btn.closest('.mcp-server-card').style.opacity = '0.4';
      try {
        await assistant.invoke('mcp-remove-server', { id });
        await renderInstalled();
        await renderFeatured();
        await refreshMcpBadge();
      } catch (e) {
        console.error('[mcp] error al quitar:', e.message);
      }
    });
  });
}

async function installServer(server, btnEl) {
  btnEl.disabled = true;
  btnEl.querySelector('.btn-text').style.display = 'none';
  btnEl.querySelector('.btn-loader').style.display = 'inline';

  if (server.auth?.needsAuth) {
    await startAuthFlow(server, btnEl);
    return;
  }

  await doInstall(server, btnEl);
}

async function startAuthFlow(server, btnEl) {
  mcpState.authFlow = { server, step: 'config', data: {} };
  mcpState.currentView = 'auth';
  renderAuthFlow(server, btnEl);
}

function renderAuthFlow(server, btnEl) {
  const modal = document.getElementById('mcp-modal');
  const content = modal.querySelector('.mcp-content');

  const auth = server.auth;
  const isOAuth = auth.type === 'oauth';
  const provider = auth.oauth?.provider || 'generic';

  content.innerHTML = `
    <div class="mcp-auth-flow">
      <div class="mcp-auth-header">
        <button class="mcp-auth-back" id="mcp-auth-back">← Volver</button>
        <h2>Conectar ${escapeHtml(server.name)}</h2>
      </div>
      <div class="mcp-auth-body">
        <div class="mcp-auth-icon">${isOAuth ? '[OAUTH]' : '[KEY]'}</div>
        <h3>${isOAuth ? 'Autorización OAuth' : 'Configurar API Key'}</h3>
        <p class="mcp-auth-desc">
          ${
            isOAuth
              ? `Este servidor necesita acceso a tu cuenta de <strong>${provider}</strong>. Te redirigiremos para autorizar y Kaoru guardará el token de forma segura en tu llavero.`
              : `Este servidor requiere una <strong>API Key</strong>. Pégala abajo y se guardará en tu llavero (nunca en config.json).`
          }
        </p>

        ${
          isOAuth
            ? `
          <div class="mcp-oauth-providers">
            <button class="mcp-oauth-btn" data-provider="${provider}" title="Conectar con ${provider}">
              <svg class="oauth-icon" viewBox="0 0 24 24" fill="currentColor">${getOAuthIcon(provider)}</svg>
              <span>Continuar con ${capitalize(provider)}</span>
            </button>
          </div>
        `
            : `
          <div class="mcp-apikey-form">
            <label>Variable de entorno: <strong>${auth.envVars[0]?.name || 'API_KEY'}</strong></label>
            <input type="password" id="mcp-apikey-input" placeholder="Pega tu API key aquí" autocomplete="off">
            <small>La key se guarda en el llavero del sistema (Keychain/Secret Service)</small>
            <button class="btn-save" id="mcp-apikey-save">Guardar y continuar</button>
          </div>
        `
        }
      </div>
    </div>
  `;

  document.getElementById('mcp-auth-back').addEventListener('click', () => {
    mcpState.authFlow = null;
    mcpState.currentView = 'store';
    renderFeatured();
    renderCategories();
  });

  if (isOAuth) {
    document.querySelectorAll('.mcp-oauth-btn').forEach((b) => {
      b.addEventListener('click', () => startOAuthFlow(server, b.dataset.provider, btnEl));
    });
  } else {
    document.getElementById('mcp-apikey-save').addEventListener('click', () => {
      const key = document.getElementById('mcp-apikey-input').value.trim();
      if (!key) return alert('Pega la API key');
      mcpState.authFlow.data.apiKey = key;
      mcpState.authFlow.data.envVar = auth.envVars[0]?.name || 'API_KEY';
      doInstall(server, btnEl, mcpState.authFlow.data);
    });
  }
}

function getOAuthIcon(provider) {
  const icons = {
    github:
      '<path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"/>',
    gitlab:
      '<path d="M21 10.534v8.663a.713.713 0 01-.713.713H14.56a.713.713 0 01-.713-.713v-8.663a.713.713 0 01.713-.713h1.425V6.274h-1.425a2.138 2.138 0 00-2.138 2.138v3.037a.713.713 0 01-.713.713H4.99a.713.713 0 01-.713-.713V4.137a2.138 2.138 0 00-2.138-2.138H.713A.713.713 0 010 1.286V.573a.714.714 0 01.713-.713h20.575a.713.713 0 01.713.713v.713a2.139 2.139 0 00-2.138 2.138v4.262h1.425a.713.713 0 01.713.713z"/>',
    google:
      '<path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>',
    microsoft:
      '<path d="M12.545 0.231v5.136h5.137v5.14H12.545v5.136H7.41V10.503H2.274V5.367h5.136V.231h5.136z"/>',
    slack:
      '<path d="M19.08 13.44c-.73.62-1.71.95-2.96.95-.92 0-1.76-.24-2.4-.71l-2.75 1.13c.32.53.5.9.5 1.05 0 .9-.47 1.48-1.04 1.48-.4 0-.72-.24-.94-.58l-.27-.42c-.76.98-1.8 1.38-3.08 1.38-1.96 0-3.44-1.14-3.44-2.82 0-1.94 1.72-3.3 3.96-3.3 1.48 0 2.5.87 3.16 1.74l2.76-1.13c-.47-.6-.9-.95-1.13-1.13-.63-.76-1.25-1.42-1.62-1.78H4.77L7.32 1.73c.8-.37 1.62-.62 2.5-.62 2.02 0 3.55 1.3 3.55 3.26 0 1.58-1.22 2.65-2.7 2.9l-.2.42c.6.5 1.1.86 1.58 1.02.86.32 1.67.48 2.6.48.94 0 1.6-.16 2.1-.47.86-.52 1.25-1.33 1.25-2.2 0-.87-.33-1.53-.83-1.94l3.14-1.38c.8.58 1.4 1.37 1.77 2.41.27.77.4 1.57.4 2.55 0 2.2-1.18 3.82-2.92 4.75z"/>',
    discord:
      '<path d="M20.317 4.37a19.791 19.791 0 00-4.885-1.515.074.074 0 00-.079.037c-.21.38-.424.85-.57 1.24a21 21 0 00-6.023 0A13.18 13.18 0 004.735 4.12a.077.077 0 00-.079-.037 18.17 18.17 0 00-5.28 1.6.07.07 0 00-.032.027C.533 6.276-.32 7.637-.099 8.98a.083.083 0 00.031.057 19.9 19.9 0 005.992 11.54.07.07 0 00.079-.037c.38-.72.97-1.75 1.54-2.48a.2.2 0 01.182-.07c1.47-.1 3.647-.086 5.618-.086s4.148-.01 5.617.086a.2.2 0 01.182.07c.6.83 1.26 1.98 1.62 2.64a.076.076 0 00.078.037 18.17 18.17 0 005.281-1.6.071.071 0 00.031-.027c.473-2.766 1.277-5.513-.038-7.685a.061.061 0 00-.045-.045zm-6.6 11.29a5.986 5.986 0 01-2.204.12 6.05 6.05 0 01-1.631-.325 34.85 34.85 0 01-1.696-.525.07.07 0 00-.097.017 13.3 13.3 0 00-2.382 1.395.067.067 0 00-.011.096c1.476 2.14 5.464 3.874 9.047 2.29a.068.068 0 00.038-.102 11.98 11.98 0 001.38-1.813.068.068 0 00-.024-.11c-1.593-.922-3.114-2.495-3.775-4.07a.066.066 0 01-.005-.093c.52-.32 1.65-.724 2.795-.997.442-.1.835-.078 1.16.078a.062.062 0 00.083-.041zM7.95 9.643a1.25 1.25 0 11-.001-2.5.06.06 0 01.07.061c0 .69-.56 1.25-1.25 1.25a.06.06 0 01-.07-.06zm8.099 0a1.25 1.25 0 11-.001-2.5.06.06 0 01.07.06c0 .69-.56 1.25-1.25 1.25a.06.06 0 01-.07-.06z"/>',
    notion:
      '<path d="M18.5 4h-15A2.5 2.5 0 001 6.5v11A2.5 2.5 0 003.5 20h15a2.5 2.5 0 002.5-2.5v-11A2.5 2.5 0 0018.5 4zM9.5 16H7v-8h2.5v8zm5 0h-2.5V8H17v8zm-2.5-11v3.5h-2v-3.5h2z"/>',
    linear:
      '<path d="M19 3H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V5a2 2 0 00-2-2zm-7 14H6v-2h6v2zm8-4H6v-2h14v2zm0-4H6V5h14v4z"/>',
    atlassian:
      '<path d="M12 2L3.5 7.5v9L12 22l8.5-5.5v-9L12 2zm0 2.5l7 4.5v9l-7 4.5-7-4.5v-9l7-4.5zM12 17.5l-5-2.5v-5l5-2.5 5 2.5v5l-5 2.5z"/>',
  };
  return icons[provider] || icons.github;
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

async function startOAuthFlow(server, provider, btnEl) {
  try {
    btnEl.disabled = true;
    btnEl.textContent = 'Abriendo navegador...';

    const res = await assistant.invoke('mcp-oauth-start', {
      provider,
      serverName: server.name,
      serverIdentifier: server.identifier,
      serverArgs: server.args,
    });

    if (res.ok && res.authUrl) {
      // Abrir en navegador
      require('electron').shell.openExternal(res.authUrl);
      // Poll for completion
      pollOAuthCompletion(server, res.state, btnEl);
    } else {
      throw new Error(res.error || 'Error iniciando OAuth');
    }
  } catch (e) {
    console.error('[mcp] OAuth error:', e);
    btnEl.disabled = false;
    btnEl.textContent = 'Instalar';
    alert('Error iniciando OAuth: ' + e.message);
  }
}

async function pollOAuthCompletion(server, state, btnEl) {
  const check = async () => {
    try {
      const res = await assistant.invoke('mcp-oauth-check', { state });
      if (res.completed) {
        if (res.tokens) {
          mcpState.authFlow.data.tokens = res.tokens;
          await doInstall(server, btnEl, mcpState.authFlow.data);
        }
        return;
      }
      setTimeout(check, 3000);
    } catch (e) {
      console.error('[mcp] OAuth poll error:', e);
      btnEl.disabled = false;
      btnEl.textContent = 'Instalar';
    }
  };
  check();
}

async function doInstall(server, btnEl, authData = {}) {
  try {
    const serverCfg = {
      name: server.name,
      command: 'npx',
      args: ['-y', server.identifier, ...(server.args || []).filter((a) => !a.startsWith('<'))],
      env: {},
    };

    if (authData.apiKey) {
      serverCfg.env[authData.envVar] = authData.apiKey;
    }
    if (authData.tokens) {
      Object.assign(serverCfg.env, authData.tokens);
    }

    const res = await assistant.invoke('mcp-add-server', { serverCfg });

    if (res.ok && res.status?.status === 'connected') {
      showToast(
        `"${server.name}" instalado y conectado (${res.status.toolCount} tools)`,
        'success'
      );
      mcpState.authFlow = null;
      await renderInstalled();
      await renderFeatured();
      await refreshMcpBadge();
    } else if (res.ok) {
      showToast(
        `"${server.name}" agregado pero no conectó: ${res.status?.error || 'error desconocido'}`,
        'warning'
      );
    } else {
      throw new Error(res.error);
    }
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  } finally {
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.querySelector('.btn-text').style.display = 'inline';
      btnEl.querySelector('.btn-loader').style.display = 'none';
    }
  }
}

function showToast(msg, type = 'info') {
  const el = document.getElementById('mcp-toast');
  if (!el) return;
  el.textContent = msg;
  el.className = `mcp-toast ${type} show`;
  setTimeout(() => el.classList.remove('show'), 4000);
}

async function renderInstalled() {
  const container = document.getElementById('mcp-installed-list');
  if (!container) return;

  try {
    const servers = await assistant.invoke('mcp-list-servers');
    if (!servers.length) {
      container.innerHTML =
        '<div class="mcp-empty-state">No hay servidores instalados. Ve a la tienda para agregar.</div>';
      return;
    }

    container.innerHTML = servers
      .map((s) =>
        renderServerCard(
          {
            ...s,
            identifier: s.identifier || s.name,
            category: s.category || 'other',
            tools: s.tools,
            toolCount: s.toolCount,
          },
          true
        )
      )
      .join('');
    attachCardListeners();
  } catch (e) {
    container.innerHTML = '<div class="mcp-empty-state">Error cargando servidores</div>';
  }
}

async function mcpSearch(query) {
  mcpState.searchQuery = query;
  mcpState.currentView = 'store';
  document.getElementById('mcp-store-view').style.display = 'block';
  document.getElementById('mcp-installed-view').style.display = 'none';
  document.getElementById('mcp-auth-view').style.display = 'none';
  document.getElementById('mcp-tab-store').classList.add('active');
  document.getElementById('mcp-tab-installed').classList.remove('active');
  await renderFeatured();
}

function openMcpModal() {
  mcpModal.classList.add('visible');
  document.getElementById('mcp-status-msg').textContent = '';
  mcpState.currentView = 'store';
  loadInitialData();
  renderInstalled();
}

function closeMcpModal() {
  mcpModal.classList.remove('visible');
  mcpState.authFlow = null;
}

const mcpBtn = document.getElementById('mcp-btn');
if (mcpBtn) mcpBtn.addEventListener('click', openMcpModal);

const mcpCloseBtn = document.getElementById('mcp-close');
if (mcpCloseBtn) mcpCloseBtn.addEventListener('click', closeMcpModal);

mcpModal.addEventListener('click', (e) => {
  if (e.target === mcpModal) closeMcpModal();
});

// Tab switching
document.getElementById('mcp-tab-store')?.addEventListener('click', () => {
  mcpState.currentView = 'store';
  document.getElementById('mcp-store-view').style.display = 'block';
  document.getElementById('mcp-installed-view').style.display = 'none';
  document.getElementById('mcp-auth-view').style.display = 'none';
  document.getElementById('mcp-tab-store').classList.add('active');
  document.getElementById('mcp-tab-installed').classList.remove('active');
  renderFeatured();
});

document.getElementById('mcp-tab-installed')?.addEventListener('click', () => {
  mcpState.currentView = 'installed';
  document.getElementById('mcp-store-view').style.display = 'none';
  document.getElementById('mcp-installed-view').style.display = 'block';
  document.getElementById('mcp-auth-view').style.display = 'none';
  document.getElementById('mcp-tab-installed').classList.add('active');
  document.getElementById('mcp-tab-store').classList.remove('active');
  renderInstalled();
});

// Search
document.getElementById('mcp-search-btn')?.addEventListener('click', () => {
  mcpSearch(document.getElementById('mcp-search-input').value.trim());
});
document.getElementById('mcp-search-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') mcpSearch(e.target.value.trim());
});

// Sort
document.getElementById('mcp-sort-select')?.addEventListener('change', (e) => {
  mcpState.sortBy = e.target.value;
  renderFeatured();
});

// Manual JSON (keep existing)
document.getElementById('mcp-json-add-btn')?.addEventListener('click', async () => {
  const raw = document.getElementById('mcp-json-input').value.trim();
  if (!raw) return showToast('Pega la config primero', 'warning');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return showToast('JSON inválido: ' + e.message, 'error');
  }
  if (!parsed.name || !parsed.command) return showToast('Falta "name" o "command"', 'warning');

  const btn = document.getElementById('mcp-json-add-btn');
  btn.disabled = true;
  btn.textContent = 'Agregando...';
  try {
    const res = await assistant.invoke('mcp-add-server', { serverCfg: parsed });
    if (res.ok && res.status?.status === 'connected') {
      showToast(`"${parsed.name}" conectado (${res.status.toolCount} tools)`, 'success');
      document.getElementById('mcp-json-input').value = '';
      await renderInstalled();
      await refreshMcpBadge();
    } else {
      showToast(res.error || 'Error desconocido', 'error');
    }
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Agregar';
  }
});

// Initial
refreshMcpBadge();
setInterval(refreshMcpBadge, 15000);
