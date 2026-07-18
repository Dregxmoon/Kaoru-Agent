/**
 * SessionManager.js — con deduplicación al inicio de sesión
 */

const { StateUpdater }          = require('./StateUpdater.js');
const { ContradictionResolver } = require('./ContradictionResolver.js');

const DECAY_INTERVAL_HOURS = 20;

class SessionManager {
  constructor(stateGraph, groundingEngine) {
    this._graph        = stateGraph;
    this._grounding    = groundingEngine;
    this._updater      = new StateUpdater(stateGraph);
    this._resolver     = new ContradictionResolver(stateGraph);
    this._sessionId    = null;
    this._history      = [];
    this._turnCount    = 0;
    this._isClosing    = false;
    this._closePromise = null;
  }

  /**
   * Mejora #6: antes de crear una sesión nueva, revisa si hay una sesión
   * anterior que se haya quedado a medias (ended_at NULL — la ventana se
   * cerró sin pasar por close(), o la app crasheó). Si la hay y está
   * dentro de la ventana razonable, la retoma — mismo sessionId, mismo
   * historial — en vez de empezar en blanco. El llamador (MarchCore →
   * main.js → chat.html) usa el flag `resumed` para repoblar la ventana
   * de chat visualmente con los mensajes recuperados.
   */
  async start(app) {
    if (this._closePromise) {
      await this._closePromise.catch(() => {});
      this._closePromise = null;
    }

    const resumable = this._graph.findResumableSession(12);

    if (resumable) {
      this._sessionId = resumable.id;
      this._history   = resumable.history;
      this._turnCount = resumable.turnCount;
      console.log(`[session] retomando sesión interrumpida ${this._sessionId} (${this._history.length} mensajes, empezó hace ${Math.round((Date.now() - resumable.startedAt) / 60000)} min)`);
    } else {
      this._sessionId = this._graph.startSession();
      this._history   = [];
      this._turnCount = 0;
      console.log(`[session] sesión ${this._sessionId} iniciada`);
    }

    // Limpiar duplicados acumulados de sesiones anteriores
    this._resolver.deduplicateNodes();

    this._maybeRunDecay(app);
    return { sessionId: this._sessionId, resumed: !!resumable, history: [...this._history] };
  }

  addTurn(role, content) {
    this._history.push({ role, content });
    this._turnCount++;
    if (this._history.length > 40) this._history = this._history.slice(-40);

    // Persistencia incremental — barata (better-sqlite3 es síncrono), y es
    // justo lo que permite resumir tras un crash: si la app truena ahora
    // mismo, como mucho se pierde el turno en vuelo, no la conversación.
    this._graph.updateSessionHistory(this._sessionId, this._history);
  }

  getHistory() { return [...this._history]; }

  async close() {
    if (this._isClosing || !this._sessionId) return;
    this._isClosing = true;

    const sessionId = this._sessionId;
    const history   = [...this._history];
    const turnCount = this._turnCount;
    this._sessionId = null;

    console.log(`[session] cerrando sesión ${sessionId} (${turnCount} turnos)...`);

    this._closePromise = this._updater.processSession(sessionId, history, turnCount)
      .then(result => {
        console.log(`[session] memoria guardada: ${result.saved} nodos`);
      })
      .catch(err => {
        console.error('[session] error:', err.message);
        try { this._graph.endSession(sessionId, { turnCount, summary: null }); } catch(_) {}
      })
      .finally(() => { this._isClosing = false; });

    return this._closePromise;
  }

  _maybeRunDecay(app) {
    try {
      const fs   = require('fs');
      const path = require('path');
      const marker = app ? path.join(app.getPath('userData'), 'march_decay_marker.json') : null;
      if (!marker) { this._updater.runDecay(); return; }
      let lastRun = 0;
      if (fs.existsSync(marker)) {
        try { lastRun = JSON.parse(fs.readFileSync(marker, 'utf-8')).ts || 0; } catch(_) {}
      }
      const hoursSince = (Date.now() - lastRun) / (1000 * 60 * 60);
      if (hoursSince >= DECAY_INTERVAL_HOURS) {
        console.log('[session] corriendo decay diario...');
        this._updater.runDecay();
        fs.writeFileSync(marker, JSON.stringify({ ts: Date.now() }), 'utf-8');
      }
    } catch(e) { console.warn('[session] error decay:', e.message); }
  }

  getStats() {
    return {
      session:    this._sessionId,
      turns:      this._turnCount,
      historyLen: this._history.length,
      graph:      this._graph.getStats(),
    };
  }
}

module.exports = { SessionManager };
