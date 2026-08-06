// @ts-check
'use strict';

/**
 * UsageTracker — registro y agregación de uso de LLM (tokens + coste).
 *
 * Cada llamada exitosa al provider registra un evento; el tracker mantiene
 * agregados en memoria y persiste a un archivo JSONL (uno por línea) para no
 * perder el historial entre sesiones. `getSummary()` expone totales globales,
 * por proveedor y de hoy.
 *
 * El coste es una ESTIMACIÓN aproximada con precios públicos por proveedor
 * (dólares por 1k tokens). Cuando un proveedor no está en la tabla o el body
 * no trae tokens, se registra con coste 0 y la bandera `costEstimated:false`.
 * No es una factura — es una brújula.
 */

const fs = require('fs');
const path = require('path');

/**
 * Precios aproximados por proveedor (USD / 1k tokens). Valores públicos
 * indicativos; revisar con cada proveedor. `null` → desconocido.
 * @type {Record<string, { input: number | null, output: number | null }>}
 */
const PRICING = {
  groq: { input: 0.05, output: 0.1 }, // llama 3.1-8b (aprox); 70b es más caro
  gemini: { input: 0.1, output: 0.4 }, // gemini-2.0-flash (aprox)
  openai: { input: 0.15, output: 0.6 }, // gpt-4o-mini
  anthropic: { input: 3.0, output: 15.0 }, // claude-sonnet (aprox conservador)
  xai: { input: 0.15, output: 0.6 }, // grok-beta (aprox)
  nvidia: { input: 0.1, output: 0.3 },
  huggingface: { input: 0.0, output: 0.0 }, // mayormente free
  deepseek: { input: 0.14, output: 0.28 },
};

const MAX_EVENTS = 5000;

/** @typedef {{ ts: string, provider: string, model: string, mode: string, promptTokens: number, completionTokens: number, totalTokens: number, costUsd: number, costEstimated: boolean, latencyMs: number, stream: boolean, error: boolean }} UsageEvent */

class UsageTracker {
  /**
   * @param {string | null} filePath Ruta del JSONL persistente. null → solo memoria.
   * @param {object} [opts]
   * @param {boolean} [opts.verbose]
   */
  constructor(filePath, opts = {}) {
    /** @type {string | null} */
    this.filePath = filePath;
    this.verbose = opts.verbose !== false;
    /** @type {UsageEvent[]} */
    this._events = [];
    this._loaded = false;
    if (this.filePath) {
      try {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      } catch (_) {
        /* no crítico */
      }
    }
  }

  _ensureLoaded() {
    if (this._loaded || !this.filePath || !fs.existsSync(this.filePath)) {
      this._loaded = true;
      return;
    }
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev && typeof ev.ts === 'string') this._events.push(ev);
        } catch (_) {
          /* línea corrupta se ignora */
        }
      }
      if (this._events.length > MAX_EVENTS)
        this._events.splice(0, this._events.length - MAX_EVENTS);
    } catch (_) {
      /* archivo ilegible: se ignora */
    }
    this._loaded = true;
  }

  /**
   * Registra un evento de uso.
   * @param {object} input
   * @param {string} input.provider
   * @param {string} input.model
   * @param {string} [input.mode]
   * @param {number} [input.promptTokens]
   * @param {number} [input.completionTokens]
   * @param {number} [input.latencyMs]
   * @param {boolean} [input.stream]
   * @param {boolean} [input.error]
   * @returns {UsageEvent}
   */
  record(input) {
    const promptTokens = input.promptTokens ?? 0;
    const completionTokens = input.completionTokens ?? 0;
    const pricing = PRICING[input.provider] || null;
    const inPrice = pricing ? pricing.input : null;
    const outPrice = pricing ? pricing.output : null;
    const costEstimated = inPrice !== null && outPrice !== null;
    const costUsd = costEstimated
      ? (promptTokens / 1000) * inPrice + (completionTokens / 1000) * outPrice
      : 0;

    /** @type {UsageEvent} */
    const ev = {
      ts: new Date().toISOString(),
      provider: input.provider,
      model: input.model,
      mode: input.mode || 'fast',
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      costUsd,
      costEstimated,
      latencyMs: input.latencyMs ?? 0,
      stream: input.stream === true,
      error: input.error === true,
    };

    this._ensureLoaded();
    this._events.push(ev);
    if (this._events.length > MAX_EVENTS) this._events.splice(0, this._events.length - MAX_EVENTS);

    if (this.filePath) {
      try {
        fs.appendFileSync(this.filePath, JSON.stringify(ev) + '\n', 'utf-8');
      } catch (e) {
        if (this.verbose) {
          const m = e instanceof Error ? e.message : String(e);
          console.log(`[usage] no se pudo persistir evento: ${m}`);
        }
      }
    }
    return ev;
  }

  /**
   * Agregados: totales globales, por proveedor y de hoy.
   * @returns {{ totalRequests: number, totalPromptTokens: number, totalCompletionTokens: number, totalTokens: number, totalCostUsd: number, byProvider: Record<string, { requests: number, tokens: number, costUsd: number }>, today: { requests: number, promptTokens: number, completionTokens: number, costUsd: number } }}
   */
  getSummary() {
    this._ensureLoaded();
    /** @type {Record<string, { requests: number, tokens: number, costUsd: number }>} */
    const byProvider = {};
    let totalRequests = 0;
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalCostUsd = 0;
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const today = { requests: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 };

    for (const ev of this._events) {
      totalRequests++;
      totalPromptTokens += ev.promptTokens;
      totalCompletionTokens += ev.completionTokens;
      totalCostUsd += ev.costUsd;
      const p = byProvider[ev.provider] || { requests: 0, tokens: 0, costUsd: 0 };
      p.requests++;
      p.tokens += ev.totalTokens;
      p.costUsd += ev.costUsd;
      byProvider[ev.provider] = p;

      const ts = Date.parse(ev.ts);
      if (!Number.isNaN(ts) && ts >= todayStart) {
        today.requests++;
        today.promptTokens += ev.promptTokens;
        today.completionTokens += ev.completionTokens;
        today.costUsd += ev.costUsd;
      }
    }

    return {
      totalRequests,
      totalPromptTokens,
      totalCompletionTokens,
      totalTokens: totalPromptTokens + totalCompletionTokens,
      totalCostUsd,
      byProvider,
      today,
    };
  }

  /** @returns {UsageEvent[]} */
  recent(n = 50) {
    this._ensureLoaded();
    return this._events.slice(-n);
  }

  reset() {
    this._events = [];
    if (this.filePath) {
      try {
        fs.writeFileSync(this.filePath, '', 'utf-8');
      } catch (_) {
        /* no crítico */
      }
    }
  }
}

module.exports = { UsageTracker, PRICING };
