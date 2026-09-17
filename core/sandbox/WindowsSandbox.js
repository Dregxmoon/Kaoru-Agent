// @ts-check
'use strict';

/**
 * Launcher del sandbox AppContainer de Windows.
 *
 * El aislamiento real vive en el helper nativo compilado por
 * compile-windows-sandbox.ps1. Este módulo solo gestiona su ciclo de vida y
 * nunca ejecuta el comando directamente si el helper no está disponible.
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_TIMEOUT = 30_000;
const PROFILE_PREFIX = 'KaoruAgent.OpenClaw';
const CACHE_VERSION = 2;
const TOOL_NAMES = ['node.exe', 'npm.cmd', 'npx.cmd', 'git.exe', 'python.exe', 'py.exe'];

/** @typedef {{ ok: boolean, stdout: string, stderr: string, exitCode: number | null, signal: string | null, error?: string }} SandboxResult */

class WindowsSandbox {
  /**
   * @param {{ cwd?: string, platform?: NodeJS.Platform, spawnImpl?: typeof spawn, cacheDir?: string }} [opts]
   */
  constructor(opts = {}) {
    this._cwd = path.resolve(opts.cwd || process.cwd());
    this._platform = opts.platform || process.platform;
    this._spawn = opts.spawnImpl || spawn;
    this._enabled = false;
    /** @type {string | null} */
    this._reason =
      this._platform === 'win32' ? 'AppContainer pendiente de inicialización' : 'requiere Windows';
    /** @type {Promise<boolean> | null} */
    this._initializing = null;
    const localData = process.env.LOCALAPPDATA || os.tmpdir();
    this._cacheDir = opts.cacheDir || path.join(localData, 'KaoruAgent', 'sandbox');
    this._helperPath = path.join(this._cacheDir, 'Kaoru.WindowsSandbox.exe');
    this._metadataPath = path.join(this._cacheDir, 'helper-metadata.json');
    this._prebuiltHelperPath = path.join(process.resourcesPath || '', 'Kaoru.WindowsSandbox.exe');
    this._compilerSource = path.join(__dirname, 'compile-windows-sandbox.ps1');
    this._compilerScript = path.join(this._cacheDir, 'compile-windows-sandbox.ps1');
    const workspaceId = crypto.createHash('sha256').update(this._cwd).digest('hex').slice(0, 16);
    this._profileName = `${PROFILE_PREFIX}.${workspaceId}`;
  }

  /** @returns {boolean} */
  sandboxEnabled() {
    return this._enabled;
  }

  /** @returns {string | null} */
  sandboxReason() {
    return this._enabled ? null : this._reason;
  }

  /**
   * Compila el helper, crea el perfil AppContainer, concede acceso únicamente
   * al workspace y prueba una ejecución real dentro del contenedor.
   * @returns {Promise<boolean>}
   */
  initialize() {
    if (this._initializing) return this._initializing;
    this._initializing = this._initializeOnce();
    return this._initializing;
  }

  /** @private @returns {Promise<boolean>} */
  async _initializeOnce() {
    if (this._platform !== 'win32') return false;
    try {
      fs.mkdirSync(this._cacheDir, { recursive: true });

      if (!this._cachedHelperIsValid()) {
        if (fs.existsSync(this._prebuiltHelperPath)) {
          fs.copyFileSync(this._prebuiltHelperPath, this._helperPath);
        } else {
          const powershell = WindowsSandbox.findPowerShell();
          if (!powershell) throw new Error('Windows PowerShell 5.1 no está disponible');
          // Node puede leer dentro de app.asar, PowerShell no. Los clones
          // materializan y compilan la fuente; los releases traen el helper
          // precompilado por after-pack.js.
          fs.copyFileSync(this._compilerSource, this._compilerScript);
          const compiled = await this._runProcess(
            powershell,
            [
              '-NoLogo',
              '-NoProfile',
              '-NonInteractive',
              '-ExecutionPolicy',
              'Bypass',
              '-File',
              this._compilerScript,
              '-OutputPath',
              this._helperPath,
            ],
            120_000
          );
          if (!compiled.ok || !fs.existsSync(this._helperPath)) {
            throw new Error(compiled.stderr.trim() || 'no se pudo compilar el helper AppContainer');
          }
        }
        this._writeCacheMetadata();
      }

      const marker = path.join(this._cwd, `.kaoru-appcontainer-${process.pid}.tmp`);
      try {
        // Evitar cmd.exe para el self-test: `/s /c` vuelve a interpretar
        // comillas y redirecciones, y una ruta temporal con espacios puede
        // producir ERROR_INVALID_NAME antes de probar el AppContainer. El
        // ejecutable empaquetado de Electron tampoco es un runner de Node:
        // sus fuses pueden ignorar ELECTRON_RUN_AS_NODE y abrir otra instancia
        // completa de Kaoru. PowerShell recibe la ruta como argumento separado
        // y prueba ejecución + escritura sin interpolarla en un shell.
        const powershell = WindowsSandbox.findPowerShell();
        if (!powershell) throw new Error('Windows PowerShell 5.1 no está disponible');
        const probe = await this._runHelper(
          [
            powershell,
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            "[IO.File]::WriteAllText($args[0], 'ok')",
            marker,
          ],
          {
            cwd: this._cwd,
            timeout: 30_000,
          }
        );
        if (!probe.ok || !fs.existsSync(marker)) {
          throw new Error(probe.error || probe.stderr || 'falló el self-test AppContainer');
        }
      } finally {
        try {
          fs.unlinkSync(marker);
        } catch (_) {}
      }

      this._enabled = true;
      this._reason = null;
      return true;
    } catch (error) {
      this._enabled = false;
      this._reason = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  /** @private @param {string} filePath @returns {string} */
  _hashFile(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  }

  /** @private @returns {boolean} */
  _cachedHelperIsValid() {
    try {
      const metadata = JSON.parse(fs.readFileSync(this._metadataPath, 'utf8'));
      return (
        metadata.version === CACHE_VERSION &&
        metadata.sourceSha256 === this._hashFile(this._compilerSource) &&
        metadata.helperSha256 === this._hashFile(this._helperPath)
      );
    } catch (_) {
      return false;
    }
  }

  /** @private */
  _writeCacheMetadata() {
    const metadata = {
      version: CACHE_VERSION,
      sourceSha256: this._hashFile(this._compilerSource),
      helperSha256: this._hashFile(this._helperPath),
    };
    const temporary = `${this._metadataPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(metadata)}\n`, 'utf8');
    fs.renameSync(temporary, this._metadataPath);
  }

  /**
   * Devuelve el argv que hace pasar un proceso por el helper AppContainer.
   * Lanza una excepción si el aislamiento no está listo: nunca degrada a una
   * ejecución directa silenciosa.
   * @param {string[]} commandArgs
   * @param {{ cwd?: string, timeout?: number }} [opts]
   * @returns {string[]}
   */
  wrap(commandArgs, opts = {}) {
    if (!this._enabled) {
      throw new Error(`sandbox AppContainer no disponible: ${this._reason}`);
    }
    if (!Array.isArray(commandArgs) || commandArgs.length === 0) {
      throw new Error('comando vacío');
    }
    const cwd = path.resolve(opts.cwd || this._cwd);
    if (!WindowsSandbox.isWithin(this._cwd, cwd)) {
      throw new Error(`cwd fuera del workspace permitido: ${cwd}`);
    }
    const timeout = Math.max(1, Math.min(opts.timeout || DEFAULT_TIMEOUT, 120_000));
    const normalizedArgs = commandArgs.slice();
    if (normalizedArgs[0]?.toLowerCase() === 'cmd.exe') {
      const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
      normalizedArgs[0] =
        process.env.ComSpec ||
        process.env.COMSPEC ||
        (systemRoot ? path.join(systemRoot, 'System32', 'cmd.exe') : normalizedArgs[0]);
    }
    return [
      this._helperPath,
      '--profile',
      this._profileName,
      '--workspace64',
      Buffer.from(this._cwd, 'utf8').toString('base64'),
      '--cwd64',
      Buffer.from(cwd, 'utf8').toString('base64'),
      '--readroots64',
      Buffer.from(WindowsSandbox.toolReadRoots().join('\n'), 'utf8').toString('base64'),
      '--timeout',
      String(timeout),
      '--',
      ...normalizedArgs.map((arg) => Buffer.from(String(arg), 'utf8').toString('base64')),
    ];
  }

  /**
   * @private
   * @param {string[]} commandArgs
   * @param {{ cwd?: string, timeout?: number }} [opts]
   * @returns {Promise<SandboxResult>}
   */
  _runHelper(commandArgs, opts = {}) {
    const wasEnabled = this._enabled;
    this._enabled = true;
    let wrapped;
    try {
      wrapped = this.wrap(commandArgs, opts);
    } finally {
      this._enabled = wasEnabled;
    }
    return this._runProcess(wrapped[0], wrapped.slice(1), opts.timeout || DEFAULT_TIMEOUT);
  }

  /**
   * @private
   * @param {string} executable
   * @param {string[]} args
   * @param {number} timeout
   * @returns {Promise<SandboxResult>}
   */
  _runProcess(executable, args, timeout) {
    return new Promise((resolve) => {
      let settled = false;
      let stdout = '';
      let stderr = '';
      const child = this._spawn(executable, args, {
        cwd: this._cwd,
        env: WindowsSandbox.minimalWindowsEnv(),
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      /** @param {Partial<SandboxResult> & { ok: boolean, exitCode: number | null }} result */
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, signal: null, ...result });
      };
      if (child.stdout) {
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
          stdout += chunk;
        });
      }
      if (child.stderr) {
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => {
          stderr += chunk;
        });
      }
      const timer = setTimeout(() => {
        child.kill();
        finish({ ok: false, exitCode: null, error: 'timeout' });
      }, timeout);
      child.on('error', (error) => {
        finish({ ok: false, exitCode: null, error: error.message });
      });
      child.on('close', (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          ok: code === 0,
          stdout,
          stderr,
          exitCode: code,
          signal,
          ...(code === 0 ? {} : { error: stderr.trim() || `exit code ${code}` }),
        });
      });
    });
  }

  /** @returns {string | null} */
  static findPowerShell() {
    const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
    if (systemRoot) {
      const candidate = path.join(
        systemRoot,
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe'
      );
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  /** @returns {NodeJS.ProcessEnv} */
  static minimalWindowsEnv() {
    /** @type {NodeJS.ProcessEnv} */
    const env = {};
    for (const key of [
      'SystemRoot',
      'SYSTEMROOT',
      'WINDIR',
      'ComSpec',
      'COMSPEC',
      'PATH',
      'PATHEXT',
      'TEMP',
      'TMP',
      'ProgramFiles',
      'ProgramFiles(x86)',
      'ProgramData',
      'USERPROFILE',
      'APPDATA',
      'LOCALAPPDATA',
    ]) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    env.ELECTRON_RUN_AS_NODE = '1';
    return env;
  }

  /** @returns {string[]} */
  static toolReadRoots() {
    const roots = new Set();
    /** @param {string} candidate */
    const add = (candidate) => {
      try {
        if (candidate && fs.statSync(candidate).isDirectory())
          roots.add(fs.realpathSync(candidate));
      } catch (_) {}
    };
    add(path.dirname(process.execPath));
    for (const entry of String(process.env.PATH || '').split(path.delimiter)) {
      if (!entry) continue;
      if (TOOL_NAMES.some((name) => fs.existsSync(path.join(entry, name)))) {
        add(entry);
        if (path.basename(entry).toLowerCase() === 'cmd') add(path.dirname(entry));
      }
    }
    return [...roots].slice(0, 24);
  }

  /** @param {string} root @param {string} candidate @returns {boolean} */
  static isWithin(root, candidate) {
    const rel = path.relative(path.resolve(root), path.resolve(candidate));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  }
}

module.exports = { WindowsSandbox, PROFILE_PREFIX };
