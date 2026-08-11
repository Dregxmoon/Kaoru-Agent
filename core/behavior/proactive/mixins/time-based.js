// @ts-nocheck
const logger = require('../../../observability/Logger.js');
// time-based.js — triggers que dependen del paso del tiempo (no de un evento
// puntual del OS): fecha especial, madrugada, silencio largo, recap de
// pendientes al arrancar, y el saneo de propuestas "ignored".

const { _parseEventTime } = require('../../../../infrastructure/sensors/UpcomingEventsWatcher.js');
const { assess: assessSlo } = require('../../../decision/SloMonitor.js');
const { receptividad } = require('../../../decision/DecisionCore.js');
const { getMemoryGaps } = require('../../../core/misc.js');

const {
  LATE_NIGHT_START,
  LATE_NIGHT_END,
  SILENCE_THRESHOLD_MS,
  PENDING_LOOKAHEAD_MS,
} = require('../config.js');

const { _monthName, _localDayString, _dayOffset, _friendlyWhen } = require('../helpers.js');

module.exports = {
  // ── Evaluación temporal (heartbeat cada 5 min) ──────────────────────────────
  // Cubre los triggers que NO dependen de un evento puntual del OS, sino del
  // paso del tiempo: fecha especial, madrugada, silencio largo.

  async _evaluateTimeBased() {
    const now = new Date();

    // Fase F (P2/P4): el heartbeat es el barrido de mantenimiento. Aquí se
    // drena la cola de diferidos QUEUE (reintenta con el contexto actual los
    // candidatos que el gate difirió) y se marcan 'ignored' las propuestas
    // enviadas sin respuesta tras el plazo. Antes ambos solo corrían como
    // efecto colateral de _tryTrigger o al volver de una pausa; sin triggers
    // ni idle→active en sesiones largas, la cola caducaba por TTL sin
    // reintento y el SLO no aprendía de las ignoradas.
    this._replayQueued();
    this._markIgnoredStale();

    const specialDate = this._checkSpecialDate(now);
    if (specialDate) {
      await this._tryTrigger(specialDate);
      return;
    }

    const hour = now.getHours();
    const idleSecs = this._osSensor?.getCurrentContext()?.idleSecs ?? 0;

    if (hour >= LATE_NIGHT_START && hour < LATE_NIGHT_END && idleSecs < 300) {
      await this._tryTrigger({
        type: 'late_night',
        hour,
        context: `Son las ${now.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })} de la madrugada y el usuario sigue activo frente al PC.`,
      });
      return;
    }

    // Curiosidad sobre la memoria (Fase nueva): antes del silencio largo, se
    // evalúan los candidatos de hechos stale / inferencias de confianza media /
    // contradicciones. El gate ya impone el cupo propio (CURIOSITY_DAILY_CAP)
    // y el boost de contexto; cada envío real consume solo ese cupo.
    await this._maybeCuriosity();

    await this._maybeLongSilence(now);
  },

  /**
   * Silencio largo, pero "porque PASÓ algo", no por el reloj: sin pendientes,
   * sin diferidos en cola y sin un hueco de memoria que valga la pena
   * preguntar, un chequeo a las 3 h no es una conversación con causa — es un
   * ladrido de agenda. Antes solo importaba el tiempo; ahora hace falta una
   * razón real para hablar (forma humana, no programada).
   */
  async _maybeLongSilence(_now) {
    const silenceBase = this._lastUserMsg || this._startedAt;
    const silenceMs = Date.now() - silenceBase;
    if (silenceMs <= SILENCE_THRESHOLD_MS) return;

    if (!this._silenceHasReason()) {
      logger.info(
        'time-based',
        '[proactive] silencio largo sin razón de fondo: el usuario no habla y no hay nada con causa — silencio (sin ladrido de agenda)'
      );
      return;
    }

    const silenceHours = Math.round(silenceMs / (1000 * 60 * 60));
    await this._tryTrigger({
      type: 'long_silence',
      hours: silenceHours,
      context: `Han pasado ${silenceHours} horas desde la última conversación con el usuario.`,
    });
  },

  /** ¿Hay algo con causa que valga la pena decirle tras un silencio largo? */
  _silenceHasReason() {
    try {
      if (this._collectPendingReminders().length > 0) return true;
    } catch (e) {
      logger.warn('time-based', '[proactive] error leyendo pendientes para silencio:', e.message);
    }
    if (this._queue && this._queue.size() > 0) return true;
    try {
      if (getMemoryGaps().length > 0) return true;
    } catch (e) {
      logger.warn('time-based', '[proactive] error leyendo gaps para silencio:', e.message);
    }
    return false;
  },

  /**
   * FIX QW-5 (sin cambios): normalización de fechas para _checkSpecialDate.
   *
   * Bug original: "15/06/2000" (con cero de relleno y año) no matcheaba
   * `todayShort = "15/6"` (sin cero de relleno), por lo que cumpleaños
   * guardados en ese formato nunca se detectaban.
   *
   * Solución: generar un conjunto de variantes de la fecha de hoy
   * (con/sin cero de relleno, formatos texto), y buscar cualquiera de ellas
   * en el contenido del nodo, en vez de una comparación rígida de string.
   */
  _checkSpecialDate(now) {
    if (!this._graph?._ready) return null;

    try {
      const userNodes = this._graph.queryNodes({ type: 'User', limit: 20 });

      const day = now.getDate();
      const month = now.getMonth() + 1;

      const dateVariants = [
        `${day}/${month}`,
        `${day}/${String(month).padStart(2, '0')}`,
        `${String(day).padStart(2, '0')}/${month}`,
        `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}`,
        `${day} de ${_monthName(month - 1)}`,
        `${String(day).padStart(2, '0')} de ${_monthName(month - 1)}`,
      ];

      const todayStr = now.toISOString().slice(0, 10); // YYYY-MM-DD

      for (const node of userNodes) {
        const content = node.content?.toLowerCase() || '';

        const matchesToday = dateVariants.some((v) => content.includes(v.toLowerCase()));

        const hasDateKeyword =
          content.includes('cumpleaños') ||
          content.includes('birthday') ||
          content.includes('nació') ||
          content.includes('aniversario') ||
          content.includes('recordatorio') ||
          content.includes('importante') ||
          content.includes('fecha especial');

        if (hasDateKeyword && matchesToday) {
          const subtype =
            content.includes('cumpleaños') || content.includes('birthday') ? 'birthday' : 'other';
          return {
            type: 'special_date',
            subtype,
            node: node.content,
            context: `Hoy es una fecha especial para el usuario: ${node.content}`,
          };
        }

        // También detectar fechas en formato ISO guardadas en contenido
        if (content.includes(todayStr) && hasDateKeyword) {
          const subtype =
            content.includes('cumpleaños') || content.includes('birthday') ? 'birthday' : 'other';
          return {
            type: 'special_date',
            subtype,
            node: node.content,
            context: `Hoy es una fecha especial para el usuario: ${node.content}`,
          };
        }
      }
    } catch (e) {
      logger.warn('time-based', '[proactive] error revisando fechas especiales:', e.message);
    }

    return null;
  },

  // ── Fase C: recap de pendientes al arrancar ─────────────────────────────────
  // Retomar hilos: al arrancar, si hay recordatorios guardados (nodos
  // `recordar_*`) con hora próxima o día de hoy, el asistente ofrece retomarlos. Va
  // por el mismo pipeline (LLM con la última palabra, cooldowns, presupuesto),
  // así no se convierte en un ladrido automático al boot.

  _collectPendingReminders() {
    if (!this._graph?.queryNodes) return [];
    let nodes = [];
    try {
      nodes = this._graph.queryNodes({ type: 'Belief', limit: 50 }) || [];
    } catch (e) {
      logger.warn('time-based', '[proactive] error leyendo recordatorios:', e.message);
      return [];
    }

    const now = Date.now();
    const pendings = [];
    for (const node of nodes) {
      if (!String(node.label || '').startsWith('recordar_')) continue;
      const parsed = _parseEventTime(node.content, now);
      if (!parsed) continue;
      if (parsed.kind === 'time_event') {
        if (parsed.ts < now || parsed.ts - now > PENDING_LOOKAHEAD_MS) continue;
      } else {
        // day_event: pendiente si es hoy (o mañana, para avisar con anticipación)
        const day = _localDayString(parsed.ts);
        const today = _localDayString(now);
        if (day !== today && _dayOffset(parsed.ts, now) !== 1) continue;
      }
      pendings.push({ nodeId: node.id, content: node.content, when: parsed.ts, kind: parsed.kind });
    }
    return pendings;
  },

  /** Al arrancar: si hay pendientes, se ofrece retomarlos (si el LLM da el OK). */
  async pendingRecap() {
    if (!this._running) return null;
    if (this._autonomyMode === 'observe') return null;
    const pendings = this._collectPendingReminders();
    if (!pendings.length) return null;

    const list = pendings
      .map((p) => `${p.content.replace(/^pidió recordar:\s*/i, '')} (${_friendlyWhen(p.when)})`)
      .slice(0, 3)
      .join('; ');
    return this._tryTrigger({
      type: 'pending_recap',
      context: `Al arrancar la sesión hay pendientes que el usuario pidió recordar: ${list}. Ofrece retomarlos con naturalidad.`,
    });
  },

  /**
   * F-5: las propuestas enviadas sin respuesta tras `_ignoredAfterMs` se
   * registran como 'ignored' (no molestar) y salen del seguimiento.
   */
  _markIgnoredStale() {
    if (!this._store) return;
    const now = Date.now();
    for (const [proposalId, info] of this._sentFeedback) {
      if (now - info.at >= this._ignoredAfterMs) {
        this._store.record({ proposalId, type: info.type, decision: 'ignored' });
        // Hilo relacional: la propuesta ignorada también se marca en el registro.
        for (const e of this._relationLog) {
          if (e.proposalId === proposalId) e.outcome = 'ignored';
        }
        // Fase F: la propuesta ignorada también baja la receptividad global
        // (EMA), no solo el SLO del tipo — si el usuario deja varias sin
        // tocar, el presupuesto dinámico del día debe encogerse, no quedarse
        // en 20 porque las aceptaciones puntuales lo mantengan alto.
        this._receptivity = receptividad(this._receptivity, { ignored: true });
        this._audit.push({
          type: info.type,
          proposalId,
          outcome: 'ignored',
          reason: 'no_response',
          at: now,
        });
        this._sentFeedback.delete(proposalId);
      }
    }
  },

  /**
   * F-5: estadísticas de SLO por tipo desde el feedback persistido. Las usa
   * el gate (degradación automática) y la telemetría de no-molestia.
   */
  _sloStats() {
    const byType = this._store?.getStats().byType ?? {};
    return assessSlo(byType);
  },
};
