// @ts-nocheck
/**
 * BaseOSSensor.js — base común de los sensores de SO (Windows y Linux).
 *
 * Centraliza el ciclo de vida y el tracking de actividad que comparten
 * OSSensor (PowerShell, Windows) y LinuxOSSensor (Hyprland/Wayland):
 *
 *   - start()/stop(): arranque/detención del poll cada `_pollMs`.
 *   - getCurrentContext()/getOpenWindows()/getOpenWindowsSummary()/
 *     getTodayHistory()/getTodaySummary(): el contrato público que el
 *     GroundingEngine serializa para el system prompt.
 *   - _processFocus()/_processIdle()/_pauseTracking(): el motor de tracking
 *     de tiempo por app (historial diario, eventos os:app-changed/tick,
 *     os:idle-changed).
 *
 * Cada plataforma implementa SOLO lo que es específico:
 *   - `_poll()`: cómo leer la ventana en foco y las ventanas abiertas.
 *   - `_saveToHistory()`: qué se persiste del segmento de actividad.
 *   - Helpers de nombres/categorías/formato (`_getFriendlyName`,
 *     `_getCategory`, `_formatElapsed`).
 *
 * Inyectable para tests; nunca lanza: un poll que falla solo se loggea.
 */

'use strict';
const logger = require('../../core/observability/Logger.js');

const { getEventBus } = require('../event-bus/EventBus.js');

const IDLE_THRESHOLD_SECS = 120;

class BaseOSSensor {
  constructor(stateGraph, { logTag = 'os-sensor', pollMs = 5000 } = {}) {
    this._graph = stateGraph;
    this._bus = getEventBus();
    this._logTag = logTag;
    this._polling = null;
    this._pollBusy = false;
    this._pollMs = pollMs;
    this._currentApp = null;
    this._currentTitle = null;
    this._appStart = null;
    this._openWindows = [];
    this._history = [];
    this._maxHistory = 100;
    this._running = false;
    this._idleSecs = 0;
    this._wasIdle = false;
  }

  start() {
    if (this._running) return;
    this._running = true;
    logger.info(
      'BaseOSSensor',
      `[${this._logTag}] iniciado (poll cada ${Math.round(this._pollMs / 1000)}s)`
    );
    this._poll();
    this._polling = setInterval(() => this._poll(), this._pollMs);
  }

  stop() {
    if (this._polling) {
      clearInterval(this._polling);
      this._polling = null;
    }
    this._running = false;
    logger.info('BaseOSSensor', `[${this._logTag}] detenido`);
  }

  getCurrentContext() {
    const elapsed = this._appStart ? Math.round((Date.now() - this._appStart) / 1000) : 0;
    return {
      app: this._currentApp,
      friendlyName: this._getFriendlyName(this._currentApp),
      title: this._currentTitle,
      category: this._getCategory(this._currentApp),
      elapsed,
      elapsedFormatted: this._formatElapsed(elapsed),
      idleSecs: this._idleSecs,
      idleFormatted: this._idleSecs > 0 ? this._formatElapsed(this._idleSecs) : null,
      isIdle: this._idleSecs >= IDLE_THRESHOLD_SECS,
      openWindows: this.getOpenWindows(),
      openWindowsSummary: this.getOpenWindowsSummary(),
      history: this.getTodayHistory(),
    };
  }

  getOpenWindows() {
    return this._openWindows.map((w) => ({
      ...w,
      focused: w.app === this._currentApp && w.title === this._currentTitle,
    }));
  }

  getTodayHistory() {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    return this._history.filter((e) => e.start >= startOfDay.getTime());
  }

  getTodaySummary() {
    const today = this.getTodayHistory();
    if (!today.length) return null;
    const byApp = {};
    for (const entry of today) {
      const key = entry.friendlyName || entry.app;
      byApp[key] = (byApp[key] || 0) + (entry.duration || 0);
    }
    return Object.entries(byApp)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 8)
      .map(([app, secs]) => `${app} (${this._formatElapsed(secs)})`)
      .join(', ');
  }

  _processFocus(app, title) {
    const elapsed = this._appStart ? Math.round((Date.now() - this._appStart) / 1000) : 0;

    if (app !== this._currentApp) {
      if (this._currentApp && this._appStart) {
        this._saveToHistory(this._currentApp, this._currentTitle, this._appStart, Date.now());
      }
      const prev = this._currentApp;
      this._currentApp = app;
      this._currentTitle = title;
      this._appStart = Date.now();
      this._bus.emit('os:app-changed', {
        app,
        friendlyName: this._getFriendlyName(app),
        title,
        category: this._getCategory(app),
        elapsed: 0,
        prev,
        prevFriendly: this._getFriendlyName(prev),
      });
      logger.info(
        'BaseOSSensor',
        `[${this._logTag}] → ${this._getFriendlyName(app)} — "${title.slice(0, 60)}"`
      );
    } else {
      this._currentTitle = title;
      this._bus.emit('os:app-tick', {
        app,
        friendlyName: this._getFriendlyName(app),
        title,
        category: this._getCategory(app),
        elapsed,
        elapsedFormatted: this._formatElapsed(elapsed),
      });
    }
  }

  _processIdle(idleSecs) {
    this._idleSecs = idleSecs;
    const isIdle = idleSecs >= IDLE_THRESHOLD_SECS;
    if (isIdle && !this._wasIdle) {
      this._wasIdle = true;
      this._bus.emit('os:idle-changed', { idle: true, idleSecs });
      logger.info(
        'BaseOSSensor',
        `[${this._logTag}] usuario idle (${this._formatElapsed(idleSecs)})`
      );
    } else if (!isIdle && this._wasIdle) {
      this._wasIdle = false;
      this._bus.emit('os:idle-changed', { idle: false, idleSecs: 0 });
      logger.info('BaseOSSensor', `[${this._logTag}] usuario activo de nuevo`);
    }
  }

  /**
   * FIX tracking: el foco cayó en una app ignorada (Explorer, diálogo de
   * sistema, etc.). Guarda de inmediato el historial de la app anterior
   * con el tiempo correcto hasta ESTE momento, y resetea el estado para
   * que cuando el foco vuelva a una app real, _processFocus lo trate
   * como un inicio nuevo (en vez de seguir sumando tiempo a la app vieja
   * mientras el usuario estuvo en una ventana ignorada).
   */
  _pauseTracking() {
    if (this._currentApp && this._appStart) {
      this._saveToHistory(this._currentApp, this._currentTitle, this._appStart, Date.now());
    }
    if (this._currentApp !== null) {
      logger.info('BaseOSSensor', `[${this._logTag}] foco en app ignorada — pausando tracking`);
    }
    this._currentApp = null;
    this._currentTitle = null;
    this._appStart = null;
  }

  // ── Helpers específicos de plataforma (implementan las subclases) ─────────

  _getFriendlyName(procName) {
    return procName;
  }

  _getCategory(_procName) {
    return 'other';
  }

  _formatElapsed(seconds) {
    return `${seconds || 0}s`;
  }

  /** Lee la ventana en foco / ventanas abiertas — implementa la subclase. */
  _poll() {}
}

module.exports = { BaseOSSensor, IDLE_THRESHOLD_SECS };
