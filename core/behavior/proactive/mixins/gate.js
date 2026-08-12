// @ts-nocheck
const logger = require('../../../observability/Logger.js');
// gate.js — árbitro central de decisión: gate de contexto determinista
// (Fase F), filtros baratos (cooldowns, chat abierto, idle, presupuesto) y la
// consulta al LLM. El LLM produce el mensaje cuando el gate admite la señal.

const LLMProvider = require('../../../llm/LLMProvider.js');
const {
  scoreRelevancia,
  ajustarScorePorAprendizaje,
} = require('../../../decision/DecisionCore.js');
const { candidateFromTrigger } = require('../../../decision/SignalNormalizer.js');
const { evaluate: evaluateGate } = require('../../../decision/ContextGate.js');

const {
  RECENT_CHAT_MS,
  CONVO_ACTIVE_MIN_TURNS,
  CONVO_ACTIVE_WINDOW_MS,
  GLOBAL_MIN_GAP_MS,
  TRIGGER_COOLDOWN_MS,
  MAX_IDLE_TO_INTERRUPT,
  CURIOSITY_TYPES,
} = require('../config.js');

module.exports = {
  // ── Fase F: gate de contexto (determinista, sin LLM) ──────────────────────
  // El LLM deja de decidir SI intervenir: este gate (normalizador → score →
  // contexto → decisión) pone el criterio barato y traceable. El LLM solo
  // PRODUCE el mensaje cuando el gate admite la señal.
  //
  // Devuelve:
  //   - null            → el trigger no es señal de sensor (temporal/OS de
  //                       personalidad) → cae al comportamiento anterior.
  //   - { verdict: 'DROP', ... }    → silencio determinista (ni se consulta LLM).
  //   - { verdict: 'QUEUE', ... }   → buen candidato, mal momento → se difiere.
  //   - { verdict: 'ACT'|'ESCALATE', decisionId, score, ... } → el LLM produce.
  _evaluateTrigger(trigger) {
    const candidate = candidateFromTrigger(trigger);
    if (!candidate) return null;

    // Curiosidad: boost de saliencia calculado en GENERACIÓN (contexto de SO
    // relacionado con el hecho/inferencia), NO en el perfil estático. Se
    // aplica al vector ANTES de scoreRelevancia para que "justo estás en el
    // tema" suba la prioridad de preguntar.
    if (typeof trigger.salienceBoost === 'number' && trigger.salienceBoost > 0) {
      candidate.signal.salience = Math.max(
        0,
        Math.min(1, candidate.signal.salience + trigger.salienceBoost)
      );
      candidate.saliencia = candidate.signal.salience;
    }

    const now = Date.now();
    const ctx = this._buildGateContext(now);
    // Fase 3, ítem 2: pesos aprendidos por LearningEngine (feedback
    // recalibrado). Si los hay, el scoring usa la política ajustada en lugar
    // de la estática; sin ellos, es identidad.
    const learnedWeights = this._store?.getLearnedWeights?.() || null;
    const policyOverride = learnedWeights ? { weights: learnedWeights } : {};
    const baseScore = scoreRelevancia(candidate.signal, policyOverride);
    // F-G: aprendizaje por tipo — el historial de aceptación/rechazo que
    // persiste ProposalStore (por trigger.type) ajusta la relevancia. Sin
    // muestras suficientes devuelve la R base sin cambios.
    const typeStats = this._store?.getStats?.()?.byType?.[trigger.type] || null;
    const score = typeStats ? ajustarScorePorAprendizaje(baseScore, typeStats) : baseScore;
    candidate.score = score;

    const result = evaluateGate(candidate, ctx);
    const auditEntry = {
      sensor: candidate.source.sensor,
      type: candidate.tipo,
      kind: candidate.kind,
      signal: candidate.signal,
      score,
      verdict: result.decision.verdict,
      reason: result.decision.reason,
      decisionId: result.decision.decisionId,
      flow: result.flow,
      budgetLimit: result.budgetLimit,
      shadow: this._shadowMode,
      at: now,
    };
    this._audit.push(auditEntry);

    if (result.queue && !result.admit) {
      this._queue.push(candidate, { now });
    }

    return { ...result.decision, score, flow: result.flow, candidate };
  },

  _buildGateContext(now) {
    const osCtx = this._osSensor?.getCurrentContext?.() ?? {};
    return {
      now,
      chatOpen: this._chatOpen,
      lastUserMsg: this._lastUserMsg || 0,
      idleSecs: osCtx.idleSecs ?? 0,
      appElapsedSec: this._categoryStreakStart
        ? Math.round((now - this._categoryStreakStart) / 1000)
        : 0,
      recentSwitches: this._recentSwitches,
      budgetUsed: this._store?.dailyCount() ?? 0,
      receptivity: this._receptivity,
      // Cupo de curiosidad (separado del presupuesto general) — lo consume
      // ContextGate para los tipos memory_stale/pattern_uncertain/memory_tension.
      curiosityUsed: this._curiosityUsedToday(),
      // F-5: tipos degradados por SLO → el gate les sube el umbral de ACT.
      degradedTypes: this._store ? this._degradedTypes() : undefined,
    };
  },

  _degradedTypes() {
    const { porTipo } = this._sloStats();
    return new Set(
      Object.values(porTipo)
        .filter((t) => t.degraded)
        .map((t) => t.type)
    );
  },

  // Fase 5: ¿conversación ACTIVA? ≥ CONVO_ACTIVE_MIN_TURNS turnos del usuario
  // dentro de CONVO_ACTIVE_WINDOW_MS. Complementa el RECENT_CHAT_MS fijo: una
  // conversación real (aunque el usuario pause un rato a pensar) no se
  // interrumpe. Ventana adaptativa, no un timer de "último mensaje".
  _isConvoActive(now) {
    return (
      Array.isArray(this._recentUserTurns) &&
      this._recentUserTurns.filter((t) => now - t <= CONVO_ACTIVE_WINDOW_MS).length >=
        CONVO_ACTIVE_MIN_TURNS
    );
  },

  /**
   * Árbitro central. Devuelve:
   *   - { blocked: true }  → un pre-filtro lo frenó (chat abierto, cooldown,
   *                          idle, sin LLM, gap global, lock en curso). El
   *                          llamador NO debe consumir su oportunidad (racha,
   *                          cooldown por tipo) y puede reintentar más tarde.
   *   - null               → el LLM fue consultado y decidió no decir nada.
   *   - message (string)   → mensaje enviado.
   */
  async _tryTrigger(trigger) {
    if (!this._running) return { blocked: true }; // aún no arrancado (workspace/MCP en init)
    if (this._autonomyMode === 'observe') return { blocked: true }; // slider: solo observar
    if (this._deciding) return { blocked: true }; // ya hay una decisión en curso
    if (!LLMProvider.getActiveProvider()) return { blocked: true };

    const now = Date.now();

    // Fase F: el gate decide ANTES del LLM. En shadow mode el gate y el audit
    // corren, pero nunca se llega a consultar al LLM ni a enviar nada.
    const gate = this._evaluateTrigger(trigger);
    if (gate) {
      if (this._shadowMode) {
        logger.info(
          'gate',
          `[proactive][shadow] gate: ${gate.verdict} (${gate.reason}) score=${gate.score?.toFixed(3)} — sin enviar`
        );
        return { blocked: true, shadow: true, gate };
      }
      if (gate.verdict === 'DROP' || gate.verdict === 'QUEUE') {
        logger.info(
          'gate',
          `[proactive] gate: ${gate.verdict} (${gate.reason}) score=${gate.score?.toFixed(3)} — ${gate.verdict === 'QUEUE' ? 'diferido' : 'silencio'}`
        );
        return { blocked: true, gate };
      }
      // ACT / ESCALATE → el LLM produce el mensaje (no decide si intervenir).
      trigger._gate = gate;
    }

    // No interrumpir si el usuario está EN MEDIO de una conversación real. El
    // chat abierto por sí solo NO bloquea: es el canal donde se muestran las
    // propuestas (ventana principal de la app). Fase 5: además del mínimo fijo
    // (habló hace < 2 min), se bloquea si la conversación está ACTIVA — ≥ 3
    // turnos del usuario en los últimos 30 min — aunque haya pausado un rato
    // a pensar.
    const chatRecent = !!this._lastUserMsg && now - this._lastUserMsg < RECENT_CHAT_MS;
    if (chatRecent || this._isConvoActive(now)) return { blocked: true };

    // ESCALATE (señal crítica con R ≥ escalar): salta los guardas temporales
    // de no-molestia (gap global, cooldown del tipo y AFK). Un secreto a punto
    // de commitearse no debería esperar 6 h por la regla de su tipo. Sigue
    // pasando por el guard de conversación reciente: nunca se interrumpe a
    // mitad de un intercambio, ni siquiera para algo crítico.
    const isEscalate = trigger._gate?.verdict === 'ESCALATE';
    if (!isEscalate) {
      // Ajusta el gap mínimo según qué tan receptivo esté el usuario
      const adjustedGap = Math.round(
        GLOBAL_MIN_GAP_MS * (1 - (this._currentProactiveScore - 0.3) * 0.5)
      );
      if (now - this._lastProactive < adjustedGap) return { blocked: true };

      // Cooldown efectivo por tipo — crece si el usuario ha descartado este
      // tipo varias veces seguidas (Fase A: el rechazo enseña).
      const baseCooldown = TRIGGER_COOLDOWN_MS[trigger.type] ?? GLOBAL_MIN_GAP_MS;
      const cooldown = this._effectiveCooldownMs(trigger.type, baseCooldown);
      const lastAttempt = this._lastAttemptByType[trigger.type] || 0;
      if (now - lastAttempt < cooldown) return { blocked: true };

      // No interrumpir si lleva mucho AFK — excepto el trigger que ES,
      // precisamente, "acaba de volver de estar AFK".
      if (trigger.type !== 'return_from_break') {
        const idleSecs = this._osSensor?.getCurrentContext()?.idleSecs ?? 0;
        if (idleSecs > MAX_IDLE_TO_INTERRUPT) return { blocked: true };
      }
    }

    // Fase F: el presupuesto diario lo impone el gate dinámico
    // (ContextGate.evaluate → budgetLimit = dynamicBudget(receptividad)), que
    // puede subir hasta `DEFAULT_POLICY.budget.max` (20) con buena
    // receptividad. Aquí ya no hay tope estático duro (DAILY_BUDGET) que lo
    // anule — el recuento real solo se hace sobre envíos efectivos.

    this._lastAttemptByType[trigger.type] = now;
    this._deciding = true;
    logger.info('gate', `[proactive] trigger: ${trigger.type} — consultando LLM...`);

    try {
      const message = await this._generateMessage(trigger);
      if (!message) {
        logger.info('gate', '[proactive] LLM decidió no enviar mensaje');
        return null;
      }

      this._lastProactive = Date.now();
      this._lastProactiveMessage = message;
      this._lastProactiveTrigger = trigger.type;

      // Fase D: historial corto para anti-repetición real (últimos 5).
      this._recentProactive.push({ msg: message, trigger: trigger.type, at: Date.now() });
      if (this._recentProactive.length > 5) this._recentProactive.shift();

      // Fase C: un envío real gasta presupuesto del día (solo cuando el LLM
      // dio el OK — los intentos bloqueados/frustrados no cuentan). La
      // curiosidad tiene un cupo PROPIO y separado del general: un envío de
      // memory_stale/pattern_uncertain/memory_tension consume SOLO el cupo de
      // curiosidad (CURIOSITY_DAILY_CAP), nunca el presupuesto diario normal
      // (y viceversa).
      if (CURIOSITY_TYPES.has(trigger.type)) {
        this._envelopeCuriosityFired();
      } else if (this._store) {
        this._store.incrementDaily();
      }

      const payload = await this._buildPayload(trigger, message);

      // Hilo relacional: registro del mensaje enviado (para bookend y para el
      // registro adaptativo). El outcome lo rellena handleDecision/el barrido
      // de ignorados; tope acotado para que no crezca sin límite.
      this._relationLog.push({
        proposalId: payload.proposalId || null,
        trigger: trigger.type,
        msg: message,
        at: Date.now(),
        outcome: null, // pendiente: lo rellena handleDecision / el barrido de ignorados
      });
      if (this._relationLog.length > 40) this._relationLog.shift();

      logger.info('gate', `[proactive] emitiendo: "${message.slice(0, 60)}..."`);
      this._bus.emit('initiative:trigger', payload);

      // F-5: rastrear la propuesta enviada para marcarla "ignored" si el
      // usuario no responde en el plazo. El barrido de las vencidas lo hace el
      // heartbeat (_evaluateTimeBased → _markIgnoredStale) cada 5 min.
      if (payload.proposalId) {
        this._sentFeedback.set(payload.proposalId, { type: trigger.type, at: Date.now() });
      }

      return message;
    } finally {
      this._deciding = false;
    }
  },

  /** Factor de cooldown según rechazos consecutivos persistidos del tipo. */
  _effectiveCooldownMs(type, baseCooldown) {
    const factor = this._store?.cooldownMultiplier(type) ?? 1;
    return Math.round(baseCooldown * factor);
  },

  getCooldownFor(type) {
    const base = TRIGGER_COOLDOWN_MS[type] ?? GLOBAL_MIN_GAP_MS;
    return {
      base,
      effective: this._effectiveCooldownMs(type, base),
      factor: this._effectiveCooldownMs(type, base) / base,
    };
  },
};
