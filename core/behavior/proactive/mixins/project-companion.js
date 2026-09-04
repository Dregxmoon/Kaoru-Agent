// @ts-check
'use strict';

const path = require('path');

const PROJECT_LANGUAGE =
  /\b(?:proyecto|repositorio|repo|c[oó]digo|implementaci[oó]n|m[oó]dulo|feature|bug|prueba|test)\b/i;
const RESUME_MIN_AGE_MS = 2 * 60 * 60 * 1000;
const RESUME_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const RESUME_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** @param {RegExp} pattern @param {string} content */
function captured(pattern, content) {
  const match = content.match(pattern);
  return (
    match?.[1]
      ?.trim()
      .replace(/[.!]+$/, '')
      .slice(0, 1000) || null
  );
}

module.exports = {
  /**
   * Registra señales explícitas del usuario sólo en el workspace activo.
   * @this {any}
   * @param {unknown} content
   * @returns {any}
   */
  _captureProjectUpdate(content) {
    const workspace = this._getWorkspace?.();
    const text = String(content || '').trim();
    if (!workspace || !text || text.length > 2000) return null;

    const objective = captured(
      /(?:el objetivo (?:de (?:este|mi) proyecto )?es|en este proyecto quiero|quiero lograr)\s+(.{3,500})/i,
      text
    );
    const blocker = captured(
      /(?:estoy|me qued[eé]) (?:atorad[oa]|bloquead[oa]) (?:con|en|porque)?\s*(.{3,500})/i,
      text
    );
    const nextStep = captured(
      /(?:lo siguiente es|el siguiente paso es|ahora voy a|despu[eé]s voy a)\s+(.{3,500})/i,
      text
    );
    const progress = captured(
      /(?:ya (?:termin[eé]|complet[eé]|arregl[eé]|implement[eé]|resolv[ií])|acabo de (?:terminar|completar|arreglar|implementar|resolver))\s+(.{2,500})/i,
      text
    );
    if (!objective && !blocker && !nextStep && !progress) return null;
    if (!PROJECT_LANGUAGE.test(text) && !this._graph?.getProjectCompanion?.(workspace)) return null;

    /** @type {any} */
    const update = { workspace, eventType: 'user_report' };
    if (objective) update.objective = objective;
    if (blocker) {
      update.blocker = blocker;
      update.phase = 'debugging';
    }
    if (nextStep) update.nextStep = nextStep;
    if (progress) {
      update.lastProgress = progress;
      update.blocker = null;
      update.phase = /prueb|verific/i.test(text) ? 'verifying' : 'building';
    }
    return this._graph?.updateProjectCompanion?.(update) || null;
  },

  /**
   * Mantiene archivo/fase actual con escritura acotada (cambio o cada 5 min).
   * @this {any}
   * @param {{category?:string,title?:string}} [input]
   */
  _observeProjectFocus(input = {}) {
    const { category, title } = input;
    const workspace = this._getWorkspace?.();
    if (!workspace || !['code', 'terminal', 'docs', 'design'].includes(String(category))) return;
    const now = Date.now();
    const focusedFile = this._getFocusedFile?.() || null;
    const key = `${workspace}|${focusedFile || ''}|${category}`;
    if (key === this._lastProjectFocusKey && now - this._lastProjectFocusWrite < 5 * 60 * 1000) {
      return;
    }
    this._lastProjectFocusKey = key;
    this._lastProjectFocusWrite = now;
    const previous = this._graph?.getProjectCompanion?.(workspace) || null;
    this._graph?.updateProjectCompanion?.({
      workspace,
      activeFile: focusedFile,
      phase: previous?.blocker ? 'debugging' : category === 'docs' ? 'exploring' : 'building',
      eventType: 'focus',
      now,
    });
    this._currentProjectTitle = title ? String(title).slice(0, 200) : null;
  },

  /**
   * Un error real es evidencia de bloqueo, no una inferencia por temporizador.
   * @this {any}
   * @param {{workspace?:string,absPath?:string,file?:string,errors?:Array<{message?:string}>}} [input]
   */
  _recordProjectBlocker(input = {}) {
    const { workspace, absPath, file, errors } = input;
    const activeWorkspace = this._getWorkspace?.();
    const scopedWorkspace = workspace || activeWorkspace;
    if (!scopedWorkspace || path.resolve(scopedWorkspace) !== path.resolve(activeWorkspace || '')) {
      return;
    }
    const first = Array.isArray(errors) ? errors[0] : null;
    if (!first?.message) return;
    this._graph?.updateProjectCompanion?.({
      workspace: scopedWorkspace,
      activeFile: absPath || file || null,
      phase: 'debugging',
      blocker: `${file || 'archivo'}: ${String(first.message).slice(0, 500)}`,
      eventType: 'lsp_error',
    });
  },

  /**
   * Estado serializable para prompt/stats; nunca devuelve otro workspace.
   * @this {any}
   * @returns {any}
   */
  _getCurrentProjectCompanion() {
    const workspace = this._getWorkspace?.();
    return workspace ? this._graph?.getProjectCompanion?.(workspace) || null : null;
  },

  /**
   * Retoma un hilo sólo al volver deliberadamente a ese workspace, con una
   * señal concreta guardada y mientras la app activa siga siendo de trabajo.
   * @this {any}
   * @param {{path?:string}} [input]
   */
  async _onProjectWorkspaceChanged(input = {}) {
    const workspace = input.path || this._getWorkspace?.();
    const category = this._osSensor?.getCurrentContext?.()?.category;
    if (!workspace || !['code', 'terminal', 'docs', 'design'].includes(String(category))) return;
    const state = this._graph?.getProjectCompanion?.(workspace);
    if (!state || !(state.objective || state.blocker || state.nextStep || state.lastProgress))
      return;
    if (state.lastEventType === 'goal_completed') return;
    const now = Date.now();
    const age = now - Number(state.lastActivityAt || 0);
    if (age < RESUME_MIN_AGE_MS || age > RESUME_MAX_AGE_MS) return;
    if (state.lastPromptedAt && now - state.lastPromptedAt < RESUME_COOLDOWN_MS) return;
    const anchor = state.blocker || state.nextStep || state.lastProgress || state.objective;
    const result = await this._tryTrigger?.({
      type: 'project_resume',
      projectName: state.projectName,
      context: `El usuario volvió al workspace "${state.projectName}". El último hilo comprobado fue: ${anchor}`,
    });
    if (typeof result === 'string') {
      this._graph?.markProjectCompanionPrompted?.(workspace, now);
    }
  },
};
