// workspace.js — gestión del workspace activo (repo/carpeta sobre la que el
// asistente trabaja como agente de código).

const path = require('path');
const fs = require('fs');

const { setProjectCWD } = require('../planner/Planner.js');
const { restartOpenClawForWorkspace } = require('./openclaw.js');
const { readSensorsConfig } = require('./config.js');

const state = require('./state.js');

// ── Workspace ──────────────────────────────────────────────────────────────
// Cambia el repo/carpeta sobre el que el asistente trabaja como agente de código.
// La usan tanto el picker del UI como el comando de terminal `asistente`.
async function setActiveWorkspace(newPath) {
  const resolved = path.resolve(newPath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return { ok: false, error: `"${resolved}" no existe o no es una carpeta` };
  }

  setProjectCWD(resolved);
  state.activeWorkspace = resolved;

  if (state.mcp) {
    const fsServer = state.mcp.listServers().find((s) => s.name === 'filesystem');
    if (fsServer) await state.mcp.removeServer(fsServer.id);
    await state.mcp.addServer({
      name: 'filesystem',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', resolved],
      env: {},
    });
  }

  // ── LSP: arrancar servidor para el nuevo workspace ─────────────────
  if (state.lspManager) {
    (async () => {
      try {
        await state.lspManager.stop();
      } catch {}
      try {
        await state.lspManager.start(resolved);
        console.log('[core] LSP listo para', resolved);
      } catch (e) {
        console.warn('[core] LSP no disponible:', e.message);
      }
    })();
  }

  // ── Fase D: reset del scope del watcher (no mezclar proyectos) ────
  if (state.lspErrorWatcher) {
    state.lspErrorWatcher.resetWorkspace(resolved);
    if (readSensorsConfig().lsp !== false)
      state.lspErrorWatcher
        .poll()
        .catch((e) => console.warn('[core] scan LSP falló:', e && e.message ? e.message : e));
  }

  // ── FIX (auditoría Fase D): OpenClaw corre con OPENCLAW_ALLOWED_PATH fijado
  // al workspace inicial; si el usuario cambia de proyecto, cualquier comando
  // del nuevo workspace se rechazaría con "cwd outside allowed path". Se
  // reinicia el server con el nuevo path permitido (pocas veces al día, y el
  // bridge ya maneja la indisponibilidad transitoria).
  restartOpenClawForWorkspace(resolved);

  state.bus.emit('workspace:changed', { path: resolved });
  if (state.gitWatcher) {
    state.gitWatcher.setWorkspace(resolved);
  }
  console.log('[core] workspace activo:', resolved);
  return { ok: true, path: resolved };
}

// Devuelve el workspace activo (null si no se ha fijado). Lo usan los comandos
// del chat (/init, /open) y el FileResolver para operar sobre el proyecto real
// y no sobre el cwd de la app.
function getWorkspace() {
  return state.activeWorkspace;
}

module.exports = {
  setActiveWorkspace,
  getWorkspace,
};
