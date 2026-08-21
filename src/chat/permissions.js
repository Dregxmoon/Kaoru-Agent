// @ts-nocheck
// Panel de permisos granulares (allow/ask/deny) — patrón opencode.
// Muestra las reglas persistentes y permite agregar/quitar. Todo pasa por
// IPC a core/security/PermissionManager.js (userData/permissions.json).

const permsModal = document.getElementById('perms-modal');

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
    rules = await window.assistant.invoke('permissions-list');
  } catch (e) {
    console.error('[perms] error listando reglas:', e.message || e);
    listEl.innerHTML = '<div class="session-error">No se pudieron cargar los permisos.</div>';
    return;
  }
  if (!rules || rules.length === 0) {
    listEl.innerHTML = '';
    emptyEl.style.display = 'block';
    return;
  }
  emptyEl.style.display = 'none';
  listEl.innerHTML = rules
    .map(
      (r) => `<div class="perm-row">
        <span class="perm-tool">${escapeHtml(r.tool)}</span>
        <span class="perm-path">${r.path ? escapeHtml(r.path) : '· todos los paths ·'}</span>
        <span class="perm-action perm-action-${escapeHtml(r.action)}">${escapeHtml(r.action)}</span>
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
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', attachPermsEvents);
} else {
  attachPermsEvents();
}
