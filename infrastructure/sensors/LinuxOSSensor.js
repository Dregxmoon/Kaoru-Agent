// @ts-nocheck
'use strict';
const logger = require('../../core/observability/Logger.js');

const { spawn } = require('child_process');
const { BaseOSSensor } = require('./BaseOSSensor.js');

const IGNORED_APPS = new Set(['vtuber-overlay', 'electron', 'desktop-names', 'Hyprland']);

const APP_NAMES = {
  firefox: 'Firefox',
  chromium: 'Chromium',
  chrome: 'Chrome',
  Alacritty: 'Terminal',
  kitty: 'Terminal',
  foot: 'Terminal',
  ghostty: 'Terminal',
  wezterm: 'Terminal',
  Code: 'VS Code',
  cursor: 'Cursor',
  discord: 'Discord',
  vesktop: 'Discord',
  spotify: 'Spotify',
  obsidian: 'Obsidian',
  Thunar: 'Archivos',
  Nautilus: 'Archivos',
  nemo: 'Archivos',
  dolphin: 'Archivos',
  Blender: 'Blender',
  Gimp: 'GIMP',
  Inkscape: 'Inkscape',
  Krita: 'Krita',
  'libreoffice-writer': 'LibreOffice',
  'libreoffice-calc': 'LibreOffice',
  'libreoffice-impress': 'LibreOffice',
  Evince: 'Lector PDF',
  Zathura: 'Lector PDF',
  Sioyek: 'Lector PDF',
  vlc: 'VLC',
  mpv: 'mpv',
  TelegramDesktop: 'Telegram',
  'signal-desktop': 'Signal',
  slack: 'Slack',
  postman: 'Postman',
  insomnia: 'Insomnia',
  Steam: 'Steam',
  Lutris: 'Lutris',
  heroic: 'Heroic',
};

const APP_CATEGORIES = {
  code: ['Code', 'cursor', 'sublime_text', 'gnome-builder', 'kdevelop', 'android-studio'],
  terminal: ['Alacritty', 'kitty', 'foot', 'ghostty', 'wezterm', 'urxvt', 'st', 'xterm'],
  browser: [
    'firefox',
    'chromium',
    'chrome',
    'brave',
    'opera',
    'vivaldi',
    'thorium',
    'zen',
    'floorp',
  ],
  design: ['Gimp', 'Inkscape', 'Krita', 'Blender'],
  docs: [
    'libreoffice-writer',
    'libreoffice-calc',
    'libreoffice-impress',
    'Evince',
    'Zathura',
    'Sioyek',
    'obsidian',
    'logseq',
  ],
  chat: ['discord', 'vesktop', 'TelegramDesktop', 'signal-desktop', 'slack', 'whatsapp-for-linux'],
  media: ['spotify', 'vlc', 'mpv', 'celluloid', 'rhythmbox'],
  api: ['postman', 'insomnia'],
  files: ['Thunar', 'Nautilus', 'nemo', 'dolphin', 'pcmanfm'],
  system: ['gnome-settings', 'xfce4-settings', 'systemsettings'],
  game: ['steam', 'lutris', 'heroic', 'mangohud', 'gamescope', 'Steam'],
};

function _getFriendlyName(procName) {
  if (!procName) return 'Desconocido';
  return APP_NAMES[procName] || procName;
}

function _getCategory(procName) {
  if (!procName) return 'other';
  for (const [cat, apps] of Object.entries(APP_CATEGORIES)) {
    if (apps.includes(procName)) return cat;
  }
  return 'other';
}

function _formatElapsed(secs) {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function _exec(cmd, args = []) {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: 'pipe', timeout: 3000, encoding: 'utf8' });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => {
        stdout += d;
      });
      child.stderr.on('data', (d) => {
        stderr += d;
      });
      child.on('error', () => resolve(null));
      child.on('close', (code) => {
        resolve(code === 0 ? stdout.trim() : null);
      });
    } catch (_) {
      resolve(null);
    }
  });
}

function _execSync(cmd, args = []) {
  try {
    const { spawnSync } = require('child_process');
    const r = spawnSync(cmd, args, { stdio: 'pipe', timeout: 3000, encoding: 'utf8' });
    if (r.status !== 0) return null;
    return r.stdout.trim();
  } catch (_) {
    return null;
  }
}

function _checkBinary(name) {
  try {
    const r = _execSync('which', [name]);
    return r !== null;
  } catch (_) {
    return false;
  }
}

function _parseHyprctlWindow(raw) {
  const result = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^\t(\w+):\s+(.*)/);
    if (m) result[m[1]] = m[2].trim();
  }
  return result;
}

function _parseHyprctlClients(raw) {
  const windows = [];
  let current = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' && Object.keys(current).length) {
      windows.push(current);
      current = {};
      continue;
    }
    const m = trimmed.match(/^(\w+):\s+(.*)/);
    if (m) current[m[1]] = m[2].trim();
  }
  if (Object.keys(current).length) windows.push(current);
  return windows;
}

async function _getIdleSecs() {
  const loginctlOut = await _exec('loginctl', [
    'show-session',
    await _getActiveSessionId(),
    '-p',
    'IdleSinceHint',
    '-p',
    'IdleHint',
  ]);
  if (!loginctlOut) return 0;
  const hintMatch = loginctlOut.match(/IdleHint=(yes|no)/);
  const sinceMatch = loginctlOut.match(/IdleSinceHint=(\d+)/);
  if (!hintMatch || hintMatch[1] === 'no') return 0;
  if (!sinceMatch) return 0;
  const since = parseInt(sinceMatch[1], 10);
  return Math.max(0, Math.floor(Date.now() / 1000) - since);
}

async function _getActiveSessionId() {
  const out = await _exec('loginctl');
  if (!out) return '';
  const lines = out.split('\n').filter((l) => l.includes('panfilo') || l.includes('wayland'));
  if (!lines.length) return '';
  return lines[0].split(/\s+/)[0];
}

class LinuxOSSensor extends BaseOSSensor {
  constructor(stateGraph) {
    super(stateGraph, { logTag: 'linux-os-sensor' });
    this._hyprctlOk = _checkBinary('hyprctl');
    if (!this._hyprctlOk) {
      logger.warn(
        'LinuxOSSensor',
        '[linux-os-sensor] hyprctl no encontrado — sensor no funcionará'
      );
    }
  }

  async _poll() {
    if (this._pollBusy || !this._hyprctlOk) return;
    this._pollBusy = true;

    try {
      const raw = await _exec('hyprctl', ['activewindow']);
      if (!raw) {
        this._pollBusy = false;
        return;
      }

      const focus = _parseHyprctlWindow(raw);
      const app = focus.class || null;
      const title = focus.title || '';
      const pid = focus.pid || null;

      const idleSecs = await _getIdleSecs();

      if (!app || IGNORED_APPS.has(app)) {
        this._openWindows = [];
        this._processIdle(idleSecs);
        this._pollBusy = false;
        return;
      }

      const clientsRaw = await _exec('hyprctl', ['clients']);
      const openWindows = [];
      if (clientsRaw) {
        const allWindows = _parseHyprctlClients(clientsRaw);
        for (const w of allWindows) {
          const wClass = w.class || '';
          if (!wClass || IGNORED_APPS.has(wClass)) continue;
          openWindows.push({
            app: wClass,
            friendlyName: _getFriendlyName(wClass),
            title: w.title || '',
            category: _getCategory(wClass),
          });
        }
      }

      this._openWindows = openWindows;
      this._bus.emit('os:windows-updated', { windows: openWindows });
      this._processFocus(app, title);
      this._processIdle(idleSecs);
    } catch (e) {
      logger.warn('LinuxOSSensor', '[linux-os-sensor] error en poll:', e.message);
    }

    this._pollBusy = false;
  }

  getOpenWindowsSummary() {
    if (!this._openWindows.length) return null;
    return this._openWindows
      .map((w) => {
        const cleanTitle = w.title || '';
        return cleanTitle ? `${w.friendlyName} (${cleanTitle.slice(0, 50)})` : w.friendlyName;
      })
      .join(', ');
  }

  _getFriendlyName(procName) {
    return _getFriendlyName(procName);
  }

  _getCategory(procName) {
    return _getCategory(procName);
  }

  _formatElapsed(secs) {
    return _formatElapsed(secs);
  }

  _saveToHistory(app, title, start, end) {
    const duration = Math.round((end - start) / 1000);
    if (duration < 5) return;
    this._history.push({
      app,
      title: title || '',
      friendlyName: _getFriendlyName(app),
      start,
      end,
      duration,
    });
    if (this._history.length > this._maxHistory)
      this._history.splice(0, this._history.length - this._maxHistory);
  }
}

module.exports = { LinuxOSSensor, APP_CATEGORIES, APP_NAMES };
