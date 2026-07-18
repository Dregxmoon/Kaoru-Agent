/**
 * MarchCore.js — Fase 3 + Quick Fixes
 *
 * Fix QW-1: propaga graph.usingFallback al renderer vía IPC.
 * Fix QW-4: init() idempotente.
 * Fase 3 — IntentDetector: buildContext() es async, detecta intención
 *   semántica con embeddings locales e inyecta en el system prompt.
 *
 * FIX Fase 3b: sqlite-vec se carga en la misma conexión del StateGraph
 *   antes de instanciar el IntentDetector, para que la tabla virtual
 *   intent_vectors sea visible desde esa conexión.
 */

const path = require('path');
const fs   = require('fs');

const { getIntentDetector }            = require('./grounding/IntentDetector.js');
const { getStateGraph }                = require('./state-graph/StateGraph.js');
const { GroundingEngine }              = require('./grounding/GroundingEngine.js');
const { SessionManager }               = require('./state-graph/SessionManager.js');
const { StateUpdater }                 = require('./state-graph/StateUpdater.js');
const { OSSensor }                     = require('../infrastructure/sensors/OSSensor.js');
const { getEventBus }                  = require('../infrastructure/event-bus/EventBus.js');
const { InitiativeEngine }             = require('./behavior/InitiativeEngine.js');
const { ProactiveEngine }              = require('./behavior/ProactiveEngine.js');
const { BehaviorModel }                = require('./behavior/BehaviorModel.js');
const { getPlanner, setProjectCWD, isHighImpact } = require('./planner/Planner.js');
const { getOpenClawBridge }            = require('./planner/OpenClawBridge.js');
const { getMCPManager }                = require('./mcp/MCPManager.js');
const LLMProvider                      = require('./llm/LLMProvider.js');

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
let _detector    = null;
let _mcp         = null;

let _initialized  = false;
let _onInitiative = null;

function init(app) {
  if (_initialized) {
    console.warn('[march-core] init() llamado más de una vez — ignorando');
    return { graph: _graph, grounding: _grounding, session: _session };
  }
  _initialized = true;

  _app = app;
  _bus = getEventBus();

  const dbPath = app
    ? path.join(app.getPath('userData'), 'march.db')
    : path.join(__dirname, '..', 'data', 'march.db');

  _configPath = app
    ? path.join(app.getPath('userData'), 'config.json')
    : null;

  _graph = getStateGraph(dbPath);
console.log('[march-core] DEBUG graph.usingFallback:', _graph.usingFallback, '| _graph._db:', !!_graph._db);
  _grounding = new GroundingEngine(_graph);
  _session   = new SessionManager(_graph, _grounding);
  _updater   = new StateUpdater(_graph);

  _osSensor   = new OSSensor(_graph);
  _initiative = new InitiativeEngine(_graph);
  _proactive  = new ProactiveEngine(_graph);

  _behavior = new BehaviorModel(_graph);
  _planner  = getPlanner();
  _bridge   = getOpenClawBridge();
  _mcp      = getMCPManager();

  const projectCWD = app ? app.getAppPath() : process.cwd();
  setProjectCWD(projectCWD);

  _grounding.setOSSensor(_osSensor);
  if (typeof _initiative.setOSSensor === 'function') _initiative.setOSSensor(_osSensor);
  _proactive.setOSSensor(_osSensor);

  if (process.platform === 'win32') {
    _osSensor.start();
    console.log('[march-core] OSSensor iniciado');
  } else {
    console.log('[march-core] OSSensor no disponible (no es Windows)');
  }

  // ── IntentDetector ────────────────────────────────────────────────────────
  // FIX Fase 3b: cargar sqlite-vec en la misma conexión del StateGraph
  // ANTES de instanciar el IntentDetector. Sin esto, intent_vectors no
  // existe para esa conexión y el detector falla silenciosamente.
  if (!_graph.usingFallback && _graph._db) {
    try {
      const sqliteVec = require('sqlite-vec');
      sqliteVec.load(_graph._db);
      console.log('[march-core] sqlite-vec cargado en StateGraph DB');

      _detector = getIntentDetector(_graph._db);
      _detector.warmup().then(() => {
        console.log('[march-core] IntentDetector listo');
      }).catch(e => {
        console.warn('[march-core] IntentDetector warmup falló:', e.message);
      });

      // Recall semántico de memoria (StateGraph.queryNodesSemantic) — misma
      // extensión, misma conexión, tabla vec0 separada de intent_vectors.
      // Backfill de nodos viejos sin embedding corre en segundo plano, en
      // lotes chicos, sin bloquear el arranque ni el primer mensaje.
      if (_graph.enableVectorSearch()) {
        _graph.backfillEmbeddings().catch(e =>
          console.warn('[march-core] backfill de embeddings falló:', e.message)
        );
      }
    } catch(e) {
      console.warn('[march-core] IntentDetector no disponible:', e.message);
      _detector = null;
    }
  } else {
    console.warn('[march-core] IntentDetector desactivado (DB no disponible)');
  }

  _bus.on('initiative:trigger', (payload) => {
    console.log(`[march-core] initiative: "${payload.suggestion?.slice(0, 60)}"`);
    if (_onInitiative) _onInitiative(payload);
  });

  _scheduleDailyPrune();
  _loadLLMConfig();
  _loadMCPConfig();
  _proactive.start();

  _bridge.isAvailable().then(available => {
    if (available) {
      console.log('[march-core] OpenClaw disponible — Fase 3 activa');
      _bus.emit('openclaw:available', { available: true });
    } else {
      console.log('[march-core] OpenClaw no detectado — herramientas desactivadas');
    }
  }).catch(() => {});

  if (_graph.usingFallback) {
    console.error('');
    console.error('╔══════════════════════════════════════════════════════════╗');
    console.error('║  ⚠  ADVERTENCIA CRÍTICA — MEMORIA NO PERSISTENTE        ║');
    console.error('║                                                          ║');
    console.error('║  better-sqlite3 no pudo inicializarse.                  ║');
    console.error('║  March está usando MemoryDB (RAM temporal).             ║');
    console.error('║  Todo lo aprendido esta sesión se perderá al cerrar.    ║');
    console.error('║                                                          ║');
    console.error('║  Solución: npx electron-rebuild -f -w better-sqlite3    ║');
    console.error('╚══════════════════════════════════════════════════════════╝');
    console.error('');
    _bus.emit('march:memory-status', { usingFallback: true });
  }

  console.log('[march-core] inicializado (Fase 3)');
  return { graph: _graph, grounding: _grounding, session: _session };
}

function onInitiative(cb) { _onInitiative = cb; }

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

function reloadLLMConfig() { _loadLLMConfig(); }

// ── MCP ────────────────────────────────────────────────────────────────────────
// Los servidores se guardan/editan desde main.js (que ya tiene loadConfig/
// saveConfig para config.json) — esto solo LEE al arrancar para reconectar
// automáticamente los que estaban enabled:true en la sesión anterior. No
// bloquea init() — si un servidor tarda o falla en conectar, el resto de
// March sigue funcionando normal (por diseño: MCP es una capacidad extra,
// nunca un requisito).
function _loadMCPConfig() {
  try {
    if (!_configPath || !fs.existsSync(_configPath)) return;
    const cfg = JSON.parse(fs.readFileSync(_configPath, 'utf-8'));
    const servers = cfg?.mcp?.servers || [];
    if (!servers.length) return;
    _mcp.init(servers).catch(e => console.warn('[march-core] error inicializando servidores MCP:', e.message));
  } catch(e) {
    console.warn('[march-core] error leyendo config de MCP:', e.message);
  }
}

async function mcpListServers() {
  return _mcp ? _mcp.listServers() : [];
}

async function mcpAddServer(serverCfg) {
  if (!_mcp) throw new Error('MCP no inicializado');
  return _mcp.addServer(serverCfg);
}

async function mcpRemoveServer(id) {
  if (_mcp) await _mcp.removeServer(id);
}

async function mcpToggleServer(id, enabled, serverCfg) {
  if (_mcp) await _mcp.toggleServer(id, enabled, serverCfg);
}

async function mcpSearchRegistry(query) {
  return _mcp ? _mcp.searchRegistry(query) : [];
}

function mcpListAllTools() {
  return _mcp ? _mcp.listAllTools() : [];
}

// ── Sesión ────────────────────────────────────────────────────────────────────

async function startSession() {
  if (!_session) { console.warn('[march-core] no inicializado'); return null; }
  const result = await _session.start(_app);
  _bus.emit('session:started', { sessionId: result.sessionId, resumed: result.resumed });
  return result; // { sessionId, resumed, history }
}

async function closeSession() {
  if (_session) {
    await _session.close();
    _bus.emit('session:closed', { sessionId: null });
  }
}

/**
 * Cierre ordenado. Lo más importante acá: los servidores MCP corren como
 * procesos hijos (típicamente `npx ...`) — si la app se cierra sin
 * desconectarlos, pueden quedar huérfanos corriendo en el sistema. Se
 * llama desde main.js en 'before-quit', con timeout, igual que closeSession.
 */
async function shutdown() {
  console.log('[march-core] cerrando...');
  if (_mcp) {
    try { await _mcp.disconnectAll(); } catch(e) { console.warn('[march-core] error desconectando MCP:', e.message); }
  }
  _proactive?.stop();
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

async function buildContext(sessionHistory, activeProvider) {
  const provider = activeProvider || LLMProvider.getActiveProvider() || 'groq';

  const lastUserMsg = [...sessionHistory].reverse().find(m => m.role === 'user');
  const userText    = lastUserMsg?.content || '';

  const osCtx = _osSensor?.getCurrentContext() ?? null;

  // BehaviorModel
  let behaviorCtx = null;
  if (_behavior) {
    try {
      behaviorCtx = _behavior.evaluate(userText, osCtx, sessionHistory);
    } catch(e) {
      console.warn('[march-core] error en BehaviorModel:', e.message);
    }
  }

  // IntentDetector
  let toolIntent = null;
  if (_detector) {
    try {
      toolIntent = await _detector.detect(userText);
      if (toolIntent.detected) {
        console.log(
          `[march-core] toolIntent: ${toolIntent.action}` +
          ` (${(toolIntent.confidence * 100).toFixed(0)}%, ${toolIntent.level})`
        );
      }
    } catch(e) {
      console.warn('[march-core] IntentDetector error:', e.message);
    }
  }

  // GroundingEngine
  let result;
  if (_grounding) {
    result = await _grounding.buildContext(sessionHistory, provider, toolIntent);
  } else {
    const Fallback = require('./llm/GroundingMinimo.js');
    result = Fallback.buildContext(sessionHistory);
  }

  // BehaviorModel — inyectar sección
  if (behaviorCtx) {
    const behaviorSection = BehaviorModel.serialize(behaviorCtx);
    if (behaviorSection) {
      result.systemPrompt = result.systemPrompt + '\n\n' + behaviorSection;
    }
  }

  // OpenClaw — solo si no hay toolIntent detectado
  if (_bridge?.getStats()?.available && !toolIntent?.detected) {
    result.systemPrompt +=
      '\n\n# HERRAMIENTAS DISPONIBLES — REGLAS ESTRICTAS\n' +
      'Tienes acceso a OpenClaw para ejecutar acciones reales en el PC del usuario.\n\n' +
      'REGLA 1 — ANUNCIA, NO EJECUTES EN PROSA:\n' +
      'Para ejecutar un comando di EXACTAMENTE: "Ejecutar: git status"\n' +
      'Para leer un archivo di EXACTAMENTE: "Voy a leer el archivo README.md"\n' +
      'Para editar un archivo di EXACTAMENTE: "Voy a escribir el archivo README.md"\n\n' +
      'REGLA 2 — NUNCA INVENTES RESULTADOS:\n' +
      'JAMÁS describas el resultado de un comando antes de ejecutarlo.\n' +
      'JAMÁS escribas output de comandos inventado (hashes de commit, listas de archivos, etc).\n' +
      'Si el usuario pide git add + git commit, anuncia cada comando por separado.\n' +
      'El sistema ejecutará los comandos y tú recibirás el resultado real.\n\n' +
      'REGLA 3 — SECUENCIA DE COMANDOS:\n' +
      'Si el usuario pide varios comandos en orden, anúncialos TODOS en la misma respuesta, uno por línea.\n' +
      'Formato exacto para múltiples comandos:\n' +
      'Ejecutar: git add .\n' +
      'Ejecutar: git commit -m "mensaje"\n' +
      'Ejecutar: git push origin 7March\n' +
      'El sistema los ejecutará en orden automáticamente.';
  }

  // MCP — independiente de toolIntent y de si OpenClaw está disponible.
  // Si hay servidores MCP conectados, sus tools se suman siempre — esa es
  // justo la idea: otra fuente de herramientas, no otra dependencia.
  if (_mcp?.hasConnectedServers()) {
    const mcpTools = _mcp.listAllTools();
    if (mcpTools.length) {
      result.systemPrompt += _buildMCPCatalogPrompt(mcpTools);
    }
  }

  return { ...result, behaviorCtx, toolIntent };
}

/**
 * Construye el bloque de system prompt que le enseña al LLM qué tools MCP
 * hay disponibles ahora mismo y el formato exacto para usarlas. Se limita
 * a 40 tools para no inflar el prompt si hay muchos servidores conectados.
 */
function _buildMCPCatalogPrompt(mcpTools) {
  const lines = mcpTools.slice(0, 40).map(t => {
    const desc = (t.description || '').replace(/\s+/g, ' ').slice(0, 100);
    return `  - ${t.server}:${t.tool}${desc ? ' — ' + desc : ''}`;
  });

  return '\n\n# HERRAMIENTAS MCP DISPONIBLES\n' +
    'Además de lo anterior, tienes acceso a estas herramientas de servidores MCP conectados:\n' +
    lines.join('\n') + '\n\n' +
    'Para usar una, responde con este formato exacto (sin narrativa alrededor del bloque):\n' +
    '```action\n' +
    'ACCIÓN: mcp_call | SERVIDOR: <nombre-servidor> | HERRAMIENTA: <nombre-herramienta> | PARAMS: {"clave": "valor"}\n' +
    '```\n' +
    'PARAMS debe ser JSON válido en una sola línea con los argumentos que la herramienta espera ' +
    '(puede ser {} si no necesita ninguno). El sistema pedirá confirmación al usuario antes de ' +
    'ejecutar cualquier herramienta MCP — no asumas que ya se ejecutó ni inventes su resultado.';
}

// ── Fase 3: Planner y OpenClaw ────────────────────────────────────────────────

async function isOpenClawAvailable() {
  if (!_bridge) return false;
  return _bridge.isAvailable();
}

function parsePlanFromResponse(llmResponse, userGoal, toolIntent = null) {
  if (!_planner) return null;
  return _planner.planFromLLMResponse(llmResponse, userGoal, toolIntent);
}

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

  const result = await _planner.execute(plan, { ...opts, onStepStart, onStepDone });

  _bus.emit('plan:finished', { planId: plan.id, status: result.status, result: result.result });
  return result;
}

async function executeTool(tool, params) {
  if (!_bridge) throw new Error('OpenClawBridge no inicializado');

  // FIX — defensa en profundidad: executeTool() (vía IPC 'openclaw-execute-tool')
  // es un camino directo a OpenClawBridge que NO pasa por Planner.execute() ni
  // por su diálogo de aprobación (onApprovalNeeded). Hoy ningún renderer lo
  // llama, pero es un IPC handler expuesto y con nodeIntegration activo
  // cualquier script en el chat podría invocarlo. Para que este atajo no sea
  // un bypass total y silencioso del sistema de aprobación, cualquier
  // operación que Planner consideraría "alto impacto" queda bloqueada aquí
  // — ese tipo de acción SOLO puede pasar por el flujo normal con plan +
  // confirmación del usuario.
  if (isHighImpact(tool, params || {})) {
    console.warn(`[march-core] executeTool bloqueado — "${tool}" requiere pasar por el flujo de plan con aprobación, no por el atajo directo`);
    return {
      ok:     false,
      error:  'Esta acción requiere aprobación explícita — usa el flujo de plan (openclaw-parse-plan → openclaw-execute-plan) en vez de executeTool directo.',
      tool,
      result: null,
      elapsed: 0,
    };
  }

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
    session:        _session?.getStats()            ?? { error: 'no inicializado' },
    osSensor:       _osSensor?.getCurrentContext()  ?? null,
    initiative:     _initiative?.getStats()         ?? null,
    proactive:      _proactive?.getStats()          ?? null,
    planner:        _planner?.getStats()            ?? null,
    openclaw:       _bridge?.getStats()             ?? null,
    intentDetector: _detector ? { ready: _detector._ready } : null,
    eventBus:       busEvents,
    provider:       LLMProvider.getActiveProvider() ?? 'groq',
    usingFallback:  _graph?.usingFallback           ?? false,
  };
}

async function forceProactive(triggerType = 'long_silence') {
  return _proactive?.forceEvaluate(triggerType);
}

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
  shutdown,
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
  isOpenClawAvailable,
  parsePlanFromResponse,
  executePlan,
  executeTool,
  mcpListServers,
  mcpAddServer,
  mcpRemoveServer,
  mcpToggleServer,
  mcpSearchRegistry,
  mcpListAllTools,
};
