// @ts-nocheck
// Panel de permisos granulares (allow/ask/deny) — patrón opencode.
// Muestra las reglas persistentes y permite agregar/quitar. Todo pasa por
// IPC a core/security/PermissionManager.js (userData/permissions.json).

const permsModal = document.getElementById('perms-modal');
const DESKTOP_CAPABILITIES = [
  ['applications', 'Aplicaciones'],
  ['browser', 'Navegador y multimedia'],
  ['screen', 'Pantalla y accesibilidad'],
  ['pointer', 'Puntero y controles'],
  ['keyboard', 'Teclado observado'],
  ['processes', 'Procesos'],
  ['camera', 'Cámara'],
];

function renderDesktopCapabilities(rules) {
  const container = document.getElementById('desktop-capabilities');
  if (!container) return;
  container.innerHTML = DESKTOP_CAPABILITIES.map(([id, label]) => {
    const rule = rules.find((item) => item.tool === `capability:${id}` && !item.path);
    const enabled = !rule || rule.action !== 'deny';
    return `<button class="desktop-capability ${enabled ? 'enabled' : 'disabled'}" data-capability="${id}" data-enabled="${enabled ? '1' : '0'}" type="button" aria-pressed="${enabled ? 'true' : 'false'}">
      <span>${escapeHtml(label)}</span><strong>${enabled ? 'ACTIVO' : 'BLOQUEADO'}</strong>
    </button>`;
  }).join('');
}

function openPermsModal() {
  permsModal.classList.add('visible');
  renderPermsList();
}

function closePermsModal() {
  permsModal.classList.remove('visible');
}

async function renderPermsList() {
  const listEl = document.getElementById('perms-list');
  const emptyEl = document.getElementById('perms-empty-msg');
  const statusEl = document.getElementById('perms-status');
  statusEl.textContent = '';
  let rules = [];
  try {
    const [loadedRules, config] = await Promise.all([
      window.assistant.invoke('permissions-list'),
      window.assistant.invoke('get-config'),
    ]);
    rules = loadedRules;
    const browser = config?.browser || {};
    document.getElementById('media-browser-control').value =
      browser.mediaControl === 'managed' ? 'managed' : 'external';
    document.getElementById('media-browser-preferred').value = browser.preferred || 'default';
  } catch (e) {
    console.error('[perms] error listando reglas:', e.message || e);
    listEl.innerHTML = '<div class="session-error">No se pudieron cargar los permisos.</div>';
    return;
  }
  rules = Array.isArray(rules) ? rules : [];
  renderDesktopCapabilities(rules);
  const toolRules = rules.filter((rule) => !String(rule.tool || '').startsWith('capability:'));
  if (toolRules.length === 0) {
    listEl.innerHTML = '';
    emptyEl.style.display = 'block';
    return;
  }
  emptyEl.style.display = 'none';
  const actionLabels = { allow: 'Permitir', ask: 'Preguntar', deny: 'Bloquear' };
  listEl.innerHTML = toolRules
    .map(
      (r) => `<div class="perm-row">
        <span class="perm-tool">${escapeHtml(r.tool)}</span>
        <span class="perm-path">${r.path ? escapeHtml(r.path) : '· todos los paths ·'}</span>
        <span class="perm-action perm-action-${escapeHtml(r.action)}">${escapeHtml(actionLabels[r.action] || r.action)}</span>
        <button class="perm-del" data-tool="${escapeHtml(r.tool)}" data-path="${escapeHtml(
          r.path || ''
        )}" title="Eliminar regla">×</button>
      </div>`
    )
    .join('');
}

function attachPermsEvents() {
  const openBtn = document.getElementById('perms-btn');
  if (openBtn) openBtn.addEventListener('click', openPermsModal);

  const closeBtn = document.getElementById('close-perms');
  if (closeBtn) closeBtn.addEventListener('click', closePermsModal);
  const closeX = document.getElementById('perms-close-x');
  if (closeX) closeX.addEventListener('click', closePermsModal);

  permsModal.addEventListener('click', (e) => {
    if (e.target === permsModal) closePermsModal();
  });

  const addBtn = document.getElementById('perms-add-btn');
  if (addBtn) {
    addBtn.addEventListener('click', async () => {
      const tool = (document.getElementById('perms-tool').value || '*').trim() || '*';
      const path = document.getElementById('perms-path').value.trim();
      const action = document.getElementById('perms-action').value;
      const statusEl = document.getElementById('perms-status');
      try {
        const res = await window.assistant.invoke('permissions-set', { tool, path, action });
        if (!res.ok) {
          statusEl.textContent = res.error || 'error';
          return;
        }
        document.getElementById('perms-tool').value = '';
        document.getElementById('perms-path').value = '';
        renderPermsList();
      } catch (e) {
        statusEl.textContent = e.message || 'error';
      }
    });
  }

  const listEl = document.getElementById('perms-list');
  if (listEl) {
    listEl.addEventListener('click', async (e) => {
      const btn = e.target.closest('.perm-del');
      if (!btn) return;
      try {
        await window.assistant.invoke('permissions-remove', {
          tool: btn.dataset.tool,
          path: btn.dataset.path,
        });
        renderPermsList();
      } catch (e) {
        console.error('[perms] error eliminando regla:', e.message || e);
      }
    });
  }

  const capabilities = document.getElementById('desktop-capabilities');
  if (capabilities) {
    capabilities.addEventListener('click', async (e) => {
      const button = e.target.closest('.desktop-capability');
      if (!button) return;
      const enabled = button.dataset.enabled === '1';
      try {
        await window.assistant.invoke('permissions-set', {
          tool: `capability:${button.dataset.capability}`,
          path: '',
          action: enabled ? 'deny' : 'ask',
        });
        renderPermsList();
      } catch (error) {
        document.getElementById('perms-status').textContent = error.message || 'error';
      }
    });
  }

  for (const id of ['media-browser-control', 'media-browser-preferred']) {
    document.getElementById(id)?.addEventListener('change', async () => {
      const statusEl = document.getElementById('perms-status');
      const patch = {
        browser: {
          mediaControl: document.getElementById('media-browser-control').value,
          preferred: document.getElementById('media-browser-preferred').value,
        },
      };
      try {
        const result = await window.assistant.invoke('set-config', patch);
        statusEl.textContent = result?.ok ? 'Preferencia de navegador guardada.' : result?.error;
      } catch (error) {
        statusEl.textContent = error.message || 'No se pudo guardar la preferencia.';
      }
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', attachPermsEvents);
} else {
  attachPermsEvents();
}
