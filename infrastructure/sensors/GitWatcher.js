/**
 * GitWatcher.js — vigila el repositorio del workspace activo y emite
 * señales cuando hay algo que vale la pena saber:
 *
 *   git:redflag
 *     - env_unignored      → existe .env y NO está en .gitignore (riesgo de
 *                            filtrar secretos)
 *     - merge_conflict     → hay archivos con conflicto de merge sin resolver
 *     - uncommitted        → demasiados archivos modificados sin commitear
 *     - unpushed_commits   → commits locales sin subir a la rama remota
 *   git:branch-changed     → el usuario cambió de rama
 *
 * Reglas de diseño:
 *   - Silencio total si el workspace no es un repo git (no emite nada, no
 *     tira errores). La proactividad de git es una capacidad extra.
 *   - Emisión por flanco ascendente: solo cuando la condición PASA de falsa
 *     a verdadera, para no repetir la misma señal cada poll. El cooldown por
 *     tipo del ProactiveEngine se encarga del resto.
 *   - Nunca lanza: cada scan está aislado, un error de git solo se loggea.
 *
 * Inyectable para tests: `exec` recibe (args, opts, cb) y responde
 * cb(err, { code, stdout }) — por defecto usa child_process.execFile.
 */

'use strict';

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const { getEventBus } = require('../../infrastructure/event-bus/EventBus.js');

const DEFAULT_POLL_MS = 5 * 60 * 1000;
const UNCOMMITTED_THRESHOLD = 12; // archivos modificados a partir de los cuales es "demasiados"

function _defaultExec(args, opts, cb) {
  execFile(
    'git',
    args,
    { cwd: opts.cwd, timeout: opts.timeout || 10000, maxBuffer: opts.maxBuffer || 2 * 1024 * 1024 },
    (err, stdout) => {
      // err.code numérico = el comando corrió y devolvió exit != 0 (normal para
      // check-ignore, rev-list sin upstream, etc.). Sin err o err.code no
      // numérico (ENOENT/signal) = fallo fatal del proceso git en sí.
      if (err && typeof err.code !== 'number') return cb(err);
      cb(null, { code: err ? err.code : 0, stdout: stdout || '' });
    }
  );
}

class GitWatcher {
  constructor({
    workspace = null,
    pollMs = DEFAULT_POLL_MS,
    bus = getEventBus(),
    exec = _defaultExec,
  } = {}) {
    this._bus = bus;
    this._workspace = workspace;
    this._pollMs = pollMs;
    this._exec = exec;
    this._timer = null;
    this._running = false;
    this._polling = false;
    this._branch = null;
    this._flags = {};
    this._lastError = null;
  }

  setWorkspace(ws) {
    this._workspace = ws;
    this._branch = null;
    this._flags = {};
  }

  start() {
    if (this._running) return;
    this._running = true;
    if (this._workspace) this.poll().catch(() => {});
    this._timer = setInterval(() => this.poll().catch(() => {}), this._pollMs);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._running = false;
  }

  async poll() {
    if (this._polling || !this._workspace) return;
    this._polling = true;
    try {
      await this._scan();
    } catch (e) {
      this._lastError = e.message;
      if (process.env.DEBUG) console.warn('[git-watcher]', e.message);
    } finally {
      this._polling = false;
    }
  }

  async _scan() {
    const ws = this._workspace;
    if (!fs.existsSync(path.join(ws, '.git'))) return;

    const repo = await this._git(['rev-parse', '--is-inside-work-tree']);
    if (repo.code !== 0 || repo.stdout.trim() !== 'true') return;

    const branch = (await this._git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
    if (branch && branch !== this._branch) {
      if (this._branch !== null) {
        this._bus.emit('git:branch-changed', { branch, prev: this._branch });
      }
      this._branch = branch;
    }

    // .env presente sin ignorar ni trackear
    if (fs.existsSync(path.join(ws, '.env'))) {
      const tracked = (await this._git(['ls-files', '.env'])).stdout.trim();
      const ignored = (await this._git(['check-ignore', '.env'])).code === 0;
      this._setFlag('env_unignored', !tracked && !ignored, () => {
        this._bus.emit('git:redflag', {
          kind: 'env_unignored',
          file: '.env',
          branch,
          message:
            'El archivo .env existe en el proyecto y no está en .gitignore — riesgo de filtrar secretos si se commitea.',
        });
      });
    } else {
      this._setFlag('env_unignored', false);
    }

    // Conflictos de merge sin resolver
    const conflicted = (await this._git(['ls-files', '-u'])).stdout;
    const conflictCount = conflicted.trim() ? conflicted.trim().split('\n').length : 0;
    this._setFlag('merge_conflict', conflictCount > 0, () => {
      this._bus.emit('git:redflag', {
        kind: 'merge_conflict',
        count: conflictCount,
        branch,
        message: `Hay ${conflictCount} archivo(s) con conflicto de merge sin resolver.`,
      });
    });

    // Demasiados cambios sin commitear
    const porcelain = (await this._git(['status', '--porcelain'])).stdout;
    const dirty = porcelain.trim() ? porcelain.trim().split('\n').length : 0;
    this._setFlag('uncommitted', dirty >= UNCOMMITTED_THRESHOLD, () => {
      this._bus.emit('git:redflag', {
        kind: 'uncommitted',
        count: dirty,
        branch,
        message: `Hay ${dirty} archivos modificados sin commitear.`,
      });
    });

    // Commits sin push — solo si la rama tiene upstream
    const unpushed = await this._git(['rev-list', '--count', '@{u}..HEAD']);
    if (unpushed.code === 0) {
      const count = parseInt(unpushed.stdout.trim(), 10) || 0;
      this._setFlag('unpushed', count > 0, () => {
        this._bus.emit('git:redflag', {
          kind: 'unpushed_commits',
          count,
          branch,
          message: `Hay ${count} commit(s) locales sin subir a la rama remota.`,
        });
      });
    }
  }

  _setFlag(key, value, onRising) {
    if (value === this._flags[key]) return;
    this._flags[key] = value;
    if (value && onRising) onRising();
  }

  _git(args) {
    return new Promise((resolve, reject) => {
      this._exec(args, { cwd: this._workspace, timeout: 10000 }, (err, res) => {
        if (err) return reject(err);
        resolve(res || { code: 0, stdout: '' });
      });
    });
  }

  getStats() {
    return {
      running: this._running,
      workspace: this._workspace,
      branch: this._branch,
      flags: this._flags,
      lastError: this._lastError,
    };
  }
}

module.exports = { GitWatcher, UNCOMMITTED_THRESHOLD };
