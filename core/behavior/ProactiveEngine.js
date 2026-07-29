/**
 * ProactiveEngine.js — v2: proactividad autónoma basada en eventos reales del OS
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CAMBIO PRINCIPAL respecto a la versión anterior (Fase 2.5 + QW-5):
 *
 *   Antes, este engine SOLO se evaluaba en un timer fijo cada 5 minutos, y
 *   solo conocía 3 triggers: fecha especial, madrugada, silencio largo.
 *   Toda la proactividad "basada en lo que el usuario está haciendo ahora
 *   mismo" vivía en InitiativeEngine.js — pero ese engine nunca consultaba
 *   al LLM, solo elegía una frase random de un array fijo por categoría
 *   ("Llevas rato en VSCode. ¿Cómo va el código?"). No había análisis real,
 *   solo un timer + un if.
 *
 *   Ahora ProactiveEngine se suscribe DIRECTO a los eventos del OSSensor
 *   (os:app-changed, os:app-tick, os:idle-changed) y analiza patrones de
 *   uso en tiempo real, sin esperar ningún mensaje del usuario:
 *
 *     - sustained_focus       → lleva mucho tiempo enfocado en una categoría
 *                                (código, terminal, docs, diseño, navegador)
 *     - context_switch_thrash → está saltando entre muchas apps distintas
 *                                en poco tiempo (posible señal de estar
 *                                atorado, frustrado o buscando algo)
 *     - return_from_break     → estuvo un rato AFK y acaba de volver
 *
 *   Se suman a los 3 triggers temporales que ya existían:
 *   special_date, late_night, long_silence.
 *
 *   TODOS los triggers — nuevos y viejos — pasan por el mismo pipeline:
 *   una heurística barata actúa como pre-filtro (¿vale la pena siquiera
 *   preguntarle al LLM?) y el LLM es quien decide con criterio real si
 *   dice algo y qué dice — exactamente el mismo patrón "pre-filtro barato
 *   → el modelo decide" que ya usas en IntentDetector (embeddings como
 *   pre-filtro → LLM confirma). El LLM siempre puede responder NO.
 *
 *   InitiativeEngine.js queda DEPRECADO (ver ese archivo) — su tabla de
 *   reglas por categoría se reusa aquí como pre-filtro (FOCUS_RULES), pero
 *   la decisión y el mensaje ahora los genera el LLM con memoria real,
 *   anti-repetición y contexto del OS — no una frase fija de un array.
 *
 * Se mantiene sin cambios de fondo: fix QW-5 de fechas especiales, el
 * pipeline de generación de mensajes con el LLM, y el contrato del payload
 * que emite ('initiative:trigger' con { reason, suggestion, actionType,
 * canHelp, utility, openChat }) — main.js no necesita ningún cambio.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { getEventBus } = require('../../infrastructure/event-bus/EventBus.js');
const LLMProvider     = require('../llm/LLMProvider.js');
const { getIdentity } = require('../grounding/GroundingEngine.js');

// ── Configuración general ───────────────────────────────────────────────────

const EVAL_INTERVAL_MS      = 5 * 60 * 1000;        // heartbeat para triggers temporales
const GLOBAL_MIN_GAP_MS     = 25 * 60 * 1000;        // colchón mínimo entre CUALQUIER mensaje autónomo
const SILENCE_THRESHOLD_MS  = 3 * 60 * 60 * 1000;
const LATE_NIGHT_START      = 0;
const LATE_NIGHT_END        = 5;
const MAX_IDLE_TO_INTERRUPT = 30 * 60;               // segundos — no interrumpir si lleva más de esto AFK
const FOLLOWUP_MULTIPLIER   = 3;                      // cuántas veces el minSec antes de un follow-up
const SESSION_END_MIN_SEC   = 20 * 60;                // mínimo de racha para trigger "fin de sesión"

// ── Pre-filtro barato para triggers basados en actividad del OS ─────────────
// (reemplaza las INITIATIVE_RULES de InitiativeEngine.js — mismo umbral por
// categoría, pero aquí solo decide si vale la pena PREGUNTARLE al LLM, no
// qué decir)
const FOCUS_RULES = {
  code:     { minSec: 5  * 60, label: 'programando' },
  terminal: { minSec: 3  * 60, label: 'en la terminal' },
  docs:     { minSec: 10 * 60, label: 'metido en documentos' },
  design:   { minSec: 10 * 60, label: 'diseñando' },
  browser:  { minSec: 15 * 60, label: 'navegando' },
  // Antes 'game' ni existía como categoría (ver fix en OSSensor.js) — sin
  // esto, jugar era invisible para toda la proactividad sin importar
  // cuánto tiempo llevaras. 40 min porque una sesión de juego típica es
  // más larga que una racha de código antes de que valga la pena comentar.
  game:     { minSec: 40 * 60, label: 'jugando' },
};

const THRASH_WINDOW_MS             = 10 * 60 * 1000; // ventana para detectar "salto entre apps"
const THRASH_MIN_SWITCHES          = 6;               // mínimo de cambios de app en la ventana
const THRASH_MIN_DISTINCT_CATEGORY = 3;                // mínimo de categorías distintas involucradas

const RETURN_MIN_GAP_SEC = 15 * 60;      // mínimo de ausencia para que valga la pena comentar
const RETURN_MAX_GAP_SEC = 3 * 60 * 60;  // más que esto ya es más parecido a "long_silence"

const WORK_CATEGORIES = new Set(['code', 'terminal', 'docs', 'design']);

// Cooldown por TIPO de trigger — tanto para intentos (se le preguntó al LLM,
// haya dicho sí o no) como, en la práctica, para envíos exitosos.
const TRIGGER_COOLDOWN_MS = {
  special_date:          20 * 60 * 60 * 1000,
  late_night:             2 * 60 * 60 * 1000,
  long_silence:           3 * 60 * 60 * 1000,
  sustained_focus:       45 * 60 * 1000,
  context_switch_thrash: 60 * 60 * 1000,
  return_from_break:     45 * 60 * 1000,
  session_end:           60 * 60 * 1000,
};

// ── ProactiveEngine ───────────────────────────────────────────────────────────

class ProactiveEngine {
  constructor(stateGraph) {
    this._graph          = stateGraph;
    this._bus            = getEventBus();
    this._osSensor       = null;
    this._chatOpen       = false;
    this._lastProactive  = 0;     // último mensaje autónomo ENVIADO (cualquier tipo)
    this._lastUserMsg    = Date.now();
    this._timer          = null;
    this._running        = false;
    this._deciding       = false; // lock — solo una consulta al LLM a la vez

    this._lastAttemptByType = {}; // último intento (haya dicho sí o no el LLM) por tipo

    this._lastProactiveMessage = null;
    this._lastProactiveTrigger = null;

    // ── Estado para análisis de actividad en tiempo real ──────────────────
    this._currentCategory       = null;
    this._prevCategory          = null;
    this._prevCategoryStreakSec = 0;
    this._categoryStreakStart   = 0;
    this._categoryStreakFired   = false;
    this._categoryStreakFiredAt = 0;
    this._categoryStreakFollowupFired = false;
    this._recentSwitches        = [];    // [{ts, category, app}] — ventana de thrash
    this._idleStartedAt         = null;  // marca de cuándo empezó el AFK actual

    this._currentProactiveScore = 0.5;
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
    console.log('[proactive] iniciado (eventos del OS en vivo + heartbeat cada 5 min)');
    setTimeout(() => this._evaluateTimeBased(), 2 * 60 * 1000);
    this._timer = setInterval(() => this._evaluateTimeBased(), EVAL_INTERVAL_MS);
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._bus.off('memory:turn-added',  this._boundOnTurnAdded);
    this._bus.off('os:app-changed',     this._boundOnAppChanged);
    this._bus.off('os:app-tick',        this._boundOnAppTick);
    this._bus.off('os:idle-changed',    this._boundOnIdleChanged);
    this._bus.off('behavior:evaluated', this._boundOnBehaviorEval);
    this._running = false;
    console.log('[proactive] detenido');
  }

  // ── Listeners de eventos del OS (análisis en vivo, sin esperar timer) ──────

  _setupListeners() {
    this._boundOnTurnAdded    = ({ role }) => { if (role === 'user') this._lastUserMsg = Date.now(); };
    this._boundOnAppChanged   = (p) => this._onAppChanged(p);
    this._boundOnAppTick      = (p) => this._onAppTick(p);
    this._boundOnIdleChanged  = (p) => this._onIdleChanged(p);
    this._boundOnBehaviorEval = (ctx) => { this._currentProactiveScore = ctx.proactiveScore ?? 0.5; };

    this._bus.on('memory:turn-added',  this._boundOnTurnAdded);
    this._bus.on('os:app-changed',     this._boundOnAppChanged);
    this._bus.on('os:app-tick',        this._boundOnAppTick);
    this._bus.on('os:idle-changed',    this._boundOnIdleChanged);
    this._bus.on('behavior:evaluated', this._boundOnBehaviorEval);
  }

  /** El usuario cambió de app — actualiza racha de enfoque y detecta "thrashing". */
  _onAppChanged({ app, category }) {
    const now = Date.now();

    this._recentSwitches.push({ ts: now, category, app });
    this._recentSwitches = this._recentSwitches.filter(s => now - s.ts <= THRASH_WINDOW_MS);

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
          type:        'session_end',
          prevCategory: this._prevCategory,
          streakSec:   this._prevCategoryStreakSec,
          context:     `El usuario pasó ${streakMinutes} minutos ${FOCUS_RULES[this._prevCategory]?.label || 'trabajando'} y acaba de cambiar a ${category || 'otra cosa'}.`,
        }).catch(e => console.warn('[proactive] error en trigger de session-end:', e.message));
      }

      // Nueva racha de enfoque (solo cuando cambia la categoría)
      this._currentCategory     = category;
      this._categoryStreakStart = now;
      this._categoryStreakFired = false;
      this._categoryStreakFiredAt = 0;
      this._categoryStreakFollowupFired = false;
    }

    const distinctCategories = [...new Set(this._recentSwitches.map(s => s.category))];
    if (
      this._recentSwitches.length >= THRASH_MIN_SWITCHES &&
      distinctCategories.length   >= THRASH_MIN_DISTINCT_CATEGORY
    ) {
      const windowMin = Math.round(THRASH_WINDOW_MS / 60000);
      this._tryTrigger({
        type:        'context_switch_thrash',
        switchCount: this._recentSwitches.length,
        categories:  distinctCategories,
        context:     `El usuario cambió de aplicación ${this._recentSwitches.length} veces en los últimos ${windowMin} minutos, saltando entre: ${distinctCategories.join(', ')}.`,
      }).catch(e => console.warn('[proactive] error en trigger de thrash:', e.message));
    }
  }

  /** El usuario sigue en la misma app — revisa si ya lleva suficiente racha de enfoque. */
  _onAppTick({ friendlyName, category, elapsed, elapsedFormatted, title }) {
    const rule = FOCUS_RULES[category];
    if (!rule) return;
    if (elapsed < rule.minSec) return;

    if (!this._categoryStreakFired) {
      // Primer trigger: acaba de cruzar el umbral mínimo
      this._categoryStreakFired = true;
      this._categoryStreakFiredAt = Date.now();

      this._tryTrigger({
        type:             'sustained_focus',
        category,
        label:            rule.label,
        friendlyName,
        title,
        elapsedSec:       elapsed,
        elapsedFormatted,
        context:          `El usuario lleva ${elapsedFormatted} ${rule.label} en ${friendlyName}${title ? ` ("${title.slice(0, 80)}")` : ''}.`,
      }).catch(e => console.warn('[proactive] error en trigger de enfoque sostenido:', e.message));
      return;
    }

    // Follow-up: si ya pasó bastante más tiempo desde el primer trigger
    if (this._categoryStreakFollowupFired) return;
    const followupThreshold = rule.minSec * FOLLOWUP_MULTIPLIER;
    if (elapsed < followupThreshold) return;

    this._categoryStreakFollowupFired = true;
    this._tryTrigger({
      type:             'sustained_focus',
      subtype:          'followup',
      category,
      label:            rule.label,
      friendlyName,
      title,
      elapsedSec:       elapsed,
      elapsedFormatted,
      context:          `El usuario sigue concentrado después de ${elapsedFormatted} ${rule.label} en ${friendlyName}${title ? ` ("${title.slice(0, 80)}")` : ''}.`,
    }).catch(e => console.warn('[proactive] error en trigger de enfoque sostenido (follow-up):', e.message));
  }

  /** El usuario se fue o volvió del PC — detecta regreso de una ausencia real. */
  _onIdleChanged({ idle, idleSecs }) {
    const now = Date.now();

    if (idle) {
      // Se acaba de cruzar el umbral de idle — estima cuándo empezó realmente
      this._idleStartedAt = now - (idleSecs * 1000);
      return;
    }

    // idle === false → el usuario acaba de volver a estar activo
    if (!this._idleStartedAt) return;
    const gapSec = Math.round((now - this._idleStartedAt) / 1000);
    this._idleStartedAt = null;
    this._categoryStreakFired = false;
    this._categoryStreakFollowupFired = false;

    if (gapSec < RETURN_MIN_GAP_SEC || gapSec > RETURN_MAX_GAP_SEC) return;

    const minutes = Math.round(gapSec / 60);
    this._tryTrigger({
      type:   'return_from_break',
      gapSec,
      context: `El usuario estuvo alejado de la PC unos ${minutes} minutos y acaba de volver a estar activo.`,
    }).catch(e => console.warn('[proactive] error en trigger de regreso:', e.message));
  }

  // ── Evaluación temporal (heartbeat cada 5 min) ──────────────────────────────
  // Cubre los triggers que NO dependen de un evento puntual del OS, sino del
  // paso del tiempo: fecha especial, madrugada, silencio largo.

  async _evaluateTimeBased() {
    const now = new Date();

    const specialDate = this._checkSpecialDate(now);
    if (specialDate) { await this._tryTrigger(specialDate); return; }

    const hour      = now.getHours();
    const idleSecs  = this._osSensor?.getCurrentContext()?.idleSecs ?? 0;

    if (hour >= LATE_NIGHT_START && hour < LATE_NIGHT_END && idleSecs < 300) {
      await this._tryTrigger({
        type:    'late_night',
        hour,
        context: `Son las ${now.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })} de la madrugada y el usuario sigue activo frente al PC.`,
      });
      return;
    }

    const silenceMs = Date.now() - this._lastUserMsg;
    if (silenceMs > SILENCE_THRESHOLD_MS) {
      const silenceHours = Math.round(silenceMs / (1000 * 60 * 60));
      await this._tryTrigger({
        type:    'long_silence',
        hours:   silenceHours,
        context: `Han pasado ${silenceHours} horas desde la última conversación con el usuario.`,
      });
    }
  }

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

      const day   = now.getDate();
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

        const matchesToday = dateVariants.some(v => content.includes(v.toLowerCase()));

        const hasDateKeyword = (
          content.includes('cumpleaños') ||
          content.includes('birthday')   ||
          content.includes('nació')       ||
          content.includes('aniversario') ||
          content.includes('recordatorio') ||
          content.includes('importante')   ||
          content.includes('fecha especial')
        );

        if (hasDateKeyword && matchesToday) {
          const subtype = content.includes('cumpleaños') || content.includes('birthday')
            ? 'birthday' : 'other';
          return {
            type:    'special_date',
            subtype,
            node:    node.content,
            context: `Hoy es una fecha especial para el usuario: ${node.content}`,
          };
        }

        // También detectar fechas en formato ISO guardadas en contenido
        if (content.includes(todayStr) && hasDateKeyword) {
          const subtype = content.includes('cumpleaños') || content.includes('birthday')
            ? 'birthday' : 'other';
          return {
            type:    'special_date',
            subtype,
            node:    node.content,
            context: `Hoy es una fecha especial para el usuario: ${node.content}`,
          };
        }
      }
    } catch(e) {
      console.warn('[proactive] error revisando fechas especiales:', e.message);
    }

    return null;
  }

  // ── Árbitro central: TODO trigger (de OS o de tiempo) pasa por aquí ────────

  /**
   * Punto único de decisión. Aplica todos los filtros baratos (cooldowns,
   * chat abierto, idle, LLM disponible) y, si pasan, consulta al LLM con
   * criterio real. El LLM siempre puede decidir no decir nada.
   */
  async _tryTrigger(trigger) {
    if (this._deciding) return null;          // ya hay una decisión en curso
    if (this._chatOpen) return null;
    if (!LLMProvider.getActiveProvider()) return null;

    const now = Date.now();

    // Ajusta el gap mínimo según qué tan receptivo esté el usuario
    const adjustedGap = Math.round(GLOBAL_MIN_GAP_MS * (1 - (this._currentProactiveScore - 0.3) * 0.5));
    if (now - this._lastProactive < adjustedGap) return null;

    const cooldown    = TRIGGER_COOLDOWN_MS[trigger.type] ?? GLOBAL_MIN_GAP_MS;
    const lastAttempt = this._lastAttemptByType[trigger.type] || 0;
    if (now - lastAttempt < cooldown) return null;

    // No interrumpir si lleva mucho AFK — excepto el trigger que ES,
    // precisamente, "acaba de volver de estar AFK".
    if (trigger.type !== 'return_from_break') {
      const idleSecs = this._osSensor?.getCurrentContext()?.idleSecs ?? 0;
      if (idleSecs > MAX_IDLE_TO_INTERRUPT) return null;
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
      return message;

    } finally {
      this._deciding = false;
    }
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

        // Límite por tipo para no saturar el prompt del LLM
        const MAX_PER_TYPE = 3;
        if (byType.User.length) {
          lines.push('Lo que sabes del usuario:');
          byType.User.slice(-MAX_PER_TYPE).forEach(c => lines.push(`- ${c}`));
        }
        if (byType.Project.length) {
          lines.push('Proyectos activos:');
          byType.Project.slice(-MAX_PER_TYPE).forEach(c => lines.push(`- ${c}`));
        }
        if (byType.Preference.length) {
          lines.push('Preferencias observadas:');
          byType.Preference.slice(-MAX_PER_TYPE).forEach(c => lines.push(`- ${c}`));
        }
        if (byType.Belief.length) {
          lines.push('Cosas que crees sobre el usuario:');
          byType.Belief.slice(-MAX_PER_TYPE).forEach(c => lines.push(`- ${c}`));
        }
      }

      const episodes = this._graph.getRecentEpisodes?.(5) ?? [];
      if (episodes.length) {
        lines.push('Sesiones recientes (episodios):');
        episodes.slice(-3).forEach(e => lines.push(`- ${e.content.slice(0, 160)}`));
      }

      const lastSessions = this._graph.getLastSessions?.(3) ?? [];
      const withSummary  = lastSessions.filter(s => s.summary);
      if (withSummary.length) {
        lines.push('Resumen de las últimas sesiones de chat:');
        withSummary.slice(-2).forEach(s => {
          const when = new Date(s.started_at).toLocaleString('es-MX', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
          lines.push(`- [${when}] ${s.summary}`);
        });
      }
    } catch(e) {
      console.warn('[proactive] error leyendo memoria:', e.message);
    }

    return lines.join('\n');
  }

  // ── Testing manual (DevTools / IPC force-proactive) ─────────────────────────
  // Bypasea los cooldowns a propósito (es una prueba forzada), pero el LLM
  // sigue teniendo la última palabra — puede seguir respondiendo NO.

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
      case 'sustained_focus': {
        const osCtx = this._osSensor?.getCurrentContext();
        const rule  = osCtx?.category ? FOCUS_RULES[osCtx.category] : null;
        const real  = !!(rule && osCtx.elapsed >= rule.minSec);
        const effectiveRule = rule || FOCUS_RULES.code;
        trigger = {
          type: 'sustained_focus',
          category:    osCtx?.category || 'code',
          label:       effectiveRule.label,
          friendlyName: osCtx?.friendlyName || 'la app actual',
          title:       osCtx?.title || '',
          elapsedSec:  osCtx?.elapsed || 0,
          forced: true,
          forcedMismatch: !real,
          context: real
            ? `El usuario lleva ${osCtx.elapsedFormatted} ${effectiveRule.label} en ${osCtx.friendlyName}.`
            : `[SIMULACIÓN DE TESTING] Se está forzando "sustained_focus", pero el usuario no lleva suficiente tiempo enfocado en una categoría reconocida ahora mismo (app actual: ${osCtx?.friendlyName || 'ninguna detectada'}).`,
        };
        break;
      }
      case 'context_switch_thrash': {
        const distinctCategories = [...new Set(this._recentSwitches.map(s => s.category))];
        const real = this._recentSwitches.length >= THRASH_MIN_SWITCHES && distinctCategories.length >= THRASH_MIN_DISTINCT_CATEGORY;
        trigger = {
          type: 'context_switch_thrash',
          switchCount: this._recentSwitches.length,
          categories:  distinctCategories,
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
      const firedAt = Date.now();
      this._lastProactive             = firedAt;
      this._lastAttemptByType[trigger.type] = firedAt;
      this._lastProactiveMessage      = message;
      this._lastProactiveTrigger      = trigger.type;
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
    const now = Date.now();
    return {
      running:               this._running,
      deciding:              this._deciding,
      lastProactive:         this._lastProactive,
      lastProactiveMessage:  this._lastProactiveMessage,
      lastProactiveTrigger:  this._lastProactiveTrigger,
      lastAttemptByType:     this._lastAttemptByType,
      lastUserMsg:           this._lastUserMsg,
      silenceMs:             now - this._lastUserMsg,
      chatOpen:              this._chatOpen,
      idleSecs:              this._osSensor?.getCurrentContext()?.idleSecs ?? null,
      currentCategory:       this._currentCategory,
      categoryStreakSec:     this._categoryStreakStart ? Math.round((now - this._categoryStreakStart) / 1000) : 0,
      categoryStreakFired:   this._categoryStreakFired,
      categoryStreakFollowupFired: this._categoryStreakFollowupFired,
      recentSwitchesCount:   this._recentSwitches.length,
      awaySince:             this._idleStartedAt,
      proactiveScore:        this._currentProactiveScore,
    };
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
    case 'sustained_focus':
      return `El usuario lleva ${trigger.elapsedFormatted || 'un buen rato'} ${trigger.label || 'enfocado'} en ${trigger.friendlyName || 'una aplicación'}${trigger.title ? ` (título de la ventana: "${trigger.title.slice(0, 80)}")` : ''}. Si el título te da una pista concreta de lo que está haciendo, úsala — sé específica, no genérica ("¿cómo va el código?" es el tipo de pregunta que NO quieres repetir siempre). Puedes preguntar algo puntual, comentar el tiempo que lleva metido en esto, o simplemente no decir nada si no tienes algo genuino.`;
    case 'context_switch_thrash':
      return `El usuario cambió de aplicación ${trigger.switchCount} veces en pocos minutos, saltando entre: ${trigger.categories?.join(', ')}. Esto puede ser una señal de que está atorado, distraído, o buscando algo que no encuentra. No lo regañes ni asumas lo peor — puedes preguntar con curiosidad genuina si anda buscando algo o si algo no le está saliendo. Si no se siente genuino, responde NO.`;
    case 'return_from_break':
      return `El usuario estuvo fuera de la PC unos ${Math.round((trigger.gapSec || 0) / 60)} minutos y acaba de volver. Un comentario breve y casual de bienvenida puede ser genuino aquí — pero no es obligatorio, si no tienes algo natural que decir responde NO.`;
    case 'session_end':
      return `El usuario venía de una sesión de ${Math.round((trigger.streakSec || 0) / 60)} minutos en una categoría de trabajo y acaba de cambiar a otra cosa. Puedes comentar algo sobre lo que estaba haciendo, preguntar cómo le fue, o simplemente no decir nada si no se siente genuino.`;
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
