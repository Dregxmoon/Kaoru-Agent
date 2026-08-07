// @ts-nocheck
/**
 * UpcomingEventsWatcher.js — vigila los recordatorios que el usuario pidió
 * guardar ("recuerda que tengo reunión a las 5" → nodo recordar_* en memoria)
 * y emite una señal cuando están cerca de cumplirse:
 *
 *   memory:upcoming-event → { nodeId, content, when, kind }
 *
 * Parsing acotado a lo que la memoria instantánea puede almacenar:
 *   - "en N minutos/horas"            → relativo a ahora
 *   - "a las HH(:MM) [am|pm]"         → hoy a esa hora
 *   - "el D de MES" (+ hora opcional) → ese día (el próximo si ya pasó)
 *   - "mañana" / "hoy"                → ese día
 *
 * kind:
 *   - 'time_event' → momento exacto; se emite cuando faltan ≤ LOOKAHEAD_MS y
 *                    nunca se repite para el mismo momento.
 *   - 'day_event'  → todo el día; se emite una vez por día calendario.
 *
 * Diseño: silencio si la memoria no está lista o no hay nodos recordar_*;
 * nunca lanza. `poll(now)` acepta un `now` inyectado para tests deterministas.
 */

'use strict';

const { getEventBus } = require('../../infrastructure/event-bus/EventBus.js');
const { BasePollingWatcher } = require('./BasePollingWatcher.js');

const LOOKAHEAD_MS = 45 * 60 * 1000;
const DEFAULT_POLL_MS = 5 * 60 * 1000;

const MONTHS = {
  enero: 0,
  febrero: 1,
  marzo: 2,
  abril: 3,
  mayo: 4,
  junio: 5,
  julio: 6,
  agosto: 7,
  septiembre: 8,
  octubre: 9,
  noviembre: 10,
  diciembre: 11,
};

function _parseEventTime(content, now) {
  const text = String(content || '')
    .replace(/^pidió recordar:\s*/i, '')
    .trim();
  if (!text) return null;
  const nowDate = new Date(now);

  // "en N minutos / N horas"
  let m = text.match(/\ben\s+(\d{1,3})\s+(min(?:uto)?s?|hora(?:s)?)\b/i);
  if (m) {
    const unitMs = /^h/.test(m[2]) ? 3600 * 1000 : 60 * 1000;
    return { ts: now + parseInt(m[1], 10) * unitMs, kind: 'time_event' };
  }

  // "a las HH(:MM) am/pm"
  let time = null;
  m = text.match(/a las\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (m) {
    let hour = parseInt(m[1], 10);
    const minute = parseInt(m[2] || '0', 10);
    const ampm = (m[3] || '').toLowerCase();
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    time = { hour, minute, ampm };
  }

  // día: "el D de MES" | "mañana" | "hoy"
  let day = null;
  m = text.match(
    /(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/i
  );
  if (m) {
    const month = MONTHS[m[2].toLowerCase()];
    const d = parseInt(m[1], 10);
    const todayStart = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate());
    let dt = new Date(nowDate.getFullYear(), month, d);
    // Solo se rota al año siguiente si el día YA PASÓ (comparando días, no
    // timestamps: "el 15 de junio" el mismo 15 de junio debe quedarse en el
    // presente aunque ya hayan pasado las 00:00).
    if (dt.getTime() < todayStart.getTime()) dt = new Date(nowDate.getFullYear() + 1, month, d);
    day = dt;
  } else if (/\bmañana\b|\btomorrow\b/i.test(text)) {
    day = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() + 1);
  } else if (/\bhoy\b|\bnow\b/i.test(text)) {
    day = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate());
  }

  if (time && day) {
    return { ts: _buildTimeTs(now, day, time), kind: 'time_event' };
  }
  if (time) {
    return { ts: _buildTimeTs(now, null, time), kind: 'time_event' };
  }
  if (day) {
    return { ts: day.getTime(), kind: 'day_event' };
  }
  return null;
}

/**
 * Resuelve el timestamp de una hora del día. Heurística de ambigüedad:
 * "a las 5" sin am/pm, si las 05:00 ya pasaron, casi seguro quiso decir
 * 17:00 — se suma 12h. Con am/pm explícito no se toca.
 */
function _buildTimeTs(now, day, time) {
  const base =
    day || new Date(new Date(now).getFullYear(), new Date(now).getMonth(), new Date(now).getDate());
  let ts = new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate(),
    time.hour,
    time.minute
  ).getTime();
  if (!time.ampm && time.hour < 12 && ts < now) {
    ts = new Date(
      base.getFullYear(),
      base.getMonth(),
      base.getDate(),
      time.hour + 12,
      time.minute
    ).getTime();
  }
  return ts;
}

function _localDayString(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

class UpcomingEventsWatcher extends BasePollingWatcher {
  constructor({ graph, pollMs = DEFAULT_POLL_MS, bus = getEventBus() } = {}) {
    super({ pollMs, bus });
    this._graph = graph;
    this._emittedTime = {}; // nodeId → ts ya anunciado
    this._emittedDay = {}; // nodeId → día calendario ya anunciado
  }

  async _scan(now = Date.now()) {
    if (!this._graph?.isReady && !this._graph?._ready) return;
    let nodes = [];
    try {
      nodes = this._graph.queryNodes({ type: 'Belief' }) || [];
    } catch (_) {
      return;
    }

    for (const node of nodes) {
      const label = String(node.label || '');
      if (!label.startsWith('recordar_')) continue;

      const parsed = _parseEventTime(node.content, now);
      if (!parsed) continue;

      if (parsed.kind === 'time_event') {
        if (parsed.ts < now) {
          delete this._emittedTime[node.id];
          continue;
        }
        if (parsed.ts - now > LOOKAHEAD_MS) continue;
        if (this._emittedTime[node.id] === parsed.ts) continue;
        this._emittedTime[node.id] = parsed.ts;
        this._bus.emit('memory:upcoming-event', {
          nodeId: node.id,
          content: node.content,
          when: parsed.ts,
          kind: 'time_event',
        });
      } else {
        // day_event: solo el día calendario del evento (no "cualquier día").
        const eventDay = _localDayString(parsed.ts);
        const todayStr = _localDayString(now);
        if (eventDay !== todayStr) continue;
        if (this._emittedDay[node.id] === todayStr) continue;
        this._emittedDay[node.id] = todayStr;
        this._bus.emit('memory:upcoming-event', {
          nodeId: node.id,
          content: node.content,
          when: parsed.ts,
          kind: 'day_event',
        });
      }
    }
  }

  getStats() {
    return {
      running: this._running,
      emittedTime: Object.keys(this._emittedTime).length,
      emittedDays: Object.keys(this._emittedDay).length,
    };
  }
}

module.exports = { UpcomingEventsWatcher, _parseEventTime, LOOKAHEAD_MS };
