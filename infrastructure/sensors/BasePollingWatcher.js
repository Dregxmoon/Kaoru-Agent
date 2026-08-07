// @ts-nocheck
/**
 * BasePollingWatcher.js — base común para los watchers de polling
 * (GitWatcher, SystemWatcher, ClipboardWatcher, UpcomingEventsWatcher,
 * LSPErrorWatcher).
 *
 * Centraliza el ciclo de vida idéntico de todos ellos:
 *   - `start()`: arranca un poll inmediato + intervalo cada `pollMs`.
 *   - `stop()`: detiene el intervalo.
 *   - `poll()`: guard contra solapamiento (`_polling`), aisla errores en
 *     `_lastError` (DEBUG loggea) y delega en `_scan(...)`.
 *
 * Las subclases solo implementan `_scan(...)` — el scan real — y exponen su
 * propio `getStats()` si quieren añadir campos. Nunca lanza: un scan que
 * falla se loggea y se reintenta en el próximo poll.
 */

'use strict';
const logger = require('../../core/observability/Logger.js');

const { getEventBus } = require('../../infrastructure/event-bus/EventBus.js');

class BasePollingWatcher {
  constructor({ pollMs, bus = getEventBus() } = {}) {
    this._bus = bus;
    this._pollMs = pollMs;
    this._timer = null;
    this._running = false;
    this._polling = false;
    this._lastError = null;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this.poll().catch(() => {});
    this._timer = setInterval(() => this.poll().catch(() => {}), this._pollMs);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._running = false;
  }

  async poll(...args) {
    if (this._polling) return;
    this._polling = true;
    try {
      await this._scan(...args);
    } catch (e) {
      this._lastError = e.message;
      if (process.env.DEBUG)
        logger.warn('BasePollingWatcher', `[${this.constructor.name.toLowerCase()}]`, e.message);
    } finally {
      this._polling = false;
    }
  }

  /** Scan real — lo implementa cada subclase. */
  async _scan() {}
}

module.exports = { BasePollingWatcher };
