// IPC listeners
document.getElementById('close-btn').addEventListener('click', () => ipcRenderer.send('chat-close'));
ipcRenderer.on('init-theme',   (e, theme) => setTheme(theme));
ipcRenderer.on('chat-speak',   (e, text)  => speak(text));
ipcRenderer.on('chat-message', (e, text)  => processMessage(text));
ipcRenderer.on('model-changed', (e, info) => {
  _modelInfo = info && info.model3Path ? info : _modelInfo;
  _modelNames = (info && info.models || []).map(m => m.name);
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
    if (res.error) { addMessage('assistant', `Error al cambiar modelo: ${res.error}`); return; }
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
  if (activeBtn) activeBtn.querySelectorAll('[data-view-mode]').forEach(b => { b.disabled = true; });
  try {
    const res = await ipcRenderer.invoke('views-set', { mode });
    if (res.error) { addMessage('assistant', `Error: ${res.error}`); return; }
    viewMode = res.mode;
    if (viewMode !== 'random' && VIEW[viewMode] && model) applyView(viewMode, viewMode !== currentView);
    _refreshViewButtons();
  } catch (err) {
    addMessage('assistant', `Error: ${err.message}`);
  } finally {
    if (activeBtn) activeBtn.querySelectorAll('[data-view-mode]').forEach(b => { b.disabled = false; });
  }
});

function _refreshViewButtons() {
  document.querySelectorAll('.view-toggle-group').forEach(group => {
    group.querySelectorAll('[data-view-mode]').forEach(b => {
      const m = b.getAttribute('data-view-mode');
      const active = m === viewMode;
      b.classList.toggle('active', active);
      b.textContent = `${VIEW_LABELS[m] || m}${active ? ' ✓' : ''}`;
    });
  });
}

// Fase 3
ipcRenderer.on('openclaw-status', (e, { available }) => updateOpenClawBadge(available));

ipcRenderer.on('plan-step-start', (e, { planId, stepId }) => {
  if (planId !== activePlanId) return;
  const el = document.getElementById(`step-${stepId}`);
  if (!el) return;
  el.className = 'plan-step running';
  el.querySelector('.step-icon').textContent = '*';
});

ipcRenderer.on('plan-started', (e, payload) => {
  if (chatGestureEngine) chatGestureEngine.onEvent('plan:started');
});

ipcRenderer.on('plan-step-done', (e, { planId, stepId, status }) => {
  if (planId !== activePlanId) return;
  const el = document.getElementById(`step-${stepId}`);
  if (!el) return;
  el.className = `plan-step ${status}`;
  el.querySelector('.step-icon').textContent = { done:'D', failed:'F', skipped:'S' }[status] || '?';
  messagesEl.scrollTop = messagesEl.scrollHeight;
});

ipcRenderer.on('plan-approval-needed', (e, payload) => _showApprovalCard(payload));

// Agent Loop IPC (Fase 2)
let _agentProgressEl = null;
const _spinnerFrames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
function _startSpinner(el) {
  let i = 0;
  const interval = setInterval(() => {
    if (!el || !el.parentNode) { clearInterval(interval); return; }
    el.textContent = _spinnerFrames[i++ % _spinnerFrames.length];
  }, 100);
}

ipcRenderer.on('agent-progress', (e, { iteration, tool, status }) => {
  if (chatGestureEngine) chatGestureEngine.onEvent('agent-progress', { status });
  if (_agentProgressEl) {
    _agentProgressEl.textContent = status === 'ok'
      ? `Paso ${iteration}: ${tool} completado`
      : `⋯ Paso ${iteration}: ejecutando ${tool}...`;
  }
});

ipcRenderer.on('agent-approval-needed', (e, { actionId, tool, description }) => {
  const approved = confirm(`El asistente quiere ejecutar:\n\n${description}\n\n¿Aprobar esta acción?`);
  ipcRenderer.send('agent-approval-response', { id: actionId, approved });
});

ipcRenderer.on('plan-finished', (e, { planId }) => {
  if (chatGestureEngine) chatGestureEngine.onEvent('plan:finished');
  const card = document.getElementById(`plan-${planId}`);
  if (card) { const dot = card.querySelector('.plan-dot'); if (dot) dot.style.animation = 'none'; }
});

ipcRenderer.on('initiative', (e, payload) => {
  if (!payload || typeof payload.suggestion !== 'string' || !payload.suggestion) return;
  if (chatGestureEngine) chatGestureEngine.onEvent('initiative');
  (async () => {
    const { bubble } = addMessage('assistant', '');
    const badge = document.createElement('span');
    badge.style.cssText = 'display:inline-block;font-family:var(--font-mono);font-size:9px;color:var(--accent);border:1px solid var(--border-accent);border-radius:3px;padding:1px 5px;margin-right:6px;opacity:.7;vertical-align:middle;';
    badge.textContent = 'AP';
    bubble.classList.add('markdown');
    bubble.appendChild(badge);
    const textSpan = document.createElement('span');
    bubble.appendChild(textSpan);
    // Escribir el texto en el span
    bubble.classList.remove('markdown');
    bubble.classList.add('typewriter-cursor');
    let buf = '';
    for (const char of payload.suggestion) {
      buf += char;
      textSpan.textContent = buf;
      messagesEl.scrollTop = messagesEl.scrollHeight;
      await new Promise(r => setTimeout(r, 18 + Math.random() * 8));
    }
    bubble.classList.remove('typewriter-cursor');
    bubble.classList.add('markdown');
    textSpan.outerHTML = `<span class="md-inline"></span>`;
    const inlineSpan = bubble.querySelector('.md-inline');
    inlineSpan.innerHTML = renderMarkdown(payload.suggestion);
    inlineSpan.querySelectorAll('.mermaid').forEach(el => _renderMermaid(el));
    messagesEl.scrollTop = messagesEl.scrollHeight;
    speak(payload.suggestion);
    pushToSession('assistant', payload.suggestion);
    ipcRenderer.send('memory-add-turn', { role: 'assistant', content: payload.suggestion });

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
    type:       proposal.type,
    decision,
  });

  wrap.querySelectorAll('button').forEach(b => { b.disabled = true; });
  clickedBtn.classList.remove('btn-proposal-accept', 'btn-proposal-deny');
  if (decision === 'accepted') {
    clickedBtn.classList.add('btn-proposal-accept');
    clickedBtn.style.opacity = '1';
  }

  const status = document.createElement('span');
  status.className = decision === 'accepted' ? 'proposal-status ok' : 'proposal-status no';
  status.textContent = decision === 'accepted'
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
  status.textContent = skipped ? `↺ ${detail || 'Ya estaba hecho.'}` : (ok ? `✓ ${detail || 'Listo.'}` : `✗ ${detail || 'Algo falló.'}`);
  wrap.appendChild(status);
  messagesEl.scrollTop = messagesEl.scrollHeight;
});

// Init
window.addEventListener('DOMContentLoaded', loadModel);
