/**
 * TitleWatcher.js — observa los títulos de las ventanas activas (eventos
 * os:app-tick / os:app-changed del OSSensor) y emite una señal cuando el
 * título parece mostrar un error:
 *
 *   os:error-title  → { app, category, title, match }
 *
 * Es un complemento barato del "terminal parse": no leemos la salida del
 * terminal (no somos dueños del PTY), pero muchos shells/IDEs ponen el error
 * o el comando fallido en el título de la ventana, y eso es suficiente para
 * que el LLM decida si ofrece ayuda.
 *
 * Deduplicación: se emite una vez por título de error distinto; si el título
 * vuelve a la normalidad y luego reaparece el error, se emite de nuevo.
 * No tiene poll propio — es 100% reactivo a los eventos del OSSensor.
 */

'use strict';

const { getEventBus } = require('../../infrastructure/event-bus/EventBus.js');

const ERROR_TITLE_PATTERNS = [
  /\berror\b/i,
  /\bfail(?:ed|ure)?\b/i,
  /\bexception\b/i,
  /\btraceback\b/i,
  /\bpanic\b/i,
  /syntax\s+error/i,
  /cannot\s+find\s+(module|file)/i,
  /undefined\s+is\s+not\s+(a\s+)?function/i,
  /exit\s+code/i,
  /\bfatal\b/i,
  /\bkilled\b/i,
  /\bsevere\b/i,
  /\b✗\b/,
  /\[fail\]/i,
  /process\s+did\s+not\s+exit/i,
];

class TitleWatcher {
  constructor({ bus = getEventBus() } = {}) {
    this._bus = bus;
    this._lastKey = null;
    this._count = 0;
    this._setupListeners();
  }

  _setupListeners() {
    this._boundOnTick = (p) => this._check(p);
    this._boundOnChanged = (p) => this._check(p);
    this._bus.on('os:app-tick', this._boundOnTick);
    this._bus.on('os:app-changed', this._boundOnChanged);
  }

  start() {}

  stop() {
    this._bus.off('os:app-tick', this._boundOnTick);
    this._bus.off('os:app-changed', this._boundOnChanged);
  }

  _check({ app, category, title } = {}) {
    if (!title) return;
    const match = ERROR_TITLE_PATTERNS.find(p => p.test(title));
    if (!match) { this._lastKey = null; return; }

    const key = `${app || ''}|${title}`;
    if (key === this._lastKey) return; // mismo error en el mismo título → dedup
    this._lastKey = key;
    this._count++;
    this._bus.emit('os:error-title', { app: app || null, category: category || null, title, match: String(match) });
  }

  getStats() {
    return { emitted: this._count, lastKey: this._lastKey };
  }
}

module.exports = { TitleWatcher, ERROR_TITLE_PATTERNS };
