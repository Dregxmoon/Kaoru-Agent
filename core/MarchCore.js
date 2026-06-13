/**
 * MarchCore.js — Fase 2.5
 *
 * Agrega ProactiveEngine al stack de subsistemas.
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
const LLMProvider          = require('./llm/LLMProvider.js');

let _graph      = null;
let _grounding  = null;
let _session    = null;
let _updater    = null;
let _osSensor   = null;
let _initiative = null;
let _proactive  = null;
let _bus        = null;
let _app        = null;
let _configPath = null;

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

  // Subsistemas base
  _graph     = getStateGraph(dbPath);
  _grounding = new GroundingEngine(_graph);
  _session   = new SessionManager(_graph, _grounding);
  _updater   = new StateUpdater(_graph);

  // Subsistemas Fase 2
  _osSensor   = new OSSensor(_graph);
  _initiative = new InitiativeEngine(_graph);

  // Subsistema Fase 2.5
  _proactive = new ProactiveEngine(_graph);

  // Conectar OSSensor
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

  // Escuchar iniciativas (de InitiativeEngine Y ProactiveEngine)
  _bus.on('initiative:trigger', (payload) => {
    console.log(`[march-core] initiative: "${payload.suggestion?.slice(0, 60)}"`);
    if (_onInitiative) _onInitiative(payload);
  });

  // Prune diario
  _scheduleDailyPrune();

  _loadLLMConfig();

  // Arrancar ProactiveEngine después de que LLMProvider esté configurado
  _proactive.start();

  console.log('[march-core] inicializado (Fase 2.5)');
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

function buildContext(sessionHistory, activeProvider) {
  const provider = activeProvider || LLMProvider.getActiveProvider() || 'groq';
  if (_grounding) return _grounding.buildContext(sessionHistory, provider);
  const Fallback = require('./llm/GroundingMinimo.js');
  return Fallback.buildContext(sessionHistory);
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
    session:    _session?.getStats()           ?? { error: 'no inicializado' },
    osSensor:   _osSensor?.getCurrentContext() ?? null,
    initiative: _initiative?.getStats()        ?? null,
    proactive:  _proactive?.getStats()         ?? null,
    eventBus:   busEvents,
    provider:   LLMProvider.getActiveProvider() ?? 'groq',
  };
}

// ── Testing ───────────────────────────────────────────────────────────────────

/**
 * Forzar un mensaje proactivo manualmente — para testing.
 * @param {string} triggerType — 'long_silence' | 'late_night' | 'special_date'
 */
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

function getGraph()      { return _graph;     }
function getOSSensor()   { return _osSensor;  }
function getGrounding()  { return _grounding; }
function getEventBus_()  { return _bus;       }

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
  getEventBus: getEventBus_,
  onInitiative,
  setChatOpen,
  reloadLLMConfig,
  forceProactive,
};