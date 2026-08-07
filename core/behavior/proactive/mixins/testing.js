// @ts-nocheck
const logger = require('../../../observability/Logger.js');
// testing.js — evaluación forzada (bypass de cooldowns, para testing en vivo)
// y estadísticas del engine (getStats).

const {
  LATE_NIGHT_START,
  LATE_NIGHT_END,
  SILENCE_THRESHOLD_MS,
  FOCUS_RULES,
  THRASH_WINDOW_MS,
  THRASH_MIN_SWITCHES,
  THRASH_MIN_DISTINCT_CATEGORY,
  RETURN_MIN_GAP_SEC,
  DAILY_BUDGET,
} = require('../config.js');

module.exports = {
  // ── Evaluación forzada (testing) ────────────────────────────────────────────
  // Bypasea los cooldowns a propósito (es una prueba forzada), pero el LLM
  // sigue teniendo la última palabra — puede seguir respondiendo NO.

  async forceEvaluate(triggerType = 'long_silence') {
    const now = new Date();
    const hour = now.getHours();
    let trigger;

    switch (triggerType) {
      case 'late_night': {
        const isActuallyLateNight = hour >= LATE_NIGHT_START && hour < LATE_NIGHT_END;
        trigger = {
          type: 'late_night',
          hour,
          forced: true,
          forcedMismatch: !isActuallyLateNight,
          context: isActuallyLateNight
            ? `Son las ${now.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })} de la madrugada y el usuario sigue activo frente al PC.`
            : `[SIMULACIÓN DE TESTING] Se está forzando el trigger "late_night", pero en realidad son las ${now.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })} — no es madrugada.`,
        };
        break;
      }
      case 'long_silence': {
        const silenceBase = this._lastUserMsg || this._startedAt;
        const silenceMs = Date.now() - silenceBase;
        const silenceHours = Math.max(1, Math.round(silenceMs / (1000 * 60 * 60)));
        const realSilence = silenceMs > SILENCE_THRESHOLD_MS;
        trigger = {
          type: 'long_silence',
          hours: silenceHours,
          forced: true,
          forcedMismatch: !realSilence,
          context: realSilence
            ? `Han pasado ${silenceHours} horas desde la última conversación con el usuario.`
            : `[SIMULACIÓN DE TESTING] Se está forzando el trigger "long_silence", pero en realidad el usuario habló hace muy poco (${Math.round(silenceMs / 60000)} minutos).`,
        };
        break;
      }
      case 'special_date': {
        const real = this._checkSpecialDate(now);
        trigger = real || {
          type: 'special_date',
          forced: true,
          forcedMismatch: true,
          context: `[SIMULACIÓN DE TESTING] Se está forzando el trigger "special_date", pero hoy (${now.toLocaleDateString('es-MX', { day: 'numeric', month: 'long' })}) no hay ninguna fecha especial registrada para el usuario.`,
        };
        break;
      }
      case 'sustained_focus': {
        const osCtx = this._osSensor?.getCurrentContext();
        const rule = osCtx?.category ? FOCUS_RULES[osCtx.category] : null;
        const real = !!(rule && osCtx.elapsed >= rule.minSec);
        const effectiveRule = rule || FOCUS_RULES.code;
        trigger = {
          type: 'sustained_focus',
          category: osCtx?.category || 'code',
          label: effectiveRule.label,
          friendlyName: osCtx?.friendlyName || 'la app actual',
          title: osCtx?.title || '',
          elapsedSec: osCtx?.elapsed || 0,
          forced: true,
          forcedMismatch: !real,
          context: real
            ? `El usuario lleva ${osCtx.elapsedFormatted} ${effectiveRule.label} en ${osCtx.friendlyName}.`
            : `[SIMULACIÓN DE TESTING] Se está forzando "sustained_focus", pero el usuario no lleva suficiente tiempo enfocado en una categoría reconocida ahora mismo (app actual: ${osCtx?.friendlyName || 'ninguna detectada'}).`,
        };
        break;
      }
      case 'context_switch_thrash': {
        const distinctCategories = [...new Set(this._recentSwitches.map((s) => s.category))];
        const real =
          this._recentSwitches.length >= THRASH_MIN_SWITCHES &&
          distinctCategories.length >= THRASH_MIN_DISTINCT_CATEGORY;
        trigger = {
          type: 'context_switch_thrash',
          switchCount: this._recentSwitches.length,
          categories: distinctCategories,
          forced: true,
          forcedMismatch: !real,
          context: real
            ? `El usuario cambió de aplicación ${this._recentSwitches.length} veces en los últimos ${Math.round(THRASH_WINDOW_MS / 60000)} minutos, saltando entre: ${distinctCategories.join(', ')}.`
            : `[SIMULACIÓN DE TESTING] Se está forzando "context_switch_thrash", pero no hay suficientes cambios de app recientes registrados (solo ${this._recentSwitches.length} en la ventana de ${Math.round(THRASH_WINDOW_MS / 60000)} min).`,
        };
        break;
      }
      case 'return_from_break': {
        trigger = {
          type: 'return_from_break',
          gapSec: RETURN_MIN_GAP_SEC + 60,
          forced: true,
          forcedMismatch: true,
          context: `[SIMULACIÓN DE TESTING] Se está forzando "return_from_break" — no hubo una ausencia real detectada, es una prueba.`,
        };
        break;
      }
      case 'lsp_error': {
        // Sin un error LSP real a mano, el parche no se puede generar y la
        // propuesta cae a informativa (no_patch). Suficiente para probar el
        // pipeline del trigger en vivo.
        trigger = {
          type: 'lsp_error',
          file: '(simulación)',
          absPath: '',
          errors: [{ message: 'error de simulación', line: 0 }],
          symbols: [],
          focused: false,
          forced: true,
          forcedMismatch: true,
          context: `[SIMULACIÓN DE TESTING] Se está forzando el trigger "lsp_error" — no hay un error LSP real ahora mismo.`,
        };
        break;
      }
      default:
        trigger = {
          type: triggerType,
          forced: true,
          forcedMismatch: true,
          context: `[SIMULACIÓN DE TESTING] Trigger "${triggerType}" forzado manualmente.`,
        };
    }

    logger.info(
      'testing',
      '[proactive] evaluación forzada:',
      triggerType,
      trigger.forcedMismatch
        ? '(sin correspondencia con la realidad)'
        : '(coincide con la realidad)'
    );
    const message = await this._generateMessage(trigger);
    if (message) {
      const firedAt = Date.now();
      this._lastProactive = firedAt;
      this._lastAttemptByType[trigger.type] = firedAt;
      this._lastProactiveMessage = message;
      this._lastProactiveTrigger = trigger.type;
      this._bus.emit('initiative:trigger', await this._buildPayload(trigger, message));
    } else {
      logger.info('testing', '[proactive] LLM no generó mensaje en evaluación forzada');
    }
    return message;
  },

  getStats() {
    const now = Date.now();
    return {
      running: this._running,
      deciding: this._deciding,
      lastProactive: this._lastProactive,
      lastProactiveMessage: this._lastProactiveMessage,
      lastProactiveTrigger: this._lastProactiveTrigger,
      lastAttemptByType: this._lastAttemptByType,
      lastUserMsg: this._lastUserMsg,
      silenceMs: now - this._lastUserMsg,
      chatOpen: this._chatOpen,
      idleSecs: this._osSensor?.getCurrentContext()?.idleSecs ?? null,
      currentCategory: this._currentCategory,
      categoryStreakSec: this._categoryStreakStart
        ? Math.round((now - this._categoryStreakStart) / 1000)
        : 0,
      categoryStreakFired: this._categoryStreakFired,
      categoryStreakFollowupFired: this._categoryStreakFollowupFired,
      recentSwitchesCount: this._recentSwitches.length,
      awaySince: this._idleStartedAt,
      proactiveScore: this._currentProactiveScore,
      autonomyMode: this._autonomyMode,
      feedback: this._store?.getStats() ?? null,
      pendingProposals: this._pendingActions.size,
      dailyBudget: {
        dayKey: this._store?.getDailyStats().dayKey ?? null,
        count: this._store?.dailyCount() ?? 0,
        limit: DAILY_BUDGET,
      },
      gate: {
        shadowMode: this._shadowMode,
        receptivity: this._receptivity,
        queued: this._queue.size(),
        audit: this._audit.getStats(),
      },
      slo: this._store ? this._sloStats() : null,
    };
  },
};
