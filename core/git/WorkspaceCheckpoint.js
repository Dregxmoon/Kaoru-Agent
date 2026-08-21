// @ts-check
/**
 * WorkspaceCheckpoint — línea base del working tree antes de la primera
 * mutación (write/edit/apply_patch) de una ejecución del AgentLoop, y revert
 * de SOLO los cambios que hizo esa tarea, sin tocar el working tree sucio
 * previo del usuario.
 *
 * Estrategia (modo `git`):
 *   1. `git stash create` captura el estado de los archivos TRACKEADOS como
 *      commit efímero (incluye el dirty previo del usuario). Ese hash es la
 *      línea base `B`.
 *   2. En `finalize()`, otro `git stash create` captura el estado post-run `P`.
 *   3. Al revertir, `git diff --binary B P` + `git apply --reverse` deshace los
 *      cambios trackeados de la tarea (los del usuario quedan idénticos entre
 *      B y P, así que el diff no los toca).
 *   4. Los archivos UNTRACKEADOS no viven en el stash commit: se gestionan por
 *      path. Los que existían sin commitear al capturar la línea base se
 *      snapshotean (contenido previo) en `onBeforeMutation`; los que la tarea
 *      creó de cero se marcan como `created` y se borran en el revert.
 *
 * Modo `snapshot` (sin repo git): cada path que la tarea toca se snapshotea
 * antes de su primera mutación; el revert restaura esos snapshots.
 *
 * Degradación: sin repo git y sin forma de snapshotea segura no se bloquea la
 * ejecución — se registra el motivo en el log y `canRevert` queda `false`.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getGitManager } = require('./GitManager.js');
const logger = require('../observability/Logger.js');

/** Tools de mutación que disparan la captura de la línea base. */
const MUTATOR_TOOLS = new Set(['write', 'edit', 'apply_patch']);

/**
 * Interfaz mínima del GitManager que usa WorkspaceCheckpoint (GitManager.js es
 * @ts-nocheck, por eso se tipa estructuralmente aquí).
 * @typedef {{
 *   getRepoRoot(cwd: string): Promise<string|null>,
 *   status(cwd: string): Promise<{ untracked?: string[], conflicts?: unknown[] }>,
 *   revParse(cwd: string, ref: string): Promise<string|null>,
 *   stashCreate(cwd: string, message?: string): Promise<string|null>,
 *   diffTree(cwd: string, fromRef: string, toRef: string): Promise<string>,
 *   applyPatch(cwd: string, patch: string, opts?: { reverse?: boolean, checkOnly?: boolean }): Promise<{ applied: boolean, error?: string, reason?: string }>,
 * }} GitLike
 */

/** Registro global de checkpoints por id (los comandos `/revertir-tarea` leen de acá). */
const REGISTRY = new Map();

function makeId() {
  return `task-${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * @param {string} fromAbs
 * @param {string} toAbs
 */
function relFrom(fromAbs, toAbs) {
  try {
    return path.relative(fromAbs, toAbs) || path.basename(toAbs);
  } catch (_) {
    return toAbs;
  }
}

/** @param {unknown} e */
function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}

/**
 * @param {{ conflicts?: unknown[] }} status
 */
function hasGitConflicts(status) {
  return Array.isArray(status.conflicts) && status.conflicts.length > 0;
}

class WorkspaceCheckpoint {
  /**
   * @param {object} opts
   * @param {string} [opts.cwd]  directorio de trabajo del run (default: PROJECT_CWD).
   * @param {object} [opts.git]  GitManager a usar (testeable).
   * @param {'git'|'snapshot'} [opts.mode]  forzar modo; si se omite se detecta.
   */
  constructor(opts = {}) {
    /** @type {string} */
    this.cwd = opts.cwd || process.cwd();
    /** @type {GitLike} */
    this.git = opts.git || getGitManager();
    this.id = makeId();
    this.createdAt = Date.now();
    /** @type {'git'|'snapshot'|null} */
    this.mode = opts.mode || null;
    this.canRevert = false;
    this.reason = null; // motivo si no se puede revertir
    /** @type {string[]} */
    this.files = []; // paths relativos tocados
    this._captured = false;
    this._finalized = false;
    this._snapshots = new Map(); // absPath -> { existed, content }
    this._created = new Set(); // absPath que la tarea creó de cero
    this._untrackedAtBaseline = new Set(); // absPath sin commitear al capturar
    this._baselineRef = null; // stash create (o null si árbol limpio)
    this._baselineHead = null;
    this._finalizeRef = null; // stash create post-run (o null)
    this._repoRoot = null;
  }

  /**
   * Captura la línea base una sola vez (antes de la primera mutación).
   * @returns {Promise<void>}
   */
  async _captureBaseline() {
    if (this._captured) return;
    this._captured = true;
    try {
      this._repoRoot = await this.git.getRepoRoot(this.cwd);
      if (!this._repoRoot) {
        // Sin repo git: revert por snapshots de los paths tocados. Siempre es
        // viable si el agente muta a través del hook (que es lo que garantiza
        // tener el contenido previo en memoria).
        this.mode = 'snapshot';
        this.canRevert = true;
        return;
      }
      const status = await this.git.status(this._repoRoot);
      if (hasGitConflicts(status)) {
        this.canRevert = false;
        this.reason = 'hay conflictos de merge activos; no se puede garantizar un revert seguro';
        return;
      }
      this.mode = 'git';
      const head = await this.git.revParse(this._repoRoot, 'HEAD');
      this._baselineHead = head || null;
      const stash = await this.git.stashCreate(this._repoRoot, `checkpoint ${this.id} baseline`);
      this._baselineRef = stash;
      for (const u of status.untracked || []) {
        try {
          this._untrackedAtBaseline.add(path.resolve(this._repoRoot, u));
        } catch (_) {
          /* path inválido */
        }
      }
      this.canRevert = true;
    } catch (e) {
      logger.warn('WorkspaceCheckpoint', `línea base de ${this.id} no disponible: ${errMsg(e)}`);
      this.canRevert = false;
      this.reason = `no se pudo capturar la línea base (${errMsg(e)})`;
    }
  }

  /**
   * Hook previo a ejecutar una mutación. Dispara la captura de la línea base y
   * snapshotea los paths que la tarea va a tocar y que ya existían sin commitear.
   * @param {object} args
   * @param {string} args.tool  'write' | 'edit' | 'apply_patch'
   * @param {Record<string, any>} [args.params]
   * @returns {Promise<void>}
   */
  async onBeforeMutation({ tool, params = {} }) {
    if (!MUTATOR_TOOLS.has(tool)) return;
    const relPaths = this._extractPaths(tool, params);
    if (relPaths.length === 0) return;
    await this._captureBaseline();
    if (!this.canRevert) return;

    for (const rel of relPaths) {
      const abs = path.isAbsolute(rel) ? rel : path.resolve(this.cwd, rel);
      if (this._snapshots.has(abs)) continue;
      if (this._created.has(abs)) continue;
      let existed = false;
      try {
        existed = fs.existsSync(abs);
      } catch (_) {
        existed = false;
      }
      if (existed) {
        this._snapshots.set(abs, { existed: true, content: this._readFile(abs) });
      } else {
        this._created.add(abs);
      }
    }
    this.files = this._collectRelPaths();
  }

  /**
   * Extrae los paths de archivos que una mutación va a tocar.
   * @param {string} tool
   * @param {Record<string, any>} params
   * @returns {string[]}
   */
  _extractPaths(tool, params = {}) {
    if (tool === 'apply_patch') {
      // El patch contiene los paths afectados: los diff --git a/X b/X y
      // +++ b/<path> delatan qué archivo se modifica.
      const patch = params.patch || params.instructions || params.content || '';
      const out = new Set();
      const body = String(patch);
      const headerRe = /^\+\+\+ b\/(.+)$/gm;
      const diffRe = /^diff --git a\/(.+?) b\//gm;
      for (const m of body.matchAll(diffRe)) {
        if (m[1] && m[1].trim()) out.add(m[1]);
      }
      for (const m of body.matchAll(headerRe)) {
        if (m[1] && m[1].trim()) out.add(m[1]);
      }
      if (out.size === 0 && (params.path || params.filePath)) {
        out.add(params.path || params.filePath);
      }
      return [...out];
    }
    const p = params.path || params.filePath;
    return p ? [p] : [];
  }

  /** @returns {string[]} paths relativos tocados (desde el repoRoot o cwd). */
  _collectRelPaths() {
    const base = this._repoRoot || this.cwd;
    const out = new Set();
    for (const abs of [...this._snapshots.keys(), ...this._created]) {
      out.add(relFrom(base, abs));
    }
    return [...out].sort();
  }

  /** @param {string} abs */
  _readFile(abs) {
    try {
      return fs.readFileSync(abs, 'utf-8');
    } catch (e) {
      logger.warn('WorkspaceCheckpoint', `no se pudo snapshotear ${abs}: ${errMsg(e)}`);
      return '';
    }
  }

  /**
   * Cierra el checkpoint al terminar el run (siempre que haya habido mutación).
   * @returns {Promise<object|null>} metadata del checkpoint, o null si no hubo
   *   nada que capturar.
   */
  async finalize() {
    if (!this._captured) return null;
    if (this._finalized) return this._metadata();
    this._finalized = true;
    if (this.mode === 'git' && this._repoRoot && this.canRevert) {
      try {
        const status = await this.git.status(this._repoRoot);
        if (!hasGitConflicts(status)) {
          this._finalizeRef = await this.git.stashCreate(
            this._repoRoot,
            `checkpoint ${this.id} final`
          );
          // Archivos nuevos sin commitear que la tarea creó SIN pasar por el
          // hook (p. ej. vía code_execution / run_command): se registran como
          // "creados por la tarea" para que el revert también los elimine.
          for (const u of status.untracked || []) {
            const abs = path.resolve(this._repoRoot, u);
            if (this._untrackedAtBaseline.has(abs)) continue;
            if (this._snapshots.has(abs)) continue;
            if (this._created.has(abs)) continue;
            this._created.add(abs);
          }
          this.files = this._collectRelPaths();
        }
      } catch (e) {
        logger.warn('WorkspaceCheckpoint', `finalize de ${this.id}: ${errMsg(e)}`);
      }
    }
    const meta = this._metadata();
    REGISTRY.set(this.id, this);
    return meta;
  }

  /** @returns {object} metadata serializable. */
  _metadata() {
    return {
      id: this.id,
      createdAt: this.createdAt,
      mode: this.mode,
      canRevert: this.canRevert,
      reason: this.reason,
      files: this.files,
      summary: this._summary(),
    };
  }

  _summary() {
    if (!this._captured) return null;
    const parts = [];
    if (this._snapshots.size > 0) {
      parts.push(`${this._snapshots.size} archivo(s) sin commitear snapshoteado(s)`);
    }
    if (this._created.size > 0) {
      parts.push(`${this._created.size} archivo(s) creado(s) por la tarea`);
    }
    const fromRef = this._baselineRef || this._baselineHead;
    if (this.mode === 'git' && fromRef && this._finalizeRef) {
      parts.push('cambios trackeados (se revierten vía diff)');
    }
    return parts.length > 0 ? parts.join('; ') : 'sin cambios detectados';
  }

  /**
   * Metadata pública del checkpoint (null si no hubo mutación capturable).
   * @returns {object|null}
   */
  metadata() {
    return this._captured ? this._metadata() : null;
  }

  /**
   * Revierte los cambios de esta tarea.
   * @param {boolean} [dryRun] si true, solo valida sin aplicar.
   * @returns {Promise<object>}
   */
  async revert(dryRun = false) {
    if (!this._captured) {
      return { ok: false, error: 'el checkpoint no llegó a capturar una línea base' };
    }
    if (!this.canRevert) {
      return { ok: false, error: this.reason || 'este checkpoint no se puede revertir' };
    }
    /** @type {{ ok: boolean, dryRun: boolean, reverted: string[], skipped: string[], warnings: string[] }} */
    const result = { ok: true, dryRun, reverted: [], skipped: [], warnings: [] };

    // 1. Cambios trackeados: diff baseline→final, revertido.
    const fromRef = this._baselineRef || this._baselineHead;
    if (this.mode === 'git' && this._repoRoot && this._finalizeRef && fromRef) {
      try {
        const patch = await this.git.diffTree(this._repoRoot, fromRef, this._finalizeRef);
        if (patch.trim()) {
          const check = await this.git.applyPatch(this._repoRoot, patch, {
            reverse: true,
            checkOnly: true,
          });
          if (!check.applied) {
            return {
              ok: false,
              error: `el diff de la tarea no se puede revertir limpiamente (${check.error || check.reason})`,
              dryRun,
            };
          }
          result.reverted.push('(cambios trackeados)');
          if (!dryRun) await this.git.applyPatch(this._repoRoot, patch, { reverse: true });
        } else {
          result.skipped.push('(sin cambios trackeados)');
        }
      } catch (e) {
        return {
          ok: false,
          error: `error al revertir cambios trackeados: ${errMsg(e)}`,
          dryRun,
        };
      }
    }

    // 2. Archivos que ya existían sin commitear: restaurar snapshot.
    for (const [abs, snap] of this._snapshots) {
      const rel = relFrom(this._repoRoot || this.cwd, abs);
      try {
        if (snap.existed) {
          if (!dryRun) {
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, snap.content, 'utf-8');
          }
          result.reverted.push(rel);
        } else {
          if (!dryRun) fs.rmSync(abs, { force: true });
          result.reverted.push(`${rel} (eliminado)`);
        }
      } catch (e) {
        result.warnings.push(`${rel}: ${errMsg(e)}`);
      }
    }

    // 3. Archivos creados por la tarea: eliminar.
    for (const abs of this._created) {
      const rel = relFrom(this._repoRoot || this.cwd, abs);
      if (!fs.existsSync(abs)) {
        result.skipped.push(`${rel} (ya no existe)`);
        continue;
      }
      try {
        if (!dryRun) fs.rmSync(abs, { force: true });
        result.reverted.push(`${rel} (creado por la tarea)`);
      } catch (e) {
        result.warnings.push(`${rel}: ${errMsg(e)}`);
      }
    }

    return result;
  }
}

/**
 * Devuelve el checkpoint registrado para un id.
 * @param {string} id
 */
function getCheckpoint(id) {
  return REGISTRY.get(id) || null;
}

/** Lista de checkpoints registrados, más reciente primero. */
function listCheckpoints() {
  return [...REGISTRY.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((cp) => cp._metadata());
}

/**
 * Revierte el último checkpoint registrado (o uno concreto por id).
 * @param {string|undefined} id
 */
async function revertCheckpoint(id) {
  const cp = id
    ? getCheckpoint(id)
    : [...REGISTRY.values()].sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!cp) return { ok: false, error: 'no hay checkpoints registrados' };
  return cp.revert(false);
}

module.exports = {
  WorkspaceCheckpoint,
  getCheckpoint,
  listCheckpoints,
  revertCheckpoint,
  MUTATOR_TOOLS,
};
