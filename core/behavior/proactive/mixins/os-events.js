// @ts-nocheck
const logger = require('../../../observability/Logger.js');
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
  MEDIA_MIN_SEC,
} = require('../config.js');
const { _detectMediaTitle, _matchMediaTaste } = require('../helpers.js');
const { isRealIdentityNode } = require('../../../core/misc.js');

// Máximo de títulos de contenido ya comentados que se recuerdan. Sin tope, una
// sesión larga (o años de uso del mismo equipo) acumula el Set sin límite.
const MAX_MEDIA_FIRED = 300;

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
      // ── Fin de bloque de foco (borde natural, no un contador) ────────────
      // El comentario mid-flow basado en "llevas X min enfocado" se eliminó:
      // se sentía programado. El momento humano para hablar de un bloque de
      // foco es cuando TERMINA — aquí, al cambiar de categoría — con el
      // contexto de la ventana sobre la que estaba ("hito"). Las sesiones de
      // trabajo largas (work → no-work, ≥ 20 min) las cubre session_end, para
      // no disparar dos veces el mismo momento.
      const prevRule = FOCUS_RULES[this._prevCategory];
      const bigWorkEnd =
        this._prevCategory &&
        WORK_CATEGORIES.has(this._prevCategory) &&
        !WORK_CATEGORIES.has(category) &&
        this._prevCategoryStreakSec >= SESSION_END_MIN_SEC;
      if (
        this._prevCategory &&
        prevRule &&
        this._prevCategoryStreakSec >= prevRule.minSec &&
        !bigWorkEnd &&
        !this._categoryStreakFired
      ) {
        this._categoryStreakFired = true; // el fin de este bloque se maneja una vez
        const mins = Math.round(this._prevCategoryStreakSec / 60);
        const lastWin =
          this._lastFocusedWindow?.category === this._prevCategory ? this._lastFocusedWindow : null;
        // Fase 5: el título de la ventana SOLO si es una categoría de trabajo
        // (code/terminal/docs/design). Si el bloque era media/ocio, nombrar el
        // título (p. ej. un anime en Crunchyroll) se siente a vigilancia.
        const titleCtx =
          lastWin?.title && lastWin.category && WORK_CATEGORIES.has(lastWin.category)
            ? ` Estaba en "${String(lastWin.title).slice(0, 80)}".`
            : '';
        this._tryTrigger({
          type: 'focus_block_end',
          prevCategory: this._prevCategory,
          label: prevRule.label,
          streakSec: this._prevCategoryStreakSec,
          app: lastWin?.app || app,
          context: `El usuario dejó de estar ${prevRule.label} después de ${mins} minutos.${titleCtx} Es un buen momento para comentar el bloque que terminó — si hay algo genuino que decir, sin romperle el flujo.`,
        }).catch((e) =>
          logger.warn('os-events', '[proactive] error en trigger de fin de bloque:', e.message)
        );
      }

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
        }).catch((e) =>
          logger.warn('os-events', '[proactive] error en trigger de session-end:', e.message)
        );
      }

      // Nueva racha de enfoque (solo cuando cambia la categoría). OJO: NO se
      // resetea _categoryStreakFired aquí. El fin de un bloque de foco es un
      // borde que se procesa UNA vez por sesión activa (aunque el gate lo
      // bloquee: la oportunidad del momento pasó, no se persigue). El reset
      // real ocurre al volver de una pausa (_onIdleChanged), que es cuando
      // empieza una senda de foco nueva.
      this._currentCategory = category;
      this._categoryStreakStart = now;
    }

    const distinctCategories = [...new Set(this._recentSwitches.map((s) => s.category))];
    const distinctApps = [...new Set(this._recentSwitches.map((s) => s.app).filter(Boolean))];
    if (
      this._recentSwitches.length >= THRASH_MIN_SWITCHES &&
      distinctCategories.length >= THRASH_MIN_DISTINCT_CATEGORY
    ) {
      const windowMin = Math.round(THRASH_WINDOW_MS / 60000);
      // Fase B: el contexto lleva los nombres REALES de las apps y el título de
      // la ventana actual, para que Kaoru pueda decir algo concreto y no caer
      // siempre en el genérico "¿anda buscando algo?". Fase 5: el título SOLO
      // si la ventana actual es de trabajo — un título de media/ocio es
      // vigilancia, no contexto útil.
      const currentTitle = this._osSensor?.getCurrentContext?.()?.title ?? null;
      const titleForPrompt =
        currentTitle && this._currentCategory && WORK_CATEGORIES.has(this._currentCategory)
          ? currentTitle
          : null;
      this._tryTrigger({
        type: 'context_switch_thrash',
        switchCount: this._recentSwitches.length,
        categories: distinctCategories,
        apps: distinctApps,
        title: titleForPrompt,
        context: `El usuario cambió de aplicación ${this._recentSwitches.length} veces en los últimos ${windowMin} minutos, saltando entre: ${distinctCategories.join(', ')} (${distinctApps.join(', ')}).${titleForPrompt ? ` Ahora mismo está en: "${String(titleForPrompt).slice(0, 80)}".` : ''}`,
      }).catch((e) =>
        logger.warn('os-events', '[proactive] error en trigger de thrash:', e.message)
      );
    }
  },

  /**
   * Tick de la app activa. NO dispara comentarios mid-flow por contador: el
   * momento natural para hablar de un bloque de foco es su FIN (focus_block_end
   * en _onAppChanged). Aquí solo se recuerda la ventana/contenido del bloque
   * actual para dar contexto de "hito" cuando el bloque termine, y se rastrea
   * media_watching (contenido en pantalla).
   */
  async _onAppTick({ friendlyName, category, title }) {
    this._trackMedia({ category, title, friendlyName });

    if (FOCUS_RULES[category]) {
      this._lastFocusedWindow = {
        category,
        app: friendlyName,
        title: title || null,
        at: Date.now(),
      };
    }
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
    }).catch((e) =>
      logger.warn('os-events', '[proactive] error en trigger de regreso:', e.message)
    );
  },

  /**
   * Fase F: re-procesa la cola de diferidos con el contexto actual. Los que el
   * gate admite (ACT/ESCALATE) entran al pipeline normal — el LLM produce.
   */
  _replayQueued() {
    const ready = this._queue.poll(this._buildGateContext(Date.now()));
    if (!ready.length) return;
    logger.info('os-events', `[proactive] reintentando ${ready.length} diferido(s) de la cola...`);
    for (const { candidate, decision: _decision } of ready) {
      this._tryTrigger({
        type: candidate.tipo,
        kind: candidate.kind,
        ...candidate.payload,
        context: candidate.payload.message || candidate.payload.title || '',
      }).catch((e) =>
        logger.warn('os-events', '[proactive] error reintentando diferido:', e.message)
      );
    }
  },

  /**
   * media_watching: detecta contenido en pantalla (YouTube, Spotify, VLC...) y,
   * tras MEDIA_MIN_SEC sobre el MISMO título, dispara un trigger para comentarlo.
   * Dedup por título (una vez por video/canción) y reset cuando cambia el
   * contenido o la app deja de ser media/browser con plataforma.
   */
  _trackMedia({ category, title, friendlyName }) {
    const media = _detectMediaTitle(title, category);

    // Sin contenido reconocible → reset del track.
    if (!media) {
      if (this._mediaTrack) {
        logger.info('os-events', '[proactive] media: contenido ya no visible — reset');
        this._mediaTrack = null;
      }
      return;
    }

    const key = media.title.toLowerCase().trim();
    const now = Date.now();

    // Cambió de contenido (otro video/canción) → nueva racha.
    if (!this._mediaTrack || this._mediaTrack.key !== key) {
      this._mediaTrack = { key, title: media.title, platform: media.platform, startedAt: now };
    }

    // Ya comentamos este título → no insistir.
    if (this._mediaFired.has(key)) return;

    const elapsedSec = Math.round((now - this._mediaTrack.startedAt) / 1000);
    if (elapsedSec < MEDIA_MIN_SEC) return;

    this._mediaFired.add(key);
    // Ventana acotada: los títulos más viejos comentados salen primero, para
    // que el Set no crezca para siempre en una sesión de larga duración.
    if (this._mediaFired.size > MAX_MEDIA_FIRED) {
      const it = this._mediaFired.keys();
      while (this._mediaFired.size > MAX_MEDIA_FIRED) {
        this._mediaFired.delete(it.next().value);
      }
    }
    this._mediaLastFired = now;

    // ¿El contenido en pantalla conecta con algún gusto guardado? Si sí, el
    // trigger lo lleva para que el prompt pueda decir "ah, ese es de los que
    // te gustan" y el gate puntúe mejor la señal (comentar algo que conecta
    // con la persona vale más que un comentario genérico).
    const worldModel = this._graph?.getWorldModel?.() ?? [];
    const tasteMatches = _matchMediaTaste(media.title, worldModel.filter(isRealIdentityNode));
    const knownTaste = tasteMatches.length > 0;

    // Fase 5: contexto NEUTRO cuando el contenido NO conecta con un gusto
    // guardado. Referenciar el título exacto de algo que el usuario no ha
    // compartido se siente a vigilancia ("sé que estás viendo X"). Solo si
    // hay un match con una preferencia confirmada se nombra el contenido.
    const content = knownTaste
      ? `El usuario lleva ${this._formatSec(elapsedSec)} viendo o escuchando "${media.title}"${media.platform !== 'media' ? ` (${media.platform})` : ''} en ${friendlyName || category}. Es contenido que conecta con sus gustos guardados.`
      : `El usuario lleva ${this._formatSec(elapsedSec)} con contenido en pantalla (${category || 'media'}) en ${friendlyName || 'una app de contenido'}.`;
    this._tryTrigger({
      type: 'media_watching',
      category,
      friendlyName,
      title: media.title,
      platform: media.platform,
      elapsedSec,
      tasteMatches,
      mediaTasteMatch: knownTaste,
      context: content,
    }).catch((e) =>
      logger.warn('os-events', '[proactive] error en trigger de media_watching:', e.message)
    );
  },

  _formatSec(secs) {
    if (!secs || secs < 60) return `${secs || 0} segundos`;
    const m = Math.round(secs / 60);
    return m === 1 ? '1 minuto' : `${m} minutos`;
  },
};
