'use strict';

/**
 * F-3 — Gate de contexto.
 *
 * Decide SI un candidato normalizado (F-2) llega a molestar al usuario, usando
 * las funciones puras del núcleo (F-1) + contexto en vivo del motor:
 *
 *   - Flow detection: nivel de inmersión (idle / active / deep) según cuánto
 *     tiempo lleva la app actual y si hay thrashing de contexto.
 *   - Presupuesto dinámico: Budget(t) = clamp(base · rec_norm, min, max) — se
 *     calcula con `presupuesto(receptividad)` del núcleo.
 *   - Cola QUEUE: los candidatos "buenos pero mal momento" no se pierden, se
 *     difieren y se reintentan cuando el contexto mejora.
 *
 * Resultado de `evaluate(candidato, contexto)`:
 *   - { admit: true, decision }  → pasar a producción (LLM genera el mensaje).
 *   - { admit: false, decision, queue: true } → difiere (se reintenta).
 *   - { admit: false, decision } → descartar (DROP), no se reintenta.
 *
 * El gate es determinista dado (candidato, contexto): la calibración se hace
 * por política, no en esta clase.
 */

const { decide, presupuesto, REASON, DEFAULT_POLICY } = require('./DecisionCore.js');

const FLOW = {
  IDLE:   'idle',     // AFK o sin actividad reciente → no molestar salvo crítico
  ACTIVE: 'active',   // trabajando normalmente → se puede proponer si el score lo justifica
  DEEP:   'deep',     // inmerso (app actual > N min, sin thrashing) → barra alta
};

const DEFAULT_GATE_POLICY = {
  // Umbral de minutos con la misma app para considerar "deep flow".
  deepFlowAppMin: 15,
  // Ventana (ms) en la que una racha de cambios de app = thrashing.
  thrashWindowMs: 2 * 60 * 1000,
  // Nº de cambios de app en la ventana para marcar thrashing.
  thrashThreshold: 6,
  // Tiempo de vida máximo de un candidato en cola (ms) antes de caducar.
  queueTtlMs: 60 * 60 * 1000,
  // Reintentos máximos antes de soltar el candidato (aunque siga siendo válido).
  queueMaxRetries: 3,
  // En flow profundo, exige un bonus extra de relevancia para ACT.
  // Se materializa como `promoteBy` de la política del núcleo (F-1).
  deepFlowRBonus: 0.15,
  // Si el usuario acaba de hablar (ms), no interrumpir nunca.
  recentChatMs: 2 * 60 * 1000,
  // Candidatos con score menor a esto nunca se envían (piso de silencio).
  floorRelevance: 0.4,
};

/**
 * Nivel de flow a partir del contexto del motor.
 */
function detectFlow(context = {}, policy = DEFAULT_GATE_POLICY) {
  const { idleSecs = 0, appElapsedSec = 0, recentSwitches = [], now = Date.now() } = context;

  if (idleSecs > 60) return { level: FLOW.IDLE, reason: 'idle' };

  const switches = (recentSwitches || []).filter(s => now - s.ts <= policy.thrashWindowMs);
  const thrashing = switches.length >= policy.thrashThreshold;

  if (appElapsedSec >= policy.deepFlowAppMin * 60 && !thrashing) {
    return { level: FLOW.DEEP, reason: 'immersed' };
  }
  return { level: FLOW.ACTIVE, reason: thrashing ? 'thrashing' : 'active' };
}

/**
 * Presupuesto dinámico según la receptividad acumulada.
 * `receptivity` en [-1,1]; null → neutro.
 */
function dynamicBudget(receptivity = null, policy = DEFAULT_GATE_POLICY) {
  return presupuesto(receptivity, { budget: policy.budget });
}

/**
 * Gate de contexto: filtra candidatos en frío (sin LLM) y difiere los QUEUE.
 */
function evaluate(candidate, context = {}, policy = DEFAULT_GATE_POLICY) {
  if (!candidate) return { admit: false, reason: 'no_candidate' };

  const now = context.now ?? Date.now();

  // 1) Flow detection (para selfGated es solo informativo en el audit).
  const flow = detectFlow(context, policy);

  // 2) Presupuesto dinámico.
  const budgetLimit = dynamicBudget(context.receptivity ?? 0, policy);
  const budgetUsed = context.budgetUsed ?? 0;
  const withinBudget = budgetUsed < budgetLimit;

  // 3) SLO degradation (F-5).
  const degraded = context.degradedTypes?.has?.(candidate.tipo) ?? false;

  // ── Triggers temporales (selfGated, F-4 / Gap 2) ──────────────────────────
  // long_silence, return_from_break, special_date... su condición de disparo ya
  // validó el momento (horas de silencio, vuelta de pausa, fecha especial). El
  // gate aquí NO re-valida chat/idle/flow — solo impone presupuesto y SLO. Con
  // eso cada mensaje temporal queda con score + audit (ROADMAP).
  if (candidate.selfGated) {
    if (!withinBudget) {
      return { admit: false, decision: { verdict: 'DROP', reason: REASON.DROP_BUDGET_EXHAUSTED, relevance: candidate.score ?? 0, flow: flow.level }, flow: flow.level, budgetLimit };
    }
    if (degraded) {
      return { admit: false, decision: { verdict: 'DROP', reason: REASON.DROP_DEGRADED, relevance: candidate.score ?? 0, flow: flow.level }, flow: flow.level, budgetLimit };
    }
    return { admit: true, decision: { verdict: 'ACT', reason: REASON.SELF_GATED_ADMIT, relevance: candidate.score ?? 0, flow: flow.level }, flow: flow.level, budgetLimit };
  }

  const userPresent = !context.chatOpen && (context.lastUserMsg == null || now - context.lastUserMsg > policy.recentChatMs);

  // 4) Relevancia desde el vector de señal del candidato (F-1).
  const relevance = candidate.score ?? 0;
  if (relevance < policy.floorRelevance) {
    return { admit: false, decision: { verdict: 'DROP', reason: 'below_floor', relevance, flow: flow.level }, queue: false };
  }

  // 5) Decisión del núcleo. En flow profundo exigimos más relevancia: se
  //    sube el umbral de re-promoción (histéresis) vía la política del núcleo.
  //    Un tipo DEGRADADO por SLO (F-5) también se promociona más difícil.
  const degradedGate = flow.level === FLOW.DEEP || degraded;
  const decision = decide({
    relevance,
    goodMoment: userPresent && withinBudget && flow.level !== FLOW.IDLE,
    isCritical: !!candidate.isCritical,
    userPresent,
    budgetUsed,
    budgetLimit,
    degraded: degradedGate,
  }, {
    thresholds: degradedGate
      ? { promoteBy: Math.max(policy.deepFlowRBonus, context.degradedBonus ?? 0) }
      : undefined,
  });

  if (decision.verdict === 'ACT' || decision.verdict === 'ESCALATE') {
    return { admit: true, decision, flow: flow.level, budgetLimit };
  }
  if (decision.verdict === 'QUEUE') {
    return { admit: false, decision, flow: flow.level, queue: true };
  }
  return { admit: false, decision, flow: flow.level, queue: false };
}

/**
 * Cola de diferidos: candidatos QUEUE que se reintentan al mejorar el contexto.
 * Circular con TTL y límite de reintentos para no acumular ruido.
 */
class QueueStore {
  constructor(policy = DEFAULT_GATE_POLICY) {
    this._items = [];
    this._max = 20;
    this._ttl = policy.queueTtlMs;
    this._maxRetries = policy.queueMaxRetries;
  }

  /** Encola un candidato diferido. Devuelve false si ya estaba (dedupe por tipo+kind). */
  push(candidate, context = {}) {
    if (!candidate) return false;
    if (this._items.some(i => i.candidate.tipo === candidate.tipo && i.candidate.kind === candidate.kind)) {
      return false;
    }
    if (this._items.length >= this._max) this._items.shift();
    this._items.push({ candidate, queuedAt: context.now ?? Date.now(), retries: 0 });
    return true;
  }

  /**
   * Devuelve los candidatos listos para reintentar según el contexto actual.
   * Caduca los que superan TTL o reintentos; si el contexto sigue malo, se
   * quedan (sin quemar reintento) hasta que pase el gate.
   */
  poll(context = {}) {
    const now = context.now ?? Date.now();
    const ready = [];
    this._items = this._items.filter((item) => {
      if (now - item.queuedAt > this._ttl) return false;
      if (item.retries >= this._maxRetries) return false;

      // Re-evalúa el candidato con el contexto actual, sin consumir reintento
      // a menos que el gate diga "adelante" (admit) — así un mal momento
      // persistente no quema reintentos.
      const gate = evaluate(item.candidate, context);
      if (gate.admit) {
        item.retries += 1;
        ready.push({ candidate: item.candidate, decision: gate.decision });
        return false; // se saca de la cola
      }
      if (gate.queue) {
        item.retries += 1; // el gate lo volvió a diferir → cuenta como intento
      }
      return true;
    });
    return ready;
  }

  size() { return this._items.length; }
  clear() { this._items = []; }
  entries() { return [...this._items]; }
}

module.exports = { evaluate, detectFlow, dynamicBudget, QueueStore, FLOW, DEFAULT_GATE_POLICY };
