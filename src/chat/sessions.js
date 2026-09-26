// @ts-nocheck
/* global clearAttachments, MAX_SESSION_HISTORY */
// Chats persistentes. El main cambia la sesión y el workspace como una operación.
const sessionsModal = document.getElementById('sessions-modal');
const sessionsListEl = document.getElementById('sessions-list');
const sessionsCloseBtn = document.getElementById('sessions-close');
let currentConversationId = null;
let displayedWorkspace = null;
let conversationLoading = false;
let conversationBusy = 0;
let choosingWorkspace = false;
let sessionsRenderId = 0;
const collapsedWorkspaceGroups = new Set();

function openSessions() {
  const modelPanel = document.getElementById('model-panel');
  if (modelPanel) {
    const width = modelPanel.getBoundingClientRect().width;
    if (width > 1)
      document.getElementById('app').style.setProperty('--avatar-panel-width', `${width}px`);
  }
  sessionsModal.classList.add('visible');
  document.getElementById('app').classList.add('sessions-open');
  document.getElementById('sessions-btn').setAttribute('aria-expanded', 'true');
  renderSessions();
}

function closeSessions() {
  sessionsModal.classList.remove('visible');
  document.getElementById('app').classList.remove('sessions-open');
  document.getElementById('sessions-btn').setAttribute('aria-expanded', 'false');
}

function showConversation(conversation) {
  if (conversation?.id === currentConversationId && conversation.workspace === displayedWorkspace) {
    closeSessions();
    renderSessions();
    return;
  }
  currentConversationId = conversation?.id || null;
  displayedWorkspace = conversation?.workspace || null;
  const landing = document.getElementById('landing');
  messagesEl.replaceChildren();
  if (landing) {
    messagesEl.appendChild(landing);
    landing.classList.toggle('hidden', Boolean(conversation?.history?.length));
  }
  sessionHistory.length = 0;
  resetPlanBlock();
  resetDiffBlocks();
  resetActivities();
  if (typeof clearAttachments === 'function') clearAttachments();
  for (const turn of conversation?.history || []) {
    if (!turn?.content) continue;
    sessionHistory.push({ role: turn.role, content: turn.content });
    addMessage(turn.role === 'user' ? 'user' : 'assistant', turn.content);
  }
  if (sessionHistory.length > MAX_SESSION_HISTORY) {
    sessionHistory.splice(0, sessionHistory.length - MAX_SESSION_HISTORY);
  }
  const blocked = !conversation;
  const input = document.getElementById('msg-input');
  if (input) {
    input.value = '';
    input.disabled = blocked;
    input.placeholder = blocked ? 'Elige una carpeta para comenzar' : 'Escribe a Kaoru…';
  }
  document.getElementById('new-chat-btn').disabled = blocked;
  _applyWorkspaceUI(conversation?.workspace || null);
  if (blocked) openSessions();
  else {
    closeSessions();
    renderSessions();
  }
}

async function renderSessions() {
  const requestId = ++sessionsRenderId;
  sessionsListEl.textContent = 'Cargando chats…';
  let sessions;
  try {
    sessions = await ipcRenderer.invoke('conversations-list');
  } catch (error) {
    if (requestId === sessionsRenderId)
      sessionsListEl.textContent = `No se pudieron cargar: ${error.message}`;
    return;
  }
  if (requestId !== sessionsRenderId) return;
  sessionsListEl.replaceChildren();
  if (!sessions.length) {
    const empty = document.createElement('p');
    empty.className = 'sessions-empty';
    empty.textContent = 'Abre una carpeta para comenzar tu primer chat.';
    sessionsListEl.appendChild(empty);
  }
  const groups = new Map();
  for (const session of sessions) {
    const key = session.workspace || 'Sin carpeta asociada';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(session);
  }
  for (const [workspace, conversations] of groups) {
    const heading = document.createElement('button');
    heading.type = 'button';
    heading.className = 'sessions-group';
    const label = document.createElement('span');
    label.className = 'sessions-group-label';
    label.textContent = conversations[0].workspace
      ? workspace.split(/[\\/]/).filter(Boolean).pop()
      : workspace;
    const count = document.createElement('span');
    count.className = 'sessions-group-count';
    count.textContent = String(conversations.length);
    const chevron = document.createElement('span');
    chevron.className = 'sessions-group-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    const rows = document.createElement('div');
    rows.className = 'sessions-group-rows';
    const collapsed = collapsedWorkspaceGroups.has(workspace);
    rows.hidden = collapsed;
    heading.setAttribute('aria-expanded', String(!collapsed));
    chevron.textContent = collapsed ? '▸' : '▾';
    heading.append(chevron, label, count);
    heading.title = workspace;
    heading.addEventListener('click', () => {
      rows.hidden = !rows.hidden;
      heading.setAttribute('aria-expanded', String(!rows.hidden));
      chevron.textContent = rows.hidden ? '▸' : '▾';
      if (rows.hidden) collapsedWorkspaceGroups.add(workspace);
      else collapsedWorkspaceGroups.delete(workspace);
    });
    sessionsListEl.append(heading, rows);
    for (const session of conversations) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'session-row';
      if (session.id === currentConversationId) row.classList.add('active');
      const title = document.createElement('span');
      title.className = 'session-row-title';
      title.textContent = session.title;
      title.title = session.title;
      const detail = document.createElement('span');
      detail.className = 'session-row-sub';
      detail.textContent = `${new Date(session.lastActiveAt).toLocaleDateString()} · ${session.turnCount} turnos${session.missingWorkspace ? ' · Carpeta no disponible' : ''}`;
      row.append(title, detail);
      row.addEventListener('click', async () => {
        if (session.id === currentConversationId) return closeSessions();
        if (session.missingWorkspace || !session.workspace) {
          if (conversationBusy)
            return showConversationError('Espera a que termine Kaoru o cancela la tarea');
          const picked = await chooseWorkspace();
          if (picked)
            await changeConversation('conversation-open', { id: session.id, workspace: picked });
          return;
        }
        await changeConversation('conversation-open', { id: session.id });
      });
      rows.appendChild(row);
    }
  }
}

function showConversationError(message) {
  if (!sessionsModal.classList.contains('visible')) openSessions();
  const error = document.getElementById('sessions-error');
  error.textContent = message;
  error.hidden = false;
}

async function chooseWorkspace() {
  if (choosingWorkspace) return null;
  choosingWorkspace = true;
  const button = document.getElementById('new-workspace-btn');
  button.disabled = true;
  try {
    return await ipcRenderer.invoke('choose-workspace-folder');
  } catch (error) {
    showConversationError(error.message || 'No se pudo abrir el selector de carpetas');
    return null;
  } finally {
    choosingWorkspace = false;
    button.disabled = false;
  }
}

async function changeConversation(channel, input = {}) {
  if (conversationBusy)
    return showConversationError('Espera a que termine Kaoru o cancela la tarea');
  if (conversationLoading) return;
  conversationLoading = true;
  document.getElementById('sessions-error').hidden = true;
  try {
    const result = await ipcRenderer.invoke(channel, input);
    if (!result?.ok) return showConversationError(result?.error || 'No se pudo abrir el chat');
    showConversation(result.conversation);
  } catch (error) {
    showConversationError(error.message);
  } finally {
    conversationLoading = false;
  }
}

document.getElementById('sessions-btn').addEventListener('click', () => {
  if (sessionsModal.classList.contains('visible')) closeSessions();
  else openSessions();
});
document
  .getElementById('new-chat-btn')
  .addEventListener('click', () => changeConversation('conversation-new'));
document.getElementById('new-workspace-btn').addEventListener('click', async () => {
  if (conversationBusy || conversationLoading || choosingWorkspace)
    return showConversationError('Espera a que termine Kaoru o cancela la tarea');
  const workspace = await chooseWorkspace();
  if (workspace) await changeConversation('conversation-new', { workspace });
});
sessionsCloseBtn.addEventListener('click', closeSessions);
ipcRenderer.on('conversation-opened', (_event, conversation) => showConversation(conversation));
ipcRenderer
  .invoke('conversation-current')
  .then((conversation) => {
    if (currentConversationId == null) showConversation(conversation || null);
  })
  .catch(() => {
    if (currentConversationId == null) showConversation(null);
  });
