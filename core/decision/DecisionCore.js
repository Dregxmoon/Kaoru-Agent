// @ts-check
'use strict';

/**
 * DecisionCore.js — Fase F: núcleo determinista de decisión proactiva.
 *
 * Funciones PURAS de alto nivel (mismo input → mismo output, sin estado
 * oculto, sin I/O). Son el criterio del asistente para decidir SI, CUÁNDO y CON
 * QUÉ prioridad actuar ante una señal del entorno. El ProactiveEngine (y los
 * sensores) SOLO llaman a estas funciones; el LLM nunca decide, produce.
 *
 * Diseño (ver ROADMAP Fase F):
 *   3. scoreRelevancia(signal, ctx)  → R ∈ [0,1]
 *      R = w₁·Severidad + w₂·Accionabilidad + w₃·Saliencia + w₄·CosteDeIgnorar
 *      (todos los términos en [0,1], normalizados por el sensor en F-2)
 *   4. receptividad(prev, outcome, h) → Rec ∈ [-1,1]   (EMA con decaimiento)
 *   5. presupuesto(Rec)               → Budget ∈ [min, max] (dinámico)
 *   6. decide(R, ctx, Rec, budget)    → { verdict, reason, ... } con
 *      histéresis: degradar un tipo es barato, re-promocionarlo exige superar
 *      un umbral más alto.
 *
 * Transversal: cada decisión produce una entrada de AUDIT con reasonCode,
 * traceable en `{ sensor → scores → gates → veredicto → outcome }`.
 *
 * Policy-as-config: todos los pesos/umbrales viven en DEFAULT_POLICY (JSON
 * serializable) — se calibran sin tocar código.
 */

// ── Tipos ────────────────────────────────────────────────────────────────────
/**
 * @typedef {object} RelevancySignal
 * @property {number} [severity]      [0,1]
 * @property {number} [actionability] [0,1]
 * @property {number} [salience]      [0,1]
 * @property {number} [costOfIgnore]  [0,1]
 */

/**
 * @typedef {object} WeightsConfig
 * @property {number} [severity]
 * @property {number} [actionability]
 * @property {number} [salience]
 * @property {number} [costOfIgnore]
 */

/**
 * @typedef {object} ThresholdsConfig
 * @property {number} [act]
 * @property {number} [queue]
 * @property {number} [escalate]
 * @property {number} [promoteBy]
 */

/**
 * @typedef {object} ReceptivityConfig
 * @property {number} [alpha]
 * @property {number} [accepted]
 * @property {number} [rejected]
 * @property {number} [ignored]
 * @property {number} [decayPerHour]
 */

/**
 * @typedef {object} BudgetConfig
 * @property {number} [base]
 * @property {number} [min]
 * @property {number} [max]
 */

/**
 * @typedef {object} LearningConfig
 * @property {number} [minSamples]
 * @property {number} [maxBias]
 * @property {number} [perRejectPenalty]
 * @property {number} [maxRejectsTracked]
 */

/**
 * Override parcial de la política (todo opcional → cada campo se fusiona
 * sobre los valores por defecto de DEFAULT_POLICY en runtime).
 * @typedef {object} ProactivePolicy
 * @property {WeightsConfig} [weights]
 * @property {ThresholdsConfig} [thresholds]
 * @property {ReceptivityConfig} [receptivity]
 * @property {BudgetConfig} [budget]
 * @property {LearningConfig} [learning]
 */

/**
 * @typedef {object} ReceptivityOutcome
 * @property {boolean} [accepted]
 * @property {boolean} [rejected]
 * @property {boolean} [ignored]
 */

/**
 * @typedef {object} TypeOutcomeStats
 * @property {number} [accepted]
 * @property {number} [rejected]
 * @property {number} [ignored]
 * @property {number} [rejectsInRow]
 */

/**
 * Stats de deriveWeights: puede venir anidado (`{ byType }`) o plano.
 * @typedef {object} DeriveStatsLike
 * @property {Object<string, TypeOutcomeStats>} [byType]
 */

/**
 * @typedef {object} DecideContext
 * @property {number} [relevance]     R en [0,1]
 * @property {boolean} [goodMoment]   gate de contexto (F-3)
 * @property {boolean} [userPresent]  usuario en el equipo
 * @property {boolean} [isCritical]  senal critica (salta presupuesto)
 * @property {boolean} [degraded]  tipo degradado por SLO (F-5)
 * @property {number} [budgetUsed]
 * @property {number} [budgetLimit]
 */

/**
 * @typedef {object} Decision
 * @property {'ACT' | 'QUEUE' | 'DROP' | 'ESCALATE'} verdict
 * @property {string} reason
 * @property {number} relevance
 * @property {string} decisionId
 */

/**
 * @typedef {object} AuditEntry
 * @property {number} ts
 * @property {string | null} sensor
 * @property {string | null} type
 * @property {string | null} kind
 * @property {object | null} signal
 * @property {object | null} scores
 * @property {number | null} score
 * @property {string | null} flow
 * @property {object | null} context
 * @property {string | null} verdict
 * @property {string | null} reason
 * @property {string | null} outcome
 * @property {string | null} decisionId
 * @property {boolean} shadow
 */

/**
 * @typedef {object} AuditEntryInput
 * @property {string} [sensor]
 * @property {string} [type]
 * @property {string} [kind]
 * @property {object} [signal]
 * @property {object} [scores]
 * @property {number} [score]
 * @property {string} [flow]
 * @property {object} [context]
 * @property {string} [verdict]
 * @property {string} [reason]
 * @property {string} [outcome]
 * @property {string} [decisionId]
 * @property {boolean} [shadow]
 */

/**
 * @param {number} x
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

/**
 * @param {unknown} v
 * @param {number} [lo]
 * @param {number} [hi]
 * @returns {number}
 */
function _norm(v, lo = 0, hi = 1) {
  if (typeof v !== 'number' || !isFinite(/** @type {number} */ (v))) return 0;
  return clamp((v - lo) / (hi - lo), 0, 1);
}

const DEFAULT_POLICY = {
  weights: {
    severity: 0.4, // qué tan grave es (0=info, 1=crítico)
    actionability: 0.25, // cuánto puede el asistente ayudar de verdad
    salience: 0.25, // qué tan ligado a lo que el usuario hace AHORA
    costOfIgnore: 0.1, // cuánto cuesta no actuar (secreto expuesto)
  },
  thresholds: {
    act: 0.6, // R ≥ act + buen momento → ACT NOW
    queue: 0.35, // R ≥ queue + mal momento → QUEUE
    escalate: 0.8, // R ≥ escalate (crítica) → salta presupuesto normal
    promoteBy: 0.15, // histéresis: re-promocionar exige R más alta
  },
  receptivity: {
    alpha: 0.25, // suavizado EMA (outcome)
    accepted: +1.0, // aceptó → sube
    rejected: -0.6, // rechazó → baja
    ignored: -0.4, // no tocó la propuesta → baja un poco
    decayPerHour: 0.03, // tendencia al neutro con el paso del tiempo
  },
  budget: {
    base: 12, // neutro (receptividad 0) → 12 iniciativas/día
    min: 2,
    max: 20,
  },
  // F-G: aprendizaje por tipo. El historial de aceptación/rechazo que persiste
  // ProposalStore retroalimenta el scoring: un tipo bien recibido sube su R, un
  // tipo rechazado seguido la baja. Requiere un mínimo de muestras (evita
  // aprender de un único dato) y está acotado para no descalibrar el gate.
  learning: {
    minSamples: 3, // decisiones registradas antes de que el ajuste actúe
    maxBias: 0.1, // sesgo máximo por ratio de aceptación (±)
    perRejectPenalty: 0.02, // por cada rechazo consecutivo
    maxRejectsTracked: 4, // topes de la penalidad por rechazos en fila
  },
};

/**
 * F-1. Score de relevancia de una señal ya normalizada (F-2).
 * @param {RelevancySignal} [signal] alguna señal ya normalizada (F-2)
 * @param {ProactivePolicy} [policy] override parcial de DEFAULT_POLICY
 * @returns {number} R ∈ [0,1]
 */
function scoreRelevancia(signal = {}, policy = {}) {
  signal = signal || {};
  /** @type {Required<WeightsConfig>} */
  const w = { ...DEFAULT_POLICY.weights, ...(policy.weights || {}) };
  const s = {
    severity: _norm(signal.severity),
    actionability: _norm(signal.actionability),
    salience: _norm(signal.salience),
    costOfIgnore: _norm(signal.costOfIgnore),
  };
  return clamp(
    w.severity * s.severity +
      w.actionability * s.actionability +
      w.salience * s.salience +
      w.costOfIgnore * s.costOfIgnore,
    0,
    1
  );
}

/**
 * F-1. Receptividad del usuario (EMA con decaimiento temporal).
 * @param {number | null} [prev]             Rec anterior ∈ [-1,1] (null = neutro 0)
 * @param {ReceptivityOutcome} [outcome]     { accepted?, rejected?, ignored? }
 * @param {number} [hoursSincePrev]          horas desde el último outcome (decaimiento)
 * @param {ProactivePolicy} [policy]
 * @returns {number} Rec ∈ [-1,1]
 */
function receptividad(prev, outcome = {}, hoursSincePrev = 0, policy = {}) {
  /** @type {Required<ReceptivityConfig>} */
  const rp = { ...DEFAULT_POLICY.receptivity, ...(policy.receptivity || {}) };
  let base = typeof prev === 'number' && isFinite(prev) ? prev : 0;

  if (hoursSincePrev > 0) {
    base *= Math.exp(-rp.decayPerHour * hoursSincePrev);
  }

  // Sin decisión del usuario: solo el decaimiento temporal mueve Rec.
  const hasOutcome = !!(outcome.accepted || outcome.rejected || outcome.ignored);
  if (!hasOutcome) return clamp(base, -1, 1);

  const delta = outcome.accepted ? rp.accepted : outcome.rejected ? rp.rejected : rp.ignored;
  return clamp(base + rp.alpha * (delta - base), -1, 1);
}

/**
 * F-1. Presupuesto dinámico diario según la receptividad.
 * @param {number} rec                    Rec ∈ [-1,1]
 * @param {ProactivePolicy} [policy]
 * @returns {number} presupuesto entero ∈ [min, max]
 */
function presupuesto(rec, policy = {}) {
  /** @type {Required<BudgetConfig>} */
  const b = { ...DEFAULT_POLICY.budget, ...(policy.budget || {}) };
  const norm = _norm(rec, -1, 1); // [-1,1] → [0,1]
  const target = b.base * (0.4 + 1.2 * norm); // neutro (0.5) → base
  return Math.round(clamp(target, b.min, b.max));
}

/**
 * F-G. Ajuste de la relevancia por aprendizaje del tipo (aceptación/rechazo).
 *
 * El historial que persiste ProposalStore por tipo retroalimenta el scoring:
 *   - sin suficientes muestras → devuelve R sin tocar (no aprende de un dato).
 *   - con muestras → un ratio alto de aceptación suma hasta +maxBias, y cada
 *     rechazo consecutivo resta hasta perRejectPenalty × maxRejectsTracked.
 *
 * Es un sesgo acotado y determinista (mismo historial → mismo ajuste); los
 * pesos del gate siguen viviendo en DEFAULT_POLICY, calibráveis sin código.
 *
 * @param {number} R                score base de scoreRelevancia ∈ [0,1]
 * @param {TypeOutcomeStats} [stats]  { accepted, rejected, ignored, rejectsInRow }
 * @param {ProactivePolicy} [policy]  override parcial de DEFAULT_POLICY
 * @returns {number} R ajustado ∈ [0,1]
 */
function ajustarScorePorAprendizaje(R, stats = {}, policy = {}) {
  if (typeof R !== 'number' || !isFinite(R)) return 0;
  if (!stats || typeof stats !== 'object') return R;
  /** @type {Required<LearningConfig>} */
  const lp = { ...DEFAULT_POLICY.learning, ...(policy.learning || {}) };
  const accepted = stats.accepted || 0;
  const rejected = stats.rejected || 0;
  const ignored = stats.ignored || 0;
  const total = accepted + rejected + ignored;
  if (total < lp.minSamples) return R;

  const acceptRatio = total > 0 ? accepted / total : 0;
  // Ratio [0,1] → sesgo lineal [−maxBias, +maxBias] centrado en 0.5.
  let bias = lp.maxBias * (2 * acceptRatio - 1);
  // Penalidad por rechazos consecutivos: el usuario se está cansando del tipo.
  const rejectsInRow = Math.min(stats.rejectsInRow || 0, lp.maxRejectsTracked);
  bias -= rejectsInRow * lp.perRejectPenalty;
  return clamp(R + bias, 0, 1);
}

/**
 * Fase 3, ítem 2 — deriveWeights: recalcula los pesos de scoring desde el
 * feedback acumulado de proactividad (cierra el círculo feedback→pesos→gate).
 *
 * A diferencia de `ajustarScorePorAprendizaje` (sesgo puntual por tipo), esto
 * recalibra los PESOS del modelo de relevancia: con suficientes decisiones,
 * un tono de aceptación alto sube ligeramente el peso de los componentes
 * "pro-activos" (actionability/salience) y un tono bajo los reduce (el gate
 * exige señales más fuertes antes de ACT). Es determinista, acotado (±20%) y
 * se normaliza para que la suma siga siendo 1. Sin muestras suficientes
 * devuelve los pesos por defecto (identidad — no cambia el comportamiento
 * existente).
 *
 * @param {DeriveStatsLike} [stats]  { byType: { [tipo]: TypeOutcomeStats } } de ProposalStore
 * @param {ProactivePolicy} [policy] override parcial de DEFAULT_POLICY
 * @returns {WeightsConfig}
 */
function deriveWeights(stats = {}, policy = {}) {
  /** @type {Required<WeightsConfig>} */
  const base = { ...DEFAULT_POLICY.weights, ...(policy.weights || {}) };
  /** @type {Required<LearningConfig>} */
  const lp = { ...DEFAULT_POLICY.learning, ...(policy.learning || {}) };
  /** @type {Object<string, TypeOutcomeStats>} */
  const byType = (stats && stats.byType) || stats || {};
  let accepted = 0;
  let total = 0;
  for (const t of Object.values(byType)) {
    if (!t || typeof t !== 'object') continue;
    accepted += t.accepted || 0;
    total += (t.accepted || 0) + (t.rejected || 0) + (t.ignored || 0);
  }
  if (total < lp.minSamples) return { ...base };

  // [0,1] → tone ∈ [-1,1] (0.5 = neutro → pesos por defecto).
  const tone = clamp((accepted / total - 0.5) * 2, -1, 1);
  const adjust = /** @type {(v: number) => number} */ (
    (v) => clamp(v * (1 + 0.2 * tone), 0.05, 0.9)
  );
  const w = {
    severity: base.severity,
    actionability: adjust(base.actionability),
    salience: adjust(base.salience),
    costOfIgnore: base.costOfIgnore,
  };
  const sum = w.severity + w.actionability + w.salience + w.costOfIgnore;
  return {
    severity: w.severity / sum,
    actionability: w.actionability / sum,
    salience: w.salience / sum,
    costOfIgnore: w.costOfIgnore / sum,
  };
}

// ── Reason codes ────────────────────────────────────────────────────────────

const REASON = {
  HIGH_VALUE_GOOD_MOMENT: 'GATE3_ACT_HIGH_VALUE',
  QUEUED_BAD_MOMENT: 'GATE2_QUEUE_BAD_MOMENT',
  DROP_LOW_RELEVANCE: 'GATE1_DROP_LOW_RELEVANCE',
  DROP_BUDGET_EXHAUSTED: 'GATE2_DROP_BUDGET_EXHAUSTED',
  DROP_DEGRADED: 'GATE2_DROP_DEGRADED',
  DROP_NOT_PRESENT: 'GATE2_DROP_NOT_PRESENT',
  ESCALATE_CRITICAL: 'GATE3_ESCALATE_CRITICAL',
  DROP_NO_CRITERION: 'GATE1_DROP_NO_CRITERION',
  // Cupo diario de curiosidad agotado: presupuesto SEPARADO del general
  // (GATE2_DROP_BUDGET_EXHAUSTED), ver core/behavior/proactive/config.js.
  DROP_CURIOSITY_CAP: 'GATE2_DROP_CURIOSITY_CAP',
  // Curiosidad admitida (cupo disponible): SELF_GATED_ADMIT pero para los tipos
  // memory_stale/pattern_uncertain/memory_tension. El score es solo informativo.
  CURIOSITY_ADMIT: 'GATE3_ACT_CURIOSITY',
  // Trigger temporal (F-4): su condición ya validó el momento, el gate solo
  // impone presupuesto y SLO → admit directo, pero con audit propio.
  SELF_GATED_ADMIT: 'GATE3_ACT_SELF_GATED',
};

/**
 * F-1. Política de decisión con histéresis.
 * @param {DecideContext} [ctx]
 * @param {ProactivePolicy} [policy]
 * @returns {Decision}
 */
function decide(ctx = {}, policy = {}) {
  /** @type {Required<ThresholdsConfig>} */
  const th = { ...DEFAULT_POLICY.thresholds, ...(policy.thresholds || {}) };
  const R = _norm(ctx.relevance);
  const budgetUsed = ctx.budgetUsed ?? 0;
  const budgetLimit = ctx.budgetLimit ?? Infinity;

  // Crítica: salta el presupuesto normal, jamás salta "¿está el usuario?".
  if (ctx.isCritical && R >= th.escalate) {
    if (ctx.userPresent === false) {
      return {
        verdict: 'QUEUE',
        reason: REASON.QUEUED_BAD_MOMENT,
        relevance: R,
        decisionId: _id(),
      };
    }
    return {
      verdict: 'ESCALATE',
      reason: REASON.ESCALATE_CRITICAL,
      relevance: R,
      decisionId: _id(),
    };
  }

  // Presupuesto normal agotado (no aplica a críticas).
  if (budgetUsed >= budgetLimit) {
    return {
      verdict: 'DROP',
      reason: REASON.DROP_BUDGET_EXHAUSTED,
      relevance: R,
      decisionId: _id(),
    };
  }

  // Histéresis: un tipo degradado necesita superar un umbral más alto.
  const actThreshold = ctx.degraded ? th.act + th.promoteBy : th.act;

  if (R >= actThreshold && ctx.goodMoment !== false) {
    return {
      verdict: 'ACT',
      reason: REASON.HIGH_VALUE_GOOD_MOMENT,
      relevance: R,
      decisionId: _id(),
    };
  }

  if (R >= th.queue) {
    return { verdict: 'QUEUE', reason: REASON.QUEUED_BAD_MOMENT, relevance: R, decisionId: _id() };
  }

  if (ctx.userPresent === false) {
    return { verdict: 'QUEUE', reason: REASON.QUEUED_BAD_MOMENT, relevance: R, decisionId: _id() };
  }

  return { verdict: 'DROP', reason: REASON.DROP_LOW_RELEVANCE, relevance: R, decisionId: _id() };
}

// ── Audit log (transversal) ──────────────────────────────────────────────────

/**
 * @returns {string}
 */
function _id() {
  return `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Auditoría circular en memoria: cada decisión deja un rastro traceable.
 * El PRODUCTOR (ProactiveEngine/sensores) llama a `push()`; el sistema puede
 * consultar el historial vía Control API / audit log.
 */
class AuditLog {
  /**
   * @param {{ maxEntries?: number }} [options]
   */
  constructor({ maxEntries = 2000 } = {}) {
    this._max = maxEntries;
    /** @type {AuditEntry[]} */
    this._entries = [];
  }

  /**
   * @param {AuditEntryInput} [entry]
   * @returns {AuditEntry}
   */
  push(entry = {}) {
    const e = {
      ts: Date.now(),
      sensor: entry.sensor || null,
      type: entry.type || null,
      kind: entry.kind || null,
      signal: entry.signal || null,
      scores: entry.scores || null,
      score: entry.score ?? null, // F-1: R (relevancia) calculada
      flow: entry.flow || null, // F-3: idle/active/deep
      context: entry.context || null,
      verdict: entry.verdict || null,
      reason: entry.reason || null,
      outcome: entry.outcome || null, // accepted/rejected/ignored (F-4)
      decisionId: entry.decisionId || null,
      shadow: !!entry.shadow,
    };
    this._entries.push(e);
    if (this._entries.length > this._max) {
      this._entries.splice(0, this._entries.length - this._max);
    }
    return e;
  }

  /**
   * @param {{ limit?: number, type?: string | null, verdict?: string | null }} [opts]
   * @returns {AuditEntry[]}
   */
  getEntries({ limit = 100, type = null, verdict = null } = {}) {
    let list = this._entries;
    if (type) list = list.filter((e) => e.type === type);
    if (verdict) list = list.filter((e) => e.verdict === verdict);
    return list.slice(-limit);
  }

  /**
   * @returns {{ total: number, byVerdict: Record<string, number>, byReason: Record<string, number> }}
   */
  getStats() {
    /** @type {Record<string, number>} */
    const byVerdict = {};
    /** @type {Record<string, number>} */
    const byReason = {};
    for (const e of this._entries) {
      const v = /** @type {string} */ (e.verdict);
      const r = /** @type {string} */ (e.reason);
      byVerdict[v] = (byVerdict[v] || 0) + 1;
      byReason[r] = (byReason[r] || 0) + 1;
    }
    return { total: this._entries.length, byVerdict, byReason };
  }

  reset() {
    this._entries = [];
  }
}

module.exports = {
  DEFAULT_POLICY,
  REASON,
  clamp,
  scoreRelevancia,
  ajustarScorePorAprendizaje,
  deriveWeights,
  receptividad,
  presupuesto,
  decide,
  AuditLog,
};
