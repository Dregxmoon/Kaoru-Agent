// @ts-check
'use strict';

/**
 * LearningEngine.js — Fase 3, ítem 2: el aprendizaje que cierra el círculo.
 *
 * Conecta dos fuentes de feedback con dos salidas:
 *
 *   Feedback de proactividad  → pesos de scoring recalibrados
 *     (ProposalStore)           (DecisionCore.deriveWeights) → gate de relevancia
 *
 *   Evaluación de tareas      → sección "# LO APRENDIDO" en el prompt
 *     (outcomes de agent.js)    (éxito/fracaso por modo) → el modelo evita
 *                               repetir errores y refuerza lo que funciona.
 *
 * Persistencia en JSON (data/learning_feedback.json) con el mismo patrón
 * nunca-lanza de ProposalStore: cualquier fallo de disco degrada a memoria y
 * el asistente sigue funcionando. Los pesos aprendidos se MIERAN también al
 * ProposalStore (setLearnedWeights) porque es ahí donde el gate los lee.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../observability/Logger.js');
const DecisionCore = require('../decision/DecisionCore.js');

const DEFAULT_PATH = path.join(__dirname, '..', '..', 'data', 'learning_feedback.json');

// Cuántos outcomes de tarea se conservan en disco (circular, FIFO).
const MAX_TASK_OUTCOMES = 500;

/**
 * Interface mínima de ProposalStore usada por el LearningEngine (el archivo
 * original es @ts-nocheck, así que se describe estructuralmente aquí).
 * @typedef {{
 *   getStats: () => { byType?: Record<string, {accepted?: number, rejected?: number, ignored?: number}> },
 *   setLearnedWeights: (weights: object | null) => void,
 * }} ProposalStoreLike
 */

/**
 * @typedef {object} TaskOutcome
 * @property {number} ts
 * @property {string} mode
 * @property {string|null} provider
 * @property {string|null} model
 * @property {boolean} success
 * @property {string|null} error
 * @property {number|null} iterations
 * @property {number|null} elapsedMs
 * @property {number|null} difficulty
 * @property {string} goal
 */

/** @typedef {object} LearningData
 *  @property {object|null} learnedWeights
 *  @property {TaskOutcome[]} taskOutcomes
 *  @property {number|null} updatedAt
 */

/**
 * Mensaje seguro de un `catch` (tipo `unknown` con el tsconfig actual).
 * @param {unknown} e
 * @returns {string}
 */
function _errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}

class LearningEngine {
  /**
   * @param {object} opts
   * @param {string} [opts.filePath]      Ruta del JSON (inyectable en tests).
   * @param {ProposalStoreLike} [opts.proposalStore] ProposalStore con getStats/setLearnedWeights.
   */
  constructor({ filePath, proposalStore } = {}) {
    this._filePath = filePath || DEFAULT_PATH;
    this._proposalStore = proposalStore || null;
    this._data = /** @type {LearningData} */ ({
      learnedWeights: null,
      taskOutcomes: [],
      updatedAt: null,
    });
    this._inMem = false;
    this._load();
  }

  _load() {
    try {
      if (this._filePath && fs.existsSync(this._filePath)) {
        const raw = JSON.parse(fs.readFileSync(this._filePath, 'utf-8'));
        if (raw && typeof raw === 'object') {
          this._data = {
            learnedWeights: raw.learnedWeights || null,
            taskOutcomes: Array.isArray(raw.taskOutcomes) ? raw.taskOutcomes : [],
            updatedAt: raw.updatedAt || null,
          };
        }
      }
    } catch (e) {
      logger.warn('LearningEngine', '[learning] no se pudo leer feedback previo:', _errMsg(e));
      this._inMem = true;
    }
  }

  _persist() {
    if (this._inMem || !this._filePath) return;
    try {
      fs.mkdirSync(path.dirname(this._filePath), { recursive: true });
      fs.writeFileSync(this._filePath, JSON.stringify(this._data, null, 2));
    } catch (e) {
      logger.warn('LearningEngine', '[learning] no se pudo persistir feedback:', _errMsg(e));
      this._inMem = true;
    }
  }

  // ── Feedback de proactividad → pesos ───────────────────────────────────────

  /**
   * Recalibra los pesos de scoring desde las stats del ProposalStore y los
   * escribe (a) en el propio LearningEngine y (b) en el ProposalStore, que es
   * la fuente que lee el gate. Sin muestras suficientes es identidad.
   * @returns {object} pesos { severity, actionability, salience, costOfIgnore }
   */
  calibrate() {
    const stats =
      this._proposalStore && typeof this._proposalStore.getStats === 'function'
        ? this._proposalStore.getStats()
        : {};
    const weights = DecisionCore.deriveWeights(stats || {}, {});
    this._data.learnedWeights = weights;
    this._data.updatedAt = Date.now();
    if (this._proposalStore && typeof this._proposalStore.setLearnedWeights === 'function') {
      this._proposalStore.setLearnedWeights(weights);
    }
    this._persist();
    return weights;
  }

  /** Pesos vigentes (los que el gate aplica). */
  getLearnedWeights() {
    return this._data.learnedWeights;
  }

  // ── Evaluación de tareas → prompt ──────────────────────────────────────────

  /**
   * @param {object} outcome
   * @param {string} [outcome.mode]      'smart' | 'fast' | 'agent' ...
   * @param {string} [outcome.provider]  provider activo (groq/openai/...)
   * @param {string} [outcome.model]     modelo usado
   * @param {boolean} [outcome.success]  completó o no
   * @param {string} [outcome.error]     motivo de fallo (si falló)
   * @param {number} [outcome.iterations] iteraciones del loop (si aplica)
   * @param {number} [outcome.elapsedMs] duración
   * @param {number} [outcome.difficulty] estimación 0..1 (ver difficulty.js)
   * @param {string} [outcome.goal]      resumen del objetivo
   * @returns {object} el outcome persistido
   */
  recordTaskOutcome(outcome = {}) {
    const entry = {
      ts: Date.now(),
      mode: outcome.mode || 'unknown',
      provider: outcome.provider || null,
      model: outcome.model || null,
      success: !!outcome.success,
      error: outcome.error || null,
      iterations: outcome.iterations ?? null,
      elapsedMs: outcome.elapsedMs ?? null,
      difficulty: outcome.difficulty ?? null,
      goal: String(outcome.goal || '').slice(0, 160),
    };
    this._data.taskOutcomes.push(entry);
    if (this._data.taskOutcomes.length > MAX_TASK_OUTCOMES) {
      this._data.taskOutcomes.splice(0, this._data.taskOutcomes.length - MAX_TASK_OUTCOMES);
    }
    this._persist();
    return entry;
  }

  /**
   * @param {object} [opts]
   * @param {number} [opts.limit]
   * @param {string|null} [opts.mode]
   * @returns {TaskOutcome[]}
   */
  getTaskOutcomes({ limit = 20, mode = null } = {}) {
    let list = this._data.taskOutcomes;
    if (mode) list = list.filter((o) => o.mode === mode);
    return list.slice(-limit);
  }

  /**
   * Tasa de éxito reciente. Devuelve null si no hay suficientes muestras
   * (minSamples), para que buildPromptSection no hable de datos ruidosos.
   * @param {object} [opts]
   * @param {string|null} [opts.mode]
   * @param {number} [opts.minSamples]
   * @returns {number|null}
   */
  successRate({ mode = null, minSamples = 5 } = {}) {
    let list = this._data.taskOutcomes;
    if (mode) list = list.filter((o) => o.mode === mode);
    if (list.length < minSamples) return null;
    return list.filter((o) => o.success).length / list.length;
  }

  /**
   * Dificultad de una tarea CALIBRADA con los outcomes reales del modo: el
   * heurístico de difficulty.js es la línea base y el historial lo ajusta de
   * forma acotada. Si el modo tiene baja tasa de éxito reciente, la tarea
   * probablemente sea más dura de lo que sugiere la heurística (y viceversa).
   * Se usa para el gate de planificación, el routing de confianza y la
   * evaluación de outcomes — así el presupuesto sigue al feedback real.
   * @param {object} [opts]
   * @param {string} [opts.message]
   * @param {object|null} [opts.taskIntent]
   * @param {number} [opts.messageCount]
   * @param {string} [opts.mode] modo a calibrar ('smart' | 'fast' | ...)
   * @returns {number} dificultad en [0, 1]
   */
  calibratedDifficulty({ message = '', taskIntent = null, messageCount = 0, mode = 'smart' } = {}) {
    const { estimateDifficulty } = require('./difficulty.js');
    const base = estimateDifficulty({ message, taskIntent, messageCount });
    const rate = this.successRate({ mode, minSamples: 8 });
    if (rate === null) return base;
    const adjusted = Math.min(1, Math.max(0, base + (0.5 - rate) * 0.3));
    return Math.round(adjusted * 100) / 100;
  }

  /**
   * Sección corta de prompt con lo aprendido. Solo incluye datos con muestras
   * suficientes; si no hay nada significativo devuelve null (no se inyecta).
   * @returns {string|null}
   */
  buildPromptSection() {
    const lines = [];

    // Preferencias de proactividad aprendidas del feedback de propuestas.
    if (this._proposalStore && typeof this._proposalStore.getStats === 'function') {
      const byType = this._proposalStore.getStats().byType || {};
      const low = [];
      const high = [];
      for (const [type, t] of Object.entries(byType)) {
        if (!t || typeof t !== 'object') continue;
        const total = (t.accepted || 0) + (t.rejected || 0) + (t.ignored || 0);
        if (total < 3) continue;
        const ratio = (t.accepted || 0) / total;
        if (ratio < 0.25) low.push(type);
        else if (ratio > 0.75) high.push(type);
      }
      if (low.length)
        lines.push(
          `Al usuario no le gustan las sugerencias de tipo: ${low.join(', ')} — evítalas.`
        );
      if (high.length)
        lines.push(`Al usuario le resultan útiles las sugerencias de tipo: ${high.join(', ')}.`);
    }

    // Tasa de éxito por modo de tarea.
    const smart = this.successRate({ mode: 'smart' });
    if (smart !== null)
      lines.push(`Tareas "smart" recientes completadas con éxito: ${Math.round(smart * 100)}%.`);
    const fast = this.successRate({ mode: 'fast' });
    if (fast !== null)
      lines.push(`Tareas "fast" recientes completadas con éxito: ${Math.round(fast * 100)}%.`);

    if (!lines.length) return null;
    return '# LO APRENDIDO (FEEDBACK)\n' + lines.map((l) => '  - ' + l).join('\n') + '\n';
  }

  getData() {
    return {
      learnedWeights: this._data.learnedWeights,
      taskOutcomes: this._data.taskOutcomes.slice(-20),
      updatedAt: this._data.updatedAt,
      filePath: this._filePath,
      inMemoryOnly: this._inMem,
    };
  }

  reset() {
    this._data = { learnedWeights: null, taskOutcomes: [], updatedAt: null };
    this._inMem = false;
    if (this._proposalStore && typeof this._proposalStore.setLearnedWeights === 'function') {
      this._proposalStore.setLearnedWeights(null);
    }
    if (this._filePath) {
      try {
        fs.rmSync(this._filePath, { force: true });
      } catch {}
    }
  }
}

module.exports = { LearningEngine, MAX_TASK_OUTCOMES };
