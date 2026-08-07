// os-events.js — análisis de actividad del OS en tiempo real: cambios de app,
// ticks de la app activa y regresos de pausa. Produce los triggers
// sustained_focus, context_switch_thrash, session_end y return_from_break.

const {
  FOCUS_RULES,
  THRASH_WINDOW_MS,
  THRASH_MIN_SWITCHES,
  THRASH_MIN_DISTINCT_CATEGORY,
  RETURN_MIN_GAP_SEC,
  RETURN_MAX_GAP_SEC,
  WORK_CATEGORIES,
  SESSION_END_MIN_SEC,
  FOLLOWUP_MULTIPLIER,
} = require('../config.js');

module.exports = {
  /** El usuario cambió de app — actualiza racha de enfoque y detecta "thrashing". */
  _onAppChanged({ app, category }) {
    const now = Date.now();

    this._recentSwitches.push({ ts: now, category, app });
    this._recentSwitches = this._recentSwitches.filter((s) => now - s.ts <= THRASH_WINDOW_MS);

    const categoryChanged = category !== this._currentCategory;

    if (categoryChanged && this._currentCategory !== null) {
      this._prevCategory = this._currentCategory;
      if (this._categoryStreakStart > 0) {
        this._prevCategoryStreakSec = Math.round((now - this._categoryStreakStart) / 1000);
      }
    }

    if (categoryChanged) {
      // Session-end: transición de trabajo → no-trabajo después de racha significativa
      if (
        this._prevCategory &&
        WORK_CATEGORIES.has(this._prevCategory) &&
        !WORK_CATEGORIES.has(category) &&
        this._prevCategoryStreakSec >= SESSION_END_MIN_SEC
      ) {
        const streakMinutes = Math.round(this._prevCategoryStreakSec / 60);
        this._tryTrigger({
          type: 'session_end',
          prevCategory: this._prevCategory,
          streakSec: this._prevCategoryStreakSec,
          context: `El usuario pasó ${streakMinutes} minutos ${FOCUS_RULES[this._prevCategory]?.label || 'trabajando'} y acaba de cambiar a ${category || 'otra cosa'}.`,
        }).catch((e) => console.warn('[proactive] error en trigger de session-end:', e.message));
      }

      // Nueva racha de enfoque (solo cuando cambia la categoría)
      this._currentCategory = category;
      this._categoryStreakStart = now;
      this._categoryStreakFired = false;
      this._categoryStreakFiredAt = 0;
      this._categoryStreakFollowupFired = false;
    }

    const distinctCategories = [...new Set(this._recentSwitches.map((s) => s.category))];
    if (
      this._recentSwitches.length >= THRASH_MIN_SWITCHES &&
      distinctCategories.length >= THRASH_MIN_DISTINCT_CATEGORY
    ) {
      const windowMin = Math.round(THRASH_WINDOW_MS / 60000);
      this._tryTrigger({
        type: 'context_switch_thrash',
        switchCount: this._recentSwitches.length,
        categories: distinctCategories,
        context: `El usuario cambió de aplicación ${this._recentSwitches.length} veces en los últimos ${windowMin} minutos, saltando entre: ${distinctCategories.join(', ')}.`,
      }).catch((e) => console.warn('[proactive] error en trigger de thrash:', e.message));
    }
  },

  /** El usuario sigue en la misma app — revisa si ya lleva suficiente racha de enfoque. */
  async _onAppTick({ friendlyName, category, elapsed, elapsedFormatted, title }) {
    const rule = FOCUS_RULES[category];
    if (!rule) return;
    if (elapsed < rule.minSec) return;

    if (!this._categoryStreakFired) {
      // Primer trigger: acaba de cruzar el umbral mínimo. Solo se consume la
      // racha si el trigger llegó a consultar al LLM (o se envió); si quedó
      // bloqueado (chat abierto, cooldown, idle...), se reintenta en el
      // próximo tick sin perder la oportunidad.
      let outcome = null;
      try {
        outcome = await this._tryTrigger({
          type: 'sustained_focus',
          category,
          label: rule.label,
          friendlyName,
          title,
          elapsedSec: elapsed,
          elapsedFormatted,
          context: `El usuario lleva ${elapsedFormatted} ${rule.label} en ${friendlyName}${title ? ` ("${title.slice(0, 80)}")` : ''}.`,
        });
      } catch (e) {
        console.warn('[proactive] error en trigger de enfoque sostenido:', e.message);
      }
      if (outcome && outcome.blocked) return;
      this._categoryStreakFired = true;
      this._categoryStreakFiredAt = Date.now();
      return;
    }

    // Follow-up: si ya pasó bastante más tiempo desde el primer trigger
    if (this._categoryStreakFollowupFired) return;
    const followupThreshold = rule.minSec * FOLLOWUP_MULTIPLIER;
    if (elapsed < followupThreshold) return;

    let outcome = null;
    try {
      outcome = await this._tryTrigger({
        type: 'sustained_focus',
        subtype: 'followup',
        category,
        label: rule.label,
        friendlyName,
        title,
        elapsedSec: elapsed,
        elapsedFormatted,
        context: `El usuario sigue concentrado después de ${elapsedFormatted} ${rule.label} en ${friendlyName}${title ? ` ("${title.slice(0, 80)}")` : ''}.`,
      });
    } catch (e) {
      console.warn('[proactive] error en trigger de enfoque sostenido (follow-up):', e.message);
    }
    if (outcome && outcome.blocked) return;
    this._categoryStreakFollowupFired = true;
  },

  /** El usuario se fue o volvió del PC — detecta regreso de una ausencia real. */
  _onIdleChanged({ idle, idleSecs }) {
    const now = Date.now();

    if (idle) {
      // Se acaba de cruzar el umbral de idle — estima cuándo empezó realmente
      this._idleStartedAt = now - idleSecs * 1000;
      return;
    }

    // idle === false → el usuario acaba de volver a estar activo
    if (!this._idleStartedAt) return;
    const gapSec = Math.round((now - this._idleStartedAt) / 1000);
    this._idleStartedAt = null;
    this._categoryStreakFired = false;
    this._categoryStreakFollowupFired = false;

    if (gapSec < RETURN_MIN_GAP_SEC || gapSec > RETURN_MAX_GAP_SEC) return;

    // Fase F: al volver de una pausa, es buen momento para reintentar los
    // diferidos que el gate decidió esperar (cola QUEUE). El gate re-evalúa
    // cada uno con el contexto nuevo; los que siguen sin ser buen momento
    // se quedan en cola sin quemar reintentos.
    this._replayQueued();

    const minutes = Math.round(gapSec / 60);
    this._tryTrigger({
      type: 'return_from_break',
      gapSec,
      context: `El usuario estuvo alejado de la PC unos ${minutes} minutos y acaba de volver a estar activo.`,
    }).catch((e) => console.warn('[proactive] error en trigger de regreso:', e.message));
  },

  /**
   * Fase F: re-procesa la cola de diferidos con el contexto actual. Los que el
   * gate admite (ACT/ESCALATE) entran al pipeline normal — el LLM produce.
   */
  _replayQueued() {
    const ready = this._queue.poll(this._buildGateContext(Date.now()));
    if (!ready.length) return;
    console.log(`[proactive] reintentando ${ready.length} diferido(s) de la cola...`);
    for (const { candidate, decision } of ready) {
      this._tryTrigger({
        type: candidate.tipo,
        kind: candidate.kind,
        ...candidate.payload,
        context: candidate.payload.message || candidate.payload.title || '',
      }).catch((e) => console.warn('[proactive] error reintentando diferido:', e.message));
    }
  },
};
