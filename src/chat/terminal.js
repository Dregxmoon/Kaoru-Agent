// @ts-nocheck
/* global currentConversationType, currentConversationId, displayedWorkspace */
// Terminal local: xterm dibuja secuencias ANSI; el PTY vive solo en main.
let terminalView = null;
let terminalFit = null;
let terminalViewId = null;
let terminalActivation = 0;
let terminalSeq = 0;
let terminalReady = false;
const terminalPending = new Map();
const TERMINAL_HIGH_WATER = 256 * 1024;
const TERMINAL_LOW_WATER = 64 * 1024;
let terminalQueuedChars = 0;
let terminalFlowPaused = false;
const terminalScreen = document.getElementById('terminal-screen');
const terminalViewport = document.getElementById('terminal-viewport');
const terminalPanel = document.getElementById('terminal-panel');
const terminalError = document.getElementById('terminal-error');
const terminalRestart = document.getElementById('terminal-restart');
const terminalStatus = document.getElementById('terminal-status');
const terminalWorkspace = document.getElementById('terminal-workspace');
const terminalMotionControl = document.getElementById('terminal-avatar-motion');
const terminalViewControl = document.getElementById('terminal-avatar-view');
const terminalAppearanceToggle = document.getElementById('terminal-appearance-toggle');
const terminalAppearanceMenu = document.getElementById('terminal-appearance-menu');
const terminalFontDecrease = document.getElementById('terminal-font-decrease');
const terminalFontIncrease = document.getElementById('terminal-font-increase');
const terminalFontLabel = document.getElementById('terminal-font-size');
const terminalExplainError = document.getElementById('terminal-explain-error');
const terminalAttachOutput = document.getElementById('terminal-attach-output');
const terminalChatToggle = document.getElementById('terminal-chat-toggle');
const terminalSearchToggle = document.getElementById('terminal-search-toggle');
const terminalSearchControls = document.getElementById('terminal-search-controls');
const terminalSearchInput = document.getElementById('terminal-search-input');
const terminalSearchStatus = document.getElementById('terminal-search-status');
const terminalSearchPrev = document.getElementById('terminal-search-prev');
const terminalSearchNext = document.getElementById('terminal-search-next');
const terminalSignal = document.getElementById('terminal-signal');
const terminalLabel = (key, fallback) => window.kaoruI18n?.t(key) || fallback;
let terminalExitCode = null;
let terminalActivityTimer = null;
let terminalTypingTimer = null;
let terminalReactionTimer = null;
let terminalSearchMatches = [];
let terminalSearchIndex = -1;
let terminalSearchRefreshTimer = null;
let terminalSearchInputTimer = null;
let terminalBufferVersion = 0;
let terminalSearchScannedVersion = -1;
let terminalSearchQuery = '';

let terminalFontSize = 13;
try {
  const saved = Number(localStorage.getItem('kaoru-terminal-font-size'));
  if (Number.isInteger(saved) && saved >= 11 && saved <= 18) terminalFontSize = saved;
} catch {
  // La terminal conserva el tamaño predeterminado sin almacenamiento local.
}
terminalFontLabel.textContent = `${terminalFontSize} px`;

function setTerminalFontSize(size) {
  const next = Math.max(11, Math.min(18, size));
  if (next === terminalFontSize) return;
  terminalFontSize = next;
  terminalFontLabel.textContent = `${next} px`;
  if (terminalView) {
    terminalView.options.fontSize = next;
    requestAnimationFrame(fitTerminal);
  }
  try {
    localStorage.setItem('kaoru-terminal-font-size', String(next));
  } catch {
    // El zoom funciona aunque no sea posible guardar la preferencia.
  }
}

function closeTerminalAppearance() {
  terminalAppearanceMenu.hidden = true;
  terminalAppearanceToggle.setAttribute('aria-expanded', 'false');
}

terminalAppearanceToggle.addEventListener('click', () => {
  terminalAppearanceMenu.hidden = !terminalAppearanceMenu.hidden;
  terminalAppearanceToggle.setAttribute('aria-expanded', String(!terminalAppearanceMenu.hidden));
});
terminalFontDecrease.addEventListener('click', () => setTerminalFontSize(terminalFontSize - 1));
terminalFontIncrease.addEventListener('click', () => setTerminalFontSize(terminalFontSize + 1));
document.addEventListener('click', (event) => {
  if (
    !terminalAppearanceMenu.hidden &&
    event.target !== terminalAppearanceToggle &&
    !terminalAppearanceMenu.contains(event.target)
  )
    closeTerminalAppearance();
});
document.addEventListener(
  'keydown',
  (event) => {
    if (!terminalPanel.hidden && (event.ctrlKey || event.metaKey)) {
      if (event.code === 'Equal' || event.code === 'NumpadAdd') {
        event.preventDefault();
        event.stopPropagation();
        setTerminalFontSize(terminalFontSize + 1);
      } else if (event.code === 'Minus' || event.code === 'NumpadSubtract') {
        event.preventDefault();
        event.stopPropagation();
        setTerminalFontSize(terminalFontSize - 1);
      }
    }
    if (event.key === 'Escape' && !terminalAppearanceMenu.hidden) {
      event.preventDefault();
      event.stopPropagation();
      closeTerminalAppearance();
      terminalView?.focus();
    }
  },
  true
);

function terminalPreference(key, values, fallback) {
  try {
    const value = localStorage.getItem(key);
    return values.includes(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function saveTerminalPreference(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Los controles siguen funcionando durante esta sesión.
  }
}

terminalMotionControl.value = terminalPreference(
  'kaoru-terminal-motion',
  ['subtle', 'lively', 'off'],
  'subtle'
);
terminalViewControl.value = terminalPreference('kaoru-terminal-view', ['full', 'half'], 'full');
document.getElementById('app').dataset.terminalMotion = terminalMotionControl.value;
window.terminalAvatarViewPreference = terminalViewControl.value;
terminalMotionControl.addEventListener('change', () => {
  document.getElementById('app').dataset.terminalMotion = terminalMotionControl.value;
  saveTerminalPreference('kaoru-terminal-motion', terminalMotionControl.value);
});
terminalViewControl.addEventListener('change', () => {
  window.terminalAvatarViewPreference = terminalViewControl.value;
  window.setTerminalAvatarView?.(terminalViewControl.value);
  saveTerminalPreference('kaoru-terminal-view', terminalViewControl.value);
});

function setTerminalVisualActivity(activity) {
  window.setTerminalAvatarActivity?.(activity);
}

function reactTerminalAvatar(mood) {
  if (terminalViewId == null) return;
  const activity = mood === 'happy' ? 'success' : mood === 'sad' ? 'error' : null;
  if (!activity) return;
  if (terminalReactionTimer) clearTimeout(terminalReactionTimer);
  setTerminalVisualActivity(activity);
  terminalSignal.dataset.kind = activity;
  terminalSignal.textContent = window.kaoruI18n.t(
    activity === 'error' ? 'possibleError' : 'positiveSignal'
  );
  terminalSignal.hidden = false;
  if (activity === 'error') terminalExplainError.hidden = false;
  terminalReactionTimer = setTimeout(() => {
    terminalReactionTimer = null;
    terminalSignal.hidden = true;
    setTerminalVisualActivity(terminalActivityTimer ? 'working' : 'idle');
  }, 1400);
}
window.reactTerminalAvatar = reactTerminalAvatar;

function terminalContextSnapshot() {
  if (!terminalView) return null;
  const selected = terminalView.hasSelection() ? terminalView.getSelection() : '';
  if (selected.trim()) {
    return {
      output: selected.slice(-6000).trim(),
      row: terminalView.getSelectionPosition?.()?.end?.y ?? null,
      label: window.kaoruI18n.t('selection'),
    };
  }
  const buffer = terminalView.buffer.active;
  const start = Math.max(0, buffer.length - 40);
  const lines = [];
  for (let row = start; row < buffer.length; row++) {
    lines.push(buffer.getLine(row)?.translateToString(true) || '');
  }
  const lastContentIndex = lines.findLastIndex((line) => line.trim());
  return {
    output: lines.join('\n').slice(-6000).trim(),
    row: lastContentIndex < 0 ? null : start + lastContentIndex,
    label: window.kaoruI18n.t('recentOutput'),
  };
}

terminalExplainError.title = terminalLabel('explainDraft', 'Abrir un borrador en el chat');
terminalExplainError.addEventListener('click', async () => {
  const context = terminalContextSnapshot();
  if (!context?.output || !window.openTerminalDraft) return;
  const workspace = terminalWorkspace.title || displayedWorkspace;
  if (
    await window.openTerminalDraft({
      text: window.kaoruI18n.t('explainTerminalPrompt'),
      workspace,
      terminalId: terminalViewId,
      ...context,
    })
  )
    terminalExplainError.hidden = true;
});
terminalAttachOutput.addEventListener('click', async () => {
  const context = terminalContextSnapshot();
  if (!context?.output || !window.openTerminalDraft) return;
  await window.openTerminalDraft({
    text: window.kaoruI18n.t('askTerminalPrompt'),
    workspace: terminalWorkspace.title || displayedWorkspace,
    terminalId: terminalViewId,
    ...context,
  });
});
terminalChatToggle.addEventListener('click', () => {
  if (document.getElementById('app').classList.contains('terminal-companion'))
    window.returnToLinkedTerminal?.();
  else
    window.openTerminalCompanion?.({
      terminalId: terminalViewId,
      workspace: terminalWorkspace.title || displayedWorkspace,
    });
});

window.revealTerminalAnchor = (anchor) => {
  if (!terminalView || anchor?.terminalId !== terminalViewId) return false;
  const buffer = terminalView.buffer.active;
  const sample = String(anchor.sample || '')
    .split('\n')[0]
    .trim();
  let row = Number.isSafeInteger(anchor.row) ? anchor.row : -1;
  if (
    row < 0 ||
    row >= buffer.length ||
    !buffer.getLine(row)?.translateToString(true).includes(sample)
  ) {
    row = -1;
    for (let index = buffer.length - 1; index >= 0; index--) {
      if (sample && buffer.getLine(index)?.translateToString(true).includes(sample)) {
        row = index;
        break;
      }
    }
  }
  if (row < 0) return false;
  terminalView.scrollToLine(Math.max(0, row - Math.floor(terminalView.rows / 2)));
  terminalView.focus();
  return true;
};

window.sendSuggestedTerminalCommand = (command, execute = false) => {
  if (
    !terminalReady ||
    !terminalView ||
    typeof command !== 'string' ||
    !command.trim() ||
    command.length > 2048 ||
    Array.from(command).some(
      (char) => (char.charCodeAt(0) < 32 && char !== '\t') || char.charCodeAt(0) === 127
    )
  )
    return false;
  if (execute && !window.confirm(window.kaoruI18n.format('confirmRunCommand', { command })))
    return false;
  ipcRenderer.send('terminal-write', { id: terminalViewId, data: command + (execute ? '\r' : '') });
  terminalView.focus();
  return true;
};

function setTerminalState(state, label) {
  terminalPanel.dataset.state = state;
  if (state === 'exited') {
    terminalStatus.textContent = terminalLabel('shellClosed', window.kaoruI18n.t('shellClosed')).replace(
      '{code}',
      String(terminalExitCode)
    );
  } else {
    terminalStatus.textContent = terminalLabel(
      { connecting: 'connecting', ready: 'ready', error: 'unavailable' }[state],
      label
    );
  }
}
document.addEventListener('kaoru-language-changed', () => {
  terminalExplainError.title = terminalLabel('explainDraft', window.kaoruI18n.t('openDraft'));
  terminalChatToggle.textContent = terminalLabel(
    document.getElementById('app').classList.contains('terminal-companion') ? 'closeChat' : 'chat',
    window.kaoruI18n.t('chat')
  );
  if (terminalPanel.dataset.state)
    setTerminalState(terminalPanel.dataset.state, terminalStatus.textContent);
  renderTerminalSearchStatus();
  if (!terminalSignal.hidden)
    terminalSignal.textContent = window.kaoruI18n.t(
      terminalSignal.dataset.kind === 'error' ? 'possibleError' : 'positiveSignal'
    );
});

function markTerminalActivity() {
  if (terminalActivityTimer) clearTimeout(terminalActivityTimer);
  terminalPanel.classList.add('terminal-receiving');
  if (!terminalTypingTimer && !terminalReactionTimer) setTerminalVisualActivity('working');
  terminalActivityTimer = setTimeout(() => {
    terminalPanel.classList.remove('terminal-receiving');
    terminalActivityTimer = null;
    if (!terminalTypingTimer && !terminalReactionTimer) setTerminalVisualActivity('idle');
  }, 700);
}

function markTerminalTyping() {
  terminalScreen.classList.add('terminal-typing');
  if (!terminalReactionTimer) setTerminalVisualActivity('typing');
  if (terminalTypingTimer) clearTimeout(terminalTypingTimer);
  terminalTypingTimer = setTimeout(() => {
    terminalScreen.classList.remove('terminal-typing');
    terminalTypingTimer = null;
    if (!terminalReactionTimer)
      setTerminalVisualActivity(terminalActivityTimer ? 'working' : 'idle');
  }, 900);
}

function terminalTheme() {
  const style = getComputedStyle(document.documentElement);
  const color = (name) => style.getPropertyValue(name).trim();
  const light = ['light', 'sakura'].includes(document.documentElement.dataset.theme);
  const ansi = light
    ? {
        black: '#5e5c57',
        red: '#8f716d',
        green: '#66766a',
        yellow: '#8a7b61',
        blue: '#687985',
        magenta: '#7e7282',
        cyan: '#627b79',
        white: '#383735',
        brightBlack: '#85817b',
        brightRed: '#80615e',
        brightGreen: '#536858',
        brightYellow: '#766749',
        brightBlue: '#536a77',
        brightMagenta: '#6b5d73',
        brightCyan: '#4f6b67',
        brightWhite: '#242321',
      }
    : {
        black: '#514c5b',
        red: '#ef8189',
        green: '#83d6ae',
        yellow: '#edc780',
        blue: '#91b9f4',
        magenta: '#d5a5ea',
        cyan: '#83d6dd',
        white: '#e8e4ef',
        brightBlack: '#938b9f',
        brightRed: '#ff9ca3',
        brightGreen: '#a1e9be',
        brightYellow: '#ffda9b',
        brightBlue: '#aecbff',
        brightMagenta: '#e6b9f6',
        brightCyan: '#a1eaf0',
        brightWhite: '#ffffff',
      };
  return {
    ...ansi,
    background: color('--bg-panel'),
    foreground: color('--text-primary'),
    cursor: color('--text-primary'),
    cursorAccent: color('--bg-panel'),
    selectionBackground: color('--border-accent'),
  };
}

new MutationObserver(() => {
  if (terminalView) terminalView.options.theme = terminalTheme();
}).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

function updateTerminalFlow() {
  if (terminalViewId == null) return;
  if (!terminalFlowPaused && terminalQueuedChars > TERMINAL_HIGH_WATER) {
    terminalFlowPaused = true;
    ipcRenderer.send('terminal-flow', { id: terminalViewId, paused: true });
  } else if (terminalFlowPaused && terminalQueuedChars < TERMINAL_LOW_WATER) {
    terminalFlowPaused = false;
    ipcRenderer.send('terminal-flow', { id: terminalViewId, paused: false });
  }
}

function writeTerminalData(view, data, alreadyQueued = false) {
  if (!alreadyQueued) terminalQueuedChars += data.length;
  updateTerminalFlow();
  view.write(data, () => {
    if (terminalView !== view) return;
    terminalQueuedChars = Math.max(0, terminalQueuedChars - data.length);
    terminalBufferVersion++;
    updateTerminalFlow();
    if (
      !terminalSearchControls.hidden &&
      !terminalSearchInputTimer &&
      terminalSearchInput.value.trim()
    ) {
      if (terminalSearchRefreshTimer) clearTimeout(terminalSearchRefreshTimer);
      terminalSearchRefreshTimer = setTimeout(() => {
        terminalSearchRefreshTimer = null;
        refreshTerminalSearch();
      }, 120);
    }
  });
}

function closeTerminalSearch() {
  if (terminalSearchInputTimer) clearTimeout(terminalSearchInputTimer);
  terminalSearchInputTimer = null;
  terminalSearchControls.hidden = true;
  terminalSearchToggle.setAttribute('aria-expanded', 'false');
  terminalView?.clearSelection();
  terminalView?.focus();
}

function collectTerminalSearchMatches() {
  const matches = [];
  const query = terminalSearchInput.value.trim().toLocaleLowerCase();
  if (!query || !terminalView) return matches;
  const buffer = terminalView.buffer.active;
  for (let row = 0; row < buffer.length; row++) {
    const line = buffer.getLine(row)?.translateToString(true) || '';
    const normalizedLine = line.toLocaleLowerCase();
    let offset = 0;
    while (offset < normalizedLine.length) {
      const col = normalizedLine.indexOf(query, offset);
      if (col < 0) break;
      matches.push({ row, col, length: query.length });
      offset = col + query.length;
    }
  }
  return matches;
}

function renderTerminalSearchStatus() {
  const total = terminalSearchMatches.length;
  terminalSearchStatus.textContent = `${terminalSearchIndex < 0 ? 0 : terminalSearchIndex + 1}/${total}`;
  terminalSearchStatus.title = total
    ? window.kaoruI18n.format('matches', { count: total })
    : window.kaoruI18n.t('noMatches');
  terminalSearchPrev.disabled = total === 0;
  terminalSearchNext.disabled = total === 0;
}

function selectTerminalSearchMatch(index) {
  if (!terminalView || index < 0 || index >= terminalSearchMatches.length) return;
  terminalSearchIndex = index;
  const match = terminalSearchMatches[index];
  terminalView.select(match.col, match.row, match.length);
  terminalView.scrollToLine(Math.max(0, match.row - Math.floor(terminalView.rows / 2)));
  renderTerminalSearchStatus();
}

function refreshTerminalSearch(selectFirst = false) {
  const query = terminalSearchInput.value.trim().toLocaleLowerCase();
  if (terminalSearchScannedVersion !== terminalBufferVersion || terminalSearchQuery !== query) {
    const selected = terminalSearchMatches[terminalSearchIndex];
    terminalSearchMatches = collectTerminalSearchMatches();
    terminalSearchIndex = selected
      ? terminalSearchMatches.findIndex(
          (match) => match.row === selected.row && match.col === selected.col
        )
      : -1;
    terminalSearchScannedVersion = terminalBufferVersion;
    terminalSearchQuery = query;
  }
  if (selectFirst && terminalSearchMatches.length) selectTerminalSearchMatch(0);
  else {
    if (!terminalSearchMatches.length) terminalView?.clearSelection();
    renderTerminalSearchStatus();
  }
}

function findTerminalText(backward = false) {
  if (terminalSearchInputTimer) clearTimeout(terminalSearchInputTimer);
  terminalSearchInputTimer = null;
  refreshTerminalSearch();
  if (!terminalSearchMatches.length) return;
  const nextIndex =
    terminalSearchIndex < 0
      ? backward
        ? terminalSearchMatches.length - 1
        : 0
      : (terminalSearchIndex + (backward ? -1 : 1) + terminalSearchMatches.length) %
        terminalSearchMatches.length;
  selectTerminalSearchMatch(nextIndex);
}

function openTerminalSearch() {
  terminalSearchControls.hidden = false;
  terminalSearchToggle.setAttribute('aria-expanded', 'true');
  refreshTerminalSearch();
  terminalSearchInput.focus();
  terminalSearchInput.select();
}

terminalSearchToggle.addEventListener('click', () => {
  if (terminalSearchControls.hidden) openTerminalSearch();
  else closeTerminalSearch();
});
terminalSearchPrev.addEventListener('click', () => findTerminalText(true));
terminalSearchNext.addEventListener('click', () => findTerminalText());
terminalSearchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeTerminalSearch();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    findTerminalText(event.shiftKey);
  }
});
terminalSearchInput.addEventListener('input', () => {
  if (terminalSearchInputTimer) clearTimeout(terminalSearchInputTimer);
  terminalSearchIndex = -1;
  terminalSearchMatches = [];
  terminalSearchScannedVersion = -1;
  if (terminalView?.buffer.active.length > 1000 && terminalSearchInput.value.trim()) {
    terminalSearchStatus.textContent = window.kaoruI18n.t('searching');
    terminalSearchPrev.disabled = true;
    terminalSearchNext.disabled = true;
    terminalSearchInputTimer = setTimeout(() => {
      terminalSearchInputTimer = null;
      if (!terminalSearchControls.hidden) refreshTerminalSearch(true);
    }, 90);
  } else refreshTerminalSearch(true);
});

function disposeTerminalView() {
  terminalActivation++;
  if (terminalFlowPaused && terminalViewId != null)
    ipcRenderer.send('terminal-flow', { id: terminalViewId, paused: false });
  terminalFlowPaused = false;
  terminalQueuedChars = 0;
  if (terminalActivityTimer) clearTimeout(terminalActivityTimer);
  terminalActivityTimer = null;
  if (terminalTypingTimer) clearTimeout(terminalTypingTimer);
  terminalTypingTimer = null;
  if (terminalReactionTimer) clearTimeout(terminalReactionTimer);
  terminalReactionTimer = null;
  terminalSignal.hidden = true;
  terminalExplainError.hidden = true;
  closeTerminalAppearance();
  setTerminalVisualActivity('idle');
  if (terminalSearchRefreshTimer) clearTimeout(terminalSearchRefreshTimer);
  terminalSearchRefreshTimer = null;
  if (terminalSearchInputTimer) clearTimeout(terminalSearchInputTimer);
  terminalSearchInputTimer = null;
  terminalSearchMatches = [];
  terminalSearchIndex = -1;
  terminalBufferVersion = 0;
  terminalSearchScannedVersion = -1;
  terminalSearchQuery = '';
  terminalSearchInput.value = '';
  terminalSearchControls.hidden = true;
  renderTerminalSearchStatus();
  terminalSearchToggle.setAttribute('aria-expanded', 'false');
  terminalScreen.classList.remove('terminal-typing');
  terminalPanel.classList.remove('terminal-receiving');
  if (terminalViewId != null) terminalPending.delete(terminalViewId);
  terminalViewId = null;
  terminalSeq = 0;
  terminalReady = false;
  terminalView?.dispose();
  terminalView = null;
  terminalFit = null;
  terminalViewport.replaceChildren();
}

function fitTerminal() {
  if (!terminalView || !terminalFit || terminalPanel.hidden) return;
  if (!terminalViewport.clientWidth || !terminalViewport.clientHeight) return;
  terminalFit.fit();
  ipcRenderer.send('terminal-resize', {
    id: terminalViewId,
    cols: terminalView.cols,
    rows: terminalView.rows,
  });
}

async function activateTerminal(conversation) {
  disposeTerminalView();
  const activation = terminalActivation;
  terminalPanel.hidden = false;
  terminalExitCode = null;
  setTerminalState('connecting', window.kaoruI18n.t('connecting'));
  terminalError.hidden = true;
  terminalRestart.hidden = true;
  if (conversation.workspace) {
    terminalWorkspace.textContent = conversation.workspace.split(/[\\/]/).filter(Boolean).pop();
    terminalWorkspace.title = conversation.workspace;
  }
  if (!window.Terminal || !window.FitAddon?.FitAddon) {
    terminalError.textContent = window.kaoruI18n.t('terminalRendererFailed');
    terminalError.hidden = false;
    setTerminalState('error', window.kaoruI18n.t('noUnavailable'));
    return;
  }
  terminalViewId = conversation.id;
  terminalChatToggle.textContent = terminalLabel(
    document.getElementById('app').classList.contains('terminal-companion') ? 'closeChat' : 'chat',
    window.kaoruI18n.t('chat')
  );
  ipcRenderer.send('terminal-flow', { id: conversation.id, paused: false });
  terminalView = new window.Terminal({
    cursorBlink: true,
    cursorStyle: 'bar',
    cursorWidth: 3,
    convertEol: false,
    scrollback: 6000,
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim(),
    fontSize: terminalFontSize,
    lineHeight: 1.2,
    theme: terminalTheme(),
  });
  terminalFit = new window.FitAddon.FitAddon();
  terminalView.loadAddon(terminalFit);
  terminalView.open(terminalViewport);
  terminalView.onData((data) => {
    if (terminalViewId === conversation.id) {
      markTerminalTyping();
      ipcRenderer.send('terminal-write', { id: conversation.id, data });
    }
  });
  const view = terminalView;
  terminalView.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true;
    if ((event.ctrlKey || event.metaKey) && event.code === 'KeyF') {
      openTerminalSearch();
      return false;
    }
    const shortcut = (event.ctrlKey && event.shiftKey) || event.metaKey;
    if (!shortcut) return true;
    if (event.code === 'KeyC') {
      if (view.hasSelection()) navigator.clipboard.writeText(view.getSelection()).catch(() => {});
      return false;
    }
    if (event.code === 'KeyV') {
      navigator.clipboard
        .readText()
        .then((text) => {
          if (terminalView === view) view.paste(text);
        })
        .catch(() => {});
      return false;
    }
    return true;
  });
  requestAnimationFrame(() => requestAnimationFrame(fitTerminal));
  document.fonts.ready.then(fitTerminal).catch(() => {});
  const result = await ipcRenderer.invoke('terminal-open', {
    id: conversation.id,
    cols: terminalView.cols,
    rows: terminalView.rows,
  });
  if (terminalActivation !== activation || terminalView !== view) return;
  if (!result?.ok) {
    terminalError.textContent = result?.error || window.kaoruI18n.t('terminalOpenFailed');
    terminalError.hidden = false;
    terminalRestart.hidden = false;
    setTerminalState('error', window.kaoruI18n.t('noUnavailable'));
    if (result?.error === 'Terminal no autorizada')
      window.terminalCompanionFailed?.(conversation.id);
    return;
  }
  setTerminalState('ready', window.kaoruI18n.t('shellReady'));
  document.getElementById('terminal-shell').textContent =
    result.shell || window.kaoruI18n.t('terminal');
  if (result.scrollback) writeTerminalData(terminalView, result.scrollback);
  terminalSeq = result.seq || 0;
  terminalReady = true;
  const pending = terminalPending.get(conversation.id) || [];
  for (const event of pending) {
    if (event.seq > terminalSeq) {
      writeTerminalData(terminalView, event.data, true);
      terminalSeq = event.seq;
    } else terminalQueuedChars = Math.max(0, terminalQueuedChars - event.data.length);
  }
  terminalPending.delete(conversation.id);
  updateTerminalFlow();
  requestAnimationFrame(() => {
    if (terminalViewId !== conversation.id) return;
    fitTerminal();
    terminalView.refresh(0, terminalView.rows - 1);
    terminalView.focus();
  });
}

function deactivateTerminal() {
  terminalPanel.hidden = true;
  disposeTerminalView();
}
window.activateTerminal = activateTerminal;
window.deactivateTerminal = deactivateTerminal;

ipcRenderer.on('terminal-data', (_event, payload) => {
  if (!payload || typeof payload.data !== 'string') return;
  if (payload.id !== terminalViewId || !terminalView) return;
  if (!terminalReady) {
    const pending = terminalPending.get(payload.id) || [];
    pending.push(payload);
    terminalPending.set(payload.id, pending);
    terminalQueuedChars += payload.data.length;
    updateTerminalFlow();
    return;
  }
  if (payload.seq > terminalSeq) {
    writeTerminalData(terminalView, payload.data);
    terminalSeq = payload.seq;
    markTerminalActivity();
  }
});

ipcRenderer.on('terminal-exit', (_event, payload) => {
  if (payload?.id !== terminalViewId) return;
  terminalExitCode = payload.exitCode;
  setTerminalState('exited', window.kaoruI18n.format('shellClosed', { code: payload.exitCode }));
  terminalRestart.hidden = false;
});

terminalRestart.addEventListener('click', () => {
  if (terminalViewId != null) activateTerminal({ id: terminalViewId });
});

new ResizeObserver(fitTerminal).observe(terminalViewport);
window.addEventListener('resize', fitTerminal);
// conversation-current puede resolverse entre sessions.js y este script.
if (currentConversationType === 'terminal' && currentConversationId != null)
  activateTerminal({ id: currentConversationId, workspace: displayedWorkspace });
