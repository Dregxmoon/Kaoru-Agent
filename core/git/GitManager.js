'use strict';

// GitManager.js — Tool propia de Git (no exec crudo).
//
// Envuelve `git` vía execFile (array de argumentos, nunca string de shell)
// y devuelve JSON estructurado para el LLM: estado del repo, diff, log,
// ramas, commit, stash, merge/rebase con detección de conflictos.
//
// Todos los métodos que mutan el repo (commit, stash push/pop/apply/drop,
// merge, rebase) deben pasar por la aprobación del usuario (ver
// ActionParser.isHighImpact). Aquí solo se garantiza que los argumentos
// estén saneados para no inyectar opciones/shell.

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const { dirRegexes } = require('../utils/ignoreDirs.js');

const DEFAULT_TIMEOUT = 30000;
const MAX_DIFF_PATCH = 60000;

// Ramas: sin espacios, sin `..`, sin guion inicial (evita `git merge --abort`
// colándose como "rama").
const SAFE_BRANCH_RE = /^[A-Za-z0-9._/-]{1,200}$/;
// Paths a commitear: relativo, sin `..`, sin guion inicial.
const SAFE_PATH_RE = /^[A-Za-z0-9_./-]{1,240}$/;

// Paths que git_commit NUNCA stagea automáticamente (dependencias, builds,
// cachés, secrets, datos locales).
const COMMIT_IGNORED_RE = [...dirRegexes(), /\.env(\.|$)/i, /(^|[\\/])data[\\/]/, /\.log$/];

function _run(cwd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout: opts.timeout || DEFAULT_TIMEOUT,
        maxBuffer: opts.maxBuffer || 8 * 1024 * 1024,
        encoding: 'utf-8',
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
      },
      (err, stdout, stderr) => {
        if (err && typeof err.code !== 'number') {
          // git no está instalado / spawn falló
          reject(new Error(`git no está disponible: ${err.message}`));
          return;
        }
        resolve({
          code: err ? err.code : 0,
          stdout: stdout || '',
          stderr: stderr || '',
        });
      }
    );
  });
}

function _validBranch(branch) {
  return (
    typeof branch === 'string' &&
    SAFE_BRANCH_RE.test(branch) &&
    !branch.startsWith('-') &&
    !branch.includes('..')
  );
}

function _validPaths(paths) {
  if (typeof paths === 'string') paths = [paths];
  if (!Array.isArray(paths) || paths.length === 0) return [];
  const clean = paths
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter((p) => p && SAFE_PATH_RE.test(p) && !p.startsWith('-') && !p.includes('..'));
  return clean;
}

function _assertDir(cwd) {
  if (!cwd || typeof cwd !== 'string') {
    throw new Error('Falta el directorio de trabajo (cwd) para la herramienta de git.');
  }
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(`El directorio de trabajo no existe o no es una carpeta: ${cwd}`);
  }
}

function _toError(r, context) {
  const msg = (r.stderr || r.stdout || '').trim().split('\n').slice(0, 5).join(' | ');
  const err = new Error(context ? `${context}: ${msg}` : msg || 'error de git');
  err.exitCode = r.code;
  err.gitOutput = r.stdout;
  err.gitStderr = r.stderr;
  return err;
}

// ── Parsing de `git status --porcelain=v1 -b` ─────────────────────────────────
function _parseStatusPorcelain(stdout) {
  const lines = stdout.split('\n').filter((l) => l.length > 0);
  const staged = [];
  const unstaged = [];
  const untracked = [];
  const conflicts = [];
  const branchInfo = { branch: null, ahead: 0, behind: 0 };

  for (const line of lines) {
    if (line.startsWith('##')) {
      // ## main...origin/main [ahead 1, behind 2]
      const rest = line.slice(2).trim();
      let br = rest;
      const bracket = rest.match(/\[.*\]$/);
      let track = '';
      if (bracket) {
        br = rest.slice(0, rest.indexOf('[')).trim();
        track = bracket[0];
      }
      branchInfo.branch = br.split('...')[0].trim() || null;
      const ahead = track.match(/ahead (\d+)/);
      const behind = track.match(/behind (\d+)/);
      branchInfo.ahead = ahead ? parseInt(ahead[1], 10) : 0;
      branchInfo.behind = behind ? parseInt(behind[1], 10) : 0;
      continue;
    }
    const xy = line.slice(0, 2);
    const p = line.slice(3);
    if (xy === '??') {
      untracked.push(p);
    } else if (xy[0] !== ' ' && xy[1] !== ' ') {
      conflicts.push({ status: xy, path: p });
    } else if (xy[0] !== ' ') {
      staged.push({ status: xy[0], path: p });
    } else if (xy[1] !== ' ') {
      unstaged.push({ status: xy[1], path: p });
    }
  }
  return { branchInfo, staged, unstaged, untracked, conflicts };
}

class GitManager {
  constructor(opts = {}) {
    this._exec = opts.exec || _run;
  }

  // ── Utilidades ──────────────────────────────────────────────────────────────
  async getRepoRoot(cwd) {
    _assertDir(cwd);
    const r = await this._exec(cwd, ['rev-parse', '--show-toplevel'], { maxBuffer: 1024 * 1024 });
    if (r.code !== 0) return null;
    const root = (r.stdout || '').trim();
    return root || null;
  }

  async isRepo(cwd) {
    try {
      return (await this.getRepoRoot(cwd)) !== null;
    } catch {
      return false;
    }
  }

  // ── git_status (lectura) ─────────────────────────────────────────────────────
  async status(cwd) {
    _assertDir(cwd);
    const r = await this._exec(cwd, ['status', '--porcelain=v1', '-b', '--untracked-files=normal']);
    if (r.code !== 0) throw _toError(r, 'git status falló');
    const parsed = _parseStatusPorcelain(r.stdout);
    return {
      isRepo: true,
      branch: parsed.branchInfo.branch,
      ahead: parsed.branchInfo.ahead,
      behind: parsed.branchInfo.behind,
      clean:
        parsed.staged.length +
          parsed.unstaged.length +
          parsed.untracked.length +
          parsed.conflicts.length ===
        0,
      staged: parsed.staged.map((s) => ({ path: s.path, status: s.status })),
      unstaged: parsed.unstaged.map((s) => ({ path: s.path, status: s.status })),
      untracked: parsed.untracked,
      conflicts: parsed.conflicts,
      total:
        parsed.staged.length +
        parsed.unstaged.length +
        parsed.untracked.length +
        parsed.conflicts.length,
    };
  }

  // ── git_diff (lectura) ───────────────────────────────────────────────────────
  async diff(cwd, opts = {}) {
    _assertDir(cwd);
    const { file, staged } = opts;
    const args = ['diff'];
    if (staged) args.push('--staged');
    if (file) args.push('--', String(file));
    const r = await this._exec(cwd, args, { maxBuffer: 8 * 1024 * 1024 });
    if (r.code !== 0) throw _toError(r, 'git diff falló');
    const patch = r.stdout;
    const stat = await this._exec(cwd, [...args, '--stat'], { maxBuffer: 2 * 1024 * 1024 });
    const summary = (stat.stdout || '')
      .trim()
      .split('\n')
      .filter((l) => l.trim());
    return {
      isRepo: true,
      file: file || null,
      staged: !!staged,
      summary,
      patch:
        patch.length <= MAX_DIFF_PATCH
          ? patch
          : patch.slice(0, MAX_DIFF_PATCH) + `\n[... diff truncado: ${patch.length} chars totales]`,
      patchTruncated: patch.length > MAX_DIFF_PATCH,
    };
  }

  // ── git_log (lectura) ────────────────────────────────────────────────────────
  async log(cwd, opts = {}) {
    _assertDir(cwd);
    const count = Math.min(50, Math.max(1, parseInt(opts.count, 10) || 20));
    const args = ['log', `-n${count}`, '--pretty=format:%h|%an|%ad|%s', '--date=short'];
    if (opts.file) args.push('--', String(opts.file));
    const r = await this._exec(cwd, args, { maxBuffer: 4 * 1024 * 1024 });
    if (r.code !== 0) throw _toError(r, 'git log falló');
    const commits = (r.stdout || '')
      .split('\n')
      .filter((l) => l.trim())
      .map((line) => {
        const [hash, author, date, ...rest] = line.split('|');
        return { hash, author, date, subject: rest.join('|') };
      });
    return { isRepo: true, total: commits.length, commits };
  }

  // ── git_branch (lectura) ─────────────────────────────────────────────────────
  async branch(cwd) {
    _assertDir(cwd);
    const r = await this._exec(
      cwd,
      [
        'for-each-ref',
        'refs/heads',
        '--format=%(HEAD)|%(refname:short)|%(upstream:short)|%(upstream:track)',
      ],
      { maxBuffer: 2 * 1024 * 1024 }
    );
    if (r.code !== 0) throw _toError(r, 'git branch falló');
    const branches = (r.stdout || '')
      .split('\n')
      .filter((l) => l.trim())
      .map((line) => {
        const [head, name, upstream, track] = line.split('|');
        const ahead = track ? (track.match(/ahead (\d+)/) || [])[1] : null;
        const behind = track ? (track.match(/behind (\d+)/) || [])[1] : null;
        return {
          name,
          current: head === '*',
          upstream: upstream || null,
          ahead: ahead ? parseInt(ahead, 10) : 0,
          behind: behind ? parseInt(behind, 10) : 0,
        };
      });
    const current = branches.find((b) => b.current)?.name || null;
    return { isRepo: true, current, total: branches.length, branches };
  }

  // ── git_add (helper, no expuesto como tool) ──────────────────────────────────
  async add(cwd, paths) {
    const clean = _validPaths(paths);
    const args = clean.length > 0 ? ['add', '--', ...clean] : ['add', '-A'];
    const r = await this._exec(cwd, args);
    if (r.code !== 0) throw _toError(r, 'git add falló');
    return { isRepo: true, added: clean.length > 0 ? clean : ['(todo)'] };
  }

  // ── git_commit (muta) ────────────────────────────────────────────────────────
  // Paths que git_commit NUNCA stagea automáticamente: dependencias, builds,
  // cachés, secrets y datos locales. Evita que un `add -A` comitee basura o
  // credenciales por accidente.
  async _stageSafeChanges(cwd) {
    const status = await this._exec(cwd, ['status', '--short'], {
      maxBuffer: 16 * 1024 * 1024,
    });
    if (status.code !== 0) throw _toError(status, 'git status falló');

    const allPaths = (status.stdout || '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => l.slice(3).trim())
      .filter((p) => p && p !== '.' && !p.includes(' -> '));

    const junk = allPaths.filter((p) => COMMIT_IGNORED_RE.some((re) => re.test(p)));

    if (junk.length === 0) {
      // Ruta rápida: nada que excluir → add -A (preserva renames/borrados).
      const addR = await this._exec(cwd, ['add', '-A']);
      if (addR.code !== 0) throw _toError(addR, 'git add falló');
      return;
    }

    const safe = allPaths.filter((p) => !COMMIT_IGNORED_RE.some((re) => re.test(p)));
    console.log(
      `[git] git_commit ignora ${junk.length} ruta(s) sensible(s): ${junk.slice(0, 5).join(', ')}`
    );
    if (safe.length === 0) return; // todo es junk → no stagear nada
    const addR = await this._exec(cwd, ['add', '--', ...safe]);
    if (addR.code !== 0) throw _toError(addR, 'git add falló');
  }

  async commit(cwd, opts = {}) {
    _assertDir(cwd);
    const message = typeof opts.message === 'string' ? opts.message.trim() : '';
    if (!message) throw new Error('git_commit requiere un mensaje (message).');
    if (message.length > 5000)
      throw new Error('El mensaje de commit es demasiado largo (máx 5000).');

    await this._stageSafeChanges(cwd);

    const r = await this._exec(cwd, ['commit', '-m', message], { maxBuffer: 4 * 1024 * 1024 });
    if (r.code !== 0) throw _toError(r, 'git commit falló');
    const out = (r.stdout || '').trim();
    const files = (out.match(/\d+ files? changed/g) || []).join(' ');
    const inserted = (out.match(/\d+ insertions?/g) || []).join(' ');
    const deleted = (out.match(/\d+ deletions?/g) || []).join(' ');
    // El hash corto vive dentro del corchete de la línea de resumen:
    //   [main (root-commit) e627b0e] feat: x
    const bracket = out.match(/\[([^\]]*)\]/);
    const hash = bracket ? (bracket[1].match(/\b[0-9a-f]{7,40}\b/) || [])[0] || null : null;
    return {
      isRepo: true,
      committed: true,
      hash,
      files,
      inserted,
      deleted,
      output: out.split('\n').slice(0, 10),
    };
  }

  // ── git_stash (lista = lectura; push/pop/apply/drop = muta) ─────────────────
  async stash(cwd, opts = {}) {
    _assertDir(cwd);
    const action = opts.action || 'list';
    if (!['list', 'push', 'pop', 'apply', 'drop'].includes(action)) {
      throw new Error(
        `git_stash action inválida: ${action}. Válidas: list, push, pop, apply, drop.`
      );
    }
    if (action === 'list') {
      const r = await this._exec(cwd, ['stash', 'list', '--format=%gd|%gs'], {
        maxBuffer: 2 * 1024 * 1024,
      });
      if (r.code !== 0) throw _toError(r, 'git stash list falló');
      const stashes = (r.stdout || '')
        .split('\n')
        .filter((l) => l.trim())
        .map((line) => {
          const [ref, ...subject] = line.split('|');
          return { ref, subject: subject.join('|') };
        });
      return { isRepo: true, total: stashes.length, stashes };
    }
    const args = ['stash', action];
    if (action === 'push' && opts.message) args.push('-m', String(opts.message));
    const r = await this._exec(cwd, args, { maxBuffer: 4 * 1024 * 1024 });
    if (r.code !== 0) throw _toError(r, `git stash ${action} falló`);
    return { isRepo: true, action, ok: true, output: (r.stdout || r.stderr || '').trim() };
  }

  // ── git_merge (muta) con detección de conflictos ─────────────────────────────
  async merge(cwd, opts = {}) {
    _assertDir(cwd);
    const branch = opts.branch;
    if (!_validBranch(branch)) throw new Error('git_merge requiere una rama válida (branch).');
    const args = ['merge', branch];
    if (opts.message) args.push('-m', String(opts.message).slice(0, 5000));
    const r = await this._exec(cwd, args, { maxBuffer: 8 * 1024 * 1024 });
    if (r.code !== 0) {
      const conflictFiles = await this._unmergedFiles(cwd);
      return this._conflictResult(r, 'merge', branch, conflictFiles);
    }
    return { isRepo: true, merged: true, branch, output: (r.stdout || '').trim() };
  }

  // ── git_rebase (muta) con detección de conflictos ────────────────────────────
  async rebase(cwd, opts = {}) {
    _assertDir(cwd);
    const branch = opts.branch;
    if (!_validBranch(branch)) throw new Error('git_rebase requiere una rama válida (branch).');
    const r = await this._exec(cwd, ['rebase', branch], { maxBuffer: 8 * 1024 * 1024 });
    if (r.code !== 0) {
      const conflictFiles = await this._unmergedFiles(cwd);
      return this._conflictResult(r, 'rebase', branch, conflictFiles);
    }
    return { isRepo: true, rebased: true, branch, output: (r.stdout || '').trim() };
  }

  // ── git_push (muta) ──────────────────────────────────────────────────────────
  async push(cwd, opts = {}) {
    _assertDir(cwd);
    const remote =
      typeof opts.remote === 'string' && opts.remote.trim() ? opts.remote.trim() : 'origin';
    if (!/^[A-Za-z0-9._/-]{1,200}$/.test(remote) || remote.startsWith('-')) {
      throw new Error('git_push: remote inválido.');
    }
    const branch =
      typeof opts.branch === 'string' && opts.branch.trim() ? opts.branch.trim() : null;
    if (branch && !_validBranch(branch)) throw new Error('git_push: rama inválida.');

    const args = ['push'];
    if (branch) args.push('-u'); // fija upstream: rama nueva sin remoto no falla
    args.push(remote);
    if (branch) args.push(branch);
    if (opts.force) args.push('--force');

    const token = this._resolveToken();
    const env = token ? { GIT_ASKPASS: this._writeAskpass(token), GIT_TERMINAL_PROMPT: '0' } : null;
    const r = await this._exec(cwd, args, { maxBuffer: 8 * 1024 * 1024, env });
    if (token) this._cleanupAskpass();

    if (r.code !== 0) {
      const err = _toError(r, 'git push falló');
      if (token && /denied|401|403|Authentication/i.test(err.message)) {
        err.hint =
          'El push fue rechazado por GitHub. Verificá que el token en el llavero (github_token) tenga scope "repo".';
      }
      throw err;
    }
    const out = (r.stdout + '\n' + r.stderr).trim();
    const to =
      (out.match(/^\s*[0-9a-f]{7,40}\.\.\.[0-9a-f]{7,40}\s+(\S+)/m) || [])[1] || branch || '';
    return {
      isRepo: true,
      pushed: true,
      remote,
      branch: to,
      output: out.split('\n').slice(0, 8),
    };
  }

  // Token para push HTTPS: env → llavero (github_token). Lazy require para no
  // cargar KeychainManager en contextos donde no hace falta.
  _resolveToken() {
    if (process.env.GITHUB_TOKEN && process.env.GITHUB_TOKEN.trim())
      return process.env.GITHUB_TOKEN.trim();
    if (process.env.GH_TOKEN && process.env.GH_TOKEN.trim()) return process.env.GH_TOKEN.trim();
    try {
      const K = require('../../infrastructure/keychain/KeychainManager.js');
      const t = K.getKey('github_token');
      return t && t.trim() ? t.trim() : null;
    } catch {
      return null;
    }
  }

  // Script askpass temporal: git ejecuta el binario con el prompt como argumento
  // y usa la primera línea de salida. El token nunca aparece en argv de git.
  _writeAskpass(token) {
    const askpass = path.join(require('os').tmpdir(), `asistente-gh-askpass-${process.pid}.sh`);
    const escaped = token.replace(/'/g, "'\\''");
    fs.writeFileSync(
      askpass,
      '#!/bin/sh\nif printf "%s" "$1" | grep -qi "password"; then\n  echo \'' +
        escaped +
        '\'\nelse\n  echo "oauth2"\nfi\n',
      { mode: 0o700 }
    );
    this._askpassPath = askpass;
    return askpass;
  }

  _cleanupAskpass() {
    try {
      if (this._askpassPath) fs.unlinkSync(this._askpassPath);
    } catch {}
    this._askpassPath = null;
  }

  async _unmergedFiles(cwd) {
    try {
      const r = await this._exec(cwd, ['diff', '--name-only', '--diff-filter=U'], {
        maxBuffer: 1024 * 1024,
      });
      if (r.code !== 0) return [];
      return (r.stdout || '').split('\n').filter((l) => l.trim());
    } catch {
      return [];
    }
  }

  _conflictResult(r, op, branch, conflictFiles) {
    const output = (r.stdout + '\n' + r.stderr).trim();
    const conflicted =
      conflictFiles.length > 0
        ? conflictFiles
        : (output.match(/(?:CONFLICT|both modified) \(.*?\) in ([^\n]+)/g) || []).map((m) =>
            m.replace(/^.* in /, '').trim()
          );
    return {
      isRepo: true,
      conflict: true,
      op,
      branch,
      conflictedFiles: [...new Set(conflicted.filter(Boolean))],
      message: output.split('\n').slice(0, 8),
      hint: 'Resolvé los conflictos en los archivos listados, luego usá git_status para ver el estado y confirmá con "git add" + commit (git_commit).',
    };
  }
}

let _instance = null;
function getGitManager() {
  if (!_instance) _instance = new GitManager();
  return _instance;
}

module.exports = { GitManager, getGitManager };
