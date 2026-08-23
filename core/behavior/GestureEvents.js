// @ts-check
'use strict';

/**
 * GestureEvents.js — dispatcher INDEPENDIENTE de gestos para main.js.
 *
 * Traduce eventos del sistema (generación, tareas agénticas, proactividad,
 * errores LSP, resultados de propuestas) a moods del GestureEngine y los
 * difunde a TODAS las ventanas vivas (overlay + chat) para que Kaoru se
 * sienta viva en ambas UIs sin lógica duplicada en cada punto de emisión.
 *
 * Uso (main.js):
 *   const gestureEvents = new GestureEvents({
 *     send: (mood, meta) => { sendOverlayGesture(mood, meta); sendToChat('gesture', { mood, ...meta }); },
 *   });
 *   gestureEvents.emit('generation-start');
 *   gestureEvents.emit('task-result', { ok: true });
 */

/** Mapa evento → mood base. */
const EVENT_MOODS = {
  // Generación de respuestas
  'generation-start': 'think',
  'generation-token': null, // demasiado frecuente: no gesticular por chunk
  'generation-end': null, // el mood lo decide la emoción del texto (passthrough)

  // Tareas agénticas
  'task-start': 'think',
  'task-progress': 'think',
  'task-success': 'happy',
  'task-fail': 'sad',

  // Proactividad
  proactive: 'excited',
  'lsp-error': 'surprised',
  'proposal-accepted': 'happy',
  'proposal-rejected': 'sad',

  // Sistema
  'workspace-changed': 'think',
  'model-loaded': 'happy',
};

// Dedupe de claves literales (el objeto arriba tiene un duplicado histórico).
const MOOD_FOR_EVENT = {};
for (const [k, v] of Object.entries(EVENT_MOODS)) {
  if (!(k in MOOD_FOR_EVENT)) MOOD_FOR_EVENT[k] = v;
}

/** Moods válidos según GestureLexicon (subconjunto seguro para eventos). */
const SAFE_MOODS = new Set([
  'happy', 'excited', 'sad', 'angry', 'surprised', 'shy',
  'tired', 'think', 'gentle', 'default', 'panic', 'nod', 'wave',
]);

class GestureEvents {
  /**
   * @param {object} opts
   * @param {(mood: string, meta?: object) => void} opts.send - difusor a las UIs
   */
  constructor({ send } = {}) {
    this._send = typeof send === 'function' ? send : () => {};
    /** @type {string|null} último mood emitido (para anti-spam básico) */
    this._last = null;
    this._lastAt = 0;
    this._minGapMs = 1500;
  }

  /**
   * Emite un evento → mood correspondiente → broadcast a las UIs.
   * @param {string} event
   * @param {{ emotion?: string, ok?: boolean, status?: string, [k: string]: any }} [meta]
   */
  emit(event, meta = {}) {
    let mood = MOOD_FOR_EVENT[event] ?? null;

    // Refinamientos por payload.
    if (event === 'agent-progress') {
      mood = meta.status === 'ok' ? 'happy' : meta.status === 'failed' ? 'sad' : 'think';
    }
    if (event === 'task-result') {
      mood = meta.ok ? 'happy' : 'sad';
    }
    // Emoción explícita del mensaje generado (passthrough si es segura).
    if (event === 'response-emotion' && SAFE_MOODS.has(meta.emotion)) {
      mood = meta.emotion;
    }

    if (!mood || !SAFE_MOODS.has(mood)) return null;

    const now = Date.now();
    if (mood === this._last && now - this._lastAt < this._minGapMs) return null; // anti-spam
    this._last = mood;
    this._lastAt = now;

    try {
      this._send(mood, { source: event, ...meta });
    } catch {}
    return mood;
  }
}

module.exports = { GestureEvents, MOOD_FOR_EVENT, SAFE_MOODS };
