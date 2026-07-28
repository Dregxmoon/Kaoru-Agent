#!/usr/bin/env python3
"""Fix #3 del feature de Workspace: muestra solo el nombre de carpeta
(ej. "sae" en vez de "/home/panfilo/Projects/sae") en el chat y en el
botón del header, y lo hace desde una sola fuente de verdad (el evento
workspace:changed) para que funcione igual sin importar si el cambio
vino del botón, del comando `asistente`, o de restaurar el workspace
persistido al arrancar.
Corre esto DESPUÉS de apply_workspace.py y apply_workspace_fix2.py.
"""
import sys

def apply_edit(path, old, new, label):
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()
    if content.count(old) != 1:
        print(f"✗ {label}: no encontré el texto esperado en {path} (o aparece más de una vez). ¿Ya corriste los dos scripts anteriores? Nada se tocó en este paso.")
        return False
    content = content.replace(old, new)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)
    print(f"✓ {label}")
    return True

ok = True

# ── 1. main.js: reenviar workspace:changed al renderer ─────────────────────
ok &= apply_edit(
    'main.js',
    "  MarchCore.getEventBus().on('openclaw:available', (payload) => {\n    if (chatWindow && !chatWindow.isDestroyed()) {\n      chatWindow.webContents.send('openclaw-status', payload);\n    }\n  });",
    """  MarchCore.getEventBus().on('openclaw:available', (payload) => {
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.webContents.send('openclaw-status', payload);
    }
  });

  MarchCore.getEventBus().on('workspace:changed', (payload) => {
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.webContents.send('workspace-changed', payload);
    }
  });""",
    "main.js — evento workspace:changed reenviado al renderer por IPC"
)

# ── 2. chat.html: helper para sacar el nombre corto de una ruta ────────────
ok &= apply_edit(
    'src/chat.html',
    "async function loadLLMConfig() {\n  try {\n    const cfg = await ipcRenderer.invoke('get-config');\n    if (cfg && cfg.llm) {\n      LLMProvider.configure(cfg);\n      updateKeysBanner(LLMProvider.getActiveProvider());\n    } else {\n      updateKeysBanner(null);\n    }\n  } catch(e) {\n    console.warn('[llm] error cargando config:', e.message);\n    updateKeysBanner(null);\n  }\n}",
    """// Nombre corto de un workspace: solo el último segmento de la ruta
// ("/home/panfilo/Projects/sae" -> "sae"). Sirve tanto para rutas con /
// como con \\\\ (por si algún día corre en Windows).
function _workspaceName(fullPath) {
  if (!fullPath) return 'Workspace';
  const parts = fullPath.split(/[\\\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : fullPath;
}

function _applyWorkspaceUI(fullPath) {
  const btn = document.getElementById('workspace-btn');
  if (!btn) return;
  const name = _workspaceName(fullPath);
  btn.innerHTML = `📁 ${name}`;
  btn.title = fullPath;
}

async function loadLLMConfig() {
  try {
    const cfg = await ipcRenderer.invoke('get-config');
    if (cfg && cfg.llm) {
      LLMProvider.configure(cfg);
      updateKeysBanner(LLMProvider.getActiveProvider());
    } else {
      updateKeysBanner(null);
    }
    if (cfg && cfg.activeWorkspace) _applyWorkspaceUI(cfg.activeWorkspace);
  } catch(e) {
    console.warn('[llm] error cargando config:', e.message);
    updateKeysBanner(null);
  }
}""",
    "chat.html — helper _workspaceName y estado inicial del botón agregados"
)

# ── 3. chat.html: el botón ya no empuja el mensaje directo, y se escucha el evento ──
ok &= apply_edit(
    'src/chat.html',
    """document.getElementById('workspace-btn').addEventListener('click', async () => {
  const res = await ipcRenderer.invoke('pick-workspace-folder');
  if (res?.ok) addMessage('march', `Ahora estoy trabajando en \\`${res.path}\\``);
});""",
    """document.getElementById('workspace-btn').addEventListener('click', async () => {
  const res = await ipcRenderer.invoke('pick-workspace-folder');
  if (res && !res.ok) addMessage('march', `No pude cambiar de workspace: ${res.error}`);
  // Si sí funcionó, el mensaje y el botón se actualizan solos vía el
  // evento 'workspace-changed' de abajo — misma fuente de verdad sin
  // importar si el cambio vino de este botón, de `asistente`, o de
  // restaurar el workspace persistido al arrancar.
});

ipcRenderer.on('workspace-changed', (e, { path }) => {
  _applyWorkspaceUI(path);
  addMessage('march', `Ahora estoy trabajando en \\`${_workspaceName(path)}\\``);
});""",
    "chat.html — botón y evento workspace-changed unificados en una sola fuente de verdad"
)

print("\nTodo listo." if ok else "\nAlgún paso falló — revisa los ✗ antes de correr npm start.")
sys.exit(0 if ok else 1)