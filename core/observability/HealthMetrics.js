// @ts-check
'use strict';
const logger = require('./Logger.js');
const { UsageTracker, PRICING } = require('./UsageTracker.js');

/**
 * HealthMetrics — punto de observabilidad del sistema.
 *
 * Agrega una vista unificada de salud y métricas del asistente:
 *   - Salud: estado del bridge, sandbox, conexión al servidor OpenClaw.
 *   - Uso LLM: totales de tokens/costes por proveedor y del día.
 *   - Recursos: memoria RSS del proceso.
 *
 * Uso:
 *   const { getHealthMetrics } = require('../observability/HealthMetrics.js');
 *   const metrics = getHealthMetrics();
 *   // O con un bridge y tracker activos:
 *   const hm = new HealthMetrics({ bridge, tracker });
 *   await hm.getReport();
 */

const { performance } = require('perf_hooks');

/** @typedef {{ totalRequests: number, totalPromptTokens: number, totalCompletionTokens: number, totalTokens: number, totalCostUsd: number, byProvider: Record<string, { requests: number, tokens: number, costUsd: number }>, today: { requests: number, promptTokens: number, completionTokens: number, costUsd: number } }} UsageSummary */

class HealthMetrics {
  /**
   * @param {object} [opts]
   * @param {object} [opts.bridge]        OpenClawBridge para estado de sandbox/disponibilidad.
   * @param {UsageTracker} [opts.tracker]  UsageTracker para métricas de LLM.
   * @param {string} [opts.filePath]       ruta del archivo JSONL de métricas.
   */
  constructor(opts = {}) {
    /** @type {object | null} */
    this._bridge = opts.bridge || null;
    /** @type {UsageTracker | null} */
    this._tracker = opts.tracker || null;
    /** @type {string | null} */
    this._filePath = opts.filePath || null;
    /** @type {number} */
    this._startTime = Date.now();
    /** @type {Map<string, number>} */
    this._requestTimestamps = new Map();
    /** @type {number} */
    this._activeRequests = 0;
    /** @type {number} */
    this._totalRequests = 0;
    /** @type {number} */
    this._lastErrorTime = 0;
    /** @type {string | null} */
    this._lastError = null;
  }

  /**
   * Registra una solicitud entrante.
   * @param {string} [label]
   */
  recordRequest(label) {
    this._totalRequests++;
    this._activeRequests++;
    const key = label || 'anonymous';
    this._requestTimestamps.set(key, Date.now());
  }

  /**
   * Marca una solicitud como completada.
   * @param {string} [label]
   */
  recordResponse(label) {
    if (label) {
      this._requestTimestamps.delete(label);
    }
    this._activeRequests = Math.max(0, this._activeRequests - 1);
  }

  /**
   * Registra un error.
   * @param {string} msg
   */
  recordError(msg) {
    this._lastError = msg;
    this._lastErrorTime = Date.now();
    logger.error('HealthMetrics', `error: ${msg}`);
  }

  /**
   * Devuelve un snapshot de salud del sistema.
   * @returns {{ healthy: boolean, uptimeMs: number, sandbox: { enabled: boolean, reason: string | null } | null, bridgeAvailable: boolean | null, activeRequests: number, totalRequests: number, lastError: string | null, memoryMb: number, timestamp: string }}
   */
  getHealth() {
    const bridgeStatus = this._bridge ? this._bridge.getSandboxStatus() : null;
    const bridgeAvailable = this._bridge ? this._bridge._available : null;
    const mem = process.memoryUsage();
    const uptimeMs = Date.now() - this._startTime;

    const healthy = bridgeAvailable !== false && this._activeRequests < 100;

    return {
      healthy,
      uptimeMs,
      sandbox: bridgeStatus ? { ...bridgeStatus } : null,
      bridgeAvailable,
      activeRequests: this._activeRequests,
      totalRequests: this._totalRequests,
      lastError: this._lastError,
      memoryMb: Math.round((mem.rss || 0) / (1024 * 1024) * 10) / 10,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Devuelve un reporte completo de salud + métricas.
   * @returns {{ health: object, usage: UsageSummary | null, requestsPerMinute: number, errorsLastHour: number }}
   */
  getReport() {
    const health = this.getHealth();
    const usage = this._tracker ? this._tracker.getSummary() : null;

    // Requests per minuto (última hora)
    const oneHourAgo = Date.now() - 3600_000;
    let recentRequests = 0;
    for (const ts of this._requestTimestamps.values()) {
      if (ts >= oneHourAgo) recentRequests++;
    }
    const requestsPerMinute = Math.round(recentRequests / 60 * 10) / 10;

    // Errores en la última hora
    const oneHourAgo2 = Date.now() - 3600_000;
    const errorsLastHour = this._lastErrorTime >= oneHourAgo2 ? 1 : 0;

    return {
      health,
      usage,
      requestsPerMinute,
      errorsLastHour,
    };
  }

  /**
   * Resetea los contadores de requests activos y errores.
   */
  reset() {
    this._activeRequests = 0;
    this._totalRequests = 0;
    this._requestTimestamps.clear();
    this._lastError = null;
    this._lastErrorTime = 0;
    this._startTime = Date.now();
    if (this._tracker) {
      this._tracker.reset();
    }
  }

  /**
   * Devuelve las métricas de uso del tracker si está configurado.
   * @returns {UsageSummary | null}
   */
  getUsageSummary() {
    return this._tracker ? this._tracker.getSummary() : null;
  }
}

// Singleton por defecto — los módulos comparten una única instancia.
let _defaultInstance = null;
function getHealthMetrics(opts) {
  if (!_defaultInstance || opts) {
    _defaultInstance = new HealthMetrics(opts);
  }
  return _defaultInstance;
}

module.exports = { HealthMetrics, getHealthMetrics };