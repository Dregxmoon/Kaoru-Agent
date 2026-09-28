// @ts-check
'use strict';

const { ipcMain } = require('electron');
const { TerminalService } = require('../core/terminal/TerminalService.js');

/** @type {InstanceType<typeof TerminalService>|null} */
let service = null;
/** @type {number|null} */
let linkedTerminalId = null;

/** @param {any} ctx */
function register(ctx) {
  linkedTerminalId = null;
  /** @param {number} id */
  const linkedToActiveChat = (id) => {
    const active = ctx.Core.activeConversation();
    const row = Number.isSafeInteger(id) && ctx.Core.getGraph()?._sessions?.getSession(id);
    return Boolean(
      active?.type === 'chat' &&
      row?.session_type === 'terminal' &&
      row.workspace &&
      row.workspace === active.workspace
    );
  };
  /** @param {number} id */
  const visibleTerminal = (id) => {
    const active = ctx.Core.activeConversation();
    return Boolean(
      (active?.type === 'terminal' && active.id === id) ||
      (id === linkedTerminalId && linkedToActiveChat(id))
    );
  };
  service = new TerminalService({
    send: (channel, payload) => {
      const window = ctx.S?.chatWindow;
      if (!window || window.isDestroyed()) return;
      if (
        (channel === 'terminal-data' || channel === 'terminal-exit') &&
        !visibleTerminal(payload.id)
      )
        return;
      window.webContents.send(channel, payload);
    },
    onGesture: (mood) => ctx.sendTerminalGesture(mood),
    onActivity: (id) => ctx.Core.getGraph()?._sessions?.markTerminalActivity(id),
  });
  const terminal = service;

  /** @param {Electron.IpcMainEvent|Electron.IpcMainInvokeEvent} event @param {number} id */
  const authorized = (event, id) => {
    const window = ctx.S?.chatWindow;
    return Boolean(
      window && !window.isDestroyed() && event.sender === window.webContents && visibleTerminal(id)
    );
  };

  ipcMain.handle('terminal-open', (event, { id, cols, rows } = {}) => {
    const window = ctx.S?.chatWindow;
    if (
      !window ||
      window.isDestroyed() ||
      event.sender !== window.webContents ||
      (!authorized(event, id) && !linkedToActiveChat(id))
    )
      return { ok: false, error: 'Terminal no autorizada' };
    try {
      if (ctx.Core.activeConversation()?.type === 'chat') linkedTerminalId = id;
      else linkedTerminalId = null;
      return {
        ok: true,
        ...terminal.open(id, ctx.Core.activeConversation().workspace, { cols, rows }),
      };
    } catch (error) {
      return {
        ok: false,
        error: `No se pudo iniciar la shell: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  });
  ipcMain.on('terminal-write', (event, { id, data } = {}) => {
    if (authorized(event, id)) terminal.write(id, data);
  });
  ipcMain.on('terminal-resize', (event, { id, cols, rows } = {}) => {
    if (authorized(event, id)) terminal.resize(id, cols, rows);
  });
  ipcMain.on('terminal-flow', (event, { id, paused } = {}) => {
    const window = ctx.S?.chatWindow;
    if (!window || window.isDestroyed() || event.sender !== window.webContents) return;
    if (!Number.isSafeInteger(id) || typeof paused !== 'boolean') return;
    if (paused && !authorized(event, id)) return;
    terminal.setFlow(id, paused);
  });
}

function closeAll() {
  linkedTerminalId = null;
  service?.closeAll();
}

/** @param {number} id */
function close(id) {
  if (linkedTerminalId === id) linkedTerminalId = null;
  return service?.close(id) || false;
}

module.exports = { register, close, closeAll };
