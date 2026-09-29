// @ts-nocheck
/* global clearAttachments, MAX_SESSION_HISTORY */
// Chats persistentes. El main cambia la sesión y el workspace como una operación.
const sessionsModal = document.getElementById('sessions-modal');
const sessionsListEl = document.getElementById('sessions-list');
const sessionsCloseBtn = document.getElementById('sessions-close');
let currentConversationId = null;
let currentConversationType = null;
let displayedWorkspace = null;
let conversationLoading = false;
let conversationBusy = 0;
let choosingWorkspace = false;
let sessionsRenderId = 0;
let sessionsVisibleLimit = 100;
const collapsedWorkspaceGroups = new Set();
const terminalLinksKey = 'kaoru-terminal-chat-links';
const sessionText = (key, fallback) => window.kaoruI18n?.t(key) || fallback;
const sessionFormat = (key, values, fallback) => window.kaoruI18n?.format(key, values) || fallback;
let terminalLinks = {};
let companionTerminalId = null;
let terminalContext = null;
try {
  terminalLinks = JSON.parse(localStorage.getItem(terminalLinksKey) || '{}') || {};
} catch {
  terminalLinks = {};
}

function saveTerminalLinks() {
  try {
    localStorage.setItem(terminalLinksKey, JSON.stringify(terminalLinks));
  } catch {
    // La vinculación funciona durante esta ejecución aunque no se pueda persistir.
  }
}

function linkedTerminalFor(conversation) {
  if (conversation?.type !== 'chat') return null;
  for (const [id, link] of Object.entries(terminalLinks)) {
    if (link?.chatId === conversation.id && link.workspace === conversation.workspace)
      return Number(id);
  }
  return null;
}

function clearTerminalContext() {
  terminalContext = null;
  document.getElementById('terminal-context-card').hidden = true;
  document.getElementById('terminal-context-preview').textContent = '';
}

window.attachTerminalContext = (context) => {
  if (!context || typeof context.output !== 'string' || !context.output.trim()) return false;
  if (!Number.isSafeInteger(context.terminalId) || context.terminalId !== companionTerminalId)
    return false;
  const contextKind =
    context.label === window.kaoruI18n.t('selection') || context.label === 'Selección'
      ? 'selection'
      : 'recent';
  terminalContext = {
    terminalId: context.terminalId,
    row: Number.isSafeInteger(context.row) ? context.row : null,
    output: context.output.slice(-6000),
    kind: contextKind,
  };
  document.getElementById('terminal-context-label').textContent = window.kaoruI18n.t(
    contextKind === 'selection' ? 'terminalSelection' : 'terminalRecentOutput'
  );
  document.getElementById('terminal-context-preview').textContent = terminalContext.output;
  document.getElementById('terminal-context-card').hidden = false;
  return true;
};

window.takeTerminalContext = () => {
  const context = terminalContext;
  clearTerminalContext();
  if (!context) return null;
  return {
    anchor: {
      terminalId: context.terminalId,
      row: context.row,
      sample: context.output.split('\n').filter(Boolean).at(-1)?.slice(0, 80) || '',
    },
    text:
      `\n\n${window.kaoruI18n.t('attachedTerminalDataWarning')}\n` +
      context.output
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n'),
  };
};

document.getElementById('terminal-context-remove').addEventListener('click', clearTerminalContext);

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
  document.getElementById('new-session-menu').hidden = true;
  document.getElementById('new-chat-btn').setAttribute('aria-expanded', 'false');
  if (
    conversation?.id === currentConversationId &&
    conversation.workspace === displayedWorkspace &&
    conversation.type === currentConversationType
  ) {
    closeSessions();
    renderSessions();
    return;
  }
  currentConversationId = conversation?.id || null;
  window.pendingTerminalAnchor = null;
  window.activeTerminalAnswerAnchor = null;
  currentConversationType = conversation?.type || null;
  displayedWorkspace = conversation?.workspace || null;
  const terminal = currentConversationType === 'terminal';
  companionTerminalId = terminal ? null : linkedTerminalFor(conversation);
  document.getElementById('app').classList.toggle('terminal-mode', terminal);
  document
    .getElementById('app')
    .classList.toggle('terminal-companion', Boolean(companionTerminalId));
  document.getElementById('terminal-companion-header').hidden = !companionTerminalId;
  clearTerminalContext();
  document.getElementById('agent-mode-badge').textContent = terminal ? 'TERMINAL' : 'AUTO';
  window.setTerminalAvatarMode?.(terminal);
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
  const blocked = !conversation || terminal;
  const input = document.getElementById('msg-input');
  if (input) {
    input.value = '';
    input.disabled = blocked;
    input.placeholder = blocked
      ? window.kaoruI18n.t('chooseFolderHint')
      : window.kaoruI18n.t('writeToKaoru');
  }
  document.getElementById('new-chat-btn').disabled = !conversation;
  _applyWorkspaceUI(conversation?.workspace || null);
  if (!conversation) openSessions();
  else {
    closeSessions();
    renderSessions();
  }
  // Abrir xterm cuando el panel y el workspace ya tienen su tamaño definitivo.
  if (terminal && typeof window.activateTerminal === 'function')
    window.activateTerminal(conversation);
  else if (companionTerminalId && typeof window.activateTerminal === 'function')
    window.activateTerminal({ id: companionTerminalId, workspace: conversation.workspace });
  else if (typeof window.deactivateTerminal === 'function') window.deactivateTerminal();
}

async function renderSessions() {
  const requestId = ++sessionsRenderId;
  sessionsListEl.textContent = sessionText('loadingChats', 'Cargando chats…');
  let page;
  try {
    page = await ipcRenderer.invoke('conversations-page', { limit: sessionsVisibleLimit });
  } catch (error) {
    if (requestId === sessionsRenderId)
      sessionsListEl.textContent = sessionFormat(
        'chatsLoadFailed',
        { error: error.message },
        `No se pudieron cargar: ${error.message}`
      );
    return;
  }
  if (requestId !== sessionsRenderId) return;
  const sessions = page.conversations;
  sessionsListEl.replaceChildren();
  if (!sessions.length) {
    const empty = document.createElement('p');
    empty.className = 'sessions-empty';
    empty.textContent = page.total
      ? sessionText('noChatsOnPage', 'No quedan chats en esta página. Puedes mostrar más.')
      : sessionText('noChats', 'Abre una carpeta para comenzar tu primera sesión.');
    sessionsListEl.appendChild(empty);
  }
  const groups = new Map();
  for (const session of sessions) {
    const key = session.workspace || sessionText('noFolder', 'Sin carpeta asociada');
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
    count.textContent = String(page.counts[workspace] || conversations.length);
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
      const entry = document.createElement('div');
      entry.className = 'session-entry';
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'session-row';
      if (session.id === currentConversationId) row.classList.add('active');
      const title = document.createElement('span');
      title.className = 'session-row-title';
      title.textContent = `${session.type === 'terminal' ? '⌁ ' : '▤ '}${session.title}`;
      title.title = session.title;
      const detail = document.createElement('span');
      detail.className = 'session-row-sub';
      detail.textContent = `${new Date(session.lastActiveAt).toLocaleDateString(window.kaoruI18n?.language || undefined)} · ${session.type === 'terminal' ? sessionText('terminal', 'Terminal') : sessionFormat('turns', { count: session.turnCount }, `${session.turnCount} turnos`)}${session.missingWorkspace ? ` · ${sessionText('missingFolder', 'Carpeta no disponible')}` : ''}`;
      row.append(title, detail);
      row.addEventListener('click', async () => {
        if (session.id === currentConversationId) return closeSessions();
        if (session.missingWorkspace || !session.workspace) {
          if (conversationBusy)
            return showConversationError(
              sessionText('waitForKaoru', 'Espera a que termine Kaoru o cancela la tarea')
            );
          const picked = await chooseWorkspace();
          if (picked)
            await changeConversation('conversation-open', { id: session.id, workspace: picked });
          return;
        }
        await changeConversation('conversation-open', { id: session.id });
      });
      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.className = 'session-delete';
      deleteButton.textContent = '×';
      deleteButton.setAttribute(
        'aria-label',
        sessionFormat(
          session.type === 'terminal' ? 'deleteTerminal' : 'deleteChat',
          { title: session.title },
          `Eliminar ${session.type === 'terminal' ? 'terminal' : 'chat'}: ${session.title}`
        )
      );
      deleteButton.title = deleteButton.getAttribute('aria-label');
      deleteButton.addEventListener('click', async () => {
        if (conversationBusy)
          return showConversationError(
            sessionText('waitForKaoru', 'Espera a que termine Kaoru o cancela la tarea')
          );
        if (conversationLoading) return;
        conversationLoading = true;
        deleteButton.disabled = true;
        document.getElementById('sessions-error').hidden = true;
        try {
          const result = await ipcRenderer.invoke('conversation-delete', { id: session.id });
          if (result?.cancelled) return;
          if (!result?.ok) {
            showConversationError(
              result?.error ||
                sessionText('chatDeleteFailed', 'No se pudo eliminar la conversación')
            );
            return;
          }
          sessionsVisibleLimit = Math.max(0, sessionsVisibleLimit - 1);
          for (const [terminalId, link] of Object.entries(terminalLinks)) {
            if (Number(terminalId) === session.id || link.chatId === session.id)
              delete terminalLinks[terminalId];
          }
          saveTerminalLinks();
          if (result.wasActive) showConversation(result.conversation || null);
          else renderSessions();
        } catch (error) {
          showConversationError(
            error.message || sessionText('chatDeleteFailed', 'No se pudo eliminar la conversación')
          );
        } finally {
          conversationLoading = false;
          deleteButton.disabled = false;
        }
      });
      entry.append(row, deleteButton);
      rows.appendChild(entry);
    }
  }
  if (sessions.length < page.total) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'sessions-load-more';
    more.textContent = sessionFormat(
      'loadMore',
      { shown: sessions.length, total: page.total },
      `Mostrar más · ${sessions.length} de ${page.total}`
    );
    more.addEventListener('click', () => {
      sessionsVisibleLimit += 100;
      renderSessions();
    });
    sessionsListEl.appendChild(more);
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
    showConversationError(error.message || window.kaoruI18n.t('couldNotOpenFolderPicker'));
    return null;
  } finally {
    choosingWorkspace = false;
    button.disabled = false;
  }
}

async function changeConversation(channel, input = {}) {
  if (conversationBusy) {
    showConversationError(
      sessionText('waitForKaoru', 'Espera a que termine Kaoru o cancela la tarea')
    );
    return false;
  }
  if (conversationLoading) return false;
  conversationLoading = true;
  document.getElementById('sessions-error').hidden = true;
  try {
    const result = await ipcRenderer.invoke(channel, input);
    if (!result?.ok) {
      showConversationError(
        result?.error || sessionText('chatOpenFailed', 'No se pudo abrir el chat')
      );
      return false;
    }
    showConversation(result.conversation);
    return true;
  } catch (error) {
    showConversationError(error.message);
    return false;
  } finally {
    conversationLoading = false;
  }
}

window.openTerminalCompanion = async ({ terminalId, workspace }) => {
  if (!Number.isSafeInteger(terminalId) || terminalId <= 0 || !workspace) return false;
  const link = terminalLinks[terminalId];
  const opened =
    link?.workspace === workspace
      ? await changeConversation('conversation-open', { id: link.chatId })
      : false;
  if (!opened && !(await changeConversation('conversation-new', { type: 'chat', workspace })))
    return false;
  terminalLinks[terminalId] = { chatId: currentConversationId, workspace };
  saveTerminalLinks();
  if (companionTerminalId !== terminalId) {
    companionTerminalId = terminalId;
    document.getElementById('app').classList.add('terminal-companion');
    document.getElementById('terminal-companion-header').hidden = false;
    await window.activateTerminal?.({ id: terminalId, workspace });
  }
  return true;
};

window.openTerminalDraft = async ({ text, workspace, terminalId, output, row, label }) => {
  if (!(await window.openTerminalCompanion({ terminalId, workspace }))) return false;
  if (output) window.attachTerminalContext({ terminalId, output, row, label });
  const draft = document.getElementById('msg-input');
  if (typeof text === 'string' && text.trim()) {
    draft.value = text.slice(0, 1500);
    draft.dispatchEvent(new Event('input', { bubbles: true }));
  }
  draft.focus();
  return true;
};

window.returnToLinkedTerminal = async () => {
  if (!companionTerminalId) return false;
  return changeConversation('conversation-open', { id: companionTerminalId });
};
window.terminalCompanionFailed = (id) => {
  if (id !== companionTerminalId) return;
  delete terminalLinks[id];
  saveTerminalLinks();
  companionTerminalId = null;
  document.getElementById('app').classList.remove('terminal-companion');
  document.getElementById('terminal-companion-header').hidden = true;
  window.deactivateTerminal?.();
};
document.getElementById('terminal-return').addEventListener('click', () => {
  window.returnToLinkedTerminal();
});

document.getElementById('sessions-btn').addEventListener('click', () => {
  if (sessionsModal.classList.contains('visible')) closeSessions();
  else openSessions();
});
const newSessionMenu = document.getElementById('new-session-menu');
document.getElementById('new-chat-btn').addEventListener('click', () => {
  newSessionMenu.hidden = !newSessionMenu.hidden;
  document
    .getElementById('new-chat-btn')
    .setAttribute('aria-expanded', String(!newSessionMenu.hidden));
});
document.getElementById('new-session-chat').addEventListener('click', () => {
  newSessionMenu.hidden = true;
  document.getElementById('new-chat-btn').setAttribute('aria-expanded', 'false');
  changeConversation('conversation-new', { type: 'chat' });
});
document.getElementById('new-session-terminal').addEventListener('click', () => {
  newSessionMenu.hidden = true;
  document.getElementById('new-chat-btn').setAttribute('aria-expanded', 'false');
  changeConversation('conversation-new', { type: 'terminal' });
});
document.getElementById('new-workspace-btn').addEventListener('click', async () => {
  if (conversationBusy || conversationLoading || choosingWorkspace)
    return showConversationError(window.kaoruI18n.t('waitForKaoru'));
  const workspace = await chooseWorkspace();
  if (workspace) await changeConversation('conversation-new', { workspace });
});
document.getElementById('new-workspace-terminal-btn').addEventListener('click', async () => {
  if (conversationBusy || conversationLoading || choosingWorkspace) return;
  const workspace = await chooseWorkspace();
  if (workspace) await changeConversation('conversation-new', { workspace, type: 'terminal' });
});
document.getElementById('onboarding-terminal').addEventListener('click', async () => {
  try {
    const workspace = await chooseWorkspace();
    if (!workspace) return;
    if (!(await changeConversation('conversation-new', { workspace, type: 'terminal' }))) return;
    const saved = await ipcRenderer.invoke('set-config', { onboarding: { completed: true } });
    if (!saved?.ok) throw new Error(saved?.error || window.kaoruI18n.t('configSaveFailed'));
    document.getElementById('onboarding-modal').classList.remove('visible');
  } catch (error) {
    showConversationError(error.message || window.kaoruI18n.t('terminalOpenFailed'));
  }
});
sessionsCloseBtn.addEventListener('click', closeSessions);
ipcRenderer.on('conversation-opened', (_event, conversation) => showConversation(conversation));
document.addEventListener('kaoru-language-changed', () => {
  if (sessionsModal.classList.contains('visible')) renderSessions();
  if (terminalContext)
    document.getElementById('terminal-context-label').textContent = window.kaoruI18n.t(
      terminalContext.kind === 'selection' ? 'terminalSelection' : 'terminalRecentOutput'
    );
});
ipcRenderer
  .invoke('conversation-current')
  .then((conversation) => {
    if (currentConversationId == null) showConversation(conversation || null);
  })
  .catch(() => {
    if (currentConversationId == null) showConversation(null);
  });
