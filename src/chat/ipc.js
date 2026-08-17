// @ts-nocheck
// IPC listeners
document
  .getElementById('close-btn')
  .addEventListener('click', () => ipcRenderer.send('chat-close'));
ipcRenderer.on('init-theme', (e, theme) => setTheme(theme));
ipcRenderer.on('chat-message', (e, text) => processMessage(text));
ipcRenderer.on('model-changed', (e, info) => {
  _modelInfo = info && info.model3Path ? info : _modelInfo;
  _modelNames = ((info && info.models) || []).map((m) => m.name);
  reloadModel();
});

ipcRenderer.on('views-changed', (e, s) => {
  if (!s || !s.mode) return;
  viewMode = s.mode;
  if (viewMode !== 'random' && VIEW[viewMode] && model) {
    applyView(viewMode, viewMode !== currentView);
  }
  _refreshViewButtons();
});

// Clic en los botones de modelo que renderiza /cambio-modelo → carga al instante
messagesEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-model-set]');
  if (!btn || btn.classList.contains('active')) return;
  btn.disabled = true;
  try {
    const res = await ipcRenderer.invoke('model-set', { id: btn.getAttribute('data-model-set') });
    if (res.error) {
      addMessage('assistant', `Error al cambiar modelo: ${res.error}`);
      return;
    }
    addMessage('assistant', `Modelo cambiado a: **${res.info.name}**`);
  } catch (err) {
    addMessage('assistant', `Error al cambiar modelo: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
});

// Clic en los botones de selección de vista que renderiza /modelo-vistas
messagesEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-view-mode]');
  if (!btn) return;
  const mode = btn.getAttribute('data-view-mode');
  const activeBtn = btn.closest('.view-toggle-group');
  if (activeBtn)
    activeBtn.querySelectorAll('[data-view-mode]').forEach((b) => {
      b.disabled = true;
    });
  try {
    const res = await ipcRenderer.invoke('views-set', { mode });
    if (res.error) {
      addMessage('assistant', `Error: ${res.error}`);
      return;
    }
    viewMode = res.mode;
    if (viewMode !== 'random' && VIEW[viewMode] && model)
      applyView(viewMode, viewMode !== currentView);
    _refreshViewButtons();
  } catch (err) {
    addMessage('assistant', `Error: ${err.message}`);
  } finally {
    if (activeBtn)
      activeBtn.querySelectorAll('[data-view-mode]').forEach((b) => {
        b.disabled = false;
      });
  }
});

function _refreshViewButtons() {
  document.querySelectorAll('.view-toggle-group').forEach((group) => {
    group.querySelectorAll('[data-view-mode]').forEach((b) => {
      const m = b.getAttribute('data-view-mode');
      const active = m === viewMode;
      b.classList.toggle('active', active);
      b.textContent = `${VIEW_LABELS[m] || m}${active ? ' ✓' : ''}`;
    });
  });
}

// Fase 3
ipcRenderer.on('openclaw-status', (e, status) => {
  const { available, sandbox, sandboxReason } = status || {};
  openclawAvailable = Boolean(available);
  openclawSandbox = sandbox === undefined || sandbox === null ? null : Boolean(sandbox);
  openclawSandboxReason = sandboxReason || null;
  updateSandboxBanner();
  if (!openclawAvailable) setAgentMode('chat');
});

// Badge de modo agente (Tab alterna). Se refleja también en el body dataset
// para que el CSS pueda diferenciar el estado.
onAgentMode((mode) => {
  const badge = document.getElementById('agent-mode-badge');
  if (badge) {
    badge.textContent = mode === 'agent' ? 'AGENTE' : 'CHAT';
    badge.classList.toggle('chat', mode !== 'agent');
    badge.title =
      mode === 'agent'
        ? 'Modo agente: usa herramientas (escribir, editar, bash). Tab para cambiar a chat.'
        : 'Modo chat: solo conversación, sin herramientas. Tab para cambiar a agente.';
  }
  document.body.dataset.agentMode = mode;
});

// El badge también alterna el modo al hacer clic (además de Tab).
const _modeBadge = document.getElementById('agent-mode-badge');
if (_modeBadge) _modeBadge.addEventListener('click', () => toggleAgentMode());

// Agent Loop IPC (Fase 2 → Cambio 1/2 del rediseño: ActivityBlocks + estados)
// renderActivityBlock/resetActivityBlocks vienen de chat/activityBlock.js
// (script hermano, cargado antes que este archivo — ver chat.html).
// agentStates viene de core/behavior/agentStates.js vía el loader async de
// core.js (initCoreModules). Los events de agent-progress solo llegan durante
// un agent-run (muy después de cargar la página), así que el guard es seguro.
let _activityContainerEl = null;

ipcRenderer.on('agent-progress', (e, progress) => {
  const state = agentStates ? agentStates.stateFromProgress(progress) : null;
  if (chatGestureEngine)
    chatGestureEngine.onEvent('agent-progress', { state, status: progress.status });
  // Recordar el último archivo escrito para que el frame de preview HTML
  // muestre su ruta (write/apply_patch llevan el path en params).
  if (
    progress.phase === 'end' &&
    progress.status === 'ok' &&
    progress.tool &&
    /^(write|apply_patch)$/i.test(progress.tool)
  ) {
    const p = progress.params || {};
    const path = p.path || p.file_path || p.file || '';
    if (path) window.__lastWritePath = path;
  }
  renderActivityBlock(_activityContainerEl, progress);
});

// HUD del plan explícito (plan-then-act): AgentLoop reenvía por 'agent-plan'
// los pasos del plan y el conteo completado; se pintan como widget en el feed.
ipcRenderer.on('agent-plan', (e, plan) => {
  renderPlanBlock(plan);
});

function setActivityContainer(el) {
  _activityContainerEl = el;
}

ipcRenderer.on('agent-approval-needed', (e, { actionId, tool, params, description }) => {
  _showApprovalCard({ id: actionId, tool, params, description });
});

// El timeout de aprobación expiró en main (sin respuesta del usuario): el card
// se marca como expirado en vez de quedar activo aceptando clics que no van a
// ningún lado. La acción NO se ejecutó.
ipcRenderer.on('agent-approval-expired', (e, { actionId }) => {
  _expireApprovalCard(actionId);
});

ipcRenderer.on('initiative', (e, payload) => {
  if (!payload || typeof payload.suggestion !== 'string' || !payload.suggestion) return;
  if (chatGestureEngine) chatGestureEngine.onEvent('initiative');
  (async () => {
    const { bubble } = addMessage('assistant', '');
    const badge = document.createElement('span');
    badge.style.cssText =
      'display:inline-block;font-family:var(--font-mono);font-size:9px;color:var(--accent);border:1px solid var(--border-accent);border-radius:3px;padding:1px 5px;margin-right:6px;opacity:.7;vertical-align:middle;';
    badge.textContent = 'AP';
    bubble.classList.add('markdown');
    bubble.appendChild(badge);
    const textSpan = document.createElement('span');
    bubble.appendChild(textSpan);
    // Revelar el texto renderizando markdown en vivo (limpio mientras se
    // escribe, con cursor parpadeante); al terminar ya queda renderizado.
    const parsedIni = _parseGestureMarkers(payload.suggestion);
    const reveal = revealText(textSpan, parsedIni.clean, {
      markdown: true,
      gestures: parsedIni.markers,
      onGesture: _playGesture,
    });
    await reveal.done;
    bubble.querySelectorAll('.mermaid').forEach((el) => _renderMermaid(el));
    messagesEl.scrollTop = messagesEl.scrollHeight;
    speak(parsedIni.clean);
    pushToSession('assistant', parsedIni.clean);
    ipcRenderer.send('memory-add-turn', { role: 'assistant', content: parsedIni.clean });

    // Fase A: si la iniciativa trae una propuesta, se muestran botones de
    // consentimiento. El voto es feedback para ajustar la frecuencia futura;
    // la ejecución de la acción declarada llega en la Fase B.
    if (payload.proposal) {
      _renderProposal(payload.proposal, bubble);
    }
  })();
});

// Propuestas proactivas (Fase A)
// proposalId → wrap (div .proposal-actions) para poder confirmar el resultado
// real de la ejecución (Fase B) en el bubble correcto.
const _proposalActions = new Map();

function _renderProposal(proposal, bubble) {
  const wrap = document.createElement('div');
  wrap.className = 'proposal-actions';

  if (proposal.preview) {
    const preview = document.createElement('div');
    preview.className = 'proposal-preview';
    preview.textContent = proposal.preview;
    wrap.appendChild(preview);
  }

  if (proposal.diff) {
    const diff = document.createElement('pre');
    diff.className = 'proposal-diff';
    diff.textContent = proposal.diff;
    wrap.appendChild(diff);
  }

  const btns = document.createElement('div');
  btns.className = 'proposal-btns';

  const accept = document.createElement('button');
  accept.className = 'btn-proposal-accept';
  accept.textContent = 'Sí, hazlo';
  accept.addEventListener('click', () => sendProposalDecision(proposal, 'accepted', wrap, accept));

  const deny = document.createElement('button');
  deny.className = 'btn-proposal-deny';
  deny.textContent = 'No, gracias';
  deny.addEventListener('click', () => sendProposalDecision(proposal, 'rejected', wrap, deny));

  btns.appendChild(accept);
  btns.appendChild(deny);
  wrap.appendChild(btns);
  bubble.appendChild(wrap);

  _proposalActions.set(proposal.id, wrap);
  if (_proposalActions.size > 50) {
    const oldest = _proposalActions.keys().next().value;
    _proposalActions.delete(oldest);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function sendProposalDecision(proposal, decision, wrap, clickedBtn) {
  ipcRenderer.send('initiative-decision', {
    proposalId: proposal.id,
    type: proposal.type,
    decision,
  });

  wrap.querySelectorAll('button').forEach((b) => {
    b.disabled = true;
  });
  clickedBtn.classList.remove('btn-proposal-accept', 'btn-proposal-deny');
  if (decision === 'accepted') {
    clickedBtn.classList.add('btn-proposal-accept');
    clickedBtn.style.opacity = '1';
  }

  const status = document.createElement('span');
  status.className = decision === 'accepted' ? 'proposal-status ok' : 'proposal-status no';
  status.textContent =
    decision === 'accepted'
      ? '✓ Aceptado — en proceso.'
      : 'Descartado — seré más selectiva con esto.';
  wrap.appendChild(status);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// Fase B: resultado real de la ejecución de una propuesta aceptada — la
// confirmación llega con la verificación REAL (p. ej. git check-ignore), no
// de oído.
ipcRenderer.on('proposal-result', (e, { proposalId, ok, skipped, detail }) => {
  if (chatGestureEngine) chatGestureEngine.onEvent('proposal-result', { ok });
  const wrap = _proposalActions.get(proposalId);
  if (!wrap) return;
  _proposalActions.delete(proposalId);

  const prev = wrap.querySelector('.proposal-status');
  if (prev) prev.remove();

  const status = document.createElement('span');
  status.className = ok ? 'proposal-status ok' : 'proposal-status err';
  status.textContent = skipped
    ? `↺ ${detail || 'Ya estaba hecho.'}`
    : ok
      ? `✓ ${detail || 'Listo.'}`
      : `✗ ${detail || 'Algo falló.'}`;
  wrap.appendChild(status);
  messagesEl.scrollTop = messagesEl.scrollHeight;
});

// Init
window.addEventListener('DOMContentLoaded', loadModel);
setActivityContainer(document.getElementById('messages'));

// ── Roundtrip main → página (sandbox:true) ─────────────────────────────────
// El main construye el ctx de CommandRegistry con stubs de funciones de página
// (ver ipc/chat-handlers.js). Cada stub envía un chat-ui-call; aquí se ejecuta
// la función real del renderer y se responde con chat-ui-call-result. Las
// funciones NO viajan por el bridge: solo nombres, y los argumentos son datos
// serializables.
assistant.onUiCall(({ id, fn, args }) => {
  Promise.resolve()
    .then(() => {
      switch (fn) {
        case 'addMessage':
          return addMessage(...(args || []));
        case 'processMessage':
          return processMessage(...(args || []));
        case 'openSettings':
          return openSettings();
        case 'openSessions':
          return openSessions();
        case 'openNodes':
          return openNodes();
        case 'hideNodes':
          return hideNodes();
        case 'openMcp':
          return openMcpModal();
        case 'openPerms':
          return openPermsModal();
        case 'pickWorkspace':
          return ipcRenderer.invoke('pick-workspace-folder');
        case 'gesture-play':
          if (!chatGestureEngine) return { ok: false, reason: 'sin motor de gestos' };
          return chatGestureEngine.play(args[0], args[1] || {});
        case 'setTtsMuted':
          return setTtsMuted(args[0]);
        case 'ipc-invoke':
          return ipcRenderer.invoke(...(args || []));
        case 'ipc-send':
          return ipcRenderer.send(...(args || []));
        default:
          throw new Error('ui-call desconocido: ' + fn);
      }
    })
    .then((result) => assistant.uiCallResult(id, result === undefined ? null : result))
    .catch((err) => assistant.uiCallResult(id, { __error: (err && err.message) || String(err) }));
});

// ── Auto-update (banner) ─────────────────────────────────────────────────────
const _updateBanner = document.getElementById('update-banner');
const _updateText = document.getElementById('update-text');
const _updateProgress = document.getElementById('update-progress');
const _updateDlBtn = document.getElementById('update-dl-btn');
const _updateRestartBtn = document.getElementById('update-restart-btn');
const _updateCloseBtn = document.getElementById('update-close-btn');

function _showUpdate(state, p) {
  _updateText.textContent = p.text;
  _updateProgress.textContent = p.progress || '';
  _updateDlBtn.style.display = p.showDl ? '' : 'none';
  _updateRestartBtn.style.display = p.showRestart ? '' : 'none';
  _updateBanner.classList.toggle('visible', !!p.show);
}

_updateDlBtn.addEventListener('click', () => ipcRenderer.invoke('update:download'));
_updateRestartBtn.addEventListener('click', () => ipcRenderer.invoke('update:install'));
_updateCloseBtn.addEventListener('click', () => _updateBanner.classList.remove('visible'));

ipcRenderer.on('update-status', (e, st) => {
  const cur = st.info && st.info.version ? ` v${st.info.version}` : '';
  switch (st.state) {
    case 'available':
      _showUpdate(st, {
        show: true,
        text: `Actualización disponible${cur} — reinicia la app para descargarla.`,
        showDl: true,
      });
      break;
    case 'downloading':
      _showUpdate(st, {
        show: true,
        text: `Descargando actualización${cur}...`,
        progress: st.percent != null ? `${st.percent}%` : '',
      });
      break;
    case 'downloaded':
      _showUpdate(st, {
        show: true,
        text: `Actualización v${st.version || ''} lista para instalar.`,
        showRestart: true,
      });
      break;
    case 'error':
      _showUpdate(st, {
        show: true,
        text: `Error al actualizar: ${(st.error || '').slice(0, 80)}`,
      });
      break;
    case 'postponed':
      _showUpdate(st, { show: false });
      break;
    default:
      _showUpdate(st, { show: false });
  }
});
