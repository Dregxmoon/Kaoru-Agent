// @ts-check
'use strict';

const path = require('path');

const PHASES = new Set(['exploring', 'building', 'debugging', 'verifying', 'paused', 'unknown']);

class ProjectCompanionStore {
  /** @param {any} db @param {{usingFallback?:boolean}} graph */
  constructor(db, graph) {
    this._db = db;
    this._graph = graph;
    /** @type {Map<string, any>} */
    this._fallback = new Map();
  }

  /**
   * Actualiza el hilo de un workspace sin mezclar proyectos. Un campo ausente
   * conserva su valor; `null` explícito permite limpiar un estado resuelto.
   * @param {{workspace:string,objective?:string|null,activeFile?:string|null,phase?:string,blocker?:string|null,nextStep?:string|null,lastProgress?:string|null,eventType?:string,now?:number}} input
   */
  update(input) {
    const workspace = this._workspace(input?.workspace);
    if (!workspace) return null;
    const now = Number(input.now) || Date.now();
    const previous = this.get(workspace);
    /** @param {string} key */
    const has = (key) => Object.prototype.hasOwnProperty.call(input, key);
    const phase = PHASES.has(String(input.phase))
      ? String(input.phase)
      : previous?.phase || 'unknown';
    const row = {
      workspace,
      projectName: path.basename(workspace),
      objective: has('objective') ? this._text(input.objective, 1000) : previous?.objective || null,
      activeFile: has('activeFile')
        ? this._relativeFile(workspace, input.activeFile)
        : previous?.activeFile || null,
      phase,
      blocker: has('blocker') ? this._text(input.blocker, 1000) : previous?.blocker || null,
      nextStep: has('nextStep') ? this._text(input.nextStep, 1000) : previous?.nextStep || null,
      lastProgress: has('lastProgress')
        ? this._text(input.lastProgress, 1000)
        : previous?.lastProgress || null,
      lastEventType: this._text(input.eventType, 80) || previous?.lastEventType || 'activity',
      lastActivityAt: now,
      lastProgressAt: has('lastProgress') ? now : previous?.lastProgressAt || null,
      lastPromptedAt: previous?.lastPromptedAt || null,
      createdAt: previous?.createdAt || now,
      updatedAt: now,
    };

    if (this._graph.usingFallback) {
      this._fallback.set(workspace, row);
      return row;
    }
    this._db
      .prepare(
        `INSERT INTO project_companion_state
         (workspace, project_name, objective, active_file, phase, blocker, next_step,
          last_progress, last_event_type, last_activity_at, last_progress_at, last_prompted_at,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace) DO UPDATE SET
           project_name=excluded.project_name, objective=excluded.objective,
           active_file=excluded.active_file, phase=excluded.phase, blocker=excluded.blocker,
           next_step=excluded.next_step, last_progress=excluded.last_progress,
           last_event_type=excluded.last_event_type, last_activity_at=excluded.last_activity_at,
           last_progress_at=excluded.last_progress_at,
           last_prompted_at=excluded.last_prompted_at, updated_at=excluded.updated_at`
      )
      .run(
        row.workspace,
        row.projectName,
        row.objective,
        row.activeFile,
        row.phase,
        row.blocker,
        row.nextStep,
        row.lastProgress,
        row.lastEventType,
        row.lastActivityAt,
        row.lastProgressAt,
        row.lastPromptedAt,
        row.createdAt,
        row.updatedAt
      );
    return row;
  }

  /** @param {string} workspace @param {number} [now] */
  markPrompted(workspace, now = Date.now()) {
    const safe = this._workspace(workspace);
    if (!safe) return false;
    if (this._graph.usingFallback) {
      const row = this._fallback.get(safe);
      if (!row) return false;
      row.lastPromptedAt = now;
      return true;
    }
    return (
      this._db
        .prepare('UPDATE project_companion_state SET last_prompted_at=? WHERE workspace=?')
        .run(now, safe).changes === 1
    );
  }

  /** @param {string} workspace */
  get(workspace) {
    const safe = this._workspace(workspace);
    if (!safe) return null;
    if (this._graph.usingFallback) return this._fallback.get(safe) || null;
    const row = this._db
      .prepare('SELECT * FROM project_companion_state WHERE workspace=?')
      .get(safe);
    return row ? this._view(row) : null;
  }

  /** @param {number} [limit] */
  list(limit = 20) {
    if (this._graph.usingFallback) {
      return [...this._fallback.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
    }
    return this._db
      .prepare('SELECT * FROM project_companion_state ORDER BY updated_at DESC LIMIT ?')
      .all(Math.max(1, Math.min(100, Number(limit) || 20)))
      .map((/** @type {any} */ row) => this._view(row));
  }

  /** @param {any} row */
  _view(row) {
    return {
      workspace: String(row.workspace),
      projectName: String(row.project_name),
      objective: row.objective == null ? null : String(row.objective),
      activeFile: row.active_file == null ? null : String(row.active_file),
      phase: String(row.phase || 'unknown'),
      blocker: row.blocker == null ? null : String(row.blocker),
      nextStep: row.next_step == null ? null : String(row.next_step),
      lastProgress: row.last_progress == null ? null : String(row.last_progress),
      lastEventType: String(row.last_event_type || 'activity'),
      lastActivityAt: Number(row.last_activity_at),
      lastProgressAt: row.last_progress_at == null ? null : Number(row.last_progress_at),
      lastPromptedAt: row.last_prompted_at == null ? null : Number(row.last_prompted_at),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  /** @param {unknown} value @param {number} max */
  _text(value, max) {
    if (value == null) return null;
    const text = String(value).trim().replace(/\s+/g, ' ').slice(0, max);
    return text || null;
  }

  /** @param {unknown} value */
  _workspace(value) {
    const raw = String(value || '').trim();
    return raw ? path.resolve(raw) : '';
  }

  /** @param {string} workspace @param {unknown} value */
  _relativeFile(workspace, value) {
    const raw = this._text(value, 1000);
    if (!raw) return null;
    const absolute = path.resolve(raw);
    const relative = path.relative(workspace, absolute);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
      ? relative.slice(0, 500)
      : path.basename(raw).slice(0, 500);
  }
}

module.exports = { ProjectCompanionStore };
