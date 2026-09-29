// @ts-nocheck
// Panel de Ajustes (§9): autonomía (observe/suggest/act), flags del agente
// (autoApprove, approvalTimeoutMs), bloqueo con PIN (§11.1) y cuenta de
// GitHub. Todo persiste vía IPC al main (set-config / pin-* / github-status).

const prefsModal = document.getElementById('prefs-modal');
const onboardingModal = document.getElementById('onboarding-modal');
const settingsText = (key) => window.kaoruI18n.t(key);
const settingsFormat = (key, values) => window.kaoruI18n.format(key, values);

let _prefs = null; // config actual (redactada) desde get-config

function openPrefs() {
  prefsModal.classList.add('visible');
  _loadPrefs();
}

function closePrefs() {
  prefsModal.classList.remove('visible');
}

async function _completeOnboarding() {
  const result = await window.assistant.invoke('set-config', {
    onboarding: { completed: true },
  });
  if (!result?.ok) throw new Error(result?.error || settingsText('onboardingSaveFailed'));
  onboardingModal.classList.remove('visible');
}

async function _showOnboardingIfNeeded() {
  try {
    const config = await window.assistant.invoke('get-config');
    if (!config?.onboarding?.completed) onboardingModal.classList.add('visible');
  } catch (_) {}
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
  _loadLlmCredentials();
}

async function _loadLlmCredentials() {
  const container = document.getElementById('prefs-llm-credentials');
  const statusEl = document.getElementById('prefs-llm-status');
  statusEl.textContent = '';
  try {
    const data = await window.assistant.invoke('get-model-picker');
    const connected = (data.providers || []).filter((provider) => provider.hasKey);
    if (!connected.length) {
      container.innerHTML = `<div class="llm-credentials-empty">${settingsText('noSavedKeys')}</div>`;
      return;
    }
    container.innerHTML = connected
      .map(
        (provider) => `<div class="llm-credential-row" data-provider="${escapeHtml(provider.id)}">
          <strong>${escapeHtml(provider.name || provider.id)}</strong>
          <input type="password" autocomplete="off" placeholder="${settingsText('newApiKey')}" aria-label="${escapeHtml(settingsFormat('newApiKeyFor', { provider: provider.name || provider.id }))}" />
          <button class="btn-save" data-action="replace">${settingsText('replace')}</button>
          <button class="btn-cancel" data-action="remove">${settingsText('delete')}</button>
        </div>`
      )
      .join('');
  } catch (error) {
    container.innerHTML = '';
    statusEl.textContent = error.message || settingsText('credentialsLoadFailed');
    statusEl.style.color = '#ef4444';
  }
}

async function _replaceLlmKey(row) {
  const providerId = row.dataset.provider;
  const input = row.querySelector('input');
  const statusEl = document.getElementById('prefs-llm-status');
  const apiKey = input.value.trim();
  if (!apiKey) {
    statusEl.textContent = settingsText('enterApiKey');
    statusEl.style.color = '#f59e0b';
    return;
  }
  const saved = await window.assistant.invoke('replace-llm-key', {
    providerId,
    apiKey,
    useKeychain: document.getElementById('use-keychain').checked,
  });
  if (!saved?.ok) throw new Error(saved?.error || settingsText('keyReplaceFailed'));
  input.value = '';
  statusEl.textContent = settingsFormat('keyReplaced', { provider: providerId });
  statusEl.style.color = '#10b981';
  document.dispatchEvent(new CustomEvent('llm-credentials-changed'));
}

async function _removeLlmKey(row) {
  const providerId = row.dataset.provider;
  if (!window.confirm(settingsFormat('confirmRemoveKey', { provider: providerId }))) return;
  const statusEl = document.getElementById('prefs-llm-status');
  const result = await window.assistant.invoke('remove-llm-key', { providerId });
  document.dispatchEvent(new CustomEvent('llm-credentials-changed'));
  await _loadLlmCredentials();
  statusEl.textContent = result?.ok
    ? settingsFormat('keyRemoved', { provider: providerId })
    : result?.error || settingsText('keyRemoveFailed');
  statusEl.style.color = result?.ok ? '#10b981' : '#f59e0b';
}

async function _loadPinStatus() {
  const statusEl = document.getElementById('prefs-pin-status');
  try {
    const st = await window.assistant.invoke('pin-status');
    const clearBtn = document.getElementById('prefs-pin-clear-btn');
    clearBtn.style.display = st.set ? '' : 'none';
    statusEl.textContent = st.set ? settingsText('pinSet') : settingsText('noPin');
    statusEl.style.color = st.set ? 'var(--text-secondary)' : 'var(--text-secondary)';
  } catch (e) {
    statusEl.textContent = (e && e.message) || settingsText('pinStatusFailed');
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
      statusEl.textContent = st.login
        ? settingsFormat('connectedAs', { login: st.login })
        : settingsText('connectedHidden');
      logoutBtn.style.display = '';
    } else {
      statusEl.textContent = st.clientIdSet
        ? settingsText('githubLoginHint')
        : settingsText('githubClientHint');
      logoutBtn.style.display = 'none';
    }
  } catch (e) {
    statusEl.textContent = settingsText('githubStatusFailed');
    errorEl.textContent = (e && e.message) || String(e);
  }
}

async function _setAgentPatch(patch) {
  const statusEl = document.getElementById('prefs-agent-status');
  try {
    const res = await window.assistant.invoke('set-config', patch);
    if (res && res.ok === false) {
      statusEl.textContent = res.error || settingsText('errorLabel');
      statusEl.style.color = '#ef4444';
      return;
    }
    statusEl.textContent = '';
  } catch (e) {
    statusEl.textContent = (e && e.message) || settingsText('errorLabel');
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

  document.getElementById('prefs-llm-credentials').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const row = button.closest('.llm-credential-row');
    button.disabled = true;
    try {
      if (button.dataset.action === 'replace') await _replaceLlmKey(row);
      else await _removeLlmKey(row);
    } catch (error) {
      const statusEl = document.getElementById('prefs-llm-status');
      statusEl.textContent = error.message || settingsText('credentialsUpdateFailed');
      statusEl.style.color = '#ef4444';
    } finally {
      button.disabled = false;
    }
  });

  document.querySelectorAll('#prefs-autonomy .prefs-seg').forEach((seg) => {
    seg.addEventListener('click', async () => {
      const mode = seg.dataset.mode;
      const res = await window.assistant.invoke('set-config', { autonomy: mode });
      if (!res || res.ok === false) {
        const statusEl = document.getElementById('prefs-agent-status');
        statusEl.textContent = (res && res.error) || settingsText('errorLabel');
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
      statusEl.textContent = settingsText('enterPin');
      statusEl.style.color = '#ef4444';
      return;
    }
    try {
      const res = await window.assistant.invoke('pin-set', pin);
      statusEl.textContent = res.ok ? settingsText('pinSaved') : res.error || settingsText('errorLabel');
      statusEl.style.color = res.ok ? 'var(--text-secondary)' : '#ef4444';
      if (res.ok) {
        input.value = '';
        document.getElementById('prefs-pin-clear-btn').style.display = '';
      }
    } catch (e) {
      statusEl.textContent = (e && e.message) || settingsText('errorLabel');
      statusEl.style.color = '#ef4444';
    }
  });

  document.getElementById('prefs-pin-clear-btn').addEventListener('click', async () => {
    const statusEl = document.getElementById('prefs-pin-status');
    try {
      const res = await window.assistant.invoke('pin-clear');
      statusEl.textContent = res.ok ? settingsText('pinRemoved') : res.error || settingsText('errorLabel');
      statusEl.style.color = res.ok ? 'var(--text-secondary)' : '#ef4444';
      if (res.ok) {
        document.getElementById('prefs-pin-clear-btn').style.display = 'none';
      }
    } catch (e) {
      statusEl.textContent = (e && e.message) || settingsText('errorLabel');
      statusEl.style.color = '#ef4444';
    }
  });

  document.getElementById('prefs-gh-logout-btn').addEventListener('click', async () => {
    const errorEl = document.getElementById('prefs-gh-error');
    try {
      await window.assistant.runCommand('/github logout');
      errorEl.textContent = '';
      _loadGhStatus();
      document.getElementById('prefs-gh-status').textContent = settingsText('signedOut');
    } catch (e) {
      errorEl.textContent = (e && e.message) || String(e);
    }
  });

  document.getElementById('onboarding-models').addEventListener('click', () => {
    onboardingModal.classList.remove('visible');
    openSettings();
  });
  document.getElementById('onboarding-permissions').addEventListener('click', () => {
    onboardingModal.classList.remove('visible');
    openPermsModal();
  });
  document.getElementById('onboarding-later').addEventListener('click', () => {
    onboardingModal.classList.remove('visible');
  });
  document.getElementById('onboarding-finish').addEventListener('click', async (event) => {
    event.currentTarget.disabled = true;
    try {
      await _completeOnboarding();
    } finally {
      event.currentTarget.disabled = false;
    }
  });

  document.getElementById('prefs-reset-permissions-btn').addEventListener('click', async () => {
    const status = document.getElementById('prefs-maintenance-status');
    if (!window.confirm(settingsText('confirmResetPermissions'))) return;
    const result = await window.assistant.invoke('maintenance-reset-permissions');
    status.textContent = result?.ok
      ? settingsFormat('permissionsReset', { count: result.removed })
      : result?.error || settingsText('permissionsResetFailed');
  });

  document.getElementById('prefs-clear-cache-btn').addEventListener('click', async () => {
    const status = document.getElementById('prefs-maintenance-status');
    const result = await window.assistant.invoke('maintenance-clear-cache');
    status.textContent = result?.ok
      ? settingsText('cacheCleared')
      : settingsText('cachePartiallyCleared');
  });

  document.getElementById('prefs-previous-versions-btn').addEventListener('click', async () => {
    await window.assistant.invoke('update:open-releases');
  });

  document.getElementById('prefs-factory-reset-btn').addEventListener('click', async () => {
    const status = document.getElementById('prefs-maintenance-status');
    const confirmation = document.getElementById('prefs-factory-confirm').value.trim();
    if (confirmation !== 'BORRAR TODO') {
      status.textContent = settingsText('confirmEraseText');
      status.style.color = '#ef4444';
      return;
    }
    if (!window.confirm(settingsText('confirmFactoryReset'))) {
      return;
    }
    const result = await window.assistant.invoke('maintenance-factory-reset', { confirmation });
    status.textContent = result?.ok
      ? settingsText('restartingAfterReset')
      : result?.error || settingsText('factoryResetFailed');
  });

  _showOnboardingIfNeeded();
  document.addEventListener('kaoru-language-changed', () => {
    if (prefsModal.classList.contains('visible')) _loadPrefs();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', attachPrefsEvents);
} else {
  attachPrefsEvents();
}
