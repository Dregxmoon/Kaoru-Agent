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
  GLOBAL_MIN_GAP_MS,
  DAILY_BUDGET,
  TRIGGER_COOLDOWN_MS,
  MAX_IDLE_TO_INTERRUPT,
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

    const now = Date.now();
    const ctx = this._buildGateContext(now);
    const baseScore = scoreRelevancia(candidate.signal);
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
        console.log(
          `[proactive][shadow] gate: ${gate.verdict} (${gate.reason}) score=${gate.score?.toFixed(3)} — sin enviar`
        );
        return { blocked: true, shadow: true, gate };
      }
      if (gate.verdict === 'DROP' || gate.verdict === 'QUEUE') {
        console.log(
          `[proactive] gate: ${gate.verdict} (${gate.reason}) score=${gate.score?.toFixed(3)} — ${gate.verdict === 'QUEUE' ? 'diferido' : 'silencio'}`
        );
        return { blocked: true, gate };
      }
      // ACT / ESCALATE → el LLM produce el mensaje (no decide si intervenir).
      trigger._gate = gate;
    }

    // No interrumpir si el usuario está EN MEDIO de una conversación real
    // (habló hace < 2 min). El chat abierto por sí solo NO bloquea: es el
    // canal donde se muestran las propuestas (ventana principal de la app).
    if (this._lastUserMsg && now - this._lastUserMsg < RECENT_CHAT_MS) return { blocked: true };

    // Ajusta el gap mínimo según qué tan receptivo esté el usuario
    const adjustedGap = Math.round(
      GLOBAL_MIN_GAP_MS * (1 - (this._currentProactiveScore - 0.3) * 0.5)
    );
    if (now - this._lastProactive < adjustedGap) return { blocked: true };

    // Fase C: presupuesto diario duro — si ya se gastaron todas las
    // iniciativas de hoy, se frena ANTES de consultar al LLM (el silencio es
    // respeto). El recuento se hace solo sobre envíos reales.
    if (this._store && this._store.dailyCount() >= DAILY_BUDGET) {
      console.log(
        `[proactive] presupuesto diario agotado (${this._store.dailyCount()}/${DAILY_BUDGET})`
      );
      return { blocked: true };
    }

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

    this._lastAttemptByType[trigger.type] = now;
    this._deciding = true;
    console.log(`[proactive] trigger: ${trigger.type} — consultando LLM...`);

    try {
      const message = await this._generateMessage(trigger);
      if (!message) {
        console.log('[proactive] LLM decidió no enviar mensaje');
        return null;
      }

      this._lastProactive = Date.now();
      this._lastProactiveMessage = message;
      this._lastProactiveTrigger = trigger.type;

      // Fase C: un envío real gasta presupuesto del día (solo cuando el LLM
      // dio el OK — los intentos bloqueados/frustrados no cuentan).
      if (this._store) this._store.incrementDaily();

      const payload = await this._buildPayload(trigger, message);

      console.log(`[proactive] emitiendo: "${message.slice(0, 60)}..."`);
      this._bus.emit('initiative:trigger', payload);

      // F-5: rastrear la propuesta enviada para marcarla "ignored" si el
      // usuario no responde en el plazo. Solo las que tienen proposalId.
      if (payload.proposalId) {
        this._sentFeedback.set(payload.proposalId, { type: trigger.type, at: Date.now() });
        this._markIgnoredStale();
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
