// @ts-nocheck
'use strict';

/**
 * ProactiveExecutor.js — Fase B: ejecutor whitelisted de acciones proactivas.
 *
 * Es la ÚNICA vía por la que una propuesta proactiva pasa de "palabra" a
 * "hecho", y solo DESPUÉS del clic explícito del usuario en el chat. Reglas:
 *
 *   1. Whitelist estricta de tools (PROACTIVE_TOOLS). El LLM JAMÁS inventa
 *      herramientas ni args: la acción viene determinista del PROPOSAL_HINTS
 *      del ProactiveEngine y los params pasan validación aquí.
 *   2. Solo lectura sin permiso (preview/diff); MUTACIONES solo vía execute()
 *      (que el engine solo llama tras 'accepted').
 *   3. Verificación post-acción real: gitignore_add re-chequea con
 *      `git check-ignore` y reporta el resultado REAL, no "listo" de oído.
 *   4. Idempotencia: una propuesta ejecutada no se vuelve a ejecutar
 *      (guard por proposalId) y gitignore_add no duplica líneas.
 *   5. CWD correcto: TODOS los comandos git corren con `cwd = workspace`
 *      (nunca hereda el cwd del proceso).
 *   6. Nunca lanza en producción: cada acción se aísla y devuelve
 *      { ok, detail, skipped }.
 *
 * Inyectable para tests: `exec` recibe (args, opts, cb) — igual contrato que
 * GitWatcher; por defecto usa child_process.execFile('git', ...).
 */

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const Diff = require('diff');

const PROACTIVE_TOOLS = new Set(['git_status', 'gitignore_add', 'apply_patch']);

// ── G.4: Catálogo de tools proactivas ──────────────────────────────────────
// Cada tool declara su contrato: validate, preview, execute.
// ProactiveExecutor despacha genéricamente — sin if/switch por tool.
const TOOL_CATALOG = {
  git_status: {
    validate: () => true,
    preview: (action, ex) => ex._previewGitStatus(),
    execute: (action, ex) => ex._previewGitStatus(),
    // git_status es solo lectura: execute devuelve preview, no detail.
    normalizeResult: (res) => ({
      ok: res.ok,
      detail: res.ok ? res.preview : res.reason || 'error',
    }),
  },
  gitignore_add: {
    validate: (action) => _validateFilename(action.params?.file),
    preview: (action, ex) => ex._previewGitignoreAdd(action.params?.file),
    execute: (action, ex, pid) => ex._execGitignoreAdd(action.params?.file, pid),
  },
  apply_patch: {
    validate: (action, ex) => ex._validPatchParams(action.params),
    preview: (action, ex) => ex._previewPatch(action.params),
    execute: (action, ex, pid) => ex._execApplyPatch(action.params, pid),
  },
};

// Nombres de archivo válidos para gitignore_add: simple, sin separadores,
// sin path traversal, sin caracteres que puedan escaparse del argumento.
// (.env, .env.local, secret.txt, build, node_modules...)
const SAFE_FILENAME_RE = /^[A-Za-z0-9._-]{1,120}$/;

function _defaultExec(args, opts, cb) {
  execFile(
    'git',
    args,
    { cwd: opts.cwd, timeout: opts.timeout || 10000, maxBuffer: opts.maxBuffer || 2 * 1024 * 1024 },
    (err, stdout) => {
      if (err && typeof err.code !== 'number') return cb(err);
      cb(null, { code: err ? err.code : 0, stdout: stdout || '' });
    }
  );
}

function _validateFilename(file) {
  if (!file || typeof file !== 'string') return false;
  return SAFE_FILENAME_RE.test(file) && !file.includes('..');
}

// Fase D: ruta de archivo RELATIVA al workspace para un parche. Sin `..`,
// sin absoluto, sin caracteres raros. Solo texto/código plano.
const SAFE_RELATIVE_FILE_RE = /^[A-Za-z0-9_./-]{1,240}$/;
const PATCHABLE_EXTS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.json',
  '.py',
  '.css',
  '.md',
  '.txt',
  '.yml',
  '.yaml',
  '.sh',
  '.html',
]);
const MAX_CHANGES = 8;
const MAX_PATCH_FRAGMENT = 16 * 1024;

// Rutas inmutables por defensa en profundidad (nunca parchear credenciales).
const IMMUTABLE_PATCH_RE =
  /(\.env(\.|$)|\.(key|pem|pfx|crt)$|^\.ssh[\\/]|credentials|\.pgpass|\.npmrc)/i;

function _validateRelativeFile(file) {
  if (!file || typeof file !== 'string') return false;
  if (path.isAbsolute(file)) return false;
  if (file.includes('..')) return false;
  if (!SAFE_RELATIVE_FILE_RE.test(file)) return false;
  const ext = path.extname(file).toLowerCase();
  return PATCHABLE_EXTS.has(ext) && !IMMUTABLE_PATCH_RE.test(file);
}

function _normalizeDiagnostic(d) {
  return {
    code: d.code || null,
    message: (d.message || '').trim(),
    line: d.line ?? d.range?.start?.line ?? 0,
    severity: d.severity ?? 1,
  };
}

// Un diagnóstico "coincide" con un error objetivo si comparten mensaje o línea.
function _matchesTarget(diag, targets) {
  return targets.some(
    (t) =>
      (t.message && diag.message && t.message === diag.message) ||
      (t.line != null && diag.line === t.line)
  );
}

// JS sintáctico válido: oracle extra del parche. El LSP puede reportar 0
// errores con sintaxis TS-en-JS (p.ej. `function f(a: number)` en un .js,
// checkJs no la marca como 8010), así que para archivos JS se comprueba con
// `node --check`. Devuelve null si es válido (o no aplica), o el mensaje del
// error de sintaxis si no lo es. Si `node` no está disponible, no bloquea.
function _defaultSyntaxCheck(content, file) {
  const ext = path.extname(file || '').toLowerCase();
  if (ext !== '.js' && ext !== '.mjs' && ext !== '.cjs') return Promise.resolve(null);
  const tmp = path.join(
    os.tmpdir(),
    `asistente-syntax-${crypto.randomBytes(6).toString('hex')}${ext}`
  );
  try {
    fs.writeFileSync(tmp, content);
  } catch (e) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    execFile('node', ['--check', tmp], { timeout: 10000 }, (err) => {
      try {
        fs.unlinkSync(tmp);
      } catch (_) {}
      if (!err) return resolve(null);
      if (err.code === 'ENOENT') return resolve(null); // sin node → no bloquea
      const full = String(err.message || '');
      const hit = full
        .split('\n')
        .find((l) => /SyntaxError|Unexpected token|Unexpected end/.test(l));
      resolve(hit ? hit.trim() : null);
    });
  });
}

class ProactiveExecutor {
  /**
   * @param {object} opts
   * @param {() => string|null} opts.getWorkspace - devuelve el workspace activo
   * @param {Function} [opts.exec] - exec inyectable para tests
   * @param {() => string[]} [opts.getOpenFiles] - archivos abiertos en el editor
   * @param {(file: string) => Promise<Array|null>} [opts.getDiagnostics] - LSP real (o stub)
   * @param {(file: string, content: string) => void} [opts.notifyChanged] - avisa al LSP del cambio
   * @param {(file: string) => Promise<Array|null>} [opts.waitForDiagnostics] - LSP.1: espera el push fresco
   *   de diagnósticos tras el cambio (reemplaza el sleep fijo de verifyDelayMs)
   */
  constructor({
    getWorkspace,
    exec = _defaultExec,
    getOpenFiles = () => [],
    getDiagnostics = null,
    notifyChanged = null,
    waitForDiagnostics = null,
    verifyDelayMs = 2500,
    syntaxCheck = _defaultSyntaxCheck,
  } = {}) {
    this._getWorkspace = getWorkspace || (() => null);
    this._exec = exec;
    this._getOpenFiles = getOpenFiles || (() => []);
    this._getDiagnostics = getDiagnostics || null;
    this._notifyChanged = notifyChanged || null;
    this._waitForDiagnostics = waitForDiagnostics || null;
    this._verifyDelayMs = verifyDelayMs;
    this._syntaxCheck = syntaxCheck;
    this._executing = false; // lock — una mutación a la vez
    this._done = new Set(); // proposalIds ya ejecutados (idempotencia)
    this._lastResult = null;
    this._patchBackups = new Map(); // absPath → contenido original (rollback)
  }

  getWorkspace() {
    const ws = typeof this._getWorkspace === 'function' ? this._getWorkspace() : this._getWorkspace;
    return ws || null;
  }

  isDone(proposalId) {
    return this._done.has(proposalId);
  }

  markDone(proposalId) {
    this._done.add(proposalId);
    if (this._done.size > 200) {
      const first = this._done.values().next().value;
      this._done.delete(first);
    }
  }

  /**
   * Genera la preview/diff de una acción SIN mutar nada (solo lectura).
   * @returns {Promise<{ok: boolean, preview?: string, diff?: string, reason?: string}>}
   */
  async preview(action) {
    if (!this._validAction(action)) return { ok: false, reason: 'acción no permitida' };
    try {
      const tool = TOOL_CATALOG[action.tool];
      if (!tool) return { ok: false, reason: 'tool desconocida' };
      return await tool.preview(action, this);
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  /**
   * Ejecuta la acción (solo la llama el engine tras la confirmación).
   * @returns {Promise<{ok: boolean, detail?: string, skipped?: boolean, reason?: string}>}
   */
  async execute(action, { proposalId } = {}) {
    if (!this._validAction(action)) return { ok: false, reason: 'acción no permitida' };
    if (proposalId && this.isDone(proposalId))
      return { ok: true, skipped: true, detail: 'Ya estaba ejecutada.' };

    if (this._executing) return { ok: false, reason: 'ya hay una acción en ejecución' };
    this._executing = true;
    try {
      const tool = TOOL_CATALOG[action.tool];
      if (!tool) return { ok: false, reason: 'tool desconocida' };
      const raw = await tool.execute(action, this, proposalId);
      const res = tool.normalizeResult ? tool.normalizeResult(raw) : raw;
      this._lastResult = res;
      return res;
    } finally {
      this._executing = false;
    }
  }

  // ── Validación de acciones ─────────────────────────────────────────────────

  _validAction(action) {
    if (!action || typeof action !== 'object') return false;
    if (!PROACTIVE_TOOLS.has(action.tool)) return false;
    const ws = this.getWorkspace();
    if (!ws || !fs.existsSync(ws)) return false;
    const tool = TOOL_CATALOG[action.tool];
    if (tool && !tool.validate(action, this)) return false;
    return true;
  }

  /** Valida los params de apply_patch SIN tocar el disco. */
  _validPatchParams(params) {
    if (!params || typeof params !== 'object') return false;
    if (!_validateRelativeFile(params.file)) return false;
    if (!Array.isArray(params.changes) || !params.changes.length) return false;
    if (params.changes.length > MAX_CHANGES) return false;
    for (const c of params.changes) {
      if (!c || typeof c !== 'object') return false;
      if (typeof c.old !== 'string' || !c.old.trim()) return false;
      if (typeof c.new !== 'string') return false;
      if (c.old.length > MAX_PATCH_FRAGMENT || c.new.length > MAX_PATCH_FRAGMENT) return false;
    }
    return true;
  }

  /** Resuelve la ruta absoluta del archivo y la acota al workspace. */
  _patchAbsPath(params) {
    const ws = this.getWorkspace();
    if (!ws) return null;
    const abs = path.resolve(ws, params.file);
    const rel = path.relative(ws, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
    return abs;
  }

  // ── git_status (solo lectura) ──────────────────────────────────────────────

  async _previewGitStatus() {
    const ws = this.getWorkspace();
    const inRepo = await this._git(['rev-parse', '--is-inside-work-tree'], ws);
    if (inRepo.code !== 0 || inRepo.stdout.trim() !== 'true') {
      return { ok: false, reason: 'el workspace no es un repositorio git' };
    }
    const status = await this._git(['status', '--porcelain'], ws);
    const branch = (await this._git(['rev-parse', '--abbrev-ref', 'HEAD'], ws)).stdout.trim();
    const lines = status.stdout.trim() ? status.stdout.trim().split('\n') : [];
    const summary = lines.length
      ? `git status — ${lines.length} cambio(s) en ${branch}:\n${lines.slice(0, 12).join('\n')}${lines.length > 12 ? `\n… y ${lines.length - 12} más` : ''}`
      : `git status — sin cambios, todo limpio en ${branch}.`;
    return { ok: true, preview: summary, diff: null };
  }

  // ── gitignore_add (mutación con verificación) ─────────────────────────────

  async _previewGitignoreAdd(file) {
    if (!_validateFilename(file)) return { ok: false, reason: 'nombre de archivo inválido' };
    const ws = this.getWorkspace();
    const giPath = path.join(ws, '.gitignore');
    let existing = '';
    if (fs.existsSync(giPath)) existing = fs.readFileSync(giPath, 'utf-8');

    const already = existing.split('\n').some((l) => l.trim() === file);
    if (already) return { ok: false, reason: 'ya está en .gitignore', diff: null };

    const diff = existing ? `${existing.replace(/\n+$/, '')}\n+${file}\n` : `+${file}\n`;
    const preview = `Añadiré "${file}" al .gitignore del workspace.`;
    return { ok: true, preview, diff };
  }

  async _execGitignoreAdd(file, proposalId) {
    const ws = this.getWorkspace();
    const giPath = path.join(ws, '.gitignore');

    // No escribir jamás fuera de un repo git.
    const inRepo = await this._git(['rev-parse', '--is-inside-work-tree'], ws);
    if (inRepo.code !== 0 || inRepo.stdout.trim() !== 'true') {
      return { ok: false, detail: 'el workspace no es un repositorio git' };
    }

    // Idempotencia extra (race con otro proceso): re-chequear antes de escribir.
    const pre = await this._previewGitignoreAdd(file);
    if (!pre.ok) {
      const alreadyIgnored = await this._git(['check-ignore', file], ws);
      if (alreadyIgnored.code === 0) {
        return { ok: true, skipped: true, detail: `"${file}" ya está ignorado.` };
      }
      return { ok: false, detail: pre.reason || 'no se pudo preparar' };
    }

    try {
      const existing = fs.existsSync(giPath) ? fs.readFileSync(giPath, 'utf-8') : '';
      const next = existing.endsWith('\n')
        ? `${existing}${file}\n`
        : `${existing}${existing ? '\n' : ''}${file}\n`;
      fs.writeFileSync(giPath, next);
    } catch (e) {
      return { ok: false, detail: `no se pudo escribir .gitignore: ${e.message}` };
    }

    // Verificación post-acción REAL — no reportar "listo" de oído.
    const check = await this._git(['check-ignore', file], ws);
    if (check.code !== 0) {
      return {
        ok: false,
        detail: `verificación falló: "${file}" no quedó ignorado (check-ignore exit ${check.code}).`,
      };
    }
    if (proposalId) this.markDone(proposalId);
    return {
      ok: true,
      detail: `Listo — verifiqué con git check-ignore: "${file}" ya está ignorado.`,
    };
  }

  // ── apply_patch (mutación de código con verificación LSP y rollback) ──────

  /**
   * Preview SOLO lectura: valida que cada fragmento `old` sea único en el
   * archivo actual y devuelve el diff unificado real de la aplicación.
   */
  async _previewPatch(params) {
    if (!this._validPatchParams(params)) return { ok: false, reason: 'parche inválido' };
    const abs = this._patchAbsPath(params);
    if (!abs) return { ok: false, reason: 'el archivo no existe o está fuera del workspace' };

    const original = fs.readFileSync(abs, 'utf-8');
    const applied = this._applyChanges(original, params.changes);
    if (applied.error) return { ok: false, reason: applied.error };

    // Oracle extra: si el parche deja el archivo con sintaxis JS inválida (el
    // caso típico es sintaxis TS en un .js, que el LSP no siempre marca),
    // no se ofrece. Solo lectura: nada se escribió.
    const syntaxErr = await this._syntaxCheck(applied.content, params.file);
    if (syntaxErr)
      return { ok: false, reason: `el parche rompe la sintaxis del archivo: ${syntaxErr}` };

    const diff = this._buildUnifiedDiff(original, applied.content, params.file);
    return {
      ok: true,
      preview: `Aplicaré ${params.changes.length} cambio(s) en "${params.file}".`,
      diff,
    };
  }

  /**
   * Ejecución tras el clic: respeta el guard de archivos abiertos en el
   * editor, aplica, y verifica con el LSP. Si la verificación detecta un
   * error NUEVO (regresión) revierte el archivo a su contenido original.
   */
  async _execApplyPatch(params, proposalId) {
    if (!this._validPatchParams(params)) return { ok: false, detail: 'parche inválido' };
    const abs = this._patchAbsPath(params);
    if (!abs) return { ok: false, detail: 'el archivo no existe o está fuera del workspace' };

    // Guard Fase D (#18): jamás escribir sobre un archivo abierto en el editor.
    // El diff sí se mostró en la propuesta; aplicar el parche es decisión del
    // usuario en el editor.
    const open = (this._getOpenFiles() || []).map((f) => path.resolve(f));
    if (open.includes(abs)) {
      return {
        ok: false,
        detail:
          'el archivo está abierto en el editor — solo propongo el parche, aplícalo tú (o ciérralo y vuelve a aceptar).',
      };
    }

    const original = fs.readFileSync(abs, 'utf-8');
    const applied = this._applyChanges(original, params.changes);
    if (applied.error) return { ok: false, detail: applied.error };

    // Backup para rollback (en memoria — suficiente para revertir regresiones
    // detectadas en la misma verificación).
    this._patchBackups.set(abs, original);

    try {
      fs.writeFileSync(abs, applied.content);
    } catch (e) {
      return { ok: false, detail: `no se pudo escribir "${params.file}": ${e.message}` };
    }

    // Oracle extra post-acción: el LSP puede reportar 0 errores con sintaxis
    // TS-en-JS; aquí se comprueba que el archivo JS siga siendo JS válido.
    const syntaxErr = await this._syntaxCheck(applied.content, abs);
    if (syntaxErr) {
      try {
        fs.writeFileSync(abs, original);
        this._patchBackups.delete(abs);
        return {
          ok: false,
          detail: `el parche dejó el archivo con sintaxis JS inválida (${syntaxErr}) — revertí el cambio.`,
          rolledBack: true,
        };
      } catch (e) {
        return {
          ok: false,
          detail: `el parche dejó el archivo con sintaxis JS inválida (${syntaxErr}) y ADEMÁS no se pudo revertir: ${e.message}.`,
          rolledBack: false,
        };
      }
    }

    // Verificación post-acción con el LSP real (o stub inyectado).
    if (this._getDiagnostics) {
      try {
        if (this._notifyChanged) this._notifyChanged(abs, applied.content);
        // LSP.1: event-driven en vez de sleep fijo — esperar el push fresco de
        // diagnósticos (waitForDiagnostics). Si no está inyectado, se mantiene
        // el comportamiento previo (verifyDelayMs).
        if (this._waitForDiagnostics) {
          await this._waitForDiagnostics(abs);
        } else {
          await new Promise((r) => setTimeout(r, this._verifyDelayMs));
        }
        const after = ((await this._getDiagnostics(abs)) || []).map(_normalizeDiagnostic);
        const target = Array.isArray(params.targetErrors)
          ? params.targetErrors.map(_normalizeDiagnostic)
          : [];

        const regression = after.filter((a) => !_matchesTarget(a, target));
        if (regression.length) {
          // Rollback: restaurar el contenido original y reportar el fallo REAL.
          try {
            fs.writeFileSync(abs, original);
            this._patchBackups.delete(abs);
            return {
              ok: false,
              detail: `la verificación LSP encontró un error nuevo tras el parche (${regression[0].message.slice(0, 90)}) — revertí el cambio.`,
              rolledBack: true,
            };
          } catch (e) {
            return {
              ok: false,
              detail: `la verificación LSP encontró un error nuevo tras el parche (${regression[0].message.slice(0, 90)}) y ADEMÁS no se pudo revertir: ${e.message}.`,
              rolledBack: false,
            };
          }
        }

        const fixed = target.length > 0 && !after.some((a) => _matchesTarget(a, target));
        if (proposalId) this.markDone(proposalId);
        return {
          ok: true,
          detail: fixed
            ? `Parche aplicado y verificado con el LSP: el/los error(es) ya no aparecen en "${params.file}".`
            : `Parche aplicado en "${params.file}" (el LSP aún reporta el error — el fix no bastó o el diagnóstico tarda en actualizarse).`,
        };
      } catch (e) {
        return { ok: false, detail: `verificación falló: ${e.message}` };
      }
    }

    if (proposalId) this.markDone(proposalId);
    return {
      ok: true,
      detail: `Parche aplicado en "${params.file}" (sin verificación LSP disponible).`,
    };
  }

  /**
   * Aplica una lista de reemplazos exactos sobre el contenido. Cada `old`
   * debe existir EXACTAMENTE una vez en el contenido actual (evolucionado),
   * para no tocar algo que el usuario ya cambió o que aparece repetido.
   */
  _applyChanges(content, changes) {
    let current = content;
    for (const c of changes) {
      const count = current.split(c.old).length - 1;
      if (count !== 1) {
        const preview = c.old.slice(0, 60).replace(/\n/g, '\\n');
        return {
          error: `el fragmento "${preview}..." no es único en el archivo (${count} coincidencias) — el archivo cambió o el parche es ambiguo. No se aplicó nada.`,
        };
      }
      current = current.replace(c.old, c.new);
    }
    return { content: current };
  }

  /** Diff unificado real entre el contenido actual y el parcheado. */
  _buildUnifiedDiff(original, patched, file) {
    const norm = file.split(path.sep).join('/');
    let diff;
    try {
      diff = Diff.createTwoFilesPatch(`a/${norm}`, `b/${norm}`, original, patched, '', '', {
        context: 3,
      });
    } catch (e) {
      return `--- a/${norm}\n+++ b/${norm}\n@@ ${patched.length - original.length >= 0 ? '+' : ''}${original.length} vs ${patched.length} chars @@\n[no se pudo generar diff detallado]`;
    }
    // Quitar las cabeceras temporales que no aportan.
    const lines = diff
      .split('\n')
      .filter(
        (l) =>
          !l.startsWith('Index:') &&
          !l.startsWith('=======') &&
          !l.startsWith('--- ') &&
          !l.startsWith('+++ ')
      );
    return lines.join('\n').trim();
  }

  // ── git (helper compartido) ──────────────────────────────────────────────

  _git(args, cwd) {
    return new Promise((resolve, reject) => {
      this._exec(args, { cwd, timeout: 10000 }, (err, res) => {
        if (err) return reject(err);
        resolve(res || { code: 0, stdout: '' });
      });
    });
  }

  getStats() {
    return {
      workspace: this.getWorkspace(),
      executing: this._executing,
      executed: this._done.size,
      lastResult: this._lastResult,
      openFiles: this._getOpenFiles ? this._getOpenFiles().length : 0,
      backups: this._patchBackups.size,
    };
  }
}

module.exports = { ProactiveExecutor, PROACTIVE_TOOLS, TOOL_CATALOG };
