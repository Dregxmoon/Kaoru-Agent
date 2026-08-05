/**
 * EventBus.js — Fase 2
 *
 * Pub/sub interno tipado. Es la ÚNICA vía de comunicación entre componentes.
 * Ningún módulo importa directamente a otro — todo pasa por aquí.
 *
 * Eventos definidos:
 *   os:app-changed     — { app, title, elapsed, prev }
 *   os:app-tick        — { app, title, elapsed } (cada 5s si la app no cambió)
 *   os:history-updated — { history }
 *   memory:turn-added  — { role, content, sessionId }
 *   memory:node-saved  — { nodeId, label, type }
 *   initiative:trigger — { reason, app, suggestion, actionType }
 *   initiative:dismiss — { reason }
 *   session:started    — { sessionId }
 *   session:closed     — { sessionId, turnCount }
 */

class EventBus {
  constructor() {
    this._listeners = new Map();
    this._log = [];
    this._maxLog = 200;
  }

  /**
   * Suscribirse a un evento.
   * @param {string}   event   — nombre del evento
   * @param {Function} handler — callback(payload)
   * @returns {Function} unsub — llama para cancelar la suscripción
   */
  on(event, handler) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(handler);

    // Devuelve función para cancelar
    return () => this.off(event, handler);
  }

  /** Suscripción de una sola vez. */
  once(event, handler) {
    const wrapper = (payload) => {
      handler(payload);
      this.off(event, wrapper);
    };
    return this.on(event, wrapper);
  }

  /** Cancelar suscripción. */
  off(event, handler) {
    this._listeners.get(event)?.delete(handler);
  }

  /**
   * Emitir un evento.
   * @param {string} event
   * @param {object} payload
   */
  emit(event, payload = {}) {
    const entry = { event, payload, ts: Date.now() };

    // Log circular (para debug)
    this._log.push(entry);
    if (this._log.length > this._maxLog) this._log.shift();

    // Notificar listeners
    const handlers = this._listeners.get(event);
    if (!handlers || handlers.size === 0) return;

    for (const handler of handlers) {
      try {
        handler(payload);
      } catch (e) {
        console.error(`[event-bus] error en handler de '${event}':`, e.message);
      }
    }
  }

  /** Últimos N eventos emitidos (para debug). */
  getLog(n = 20) {
    return this._log.slice(-n);
  }

  /** Lista todos los eventos con listeners activos. */
  getActiveEvents() {
    const result = {};
    for (const [event, handlers] of this._listeners) {
      if (handlers.size > 0) result[event] = handlers.size;
    }
    return result;
  }
}

// Singleton global — un solo bus por proceso
let _instance = null;

function getEventBus() {
  if (!_instance) _instance = new EventBus();
  return _instance;
}

module.exports = { EventBus, getEventBus };
