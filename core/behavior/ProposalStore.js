// @ts-nocheck
'use strict';
const logger = require('../observability/Logger.js');

/**
 * ProposalStore.js — Fase A: persistencia del feedback de propuestas proactivas.
 *
 * Guarda en disco (JSON) qué propuestas aceptó/descartó el usuario, POR TIPO
 * de iniciativa, para que ProactiveEngine ajuste la frecuencia futura: si el
 * usuario descarta varias veces el mismo tipo, su cooldown efectivo crece y la
 * proactividad de ese tipo se enfría (el rechazo enseña).
 *
 * Se guarda en JSON (config-style) a propósito, NO como nodos del grafo
 * semántico: este feedback es telemetría, no memoria. Meterlo en el grafo
 * ensuciaría el retrieval semántico con metadatos de UX.
 *
 * Ruta por defecto: data/proactive_feedback.json (o la que inyectes en tests).
 * Nunca lanza en producción: cualquier fallo de disco se loggea y se degrada
 * a un store en memoria (la proactividad sigue funcionando, solo sin memoria).
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_PATH = path.join(__dirname, '..', '..', 'data', 'proactive_feedback.json');

// Cuántos rechazos consecutivos se recuerdan por tipo (a partir de ahí el
// factor de cooldown ya está en su tope).
const MAX_REJECTS_TRACKED = 4;
// Tope del factor que multiplica el cooldown base (×3 = el tipo se enfría).
const MAX_COOLDOWN_MULTIPLIER = 3;
// Cuántos días de historial diario de iniciativas se conservan en disco.
const MAX_DAILY_KEYS = 30;
const MAX_EMISSIONS = 200;
const EMISSION_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const CONTEXT_MODES = new Set(['work', 'browser', 'search', 'media', 'neutral']);
const CONTEXT_LEVELS = new Set(['auto', 'quiet', 'balanced', 'engaged']);
const CONTEXT_DEFAULTS = Object.freeze({
  work: 'balanced',
  browser: 'balanced',
  search: 'quiet',
  media: 'balanced',
  neutral: 'balanced',
});

function _localDayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

class ProposalStore {
  constructor({ filePath } = {}) {
    this._filePath = filePath || DEFAULT_PATH;
    this._data = {
      byType: {},
      decisions: [],
      byDay: {},
      byContext: {},
      contextPreferences: {},
      emissions: [],
    };
    this._inMem = false; // true si el disco falló → solo RAM
    this._load();
  }

  _load() {
    try {
      if (this._filePath && fs.existsSync(this._filePath)) {
        const raw = JSON.parse(fs.readFileSync(this._filePath, 'utf-8'));
        if (raw && typeof raw === 'object') this._data = raw;
        if (!this._data.byDay) this._data.byDay = {};
        if (!this._data.byContext) this._data.byContext = {};
        if (!this._data.contextPreferences) this._data.contextPreferences = {};
        if (!Array.isArray(this._data.emissions)) this._data.emissions = [];
      }
    } catch (e) {
      logger.warn('ProposalStore', '[proposal-store] no se pudo leer feedback previo:', e.message);
      this._inMem = true;
    }
  }

  _persist() {
    if (this._inMem || !this._filePath) return;
    try {
      fs.mkdirSync(path.dirname(this._filePath), { recursive: true });
      fs.writeFileSync(this._filePath, JSON.stringify(this._data, null, 2));
    } catch (e) {
      logger.warn('ProposalStore', '[proposal-store] no se pudo persistir feedback:', e.message);
      this._inMem = true;
    }
  }

  /**
   * Registra una decisión del usuario sobre una propuesta.
   * @param {{proposalId: string, type: string, decision: 'accepted'|'rejected'|'ignored', reason?: string, context?:string}} entry
   */
  record({ proposalId, type, decision, reason, context } = {}) {
    if (!proposalId || !type) return null;
    const d = decision === 'accepted' || decision === 'ignored' ? decision : 'rejected';

    const t = (this._data.byType[type] ||= {
      accepted: 0,
      rejected: 0,
      ignored: 0,
      rejectsInRow: 0,
      lastDecision: null,
    });
    if (d === 'accepted') {
      t.accepted += 1;
      t.rejectsInRow = 0;
    } else if (d === 'ignored') {
      t.ignored += 1;
      t.rejectsInRow = 0;
    } else {
      t.rejected += 1;
      t.rejectsInRow = Math.min(MAX_REJECTS_TRACKED, t.rejectsInRow + 1);
    }
    t.lastDecision = d;

    const contextMode = CONTEXT_MODES.has(context) ? context : null;
    if (contextMode) {
      const c = (this._data.byContext[contextMode] ||= { accepted: 0, rejected: 0, ignored: 0 });
      c[d] += 1;
      c.lastDecision = d;
      c.updatedAt = Date.now();
    }

    this._data.decisions.push({
      proposalId,
      type,
      decision: d,
      reason: reason || null,
      context: contextMode,
      ts: Date.now(),
    });
    if (this._data.decisions.length > 500)
      this._data.decisions.splice(0, this._data.decisions.length - 500);

    this._persist();
    return { ...t };
  }

  /**
   * Factor que multiplica el cooldown base de un tipo según los rechazos
   * consecutivos. 1 = sin penalidad; MAX_COOLDOWN_MULTIPLIER = tope (el tipo
   * se enfría fuerte hasta que el usuario acepte algo de nuevo).
   */
  cooldownMultiplier(type) {
    const t = this._data.byType[type];
    if (!t || !t.rejectsInRow) return 1;
    return Math.min(MAX_COOLDOWN_MULTIPLIER, 1 + t.rejectsInRow * 0.5);
  }

  // ── Fase C: presupuesto diario de iniciativas ──────────────────────────────

  /**
   * Cuántas iniciativas proactivas se ENVIARON hoy (día calendario local).
   * Persistido en disco para que el tope sobreviva reinicios.
   */
  dailyCount(dayKey = _localDayKey()) {
    return this._data.byDay[dayKey] || 0;
  }

  /** Registra una iniciativa enviada hoy y poda los días viejos. */
  incrementDaily(dayKey = _localDayKey()) {
    this._data.byDay[dayKey] = (this._data.byDay[dayKey] || 0) + 1;
    const keys = Object.keys(this._data.byDay).sort();
    if (keys.length > MAX_DAILY_KEYS) {
      for (const k of keys.slice(0, keys.length - MAX_DAILY_KEYS)) delete this._data.byDay[k];
    }
    this._persist();
    return this._data.byDay[dayKey];
  }

  getDailyStats(dayKey = _localDayKey()) {
    return { dayKey, count: this.dailyCount(dayKey) };
  }

  /** Todas las decisiones registradas (con ts) — para reportes de Fase E. */
  getDecisions() {
    return this._data.decisions;
  }

  // ── Fase 3, ítem 2: pesos aprendidos (LearningEngine) ──────────────────────
  // Campo aditivo: el feedback recalibrado por LearningEngine se guarda aquí
  // para que el gate de relevancia lo aplique sin tocar el flujo existente.

  getLearnedWeights() {
    return this._data.learnedWeights || null;
  }

  setLearnedWeights(weights) {
    this._data.learnedWeights = weights || null;
    this._persist();
    return this._data.learnedWeights;
  }

  /** Preferencia explícita del usuario; `auto` devuelve el control al aprendizaje. */
  setContextPreference(context, level) {
    if (!CONTEXT_MODES.has(context) || !CONTEXT_LEVELS.has(level)) {
      return { ok: false, error: 'context_preference_invalid' };
    }
    this._data.contextPreferences[context] = level;
    this._persist();
    return { ok: true, ...this.getContextPolicy(context) };
  }

  /**
   * Política efectiva. El aprendizaje sólo cambia el nivel con cuatro muestras;
   * una preferencia explícita siempre gana.
   */
  getContextPolicy(context) {
    const mode = CONTEXT_MODES.has(context) ? context : 'neutral';
    const storedPreference = this._data.contextPreferences[mode];
    const configured = CONTEXT_LEVELS.has(storedPreference) ? storedPreference : 'auto';
    const stats = this._data.byContext[mode] || { accepted: 0, rejected: 0, ignored: 0 };
    const samples = stats.accepted + stats.rejected + stats.ignored;
    const acceptanceRate = samples ? stats.accepted / samples : null;
    let effective = CONTEXT_DEFAULTS[mode];
    let source = 'default';
    if (configured !== 'auto') {
      effective = configured;
      source = 'explicit';
    } else if (samples >= 4) {
      if (acceptanceRate >= 0.7) effective = 'engaged';
      else if (acceptanceRate <= 0.2) effective = 'quiet';
      source = 'learned';
    }
    return { context: mode, configured, effective, source, samples, acceptanceRate };
  }

  getContextPolicies() {
    return [...CONTEXT_MODES].map((context) => this.getContextPolicy(context));
  }

  /**
   * Conserva el historial relacional para que el anti-repetición y la
   * evaluación sobrevivan a los reinicios. No guarda el contexto crudo del
   * sensor, sólo el mensaje emitido y sus atributos mínimos.
   * @param {{proposalId?:string|null,type:string,context?:string,message:string,at?:number}} input
   */
  recordEmission(input) {
    if (!input?.type || !input?.message) return null;
    const at = Number(input.at) || Date.now();
    const id = input.proposalId || `emission-${at}-${Math.random().toString(36).slice(2, 8)}`;
    const row = {
      id,
      proposalId: input.proposalId || null,
      type: String(input.type).slice(0, 80),
      context: CONTEXT_MODES.has(input.context) ? input.context : 'neutral',
      message: String(input.message).trim().slice(0, 600),
      at,
      outcome: null,
      respondedAt: null,
      responseLatencyMs: null,
    };
    this._data.emissions.push(row);
    this._pruneEmissions(at);
    this._persist();
    return { ...row };
  }

  /** @param {string} proposalId @param {'accepted'|'rejected'|'ignored'|'auto_executed'} outcome @param {number} [now] */
  resolveEmission(proposalId, outcome, now = Date.now()) {
    if (!proposalId || !['accepted', 'rejected', 'ignored', 'auto_executed'].includes(outcome)) {
      return false;
    }
    const row = [...this._data.emissions].reverse().find((item) => item.proposalId === proposalId);
    if (!row) return false;
    row.outcome = outcome;
    row.respondedAt = now;
    row.responseLatencyMs = Math.max(0, now - Number(row.at || now));
    this._persist();
    return true;
  }

  /** @param {{limit?:number,maxAgeMs?:number}} [opts] */
  getRecentEmissions({ limit = 20, maxAgeMs = 14 * 24 * 60 * 60 * 1000 } = {}) {
    const cutoff = Date.now() - Math.max(1, maxAgeMs);
    return this._data.emissions
      .filter((row) => Number(row.at) >= cutoff)
      .slice(-Math.max(1, Math.min(100, limit)))
      .map((row) => ({ ...row }));
  }

  /** Métricas de utilidad real, no sólo cantidad de mensajes enviados. */
  getLongitudinalStats() {
    const rows = this.getRecentEmissions({ limit: MAX_EMISSIONS, maxAgeMs: EMISSION_RETENTION_MS });
    const resolved = rows.filter((row) =>
      ['accepted', 'rejected', 'ignored'].includes(row.outcome)
    );
    const accepted = resolved.filter((row) => row.outcome === 'accepted').length;
    const rejected = resolved.filter((row) => row.outcome === 'rejected').length;
    const ignored = resolved.filter((row) => row.outcome === 'ignored').length;
    const autoExecuted = rows.filter((row) => row.outcome === 'auto_executed').length;
    const latencies = resolved
      .map((row) => Number(row.responseLatencyMs))
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => a - b);
    const middle = Math.floor(latencies.length / 2);
    const medianResponseMs = latencies.length
      ? latencies.length % 2
        ? latencies[middle]
        : Math.round((latencies[middle - 1] + latencies[middle]) / 2)
      : null;
    const byContext = {};
    for (const row of resolved) {
      const stats = (byContext[row.context] ||= { total: 0, accepted: 0, rejected: 0, ignored: 0 });
      stats.total += 1;
      stats[row.outcome] += 1;
    }
    const half = Math.floor(resolved.length / 2);
    const rate = (group) =>
      group.length ? group.filter((row) => row.outcome === 'accepted').length / group.length : null;
    const previousRate = half ? rate(resolved.slice(0, half)) : null;
    const recentRate = half ? rate(resolved.slice(half)) : null;
    return {
      totalEmissions: rows.length,
      resolved: resolved.length,
      accepted,
      rejected,
      ignored,
      autoExecuted,
      acceptanceRate: resolved.length ? accepted / resolved.length : null,
      medianResponseMs,
      trend: resolved.length >= 8 ? recentRate - previousRate : null,
      byContext,
    };
  }

  /** @param {number} now */
  _pruneEmissions(now) {
    const cutoff = now - EMISSION_RETENTION_MS;
    this._data.emissions = this._data.emissions
      .filter((row) => Number(row.at) >= cutoff)
      .slice(-MAX_EMISSIONS);
  }

  clearEmissions() {
    const deleted = this._data.emissions.length;
    this._data.emissions = [];
    this._persist();
    return { ok: true, deleted };
  }

  getStats() {
    return {
      byType: this._data.byType,
      decisions: this._data.decisions.slice(-20),
      byDay: this._data.byDay,
      byContext: this._data.byContext,
      contextPolicies: this.getContextPolicies(),
      longitudinal: this.getLongitudinalStats(),
      filePath: this._filePath,
      inMemoryOnly: this._inMem,
    };
  }

  reset() {
    this._data = {
      byType: {},
      decisions: [],
      byDay: {},
      byContext: {},
      contextPreferences: {},
      emissions: [],
    };
    this._inMem = false;
    if (this._filePath) {
      try {
        fs.rmSync(this._filePath, { force: true });
      } catch {}
    }
  }
}

module.exports = { ProposalStore };
