// Input
const input     = document.getElementById('msg-input');
const sendBtn   = document.getElementById('send-btn');
const hintEl    = document.getElementById('input-hint-text');

function updateLlmHint() {
  const active = LLMProvider.getActiveProvider();
  const all = LLMProvider.getAvailableProviders();
  const p = all.find(x => x.id === active);
  if (p) {
    const cost = p.free ? 'gratis' : 'pago';
    hintEl.textContent = `${p.name} (${cost}) · /help`;
  } else {
    hintEl.textContent = 'Sin LLM activo · /help';
  }
}

let _atSelectedIdx = -1;
let _atQuery = '';
let _cmdSuggested = false;

const _cmdNames = [
  ...CommandRegistry.getNames(),
  // Atajos de proveedor (/groq, /gemini, /nvidia, ...) — se resuelven en
  // CommandRegistry.execute() como fallback, así que deben autocompletarse.
  ...LLMProvider.getAvailableProviders().map(p => p.id),
];
let _skillNames = [];
let _providerNames = [];
ipcRenderer.invoke('list-skills').then(skills => {
  _skillNames = skills.map(s => s.name);
}).catch(() => {});
try {
  _providerNames = LLMProvider.getAvailableProviders().filter(p => p.hasKey).map(p => p.id);
} catch {}

function _getProjectFiles() {
  if (_atProjectFiles) return _atProjectFiles;
  try {
    _atProjectFiles = FileResolver.listProjectFiles(_workspacePath || assistant.cwd());
  } catch { _atProjectFiles = []; }
  return _atProjectFiles;
}

function _showAtSuggestions(query) {
  _atQuery = query;
  const el = document.getElementById('at-suggestions');

  const files = _getProjectFiles().filter(f =>
    f.path.toLowerCase().includes(query.toLowerCase())
  ).slice(0, 20);

  if (files.length === 0) { el.style.display = 'none'; return; }

  el.innerHTML = files.map((f, i) =>
    `<div class="at-suggestion-item" data-index="${i}" data-path="${escapeHtml(f.path)}">
      <span class="file-icon">${f.type === 'directory' ? '[DIR]' : '[FILE]'}</span>
      <span>${_highlightMatch(f.name, query)}</span>
      <span class="file-path">${escapeHtml(f.path.split('/').slice(0, -1).join('/') || '.')}</span>
    </div>`
  ).join('');
  el.style.display = 'block';
  _atSelectedIdx = -1;
}

// Antes solo escapaba la rama SIN match (idx === -1) — un nombre de
// archivo malicioso que SÍ matcheaba la búsqueda pasaba crudo por el resto
// del string (name.slice antes/después del match), sin pasar por
// escapeHtml en absoluto. Ahora las tres partes se escapan por separado
// antes de insertar el <strong> — el <strong> es el único HTML real que
// se genera acá, todo lo demás es texto del usuario/filesystem.
function _highlightMatch(name, query) {
  const idx = name.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return escapeHtml(name);
  const before = escapeHtml(name.slice(0, idx));
  const match = escapeHtml(name.slice(idx, idx + query.length));
  const after = escapeHtml(name.slice(idx + query.length));
  return before + '<strong>' + match + '</strong>' + after;
}

function _applyAtSuggestion(path) {
  const el = document.getElementById('at-suggestions');
  el.style.display = 'none';

  const cursorPos = input.selectionStart;
  const text = input.value;
  const before = text.slice(0, cursorPos);
  const after = text.slice(cursorPos);

  const atIdx = before.lastIndexOf('@');
  if (atIdx === -1) return;

  const newText = before.slice(0, atIdx + 1) + path + after;
  input.value = newText;
  const newPos = atIdx + 1 + path.length;
  input.setSelectionRange(newPos, newPos);
  input.dispatchEvent(new Event('input'));
  input.focus();
}

function _showCmdSuggestions(query) {
  _cmdSuggested = true;
  _atQuery = query;
  const el = document.getElementById('at-suggestions');

  const cmds = _cmdNames.filter(c =>
    c.toLowerCase().startsWith(query.toLowerCase())
  ).slice(0, 15);

  if (cmds.length === 0) { el.style.display = 'none'; return; }

  el.innerHTML = cmds.map((c, i) =>
    `<div class="at-suggestion-item" data-index="${i}" data-cmd="${c}">
      <span style="color:var(--accent);font-weight:600">/${c}</span>
      <span style="opacity:.5;margin-left:auto;font-size:10px">cmd</span>
    </div>`
  ).join('');
  el.style.display = 'block';
  _atSelectedIdx = -1;
}

function _applyCmdSuggestion(cmd) {
  _cmdSuggested = false;
  const el = document.getElementById('at-suggestions');
  el.style.display = 'none';
  input.value = '/' + cmd + ' ';
  input.focus();
  const newPos = input.value.length;
  input.setSelectionRange(newPos, newPos);
  input.dispatchEvent(new Event('input'));
}

function _cmdArgCompletions(cmdName) {
  const cmd = CommandRegistry.getCommand(cmdName);
  if (!cmd) return null;
  if (cmdName === 'skill') return _skillNames.length > 0 ? _skillNames : null;
  if (cmdName === 'model') return _providerNames.length > 0 ? _providerNames : null;
  if (cmdName === 'provider') return ['set', 'add', 'remove'];
  if (cmdName === 'cambio-modelo') return _modelNames.length > 0 ? _modelNames : null;
  if (cmdName === 'modelo-vistas') return ['full', 'half', 'head', 'all'];
  return cmd.completions || null;
}

function _showArgSuggestions(cmdName, partialArg) {
  const completions = _cmdArgCompletions(cmdName);
  if (!completions) { document.getElementById('at-suggestions').style.display = 'none'; return; }

  const filtered = completions.filter(c =>
    c.toLowerCase().startsWith(partialArg.toLowerCase())
  ).slice(0, 15);

  const el = document.getElementById('at-suggestions');
  if (filtered.length === 0) { el.style.display = 'none'; return; }

  el.innerHTML = filtered.map((c, i) =>
    `<div class="at-suggestion-item" data-index="${i}" data-cmd-arg="${c}">
      <span style="color:var(--accent)">${c}</span>
      <span style="opacity:.5;margin-left:auto;font-size:10px">/${cmdName}</span>
    </div>`
  ).join('');
  el.style.display = 'block';
  _atSelectedIdx = -1;
}

function _applyArgSuggestion(arg) {
  const el = document.getElementById('at-suggestions');
  el.style.display = 'none';

  const cursorPos = input.selectionStart;
  const before = input.value.slice(0, cursorPos);
  const after = input.value.slice(cursorPos);

  const spaceIdx = before.indexOf(' ');
  const newBefore = before.slice(0, spaceIdx + 1) + arg;
  input.value = newBefore + after;
  const newPos = newBefore.length;
  input.setSelectionRange(newPos, newPos);
  input.dispatchEvent(new Event('input'));
  input.focus();
}

input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';

  const cursorPos = input.selectionStart;
  const textBeforeCursor = input.value.slice(0, cursorPos);

  // /command name suggestions: only at start of input, no space yet
  if (textBeforeCursor.startsWith('/') && !textBeforeCursor.includes(' ')) {
    _cmdSuggested = true;
    const query = textBeforeCursor.slice(1);
    _showCmdSuggestions(query);
    return;
  }

  // /command sub-arg suggestions: /cmd partial...
  if (textBeforeCursor.startsWith('/') && textBeforeCursor.includes(' ')) {
    _cmdSuggested = false;
    const afterSlash = textBeforeCursor.slice(1);
    const spaceIdx = afterSlash.indexOf(' ');
    const cmdName = afterSlash.slice(0, spaceIdx);
    const partialArg = afterSlash.slice(spaceIdx + 1);
    _showArgSuggestions(cmdName, partialArg);
    return;
  }

  // @file suggestions
  _cmdSuggested = false;
  const atIdx = textBeforeCursor.lastIndexOf('@');
  if (atIdx === -1 || textBeforeCursor.slice(atIdx).includes(' ')) {
    document.getElementById('at-suggestions').style.display = 'none';
    return;
  }
  const query = textBeforeCursor.slice(atIdx + 1);
  _showAtSuggestions(query);
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    const atEl = document.getElementById('at-suggestions');
    if (atEl.style.display === 'block') {
      e.preventDefault();
      const selected = atEl.querySelector('.at-suggestion-item.selected');
      if (selected) {
        if (_cmdSuggested) {
          _applyCmdSuggestion(selected.dataset.cmd);
        } else if (selected.dataset.cmdArg) {
          _applyArgSuggestion(selected.dataset.cmdArg);
        } else {
          _applyAtSuggestion(selected.dataset.path);
        }
        return;
      }
    }
    // Clear command suggestion state on send
    _cmdSuggested = false;
    e.preventDefault();
    const text = input.value;
    input.value = ''; input.style.height = 'auto';
    document.getElementById('at-suggestions').style.display = 'none';
    sendMessage(text);
  }
  if (e.key === 'Tab' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const atEl = document.getElementById('at-suggestions');
    if (atEl.style.display !== 'block') return;
    e.preventDefault();
    const items = atEl.querySelectorAll('.at-suggestion-item');
    if (items.length === 0) return;
    if (e.key === 'Tab' || e.key === 'ArrowDown') {
      _atSelectedIdx = (_atSelectedIdx + 1) % items.length;
    } else {
      _atSelectedIdx = (_atSelectedIdx - 1 + items.length) % items.length;
    }
    items.forEach((el, i) => el.classList.toggle('selected', i === _atSelectedIdx));
    if (items[_atSelectedIdx]) items[_atSelectedIdx].scrollIntoView({ block: 'nearest' });
  }
  if (e.key === 'Escape') {
    _cmdSuggested = false;
    document.getElementById('at-suggestions').style.display = 'none';
  }
});
// Click handler for @ and / suggestions
document.getElementById('at-suggestions').addEventListener('mousedown', (e) => {
  const item = e.target.closest('.at-suggestion-item');
  if (!item) return;
  e.preventDefault();
  if (_cmdSuggested) {
    _applyCmdSuggestion(item.dataset.cmd);
  } else if (item.dataset.cmdArg) {
    _applyArgSuggestion(item.dataset.cmdArg);
  } else {
    _applyAtSuggestion(item.dataset.path);
  }
});
sendBtn.addEventListener('click', () => {
  const text = input.value;
  input.value = ''; input.style.height = 'auto';
  sendMessage(text);
});

function sendMessage(text) {
  const files = [...pendingFiles];
  clearAttachments();
  processMessage(text, files);
}

// Adjuntos
const attachBtn = document.getElementById('attach-btn');
const fileInput = document.getElementById('file-input');
const attachBar = document.getElementById('attachments-bar');

attachBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => addFiles(Array.from(e.target.files)));

function addFiles(files) {
  files.forEach(f => { if (!pendingFiles.find(p => p.name === f.name && p.size === f.size)) pendingFiles.push(f); });
  renderAttachBar(); fileInput.value = '';
}
function renderAttachBar() {
  attachBar.innerHTML = '';
  if (!pendingFiles.length) { attachBar.classList.remove('has-files'); return; }
  attachBar.classList.add('has-files');
  pendingFiles.forEach((f, i) => {
    const chip = document.createElement('div'); chip.className = 'attach-chip';
    chip.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66L9.41 17.41a2 2 0 01-2.83-2.83l8.49-8.48"/></svg><span class="chip-name">${f.name}</span><div class="chip-del" data-idx="${i}">X</div>`;
    attachBar.appendChild(chip);
  });
  attachBar.querySelectorAll('.chip-del').forEach(btn =>
    btn.addEventListener('click', () => { pendingFiles.splice(Number(btn.dataset.idx), 1); renderAttachBar(); })
  );
}
function clearAttachments() { pendingFiles = []; renderAttachBar(); }

const chatPanel   = document.getElementById('chat-panel');
const dropOverlay = document.getElementById('drop-overlay');
let dragCounter   = 0;
chatPanel.addEventListener('dragenter', (e) => { e.preventDefault(); dragCounter++; if (e.dataTransfer.types.includes('Files')) dropOverlay.classList.add('visible'); });
chatPanel.addEventListener('dragleave', () => { dragCounter--; if (dragCounter <= 0) { dragCounter = 0; dropOverlay.classList.remove('visible'); } });
chatPanel.addEventListener('dragover', (e) => e.preventDefault());
chatPanel.addEventListener('drop', (e) => {
  e.preventDefault(); dragCounter = 0; dropOverlay.classList.remove('visible');
  const files = Array.from(e.dataTransfer.files);
  if (!files.length) return;
  const folder = files.find(f => {
    if (!f.path) return false;
    let isDir = false;
    try { isDir = assistant.statIsDir(f.path); } catch {}
    return isDir;
  });
  if (folder) { importModelFromFolder(folder.path); return; }
  addFiles(files);
});

async function importModelFromFolder(folderPath) {
  const res = await ipcRenderer.invoke('model-import', { folderPath });
  if (res.error) { addMessage('assistant', `Error al importar modelo: ${res.error}`); return; }
  addMessage('assistant', `Modelo importado y activado: **${res.info.name}**`);
}
