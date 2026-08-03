'use strict';

// ── Cola de requests por provider (Fase J) ──────────────────────────────────
// Los tiers gratis (Groq, etc.) tienen TPM/TPD agresivos: si varias llamadas
// LLM se disparan a la vez (ProactiveEngine + AgentLoop, o el benchmark con
// varias corridas), todas chocan contra el rate-limit y queman reintentos.
//
// ProviderQueue serializa las llamadas por provider y, cuando un 429 dice
// "espera X", pone al provider en cooldown: los requests siguientes esperan
// en cola hasta que pase (en vez de dispararse y fallar en cadena).
//
// - concurrency: cuántas llamadas simultáneas por provider (1 = serial).
// - priority: mayor número sale antes entre los que esperan.
// - maxWaitMs: presupuesto de espera por request (0/-1 = esperar lo que sea;
//   por defecto 30s → si el cooldown es más largo, el request se rechaza con
//   el error de rate-limit y el caller hace fallback a otro provider).

function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const RETRY_INTERVAL_RE = /(?:try again|retry) in (\d+(?:\.\d+)?)m(\d+(?:\.\d+)?)?s/i;
const RETRY_SECONDS_RE  = /(?:try again|retry) in (\d+(?:\.\d+)?)s/i;

/** Parsea "Please try again in 3m20.5s" / "in 12s" (patrón Groq/OpenAI). */
function parseRetryAfterMs(message = '') {
  const both = message.match(RETRY_INTERVAL_RE);
  if (both) return Math.ceil((parseFloat(both[1]) * 60 + (parseFloat(both[2]) || 0)) * 1000);
  const secs = message.match(RETRY_SECONDS_RE);
  return secs ? Math.ceil(parseFloat(secs[1]) * 1000) : 0;
}

class ProviderQueue {
  constructor(opts = {}) {
    this._concurrency = Math.max(1, opts.concurrency ?? 1);
    this._queue = [];          // { id, priority, run, resolve, reject, maxWaitMs, enqueuedAt }
    this._active = 0;
    this._cooldownUntil = 0;   // timestamp: nadie corre hasta que pase
    this._lastRateLimitError = null;
    this._drainTimer = null;
    this._seq = 0;
    this._disabled = false;
    this._stats = {
      total: 0, completed: 0, failed: 0,
      rateLimited: 0, totalWaitMs: 0, execMs: 0,
    };
  }

  get stats() {
    return { ...this._stats, pending: this._queue.length + this._active };
  }

  get cooldownRemainingMs() {
    return Math.max(0, this._cooldownUntil - Date.now());
  }

  enable() {
    this._disabled = false;
    this._drain();
  }

  disable() {
    this._disabled = true;
    this._clearDrainTimer();
  }

  submit(run, { priority = 0, maxWaitMs = 30000 } = {}) {
    return new Promise((resolve, reject) => {
      this._queue.push({ id: ++this._seq, priority, run, resolve, reject, maxWaitMs, enqueuedAt: Date.now() });
      this._reorder();
      this._drain();
    });
  }

  _reorder() {
    this._queue.sort((a, b) => b.priority - a.priority || a.enqueuedAt - b.enqueuedAt);
  }

  _clearDrainTimer() {
    if (this._drainTimer) {
      clearTimeout(this._drainTimer);
      this._drainTimer = null;
    }
  }

  _drain() {
    this._clearDrainTimer();
    if (this._disabled) return;

    while (this._active < this._concurrency && this._queue.length > 0) {
      const cooldownLeft = this._cooldownUntil - Date.now();

      if (cooldownLeft > 0) {
        // Primer request en cola: si el cooldown lo haría exceder su presupuesto,
        // se rechaza ya (el caller hace fallback) en vez de esperar colgado.
        const task = this._queue[0];
        const totalWait = cooldownLeft + (Date.now() - task.enqueuedAt);
        if (task.maxWaitMs >= 0 && totalWait > task.maxWaitMs) {
          this._queue.shift();
          this._stats.failed++;
          this._stats.rateLimited++;
          task.reject(this._lastRateLimitError || new Error('provider en rate-limit (cooldown)'));
          continue;
        }
        // Nada se puede arrancar todavía — despertar cuando pase el cooldown.
        this._drainTimer = setTimeout(() => this._drain(), cooldownLeft + 10);
        return;
      }

      const task = this._queue.shift();
      this._active++;
      this._stats.total++;
      this._run(task).finally(() => {
        this._active--;
        this._drain();
      });
    }
  }

  async _run(task) {
    this._stats.totalWaitMs += Date.now() - task.enqueuedAt;
    const t0 = Date.now();
    try {
      const res = await task.run();
      this._stats.completed++;
      task.resolve(res);
    } catch (err) {
      this._stats.failed++;
      const waitMs = parseRetryAfterMs(err?.message || '');
      if (waitMs > 0) {
        this._stats.rateLimited++;
        this._cooldownUntil = Math.max(this._cooldownUntil, Date.now() + waitMs);
        this._lastRateLimitError = err;
      }
      task.reject(err);
    } finally {
      this._stats.execMs += Date.now() - t0;
    }
  }

  /** Espera hasta que la cola quede vacía (útil en tests / apagado ordenado). */
  async flush() {
    while (this._queue.length > 0 || this._active > 0) {
      await _sleep(10);
    }
  }
}

module.exports = { ProviderQueue, parseRetryAfterMs };
