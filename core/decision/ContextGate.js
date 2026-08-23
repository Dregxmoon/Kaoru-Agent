// @ts-nocheck
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

const { decide, presupuesto, REASON } = require('./DecisionCore.js');
// CURIOSITY_DAILY_CAP / CURIOSITY_TYPES: el cupo diario de preguntas de
// curiosidad sobre la memoria (hechos stale, inferencias de confianza media,
// contradicciones) vive en proactive/config.js — NO hay un tercer lugar de
// config. Separado del presupuesto general.
const { CURIOSITY_DAILY_CAP, CURIOSITY_TYPES, WORK_SIGNAL_TYPES, WORK_DAILY_CAP } = require(
  '../behavior/proactive/config.js'
);

const FLOW = {
  IDLE: 'idle', // AFK o sin actividad reciente → no molestar salvo crítico
  ACTIVE: 'active', // trabajando normalmente → se puede proponer si el score lo justifica
  DEEP: 'deep', // inmerso (app actual > N min, sin thrashing) → barra alta
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
  // Chat ABIERTO pero sin actividad del usuario por más de esto (ms) → deja
  // de contar como "conversación activa" y se puede proponer. El chat abierto
  // solo bloquea mientras el usuario está chateando de verdad; un chat
  // dormido es el canal natural de los mensajes proactivos.
  chatIdleMs: 5 * 60 * 1000,
  // Candidatos con score menor a esto nunca se envían (piso de silencio).
  floorRelevance: 0.4,
  // Cupo diario de curiosidad (preguntas sobre memoria). Vale el de
  // proactive/config.js; se puede overridear por política (tests).
  curiosityDailyCap: CURIOSITY_DAILY_CAP,
};

/**
 * Nivel de flow a partir del contexto del motor.
 */
function detectFlow(context = {}, policy = DEFAULT_GATE_POLICY) {
  const { idleSecs = 0, appElapsedSec = 0, recentSwitches = [], now = Date.now() } = context;

  if (idleSecs > 60) return { level: FLOW.IDLE, reason: 'idle' };

  const switches = (recentSwitches || []).filter((s) => now - s.ts <= policy.thrashWindowMs);
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

  // 2) Presupuesto dinámico general.
  const budgetLimit = dynamicBudget(context.receptivity ?? 0, policy);
  const budgetUsed = context.budgetUsed ?? 0;
  // Cupo de curiosidad: PRESUPUESTO PROPIO, independiente del general. Un día
  // con mucha proactividad de código no agota la curiosidad, y viceversa.
  const curiosityType = CURIOSITY_TYPES.has(candidate.tipo);
  const curiosityCap = policy.curiosityDailyCap ?? CURIOSITY_DAILY_CAP;
  const curiosityUsed = context.curiosityUsed ?? 0;

  // Cupo de TRABAJO (lsp_error y afines): también propio. Un error real en el
  // código del usuario NO muere porque se agotara el presupuesto charlando.
  const workType = WORK_SIGNAL_TYPES.has(candidate.tipo);
  const workCap = policy.workDailyCap ?? WORK_DAILY_CAP;
  const workWithinBudget = workType ? (context.workUsed ?? 0) < workCap : true;

  const withinBudget = curiosityType
    ? curiosityUsed < curiosityCap
    : workType
      ? workWithinBudget
      : budgetUsed < budgetLimit;

  // Cupo de curiosidad agotado → DROP determinista aunque sobre presupuesto
  // general (y aunque la relevancia sea alta): es un cupo propio.
  if (curiosityType && !withinBudget) {
    return {
      admit: false,
      decision: {
        verdict: 'DROP',
        reason: REASON.DROP_CURIOSITY_CAP,
        relevance: candidate.score ?? 0,
        flow: flow.level,
      },
      flow: flow.level,
      budgetLimit,
    };
  }

  // Cupo de trabajo agotado → DROP con razón propia (6/día evita acoso, pero
  // es INDEPENDIENTE del presupuesto general de charla).
  if (workType && !workWithinBudget) {
    return {
      admit: false,
      decision: {
        verdict: 'DROP',
        reason: 'work_cap_exhausted',
        relevance: candidate.score ?? 0,
        flow: flow.level,
      },
      flow: flow.level,
      budgetLimit,
    };
  }

  // 3) SLO degradation (F-5).
  const degraded = context.degradedTypes?.has?.(candidate.tipo) ?? false;

  // ── Triggers auto-validados (F-4 / Gap 2) ─────────────────────────────────
  // long_silence, return_from_break, special_date... su condición de disparo ya
  // validó el momento (horas de silencio, vuelta de pausa, fecha especial). El
  // gate aquí NO re-valida chat/idle/flow — solo impone presupuesto y SLO. Con
  // eso cada mensaje temporal queda con score + audit (ROADMAP).
  //
  // CURIOSIDAD (memory_stale/pattern_uncertain/memory_tension): el mixin la
  // evalúa una vez por heartbeat en un momento de baja fricción y el boost de
  // saliencia ya priorizó contexto; NADA gana con el piso de relevancia ni con
  // el flow (el cooldown de 6h por tipo y el cupo diario son los que evitan el
  // acoso). Un extraño "dato conocido" NO es ruido a silenciar por score: es
  // contenido a explorar → bypass del piso (mismo trato que los selfGated).
  const selfValidated = candidate.selfGated || curiosityType;
  if (selfValidated) {
    if (!withinBudget) {
      return {
        admit: false,
        decision: {
          verdict: 'DROP',
          reason: REASON.DROP_BUDGET_EXHAUSTED,
          relevance: candidate.score ?? 0,
          flow: flow.level,
        },
        flow: flow.level,
        budgetLimit,
      };
    }
    if (degraded) {
      return {
        admit: false,
        decision: {
          verdict: 'DROP',
          reason: REASON.DROP_DEGRADED,
          relevance: candidate.score ?? 0,
          flow: flow.level,
        },
        flow: flow.level,
        budgetLimit,
      };
    }
    return {
      admit: true,
      decision: {
        verdict: 'ACT',
        reason: curiosityType ? REASON.CURIOSITY_ADMIT : REASON.SELF_GATED_ADMIT,
        relevance: candidate.score ?? 0,
        flow: flow.level,
      },
      flow: flow.level,
      budgetLimit,
    };
  }

  // "Usuario presente" = no está chateando AHORA. El chat ABIERTO por sí solo
  // NO bloquea (es el canal donde se muestran las propuestas — ver comentario
  // en gate.js): bloquea mientras haya actividad reciente (recentChatMs) o si
  // el chat está abierto con menos de chatIdleMs de silencio.
  const chatQuiet =
    !context.chatOpen ||
    (context.lastUserMsg != null && now - context.lastUserMsg > policy.chatIdleMs);
  const userPresent =
    chatQuiet &&
    (context.lastUserMsg == null || now - context.lastUserMsg > policy.recentChatMs);

  // Exención de trabajo: un error LSP en el archivo ENFOCADO se reporta sin
  // importar el estado del chat — es exactamente el momento en que la ayuda
  // vale (estás programando, el error está en tu cara). Mantiene presupuesto,
  // cooldown del tipo y SLO; solo anula el bloqueo por estado de chat.
  // `focused` viaja dentro del payload del candidato (candidateFromTrigger).
  const workExempt =
    candidate.tipo === 'lsp_error' &&
    (candidate.focused === true || candidate.payload?.focused === true);

  // 4) Relevancia desde el vector de señal del candidato (F-1).
  const relevance = candidate.score ?? 0;
  if (relevance < policy.floorRelevance) {
    return {
      admit: false,
      decision: { verdict: 'DROP', reason: 'below_floor', relevance, flow: flow.level },
      queue: false,
    };
  }

  // 5) Decisión del núcleo. En flow profundo exigimos más relevancia: se
  //    sube el umbral de re-promoción (histéresis) vía la política del núcleo.
  //    Un tipo DEGRADADO por SLO (F-5) también se promociona más difícil.
  const degradedGate = flow.level === FLOW.DEEP || degraded;
  const decision = decide(
    {
      relevance,
      goodMoment:
        workExempt || (userPresent && withinBudget && flow.level !== FLOW.IDLE),
      isCritical: !!candidate.isCritical,
      userPresent,
      // Señales de trabajo: su cupo propio ya se validó arriba — el
      // presupuesto general agotado NO las mata (score 0.91 DROP fue el bug).
      budgetUsed: workType ? 0 : budgetUsed,
      budgetLimit,
      degraded: degradedGate,
    },
    {
      thresholds: degradedGate
        ? { promoteBy: Math.max(policy.deepFlowRBonus, context.degradedBonus ?? 0) }
        : undefined,
    }
  );

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
    if (
      this._items.some(
        (i) => i.candidate.tipo === candidate.tipo && i.candidate.kind === candidate.kind
      )
    ) {
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

  size() {
    return this._items.length;
  }
  clear() {
    this._items = [];
  }
  entries() {
    return [...this._items];
  }
}

module.exports = { evaluate, detectFlow, dynamicBudget, QueueStore, FLOW, DEFAULT_GATE_POLICY };
