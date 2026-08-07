// openclaw.js — ciclo de vida del servidor local de tools (openclaw-server.js):
// arranque con allowed-path, watchdog de disponibilidad, parada ordenada y
// limpieza de procesos huérfanos.

const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const fs = require('fs');

const { getOpenClawBridge } = require('../planner/OpenClawBridge.js');
const { getProjectCWD } = require('../planner/Planner.js');

const state = require('./state.js');

const OPENCLAW_RETRIES = 15;
const OPENCLAW_RETRY_MS = 400;

// ── Limpieza de procesos huérfanos ──────────────────────────────────────────
// Los servidores externos (MCP, LSP) se lanzan vía `npx`, que re-ejecuta el
// paquete en un proceso hijo. Matar `npx` deja el servidor real corriendo.
// Estas funciones recorren /proc, encuentran los descendientes del proceso
// actual (que no sean Electron) y les envían la señal pedida, para que al
// cerrar la app no quede nada vivo.
function descendantPids(rootPid) {
  const children = new Map(); // ppid -> [pid, ...]
  try {
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      let ppid = -1;
      try {
        const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf-8');
        const close = stat.lastIndexOf(')');
        const after = stat
          .slice(close + 1)
          .trim()
          .split(/\s+/);
        ppid = parseInt(after[1], 10);
      } catch (_) {}
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid).push(parseInt(entry, 10));
    }
  } catch (_) {
    return [];
  }

  const out = [];
  const stack = [...(children.get(rootPid) || [])];
  while (stack.length) {
    const pid = stack.pop();
    out.push(pid);
    stack.push(...(children.get(pid) || []));
  }
  return out;
}

function isElectronProcess(pid) {
  try {
    return /electron/i.test(fs.readlinkSync(`/proc/${pid}/exe`));
  } catch (_) {
    return true;
  }
}

function killDescendants(signal) {
  let n = 0;
  for (const pid of descendantPids(process.pid)) {
    if (isElectronProcess(pid)) continue;
    try {
      process.kill(pid, signal);
      n++;
    } catch (_) {}
  }
  return n;
}

// ── OpenClaw Server ────────────────────────────────────────────────────────────

function startOpenClaw(workspacePath) {
  const serverPath = path.join(__dirname, '..', '..', 'openclaw-server.js');
  if (!fs.existsSync(serverPath)) {
    console.warn('[core] openclaw-server.js no encontrado — herramientas desactivadas');
    state.bus.emit('openclaw:available', { available: false });
    return;
  }

  if (state.openclawStarting) {
    console.warn('[core] OpenClaw ya está iniciando — ignorando');
    return;
  }
  state.openclawStarting = true;
  state.openclawWorkspace = workspacePath ? path.resolve(workspacePath) : null;

  // Generar API key para openclaw-server y pasarla vía entorno
  const apiKey = crypto.randomBytes(32).toString('hex');

  // Pasar el workspace como PATH permitido (evita "cwd outside allowed path")
  const allowedPath = workspacePath ? path.resolve(workspacePath) : getProjectCWD();

  // Auditoría persistente del servidor de tools en userData (si hay app)
  const auditDir = state.app
    ? path.join(state.app.getPath('userData'), 'audit')
    : path.join(require('os').tmpdir(), 'asistente-vtuber-audit');
  const auditPath = path.join(auditDir, 'openclaw.jsonl');

  try {
    state.openclawProcess = cp.fork(serverPath, [], {
      stdio: 'pipe',
      env: {
        ...process.env,
        OPENCLAW_API_KEY: apiKey,
        OPENCLAW_ALLOWED_PATH: allowedPath,
        OPENCLAW_AUDIT_PATH: auditPath,
      },
    });

    // No dejar la API key en el env del proceso padre
    delete process.env.OPENCLAW_API_KEY;
    // Entregar la key al bridge en memoria (el bridge la lee por request)
    try {
      require('../planner/OpenClawBridge.js').setApiKey(apiKey);
    } catch (_) {}

    state.openclawProcess.stdout?.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg) console.log('[openclaw-server]', msg);
    });

    state.openclawProcess.stderr?.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg) console.error('[openclaw-server]', msg);
    });

    state.openclawProcess.on('exit', (code) => {
      state.openclawStarting = false;
      state.openclawProcess = null;
      getOpenClawBridge().resetAvailabilityCache();
      state.bus.emit('openclaw:available', { available: false });
    });

    state.openclawProcess.on('error', (err) => {
      state.openclawStarting = false;
      state.openclawProcess = null;
      state.bus.emit('openclaw:available', { available: false });
    });

    let retries = 0;
    const check = () => {
      state.openclawCheckTimer = null;
      retries++;
      getOpenClawBridge().resetAvailabilityCache();
      getOpenClawBridge()
        .isAvailable()
        .then((available) => {
          if (available) {
            console.log('[core] OpenClaw listo — Fase 3 activa');
            state.bus.emit('openclaw:available', { available: true });
          } else if (retries < OPENCLAW_RETRIES) {
            state.openclawCheckTimer = setTimeout(check, OPENCLAW_RETRY_MS);
          } else {
            console.warn(`[core] OpenClaw no respondió después de ${OPENCLAW_RETRIES} intentos`);
            state.openclawProcess?.kill();
            state.openclawStarting = false;
            state.openclawProcess = null;
            state.bus.emit('openclaw:available', { available: false });
          }
        })
        .catch(() => {
          if (retries < OPENCLAW_RETRIES)
            state.openclawCheckTimer = setTimeout(check, OPENCLAW_RETRY_MS);
          else {
            state.openclawStarting = false;
            state.bus.emit('openclaw:available', { available: false });
          }
        });
    };

    state.openclawCheckTimer = setTimeout(check, 1500);
  } catch (e) {
    state.openclawStarting = false;
    console.error('[core] error iniciando OpenClaw:', e.message);
    state.bus.emit('openclaw:available', { available: false });
  }
}

function stopOpenClaw() {
  const proc = state.openclawProcess;
  if (state.openclawKillTimer) {
    clearTimeout(state.openclawKillTimer);
    state.openclawKillTimer = null;
  }
  if (state.openclawCheckTimer) {
    clearTimeout(state.openclawCheckTimer);
    state.openclawCheckTimer = null;
  }
  if (proc) {
    console.log('[core] deteniendo OpenClaw...');
    state.openclawProcess = null;
    state.openclawStarting = false;
    try {
      for (const pid of descendantPids(proc.pid)) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch (_) {}
      }
      proc.kill('SIGTERM');
      state.openclawKillTimer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch (_) {}
        state.openclawKillTimer = null;
      }, 3000);
    } catch (e) {
      console.warn('[core] error deteniendo OpenClaw:', e.message);
    }
  }
  getOpenClawBridge().resetAvailabilityCache();
}

/**
 * FIX (auditoría Fase D): al cambiar de workspace, OpenClaw debe servir el
 * nuevo path permitido. Si el server corre con el path inicial, los comandos
 * del nuevo proyecto serían rechazados en silencio ("cwd outside allowed path").
 */
function restartOpenClawForWorkspace(ws) {
  const resolved = path.resolve(ws);
  if (state.openclawWorkspace === resolved) return; // mismo workspace → no tocar nada
  if (!state.openclawStarting && state.openclawProcess) {
    console.log('[core] workspace cambió — reiniciando OpenClaw para el nuevo allowed path');
    try {
      stopOpenClaw();
    } catch (e) {
      console.warn('[core] falló al detener OpenClaw:', e && e.message ? e.message : e);
    }
  }
  if (!state.openclawProcess && !state.openclawStarting) {
    startOpenClaw(resolved);
  }
}

module.exports = {
  startOpenClaw,
  stopOpenClaw,
  restartOpenClawForWorkspace,
  descendantPids,
  isElectronProcess,
  killDescendants,
};
