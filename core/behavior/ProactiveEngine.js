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

const crypto          = require('crypto');
const path            = require('path');

const { getEventBus } = require('../../infrastructure/event-bus/EventBus.js');
const LLMProvider     = require('../llm/LLMProvider.js');
const { getIdentity } = require('../grounding/GroundingEngine.js');
const { ProposalStore } = require('./ProposalStore.js');
const { _parseEventTime } = require('../../infrastructure/sensors/UpcomingEventsWatcher.js');

// Fase F: núcleo determinista de decisión + gate de contexto. El LLM produce,
// no decide — estos módulos ponen el criterio barato y traceable.
const { scoreRelevancia, receptividad, AuditLog } = require('../decision/DecisionCore.js');
const { candidateFromTrigger } = require('../decision/SignalNormalizer.js');
const { evaluate: evaluateGate, QueueStore } = require('../decision/ContextGate.js');
const { assess: assessSlo } = require('../decision/SloMonitor.js');

// ── Configuración general ───────────────────────────────────────────────────

const EVAL_INTERVAL_MS      = 5 * 60 * 1000;        // heartbeat para triggers temporales
const GLOBAL_MIN_GAP_MS     = 25 * 60 * 1000;        // colchón mínimo entre CUALQUIER mensaje autónomo
const SILENCE_THRESHOLD_MS  = 3 * 60 * 60 * 1000;
const LATE_NIGHT_START      = 0;
const LATE_NIGHT_END        = 5;
const MAX_IDLE_TO_INTERRUPT = 30 * 60;               // segundos — no interrumpir si lleva más de esto AFK
const RECENT_CHAT_MS        = 2 * 60 * 1000;          // no interrumpir si el usuario conversó hace < 2 min
const FOLLOWUP_MULTIPLIER   = 3;                      // cuántas veces el minSec antes de un follow-up
const SESSION_END_MIN_SEC   = 20 * 60;                // mínimo de racha para trigger "fin de sesión"

// Fase C: presupuesto diario duro de iniciativas proactivas ENVIADAS. Es el
// freno macro ("conocer sin hartar"); el cooldown por tipo es el freno fino.
const DAILY_BUDGET           = 12;
const PENDING_LOOKAHEAD_MS   = 45 * 60 * 1000;        // pendientes a <45 min para el recap de arranque

// G.1: proactividad de alta calidad. Mensajes "relleno" que no aportan nada
// (saludos vacíos, check-ins genéricos) se descartan en modo producción (gate
// admitió). El gate ya validó relevancia; el mensaje debe tener sustancia.
const LOW_VALUE_MSGS = new Set([
  'hola', 'hey', 'hi', 'holi', 'saludos', 'buenas', 'buenas tardes', 'buenos dias',
  'cómo estas', 'como estas', 'cómo va', 'como va', 'cómo va el proyecto', 'como va el proyecto',
  'cómo va todo', 'como va todo', 'cómo va tu dia', 'como va tu dia', 'todo bien', 'todo bien?',
  'que tal', 'qué tal', 'que haces', 'qué haces', 'sigues ahi', 'sigues ahí', 'estas ahi',
  'estás ahí', 'ya atorada', 'ya atorado', 'en qué puedo ayudarte', 'en que puedo ayudarte',
]);

function _isLowValueMessage(msg) {
  const norm = msg.toLowerCase().trim().replace(/[¿?¡!.,:;]/g, '').replace(/\s+/g, ' ').trim();
  if (LOW_VALUE_MSGS.has(norm)) return true;
  if (norm.length < 8) return true; // filler demasiado corto para tener sustancia
  return false;
}

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

// ── Fase A: autonomía con consentimiento ──────────────────────────────────────
// El mensaje proactivo pasa de comentario a *propuesta*: además del texto del
// LLM, el payload lleva un bloque `proposal` determinista (NUNCA inventado por
// el modelo) con un título, un preview de qué pasaría y — si aplica — una
// acción declarada que en la Fase B ejecutará un executor whitelisted tras la
// confirmación del usuario. Hoy la acción se registra (feedback), no se ejecuta.
//
// La escalera: observar → informar → proponer → actuar. El slider de autonomía
// (config `autonomy`) controla cuánto sube el engine en esa escalera:
//   observe → ni informa (sensores corren, cero mensajes proactivos)
//   suggest → informa + propone botones (default)
//   act     → en Fase B habilita ejecutar tras confirmación; hoy = suggest.
const AUTONOMY_MODES = ['observe', 'suggest', 'act'];

// Propuestas por tipo de trigger (+kind del sensor). `action` es declarativo:
// define QUÉ se haría, pero en Fase A no ejecuta nada. `kind: 'info'` = solo
// informar/confirmar; `kind: 'action'` = tiene una acción concreta detrás.
const PROPOSAL_HINTS = {
  git_redflag: {
    env_unignored: {
      title:   'Añadir el archivo sensible a .gitignore',
      preview: 'Añadir a .gitignore el archivo que parece contener secretos, para que no se suba por accidente.',
      kind:    'action',
      action:  { tool: 'gitignore_add', params: {} },
    },
    merge_conflict: {
      title:   'Ver los archivos en conflicto',
      preview: 'Ejecutar git status para listar los archivos que quedaron en conflicto.',
      kind:    'action',
      action:  { tool: 'git_status', params: {} },
    },
    uncommitted: {
      title:   'Ver qué hay sin commitear',
      preview: 'Ejecutar git status para revisar los cambios pendientes.',
      kind:    'action',
      action:  { tool: 'git_status', params: {} },
    },
    default: {
      title:   'Ver el estado del repositorio',
      preview: 'Revisar el estado actual de git en tu workspace.',
      kind:    'action',
      action:  { tool: 'git_status', params: {} },
    },
  },
  system_warning: {
    default: {
      title:   'Ver el detalle de la advertencia',
      preview: 'Revisar qué recurso del sistema está al límite y qué puedes hacer.',
      kind:    'info',
      action:  null,
    },
  },
  error_title: {
    default: {
      title:   'Abrir el chat y verlo juntos',
      preview: 'Te cuento lo que se ve en tu pantalla y vemos si puedo ayudar con el error.',
      kind:    'info',
      action:  null,
    },
  },
  clipboard_context: {
    default: {
      title:   'Trabajar sobre lo que copiaste',
      preview: 'Si es un error o una URL, seguimos desde ahí en el chat.',
      kind:    'info',
      action:  null,
    },
  },
  upcoming_event: {
    default: {
      title:   'Confirmar que lo tengo presente',
      preview: 'Anotado — te lo recuerdo cuando toque.',
      kind:    'info',
      action:  null,
    },
  },
  pending_recap: {
    default: {
      title:   'Retomar lo pendiente',
      preview: 'Recordarte lo que me pediste tener presente al arrancar.',
      kind:    'info',
      action:  null,
    },
  },
  // Fase D: error de código detectado por el LSP. La propuesta pide un parche;
  // si el LLM no logra generar uno válido, cae a informativa (ver el error).
  lsp_error: {
    default: {
      title:   'Proponer un parche para el error',
      preview: 'Generar y proponer un parche que corrija el error detectado por el LSP.',
      kind:    'action',
      action:  { tool: 'apply_patch', params: {} },
    },
    no_patch: {
      title:   'Ver el error de código',
      preview: 'Te enseño dónde está el error en tu código y vemos cómo resolverlo.',
      kind:    'info',
      action:  null,
    },
  },
};

const DEFAULT_AUTONOMY_MODE = 'suggest';

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
  // Señales de sensores — la frecuencia real la marca cada sensor (re-emiten
  // mientras la condición persista); aquí solo se evita consultar al LLM en
  // exceso para el mismo tipo de señal.
  git_redflag:            6 * 60 * 60 * 1000,
  system_warning:         60 * 60 * 1000,
  error_title:            30 * 60 * 1000,
  clipboard_context:      30 * 60 * 1000,
  upcoming_event:         30 * 60 * 1000,
  pending_recap:          60 * 60 * 1000,
  lsp_error:              45 * 60 * 1000,
};

// ── ProactiveEngine ───────────────────────────────────────────────────────────

class ProactiveEngine {
  constructor(stateGraph, opts = {}) {
    this._graph          = stateGraph;
    this._bus            = getEventBus();
    this._osSensor       = null;
    this._chatOpen       = false;
    this._lastProactive  = 0;     // último mensaje autónomo ENVIADO (cualquier tipo)
    this._lastUserMsg    = 0;     // 0 = el usuario aún no ha conversado en esta sesión
    this._startedAt      = Date.now();
    this._timer          = null;
    this._running        = false;
    this._deciding       = false; // lock — solo una consulta al LLM a la vez

    // Fase A: feedback persistido de propuestas + slider de autonomía.
    // El store es opcional — si no se pasa (tests), todo degrada a no-op.
    this._store          = opts.store || null;
    this._autonomyMode   = DEFAULT_AUTONOMY_MODE;

    // Fase B: executor whitelisted de acciones. Opcional — sin él las
    // propuestas solo informan (el botón "Sí, hazlo" solo registra feedback).
    this._executor        = opts.executor || null;
    this._pendingActions  = new Map(); // proposalId → { action, type, at }

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

    // ── Fase F: gate de contexto + audit + cola de diferidos ───────────────
    // Determinista, sin LLM. Si `shadowMode` está activo, el gate y el audit
    // corren completos pero NADA se envía al usuario (dry-run para calibrar).
    this._shadowMode      = !!opts.shadowMode;
    this._audit           = opts.audit || new AuditLog();
    this._queue           = opts.queue || new QueueStore();
    this._receptivity     = 0; // Rec acumulada (EMA) — actualizada por handleDecision
    this._sentFeedback    = new Map(); // proposalId → { type, at } para marcar ignored
    this._ignoredAfterMs  = opts.ignoredAfterMs || 12 * 60 * 60 * 1000; // 12h sin respuesta = ignored
  }

  setOSSensor(osSensor) {
    this._osSensor = osSensor;
  }

  setChatOpen(open) {
    this._chatOpen = open;
  }

  setAutonomyMode(mode) {
    this._autonomyMode = AUTONOMY_MODES.includes(mode) ? mode : DEFAULT_AUTONOMY_MODE;
  }

  getAutonomyMode() {
    return this._autonomyMode;
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
    this._bus.off('git:redflag',           this._boundOnGitRedflag);
    this._bus.off('system:warning',        this._boundOnSystemWarn);
    this._bus.off('os:error-title',        this._boundOnErrorTitle);
    this._bus.off('clipboard:copied',      this._boundOnClipboard);
    this._bus.off('memory:upcoming-event', this._boundOnUpcoming);
    this._bus.off('lsp:error',             this._boundOnLspError);
    this._bus.off('initiative:decision',   this._boundOnDecision);
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
    this._boundOnGitRedflag   = (p) => this._onGitRedflag(p);
    this._boundOnSystemWarn   = (p) => this._onSystemWarning(p);
    this._boundOnErrorTitle   = (p) => this._onErrorTitle(p);
    this._boundOnClipboard    = (p) => this._onClipboard(p);
    this._boundOnUpcoming     = (p) => this._onUpcomingEvent(p);
    this._boundOnLspError     = (p) => this._onLspError(p);
    this._boundOnDecision     = (d) => this.handleDecision(d);

    this._bus.on('memory:turn-added',  this._boundOnTurnAdded);
    this._bus.on('os:app-changed',     this._boundOnAppChanged);
    this._bus.on('os:app-tick',        this._boundOnAppTick);
    this._bus.on('os:idle-changed',    this._boundOnIdleChanged);
    this._bus.on('behavior:evaluated', this._boundOnBehaviorEval);
    this._bus.on('git:redflag',           this._boundOnGitRedflag);
    this._bus.on('system:warning',        this._boundOnSystemWarn);
    this._bus.on('os:error-title',        this._boundOnErrorTitle);
    this._bus.on('clipboard:copied',      this._boundOnClipboard);
    this._bus.on('memory:upcoming-event', this._boundOnUpcoming);
    this._bus.on('lsp:error',             this._boundOnLspError);
    this._bus.on('initiative:decision',   this._boundOnDecision);
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
          type:             'sustained_focus',
          category,
          label:            rule.label,
          friendlyName,
          title,
          elapsedSec:       elapsed,
          elapsedFormatted,
          context:          `El usuario lleva ${elapsedFormatted} ${rule.label} en ${friendlyName}${title ? ` ("${title.slice(0, 80)}")` : ''}.`,
        });
      } catch(e) {
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
        type:             'sustained_focus',
        subtype:          'followup',
        category,
        label:            rule.label,
        friendlyName,
        title,
        elapsedSec:       elapsed,
        elapsedFormatted,
        context:          `El usuario sigue concentrado después de ${elapsedFormatted} ${rule.label} en ${friendlyName}${title ? ` ("${title.slice(0, 80)}")` : ''}.`,
      });
    } catch(e) {
      console.warn('[proactive] error en trigger de enfoque sostenido (follow-up):', e.message);
    }
    if (outcome && outcome.blocked) return;
    this._categoryStreakFollowupFired = true;
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

    // Fase F: al volver de una pausa, es buen momento para reintentar los
    // diferidos que el gate decidió esperar (cola QUEUE). El gate re-evalúa
    // cada uno con el contexto nuevo; los que siguen sin ser buen momento
    // se quedan en cola sin quemar reintentos.
    this._replayQueued();

    const minutes = Math.round(gapSec / 60);
    this._tryTrigger({
      type:   'return_from_break',
      gapSec,
      context: `El usuario estuvo alejado de la PC unos ${minutes} minutos y acaba de volver a estar activo.`,
    }).catch(e => console.warn('[proactive] error en trigger de regreso:', e.message));
  }

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
        type:   candidate.tipo,
        kind:   candidate.kind,
        ...candidate.payload,
        context: candidate.payload.message || candidate.payload.title || '',
      }).catch(e => console.warn('[proactive] error reintentando diferido:', e.message));
    }
  }

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
        this._audit.push({ type: info.type, proposalId, outcome: 'ignored', reason: 'no_response', at: now });
        this._sentFeedback.delete(proposalId);
      }
    }
  }

  /**
   * F-5: estadísticas de SLO por tipo desde el feedback persistido. Las usa
   * el gate (degradación automática) y la telemetría de no-molestia.
   */
  _sloStats() {
    const byType = this._store?.getStats().byType ?? {};
    return assessSlo(byType);
  }

  // ── Señales de los sensores (GitWatcher, SystemWatcher, TitleWatcher,
  //    ClipboardWatcher, UpcomingEventsWatcher) ───────────────────────────────
  // Todas pasan por el mismo _tryTrigger: cooldown por tipo, chat abierto,
  // idle, gap global, y el LLM tiene la última palabra (puede decir NO).

  _onGitRedflag({ kind, message, branch, count, file } = {}) {
    if (!message) return;
    this._tryTrigger({
      type: 'git_redflag', kind, branch, count, file,
      context: message,
    }).catch(e => console.warn('[proactive] error en trigger git_redflag:', e.message));
  }

  _onSystemWarning({ kind, message } = {}) {
    if (!message) return;
    this._tryTrigger({
      type: 'system_warning', kind,
      context: message,
    }).catch(e => console.warn('[proactive] error en trigger system_warning:', e.message));
  }

  _onErrorTitle({ title, app, category } = {}) {
    if (!title) return;
    this._tryTrigger({
      type: 'error_title', app, category,
      context: `La ventana activa parece mostrar un error: "${title.slice(0, 120)}".`,
    }).catch(e => console.warn('[proactive] error en trigger error_title:', e.message));
  }

  _onClipboard({ kind, snippet } = {}) {
    if (!kind || !snippet) return;
    this._tryTrigger({
      type: 'clipboard_context', kind,
      context: kind === 'stacktrace'
        ? `El usuario acaba de copiar un stacktrace de error: "${snippet.slice(0, 120)}".`
        : `El usuario acaba de copiar una URL: "${snippet.slice(0, 120)}".`,
    }).catch(e => console.warn('[proactive] error en trigger clipboard_context:', e.message));
  }

  _onUpcomingEvent({ content, when } = {}) {
    if (!content) return;
    const timeStr = when ? new Date(when).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }) : '';
    this._tryTrigger({
      type: 'upcoming_event',
      context: `El usuario pidió que recordaras: "${content}".${timeStr ? ` Es alrededor de las ${timeStr}.` : ''}`,
    }).catch(e => console.warn('[proactive] error en trigger upcoming_event:', e.message));
  }

  // ── Fase D: errores del LSP como señal proactiva ──────────────────────────
  // El LSPErrorWatcher emite `lsp:error` con el archivo y los diagnósticos de
  // severidad 1. Aquí se convierte en un trigger del pipeline normal (cooldown,
  // presupuesto, chat reciente, y el LLM con la última palabra).

  _onLspError({ file, absPath, workspace, errors, focused, symbols, languageId, fileType } = {}) {
    if (!file || !Array.isArray(errors) || !errors.length) return;
    const first = errors[0];
    this._tryTrigger({
      type: 'lsp_error',
      file, absPath, workspace, errors, symbols, focused,
      languageId, fileType,
      context: `Hay ${errors.length} error(es) de código en "${file}"${focused ? ' — es el archivo que estás viendo' : ''}. El primero: "${first.message.slice(0, 120)}" (línea ${(first.line ?? 0) + 1}).`,
    }).catch(e => console.warn('[proactive] error en trigger lsp_error:', e.message));
  }

  /**
   * Fase D: pide al LLM un parche de reemplazo exacto para el error. Devuelve
   * `{ changes }` o null si no se pudo generar/parsear. Los `old` deben ser
   * fragmentos EXACTOS del archivo (única ocurrencia); el executor los valida
   * antes de proponer nada.
   */
  async _generatePatch(trigger) {
    if (!trigger?.absPath) return null;
    const fs = require('fs');
    let content;
    try { content = fs.readFileSync(trigger.absPath, 'utf-8'); }
    catch(e) { return null; }

    const firstErr = trigger.errors?.[0] || {};
    const errLine  = (firstErr.line ?? 0);

    // Contexto: el fragmento del archivo alrededor del error (texto EXACTO),
    // el/los errores y el símbolo (función) donde está.
    const lines   = content.split('\n');
    const from    = Math.max(0, errLine - 30);
    const to      = Math.min(lines.length, errLine + 40);
    const slice   = lines.slice(from, to).join('\n');

    let symbolsCtx = '';
    if (Array.isArray(trigger.symbols) && trigger.symbols.length) {
      const enclosing = [...trigger.symbols].reverse().find(s => s.line <= errLine) || trigger.symbols[0];
      const near = trigger.symbols
        .filter(s => Math.abs(s.line - errLine) <= 12)
        .slice(0, 5)
        .map(s => `${s.kindName} ${s.name} (línea ${s.line + 1})`);
      symbolsCtx = `Símbolos del archivo:\n${near.join('\n') || '(sin símbolos cercanos)'}`;
      if (enclosing) symbolsCtx += `\nEl error está dentro de: ${enclosing.kindName} ${enclosing.name}.`;
    }

    const errsCtx = trigger.errors.map(e => `- [línea ${(e.line ?? 0) + 1}] ${e.message}${e.code ? ` (${e.code})` : ''}`).join('\n');

    // Lenguaje del archivo (viene del sensor / extensión): el LLM debe parchear
    // en el idioma REAL del archivo. Sin esto, ante `implicit any` (7006) que
    // llega vía checkJs en un .js, un LLM anota sintaxis TS y rompe el archivo.
    const fileType = trigger.fileType || path.extname(trigger.file || '').toLowerCase();
    const langRule = _patchLanguageRule(fileType);

    const systemPrompt = `Eres un asistente de corrección de código. Generas un PARCHE de reemplazo exacto para eliminar los errores reportados. Reglas:
1. Devuelve SOLO JSON: {"changes":[{"old":"...","new":"..."}]}
2. "old" debe ser un fragmento de texto EXACTO del archivo que se te da (respetando espacios y saltos de línea) y debe aparecer UNA sola vez.
3. "new" es el reemplazo corregido.
4. Mínimo de cambios necesario; no reformatees el archivo.
${langRule}`;

    const userPrompt = `Archivo: ${trigger.file}${trigger.fileType ? ` (${trigger.fileType})` : ''}
El contenido REAL del archivo (fragmento alrededor del error, delimitado por ---):
---
${slice}
---
Errores a corregir:
${errsCtx}
${symbolsCtx}
Genera el parche JSON.`;

    try {
      const response = await LLMProvider.complete(
        [{ role: 'user', content: userPrompt }],
        systemPrompt
      );
      const parsed = _extractPatch(response);
      if (!parsed || !Array.isArray(parsed.changes) || !parsed.changes.length) return null;
      const changes = parsed.changes
        .filter(c => c && typeof c.old === 'string' && c.old.trim() && typeof c.new === 'string')
        .slice(0, 6);
      if (!changes.length) return null;
      return { changes };
    } catch(e) {
      console.warn('[proactive] error generando parche:', e.message);
      return null;
    }
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

    const silenceBase = this._lastUserMsg || this._startedAt;
    const silenceMs = Date.now() - silenceBase;
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

    const now  = Date.now();
    const ctx  = this._buildGateContext(now);
    const score = scoreRelevancia(candidate.signal);
    candidate.score = score;

    const result = evaluateGate(candidate, ctx);
    const auditEntry = {
      sensor:      candidate.source.sensor,
      type:        candidate.tipo,
      kind:        candidate.kind,
      signal:      candidate.signal,
      score,
      verdict:     result.decision.verdict,
      reason:      result.decision.reason,
      decisionId:  result.decision.decisionId,
      flow:        result.flow,
      budgetLimit: result.budgetLimit,
      shadow:      this._shadowMode,
      at:          now,
    };
    this._audit.push(auditEntry);

    if (result.queue && !result.admit) {
      this._queue.push(candidate, { now });
    }

    return { ...result.decision, score, flow: result.flow, candidate };
  }

  _buildGateContext(now) {
    const osCtx = this._osSensor?.getCurrentContext?.() ?? {};
    return {
      now,
      chatOpen:        this._chatOpen,
      lastUserMsg:     this._lastUserMsg || 0,
      idleSecs:        osCtx.idleSecs ?? 0,
      appElapsedSec:   this._categoryStreakStart
        ? Math.round((now - this._categoryStreakStart) / 1000)
        : 0,
      recentSwitches:  this._recentSwitches,
      budgetUsed:      this._store?.dailyCount() ?? 0,
      receptivity:     this._receptivity,
      // F-5: tipos degradados por SLO → el gate les sube el umbral de ACT.
      degradedTypes:   this._store ? this._degradedTypes() : undefined,
    };
  }

  _degradedTypes() {
    const { porTipo } = this._sloStats();
    return new Set(Object.values(porTipo).filter(t => t.degraded).map(t => t.type));
  }

  /**
   * Punto único de decisión. Aplica todos los filtros baratos (cooldowns,
   * chat abierto, idle, LLM disponible) y, si pasan, consulta al LLM con
   * criterio real. El LLM siempre puede decidir no decir nada.
   */
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
    if (!this._running) return { blocked: true };         // aún no arrancado (workspace/MCP en init)
    if (this._autonomyMode === 'observe') return { blocked: true }; // slider: solo observar
    if (this._deciding) return { blocked: true };          // ya hay una decisión en curso
    if (!LLMProvider.getActiveProvider()) return { blocked: true };

    const now = Date.now();

    // Fase F: el gate decide ANTES del LLM. En shadow mode el gate y el audit
    // corren, pero nunca se llega a consultar al LLM ni a enviar nada.
    const gate = this._evaluateTrigger(trigger);
    if (gate) {
      if (this._shadowMode) {
        console.log(`[proactive][shadow] gate: ${gate.verdict} (${gate.reason}) score=${gate.score?.toFixed(3)} — sin enviar`);
        return { blocked: true, shadow: true, gate };
      }
      if (gate.verdict === 'DROP' || gate.verdict === 'QUEUE') {
        console.log(`[proactive] gate: ${gate.verdict} (${gate.reason}) score=${gate.score?.toFixed(3)} — ${gate.verdict === 'QUEUE' ? 'diferido' : 'silencio'}`);
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
    const adjustedGap = Math.round(GLOBAL_MIN_GAP_MS * (1 - (this._currentProactiveScore - 0.3) * 0.5));
    if (now - this._lastProactive < adjustedGap) return { blocked: true };

    // Fase C: presupuesto diario duro — si ya se gastaron todas las
    // iniciativas de hoy, se frena ANTES de consultar al LLM (el silencio es
    // respeto). El recuento se hace solo sobre envíos reales.
    if (this._store && this._store.dailyCount() >= DAILY_BUDGET) {
      console.log(`[proactive] presupuesto diario agotado (${this._store.dailyCount()}/${DAILY_BUDGET})`);
      return { blocked: true };
    }

    // Cooldown efectivo por tipo — crece si el usuario ha descartado este
    // tipo varias veces seguidas (Fase A: el rechazo enseña).
    const baseCooldown = TRIGGER_COOLDOWN_MS[trigger.type] ?? GLOBAL_MIN_GAP_MS;
    const cooldown     = this._effectiveCooldownMs(trigger.type, baseCooldown);
    const lastAttempt  = this._lastAttemptByType[trigger.type] || 0;
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

      this._lastProactive        = Date.now();
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
  }

  // ── Fase C: recap de pendientes al arrancar ─────────────────────────────────
  // Retomar hilos: al arrancar, si hay recordatorios guardados (nodos
  // `recordar_*`) con hora próxima o día de hoy, el asistente ofrece retomarlos. Va
  // por el mismo pipeline (LLM con la última palabra, cooldowns, presupuesto),
  // así no se convierte en un ladrido automático al boot.

  _collectPendingReminders() {
    if (!this._graph?.queryNodes) return [];
    let nodes = [];
    try { nodes = this._graph.queryNodes({ type: 'Belief', limit: 50 }) || []; } catch(e) {
      console.warn('[proactive] error leyendo recordatorios:', e.message);
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
  }

  /** Al arrancar: si hay pendientes, se ofrece retomarlos (si el LLM da el OK). */
  async pendingRecap() {
    if (!this._running) return null;
    if (this._autonomyMode === 'observe') return null;
    const pendings = this._collectPendingReminders();
    if (!pendings.length) return null;

    const list = pendings
      .map(p => `${p.content.replace(/^pidió recordar:\s*/i, '')} (${_friendlyWhen(p.when)})`)
      .slice(0, 3)
      .join('; ');
    return this._tryTrigger({
      type: 'pending_recap',
      context: `Al arrancar la sesión hay pendientes que el usuario pidió recordar: ${list}. Ofrece retomarlos con naturalidad.`,
    });
  }

  // ── Fase A: propuestas con consentimiento ────────────────────────────────────

  /**
   * Ensambla el payload de iniciativa. `proposal` es un bloque DETERMINISTA
   * (nunca lo inventa el LLM): título, preview y acción declarada vienen del
   * mapa PROPOSAL_HINTS según tipo/kind del sensor. Si hay executor (Fase B),
   * la preview se enriquece con el diff real (solo lectura) de la acción; la
   * MUTACIÓN solo ocurre tras el clic del usuario (handleDecision). Si no hay
   * hint, la iniciativa es solo informativa (proposal: null).
   */
  async _buildPayload(trigger, message) {
    const proposal = await this._buildProposal(trigger);
    return {
      reason:     trigger.type,
      suggestion: message,
      actionType: 'proactive',
      canHelp:    true,
      utility:    1.0,
      openChat:   true,
      proposalId: proposal ? proposal.id : null,
      proposal,
    };
  }

  async _buildProposal(trigger) {
    const byKind = PROPOSAL_HINTS[trigger.type];
    if (!byKind) return null;
    let hint = (trigger.kind && byKind[trigger.kind]) || byKind.default || null;
    if (!hint) return null;

    // Fase D: para apply_patch el parche lo genera el LLM y lo VALIDA el
    // executor (fragmentos exactos y únicos). Si no se logra un parche
    // válido, la propuesta cae a informativa (no_patch): nunca se promete
    // un parche que no se pueda aplicar.
    let action = null;
    if (hint.action?.tool === 'apply_patch') {
      const patch = await this._generatePatch(trigger);
      if (patch && patch.changes && patch.changes.length) {
        action = {
          tool: 'apply_patch',
          params: {
            file:         trigger.file,
            changes:      patch.changes,
            targetErrors: trigger.errors || [],
          },
        };
      } else {
        hint = byKind.no_patch || null;
        if (!hint) return null;
      }
    } else if (hint.action) {
      // Fase B: la acción se resuelve en el backend (whitelist), nunca confía
      // en lo que devuelva el renderer. Los params se derivan del trigger.
      action = { tool: hint.action.tool, params: this._resolveActionParams(hint.action.tool, trigger) };
    }

    let preview = hint.preview;
    let diff    = null;
    if (action && this._executor) {
      try {
        const p = await this._executor.preview(action);
        if (p && p.ok) {
          if (p.preview) preview = p.preview;
          if (p.diff)    diff    = p.diff;
        }
      } catch(e) {
        console.warn('[proactive] error generando preview de acción:', e.message);
      }
    }

    const proposal = {
      id:               crypto.randomUUID(),
      type:             trigger.type,
      kind:             hint.kind || 'info',
      title:            hint.title,
      preview,
      diff,
      action,
      requiresConsent:  action ? 'confirm' : null,
      createdAt:        Date.now(),
    };

    if (action) {
      // Memoria efímera de acciones pendientes (la ejecución llega en
      // handleDecision). Se acota para no crecer sin límite.
      this._pendingActions.set(proposal.id, { action, type: trigger.type, at: Date.now() });
      if (this._pendingActions.size > 50) {
        const oldest = this._pendingActions.keys().next().value;
        this._pendingActions.delete(oldest);
      }
    }

    return proposal;
  }

  /** Los params de la acción son deterministas y acotados al tipo de señal. */
  _resolveActionParams(tool, trigger) {
    if (tool === 'gitignore_add') return { file: trigger.file || '.env' };
    return {};
  }

  /** Factor de cooldown según rechazos consecutivos persistidos del tipo. */
  _effectiveCooldownMs(type, baseCooldown) {
    const factor = this._store?.cooldownMultiplier(type) ?? 1;
    return Math.round(baseCooldown * factor);
  }

  getCooldownFor(type) {
    const base = TRIGGER_COOLDOWN_MS[type] ?? GLOBAL_MIN_GAP_MS;
    return { base, effective: this._effectiveCooldownMs(type, base), factor: this._effectiveCooldownMs(type, base) / base };
  }

  /**
   * El usuario respondió a una propuesta (botón del chat). Se persiste el
   * feedback por tipo; el próximo cálculo de cooldown lo tiene en cuenta.
   * Si aceptó y la propuesta tiene una acción pendiente, se ejecuta con el
   * executor whitelisted (Fase B) — pero SIN sostener el lock `_deciding`,
   * que ya se liberó al terminar `_tryTrigger`.
   * Fire-and-forget: nunca debe romper ni bloquear el flujo del chat.
   */
  handleDecision({ proposalId, type, decision, reason } = {}) {
    if (!proposalId || !type || !decision) return false;
    if (decision !== 'accepted' && decision !== 'rejected') return false;

    // F-5: la propuesta recibió respuesta → deja de estar "pendiente".
    if (this._sentFeedback.has(proposalId)) this._sentFeedback.delete(proposalId);

    // Fase F: el outcome real del usuario alimenta la receptividad (EMA).
    this._receptivity = receptividad(this._receptivity, {
      accepted: decision === 'accepted',
      rejected: decision === 'rejected',
    });
    this._audit.push({ type, proposalId, outcome: decision, reason, at: Date.now() });

    let state = false;
    if (this._store) {
      try {
        state = this._store.record({ proposalId, type, decision, reason });
        console.log(`[proactive] feedback ${decision} para "${type}" (factor cooldown ahora ×${this._store.cooldownMultiplier(type)})`);
      } catch(e) {
        console.warn('[proactive] error registrando decisión:', e.message);
      }
    }

    if (decision === 'accepted') {
      const pending = this._pendingActions.get(proposalId);
      if (pending && this._executor) {
        this._pendingActions.delete(proposalId);
        this._executeProposal(pending, proposalId, type).catch(e =>
          console.warn('[proactive] error ejecutando propuesta:', e.message)
        );
      }
    } else {
      // Descartada — la acción pendiente deja de existir.
      this._pendingActions.delete(proposalId);
    }

    return state;
  }
  /**
   * Ejecuta la acción de una propuesta aceptada y anuncia el resultado real
   * al bus ('proposal:executed' → Core → chat). Idempotente por
   * proposalId y serializado por el lock propio del executor.
   */
  async _executeProposal(pending, proposalId, type) {
    if (this._executor.isDone(proposalId)) {
      this._bus.emit('proposal:executed', { proposalId, type, ok: true, skipped: true, detail: 'Ya estaba ejecutada.' });
      return;
    }
    try {
      const result = await this._executor.execute(pending.action, { proposalId });
      this._bus.emit('proposal:executed', {
        proposalId,
        type,
        ok:      !!result.ok,
        skipped: !!result.skipped,
        detail:  result.detail || result.reason || null,
      });
    } catch(e) {
      this._bus.emit('proposal:executed', { proposalId, type, ok: false, detail: e.message });
    }
  }

  // ── Generación con LLM ──────────────────────────────────────────────────────

  async _generateMessage(trigger) {
    const osCtx    = this._osSensor?.getCurrentContext() ?? null;
    const memory   = this._buildMemoryContext();
    const now      = new Date();
    const timeStr  = now.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
    const identity = _safeGetIdentity();

    const systemPrompt = `${identity.core || 'Eres la asistente personal de esta computadora.'}

Tienes carácter propio, humor seco, y eres genuinamente cercana a la persona con quien hablas.
Nunca usas frases como "¡Claro!", "¡Por supuesto!", "¿En qué puedo ayudarte?", "Como asistente de IA...".
Eres concisa y natural (1-3 oraciones). Cuando decides hablar, dices algo que vale la pena decir.

Tu curiosidad es genuina, no protocolar — si preguntas algo es porque te interesa, no porque "debas" hacer conversación.
Cuando decidas hablar, debe haber una razón real: un cambio que notaste en la pantalla o en el código, un error, un dato
de memoria que vale la pena traer a colación, o el estado genuino de la persona en este momento. Un saludo vacío o un
"¿cómo va todo?" genérico es peor que no decir nada: si lo único que se te ocurre es relleno, no digas nada.
Evita caer siempre en "¿cómo va el proyecto?" — revisa lo que ya dijiste antes y no lo repitas.

REGLA DE MEMORIA FACTUAL: todo lo que digas sobre la persona, sus fechas, gustos o proyectos debe estar
RESPALDADO por la memoria que aparece abajo en este prompt. Nunca inventes, completes ni infieras datos
personales que no estén ahí (nombres, cumpleaños, horarios, detalles de su vida). Si solo tienes una pista
vaga, pregunta con curiosidad en vez de afirmar. Un "no sé" o un "NO" es siempre mejor que inventar.

${memory}`;

    const antiRepeat = this._lastProactiveMessage
      ? `\nIMPORTANTE: la última vez que hablaste por iniciativa propia (motivo: ${this._lastProactiveTrigger}) dijiste textualmente:\n"${this._lastProactiveMessage}"\nNo repitas ese tema ni hagas una pregunta equivalente. Si no tienes algo genuinamente distinto que decir, responde NO.`
      : '';

    // Fase F: cuando el gate admitió (ACT/ESCALATE), el LLM PRODUCE el mensaje;
    // no decide si intervenir. El criterio ya lo puso el gate determinista.
    const productionMode = trigger._gate
      ? `El gate de contexto ya evaluó esta señal como relevante (score ${trigger._gate.score?.toFixed(3) ?? '?'}, motivo: ${trigger._gate.reason}). Tu trabajo NO es decidir si hablar: ES hablarlo. Escribe el mensaje.`
      : '';

    const userPrompt = `Son las ${timeStr} (${now.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' })}). Esta es la hora y fecha REAL en este momento, confía en este dato por encima de cualquier otra cosa.
Contexto del trigger: ${trigger.context}
${osCtx?.openWindowsSummary ? `El usuario tiene abierto: ${osCtx.openWindowsSummary}` : ''}
${osCtx?.app ? `App activa: ${osCtx.friendlyName || osCtx.app}` : ''}
${osCtx?.history?.length ? `Resumen del día (apps usadas): ${this._osSensor?.getTodaySummary?.() || ''}` : ''}

Razón para escribir: ${_triggerDescription(trigger)}
${antiRepeat}
${productionMode}

INSTRUCCIÓN CRÍTICA:
${productionMode ? 'Escribe UN mensaje corto (1-3 oraciones máximo) en tu voz natural como asistente personal. No expliques por qué escribes. No anuncies que eres proactiva. Solo di lo que dirías.'
  : `Decide si hay algo genuino y relevante que decirle al usuario AHORA.
Si no hay nada genuino que decir, responde exactamente: NO
Si sí hay algo, escribe UN mensaje corto (1-3 oraciones máximo) en tu voz natural como asistente personal.
No expliques por qué escribes. No anuncies que eres proactiva. Solo di lo que dirías.`}`;

    try {
      const response = await LLMProvider.complete(
        [{ role: 'user', content: userPrompt }],
        systemPrompt
      );

      const trimmed = response?.trim();
      if (!trimmed || trimmed.toUpperCase() === 'NO' || trimmed.length < 5) {
        return null;
      }

      // G.1: en modo producción el gate ya admitió la señal; filtrar el relleno
      // genérico que degrada la experiencia (el LLM a veces "saluda" en vez de
      // decir algo con sustancia).
      if (productionMode && _isLowValueMessage(trimmed)) {
        console.log('[proactive] mensaje descartado por relleno (producción):', JSON.stringify(trimmed));
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
        const silenceBase = this._lastUserMsg || this._startedAt;
        const silenceMs    = Date.now() - silenceBase;
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

    console.log('[proactive] evaluación forzada:', triggerType, trigger.forcedMismatch ? '(sin correspondencia con la realidad)' : '(coincide con la realidad)');
    const message = await this._generateMessage(trigger);
    if (message) {
      const firedAt = Date.now();
      this._lastProactive             = firedAt;
      this._lastAttemptByType[trigger.type] = firedAt;
      this._lastProactiveMessage      = message;
      this._lastProactiveTrigger      = trigger.type;
      this._bus.emit('initiative:trigger', await this._buildPayload(trigger, message));
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
      autonomyMode:          this._autonomyMode,
      feedback:              this._store?.getStats() ?? null,
      pendingProposals:      this._pendingActions.size,
      dailyBudget: {
        dayKey: this._store?.getDailyStats().dayKey ?? null,
        count:  this._store?.dailyCount() ?? 0,
        limit:  DAILY_BUDGET,
      },
      gate: {
        shadowMode:  this._shadowMode,
        receptivity: this._receptivity,
        queued:      this._queue.size(),
        audit:       this._audit.getStats(),
      },
      slo: this._store ? this._sloStats() : null,
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
    case 'git_redflag':
      return `Hay una alerta de git en el repositorio del usuario: ${trigger.context} Si es algo que de verdad vale la pena señalar (p. ej. secretos a punto de filtrarse), dilo con naturalidad y sin regaños; si no es el momento o no es genuino, responde NO.`;
    case 'system_warning':
      return `Hay una advertencia del sistema: ${trigger.context} Avisa de forma breve y natural si lo amerita, sin sermonear ni repetir lo obvio. Si no hay nada genuino que decir, responde NO.`;
    case 'error_title':
      return `La ventana activa del usuario parece mostrar un error. Puedes ofrecer ayuda concreta, pero NO asumas que está frustrado ni inventes detalles que no ves. Si no se siente genuino, responde NO.`;
    case 'clipboard_context':
      return `El usuario acaba de copiar contenido de alto valor al portapapeles. Si es un error/stacktrace, puedes ofrecerte a ayudarle con él de forma natural. No menciones que lees el portapapeles. Si no es genuino, responde NO.`;
    case 'upcoming_event':
      return `Hay un recordatorio cercano que el usuario pidió que guardaras. Recuérdaselo de forma breve y natural, sin dramatismo.`;
    case 'lsp_error':
      return `El LSP detectó un error de código en el archivo que el usuario trabaja. Puedes avisarle con naturalidad y ofrecer el parche si es genuino; no inventes el error ni exageres su gravedad. Si no se siente genuino, responde NO.`;
    default:
      return trigger.context;
  }
}

function _safeGetIdentity() {
  try {
    return getIdentity();
  } catch(_) {
    return { core: 'Eres la asistente personal. Tienes carácter propio y eres cercana a la persona con quien hablas.' };
  }
}

// ── Helpers de Fase C ─────────────────────────────────────────────────────────

function _localDayString(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** 0 = mismo día, 1 = mañana, -1 = ayer... (día calendario local). */
function _dayOffset(tsA, tsB) {
  const a = new Date(tsA), b = new Date(tsB);
  const da = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const db = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((da - db) / 86400000);
}

function _friendlyWhen(ts) {
  const offset = _dayOffset(ts, Date.now());
  const time = new Date(ts).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  if (offset === 0) return `hoy a las ${time}`;
  if (offset === 1) return `mañana a las ${time}`;
  return new Date(ts).toLocaleDateString('es-MX', { day: 'numeric', month: 'long' });
}

/**
 * Fase D: extrae el JSON `{ changes: [...] }` de la respuesta del LLM de
 * parches. Defensivo: soporta JSON puro, bloques ```json y el caso de que el
 * modelo envuelva el objeto con texto.
 */
function _extractPatch(response) {
  if (!response) return null;
  let text = String(response).trim();
  if (!text) return null;

  // Quitar fences de código.
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch(_) {}

  // Fallback: capturar el objeto JSON más externo con "changes".
  const start = text.indexOf('{');
  const end   = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch(_) {}

  return null;
}

/**
 * Regla de lenguaje para el prompt de parche: evita que el LLM use sintaxis de
 * un lenguaje distinto al del archivo. El caso típico: un `.js` bajo checkJs
 * reporta `implicit any` (7006) "en TS", y un LLM sin contexto anota
 * `a: number` — sintaxis inválida en JS. Aquí se le dice explícitamente.
 */
function _patchLanguageRule(fileType) {
  const t = String(fileType || '').toLowerCase();
  if (t === '.ts' || t === '.tsx' || t === '.mts' || t === '.cts') {
    return '5. El archivo es TypeScript: las anotaciones de tipos (a: number) son válidas.';
  }
  if (t === '.js' || t === '.jsx' || t === '.mjs' || t === '.cjs') {
    return '5. El archivo es JavaScript: PROHIBIDO usar anotaciones de tipos de TypeScript (a: number) — es sintaxis inválida en JS y rompería el archivo. Los errores de tipos (implicit any) se resuelven con comentarios JSDoc (`/** @param {number} a */`) o simplemente dejando la firma sin tipos.';
  }
  if (t === '.py') {
    return '5. El archivo es Python: respeta la sintaxis de Python (sin tipos TS, sin puntos y comas).';
  }
  return '';
}

module.exports = { ProactiveEngine };
