/**
 * ProactiveEngine.js — Fase 2.5 (extendido)
 *
 * Motor de mensajes proactivos de March.
 * Vive encima del InitiativeEngine — se encarga de los triggers
 * basados en tiempo y fecha, mientras InitiativeEngine maneja los de app.
 *
 * Triggers implementados:
 *   1. Silencio largo     — más de N horas sin hablar con March
 *   2. Hora del día       — madrugada activa, recordatorio de descanso
 *   3. Fecha especial     — cumpleaños u otras fechas del StateGraph
 *
 * Flujo por trigger:
 *   timer dispara → verificar condiciones → LLM evalúa si hay algo genuino →
 *     si sí: genera mensaje en voz de March → emite 'initiative:trigger' →
 *     main.js abre el chat y envía 'march-initiative' al renderer
 *     si no: silencio, reintenta en el próximo ciclo
 *
 * Anti-spam:
 *   - Máximo 1 proactivo cada 4 horas (configurable)
 *   - No dispara si el usuario está idle más de 30 minutos
 *   - No dispara si el chat ya está abierto
 *   - El LLM puede rechazar generar mensaje si no hay nada genuino que decir
 *
 * Memoria extendida (Fase 2.5):
 *   - getWorldModel() — User/Project/Preference/Belief, todo lo importante
 *   - getRecentEpisodes() — qué pasó en sesiones recientes
 *   - getLastSessions() — resúmenes de cierre de sesión
 *   - getTodaySummary() (OSSensor) — qué ha hecho hoy en la PC
 *   - Anti-repetición: recuerda el último mensaje proactivo y su tema,
 *     y le pide al LLM explícitamente no repetirlo
 *
 * Requiere:
 *   - LLMProvider configurado con al menos una key
 *   - StateGraph inicializado (para leer memoria del usuario)
 *   - OSSensor conectado (para leer idle y contexto OS)
 */

const { getEventBus } = require('../../infrastructure/event-bus/EventBus.js');
const LLMProvider     = require('../llm/LLMProvider.js');
const { getIdentity } = require('../grounding/GroundingEngine.js');

// ── Configuración ─────────────────────────────────────────────────────────────

// Cada cuánto evalúa el engine (ms) — cada 5 minutos
const EVAL_INTERVAL_MS = 5 * 60 * 1000;

// Mínimo entre mensajes proactivos (ms)
const MIN_PROACTIVE_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 horas

// Si el usuario lleva más de esto sin hablar, considerar "silencio largo" (ms)
const SILENCE_THRESHOLD_MS = 3 * 60 * 60 * 1000; // 3 horas

// Hora a partir de la cual se considera "madrugada activa" (0-5am)
const LATE_NIGHT_START = 0;
const LATE_NIGHT_END   = 5;

// Si el usuario lleva idle más de esto, no interrumpir (segundos)
const MAX_IDLE_TO_INTERRUPT = 30 * 60; // 30 minutos

// ── ProactiveEngine ───────────────────────────────────────────────────────────

class ProactiveEngine {
  constructor(stateGraph) {
    this._graph          = stateGraph;
    this._bus            = getEventBus();
    this._osSensor       = null;
    this._chatOpen       = false;
    this._lastProactive  = 0;
    this._lastUserMsg    = Date.now(); // se actualiza cuando el usuario habla
    this._timer          = null;
    this._running        = false;

    // Anti-repetición: guardamos el último mensaje proactivo y su trigger
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

  /** Notificar que el usuario acaba de escribir — resetea el reloj de silencio. */
  onUserMessage() {
    this._lastUserMsg = Date.now();
  }

  start() {
    if (this._running) return;
    this._running = true;
    console.log('[proactive] iniciado (eval cada 5 min)');
    // Primera evaluación a los 2 minutos del arranque
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
    // Guardia básica
    if (this._chatOpen) return;
    if (!LLMProvider.getActiveProvider()) return;

    // Tiempo desde último proactivo
    const sinceLastProactive = Date.now() - this._lastProactive;
    if (sinceLastProactive < MIN_PROACTIVE_INTERVAL_MS) return;

    // No interrumpir si el usuario está idle demasiado tiempo
    const idleSecs = this._osSensor?.getCurrentContext()?.idleSecs ?? 0;
    if (idleSecs > MAX_IDLE_TO_INTERRUPT) {
      console.log(`[proactive] usuario idle ${idleSecs}s, omitiendo`);
      return;
    }

    // Evaluar triggers en orden de prioridad
    const trigger = this._checkTriggers();
    if (!trigger) return;

    console.log(`[proactive] trigger: ${trigger.type} — consultando LLM...`);

    // Pedir al LLM que evalúe si hay algo genuino que decir
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
      openChat:   true, // señal para main.js de que debe abrir el chat
    };

    console.log(`[proactive] emitiendo: "${message.slice(0, 60)}..."`);
    this._bus.emit('initiative:trigger', payload);
  }

  // ── Triggers ────────────────────────────────────────────────────────────────

  _checkTriggers() {
    const now  = new Date();
    const hour = now.getHours();

    // 1. Fecha especial — máxima prioridad
    const specialDate = this._checkSpecialDate(now);
    if (specialDate) return specialDate;

    // 2. Madrugada activa — si son las 0-5am y el usuario sigue activo
    const idleSecs = this._osSensor?.getCurrentContext()?.idleSecs ?? 0;
    if (hour >= LATE_NIGHT_START && hour < LATE_NIGHT_END && idleSecs < 300) {
      return {
        type:    'late_night',
        hour,
        context: `Son las ${now.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })} de la madrugada y el usuario sigue activo frente al PC.`,
      };
    }

    // 3. Silencio largo — llevan horas sin hablar
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

  _checkSpecialDate(now) {
    if (!this._graph?._ready) return null;

    // Buscar nodos con fechas especiales en el StateGraph
    try {
      const userNodes = this._graph.queryNodes({ type: 'User', limit: 20 });
      const today     = `${now.getDate()} de ${_monthName(now.getMonth())}`;
      const todayShort = `${now.getDate()}/${now.getMonth() + 1}`;

      for (const node of userNodes) {
        const content = node.content?.toLowerCase() || '';
        // Buscar cumpleaños o fechas especiales
        if (
          content.includes('cumpleaños') ||
          content.includes('birthday') ||
          content.includes('nació') ||
          content.includes('aniversario')
        ) {
          // Verificar si la fecha coincide con hoy
          if (
            content.includes(today.toLowerCase()) ||
            content.includes(todayShort)           ||
            content.includes(`${now.getDate()} de`) // "15 de junio"
          ) {
            return {
              type:    'special_date',
              subtype: 'birthday',
              node:    node.content,
              context: `Hoy es una fecha especial para el usuario: ${node.content}`,
            };
          }
        }
      }
    } catch(e) {
      console.warn('[proactive] error revisando fechas especiales:', e.message);
    }

    return null;
  }

  // ── Generación con LLM ──────────────────────────────────────────────────────

  async _generateMessage(trigger) {
    // Construir contexto para el LLM
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

  /**
   * Construye el contexto de memoria para el LLM.
   * Usa todo lo disponible en el StateGraph:
   *   - getWorldModel(): User, Project, Preference, Belief (lo más importante de todo)
   *   - getRecentEpisodes(): qué pasó en sesiones recientes
   *   - getLastSessions(): resúmenes de cierre de sesión (con summary)
   */
  _buildMemoryContext() {
    if (!this._graph?._ready) return '';

    const lines = [];
    try {
      // Todo lo importante del usuario: identidad, proyectos, preferencias, creencias
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

      // Episodios recientes — qué ha pasado últimamente
      const episodes = this._graph.getRecentEpisodes?.(5) ?? [];
      if (episodes.length) {
        lines.push('Sesiones recientes (episodios):');
        episodes.forEach(e => lines.push(`- ${e.content.slice(0, 160)}`));
      }

      // Resúmenes de sesiones cerradas — más contexto de continuidad
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

  /**
   * Forzar un trigger manualmente — útil para testing.
   * A diferencia de la versión anterior, construye el trigger con datos
   * REALES del sistema (hora actual, silencio real, etc.) en lugar de
   * valores fijos — así March nunca recibe información contradictoria
   * sobre su propio entorno.
   */
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
        // Reusar la detección real de fecha especial; si no hay ninguna hoy,
        // marcar como simulación explícita.
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

  // ── Listeners ───────────────────────────────────────────────────────────────

  _setupListeners() {
    // Resetear reloj de silencio cuando el usuario manda un mensaje
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
  // Si es una simulación de testing que no corresponde a la realidad actual,
  // March debe saberlo explícitamente — nunca debe fingir que es de noche
  // a mediodía, ni que lleva horas en silencio si el usuario acaba de hablar.
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

/** Carga identity.json de forma segura, con fallback mínimo. */
function _safeGetIdentity() {
  try {
    return getIdentity();
  } catch(_) {
    return { core: 'Eres March 7th. Tienes carácter propio y eres cercana a la persona con quien hablas.' };
  }
}

module.exports = { ProactiveEngine };