/**
 * ProactiveEngine.js — v2: proactividad autónoma basada en eventos reales del OS
 *
 * Este archivo es el punto de entrada y composición del engine. La clase se
 * arma aquí a partir de módulos por responsabilidad en `proactive/`:
 *
 *   - proactive/config.js           → constantes y mapas (umbrales, cooldowns,
 *                                     propuestas, categorías de foco).
 *   - proactive/helpers.js          → funciones puras (descripción de triggers,
 *                                     extracción de parches, memoria, fechas).
 *   - proactive/mixins/lifecycle.js → arranque/parada, setters y listeners.
 *   - proactive/mixins/os-events.js → análisis de actividad del OS en vivo.
 *   - proactive/mixins/sensor-events.js → señales de sensores (git, sistema,
 *                                     ventana, portapapeles, recordatorios, LSP).
 *   - proactive/mixins/time-based.js→ triggers temporales (fecha especial,
 *                                     madrugada, silencio, recap de pendientes).
 *   - proactive/mixins/gate.js      → árbitro central: gate Fase F + cooldowns.
 *   - proactive/mixins/proposals.js → propuestas con consentimiento (Fase A/B).
 *   - proactive/mixins/message-gen.js → generación del mensaje con el LLM.
 *   - proactive/mixins/testing.js   → evaluación forzada + getStats.
 *
 * Los métodos se montan en el prototipo con Object.assign, de modo que
 * `module.exports = { ProactiveEngine }` y todo el contrato público quedan
 * idénticos para main.js y los tests.
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
const { AuditLog } = require('../decision/DecisionCore.js');
const { QueueStore } = require('../decision/ContextGate.js');
const { DEFAULT_AUTONOMY_MODE } = require('./proactive/config.js');

const lifecycle = require('./proactive/mixins/lifecycle.js');
const osEvents = require('./proactive/mixins/os-events.js');
const sensorEvents = require('./proactive/mixins/sensor-events.js');
const timeBased = require('./proactive/mixins/time-based.js');
const gate = require('./proactive/mixins/gate.js');
const proposals = require('./proactive/mixins/proposals.js');
const messageGen = require('./proactive/mixins/message-gen.js');
const testing = require('./proactive/mixins/testing.js');

// ── ProactiveEngine ───────────────────────────────────────────────────────────

class ProactiveEngine {
  constructor(stateGraph, opts = {}) {
    this._graph = stateGraph;
    this._bus = getEventBus();
    this._osSensor = null;
    this._chatOpen = false;
    this._lastProactive = 0; // último mensaje autónomo ENVIADO (cualquier tipo)
    this._lastUserMsg = 0; // 0 = el usuario aún no ha conversado en esta sesión
    this._startedAt = Date.now();
    this._timer = null;
    this._running = false;
    this._deciding = false; // lock — solo una consulta al LLM a la vez

    // Fase A: feedback persistido de propuestas + slider de autonomía.
    // El store es opcional — si no se pasa (tests), todo degrada a no-op.
    this._store = opts.store || null;
    this._autonomyMode = DEFAULT_AUTONOMY_MODE;

    // Fase B: executor whitelisted de acciones. Opcional — sin él las
    // propuestas solo informan (el botón "Sí, hazlo" solo registra feedback).
    this._executor = opts.executor || null;
    this._pendingActions = new Map(); // proposalId → { action, type, at }

    this._lastAttemptByType = {}; // último intento (haya dicho sí o no el LLM) por tipo

    this._lastProactiveMessage = null;
    this._lastProactiveTrigger = null;

    // ── Estado para análisis de actividad en tiempo real ──────────────────
    this._currentCategory = null;
    this._prevCategory = null;
    this._prevCategoryStreakSec = 0;
    this._categoryStreakStart = 0;
    this._categoryStreakFired = false;
    this._categoryStreakFiredAt = 0;
    this._categoryStreakFollowupFired = false;
    this._recentSwitches = []; // [{ts, category, app}] — ventana de thrash
    this._idleStartedAt = null; // marca de cuándo empezó el AFK actual

    this._currentProactiveScore = 0.5;
    this._setupListeners();

    // ── Fase F: gate de contexto + audit + cola de diferidos ───────────────
    // Determinista, sin LLM. Si `shadowMode` está activo, el gate y el audit
    // corren completos pero NADA se envía al usuario (dry-run para calibrar).
    this._shadowMode = !!opts.shadowMode;
    this._audit = opts.audit || new AuditLog();
    this._queue = opts.queue || new QueueStore();
    this._receptivity = 0; // Rec acumulada (EMA) — actualizada por handleDecision
    this._sentFeedback = new Map(); // proposalId → { type, at } para marcar ignored
    this._ignoredAfterMs = opts.ignoredAfterMs || 12 * 60 * 60 * 1000; // 12h sin respuesta = ignored
  }
}

Object.assign(ProactiveEngine.prototype, lifecycle);
Object.assign(ProactiveEngine.prototype, osEvents);
Object.assign(ProactiveEngine.prototype, sensorEvents);
Object.assign(ProactiveEngine.prototype, timeBased);
Object.assign(ProactiveEngine.prototype, gate);
Object.assign(ProactiveEngine.prototype, proposals);
Object.assign(ProactiveEngine.prototype, messageGen);
Object.assign(ProactiveEngine.prototype, testing);

module.exports = { ProactiveEngine };
