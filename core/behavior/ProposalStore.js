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

function _localDayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

class ProposalStore {
  constructor({ filePath } = {}) {
    this._filePath = filePath || DEFAULT_PATH;
    this._data = { byType: {}, decisions: [], byDay: {} };
    this._inMem = false; // true si el disco falló → solo RAM
    this._load();
  }

  _load() {
    try {
      if (this._filePath && fs.existsSync(this._filePath)) {
        const raw = JSON.parse(fs.readFileSync(this._filePath, 'utf-8'));
        if (raw && typeof raw === 'object') this._data = raw;
        if (!this._data.byDay) this._data.byDay = {};
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
   * @param {{proposalId: string, type: string, decision: 'accepted'|'rejected'|'ignored', reason?: string}} entry
   */
  record({ proposalId, type, decision, reason } = {}) {
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

    this._data.decisions.push({
      proposalId,
      type,
      decision: d,
      reason: reason || null,
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

  getStats() {
    return {
      byType: this._data.byType,
      decisions: this._data.decisions.slice(-20),
      byDay: this._data.byDay,
      filePath: this._filePath,
      inMemoryOnly: this._inMem,
    };
  }

  reset() {
    this._data = { byType: {}, decisions: [], byDay: {} };
    this._inMem = false;
    if (this._filePath) {
      try {
        fs.rmSync(this._filePath, { force: true });
      } catch {}
    }
  }
}

module.exports = { ProposalStore };
