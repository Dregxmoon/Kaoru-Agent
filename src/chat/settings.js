// @ts-nocheck
// Panel de Ajustes (§9): autonomía (observe/suggest/act), flags del agente
// (autoApprove, approvalTimeoutMs), bloqueo con PIN (§11.1) y cuenta de
// GitHub. Todo persiste vía IPC al main (set-config / pin-* / github-status).

const prefsModal = document.getElementById('prefs-modal');

let _prefs = null; // config actual (redactada) desde get-config

function openPrefs() {
  prefsModal.classList.add('visible');
  _loadPrefs();
}

function closePrefs() {
  prefsModal.classList.remove('visible');
}

async function _loadPrefs() {
  try {
    _prefs = await window.assistant.invoke('get-config');
  } catch (e) {
    _prefs = null;
  }
  const cfg = _prefs || {};
  const agent = cfg.agent || {};

  for (const seg of document.querySelectorAll('#prefs-autonomy .prefs-seg')) {
    seg.classList.toggle('active', seg.dataset.mode === (cfg.autonomy || 'suggest'));
  }
  document.getElementById('prefs-autoapprove').checked = !!agent.autoApprove;
  document.getElementById('prefs-approval-timeout').value = agent.approvalTimeoutMs || 120000;
  document.getElementById('prefs-pin-timeout').value = agent.pinTimeoutMs || 0;

  _loadPinStatus();
  _loadGhStatus();
}

async function _loadPinStatus() {
  const statusEl = document.getElementById('prefs-pin-status');
  try {
    const st = await window.assistant.invoke('pin-status');
    const clearBtn = document.getElementById('prefs-pin-clear-btn');
    clearBtn.style.display = st.set ? '' : 'none';
    statusEl.textContent = st.set ? 'PIN configurado.' : 'Sin PIN — la app se abre sin bloqueo.';
    statusEl.style.color = st.set ? 'var(--text-secondary)' : 'var(--text-secondary)';
  } catch (e) {
    statusEl.textContent = (e && e.message) || 'Error consultando el PIN.';
    statusEl.style.color = '#ef4444';
  }
}

async function _loadGhStatus() {
  const statusEl = document.getElementById('prefs-gh-status');
  const logoutBtn = document.getElementById('prefs-gh-logout-btn');
  const errorEl = document.getElementById('prefs-gh-error');
  errorEl.textContent = '';
  try {
    const st = await window.assistant.invoke('github-status');
    if (st.connected) {
      statusEl.textContent = st.login ? `Conectado como @${st.login}` : 'Conectado (cuenta oculta)';
      logoutBtn.style.display = '';
    } else {
      statusEl.textContent = st.clientIdSet
        ? 'Sin cuenta. Usá `/github login` para vincularla.'
        : 'Sin cuenta. Configurá el Client ID con `/github client-id <ID>` y luego `/github login`.';
      logoutBtn.style.display = 'none';
    }
  } catch (e) {
    statusEl.textContent = 'No se pudo consultar GitHub.';
    errorEl.textContent = (e && e.message) || String(e);
  }
}

async function _setAgentPatch(patch) {
  const statusEl = document.getElementById('prefs-agent-status');
  try {
    const res = await window.assistant.invoke('set-config', patch);
    if (res && res.ok === false) {
      statusEl.textContent = res.error || 'error';
      statusEl.style.color = '#ef4444';
      return;
    }
    statusEl.textContent = '';
  } catch (e) {
    statusEl.textContent = (e && e.message) || 'error';
    statusEl.style.color = '#ef4444';
  }
}

function attachPrefsEvents() {
  const openBtn = document.getElementById('settings-btn');
  if (openBtn) openBtn.addEventListener('click', openPrefs);

  const closeBtn = document.getElementById('prefs-close');
  if (closeBtn) closeBtn.addEventListener('click', closePrefs);
  const doneBtn = document.getElementById('prefs-done-btn');
  if (doneBtn) doneBtn.addEventListener('click', closePrefs);

  prefsModal.addEventListener('click', (e) => {
    if (e.target === prefsModal) closePrefs();
  });

  document.querySelectorAll('#prefs-autonomy .prefs-seg').forEach((seg) => {
    seg.addEventListener('click', async () => {
      const mode = seg.dataset.mode;
      const res = await window.assistant.invoke('set-config', { autonomy: mode });
      if (!res || res.ok === false) {
        const statusEl = document.getElementById('prefs-agent-status');
        statusEl.textContent = (res && res.error) || 'error';
        statusEl.style.color = '#ef4444';
        return;
      }
      for (const s of document.querySelectorAll('#prefs-autonomy .prefs-seg')) {
        s.classList.toggle('active', s.dataset.mode === mode);
      }
    });
  });

  document.getElementById('prefs-autoapprove').addEventListener('change', (e) => {
    _setAgentPatch({ agent: { autoApprove: e.target.checked } });
  });

  let timeoutDebounce = null;
  document.getElementById('prefs-approval-timeout').addEventListener('change', (e) => {
    const n = Number(e.target.value);
    if (!Number.isFinite(n) || n <= 0) {
      e.target.value = 120000;
      return;
    }
    clearTimeout(timeoutDebounce);
    timeoutDebounce = setTimeout(() => _setAgentPatch({ agent: { approvalTimeoutMs: n } }), 400);
  });

  let pinTimeoutDebounce = null;
  document.getElementById('prefs-pin-timeout').addEventListener('change', (e) => {
    const n = Number(e.target.value);
    if (!Number.isFinite(n) || n < 0) {
      e.target.value = 0;
      return;
    }
    clearTimeout(pinTimeoutDebounce);
    pinTimeoutDebounce = setTimeout(() => _setAgentPatch({ agent: { pinTimeoutMs: n } }), 400);
  });

  document.getElementById('prefs-pin-set-btn').addEventListener('click', async () => {
    const input = document.getElementById('prefs-pin-input');
    const statusEl = document.getElementById('prefs-pin-status');
    const pin = input.value;
    if (!pin) {
      statusEl.textContent = 'Escribí un PIN.';
      statusEl.style.color = '#ef4444';
      return;
    }
    try {
      const res = await window.assistant.invoke('pin-set', pin);
      statusEl.textContent = res.ok ? 'PIN guardado en el llavero.' : res.error || 'error';
      statusEl.style.color = res.ok ? 'var(--text-secondary)' : '#ef4444';
      if (res.ok) {
        input.value = '';
        document.getElementById('prefs-pin-clear-btn').style.display = '';
      }
    } catch (e) {
      statusEl.textContent = (e && e.message) || 'error';
      statusEl.style.color = '#ef4444';
    }
  });

  document.getElementById('prefs-pin-clear-btn').addEventListener('click', async () => {
    const statusEl = document.getElementById('prefs-pin-status');
    try {
      const res = await window.assistant.invoke('pin-clear');
      statusEl.textContent = res.ok ? 'PIN eliminado.' : res.error || 'error';
      statusEl.style.color = res.ok ? 'var(--text-secondary)' : '#ef4444';
      if (res.ok) {
        document.getElementById('prefs-pin-clear-btn').style.display = 'none';
      }
    } catch (e) {
      statusEl.textContent = (e && e.message) || 'error';
      statusEl.style.color = '#ef4444';
    }
  });

  document.getElementById('prefs-gh-logout-btn').addEventListener('click', async () => {
    const errorEl = document.getElementById('prefs-gh-error');
    try {
      const res = await window.assistant.runCommand('/github logout');
      errorEl.textContent = '';
      _loadGhStatus();
      document.getElementById('prefs-gh-status').textContent = res || 'Sesión cerrada.';
    } catch (e) {
      errorEl.textContent = (e && e.message) || String(e);
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', attachPrefsEvents);
} else {
  attachPrefsEvents();
}
