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
 *
 * FIX (revisión con Claude): el truncado del system prompt a
 * MAX_SYSTEM_CHARS pasaba dentro de GroqSerializer.serialize(), pero
 * buildContext() le pegaba BehaviorModel + reglas de OpenClaw + catálogo
 * MCP DESPUÉS de ese punto — el presupuesto de tokens nunca contaba esas
 * secciones. El truncado se movió aquí, al final, sobre el prompt ya
 * completo. Ver GroqSerializer.js para el otro lado de este mismo fix.
 */

const path   = require('path');
const fs     = require('fs');
const cp     = require('child_process');
const crypto = require('crypto');

const { getIntentDetector }            = require('./grounding/IntentDetector.js');
const { getStateGraph }                = require('./state-graph/StateGraph.js');
const { GroundingEngine }              = require('./grounding/GroundingEngine.js');
const { SessionManager }               = require('./state-graph/SessionManager.js');
const { StateUpdater }                 = require('./state-graph/StateUpdater.js');
const { OSSensor }                     = require('../infrastructure/sensors/OSSensor.js');
const { LinuxOSSensor }                = require('../infrastructure/sensors/LinuxOSSensor.js');
const { GitWatcher }                   = require('../infrastructure/sensors/GitWatcher.js');
const { SystemWatcher }                = require('../infrastructure/sensors/SystemWatcher.js');
const { TitleWatcher }                 = require('../infrastructure/sensors/TitleWatcher.js');
const { ClipboardWatcher }             = require('../infrastructure/sensors/ClipboardWatcher.js');
const { UpcomingEventsWatcher }        = require('../infrastructure/sensors/UpcomingEventsWatcher.js');
const { getEventBus }                  = require('../infrastructure/event-bus/EventBus.js');
const { LSPErrorWatcher }              = require('../infrastructure/sensors/LSPErrorWatcher.js');
const { SymbolIndex }                  = require('./lsp/SymbolIndex.js');
const { ProactiveEngine }              = require('./behavior/ProactiveEngine.js');
const { ProposalStore }                = require('./behavior/ProposalStore.js');
const { ProactiveExecutor }            = require('./behavior/ProactiveExecutor.js');
const { TelemetryStore }               = require('./telemetry/TelemetryStore.js');
const { BehaviorModel }                = require('./behavior/BehaviorModel.js');
const { getPlanner, setProjectCWD, isHighImpact } = require('./planner/Planner.js');
const { getOpenClawBridge }            = require('./planner/OpenClawBridge.js');
const { AgentLoop }                    = require('./planner/AgentLoop.js');
const { getMCPManager }                = require('./mcp/MCPManager.js');
const LLMProvider                      = require('./llm/LLMProvider.js');
const KeychainManager                  = require('../infrastructure/keychain/KeychainManager.js');
const TaskDetector                     = require('./task/TaskDetector.js');
const { getToolRegistry }              = require('./task/ToolRegistry.js');
const { resolveToolset }               = require('./task/ToolResolver.js');

// FIX: presupuesto de tokens del system prompt COMPLETO — antes vivía
// dentro de GroqSerializer.js y se aplicaba antes de pegar BehaviorModel,
// las reglas de OpenClaw y el catálogo MCP. Ahora se aplica aquí, al
// final de buildContext(), sobre el prompt ya ensamblado del todo.
// Se puede cambiar en caliente vía setMaxSystemChars().
let MAX_SYSTEM_CHARS = 14_000; // ~3.5k tokens — conservador pero amplio
const TRUNCATION_SUFFIX = '\n\n[contexto truncado por longitud]';
const OPENCLAW_RETRIES = 15;
const OPENCLAW_RETRY_MS = 400;
const MCP_CATALOG_LIMIT = 40;

function setMaxSystemChars(chars) {
  MAX_SYSTEM_CHARS = Math.max(2000, Math.min(100_000, chars));
  console.log(`[march-core] MAX_SYSTEM_CHARS = ${MAX_SYSTEM_CHARS}`);
}

let _graph       = null;
let _grounding   = null;
let _session     = null;
let _updater     = null;
let _osSensor    = null;
let _proactive   = null;
let _behavior    = null;
let _planner     = null;
let _bridge      = null;
let _bus         = null;
let _app         = null;
let _configPath  = null;
let _detector     = null;
let _mcp          = null;
let _mcpReadyPromise = Promise.resolve();
let _openclawProcess = null;
let _openclawStarting = false;
let _openclawWorkspace = null;
let _taskDetector = null;
let _toolRegistry = null;
let _lspManager = null;
let _gitWatcher   = null;
let _systemWatcher = null;
let _titleWatcher = null;
let _clipboardWatcher = null;
let _eventsWatcher = null;
let _proposalStore = null;
let _proactiveExecutor = null;
let _lspErrorWatcher = null;
let _symbolIndex = null;
let _telemetry = null;
let _activeWorkspace = null;
let _onProposalResult = null;
let _proposalExecutedUnsub = null;
let _lastProposal = null;   // { id, type } de la última propuesta emitida (debug/testing)

let _pruneTimer      = null;
let _pruneInitTimer  = null;
let _openclawKillTimer = null;
let _initiativeUnsub = null;
let _initialized     = false;
let _onInitiative    = null;
let _skillManager    = null;

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
if (process.env.DEBUG) console.log('[march-core] graph.usingFallback:', _graph.usingFallback, '| _graph._db:', !!_graph._db);
  _grounding = new GroundingEngine(_graph);
  _session   = new SessionManager(_graph, _grounding);
  _updater   = new StateUpdater(_graph);

  const SensorClass = process.platform === 'win32'
    ? OSSensor
    : process.platform === 'linux'
      ? LinuxOSSensor
      : null;

  if (SensorClass) {
    _osSensor = new SensorClass(_graph);
    _osSensor.start();
    console.log(`[march-core] ${SensorClass.name} iniciado (${process.platform})`);
  } else {
    _osSensor = null;
    console.log(`[march-core] OSSensor no disponible para ${process.platform}`);
  }

  _proactive  = new ProactiveEngine(_graph, {
    store: (_proposalStore = new ProposalStore({
      filePath: app
        ? path.join(app.getPath('userData'), 'proactive_feedback.json')
        : null,
    })),
    executor: (_proactiveExecutor = new ProactiveExecutor({
      getWorkspace: () => _activeWorkspace,
      // Fase D: guard de archivos abiertos en el editor + verificación LSP
      // post-parche (pull real al LSPManager).
      getOpenFiles: () => _lspErrorWatcher?.getOpenFiles() ?? [],
      getDiagnostics: async (absPath) => {
        if (!_lspManager?.isRunning) return null;
        try { return await _lspManager.getDiagnostics(absPath); } catch { return null; }
      },
      notifyChanged: (absPath, content) => {
        try { _lspManager?.changeDocument(absPath, content); } catch {}
      },
    })),
  });
  _proactive.setAutonomyMode(_readAutonomyConfig());
  console.log(`[march-core] autonomía: ${_proactive.getAutonomyMode()}`);

  _behavior = new BehaviorModel(_graph);
  _planner  = getPlanner();
  _bridge   = getOpenClawBridge();
  _mcp      = getMCPManager();
  _taskDetector = TaskDetector;
  _toolRegistry = getToolRegistry();
  _toolRegistry.setMCPManager(_mcp);
  _toolRegistry.setOpenClawBridge(_bridge);

  _lspManager = new (require('./lsp/LSPManager.js').LSPManager)();
  _toolRegistry.setLSPManager(_lspManager);

  // ── Fase D: índice de símbolos + watcher de errores LSP ─────────────────
  // El LSP pasa a ser un SENSOR del camino proactivo: el watcher convierte
  // los diagnósticos (severidad 1 = errores) en señales `lsp:error`, y el
  // índice de símbolos da contexto de función/clase al parche. Nunca rompe
  // el arranque: sin LSP o sin workspace solo trackea el foco del editor.
  _symbolIndex = new SymbolIndex({ lsp: _lspManager });
  _lspErrorWatcher = new LSPErrorWatcher({
    lsp:            _lspManager,
    getWorkspace:   () => _activeWorkspace,
    getCurrentTitle: () => _osSensor?.getCurrentContext()?.title || '',
    getSymbols:     (file) => _symbolIndex.getSymbolsFor(file),
  });

  _skillManager = new (require('./skills/SkillManager.js').SkillManager)({
    skillsDir: path.join(__dirname, '..', 'skills'),
    db: (!_graph.usingFallback && _graph._db) ? _graph._db : null,
    threshold: 0.72,
    topK: 3,
  });
  if (!_graph.usingFallback && _graph._db) {
    _skillManager.scan(true).then(() => {
      console.log('[march-core] skills escaneadas');
      _skillManager.index().then(() => {
        console.log('[march-core] skills indexadas');
      }).catch(e => console.warn('[march-core] error indexando skills:', e.message));
    }).catch(e => console.warn('[march-core] error escaneando skills:', e.message));
  }

  const projectCWD = app ? app.getAppPath() : process.cwd();
  setProjectCWD(projectCWD);

  if (_osSensor) {
    _grounding.setOSSensor(_osSensor);
    _proactive.setOSSensor(_osSensor);
  }

  // ── Sensores de señales ────────────────────────────────────────────────────
  // Vigilan git, sistema, títulos de ventana, portapapeles (opt-in) y
  // recordatorios próximos. Cada uno emite eventos al bus que el
  // ProactiveEngine ya consume. Nunca rompen el arranque: si uno falla,
  // se loggea y el resto sigue normal. Config: cfg.sensors = { git, system,
  // title, clipboard, events } (todos activos salvo clipboard, que es
  // opt-in por privacidad).
  const sensorsCfg = _readSensorsConfig();
  const startSensor = (label, factory) => {
    try { const s = factory(); s.start(); return s; }
    catch(e) { console.warn(`[march-core] sensor ${label} no disponible:`, e.message); return null; }
  };
  if (sensorsCfg.git !== false) {
    _gitWatcher = startSensor('git', () => new GitWatcher({ workspace: projectCWD }));
  }
  if (sensorsCfg.system !== false) {
    _systemWatcher = startSensor('system', () => new SystemWatcher());
  }
  if (sensorsCfg.title !== false) {
    _titleWatcher = startSensor('title', () => new TitleWatcher());
  }
  if (sensorsCfg.clipboard === true) {
    _clipboardWatcher = startSensor('clipboard', () => new ClipboardWatcher());
  }
  if (sensorsCfg.events !== false) {
    _eventsWatcher = startSensor('upcoming-events', () => new UpcomingEventsWatcher({ graph: _graph }));
  }
  console.log(`[march-core] sensores de señales: git=${_gitWatcher ? 'on' : 'off'} system=${_systemWatcher ? 'on' : 'off'} title=${_titleWatcher ? 'on' : 'off'} clipboard=${_clipboardWatcher ? 'on' : 'off'} eventos=${_eventsWatcher ? 'on' : 'off'}`);

  // ── Fase E: telemetría local ─────────────────────────────────────────────
  // Mide uso real (mensajes/día, tiempo de respuesta, silencios, reuso) en
  // JSON local. El baseline de la tasa de aceptación vive en ProposalStore
  // desde la Fase A — aquí solo se agregan los turnos de conversación.
  _telemetry = new TelemetryStore({
    filePath: app
      ? path.join(app.getPath('userData'), 'telemetry.json')
      : null,
  });

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

  _initiativeUnsub = _bus.on('initiative:trigger', (payload) => {
    if (process.env.DEBUG) console.log(`[march-core] initiative: "${payload.suggestion?.slice(0, 60)}"`);
    _lastProposal = payload.proposal ? { id: payload.proposal.id, type: payload.proposal.type } : null;
    if (_onInitiative) _onInitiative(payload);
  });

  // Fase B: resultado de ejecutar una propuesta proactiva (el clic "Sí, hazlo"
  // ya se procesó en el ProactiveEngine). Se reenvía al renderer para que
  // confirme en el bubble de la propuesta con la verificación REAL.
  _proposalExecutedUnsub = _bus.on('proposal:executed', (payload) => {
    if (process.env.DEBUG) console.log(`[march-core] proposal:executed ok=${payload.ok} "${payload.detail || ''}"`);
    if (_onProposalResult) _onProposalResult(payload);
  });

  _scheduleDailyPrune();
  _loadLLMConfig();
  _loadMCPConfig();

  // Workspace inicial — cargar ANTES de _startOpenClaw para pasar
  // OPENCLAW_ALLOWED_PATH con el directorio correcto.
  const _envWorkspace = process.env.MARCH_WORKSPACE;
  let _persistedWorkspace = null;
  if (!_envWorkspace && _configPath && fs.existsSync(_configPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(_configPath, 'utf-8'));
      if (cfg.activeWorkspace && cfg.activeWorkspace !== projectCWD) _persistedWorkspace = cfg.activeWorkspace;
    } catch(e) { console.warn('[march-core] no se pudo leer config.json:', e.message); }
  }
  const _initialWorkspace = _envWorkspace || _persistedWorkspace || projectCWD;
  _activeWorkspace = _initialWorkspace;

  _startOpenClaw(_initialWorkspace);

  // Workspace inicial async (MCP filesystem)
  if (_initialWorkspace) {
    _mcpReadyPromise.then(() => setActiveWorkspace(_initialWorkspace)).then(r => {
      if (r.ok) {
        console.log(`[march-core] workspace inicial (${_envWorkspace ? 'MARCH_WORKSPACE' : ( _persistedWorkspace ? 'persistido' : 'default' )}):`, r.path);
        _proactive.start();
        // Fase C: ofrecer retomar lo pendiente (recordatorios) al arrancar.
        _proactive.pendingRecap().catch(e =>
          console.warn('[march-core] error en recap de pendientes:', e.message)
        );
        // Fase D: watcher de errores LSP (con su propio scope).
        if (_readSensorsConfig().lsp !== false && _lspErrorWatcher) {
          _lspErrorWatcher.start();
          console.log('[march-core] LSPErrorWatcher activo');
        }
      }
      else console.warn('[march-core] workspace inicial inválido:', r.error);
    });
  }

  if (_graph.usingFallback) {
    console.error('');
    console.error('╔══════════════════════════════════════════════════════════╗');
    console.error('║  ADVERTENCIA CRITICA — MEMORIA NO PERSISTENTE        ║');
    console.error('║                                                          ║');
    console.error('║  better-sqlite3 no pudo inicializarse.                  ║');
    console.error('║  March está usando MemoryDB (RAM temporal).             ║');
    console.error('║  Todo lo aprendido esta sesión se perderá al cerrar.    ║');
    console.error('║                                                          ║');
                console.error('║  Solución: npm install                                    ║');
    console.error('╚══════════════════════════════════════════════════════════╝');
    console.error('');
    _bus.emit('march:memory-status', { usingFallback: true });
  }

  console.log('[march-core] inicializado (Fase 3)');
  return { graph: _graph, grounding: _grounding, session: _session };
}

function onInitiative(cb) { _onInitiative = cb; }

function onProposalResult(cb) { _onProposalResult = cb; }

function setChatOpen(open) {
  _proactive?.setChatOpen(open);
}

// ── Config LLM ────────────────────────────────────────────────────────────────

function _loadLLMConfig() {
  try {
    if (!_configPath || !fs.existsSync(_configPath)) return;
    const cfg = JSON.parse(fs.readFileSync(_configPath, 'utf-8'));

    // Merge con keys del llavero del sistema (máxima prioridad)
    if (cfg?.llm?.apiKeys) {
      const keychainKeys = KeychainManager.getAllKeys(['groq', 'gemini', 'openai']);
      for (const [k, v] of Object.entries(keychainKeys)) {
        if (v) cfg.llm.apiKeys[k] = v;
      }
    }

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
    if (!_configPath || !fs.existsSync(_configPath)) { _mcpReadyPromise = Promise.resolve(); return; }
    const cfg = JSON.parse(fs.readFileSync(_configPath, 'utf-8'));
    const servers = cfg?.mcp?.servers || [];
    if (!servers.length) { _mcpReadyPromise = Promise.resolve(); return; }
    _mcpReadyPromise = _mcp.init(servers).catch(e => console.warn('[march-core] error inicializando servidores MCP:', e.message));
  } catch(e) {
    console.warn('[march-core] error leyendo config de MCP:', e.message);
    _mcpReadyPromise = Promise.resolve();
  }
}

function _readSensorsConfig() {
  try {
    if (!_configPath || !fs.existsSync(_configPath)) return {};
    const cfg = JSON.parse(fs.readFileSync(_configPath, 'utf-8'));
    return (cfg && cfg.sensors) || {};
  } catch(e) {
    return {};
  }
}

function _readAutonomyConfig() {
  try {
    if (!_configPath || !fs.existsSync(_configPath)) return 'suggest';
    const cfg = JSON.parse(fs.readFileSync(_configPath, 'utf-8'));
    return (cfg && cfg.autonomy) || 'suggest';
  } catch(e) {
    return 'suggest';
  }
}

// Fase A: el usuario respondió a una propuesta (aceptar/descartar) desde el
// chat. Se reenvía al ProactiveEngine, que persiste el feedback y ajusta la
// frecuencia futura de ese tipo de iniciativa.
function handleProposalDecision(decision) {
  return _proactive?.handleDecision(decision) ?? false;
}

// ── Debug / testing (local, vía Control API) ──────────────────────────────────
// Permiten verificar el flujo Fase B en vivo: forzar el scan del GitWatcher
// (que dispara el trigger real del sensor) y resolver la última propuesta
// emitida como si el usuario hubiera clicado su botón.

function debugGitScan() {
  if (!_gitWatcher) return { ok: false, error: 'GitWatcher no activo' };
  return _gitWatcher.poll()
    .then(() => ({ ok: true, stats: _gitWatcher.getStats() }))
    .catch(e => ({ ok: false, error: e.message }));
}

function debugResolveLastProposal(accepted) {
  if (!_lastProposal) return { ok: false, error: 'no hay una propuesta reciente para resolver' };
  const decision = accepted ? 'accepted' : 'rejected';
  const ok = _proactive?.handleDecision({ proposalId: _lastProposal.id, type: _lastProposal.type, decision }) ?? false;
  return { ok, proposal: _lastProposal, decision };
}

/** Fase D: fuerza un scan del LSPErrorWatcher (verificación en vivo). */
function debugLSPScan() {
  if (!_lspErrorWatcher) return Promise.resolve({ ok: false, error: 'LSPErrorWatcher no activo' });
  return _lspErrorWatcher.poll()
    .then(() => ({ ok: true, stats: _lspErrorWatcher.getStats() }))
    .catch(e => ({ ok: false, error: e.message }));
}

// ── Fase E: reporte de telemetría ─────────────────────────────────────────────

/** "¿Estamos mejor que el mes pasado?" — métricas de uso real con baseline. */
function getTelemetryReport(opts = {}) {
  if (!_telemetry) return { ok: false, error: 'telemetría no inicializada' };
  const decisions = _proposalStore?.getDecisions?.() ?? [];
  return { ok: true, report: _telemetry.report({ decisions, ...opts }) };
}

/** Snapshots diarios crudos (para el Control API / debugging). */
function getTelemetryStats() {
  return _telemetry?.getStats() ?? null;
}

// ── Fase C: compañero persistente ─────────────────────────────────────────────

/** /olvida X — archiva los nodos de memoria que matcheen el texto. */
function forgetMemory(text) {
  if (!_graph) return { found: 0, archived: 0, error: 'grafo no inicializado' };
  return _graph.forget(text);
}

/** Al arrancar: ofrece retomar lo pendiente (recordatorios guardados). */
function pendingRecap() {
  return _proactive?.pendingRecap() ?? Promise.resolve(null);
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

// ── Workspace ──────────────────────────────────────────────────────────────
// Cambia el repo/carpeta sobre el que March trabaja como agente de código.
// La usan tanto el picker del UI como el comando de terminal `asistente`.
async function setActiveWorkspace(newPath) {
  const resolved = path.resolve(newPath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return { ok: false, error: `"${resolved}" no existe o no es una carpeta` };
  }

  setProjectCWD(resolved);
  _activeWorkspace = resolved;

  if (_mcp) {
    const fsServer = _mcp.listServers().find(s => s.name === 'filesystem');
    if (fsServer) await _mcp.removeServer(fsServer.id);
    await _mcp.addServer({
      name: 'filesystem',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', resolved],
      env: {},
    });
  }

  if (_configPath) {
    try {
      const cfg = fs.existsSync(_configPath) ? JSON.parse(fs.readFileSync(_configPath, 'utf-8')) : {};
      cfg.activeWorkspace = resolved;
      fs.writeFileSync(_configPath, JSON.stringify(cfg, null, 2));
    } catch(e) { console.warn('[march-core] no se pudo persistir workspace:', e.message); }
  }

  // ── LSP: arrancar servidor para el nuevo workspace ─────────────────
  if (_lspManager) {
    (async () => {
      try { await _lspManager.stop(); } catch {}
      try { await _lspManager.start(resolved); console.log('[march-core] LSP listo para', resolved); }
      catch(e) { console.warn('[march-core] LSP no disponible:', e.message); }
    })();
  }

  // ── Fase D: reset del scope del watcher (no mezclar proyectos) ────
  if (_lspErrorWatcher) {
    _lspErrorWatcher.resetWorkspace(resolved);
    if (_readSensorsConfig().lsp !== false) _lspErrorWatcher.poll().catch(() => {});
  }

  // ── FIX (auditoría Fase D): OpenClaw corre con OPENCLAW_ALLOWED_PATH fijado
  // al workspace inicial; si el usuario cambia de proyecto, cualquier comando
  // del nuevo workspace se rechazaría con "cwd outside allowed path". Se
  // reinicia el server con el nuevo path permitido (pocas veces al día, y el
  // bridge ya maneja la indisponibilidad transitoria).
  _restartOpenClawForWorkspace(resolved);

  _bus.emit('workspace:changed', { path: resolved });
  if (_gitWatcher) { _gitWatcher.setWorkspace(resolved); }
  console.log('[march-core] workspace activo:', resolved);
  return { ok: true, path: resolved };
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
  if (_initiativeUnsub) { _initiativeUnsub(); _initiativeUnsub = null; }
  if (_proposalExecutedUnsub) { _proposalExecutedUnsub(); _proposalExecutedUnsub = null; }

  await closeSession();

  if (_bridge) {
    try { await _bridge.closeBrowser(); } catch(e) { console.warn('[march-core] error cerrando navegador:', e.message); }
  }
  _stopOpenClaw();
  if (_osSensor) {
    try { _osSensor.stop(); } catch(e) { console.warn('[march-core] error deteniendo sensor:', e.message); }
  }
  if (_lspManager) {
    try { await _lspManager.stop(); } catch(e) { console.warn('[march-core] error cerrando LSP:', e.message); }
  }
  if (_lspErrorWatcher) {
    try { _lspErrorWatcher.stop(); } catch(e) { console.warn('[march-core] error deteniendo LSPErrorWatcher:', e.message); }
    _lspErrorWatcher = null;
  }
  _proactive?.stop();
  for (const [name, sensor] of [
    ['git', _gitWatcher], ['system', _systemWatcher], ['title', _titleWatcher],
    ['clipboard', _clipboardWatcher], ['upcoming-events', _eventsWatcher],
  ]) {
    try { sensor?.stop(); } catch(e) { console.warn(`[march-core] error deteniendo sensor ${name}:`, e.message); }
  }
  _gitWatcher = _systemWatcher = _titleWatcher = _clipboardWatcher = _eventsWatcher = null;
  _proposalStore = null;
  _proactiveExecutor = null;
  _activeWorkspace = null;
  _onProposalResult = null;
  if (_pruneTimer) { clearInterval(_pruneTimer); _pruneTimer = null; }
  if (_pruneInitTimer) { clearTimeout(_pruneInitTimer); _pruneInitTimer = null; }
  if (_graph) { try { _graph.close(); } catch(e) { console.warn('[march-core] error cerrando DB:', e.message); } }

  _onInitiative = null;
  _initialized = false;
}

// ── OpenClaw Server ────────────────────────────────────────────────────────────

function _startOpenClaw(workspacePath) {
  const serverPath = path.join(__dirname, '..', 'openclaw-server.js');
  if (!fs.existsSync(serverPath)) {
    console.warn('[march-core] openclaw-server.js no encontrado — herramientas desactivadas');
    _bus.emit('openclaw:available', { available: false });
    return;
  }

  if (_openclawStarting) {
    console.warn('[march-core] OpenClaw ya está iniciando — ignorando');
    return;
  }
  _openclawStarting = true;
  _openclawWorkspace = workspacePath ? path.resolve(workspacePath) : null;

  // Generar API key para openclaw-server y pasarla vía entorno
  const apiKey = crypto.randomBytes(32).toString('hex');

  // Pasar el workspace como PATH permitido (evita "cwd outside allowed path")
  const allowedPath = workspacePath ? path.resolve(workspacePath) : projectCWD;

  try {
    _openclawProcess = cp.fork(serverPath, [], {
      stdio: 'pipe',
      env: { ...process.env, OPENCLAW_API_KEY: apiKey, OPENCLAW_ALLOWED_PATH: allowedPath },
    });

    // No dejar la API key en el env del proceso padre
    delete process.env.OPENCLAW_API_KEY;

    _openclawProcess.stdout?.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg) console.log('[openclaw-server]', msg);
    });

    _openclawProcess.stderr?.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg) console.error('[openclaw-server]', msg);
    });

    _openclawProcess.on('exit', (code) => {
      _openclawStarting = false;
      _openclawProcess = null;
      getOpenClawBridge().resetAvailabilityCache();
      _bus.emit('openclaw:available', { available: false });
    });

    _openclawProcess.on('error', (err) => {
      _openclawStarting = false;
      _openclawProcess = null;
      _bus.emit('openclaw:available', { available: false });
    });

    let retries = 0;
    const check = () => {
      retries++;
      _bridge.resetAvailabilityCache();
      _bridge.isAvailable().then(available => {
        if (available) {
          console.log('[march-core] OpenClaw listo — Fase 3 activa');
          _bus.emit('openclaw:available', { available: true });
        } else if (retries < OPENCLAW_RETRIES) {
          setTimeout(check, OPENCLAW_RETRY_MS);
        } else {
          console.warn(`[march-core] OpenClaw no respondió después de ${OPENCLAW_RETRIES} intentos`);
          _openclawProcess?.kill();
          _openclawStarting = false;
          _openclawProcess = null;
          _bus.emit('openclaw:available', { available: false });
        }
      }).catch(() => {
        if (retries < OPENCLAW_RETRIES) setTimeout(check, OPENCLAW_RETRY_MS);
        else {
          _openclawStarting = false;
          _bus.emit('openclaw:available', { available: false });
        }
      });
    };

    setTimeout(check, 1500);
  } catch (e) {
    _openclawStarting = false;
    console.error('[march-core] error iniciando OpenClaw:', e.message);
    _bus.emit('openclaw:available', { available: false });
  }
}

function _stopOpenClaw() {
  const process = _openclawProcess;
  if (_openclawKillTimer) { clearTimeout(_openclawKillTimer); _openclawKillTimer = null; }
  if (process) {
    console.log('[march-core] deteniendo OpenClaw...');
    _openclawProcess = null;
    _openclawStarting = false;
    try {
      process.kill('SIGTERM');
      _openclawKillTimer = setTimeout(() => {
        try { process.kill('SIGKILL'); } catch (_) {}
        _openclawKillTimer = null;
      }, 3000);
    } catch (e) {
      console.warn('[march-core] error deteniendo OpenClaw:', e.message);
    }
  }
  getOpenClawBridge().resetAvailabilityCache();
}

/**
 * FIX (auditoría Fase D): al cambiar de workspace, OpenClaw debe servir el
 * nuevo path permitido. Si el server corre con el path inicial, los comandos
 * del nuevo proyecto serían rechazados en silencio ("cwd outside allowed path").
 */
function _restartOpenClawForWorkspace(ws) {
  const resolved = path.resolve(ws);
  if (_openclawWorkspace === resolved) return; // mismo workspace → no tocar nada
  if (!_openclawStarting && _openclawProcess) {
    console.log('[march-core] workspace cambió — reiniciando OpenClaw para el nuevo allowed path');
    try { _stopOpenClaw(); } catch (_) {}
  }
  if (!_openclawProcess && !_openclawStarting) {
    _startOpenClaw(resolved);
  }
}

function addTurn(role, content) {
  _session?.addTurn(role, content);
  _telemetry?.recordTurn(role);
  _bus.emit('memory:turn-added', { role, content });
}

function detectInstant(userMessage) {
  if (!_updater) return;
  _updater.detectAndSaveInstant(userMessage);
}

// ── Context ───────────────────────────────────────────────────────────────────

async function buildContext(sessionHistory, activeProvider, options = {}) {
  const provider = activeProvider || LLMProvider.getActiveProvider() || 'groq';
  const mode = options.mode || 'chat'; // 'plan' | 'execute' | 'chat'
  const approvedPlan = options.plan || null;

  const lastUserMsg = [...sessionHistory].reverse().find(m => m.role === 'user');
  const userText    = lastUserMsg?.content || '';

  const osCtx = _osSensor?.getCurrentContext() ?? null;

  // BehaviorModel
  let behaviorCtx = null;
  if (_behavior) {
    try {
      behaviorCtx = _behavior.evaluate(userText, osCtx, sessionHistory);
      _bus.emit('behavior:evaluated', behaviorCtx);
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

  // TaskDetector — detecta si el usuario quiere hacer una tarea (no solo charlar)
  let taskIntent = null;
  try {
    taskIntent = _taskDetector.detect(userText);
    if (taskIntent.isTask) {
      console.log(
        `[march-core] taskIntent: ${taskIntent.domain?.id || 'indefinido'}` +
        ` (confianza: ${taskIntent.confidence})`
      );
    }
  } catch(e) {
    console.warn('[march-core] TaskDetector error:', e.message);
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

  // ── Tool Resolution (Fase 1): siempre resolver herramientas ─────────────
  // Fase 1: el toolset completo está disponible en TODOS los modos, sin
  // importar el nivel de confianza de IntentDetector. La intención detectada
  // solo influye en CÓMO se sugieren las acciones en el texto del prompt,
  // nunca en SI el modelo puede ejecutar herramientas.
  let toolCatalog = null;
  let resolvedTools = null;
  try {
    resolvedTools = await resolveToolset({
      userMessage: userText,
      domain: taskIntent?.domain || null,
      toolRegistry: _toolRegistry,
      skillManager: _skillManager || null,
      mcpManager: _mcp || null,
      db: (_graph && !_graph.usingFallback && _graph._db) ? _graph._db : null,
    });
    toolCatalog = resolvedTools?.promptCatalog || null;
  } catch(e) {
    console.warn('[march-core] error en resolución de herramientas:', e.message);
  }
  if (!toolCatalog) {
    toolCatalog = _toolRegistry.serializeToPrompt(taskIntent?.domain || null);
  }

  // ── MODE: AGENT (loop cerrado) ─────────────────────────────────────────
  // Fase 1: nativeToolSchemas se pasa al AgentLoop para completeWithTools()
  // en todos los turnos, filtrado solo por precedencia (Skill > MCP > OpenClaw).
  if (mode === 'agent') {
    if (result.systemPrompt.length > MAX_SYSTEM_CHARS) {
      result.systemPrompt = result.systemPrompt.slice(0, MAX_SYSTEM_CHARS) + '\n\n[contexto truncado por longitud]';
      console.warn(`[march-core] system prompt truncado modo agent: ${result.systemPrompt.length} chars`);
    }
    return { ...result, behaviorCtx, toolIntent, taskIntent, mode, nativeToolSchemas: resolvedTools?.nativeToolSchemas || null };
  }

  // ── Skill knowledge injection (Fase 4) ──────────────────────────────────
  if (_skillManager && typeof _skillManager.buildInjection === 'function') {
    try {
      const skillBlock = await _skillManager.buildInjection(userText, (_graph && !_graph.usingFallback && _graph._db) ? _graph._db : null);
      if (skillBlock) {
        result.systemPrompt += '\n\n' + skillBlock;
      }
    } catch(e) {
      console.warn('[march-core] error inyectando skills:', e.message);
    }
  }

  // ── MODE: PLAN ─────────────────────────────────────────────────────────────
  // Cuando el modo es 'plan', se inyecta el catálogo de herramientas pero
  // con instrucciones de SOLO planificar, sin ejecutar nada. El LLM debe
  // devolver un bloque ```plan con los pasos.
  if (mode === 'plan') {
    if (toolCatalog) {
      result.systemPrompt += '\n\n' + toolCatalog;
    }
    result.systemPrompt +=
      '\n\n# MODO PLAN — SOLO PLANIFICA, NO EJECUTES\n' +
      'Estás en MODO PLAN. Tu única tarea es GENERAR UN PLAN con los pasos necesarios.\n' +
      'NO ejecutes ninguna acción. NO uses herramientas. NO anuncies comandos.\n' +
      'Solamente genera el plan en este formato:\n' +
      '```plan\n' +
      '- [ ] Paso 1: Descripción clara\n' +
      '- [ ] Paso 2: Siguiente acción\n' +
      '```\n' +
      'Cada paso debe ser una acción concreta y ejecutable.\n';
    if (approvedPlan) {
      result.systemPrompt +=
        '\nPlan ya aprobado por el usuario — continúa con los siguientes pasos pendientes:\n' +
        approvedPlan.steps.filter(s => !s.done).map((s, i) => `  ${i+1}. ${s.description}`).join('\n') + '\n';
    }
  }

  // ── MODE: EXECUTE ──────────────────────────────────────────────────────────
  // Cuando el modo es 'execute', se inyecta el catálogo con instrucciones de
  // ejecución y el plan aprobado como contexto.
  if (mode === 'execute') {
    if (toolCatalog) {
      result.systemPrompt += '\n\n' + toolCatalog;
    }
    result.systemPrompt +=
      '\n\n# MODO EJECUCIÓN\n' +
      'Ejecuta el siguiente plan paso a paso.\n' +
      'Usa las herramientas disponibles para completar cada paso.\n' +
      'Anuncia cada acción antes de ejecutarla.\n' +
      'Espera el resultado de cada paso antes de continuar con el siguiente.\n';
    if (approvedPlan) {
      result.systemPrompt +=
        '\n## Plan a ejecutar\n' +
        approvedPlan.steps.filter(s => !s.done).map((s, i) => `  ${i+1}. ${s.description}`).join('\n') + '\n';
    }
  }

  // ── MODE: CHAT (modo normal, sin planificación) ────────────────────────────
  // Fase 1: las herramientas están disponibles siempre que OpenClaw esté
  // activo, sin importar el nivel de intención detectado. IntentDetector
  // solo influye en las sugerencias textuales (GroqSerializer), no en el
  // acceso a herramientas.
  if (mode === 'chat') {
    if (_bridge?.getStats()?.available) {
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
    if (_mcp?.hasConnectedServers()) {
      const mcpTools = _mcp.listAllTools();
      if (mcpTools.length) {
        result.systemPrompt += _buildMCPCatalogPrompt(mcpTools);
      }
    }
  }

  // Truncado inteligente: si el prompt excede MAX_SYSTEM_CHARS, elimina
  // secciones COMPLETAS empezando por la menos importante, en vez de cortar
  // a mitad de una instrucción (que rompe el formato estructurado).
  if (result.systemPrompt.length > MAX_SYSTEM_CHARS) {
    console.warn(`[march-core] system prompt excede: ${result.systemPrompt.length} > ${MAX_SYSTEM_CHARS} chars, recortando...`);
    // Orden de sacrificio: MCP → OpenClaw → episodios → memoria → OS → comportamiento → tools intent → identidad
    const sectionMarkers = [
      { name: 'MCP',       marker: '# HERRAMIENTAS MCP',            keepIf: null },
      { name: 'OpenClaw',  marker: '# HERRAMIENTAS DISPONIBLES',    keepIf: null },
      { name: 'Plan',      marker: '# MODO PLAN',                   keepIf: null },
      { name: 'Execute',   marker: '# MODO EJECUCIÓN',              keepIf: null },
      { name: 'Episodios', marker: '## Episodios recientes',        keepIf: null },
      { name: 'Memoria',   marker: '## Lo que sé del usuario',      keepIf: null },
      { name: 'OS',        marker: '## Contexto actual',            keepIf: null },
      { name: 'Behavior',  marker: '# COMPORTAMIENTO ESTE TURNO',   keepIf: null },
      { name: 'Intent',    marker: '## INTENCIÓN DE HERRAMIENTA',   keepIf: null },
    ];
    for (const section of sectionMarkers) {
      if (result.systemPrompt.length <= MAX_SYSTEM_CHARS) break;
      const markerIdx = result.systemPrompt.indexOf(section.marker);
      if (markerIdx === -1) continue;
      // Encontrar el inicio de la sección (línea anterior ---\n\n o principio)
      const sectionStart = result.systemPrompt.lastIndexOf('\n\n---\n\n', markerIdx);
      const from = sectionStart >= 0 ? sectionStart + 6 : markerIdx;
      // Encontrar el fin (siguiente --- o fin del string)
      const remaining = result.systemPrompt.slice(from + 1);
      const nextSep = remaining.indexOf('\n\n---\n\n');
      const sectionEnd = nextSep >= 0 ? from + 1 + nextSep : result.systemPrompt.length;
      const sectionText = result.systemPrompt.slice(from, sectionEnd);
      result.systemPrompt = result.systemPrompt.slice(0, from) + result.systemPrompt.slice(sectionEnd);
      console.log(`[march-core] sección "${section.name}" eliminada (${sectionText.length} chars)`);
    }
    // Si sigue excediendo después de eliminar secciones opcionales, truncado duro al final
    if (result.systemPrompt.length > MAX_SYSTEM_CHARS) {
      const budget = MAX_SYSTEM_CHARS - TRUNCATION_SUFFIX.length;
      console.warn(`[march-core] truncado duro: ${result.systemPrompt.length} → ${MAX_SYSTEM_CHARS} chars (solo identidad)`);
      result.systemPrompt = result.systemPrompt.slice(0, Math.max(0, budget)) + TRUNCATION_SUFFIX;
    }
  }

  return { ...result, behaviorCtx, toolIntent, taskIntent, mode, nativeToolSchemas: resolvedTools?.nativeToolSchemas || null };
}

/**
 * Construye el bloque de system prompt que le enseña al LLM qué tools MCP
 * hay disponibles ahora mismo y el formato exacto para usarlas. Se limita
 * a 40 tools para no inflar el prompt si hay muchos servidores conectados.
 */
function _buildMCPCatalogPrompt(mcpTools) {
  const lines = mcpTools.slice(0, MCP_CATALOG_LIMIT).map(t => {
    const desc = (t.description || '').replace(/\s+/g, ' ').slice(0, 100);
    return `  - SERVIDOR=${t.server} | HERRAMIENTA=${t.tool}${desc ? ' — ' + desc : ''}`;
  });

  return '\n\n# HERRAMIENTAS MCP DISPONIBLES\n' +
    'Tienes acceso a estas herramientas de servidores MCP conectados. ' +
    'SOLO debes usarlas si el comando que necesitas NO se puede ejecutar con OpenClaw ' +
    '(Ejecutar: <comando>). Para listar archivos, leer archivos, o escribir archivos ' +
    'usa SIEMPRE OpenClaw (Ejecutar: ls <ruta>, Ejecutar: cat <archivo>, etc.).\n\n' +
    'Herramientas disponibles (copia EXACTAMENTE el SERVIDOR y HERRAMIENTA de esta lista):\n' +
    lines.join('\n') + '\n\n' +
    'Para usar una herramienta MCP, responde con este formato EXACTO (sin comillas alrededor de SERVIDOR y HERRAMIENTA):\n' +
    '```action\n' +
    'ACCIÓN: mcp_call | SERVIDOR: filesystem | HERRAMIENTA: list_directory | PARAMS: {"path": "/ruta"}\n' +
    '```\n' +
    'El SERVIDOR y HERRAMIENTA deben coincidir EXACTAMENTE con la lista de arriba, incluyendo mayúsculas. ' +
    'PARAMS debe ser JSON válido en una sola línea. ' +
    'El sistema pedirá confirmación al usuario antes de ejecutar cualquier herramienta MCP.';
}

// ── Fase 3: Planner y OpenClaw ────────────────────────────────────────────────

async function isOpenClawAvailable() {
  if (!_bridge) return false;
  return _bridge.isAvailable();
}

/**
 * Genera un plan estructurado para una tarea detectada.
 * Fase 1 del sistema de dos fases (plan → ejecución).
 * 
 * @param {string} userGoal - El mensaje del usuario
 * @param {object} taskIntent - Resultado de TaskDetector.detect()
 * @param {Array} sessionHistory - Historial de la sesión
 * @returns {Promise<{plan: object|null, llmResponse: string|null, error: string|null}>}
 */
async function generatePlan(userGoal, taskIntent, sessionHistory = []) {
  if (!_planner) return { plan: null, llmResponse: null, error: 'Planner no disponible' };

  try {
    const { parsePlan } = require('./task/PlanParser.js');
    const context = await buildContext(sessionHistory, null, { mode: 'plan' });
    if (!context || !context.systemPrompt) {
      return { plan: null, llmResponse: null, error: 'No se pudo construir contexto' };
    }

    console.log('[march-core] generando plan para:', userGoal.slice(0, 80));
    const llmResponse = await LLMProvider.completeTask(
      context.messages,
      context.systemPrompt + '\n\n## Solicitud del usuario\n' + userGoal
    );

    if (!llmResponse) {
      return { plan: null, llmResponse: null, error: 'LLM no respondió' };
    }

    console.log('[march-core] respuesta del plan:', llmResponse.slice(0, 200));
    const plan = parsePlan(llmResponse);

    if (plan && plan.steps?.length > 0) {
      _bus.emit('plan:generated', { goal: userGoal, plan, llmResponse });
      return { plan, llmResponse, error: null };
    }

    const fallbackPlan = _planner.planFromLLMResponse(llmResponse, userGoal, null);
    if (fallbackPlan && fallbackPlan.steps?.length > 0) {
      _bus.emit('plan:generated', { goal: userGoal, plan: fallbackPlan, llmResponse });
      return { plan: { steps: fallbackPlan.steps.map(s => ({ done: false, description: s.description || s.tool })) }, llmResponse, error: null };
    }

    return { plan: null, llmResponse, error: 'No se pudo extraer un plan de la respuesta' };
  } catch (e) {
    console.error('[march-core] error generando plan:', e.message);
    return { plan: null, llmResponse: null, error: e.message };
  }
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

// ── AgentLoop (loop cerrado con tool-calling, skills y precedencia) ───────────

/**
 * Ejecuta el loop cerrado de agente para un mensaje del usuario.
 * Reemplaza el flujo plan→execute con un loop single-step donde el LLM
 * decide tool por tool, condicionado por el resultado real del paso anterior.
 *
 * @param {string} userMessage - Mensaje del usuario
 * @param {object} [opts] - Opciones
 * @param {function} [opts.onApprovalNeeded] - Callback de aprobación
 * @param {function} [opts.onProgress] - Callback de progreso
 * @param {number} [opts.maxIterations] - Máximo de iteraciones
 * @returns {Promise<{response, iterations, toolResults, error}>}
 */
async function runAgent(userMessage, opts = {}) {
  const sessionHistory = _session?.getHistory() || [];

  const context = await buildContext(sessionHistory, null, {
    mode: 'agent',
  });

  if (!context || !context.systemPrompt) {
    return { response: null, iterations: 0, toolResults: [], error: 'No se pudo construir contexto' };
  }

  const loop = new AgentLoop({
    maxIterations: opts.maxIterations || 25,
    bridge: _bridge,
    mode: opts.mode || 'smart',
  });

  const result = await loop.run(
    userMessage,
    context.systemPrompt,
    context.messages || [],
    {
      ...opts,
      toolResolver: { resolveToolset },
      skillManager: _skillManager || null,
      mcpManager: _mcp || null,
      skillDb: (_graph && !_graph.usingFallback && _graph._db) ? _graph._db : null,
    }
  );

  _bus.emit('agent:completed', { iterations: result.iterations, error: result.error });
  return result;
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
    proactive:      _proactive?.getStats()          ?? null,
    autonomy:       _proactive?.getAutonomyMode()   ?? null,
    executor:       _proactiveExecutor?.getStats()  ?? null,
    signals: {
      git:       _gitWatcher?.getStats()      ?? null,
      system:    _systemWatcher?.getStats()   ?? null,
      title:     _titleWatcher?.getStats()    ?? null,
      clipboard: _clipboardWatcher?.getStats() ?? null,
      events:    _eventsWatcher?.getStats()   ?? null,
      lsp:       _lspErrorWatcher?.getStats() ?? null,
    },
    planner:        _planner?.getStats()            ?? null,
    openclaw:       _bridge?.getStats()             ?? null,
    intentDetector: _detector ? { ready: _detector.isReady() } : null,
    lsp:            _lspManager ? { running: _lspManager.isRunning, filePatterns: _lspManager.supportedFilePatterns } : null,
    telemetry:      _telemetry?.getStats() ?? null,
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
  _pruneInitTimer = setTimeout(run, 10_000);
  _pruneTimer = setInterval(run, 24 * 60 * 60 * 1000);
}

// ── Getters ───────────────────────────────────────────────────────────────────

function getGraph()         { return _graph;     }
function getOSSensor()      { return _osSensor;  }
function getGrounding()     { return _grounding; }
function getEventBus_()     { return _bus;       }
function getBehaviorModel() { return _behavior;  }
function getPlanner_()      { return _planner;   }
function getBridge()        { return _bridge;    }
function getTaskDetector_() { return _taskDetector; }
function listSkills() {
  if (!_skillManager) return [];
  return _skillManager.getAllSkills();
}

function storeFact({ type, label, content, importance = 0.85, tags = [] }) {
  if (!_graph?.isReady) return null;
  try {
    return _graph.createNode({ type, label, content, importance, tags });
  } catch(e) {
    console.warn('[march-core] error guardando hecho:', e.message);
    return null;
  }
}

module.exports = {
  init,
  shutdown,
  setMaxSystemChars,
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
  getTaskDetector:  getTaskDetector_,
  onInitiative,
  onProposalResult,
  setChatOpen,
  handleProposalDecision,
  debugGitScan,
  debugResolveLastProposal,
  debugLSPScan,
  getTelemetryReport,
  getTelemetryStats,
  forgetMemory,
  pendingRecap,
  reloadLLMConfig,
  forceProactive,
  isOpenClawAvailable,
  generatePlan,
  parsePlanFromResponse,
  executePlan,
  runAgent,
  executeTool,
  mcpListServers,
  mcpAddServer,
  mcpRemoveServer,
  mcpToggleServer,
  mcpSearchRegistry,
  mcpListAllTools,
  setActiveWorkspace,
  listSkills,
  storeFact,
};