// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');

const MAX_SCROLLBACK = 256 * 1024;
const GESTURE_COOLDOWN = 12000;
const OUTPUT_BATCH_MS = 8;
const OUTPUT_BATCH_CHARS = 32 * 1024;

/** @param {string} output */
function outputReaction(output) {
  // Secuencias ESC y BEL de ANSI/OSC enviadas por la shell.
  // eslint-disable-next-line no-control-regex
  const plain = output.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, '');
  if (
    /(?:\b(?:tests?|specs?)\b.{0,35}\b(?:failed|failing)\b|\b(?:error|exception|failed|fatal)\b)/i.test(
      plain
    )
  )
    return { mood: 'sad', priority: 4 };
  if (/(?:\b(?:tests?|specs?)\b.{0,35}\b(?:passed|passing)\b|\b\d+ passed\b)/i.test(plain))
    return { mood: 'happy', priority: 3 };
  if (/\b(?:warning|warn)\b/i.test(plain)) return { mood: 'think', priority: 2 };
  return null;
}

/** @param {string} command */
function commandReaction(command) {
  if (
    /(?:^|[;&|]\s*)(?:sudo\s+|rm\s+-[^\s]*[rR][^\s]*\s+|(?:drop|truncate)\s+table\b)/i.test(command)
  )
    return { mood: 'surprised', priority: 5 };
  if (/\b(?:npm|pnpm|yarn|pip|pip3|cargo)\s+(?:install|add)\b/i.test(command))
    return { mood: 'think', priority: 2 };
  return null;
}

/** @param {string} file */
function executable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveShell(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const paths = String(env.Path || env.PATH || '')
      .split(';')
      .filter(Boolean);
    const programFiles = env.ProgramFiles || env.ProgramW6432 || 'C:\\Program Files';
    const pwsh = [
      ...paths.map((dir) => path.win32.join(dir, 'pwsh.exe')),
      path.win32.join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
    ].find(fs.existsSync);
    if (pwsh) return { file: pwsh, args: ['-NoLogo'], label: 'PowerShell 7' };
    const win = env.SystemRoot || 'C:\\Windows';
    const classic = path.win32.join(win, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (fs.existsSync(classic)) return { file: classic, args: ['-NoLogo'], label: 'PowerShell' };
    return {
      file: env.ComSpec || path.win32.join(win, 'System32', 'cmd.exe'),
      args: [],
      label: 'CMD',
    };
  }
  const fallbackShells =
    platform === 'darwin' ? ['/bin/zsh', '/bin/bash', '/bin/sh'] : ['/bin/bash', '/bin/sh'];
  const shell =
    env.SHELL && path.isAbsolute(env.SHELL) && executable(env.SHELL)
      ? env.SHELL
      : fallbackShells.find(executable) || '/bin/sh';
  return { file: shell, args: ['-l'], label: path.basename(shell) };
}

class TerminalService {
  /** @param {{send:(channel:string,payload:any)=>void, onGesture?:(mood:string)=>void, onActivity?:(id:number)=>void, spawnPty?:((file:string,args:string[],options:object)=>any)|null}} options */
  constructor({ send, onGesture = () => {}, onActivity = () => {}, spawnPty = null }) {
    this._send = send;
    this._onGesture = onGesture;
    this._onActivity = onActivity;
    this._spawnPty = spawnPty;
    /** @type {Map<number, {pty:any, scrollback:string, seq:number, lastPersisted:number, lastGesture:number, lastPriority:number, inputLine:string, outputTail:string, shell:string, pendingData:string, flushTimer:ReturnType<typeof setTimeout>|null, paused:boolean, chunksReceived:number, packetsSent:number}>} */
    this._sessions = new Map();
  }

  /** @param {number} id @param {any} entry */
  _flush(id, entry) {
    if (entry.flushTimer) clearTimeout(entry.flushTimer);
    entry.flushTimer = null;
    if (this._sessions.get(id) !== entry || !entry.pendingData) return;
    const data = entry.pendingData;
    entry.pendingData = '';
    entry.scrollback = (entry.scrollback + data).slice(-MAX_SCROLLBACK);
    entry.packetsSent++;
    this._send('terminal-data', { id, data, seq: entry.seq });
  }

  /** @param {any} entry @param {{mood:string,priority:number}|null} reaction */
  _react(entry, reaction) {
    if (!reaction) return;
    const now = Date.now();
    if (now - entry.lastGesture < GESTURE_COOLDOWN && reaction.priority <= entry.lastPriority)
      return;
    entry.lastGesture = now;
    entry.lastPriority = reaction.priority;
    this._onGesture(reaction.mood);
  }

  /** @param {number} id @param {string} cwd @param {{cols?:number,rows?:number}} [size] */
  open(id, cwd, size = {}) {
    let entry = this._sessions.get(id);
    if (!entry) {
      const shell = resolveShell();
      const spawnPty = this._spawnPty || require('node-pty').spawn;
      const child = spawnPty(shell.file, shell.args, {
        cwd,
        cols: Math.max(2, Math.min(500, Number(size.cols) || 80)),
        rows: Math.max(2, Math.min(200, Number(size.rows) || 24)),
        name: 'xterm-256color',
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          KAORU_INTEGRATED_TERMINAL: '1',
        },
      });
      entry = {
        pty: child,
        scrollback: '',
        seq: 0,
        lastPersisted: 0,
        lastGesture: 0,
        lastPriority: 0,
        inputLine: '',
        outputTail: '',
        shell: shell.label,
        pendingData: '',
        flushTimer: null,
        paused: false,
        chunksReceived: 0,
        packetsSent: 0,
      };
      this._sessions.set(id, entry);
      child.onData(
        /** @param {string} data */ (data) => {
          const live = this._sessions.get(id);
          if (!live || live !== entry) return;
          live.seq++;
          live.chunksReceived++;
          const output = (live.outputTail + data).slice(-1024);
          live.outputTail = data.slice(-128);
          this._react(live, outputReaction(output));
          live.pendingData += data;
          if (live.pendingData.length >= OUTPUT_BATCH_CHARS) this._flush(id, live);
          else if (!live.flushTimer)
            live.flushTimer = setTimeout(() => this._flush(id, live), OUTPUT_BATCH_MS);
        }
      );
      child.onExit(
        /** @param {{exitCode:number}} event */ ({ exitCode }) => {
          if (this._sessions.get(id) !== entry) return;
          this._flush(id, entry);
          this._sessions.delete(id);
          this._send('terminal-exit', { id, exitCode });
          this._onGesture(exitCode === 0 ? 'gentle' : 'sad');
        }
      );
    }
    // El snapshot y los paquetes posteriores no deben solaparse.
    this._flush(id, entry);
    return { id, shell: entry.shell, scrollback: entry.scrollback, seq: entry.seq };
  }

  /** @param {number} id @param {boolean} paused */
  setFlow(id, paused) {
    const entry = this._sessions.get(id);
    if (!entry || typeof paused !== 'boolean' || entry.paused === paused) return false;
    try {
      if (paused) entry.pty.pause();
      else entry.pty.resume();
      entry.paused = paused;
      return true;
    } catch {
      return false;
    }
  }

  /** @param {number} id */
  metrics(id) {
    const entry = this._sessions.get(id);
    return entry
      ? {
          chunksReceived: entry.chunksReceived,
          packetsSent: entry.packetsSent,
          paused: entry.paused,
        }
      : null;
  }

  /** @param {number} id @param {string} data */
  write(id, data) {
    const entry = this._sessions.get(id);
    if (!entry || typeof data !== 'string' || data.length > 65536) return false;
    if (data && Date.now() - entry.lastPersisted > 30000) {
      entry.lastPersisted = Date.now();
      this._onActivity(id);
    }
    for (const char of data) {
      if (char === '\r' || char === '\n') {
        this._react(entry, commandReaction(entry.inputLine));
        entry.inputLine = '';
      } else if (char === '\x7f' || char === '\b') {
        entry.inputLine = entry.inputLine.slice(0, -1);
      } else if (char >= ' ' && char !== '\x7f') {
        entry.inputLine = (entry.inputLine + char).slice(-512);
      }
    }
    entry.pty.write(data);
    return true;
  }

  /** @param {number} id @param {number} cols @param {number} rows */
  resize(id, cols, rows) {
    const entry = this._sessions.get(id);
    if (!entry) return false;
    entry.pty.resize(
      Math.max(2, Math.min(500, Number(cols) || 80)),
      Math.max(2, Math.min(200, Number(rows) || 24))
    );
    return true;
  }

  /** @param {number} id */
  close(id) {
    const entry = this._sessions.get(id);
    if (!entry) return false;
    if (entry.flushTimer) clearTimeout(entry.flushTimer);
    this._sessions.delete(id);
    try {
      entry.pty.kill();
    } catch {}
    return true;
  }

  closeAll() {
    for (const entry of this._sessions.values()) {
      if (entry.flushTimer) clearTimeout(entry.flushTimer);
      try {
        entry.pty.kill();
      } catch {}
    }
    this._sessions.clear();
  }
}

module.exports = { TerminalService, resolveShell };
