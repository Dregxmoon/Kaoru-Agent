// @ts-check
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { isUrlSafe } = require('../security/UrlGuard.js');
const { runJsonProcess } = require('./JsonProcess.js');

/** @type {Readonly<Record<string, string>>} */
const SITE_ALIASES = Object.freeze({
  calendar: 'https://calendar.google.com/',
  drive: 'https://drive.google.com/',
  gmail: 'https://mail.google.com/',
  github: 'https://github.com/',
  maps: 'https://maps.google.com/',
  spotify: 'https://open.spotify.com/',
  whatsapp: 'https://web.whatsapp.com/',
  youtube: 'https://www.youtube.com/',
});

/** @type {Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>} */
const APP_ALIASES = Object.freeze({
  brave: Object.freeze({
    linux: ['brave-browser', 'brave'],
    darwin: ['Brave Browser'],
    win32: ['brave.exe'],
  }),
  chrome: Object.freeze({
    linux: ['google-chrome', 'google-chrome-stable'],
    darwin: ['Google Chrome'],
    win32: ['chrome.exe'],
  }),
  chromium: Object.freeze({
    linux: ['chromium', 'chromium-browser'],
    darwin: ['Chromium'],
    win32: ['chromium.exe'],
  }),
  code: Object.freeze({ linux: ['code'], darwin: ['Visual Studio Code'], win32: ['Code.exe'] }),
  discord: Object.freeze({ linux: ['discord'], darwin: ['Discord'], win32: ['Discord.exe'] }),
  edge: Object.freeze({
    linux: ['microsoft-edge', 'microsoft-edge-stable'],
    darwin: ['Microsoft Edge'],
    win32: ['msedge.exe'],
  }),
  firefox: Object.freeze({ linux: ['firefox'], darwin: ['Firefox'], win32: ['firefox.exe'] }),
  steam: Object.freeze({ linux: ['steam'], darwin: ['Steam'], win32: ['steam.exe'] }),
});

const BROWSER_ALIASES = new Set(['brave', 'chrome', 'chromium', 'edge', 'firefox']);
const MAX_APPS = 250;
const MAX_DISCOVERED_APPS = 2000;

/** @typedef {{safe: boolean, reason?: string}} UrlSafety */
/** @typedef {{name: string, id: string, source?: string, aliases?: string[]}} InstalledApp */
/** @typedef {(command: string, args: string[], options: object) => import('child_process').ChildProcess} SpawnFn */
/** @typedef {(url: string) => Promise<unknown>} OpenExternalFn */
/** @typedef {(url: string, opts?: {timeout?: number}) => Promise<UrlSafety>} UrlGuardFn */
/** @typedef {{pid:number,name:string}[]} ProcessList */

/** @param {unknown} value */
function _normalize(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

/** @param {unknown} value @param {string} field */
function _assertSafeLabel(value, field) {
  const text = String(value || '').trim();
  if (!text || text.length > 120) throw new Error(`${field} inválido`);
  const hasControlCharacter = [...text].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  if (/^[-/\\]/.test(text) || hasControlCharacter) {
    throw new Error(`${field} contiene caracteres no permitidos`);
  }
  return text;
}

/**
 * Idioma del sistema para nombres localizados (p.ej. "es" desde es_MX.UTF-8).
 * Genérico: sin listas por idioma, solo prefijo del locale del entorno.
 */
function _systemLang() {
  const raw = String(
    (typeof process !== 'undefined' && process.env && (process.env.LC_ALL || process.env.LANG)) ||
      ''
  ).toLowerCase();
  const match = /^[a-z]{2,3}/.exec(raw);
  return match ? match[0] : '';
}

/** @param {string} content @param {string} id @returns {InstalledApp|null} */
function _parseDesktopEntry(content, id) {
  let inEntry = false;
  let name = '';
  let hidden = false;
  let noDisplay = false;
  let type = '';
  /** @type {Map<string, string>} lang → nombre (Name[xx]) */
  const localized = new Map();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('[')) {
      inEntry = line === '[Desktop Entry]';
      continue;
    }
    if (!inEntry || !line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1).trim();
    if (key === 'Name' && !name) name = value;
    else if (key.startsWith('Name[') && key.endsWith(']')) {
      const lang = key.slice(5, -1).toLowerCase();
      if (lang && value && !localized.has(lang)) localized.set(lang, value);
    } else if (key === 'Type') type = value;
    else if (key === 'Hidden') hidden = value.toLowerCase() === 'true';
    else if (key === 'NoDisplay') noDisplay = value.toLowerCase() === 'true';
  }
  // El nombre primario muta con el usuario: Name[su idioma] → Name genérico.
  // Los demás nombres viajan como aliases para que "calculadora" encuentre
  // Calculator sin listas de apps por idioma en el código.
  const systemLang = _systemLang();
  let primary = name;
  if (systemLang) {
    primary =
      localized.get(systemLang) ||
      [...localized.entries()].find(([lang]) => lang.startsWith(systemLang))?.[1] ||
      name;
  }
  primary = primary || name || [...localized.values()][0] || '';
  if (!primary || type !== 'Application' || hidden || noDisplay) return null;
  const aliases = [...new Set([name, ...localized.values()])]
    .filter((candidate) => candidate && candidate !== primary)
    .map((candidate) => candidate.slice(0, 120))
    .slice(0, 8);
  return { name: primary.slice(0, 120), id, aliases };
}

class DesktopControl {
  /**
   * @param {{platform?: NodeJS.Platform, spawnImpl?: SpawnFn, processRunner?: typeof runJsonProcess, openExternal?: OpenExternalFn|null, urlGuard?: UrlGuardFn, homeDir?: string, env?: NodeJS.ProcessEnv, processLister?: (()=>Promise<ProcessList>)|null, killProcess?: ((pid:number)=>Promise<void>|void)|null, cameraStatus?: (()=>Promise<string>|string)|null, websiteResolver?: {resolve: (target: string) => Promise<{url: string, resolvedBy: string, query?: string}>}|null}} [options]
   */
  constructor(options = {}) {
    this._platform = options.platform || process.platform;
    this._spawn = options.spawnImpl || spawn;
    this._processRunner = options.processRunner || runJsonProcess;
    this._openExternal = options.openExternal || null;
    this._urlGuard = options.urlGuard || isUrlSafe;
    this._homeDir = options.homeDir || os.homedir();
    this._env = options.env || process.env;
    this._processLister = options.processLister || null;
    this._killProcess = options.killProcess || null;
    this._cameraStatus = options.cameraStatus || null;
    this._websiteResolver = options.websiteResolver || null;
  }

  /**
   * Inyecta el resolver universal de destinos (mismo contrato que usa
   * OpenClawBridge). Sin resolver, los destinos desconocidos se rechazan.
   * @param {{resolve: (target: string) => Promise<{url: string, resolvedBy: string, query?: string}>}|null} resolver
   */
  setWebsiteResolver(resolver) {
    this._websiteResolver = resolver || null;
  }

  getWebsiteResolver() {
    return this._websiteResolver;
  }

  /** @returns {Promise<InstalledApp[]>} */
  async listApps() {
    if (this._platform === 'linux') return this._listLinuxApps();
    if (this._platform === 'darwin') return this._listMacApps();
    if (this._platform === 'win32') return this._listWindowsApps();
    return [];
  }

  /** @param {{query?: unknown}} [params] */
  async searchApps(params = {}) {
    const query = _normalize(params.query);
    const apps = await this.listApps();
    return (
      query
        ? apps.filter(
            (app) =>
              _normalize(app.name).includes(query) ||
              (Array.isArray(app.aliases) &&
                app.aliases.some((alias) => _normalize(alias).includes(query)))
          )
        : apps
    ).slice(0, MAX_APPS);
  }

  /** @param {{app?: unknown}} params */
  async launchApp(params) {
    const requested = _assertSafeLabel(params && params.app, 'Aplicación');
    const normalized = _normalize(requested);
    const alias = APP_ALIASES[normalized];
    if (alias) {
      await this._launchApplicationCandidates(alias[this._platform] || [], []);
      return { kind: 'application', app: requested, status: 'spawned', verified: false };
    }

    const apps = await this.listApps();
    const matched = apps.find(
      (app) =>
        _normalize(app.name) === normalized ||
        _normalize(app.id) === normalized ||
        (Array.isArray(app.aliases) &&
          app.aliases.some((alias) => _normalize(alias) === normalized))
    );
    if (!matched) {
      throw new Error(`Aplicación no encontrada: ${requested}. Usa list_apps para ver opciones.`);
    }
    if (this._platform === 'linux') await this._spawnDetached('gtk-launch', [matched.id]);
    else if (this._platform === 'darwin') await this._spawnDetached('open', ['-a', matched.name]);
    else if (this._platform === 'win32') {
      if (matched.source === 'start-app') {
        await this._launchWindows('explorer.exe', [`shell:AppsFolder\\${matched.id}`]);
      } else {
        await this._launchWindows(matched.id, []);
      }
    } else throw new Error(`Plataforma no compatible: ${this._platform}`);
    return { kind: 'application', app: matched.name, status: 'spawned', verified: false };
  }

  /** @param {{target?: unknown, browser?: unknown}} params */
  async openWebsite(params) {
    const rawTarget = String((params && params.target) || '').trim();
    if (!rawTarget || rawTarget.length > 2048) throw new Error('Sitio o URL inválido');
    const aliasUrl = SITE_ALIASES[_normalize(rawTarget)];
    let candidate = aliasUrl || rawTarget;
    /** @type {{url: string, resolvedBy: string, query?: string}|null} */
    let resolved = aliasUrl ? { url: aliasUrl, resolvedBy: 'alias' } : null;
    let parsed = null;
    try {
      parsed = new URL(candidate);
    } catch (_) {
      parsed = null;
    }
    if (!parsed && this._websiteResolver) {
      // P0: mismo contrato que OpenClawBridge — un destino desconocido se
      // resuelve en runtime (búsqueda + scoring + UrlGuard) en vez de exigir
      // sitios predefinidos. Ya era URL/alias: no se toca la red.
      resolved = await this._websiteResolver.resolve(rawTarget);
      candidate = resolved.url;
      try {
        parsed = new URL(candidate);
      } catch (_) {
        parsed = null;
      }
    }
    if (!parsed) {
      throw new Error('Usa un sitio conocido (por ejemplo youtube) o una URL https completa');
    }
    if (parsed.protocol !== 'https:') throw new Error('Solo se permiten URLs https');
    if (parsed.username || parsed.password)
      throw new Error('No se permiten credenciales dentro de la URL');
    const safety = await this._urlGuard(parsed.href, { timeout: 3000 });
    if (!safety.safe) throw new Error(`URL bloqueada: ${safety.reason || 'destino no seguro'}`);

    const browser = _normalize(params && params.browser);
    if (browser) {
      if (!BROWSER_ALIASES.has(browser)) throw new Error(`Navegador no permitido: ${browser}`);
      const alias = APP_ALIASES[browser];
      await this._launchApplicationCandidates(alias[this._platform] || [], [parsed.href]);
    } else {
      await this._openInDefaultBrowser(parsed.href);
    }

    parsed.search = '';
    parsed.hash = '';
    return {
      kind: 'website',
      url: parsed.href,
      browser: browser || 'default',
      ...(resolved ? { resolvedBy: resolved.resolvedBy } : {}),
      ...(resolved && resolved.query ? { resolvedFromQuery: resolved.query } : {}),
    };
  }

  /** @param {{query?: unknown, limit?: unknown}} [params] */
  async listProcesses(params = {}) {
    const query = _normalize(params.query);
    const limit = Math.min(250, Math.max(1, Number(params.limit) || 100));
    let processes;
    if (this._processLister) {
      processes = await this._processLister();
    } else if (this._platform === 'win32') {
      const result = await this._processRunner(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          path.join(__dirname, 'helpers', 'windows_processes.ps1'),
        ],
        {},
        { timeout: 10_000, env: this._env }
      );
      if (!result.ok) throw new Error(String(result.error || 'No se pudieron listar procesos'));
      processes = Array.isArray(result.processes) ? result.processes : [];
    } else if (this._platform === 'linux' || this._platform === 'darwin') {
      const output = await this._runTextProcess('ps', ['-axo', 'pid=,comm=']);
      processes = output.split(/\r?\n/).flatMap((line) => {
        const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
        return match ? [{ pid: Number(match[1]), name: String(match[2]) }] : [];
      });
    } else {
      processes = [];
    }
    return processes
      .map((item) => ({ pid: Number(item.pid) || 0, name: String(item.name || '').slice(0, 160) }))
      .filter(
        (item) => item.pid > 0 && item.name && (!query || _normalize(item.name).includes(query))
      )
      .slice(0, limit);
  }

  /** @param {{pid?: unknown}} params */
  async stopProcess(params) {
    const pid = Number(params && params.pid);
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) {
      throw new Error('PID no permitido');
    }
    if (this._killProcess) await this._killProcess(pid);
    else process.kill(pid, 'SIGTERM');
    return {
      kind: 'desktop_action',
      action: 'process_stop',
      pid,
      signal: 'SIGTERM',
      executed: true,
      actionVerified: true,
      intentVerified: false,
      status: 'executed_unverified',
      requiresObservation: true,
    };
  }

  async getCameraStatus() {
    let status = 'unknown';
    if (this._cameraStatus) {
      status = String(await this._cameraStatus());
    } else {
      try {
        const electron = require('electron');
        if (typeof electron?.systemPreferences?.getMediaAccessStatus === 'function') {
          status = String(electron.systemPreferences.getMediaAccessStatus('camera'));
        }
      } catch (_) {}
    }
    return {
      kind: 'camera_status',
      platform: this._platform,
      status,
      captureSupported: false,
      note: 'Kaoru no captura video silenciosamente; solo puede abrir una aplicación de cámara.',
    };
  }

  async openCamera() {
    if (this._platform === 'win32') {
      await this._spawnDetached('explorer.exe', ['microsoft.windows.camera:']);
    } else if (this._platform === 'darwin') {
      await this._spawnDetached('open', ['-a', 'Photo Booth']);
    } else if (this._platform === 'linux') {
      await this._launchApplicationCandidates(['gnome-camera', 'snapshot', 'cheese', 'kamoso'], []);
    } else {
      throw new Error(`Cámara no compatible con ${this._platform}`);
    }
    return { kind: 'camera', status: 'spawned', verified: false };
  }

  async capabilities() {
    return {
      kind: 'desktop_capabilities',
      platform: this._platform,
      capabilities: {
        applications: true,
        browser: true,
        screen: ['linux', 'win32'].includes(this._platform),
        pointer: ['linux', 'win32'].includes(this._platform),
        keyboard: ['linux', 'win32'].includes(this._platform),
        processes: ['linux', 'darwin', 'win32'].includes(this._platform),
        camera: ['linux', 'darwin', 'win32'].includes(this._platform),
        cameraCapture: false,
      },
    };
  }

  /** @param {string} tool @param {object} [params] */
  async execute(tool, params = {}) {
    if (tool === 'list_apps') return this.searchApps(params);
    if (tool === 'launch_app') return this.launchApp(params);
    if (tool === 'open_website') return this.openWebsite(params);
    if (tool === 'process_list') return this.listProcesses(params);
    if (tool === 'process_stop') return this.stopProcess(params);
    if (tool === 'camera_status') return this.getCameraStatus();
    if (tool === 'open_camera') return this.openCamera();
    if (tool === 'desktop_capabilities') return this.capabilities();
    throw new Error(`Herramienta de escritorio desconocida: ${tool}`);
  }

  /** @returns {Promise<InstalledApp[]>} */
  async _listLinuxApps() {
    const dataHome = this._env.XDG_DATA_HOME || path.join(this._homeDir, '.local', 'share');
    const dirs = [
      path.join(dataHome, 'applications'),
      '/usr/local/share/applications',
      '/usr/share/applications',
      path.join(this._homeDir, '.local/share/flatpak/exports/share/applications'),
      '/var/lib/flatpak/exports/share/applications',
      '/var/lib/snapd/desktop/applications',
    ];
    /** @type {Map<string, InstalledApp>} */
    const found = new Map();
    for (const dir of dirs) {
      let files;
      try {
        files = await fs.promises.readdir(dir);
      } catch (_) {
        continue;
      }
      for (const filename of files.slice(0, 1000)) {
        if (!filename.endsWith('.desktop') || found.size >= MAX_DISCOVERED_APPS) continue;
        const desktopId = filename.slice(0, -8);
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(desktopId)) continue;
        try {
          const content = await fs.promises.readFile(path.join(dir, filename), 'utf8');
          if (content.length > 256 * 1024) continue;
          const app = _parseDesktopEntry(content, desktopId);
          if (app && !found.has(_normalize(app.name))) found.set(_normalize(app.name), app);
        } catch (_) {}
      }
    }
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** @returns {Promise<InstalledApp[]>} */
  async _listMacApps() {
    const dirs = ['/Applications', path.join(this._homeDir, 'Applications')];
    /** @type {Map<string, InstalledApp>} */
    const found = new Map();
    for (const dir of dirs) {
      let entries;
      try {
        entries = await fs.promises.readdir(dir);
      } catch (_) {
        continue;
      }
      for (const entry of entries) {
        if (!entry.endsWith('.app')) continue;
        const name = entry.slice(0, -4);
        found.set(_normalize(name), { name, id: name });
      }
    }
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_APPS);
  }

  /** @returns {Promise<InstalledApp[]>} */
  async _listWindowsApps() {
    /** @type {string[]} */
    const roots = [];
    if (this._env.APPDATA)
      roots.push(path.join(this._env.APPDATA, 'Microsoft', 'Windows', 'Start Menu'));
    if (this._env.ProgramData)
      roots.push(path.join(this._env.ProgramData, 'Microsoft', 'Windows', 'Start Menu'));
    /** @type {Map<string, InstalledApp>} */
    const found = new Map();
    /** @type {string[]} */
    const pending = [...roots];
    let visitedDirectories = 0;
    while (pending.length && visitedDirectories++ < 1000 && found.size < MAX_APPS) {
      const directory = pending.shift();
      if (!directory) break;
      /** @type {import('fs').Dirent[]} */
      let entries;
      try {
        entries = await fs.promises.readdir(directory, { withFileTypes: true });
      } catch (_) {
        continue;
      }
      for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          pending.push(fullPath);
          continue;
        }
        if (!/\.(lnk|url|exe)$/i.test(entry.name)) continue;
        const name = entry.name.replace(/\.(lnk|url|exe)$/i, '').trim();
        if (!name || found.has(_normalize(name))) continue;
        found.set(_normalize(name), {
          name: name.slice(0, 120),
          id: fullPath,
          source: 'start-menu',
        });
        if (found.size >= MAX_APPS) break;
      }
    }
    try {
      const discovered = await this._processRunner(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          path.join(__dirname, 'helpers', 'windows_list_apps.ps1'),
        ],
        {},
        { timeout: 10_000, env: this._env }
      );
      for (const app of Array.isArray(discovered.apps) ? discovered.apps : []) {
        const name = String(app.name || '').trim();
        const id = String(app.id || '').trim();
        if (!name || !id || name.length > 120 || id.length > 300) continue;
        if ([...name, ...id].some((character) => character.charCodeAt(0) < 32)) continue;
        if (!found.has(_normalize(name))) {
          found.set(_normalize(name), { name, id, source: 'start-app' });
        }
      }
    } catch (_) {}
    for (const name of Object.keys(APP_ALIASES)) {
      if (!found.has(name)) found.set(name, { name, id: name, source: 'alias' });
    }
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_APPS);
  }

  /** @param {readonly string[]} candidates @param {string[]} args */
  async _launchApplicationCandidates(candidates, args) {
    if (!candidates.length) throw new Error(`Aplicación no compatible con ${this._platform}`);
    let lastError = null;
    for (const candidate of candidates) {
      try {
        if (this._platform === 'darwin')
          await this._spawnDetached('open', ['-a', candidate, ...args]);
        else if (this._platform === 'win32') await this._launchWindows(candidate, args);
        else await this._spawnDetached(candidate, args);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    const message = lastError instanceof Error ? lastError.message : 'ejecutable no encontrado';
    throw new Error(`No se pudo abrir la aplicación: ${message}`);
  }

  /** @param {string} target @param {string[]} args */
  async _launchWindows(target, args) {
    const result = await this._processRunner(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(__dirname, 'helpers', 'windows_launch.ps1'),
      ],
      { target, args },
      { timeout: 10_000, env: this._env }
    );
    if (!result.ok) throw new Error(String(result.error || 'Windows rechazó el lanzamiento'));
  }

  /** @param {string} url */
  async _openInDefaultBrowser(url) {
    if (this._openExternal) {
      await this._openExternal(url);
      return;
    }
    try {
      const electron = require('electron');
      if (electron && electron.shell && typeof electron.shell.openExternal === 'function') {
        await electron.shell.openExternal(url);
        return;
      }
    } catch (_) {}
    if (this._platform === 'darwin') await this._spawnDetached('open', [url]);
    else if (this._platform === 'win32') await this._spawnDetached('explorer.exe', [url]);
    else await this._spawnDetached('xdg-open', [url]);
  }

  /** @param {string} command @param {string[]} args @returns {Promise<void>} */
  _spawnDetached(command, args, envOverrides = {}) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const child = this._spawn(command, args, {
        detached: true,
        env: { ...this._env, ...envOverrides },
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.once('error', (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
      child.once('spawn', () => {
        if (!settled) {
          settled = true;
          child.unref();
          resolve(undefined);
        }
      });
    });
  }

  /** @param {string} command @param {string[]} args @returns {Promise<string>} */
  _runTextProcess(command, args) {
    return new Promise((resolve, reject) => {
      const child = this._spawn(command, args, {
        env: this._env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      if (!child.stdout || !child.stderr) {
        child.kill();
        reject(new Error('El proceso no expuso canales de salida seguros'));
        return;
      }
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(new Error('La consulta de procesos agotó el tiempo'));
      }, 10_000);
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
        if (stdout.length > 512 * 1024) child.kill();
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.once('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) reject(new Error(stderr.trim() || `ps terminó con código ${String(code)}`));
        else resolve(stdout);
      });
    });
  }
}

/** @type {DesktopControl|null} */
let _instance = null;
function getDesktopControl() {
  if (!_instance) _instance = new DesktopControl();
  return _instance;
}

module.exports = {
  APP_ALIASES,
  BROWSER_ALIASES,
  SITE_ALIASES,
  DesktopControl,
  getDesktopControl,
  _normalize,
  _parseDesktopEntry,
};
