// @ts-check
'use strict';

/**
 * run-metrics.js — instrumentación por-run del AgentLoop.
 *
 * Acumulador ligero de métricas de ejecución que el loop actualiza en línea
 * (tools pedidas, aprobaciones, fallas reales) y que `run()` emite al terminar
 * SIEMPRE (éxito, error o cancelación) vía `emit()`. `emit()` agrega el campo
 * extra `result.metrics` (el contrato de retorno de run() no cambia) y persiste
 * el agregado en la telemetría local si está disponible. Nunca lanza: un fallo
 * aquí no puede romper un run ya terminado.
 */

const logger = require('../observability/Logger.js');

/**
 * @typedef {object} RunResult
 * @property {boolean} [cancelled]
 * @property {{ code?: string, message?: string }|null|undefined} [error]
 * @property {number} [iterations]
 * @property {object} [metrics]
 */

/**
 * @typedef {object} TelemetryApi
 * @property {(metrics: object) => void} [recordAgentRun]
 */

class RunMetrics {
  constructor() {
    /** @type {{ toolCalls: number, byType: Record<string, number>, errors: number, approvals: number, granted: number, denied: number }} */
    this._acc = { toolCalls: 0, byType: {}, errors: 0, approvals: 0, granted: 0, denied: 0 };
  }

  /** Una tool solicitada por el agente (aunque luego se bloquee/deniegue/cancele).
   *  @param {string} tool */
  trackTool(tool) {
    this._acc.toolCalls++;
    this._acc.byType[tool] = (this._acc.byType[tool] || 0) + 1;
  }

  /** Resultado de una aprobación humana (onApprovalNeeded).
   *  @param {boolean} approved */
  trackApproval(approved) {
    this._acc.approvals++;
    if (approved) {
      this._acc.granted++;
    } else {
      this._acc.denied++;
    }
  }

  /** Falla REAL de una tool (misma clasificación que toolFailures del loop). */
  trackError() {
    this._acc.errors++;
  }

  /**
   * Construye el objeto de métricas, lo anexa como `result.metrics` y lo
   * persiste vía la telemetría local (si la hay). Nunca lanza.
   * @param {{ result?: RunResult, t0: number, telemetry?: TelemetryApi|null }} ctx
   * @returns {object} métricas del run
   */
  emit({ result, t0, telemetry }) {
    const a = this._acc;
    const cancelled = Boolean(
      result && (result.cancelled === true || result.error?.code === 'ABORTED')
    );
    const metrics = {
      iterations: Number(result && result.iterations) || 0,
      tool_calls_total: a.toolCalls || 0,
      tool_calls_by_type: a.byType || {},
      errors_total: a.errors || 0,
      approval_requests: a.approvals || 0,
      approvals_granted: a.granted || 0,
      approvals_denied: a.denied || 0,
      cancelled,
      duration_ms: Date.now() - t0,
      error:
        result && result.error
          ? String((result.error && result.error.message) || result.error)
          : null,
    };
    this._acc = { toolCalls: 0, byType: {}, errors: 0, approvals: 0, granted: 0, denied: 0 };
    if (result && typeof result === 'object') {
      result.metrics = metrics;
    }
    if (telemetry && typeof telemetry.recordAgentRun === 'function') {
      try {
        telemetry.recordAgentRun(metrics);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.warn('AgentLoop', `[agent-run-metrics] telemetría falló: ${msg}`);
      }
    }
    logger.info('AgentLoop', '[agent-run-metrics]', metrics);
    return metrics;
  }
}

module.exports = { RunMetrics };
