// Panel de sesiones pasadas — picker para reanudar conversaciones anteriores.
// Se apoya en los IPC 'sessions-list' / 'session-load' (ipc/memory-handlers.js)
// que leen las sesiones cerradas del StateGraph. Al cargar una sesión se
// reemplaza el sessionHistory local y se repuebla la ventana de mensajes.
const sessionsModal = document.getElementById('sessions-modal');
const sessionsListEl = document.getElementById('sessions-list');
const sessionsCloseBtn = document.getElementById('sessions-close');
const sessionsBtn = document.getElementById('sessions-btn');

function openSessions() {
  sessionsModal.classList.add('visible');
  renderSessions();
}

function closeSessions() {
  sessionsModal.classList.remove('visible');
}

function _fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function renderSessions() {
  sessionsListEl.innerHTML = '<div class="session-loading">Cargando sesiones...</div>';
  let sessions = [];
  try {
    sessions = await ipcRenderer.invoke('sessions-list', { limit: 15 });
  } catch (e) {
    console.error('[sessions] error listando:', e.message || e);
    sessions = [];
  }
  if (!Array.isArray(sessions) || sessions.length === 0) {
    sessionsListEl.innerHTML = '<div class="sessions-empty">No hay sesiones pasadas todavía.</div>';
    return;
  }
  sessionsListEl.innerHTML = '';
  for (const s of sessions) {
    const firstUser = (s.history || []).find((m) => m.role === 'user');
    const title = s.summary || firstUser?.content || `Sesión #${s.id}`;
    const sub = `${_fmtDate(s.startedAt)} · ${s.turnCount || 0} turnos`;
    const row = document.createElement('button');
    row.className = 'session-row';
    row.innerHTML = `<div class="session-row-title">${escapeHtml(String(title).slice(0, 60))}</div>
      <div class="session-row-sub">${escapeHtml(sub)}</div>`;
    row.addEventListener('click', () => loadSessionIntoChat(s.id));
    sessionsListEl.appendChild(row);
  }
}

async function loadSessionIntoChat(id) {
  sessionsListEl.innerHTML = '<div class="session-loading">Cargando conversación...</div>';
  let session = null;
  try {
    session = await ipcRenderer.invoke('session-load', { id });
  } catch (e) {
    console.error('[sessions] error cargando:', e.message || e);
  }
  if (!session || !Array.isArray(session.history)) {
    sessionsListEl.innerHTML = '<div class="session-error">No se pudo cargar la sesión.</div>';
    return;
  }

  sessionHistory.length = 0;
  for (const turn of session.history) {
    if (turn?.content) sessionHistory.push(turn);
  }

  const messagesEl = document.getElementById('messages');
  messagesEl.innerHTML = '';
  const landing = document.getElementById('landing');
  if (landing) landing.classList.add('hidden');
  for (const turn of sessionHistory) {
    if (!turn?.content) continue;
    addMessage(turn.role === 'user' ? 'user' : 'assistant', turn.content);
  }
  closeSessions();
}

sessionsBtn.addEventListener('click', openSessions);
sessionsCloseBtn.addEventListener('click', closeSessions);
sessionsModal.addEventListener('click', (e) => {
  if (e.target === sessionsModal) closeSessions();
});
