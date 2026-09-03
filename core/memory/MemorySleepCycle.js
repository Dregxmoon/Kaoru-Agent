// @ts-check
'use strict';

const logger = require('../observability/Logger.js');

const DEFAULT_IDLE_SECONDS = 5 * 60;
const DEFAULT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

class MemorySleepCycle {
  /**
   * @param {{bus:{on:(event:string,handler:(payload:any)=>void)=>()=>void}, graph:{runCausalConsolidation?:(opts?:object)=>object,runConsolidation?:(opts?:object)=>object,runAutobiographicalMaintenance?:(limit?:number)=>object}}} deps
   * @param {{idleSeconds?:number,cooldownMs?:number}} [opts]
   */
  constructor({ bus, graph }, opts = {}) {
    this._bus = bus;
    this._graph = graph;
    this._idleSeconds = opts.idleSeconds ?? DEFAULT_IDLE_SECONDS;
    this._cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this._lastRun = 0;
    this._running = false;
    this._scheduled = false;
    /** @type {ReturnType<typeof setTimeout>|null} */
    this._timer = null;
    /** @type {null|(()=>void)} */
    this._unsubscribe = null;
  }

  start() {
    if (this._unsubscribe) return this;
    this._unsubscribe = this._bus.on('os:idle-changed', (payload = {}) => {
      if (!payload.idle || Number(payload.idleSecs) < this._idleSeconds) return;
      this.schedule('idle');
    });
    return this;
  }

  /** @param {string} [reason] */
  schedule(reason = 'manual') {
    if (this._running || this._scheduled || Date.now() - this._lastRun < this._cooldownMs) {
      return false;
    }
    this._scheduled = true;
    this._timer = setTimeout(() => {
      this._timer = null;
      this._scheduled = false;
      this.run(reason);
    }, 0);
    if (typeof this._timer.unref === 'function') this._timer.unref();
    return true;
  }

  /** @param {string} [reason] */
  run(reason = 'manual') {
    if (this._running) return { skipped: true, reason: 'already_running' };
    this._running = true;
    try {
      // Ambos motores son deterministas y trabajan con límites acotados. No
      // llaman al LLM, no ejecutan tools y no modifican permisos.
      const semantic = this._graph.runConsolidation?.({ limit: 50 }) || null;
      const causal =
        this._graph.runCausalConsolidation?.({ minAgeMs: 60 * 60 * 1000, limit: 500 }) || null;
      const autobiographical = this._graph.runAutobiographicalMaintenance?.(100) || null;
      this._lastRun = Date.now();
      logger.info('MemorySleepCycle', `[memory-sleep] consolidación completada (${reason})`);
      return { skipped: false, reason, semantic, causal, autobiographical };
    } catch (e) {
      logger.warn(
        'MemorySleepCycle',
        `[memory-sleep] consolidación falló: ${e instanceof Error ? e.message : String(e)}`
      );
      return { skipped: false, reason, error: e instanceof Error ? e.message : String(e) };
    } finally {
      this._running = false;
    }
  }

  stop() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    this._scheduled = false;
    this._unsubscribe?.();
    this._unsubscribe = null;
  }
}

module.exports = { MemorySleepCycle, DEFAULT_IDLE_SECONDS, DEFAULT_COOLDOWN_MS };
