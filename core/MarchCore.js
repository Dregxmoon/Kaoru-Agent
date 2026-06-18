/**
 * MarchCore.js — Fase 3
 *
 * Agrega al stack de Fase 2.5:
 *   - BehaviorModel  → decide tono y comportamiento por turno
 *   - Planner        → descompone acciones en pasos ejecutables
 *   - OpenClawBridge → ejecuta herramientas via HTTP en localhost:18789
 *
 * La separación de responsabilidades se mantiene:
 *   March decide qué hacer  →  Planner descompone  →  OpenClaw ejecuta
 */

const path = require('path');
const fs   = require('fs');

const { getStateGraph }    = require('./state-graph/StateGraph.js');
const { GroundingEngine }  = require('./grounding/GroundingEngine.js');
const { SessionManager }   = require('./state-graph/SessionManager.js');
const { StateUpdater }     = require('./state-graph/StateUpdater.js');
const { OSSensor }         = require('../infrastructure/sensors/OSSensor.js');
const { getEventBus }      = require('../infrastructure/event-bus/EventBus.js');
const { InitiativeEngine } = require('./behavior/InitiativeEngine.js');
const { ProactiveEngine }  = require('./behavior/ProactiveEngine.js');
const { BehaviorModel }    = require('./behavior/BehaviorModel.js');
const { getPlanner }       = require('./planner/Planner.js');
const { getOpenClawBridge } = require('./planner/OpenClawBridge.js');
const LLMProvider           = require('./llm/LLMProvider.js');

let _graph       = null;
let _grounding   = null;
let _session     = null;
let _updater     = null;
let _osSensor    = null;
let _initiative  = null;
let _proactive   = null;
let _behavior    = null;
let _planner     = null;
let _bridge      = null;
let _bus         = null;
let _app         = null;
let _configPath  = null;

let _onInitiative = null;

function init(app) {
  _app = app;
  _bus = getEventBus();

  const dbPath = app
    ? path.join(app.getPath('userData'), 'march.db')
    : path.join(__dirname, '..', 'data', 'march.db');

  _configPath = app
    ? path.join(app.getPath('userData'), 'config.json')
    : null;

  // Subsistemas base (Fases 0-1)
  _graph     = getStateGraph(dbPath);
  _grounding = new GroundingEngine(_graph);
  _session   = new SessionManager(_graph, _grounding);
  _updater   = new StateUpdater(_graph);

  // Subsistemas Fase 2
  _osSensor   = new OSSensor(_graph);
  _initiative = new InitiativeEngine(_graph);

  // Subsistema Fase 2.5
  _proactive = new ProactiveEngine(_graph);

  // ── Subsistemas Fase 3 ────────────────────────────────────────────────────
  _behavior = new BehaviorModel(_graph);
  _planner  = getPlanner();
  _bridge   = getOpenClawBridge();

  // Conectar OSSensor a todos los subsistemas que lo necesitan
  _grounding.setOSSensor(_osSensor);
  if (typeof _initiative.setOSSensor === 'function') _initiative.setOSSensor(_osSensor);
  _proactive.setOSSensor(_osSensor);

  // Arrancar OSSensor solo en Windows
  if (process.platform === 'win32') {
    _osSensor.start();
    console.log('[march-core] OSSensor iniciado');
  } else {
    console.log('[march-core] OSSensor no disponible (no es Windows)');
  }

  // Escuchar iniciativas (InitiativeEngine y ProactiveEngine)
  _bus.on('initiative:trigger', (payload) => {
    console.log(`[march-core] initiative: "${payload.suggestion?.slice(0, 60)}"`);
    if (_onInitiative) _onInitiative(payload);
  });

  // Prune diario de historial de apps
  _scheduleDailyPrune();

  // Cargar configuración LLM
  _loadLLMConfig();

  // Arrancar ProactiveEngine después de que LLMProvider esté configurado
  _proactive.start();

  // Verificar disponibilidad de OpenClaw al arrancar (sin bloquear)
  _bridge.isAvailable().then(available => {
    if (available) {
      console.log('[march-core] OpenClaw disponible — Fase 3 activa');
      _bus.emit('openclaw:available', { available: true });
    } else {
      console.log('[march-core] OpenClaw no detectado — herramientas desactivadas');
    }
  }).catch(() => {});

  console.log('[march-core] inicializado (Fase 3)');
  return { graph: _graph, grounding: _grounding, session: _session };
}

function onInitiative(cb) {
  _onInitiative = cb;
}

function setChatOpen(open) {
  _initiative?.setChatOpen(open);
  _proactive?.setChatOpen(open);
}

// ── Config LLM ────────────────────────────────────────────────────────────────

function _loadLLMConfig() {
  try {
    if (!_configPath || !fs.existsSync(_configPath)) return;
    const cfg = JSON.parse(fs.readFileSync(_configPath, 'utf-8'));
    if (cfg?.llm) {
      LLMProvider.configure(cfg);
      console.log('[march-core] LLMProvider configurado, provider:', LLMProvider.getActiveProvider());
    }
  } catch(e) {
    console.warn('[march-core] error cargando config:', e.message);
  }
}

function reloadLLMConfig() {
  _loadLLMConfig();
}

// ── Sesión ────────────────────────────────────────────────────────────────────

async function startSession() {
  if (!_session) { console.warn('[march-core] no inicializado'); return null; }
  const id = await _session.start(_app);
  _bus.emit('session:started', { sessionId: id });
  return id;
}

async function closeSession() {
  if (_session) {
    await _session.close();
    _bus.emit('session:closed', { sessionId: null });
  }
}

function addTurn(role, content) {
  _session?.addTurn(role, content);
  _bus.emit('memory:turn-added', { role, content });
}

function detectInstant(userMessage) {
  if (!_updater) return;
  _updater.detectAndSaveInstant(userMessage);
}

// ── Context ───────────────────────────────────────────────────────────────────

/**
 * buildContext — Fase 3:
 * Ahora incluye el BehaviorContext serializado en el system prompt.
 *
 * @param {Array}  sessionHistory
 * @param {string} activeProvider
 * @returns {{ systemPrompt: string, messages: Array, behaviorCtx: object }}
 */
function buildContext(sessionHistory, activeProvider) {
  const provider = activeProvider || LLMProvider.getActiveProvider() || 'groq';

  // Último mensaje del usuario para el BehaviorModel
  const lastUserMsg = [...sessionHistory].reverse().find(m => m.role === 'user');
  const userText    = lastUserMsg?.content || '';

  // Obtener contexto OS
  const osCtx = _osSensor?.getCurrentContext() ?? null;

  // Evaluar comportamiento para este turno
  let behaviorCtx = null;
  if (_behavior) {
    try {
      behaviorCtx = _behavior.evaluate(userText, osCtx, sessionHistory);
    } catch(e) {
      console.warn('[march-core] error en BehaviorModel:', e.message);
    }
  }

  // Construir contexto base
  let result;
  if (_grounding) {
    result = _grounding.buildContext(sessionHistory, provider);
  } else {
    const Fallback = require('./llm/GroundingMinimo.js');
    result = Fallback.buildContext(sessionHistory);
  }

  // Inyectar BehaviorContext en el system prompt
  if (behaviorCtx) {
    const behaviorSection = BehaviorModel.serialize(behaviorCtx);
    if (behaviorSection) {
      result.systemPrompt = result.systemPrompt + '\n\n' + behaviorSection;
    }
  }

  // Inyectar estado de OpenClaw si está disponible
  if (_bridge?.getStats()?.available) {
    result.systemPrompt +=
      '\n\n# HERRAMIENTAS DISPONIBLES\n' +
      'Tienes acceso a OpenClaw (localhost:18789). Puedes ejecutar acciones reales en el PC.\n' +
      'Cuando el usuario pida una acción, anuncia lo que vas a hacer antes de hacerlo.\n' +
      'Usa frases como "Voy a buscar eso", "Ejecutando el comando", "Leyendo el archivo".\n' +
      'Tras ejecutar, reporta el resultado de forma natural.';
  }

  return { ...result, behaviorCtx };
}

// ── Fase 3: Planner y OpenClaw ────────────────────────────────────────────────

/**
 * Verifica si OpenClaw está disponible.
 * @returns {Promise<boolean>}
 */
async function isOpenClawAvailable() {
  if (!_bridge) return false;
  return _bridge.isAvailable();
}

/**
 * Parsea una respuesta del LLM buscando acciones y construye un plan.
 * Retorna null si no hay acciones detectadas.
 *
 * @param {string} llmResponse
 * @param {string} userGoal
 * @returns {object|null} Plan
 */
function parsePlanFromResponse(llmResponse, userGoal) {
  if (!_planner) return null;
  return _planner.planFromLLMResponse(llmResponse, userGoal);
}

/**
 * Ejecuta un plan.
 * Emite eventos al EventBus para que main.js pueda notificar al renderer.
 *
 * @param {object}   plan
 * @param {object}   [opts]
 * @param {Function} [opts.onApprovalNeeded]  — async (step) → boolean
 * @param {Function} [opts.onStepStart]       — (step) → void
 * @param {Function} [opts.onStepDone]        — (step, result) → void
 * @returns {Promise<object>} Plan ejecutado
 */
async function executePlan(plan, opts = {}) {
  if (!_planner) throw new Error('Planner no inicializado');

  _bus.emit('plan:started', { planId: plan.id, goal: plan.goal, steps: plan.steps.length });

  const onStepStart = (step) => {
    _bus.emit('plan:step-start', { planId: plan.id, step });
    opts.onStepStart?.(step);
  };

  const onStepDone = (step, result) => {
    _bus.emit('plan:step-done', { planId: plan.id, step, result });
    opts.onStepDone?.(step, result);
  };

  const result = await _planner.execute(plan, {
    ...opts,
    onStepStart,
    onStepDone,
  });

  _bus.emit('plan:finished', { planId: plan.id, status: result.status, result: result.result });
  return result;
}

/**
 * Ejecuta una herramienta directamente (sin plan multi-paso).
 * Para acciones simples y rápidas.
 *
 * @param {string} tool
 * @param {object} params
 * @returns {Promise<object>} resultado del bridge
 */
async function executeTool(tool, params) {
  if (!_bridge) throw new Error('OpenClawBridge no inicializado');
  return _bridge.execute(tool, params);
}

// ── Stats ─────────────────────────────────────────────────────────────────────

function getStats() {
  let busEvents = {};
  try {
    if (typeof _bus?.getActiveEvents === 'function') {
      busEvents = _bus.getActiveEvents();
    } else if (typeof _bus?.eventNames === 'function') {
      busEvents = _bus.eventNames().reduce((acc, name) => {
        acc[name] = _bus.listenerCount(name);
        return acc;
      }, {});
    }
  } catch(_) {}

  return {
    session:    _session?.getStats()            ?? { error: 'no inicializado' },
    osSensor:   _osSensor?.getCurrentContext()  ?? null,
    initiative: _initiative?.getStats()         ?? null,
    proactive:  _proactive?.getStats()          ?? null,
    planner:    _planner?.getStats()            ?? null,
    openclaw:   _bridge?.getStats()             ?? null,
    eventBus:   busEvents,
    provider:   LLMProvider.getActiveProvider() ?? 'groq',
  };
}

// ── Testing ───────────────────────────────────────────────────────────────────

async function forceProactive(triggerType = 'long_silence') {
  return _proactive?.forceEvaluate(triggerType);
}

// ── Prune diario ──────────────────────────────────────────────────────────────

function _scheduleDailyPrune() {
  const run = () => {
    try { _graph?.pruneAppHistory(30); } catch(e) {
      console.warn('[march-core] error en prune diario:', e.message);
    }
  };
  setTimeout(run, 10_000);
  setInterval(run, 24 * 60 * 60 * 1000);
}

// ── Getters ───────────────────────────────────────────────────────────────────

function getGraph()         { return _graph;     }
function getOSSensor()      { return _osSensor;  }
function getGrounding()     { return _grounding; }
function getEventBus_()     { return _bus;       }
function getBehaviorModel() { return _behavior;  }
function getPlanner_()      { return _planner;   }
function getBridge()        { return _bridge;    }

module.exports = {
  init,
  startSession,
  closeSession,
  addTurn,
  detectInstant,
  buildContext,
  getStats,
  getGraph,
  getOSSensor,
  getGrounding,
  getEventBus:      getEventBus_,
  getBehaviorModel,
  getPlanner:       getPlanner_,
  getBridge,
  onInitiative,
  setChatOpen,
  reloadLLMConfig,
  forceProactive,
  // Fase 3
  isOpenClawAvailable,
  parsePlanFromResponse,
  executePlan,
  executeTool,
};
