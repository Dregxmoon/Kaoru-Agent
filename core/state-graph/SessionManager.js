// @ts-check
const logger = require('../observability/Logger.js');
/**
 * SessionManager.js — con deduplicación al inicio de sesión
 */

const { StateUpdater } = require('./StateUpdater.js');
const { ContradictionResolver } = require('./ContradictionResolver.js');

const DECAY_INTERVAL_HOURS = 20;

/**
 * @typedef {{ id: string, history: Array<{ role: string, content: string, ts?: number }>, turnCount: number }} ResumableSession
 * @typedef {{ getPath(name: string): string }} ElectronAppLike
 * @typedef {{
 *   findResumableSession(hours: number): ResumableSession | null,
 *   startSession(): string,
 *   updateSessionHistory(id: string, history: Array<object>): void,
 *   endSession(id: string, opts: object): void,
 *   getStats(): object,
 * }} StateGraphLike
 */
class SessionManager {
  /**
   * @param {StateGraphLike} stateGraph
   * @param {object} groundingEngine
   * @param {{ resumeMaxAgeHours?: number }} [options]
   */
  constructor(stateGraph, groundingEngine, { resumeMaxAgeHours = 48 } = {}) {
    this._graph = stateGraph;
    this._grounding = groundingEngine;
    this._updater = new StateUpdater(stateGraph);
    this._resolver = new ContradictionResolver(stateGraph);
    this._sessionId = null;
    /** @type {Array<{ role: string, content: string, ts?: number }>} */
    this._history = [];
    this._turnCount = 0;
    this._isClosing = false;
    this._closePromise = null;
    this._resumeMaxAgeHours = resumeMaxAgeHours;
  }

  /**
   * Mejora #6: antes de crear una sesión nueva, revisa si hay una sesión
   * anterior que se haya quedado a medias (ended_at NULL — la ventana se
   * cerró sin pasar por close(), o la app crasheó). Si la hay y está
   * dentro de la ventana razonable, la retoma — mismo sessionId, mismo
   * historial — en vez de empezar en blanco. El llamador (Core →
   * main.js → chat.html) usa el flag `resumed` para repoblar la ventana
   * de chat visualmente con los mensajes recuperados.
   */
  /** @param {ElectronAppLike | null} [app] */
  async start(app) {
    if (this._closePromise) {
      await this._closePromise.catch(() => {});
      this._closePromise = null;
    }

    const resumable = this._graph.findResumableSession(this._resumeMaxAgeHours);
    if (resumable) {
      logger.info(
        'SessionManager',
        `[session] reanudando sesión interrumpida ${resumable.id} (${resumable.history.length} mensajes)`
      );
      this._sessionId = resumable.id;
      this._history = resumable.history;
      this._turnCount = resumable.turnCount;
      this._resolver.deduplicateNodes();
      this._updater.cleanupMemoryArtifacts();
      this._maybeRunDecay(app);
      return { sessionId: this._sessionId, resumed: true, history: resumable.history };
    }

    this._sessionId = this._graph.startSession();
    this._history = [];
    this._turnCount = 0;
    logger.info('SessionManager', `[session] sesión ${this._sessionId} iniciada`);

    this._resolver.deduplicateNodes();
    this._updater.cleanupMemoryArtifacts();

    this._maybeRunDecay(app);
    return { sessionId: this._sessionId, resumed: false, history: [] };
  }

  /**
   * @param {string} role
   * @param {string} content
   */
  addTurn(role, content) {
    this._history.push({ role, content, ts: Date.now() });
    this._turnCount++;
    if (this._history.length > 40) this._history = this._history.slice(-40);

    // Persistencia incremental — barata (better-sqlite3 es síncrono), y es
    // justo lo que permite resumir tras un crash: si la app truena ahora
    // mismo, como mucho se pierde el turno en vuelo, no la conversación.
    if (this._sessionId) {
      this._graph.updateSessionHistory(this._sessionId, this._history);
    }
  }

  getHistory() {
    return [...this._history];
  }

  /**
   * Restaura una sesión desde un snapshot (checkpoint). Permite retomar una
   * conversación desde un punto guardado: mismo historial y turnos, pero
   * siempre dentro de una sesión válida (nueva si sessionId es null).
   * @param {Array<{ role: string, content: string, ts?: number }>} history
   * @param {string | null} [sessionId]
   * @returns {{ sessionId: string, turnCount: number }}
   */
  restore(history, sessionId = null) {
    const safeHistory = Array.isArray(history) ? history : [];
    this._sessionId = sessionId || this._graph.startSession();
    this._history = safeHistory.slice(-40);
    this._turnCount = this._history.length;
    if (this._sessionId) {
      this._graph.updateSessionHistory(this._sessionId, this._history);
    }
    logger.info(
      'SessionManager',
      `[session] checkpoint restaurado: sesión ${this._sessionId} (${this._history.length} mensajes)`
    );
    return { sessionId: this._sessionId, turnCount: this._turnCount };
  }

  async close() {
    if (this._isClosing || !this._sessionId) return;
    this._isClosing = true;

    const sessionId = this._sessionId;
    const history = [...this._history];
    const turnCount = this._turnCount;
    this._sessionId = null;

    logger.info(
      'SessionManager',
      `[session] cerrando sesión ${sessionId} (${turnCount} turnos)...`
    );

    this._closePromise = this._updater
      .processSession(sessionId, history, turnCount)
      .then((result) => {
        logger.info('SessionManager', `[session] memoria guardada: ${result.saved} nodos`);
        return result;
      })
      .catch((err) => {
        logger.error('SessionManager', '[session] error:', err.message);
        try {
          this._graph.endSession(sessionId, { turnCount, summary: null });
        } catch (_) {}
      })
      .finally(() => {
        this._isClosing = false;
      });

    return this._closePromise;
  }

  /** @param {ElectronAppLike | null} [app] */
  _maybeRunDecay(app) {
    try {
      const fs = require('fs');
      const path = require('path');
      const marker = app ? path.join(app.getPath('userData'), 'decay_marker.json') : null;
      if (!marker) {
        this._updater.runDecay();
        return;
      }
      let lastRun = 0;
      if (fs.existsSync(marker)) {
        try {
          lastRun = JSON.parse(fs.readFileSync(marker, 'utf-8')).ts || 0;
        } catch (_) {}
      }
      const hoursSince = (Date.now() - lastRun) / (1000 * 60 * 60);
      if (hoursSince >= DECAY_INTERVAL_HOURS) {
        logger.info('SessionManager', '[session] corriendo decay diario...');
        this._updater.runDecay();
        fs.writeFileSync(marker, JSON.stringify({ ts: Date.now() }), 'utf-8');
      }
    } catch (e) {
      logger.warn('SessionManager', '[session] error decay:', /** @type {Error} */ (e).message);
    }
  }

  getStats() {
    return {
      session: this._sessionId,
      turns: this._turnCount,
      historyLen: this._history.length,
      graph: this._graph.getStats(),
    };
  }
}

module.exports = { SessionManager };
