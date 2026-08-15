// @ts-nocheck
'use strict';
const logger = require('../observability/Logger.js');

/**
 * TelemetryStore.js — Fase E: evaluación continua con datos locales.
 *
 * Responde "¿estamos mejor que el mes pasado?" con métricas reales de uso,
 * no con la impresión: mensajes/día, tiempo de respuesta, silencios, sesiones
 * (reuso) y tasa de aceptación por tipo de iniciativa.
 *
 * Reglas de diseño (mismas que ProposalStore):
 *   - Telemetría local: JSON en disco, nunca se envía a ningún lado.
 *   - Nunca lanza: cualquier fallo de disco degrada a memoria RAM (la app
 *     sigue funcionando, solo sin historial).
 *   - Basura contenida: los arrays de muestras (tiempos de respuesta,
 *     silencios) tienen tope por día y los días viejos se podan.
 *   - Fase A = baseline: los turnos se cuentan desde el día 1, así que el
 *     reporte mensual siempre tiene con qué comparar.
 *
 * Qué NO mide (a propósito): el feedback de propuestas vive en
 * ProposalStore (byType persistido). Aquí se leen las decisiones para
 * componer la tasa de aceptación del mes sin duplicar el almacenamiento.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_PATH = path.join(__dirname, '..', '..', 'data', 'telemetry.json');

// ── Umbrales de la telemetría ─────────────────────────────────────────────
const SILENCE_THRESHOLD_MS = 30 * 60 * 1000; // gap entre mensajes del usuario que cuenta como "silencio"
const SESSION_GAP_MS = 20 * 60 * 1000; // gap que separa dos "sesiones" (reuso)
const RESPONSE_WINDOW_MS = 10 * 60 * 1000; // máximo para considerar un turno assistant como respuesta a un user
const MAX_RESPONSE_SAMPLES = 200; // muestras de tiempo de respuesta por día (p50/p90)
const MAX_SILENCE_SAMPLES = 60; // muestras de silencios por día
const MAX_RUN_DURATION_SAMPLES = 200; // muestras de duración de runs del agente por día
const MAX_DAYS = 90; // días de historial retenidos en disco

function _localDayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function _monthKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}`;
}

function _prevMonthKey(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${m - 1}`;
}

function _percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

class TelemetryStore {
  constructor({ filePath, now = Date.now } = {}) {
    this._filePath = filePath || DEFAULT_PATH;
    this._now = now;
    this._data = { days: {}, meta: { lastActivityTs: 0, lastUserTs: 0 } };
    this._inMem = false;
    this._load();
  }

  _load() {
    try {
      if (this._filePath && fs.existsSync(this._filePath)) {
        const raw = JSON.parse(fs.readFileSync(this._filePath, 'utf-8'));
        if (raw && typeof raw === 'object') this._data = raw;
        if (!this._data.days) this._data.days = {};
        if (!this._data.meta) this._data.meta = { lastActivityTs: 0, lastUserTs: 0 };
      }
    } catch (e) {
      logger.warn('TelemetryStore', '[telemetry] no se pudo leer telemetría previa:', e.message);
      this._inMem = true;
    }
  }

  _persist() {
    if (this._inMem || !this._filePath) return;
    try {
      fs.mkdirSync(path.dirname(this._filePath), { recursive: true });
      fs.writeFileSync(this._filePath, JSON.stringify(this._data, null, 2));
    } catch (e) {
      logger.warn('TelemetryStore', '[telemetry] no se pudo persistir:', e.message);
      this._inMem = true;
    }
  }

  _day(dayKey) {
    return (this._data.days[dayKey] ||= {
      userMessages: 0,
      assistantMessages: 0,
      responseCount: 0,
      responseSumMs: 0,
      responseTimes: [],
      silenceCount: 0,
      silenceTotalMs: 0,
      silences: [],
      sessions: 0,
      // Runs del agente (AgentLoop): métricas por-run agregadas al día.
      agentRuns: 0,
      agentToolCalls: 0,
      agentErrors: 0,
      agentApprovalRequests: 0,
      agentApprovalsGranted: 0,
      agentApprovalsDenied: 0,
      agentCancelled: 0,
      agentRunDurationsMs: [],
      agentRunDurationSumMs: 0,
    });
  }

  _prune() {
    const keys = Object.keys(this._data.days).sort();
    if (keys.length > MAX_DAYS) {
      for (const k of keys.slice(0, keys.length - MAX_DAYS)) delete this._data.days[k];
    }
  }

  /**
   * Registra un turno de conversación (rol 'user' o 'assistant'). Es el
   * embudo central: todo turno que se persiste a memoria pasa por aquí.
   * Deriva en el mismo punto las cuatro métricas de uso:
   *   - userMessages / assistantMessages → mensajes/día
   *   - responseTimes → tiempo de respuesta (p50/p90/avg)
   *   - silences → periodos largos sin mensajes del usuario
   *   - sessions → ráfagas de actividad (reuso)
   */
  recordTurn(role, ts = this._now()) {
    const dayKey = _localDayKey(ts);
    const day = this._day(dayKey);
    const meta = this._data.meta;

    if (role === 'user') {
      day.userMessages += 1;

      // Silencio: gap grande desde la última actividad, SOLO dentro del mismo
      // día calendario. Un gap que cruza la medianoche es "empezó otro día",
      // no un silencio — si contáramos los overnight como silencios, más días
      // de uso (mejor) inflaría las horas de silencio y el reporte mentiría.
      if (meta.lastActivityTs) {
        const gap = ts - meta.lastActivityTs;
        if (gap > SILENCE_THRESHOLD_MS && _localDayKey(meta.lastActivityTs) === dayKey) {
          day.silenceCount += 1;
          day.silenceTotalMs += gap;
          day.silences.push({ ms: gap, at: ts });
          if (day.silences.length > MAX_SILENCE_SAMPLES) day.silences.shift();
        }
        // Sesión nueva (reuso): volvió después de un gap largo.
        if (gap > SESSION_GAP_MS) day.sessions += 1;
      } else {
        day.sessions += 1;
      }

      meta.lastUserTs = ts;
    } else if (role === 'assistant') {
      day.assistantMessages += 1;

      // Tiempo de respuesta SOLO si este assistant sigue a un user reciente.
      // Una iniciativa proactiva (sin user previo o mucho después) NO es una
      // respuesta y no debe inflar el promedio.
      if (
        meta.lastUserTs &&
        ts - meta.lastUserTs > 0 &&
        ts - meta.lastUserTs <= RESPONSE_WINDOW_MS
      ) {
        const ms = ts - meta.lastUserTs;
        day.responseCount += 1;
        day.responseSumMs += ms;
        day.responseTimes.push(ms);
        if (day.responseTimes.length > MAX_RESPONSE_SAMPLES) day.responseTimes.shift();
        meta.lastUserTs = 0; // un user → una respuesta
      }
    }

    meta.lastActivityTs = ts;
    this._prune();
    this._persist();
  }

  /**
   * Registra las métricas de ejecución de un run del agente (emitidas por
   * AgentLoop al terminar, pase lo que pase). Se agregan como contadores del
   * día (mismo mecanismo de persistencia que los turnos). Las duraciones se
   * guardan como muestras (tope por día) para p50/p90 en el resumen mensual.
   *
   * @param {object} m Métricas del run (shape de AgentLoop._emitRunMetrics).
   */
  recordAgentRun(m = {}) {
    const dayKey = _localDayKey(this._now());
    const day = this._day(dayKey);
    day.agentRuns += 1;
    day.agentToolCalls += m.tool_calls_total || 0;
    day.agentErrors += m.errors_total || 0;
    day.agentApprovalRequests += m.approval_requests || 0;
    day.agentApprovalsGranted += m.approvals_granted || 0;
    day.agentApprovalsDenied += m.approvals_denied || 0;
    if (m.cancelled) day.agentCancelled += 1;
    const dur = m.duration_ms || 0;
    day.agentRunDurationsMs.push(dur);
    if (day.agentRunDurationsMs.length > MAX_RUN_DURATION_SAMPLES) {
      day.agentRunDurationsMs.shift();
    }
    day.agentRunDurationSumMs += dur;
    this._prune();
    this._persist();
  }

  // ── Agregación mensual ───────────────────────────────────────────────────

  monthSummary(monthKey = _monthKey(this._now())) {
    const acc = {
      activeDays: 0,
      userMessages: 0,
      assistantMessages: 0,
      responseCount: 0,
      responseSumMs: 0,
      responseTimes: [],
      silenceCount: 0,
      silenceTotalMs: 0,
      sessions: 0,
      agentRuns: 0,
      agentToolCalls: 0,
      agentErrors: 0,
      agentApprovalRequests: 0,
      agentApprovalsGranted: 0,
      agentApprovalsDenied: 0,
      agentCancelled: 0,
      agentRunDurationsMs: [],
      agentRunDurationSumMs: 0,
    };

    for (const [dayKey, d] of Object.entries(this._data.days)) {
      if (!dayKey.startsWith(monthKey)) continue;
      if (d.userMessages > 0) acc.activeDays += 1;
      acc.userMessages += d.userMessages;
      acc.assistantMessages += d.assistantMessages;
      acc.responseCount += d.responseCount;
      acc.responseSumMs += d.responseSumMs;
      acc.responseTimes = acc.responseTimes
        .concat(d.responseTimes)
        .slice(-MAX_RESPONSE_SAMPLES * 4);
      acc.silenceCount += d.silenceCount;
      acc.silenceTotalMs += d.silenceTotalMs;
      acc.sessions += d.sessions;
      acc.agentRuns += d.agentRuns || 0;
      acc.agentToolCalls += d.agentToolCalls || 0;
      acc.agentErrors += d.agentErrors || 0;
      acc.agentApprovalRequests += d.agentApprovalRequests || 0;
      acc.agentApprovalsGranted += d.agentApprovalsGranted || 0;
      acc.agentApprovalsDenied += d.agentApprovalsDenied || 0;
      acc.agentCancelled += d.agentCancelled || 0;
      acc.agentRunDurationsMs = acc.agentRunDurationsMs
        .concat(d.agentRunDurationsMs || [])
        .slice(-MAX_RUN_DURATION_SAMPLES * 4);
      acc.agentRunDurationSumMs += d.agentRunDurationSumMs || 0;
    }

    const sorted = [...acc.responseTimes].sort((a, b) => a - b);
    const runDurations = [...acc.agentRunDurationsMs].sort((a, b) => a - b);
    return {
      monthKey,
      activeDays: acc.activeDays,
      userMessages: acc.userMessages,
      assistantMessages: acc.assistantMessages,
      messagesPerDay: acc.activeDays
        ? (acc.userMessages + acc.assistantMessages) / acc.activeDays
        : 0,
      responseCount: acc.responseCount,
      avgResponseMs: acc.responseCount ? Math.round(acc.responseSumMs / acc.responseCount) : null,
      p50ResponseMs: _percentile(sorted, 50),
      p90ResponseMs: _percentile(sorted, 90),
      silenceCount: acc.silenceCount,
      silenceHours: Math.round((acc.silenceTotalMs / (1000 * 60 * 60)) * 10) / 10,
      sessions: acc.sessions,
      sessionsPerDay: acc.activeDays ? acc.sessions / acc.activeDays : 0,
      agentRuns: acc.agentRuns,
      agentToolCalls: acc.agentToolCalls,
      agentErrors: acc.agentErrors,
      agentApprovalRequests: acc.agentApprovalRequests,
      agentApprovalsGranted: acc.agentApprovalsGranted,
      agentApprovalsDenied: acc.agentApprovalsDenied,
      agentCancelled: acc.agentCancelled,
      avgRunDurationMs: acc.agentRuns
        ? Math.round(acc.agentRunDurationSumMs / acc.agentRuns)
        : null,
      p50RunDurationMs: _percentile(runDurations, 50),
      p90RunDurationMs: _percentile(runDurations, 90),
    };
  }

  /**
   * Tasa de aceptación de un mes a partir de las decisiones del
   * ProposalStore (que ya tiene el historial desde la Fase A).
   */
  acceptanceForMonth(monthKey, decisions = []) {
    const [y, m] = monthKey.split('-').map(Number);
    const from = new Date(y, m - 1, 1, 0, 0, 0, 0).getTime();
    const to = new Date(y, m, 1, 0, 0, 0, 0).getTime();
    const inMonth = decisions.filter((d) => d.ts >= from && d.ts < to);

    const byType = {};
    for (const d of inMonth) {
      const t = (byType[d.type] ||= { accepted: 0, rejected: 0, total: 0 });
      if (d.decision === 'accepted') t.accepted += 1;
      else if (d.decision === 'rejected') t.rejected += 1;
      t.total += 1;
    }
    const totals = Object.values(byType).reduce(
      (a, t) => ({ accepted: a.accepted + t.accepted, rejected: a.rejected + t.rejected }),
      { accepted: 0, rejected: 0 }
    );
    const total = totals.accepted + totals.rejected;

    return {
      monthKey,
      rate: total ? Math.round((totals.accepted / total) * 100) : null,
      accepted: totals.accepted,
      rejected: totals.rejected,
      total,
      byType,
    };
  }

  /**
   * Reporte "¿estamos mejor que el mes pasado?" — compara el mes actual (o
   * el indicado) contra el mes anterior. Devuelve métricas de ambos meses,
   * deltas porcentuales y un veredicto basado en la dirección de cada
   * métrica (más mensajes = mejor, respuesta más rápida = mejor, etc.).
   */
  report({ monthKey = _monthKey(this._now()), compareMonthKey = null, decisions = [] } = {}) {
    const prevKey = compareMonthKey || _prevMonthKey(monthKey);
    const current = this.monthSummary(monthKey);
    const previous = this.monthSummary(prevKey);
    const acceptance = this.acceptanceForMonth(monthKey, decisions);
    const prevAcceptance = this.acceptanceForMonth(prevKey, decisions);

    const pct = (cur, prev) =>
      prev === 0 || cur == null || prev == null ? null : Math.round(((cur - prev) / prev) * 100);

    const deltas = {
      messagesPerDay: pct(current.messagesPerDay, previous.messagesPerDay),
      avgResponseMs: pct(current.avgResponseMs, previous.avgResponseMs),
      p50ResponseMs: pct(current.p50ResponseMs, previous.p50ResponseMs),
      silenceHours: pct(current.silenceHours, previous.silenceHours),
      silenceCount: pct(current.silenceCount, previous.silenceCount),
      sessionsPerDay: pct(current.sessionsPerDay, previous.sessionsPerDay),
      activeDays: pct(current.activeDays, previous.activeDays),
      acceptanceRate:
        prevAcceptance.rate == null || acceptance.rate == null
          ? null
          : pct(acceptance.rate, prevAcceptance.rate),
    };

    // Dirección "buena" por métrica: ↑ o ↓ es mejor.
    const GOOD = {
      messagesPerDay: 'up',
      avgResponseMs: 'down',
      p50ResponseMs: 'down',
      silenceHours: 'down',
      silenceCount: 'down',
      sessionsPerDay: 'up',
      activeDays: 'up',
      acceptanceRate: 'up',
    };
    const improved = { up: 0, down: 0, neutral: 0 };
    for (const [k, delta] of Object.entries(deltas)) {
      if (delta == null || delta === 0) {
        improved.neutral += 1;
        continue;
      }
      const direction = GOOD[k];
      const good = direction === 'up' ? delta > 0 : delta < 0;
      improved[good ? 'up' : 'down'] += 1;
    }

    return {
      monthKey,
      compareMonthKey: prevKey,
      current,
      previous,
      acceptance,
      prevAcceptance,
      deltas,
      verdict:
        improved.up > improved.down
          ? 'improved'
          : improved.down > improved.up
            ? 'regressed'
            : 'stable',
    };
  }

  getStats() {
    const today = this.monthSummary(_monthKey(this._now()));
    return {
      filePath: this._filePath,
      inMemoryOnly: this._inMem,
      days: Object.keys(this._data.days).length,
      meta: this._data.meta,
      today,
      lastReport: null,
    };
  }

  reset() {
    this._data = { days: {}, meta: { lastActivityTs: 0, lastUserTs: 0 } };
    this._inMem = false;
    if (this._filePath) {
      try {
        fs.rmSync(this._filePath, { force: true });
      } catch (_) {}
    }
  }
}

module.exports = { TelemetryStore, SILENCE_THRESHOLD_MS, SESSION_GAP_MS, RESPONSE_WINDOW_MS };
