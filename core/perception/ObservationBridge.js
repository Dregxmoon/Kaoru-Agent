// @ts-check
'use strict';

const crypto = require('crypto');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** @param {unknown} value @returns {string} */
function clean(value) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** @param {string} event @param {object} payload @returns {string} */
function dedupe(event, payload) {
  const bucket = Math.floor(Date.now() / (5 * 60 * 1000));
  const hash = crypto
    .createHash('sha256')
    .update(`${event}:${JSON.stringify(payload)}:${bucket}`)
    .digest('hex')
    .slice(0, 24);
  return `sensor:${event}:${hash}`;
}

class ObservationBridge {
  /**
   * @param {{bus:{on:(event:string, handler:(payload:any)=>void)=>()=>void}, graph:{recordObservation?:(opts:object)=>number|null}}} deps
   */
  constructor({ bus, graph }) {
    this._bus = bus;
    this._graph = graph;
    /** @type {Array<()=>void>} */
    this._unsubs = [];
  }

  start() {
    if (this._unsubs.length) return this;
    this._listen('os:app-changed', 'os', 'app_changed', 30 * DAY_MS, (p) => ({
      content: `Aplicación activa: ${clean(p.friendlyName || p.app)}`,
      metadata: {
        app: clean(p.app),
        friendlyName: clean(p.friendlyName),
        category: clean(p.category),
        // Títulos solo se conservan para categorías de trabajo.
        title: ['code', 'terminal', 'docs', 'design'].includes(p.category) ? clean(p.title) : '',
      },
    }));
    this._listen('os:idle-changed', 'os', 'idle_changed', 7 * DAY_MS, (p) => ({
      content: p.idle ? 'El usuario quedó inactivo' : 'El usuario volvió al equipo',
      metadata: { idle: !!p.idle, idleSecs: Number(p.idleSecs) || 0 },
    }));
    this._listen('git:branch-changed', 'git', 'branch_changed', 90 * DAY_MS, (p) => ({
      content: `Cambio de rama: ${clean(p.prev)} → ${clean(p.branch)}`,
      metadata: { previous: clean(p.prev), branch: clean(p.branch) },
    }));
    this._listen('git:redflag', 'git', 'warning', 90 * DAY_MS, (p) => ({
      content: clean(p.message).slice(0, 500),
      metadata: { kind: clean(p.kind), branch: clean(p.branch), file: clean(p.file) },
    }));
    this._listen('system:warning', 'system', 'warning', 30 * DAY_MS, (p) => ({
      content: clean(p.message).slice(0, 500),
      metadata: { kind: clean(p.kind) },
    }));
    this._listen('os:error-title', 'os', 'error_title', 7 * DAY_MS, (p) => ({
      content: clean(p.title).slice(0, 300),
      metadata: { app: clean(p.app), category: clean(p.category) },
    }));
    this._listen('clipboard:copied', 'clipboard', 'copied_context', HOUR_MS, (p) => ({
      content: clean(p.snippet).slice(0, 500),
      metadata: { kind: clean(p.kind) },
      sensitivity: 'sensitive',
    }));
    this._listen('memory:upcoming-event', 'calendar', 'upcoming_event', 180 * DAY_MS, (p) => ({
      content: clean(p.content).slice(0, 1000),
      metadata: { when: Number(p.when) || null },
    }));
    this._listen('lsp:error', 'lsp', 'diagnostic', 30 * DAY_MS, (p) => {
      const first = Array.isArray(p.errors) ? p.errors[0] : null;
      return {
        content: `${clean(p.file)}: ${clean(first?.message).slice(0, 500)}`,
        metadata: {
          file: clean(p.file),
          count: Number(p.count) || (Array.isArray(p.errors) ? p.errors.length : 0),
          line: Number(first?.line) || 0,
          languageId: clean(p.languageId),
          focused: !!p.focused,
        },
      };
    });
    return this;
  }

  /**
   * @param {string} event
   * @param {string} source
   * @param {string} kind
   * @param {number} ttlMs
   * @param {(payload:any)=>{content:string,metadata:object,sensitivity?:string}} normalize
   */
  _listen(event, source, kind, ttlMs, normalize) {
    const unsubscribe = this._bus.on(event, (payload = {}) => {
      const normalized = normalize(payload);
      if (!normalized.content) return;
      this._graph.recordObservation?.({
        source,
        kind,
        content: normalized.content,
        metadata: normalized.metadata,
        sensitivity: normalized.sensitivity || 'private',
        ttlMs,
        dedupeKey: dedupe(event, normalized),
      });
    });
    this._unsubs.push(unsubscribe);
  }

  stop() {
    for (const unsubscribe of this._unsubs.splice(0)) unsubscribe();
  }
}

module.exports = { ObservationBridge };
