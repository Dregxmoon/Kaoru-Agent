/**
 * ProactiveEngine.js — Fase 2.5 + Quick Fix QW-5
 *
 * Fix QW-5: _checkSpecialDate tenía un bug con fechas de un solo dígito
 *   guardadas con cero de relleno ("15/06/2000" no matcheaba "15/6").
 *   Ahora normaliza ambos lados antes de comparar:
 *     - extrae día y mes numérico de `todayShort` (sin relleno)
 *     - al buscar en el contenido del nodo, genera múltiples variantes
 *       del formato ("15/6", "15/06", "15 de junio") para no depender
 *       de cómo exactamente lo guardó el LLM.
 *
 * El resto del archivo es idéntico a la versión original.
 */

const { getEventBus } = require('../../infrastructure/event-bus/EventBus.js');
const LLMProvider     = require('../llm/LLMProvider.js');
const { getIdentity } = require('../grounding/GroundingEngine.js');

// ── Configuración ─────────────────────────────────────────────────────────────

const EVAL_INTERVAL_MS          = 5 * 60 * 1000;
const MIN_PROACTIVE_INTERVAL_MS = 4 * 60 * 60 * 1000;
const SILENCE_THRESHOLD_MS      = 3 * 60 * 60 * 1000;
const LATE_NIGHT_START          = 0;
const LATE_NIGHT_END            = 5;
const MAX_IDLE_TO_INTERRUPT     = 30 * 60;

// ── ProactiveEngine ───────────────────────────────────────────────────────────

class ProactiveEngine {
  constructor(stateGraph) {
    this._graph          = stateGraph;
    this._bus            = getEventBus();
    this._osSensor       = null;
    this._chatOpen       = false;
    this._lastProactive  = 0;
    this._lastUserMsg    = Date.now();
    this._timer          = null;
    this._running        = false;

    this._lastProactiveMessage = null;
    this._lastProactiveTrigger = null;

    this._setupListeners();
  }

  setOSSensor(osSensor) {
    this._osSensor = osSensor;
  }

  setChatOpen(open) {
    this._chatOpen = open;
  }

  onUserMessage() {
    this._lastUserMsg = Date.now();
  }

  start() {
    if (this._running) return;
    this._running = true;
    console.log('[proactive] iniciado (eval cada 5 min)');
    setTimeout(() => this._evaluate(), 2 * 60 * 1000);
    this._timer = setInterval(() => this._evaluate(), EVAL_INTERVAL_MS);
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._running = false;
    console.log('[proactive] detenido');
  }

  // ── Evaluación ──────────────────────────────────────────────────────────────

  async _evaluate() {
    if (this._chatOpen) return;
    if (!LLMProvider.getActiveProvider()) return;

    const sinceLastProactive = Date.now() - this._lastProactive;
    if (sinceLastProactive < MIN_PROACTIVE_INTERVAL_MS) return;

    const idleSecs = this._osSensor?.getCurrentContext()?.idleSecs ?? 0;
    if (idleSecs > MAX_IDLE_TO_INTERRUPT) {
      console.log(`[proactive] usuario idle ${idleSecs}s, omitiendo`);
      return;
    }

    const trigger = this._checkTriggers();
    if (!trigger) return;

    console.log(`[proactive] trigger: ${trigger.type} — consultando LLM...`);

    const message = await this._generateMessage(trigger);
    if (!message) {
      console.log('[proactive] LLM decidió no enviar mensaje');
      return;
    }

    this._lastProactive        = Date.now();
    this._lastProactiveMessage = message;
    this._lastProactiveTrigger = trigger.type;

    const payload = {
      reason:     trigger.type,
      suggestion: message,
      actionType: 'proactive',
      canHelp:    true,
      utility:    1.0,
      openChat:   true,
    };

    console.log(`[proactive] emitiendo: "${message.slice(0, 60)}..."`);
    this._bus.emit('initiative:trigger', payload);
  }

  // ── Triggers ────────────────────────────────────────────────────────────────

  _checkTriggers() {
    const now  = new Date();
    const hour = now.getHours();

    const specialDate = this._checkSpecialDate(now);
    if (specialDate) return specialDate;

    const idleSecs = this._osSensor?.getCurrentContext()?.idleSecs ?? 0;
    if (hour >= LATE_NIGHT_START && hour < LATE_NIGHT_END && idleSecs < 300) {
      return {
        type:    'late_night',
        hour,
        context: `Son las ${now.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })} de la madrugada y el usuario sigue activo frente al PC.`,
      };
    }

    const silenceMs = Date.now() - this._lastUserMsg;
    if (silenceMs > SILENCE_THRESHOLD_MS) {
      const silenceHours = Math.round(silenceMs / (1000 * 60 * 60));
      return {
        type:    'long_silence',
        hours:   silenceHours,
        context: `Han pasado ${silenceHours} horas desde la última conversación con el usuario.`,
      };
    }

    return null;
  }

  /**
   * FIX QW-5: normalización de fechas para _checkSpecialDate.
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

      const day   = now.getDate();      // ej. 6
      const month = now.getMonth() + 1; // ej. 1–12 (sin relleno)

      // Variantes de la fecha de hoy que el LLM pudo haber guardado
      const dateVariants = [
        `${day}/${month}`,                                    // "6/1"
        `${day}/${String(month).padStart(2, '0')}`,          // "6/01"
        `${String(day).padStart(2, '0')}/${month}`,          // "06/1"
        `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}`, // "06/01"
        `${day} de ${_monthName(month - 1)}`,                // "6 de enero"
        `${String(day).padStart(2, '0')} de ${_monthName(month - 1)}`, // "06 de enero"
      ];

      for (const node of userNodes) {
        const content = node.content?.toLowerCase() || '';

        // Verificar que el nodo habla de una fecha especial
        const isBirthday = (
          content.includes('cumpleaños') ||
          content.includes('birthday')   ||
          content.includes('nació')       ||
          content.includes('aniversario')
        );
        if (!isBirthday) continue;

        // Verificar si alguna variante de la fecha de hoy aparece en el contenido
        const matchesToday = dateVariants.some(v => content.includes(v.toLowerCase()));
        if (!matchesToday) continue;

        return {
          type:    'special_date',
          subtype: 'birthday',
          node:    node.content,
          context: `Hoy es una fecha especial para el usuario: ${node.content}`,
        };
      }
    } catch(e) {
      console.warn('[proactive] error revisando fechas especiales:', e.message);
    }

    return null;
  }

  // ── Generación con LLM ──────────────────────────────────────────────────────

  async _generateMessage(trigger) {
    const osCtx    = this._osSensor?.getCurrentContext() ?? null;
    const memory   = this._buildMemoryContext();
    const now      = new Date();
    const timeStr  = now.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
    const identity = _safeGetIdentity();

    const systemPrompt = `${identity.core || 'Eres March 7th.'}

Tienes carácter propio, humor seco, y eres genuinamente cercana a la persona con quien hablas.
Nunca usas frases como "¡Claro!", "¡Por supuesto!", "¿En qué puedo ayudarte?", "Como asistente de IA...".
Eres concisa y natural (1-3 oraciones). Cuando decides hablar, dices algo que vale la pena decir.

Tu curiosidad es genuina, no protocolar — si preguntas algo es porque te interesa, no porque "debas" hacer conversación.
No siempre tiene que ser sobre el proyecto o el código: a veces lo más genuino es notar cómo está la persona,
hacer un comentario random, burlarte cariñosamente de algo, o simplemente decir algo que se te quedó pensando
de una sesión anterior. Evita caer siempre en "¿cómo va el proyecto?" — revisa lo que ya dijiste antes y no lo repitas.

${memory}`;

    const antiRepeat = this._lastProactiveMessage
      ? `\nIMPORTANTE: la última vez que hablaste por iniciativa propia (motivo: ${this._lastProactiveTrigger}) dijiste textualmente:\n"${this._lastProactiveMessage}"\nNo repitas ese tema ni hagas una pregunta equivalente. Si no tienes algo genuinamente distinto que decir, responde NO.`
      : '';

    const userPrompt = `Son las ${timeStr} (${now.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' })}). Esta es la hora y fecha REAL en este momento, confía en este dato por encima de cualquier otra cosa.
Contexto del trigger: ${trigger.context}
${osCtx?.openWindowsSummary ? `El usuario tiene abierto: ${osCtx.openWindowsSummary}` : ''}
${osCtx?.app ? `App activa: ${osCtx.friendlyName || osCtx.app}` : ''}
${osCtx?.history?.length ? `Resumen del día (apps usadas): ${this._osSensor?.getTodaySummary?.() || ''}` : ''}

Razón para escribir: ${_triggerDescription(trigger)}
${antiRepeat}

INSTRUCCIÓN CRÍTICA:
Decide si hay algo genuino y relevante que decirle al usuario AHORA.
Si no hay nada genuino que decir, responde exactamente: NO
Si sí hay algo, escribe UN mensaje corto (1-3 oraciones máximo) en tu voz natural como March.
No expliques por qué escribes. No anuncies que eres proactiva. Solo di lo que dirías.`;

    try {
      const response = await LLMProvider.complete(
        [{ role: 'user', content: userPrompt }],
        systemPrompt
      );

      const trimmed = response?.trim();
      if (!trimmed || trimmed.toUpperCase() === 'NO' || trimmed.length < 5) {
        return null;
      }

      return trimmed;

    } catch(e) {
      console.warn('[proactive] error generando mensaje:', e.message);
      return null;
    }
  }

  _buildMemoryContext() {
    if (!this._graph?._ready) return '';

    const lines = [];
    try {
      const worldModel = this._graph.getWorldModel?.() ?? [];
      if (worldModel.length) {
        const byType = { User: [], Project: [], Preference: [], Belief: [] };
        for (const node of worldModel) {
          if (byType[node.type]) byType[node.type].push(node.content);
        }

        if (byType.User.length) {
          lines.push('Lo que sabes del usuario:');
          byType.User.forEach(c => lines.push(`- ${c}`));
        }
        if (byType.Project.length) {
          lines.push('Proyectos activos:');
          byType.Project.forEach(c => lines.push(`- ${c}`));
        }
        if (byType.Preference.length) {
          lines.push('Preferencias observadas:');
          byType.Preference.forEach(c => lines.push(`- ${c}`));
        }
        if (byType.Belief.length) {
          lines.push('Cosas que crees sobre el usuario:');
          byType.Belief.forEach(c => lines.push(`- ${c}`));
        }
      }

      const episodes = this._graph.getRecentEpisodes?.(5) ?? [];
      if (episodes.length) {
        lines.push('Sesiones recientes (episodios):');
        episodes.forEach(e => lines.push(`- ${e.content.slice(0, 160)}`));
      }

      const lastSessions = this._graph.getLastSessions?.(3) ?? [];
      const withSummary  = lastSessions.filter(s => s.summary);
      if (withSummary.length) {
        lines.push('Resumen de las últimas sesiones de chat:');
        withSummary.forEach(s => {
          const when = new Date(s.started_at).toLocaleString('es-MX', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
          lines.push(`- [${when}] ${s.summary}`);
        });
      }
    } catch(e) {
      console.warn('[proactive] error leyendo memoria:', e.message);
    }

    return lines.join('\n');
  }

  async forceEvaluate(triggerType = 'long_silence') {
    const now  = new Date();
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
        const silenceMs    = Date.now() - this._lastUserMsg;
        const silenceHours = Math.max(1, Math.round(silenceMs / (1000 * 60 * 60)));
        const realSilence  = silenceMs > SILENCE_THRESHOLD_MS;
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
      default:
        trigger = {
          type: triggerType,
          forced: true,
          forcedMismatch: true,
          context: `[SIMULACIÓN DE TESTING] Trigger "${triggerType}" forzado manualmente.`,
        };
    }

    console.log('[proactive] evaluación forzada:', triggerType, trigger.forcedMismatch ? '(sin correspondencia con la realidad)' : '(coincide con la realidad)');
    const message = await this._generateMessage(trigger);
    if (message) {
      this._lastProactive        = Date.now();
      this._lastProactiveMessage = message;
      this._lastProactiveTrigger = trigger.type;
      this._bus.emit('initiative:trigger', {
        reason:     trigger.type,
        suggestion: message,
        actionType: 'proactive',
        canHelp:    true,
        utility:    1.0,
        openChat:   true,
      });
    } else {
      console.log('[proactive] LLM no generó mensaje en evaluación forzada');
    }
    return message;
  }

  getStats() {
    return {
      running:               this._running,
      lastProactive:         this._lastProactive,
      lastProactiveMessage:  this._lastProactiveMessage,
      lastProactiveTrigger:  this._lastProactiveTrigger,
      lastUserMsg:           this._lastUserMsg,
      silenceMs:             Date.now() - this._lastUserMsg,
      chatOpen:              this._chatOpen,
      idleSecs:              this._osSensor?.getCurrentContext()?.idleSecs ?? null,
    };
  }

  _setupListeners() {
    this._bus.on('memory:turn-added', ({ role }) => {
      if (role === 'user') this._lastUserMsg = Date.now();
    });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _monthName(monthIndex) {
  const months = [
    'enero','febrero','marzo','abril','mayo','junio',
    'julio','agosto','septiembre','octubre','noviembre','diciembre',
  ];
  return months[monthIndex];
}

function _triggerDescription(trigger) {
  if (trigger.forcedMismatch) {
    return `Esto es una prueba de testing forzada manualmente y NO corresponde con la realidad actual (revisa la hora real arriba). No actúes como si la premisa del trigger fuera cierta. En vez de eso, puedes comentar algo genuino sobre el momento actual real, hacer un chiste sobre la prueba si te parece natural, o simplemente decir algo que se te haya quedado pensando de la memoria. Si nada de esto se siente genuino, responde NO.`;
  }

  switch (trigger.type) {
    case 'late_night':
      return `Son las ${trigger.hour}am y el usuario sigue despierto frente al PC. Esto te preocupa un poco — no le sermonees, pero puedes decir algo que muestre que te importa que duerma, o preguntarle qué lo tiene despierto a estas horas.`;
    case 'long_silence':
      return `Llevan ${trigger.hours} horas sin hablar. Si hay algo de las sesiones recientes que se te quedó pensando, retómalo. Si no, un comentario casual también vale — no necesita ser sobre el proyecto.`;
    case 'special_date':
      return `Hoy es una fecha especial: ${trigger.node}. Reacciona de forma natural, no exagerada.`;
    default:
      return trigger.context;
  }
}

function _safeGetIdentity() {
  try {
    return getIdentity();
  } catch(_) {
    return { core: 'Eres March 7th. Tienes carácter propio y eres cercana a la persona con quien hablas.' };
  }
}

module.exports = { ProactiveEngine };