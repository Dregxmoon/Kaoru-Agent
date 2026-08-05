/**
 * ClipboardWatcher.js — detecta contenido de alto valor copiado al
 * portapapeles (un stacktrace de error o una URL) y emite:
 *
 *   clipboard:copied → { kind: 'stacktrace' | 'url', snippet }
 *
 * Es una señal opt-in (config sensors.clipboard = true): lee el portapapeles
 * del sistema y eso toca la privacidad. Por eso:
 *   - Solo se clasifica contenido de alto valor; el resto del texto copiado
 *     (contraseñas, textos personales) se ignora por completo y ni se mira.
 *   - Solo se emite cuando el contenido CAMBIA respecto al último.
 *
 * El reader es inyectable para tests; el default usa el módulo `clipboard` de
 * Electron, cargado de forma perezosa y aislado en try/catch (en modos donde
 * no está disponible, el watcher simplemente no emite nada).
 */

'use strict';

const { getEventBus } = require('../../infrastructure/event-bus/EventBus.js');

const DEFAULT_POLL_MS = 5 * 1000;
const MAX_SNIPPET     = 200;

const STACKTRACE_RE = /(\bError|Exception|Traceback|fatal:|panic:)\b|at\s+[\w.$<>[\],?]+\s+\(.+:\d+:\d+\)/i;
const URL_RE        = /^https?:\/\/|^www\./i;

function _defaultReader() {
  try {
    const { clipboard } = require('electron');
    return clipboard ? clipboard.readText() : '';
  } catch(_) {
    return '';
  }
}

class ClipboardWatcher {
  constructor({ pollMs = DEFAULT_POLL_MS, reader = _defaultReader, bus = getEventBus() } = {}) {
    this._bus    = bus;
    this._pollMs = pollMs;
    this._reader = reader;
    this._timer  = null;
    this._running = false;
    this._last   = null;
    this._count  = 0;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._tick();
    this._timer = setInterval(() => this._tick(), this._pollMs);
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._running = false;
  }

  _tick() {
    let text;
    try {
      text = String(this._reader() || '').trim();
    } catch(_) {
      return;
    }
    if (!text || text === this._last) return;
    this._last = text;

    const kind = this._classify(text);
    if (!kind) return;

    this._count++;
    this._bus.emit('clipboard:copied', {
      kind,
      snippet: text.slice(0, MAX_SNIPPET),
    });
  }

  _classify(text) {
    if (STACKTRACE_RE.test(text)) return 'stacktrace';
    if (URL_RE.test(text)) return 'url';
    return null;
  }

  getStats() {
    return { running: this._running, emitted: this._count, lastKind: this._classify(this._last || '') };
  }
}

module.exports = { ClipboardWatcher, MAX_SNIPPET };
