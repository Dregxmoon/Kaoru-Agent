// @ts-nocheck
const logger = require('../observability/Logger.js');
// shutdown.js — cierre ordenado del núcleo: procesos huérfanos, MCP, LSP,
// sensores, ProactiveEngine y la base de datos.

const { killDescendants, stopOpenClaw } = require('./openclaw.js');
const { closeSession } = require('./session.js');

const state = require('./state.js');

/**
 * Cierre ordenado. Lo más importante acá: los servidores MCP corren como
 * procesos hijos (típicamente `npx ...`) — si la app se cierra sin
 * desconectarlos, pueden quedar huérfanos corriendo en el sistema. Se
 * llama desde main.js en 'before-quit', con timeout, igual que closeSession.
 */
async function shutdown() {
  logger.info('shutdown', '[core] cerrando...');

  // Matar primero a los hijos externos (npx y sus servidores reales) — antes
  // de cualquier await, para que corra aunque shutdown() tarde después.
  // SIGKILL como red de seguridad 2s después (timer con unref para no
  // retener el event loop de Electron). El timer se CANCELA al completar el
  // shutdown (ver al final): si no, mataría procesos que arrancan DESPUÉS del
  // cierre — p. ej. el server OpenClaw de una corrida de benchmark siguiente.
  const sigkillTimer = setTimeout(() => {
    killDescendants('SIGKILL');
  }, 2000);
  if (typeof sigkillTimer.unref === 'function') sigkillTimer.unref();

  if (state.mcp) {
    try {
      await state.mcp.disconnectAll();
    } catch (e) {
      logger.warn('shutdown', '[core] error desconectando MCP:', e.message);
    }
  }
  if (state.initiativeUnsub) {
    state.initiativeUnsub();
    state.initiativeUnsub = null;
  }
  if (state.proposalExecutedUnsub) {
    state.proposalExecutedUnsub();
    state.proposalExecutedUnsub = null;
  }

  await closeSession();

  if (state.bridge) {
    try {
      await state.bridge.closeBrowser();
    } catch (e) {
      logger.warn('shutdown', '[core] error cerrando navegador:', e.message);
    }
  }
  stopOpenClaw();
  if (state.osSensor) {
    try {
      state.osSensor.stop();
    } catch (e) {
      logger.warn('shutdown', '[core] error deteniendo sensor:', e.message);
    }
  }
  if (state.lspManager) {
    try {
      await state.lspManager.stop();
    } catch (e) {
      logger.warn('shutdown', '[core] error cerrando LSP:', e.message);
    }
  }
  if (state.lspErrorWatcher) {
    try {
      state.lspErrorWatcher.stop();
    } catch (e) {
      logger.warn('shutdown', '[core] error deteniendo LSPErrorWatcher:', e.message);
    }
    state.lspErrorWatcher = null;
  }
  state.proactive?.stop();
  for (const [name, sensor] of [
    ['git', state.gitWatcher],
    ['system', state.systemWatcher],
    ['title', state.titleWatcher],
    ['clipboard', state.clipboardWatcher],
    ['upcoming-events', state.eventsWatcher],
  ]) {
    try {
      sensor?.stop();
    } catch (e) {
      logger.warn('shutdown', `[core] error deteniendo sensor ${name}:`, e.message);
    }
  }
  state.gitWatcher =
    state.systemWatcher =
    state.titleWatcher =
    state.clipboardWatcher =
    state.eventsWatcher =
      null;
  state.proposalStore = null;
  state.proactiveExecutor = null;
  state.activeWorkspace = null;
  state.onProposalResult = null;
  if (state.pruneTimer) {
    clearInterval(state.pruneTimer);
    state.pruneTimer = null;
  }
  if (state.pruneInitTimer) {
    clearTimeout(state.pruneInitTimer);
    state.pruneInitTimer = null;
  }
  if (state.graph) {
    try {
      state.graph.close();
    } catch (e) {
      logger.warn('shutdown', '[core] error cerrando DB:', e.message);
    }
  }

  state.onInitiative = null;
  state.initialized = false;

  // El cierre limpio ya detuvo todo (SIGTERM + limpiezas explícitas). Cancelar
  // el SIGKILL de respaldo para no matar procesos ajenos que arrancan después
  // (p. ej. el server OpenClaw de una corrida de benchmark siguiente).
  clearTimeout(sigkillTimer);
}

module.exports = {
  shutdown,
};
