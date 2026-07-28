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

const path = require('path');
const fs   = require('fs');
const cp   = require('child_process');

const { getIntentDetector }            = require('./grounding/IntentDetector.js');
const { getStateGraph }                = require('./state-graph/StateGraph.js');
const { GroundingEngine }              = require('./grounding/GroundingEngine.js');
const { SessionManager }               = require('./state-graph/SessionManager.js');
const { StateUpdater }                 = require('./state-graph/StateUpdater.js');
const { OSSensor }                     = require('../infrastructure/sensors/OSSensor.js');
const { LinuxOSSensor }                = require('../infrastructure/sensors/LinuxOSSensor.js');
const { getEventBus }                  = require('../infrastructure/event-bus/EventBus.js');
const { InitiativeEngine }             = require('./behavior/InitiativeEngine.js');
const { ProactiveEngine }              = require('./behavior/ProactiveEngine.js');
const { BehaviorModel }                = require('./behavior/BehaviorModel.js');
const { getPlanner, setProjectCWD, isHighImpact } = require('./planner/Planner.js');
const { getOpenClawBridge }            = require('./planner/OpenClawBridge.js');
const { getMCPManager }                = require('./mcp/MCPManager.js');
const LLMProvider                      = require('./llm/LLMProvider.js');

// FIX: presupuesto de tokens del system prompt COMPLETO — antes vivía
// dentro de GroqSerializer.js y se aplicaba antes de pegar BehaviorModel,
// las reglas de OpenClaw y el catálogo MCP. Ahora se aplica aquí, al
// final de buildContext(), sobre el prompt ya ensamblado del todo.
const MAX_SYSTEM_CHARS = 14_000; // ~3.5k tokens — conservador pero amplio

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
let _mcpReadyPromise = Promise.resolve();
let _openclawProcess = null;

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

  _initiative = new InitiativeEngine(_graph);
  _proactive  = new ProactiveEngine(_graph);

  _behavior = new BehaviorModel(_graph);
  _planner  = getPlanner();
  _bridge   = getOpenClawBridge();
  _mcp      = getMCPManager();

  const projectCWD = app ? app.getAppPath() : process.cwd();
  setProjectCWD(projectCWD);

  if (_osSensor) {
    _grounding.setOSSensor(_osSensor);
    if (typeof _initiative.setOSSensor === 'function') _initiative.setOSSensor(_osSensor);
    _proactive.setOSSensor(_osSensor);
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
    if (process.env.DEBUG) console.log(`[march-core] initiative: "${payload.suggestion?.slice(0, 60)}"`);
    if (_onInitiative) _onInitiative(payload);
  });

  _scheduleDailyPrune();
  _loadLLMConfig();
  _loadMCPConfig();
  _startOpenClaw();
  _proactive.start();

  // Workspace inicial — prioridad: MARCH_WORKSPACE (comando `asistente`
  // explícito) > último workspace persistido en config.json > default
  // (carpeta de March, ya asignada arriba vía setProjectCWD(projectCWD)).
  // Se espera a _mcpReadyPromise antes de tocar los servidores MCP para
  // no pisar la conexión inicial a mitad de camino (causaba el
  // "error conectando a filesystem: Not connected" intermitente).
  const _envWorkspace = process.env.MARCH_WORKSPACE;
  let _persistedWorkspace = null;
  if (!_envWorkspace && _configPath && fs.existsSync(_configPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(_configPath, 'utf-8'));
      if (cfg.activeWorkspace && cfg.activeWorkspace !== projectCWD) _persistedWorkspace = cfg.activeWorkspace;
    } catch(_) {}
  }
  const _initialWorkspace = _envWorkspace || _persistedWorkspace;
  if (_initialWorkspace) {
    _mcpReadyPromise.then(() => setActiveWorkspace(_initialWorkspace)).then(r => {
      if (r.ok) console.log(`[march-core] workspace inicial (${_envWorkspace ? 'MARCH_WORKSPACE' : 'persistido'}):`, r.path);
      else console.warn('[march-core] workspace inicial inválido:', r.error);
    });
  }

  if (_graph.usingFallback) {
    console.error('');
    console.error('╔══════════════════════════════════════════════════════════╗');
    console.error('║  ⚠  ADVERTENCIA CRÍTICA — MEMORIA NO PERSISTENTE        ║');
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

  _bus.emit('workspace:changed', { path: resolved });
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
  // FIX: OpenClawBridge.closeBrowser() existía y hasta decía en su propio
  // comentario "llamar al cerrar la app", pero nada lo llamaba — el
  // Chromium headless de BrowserBridge (más sus procesos hijo) se quedaba
  // corriendo huérfano después de cerrar March, mismo problema que ya se
  // resolvió para los servidores MCP arriba.
  if (_bridge) {
    try { await _bridge.closeBrowser(); } catch(e) { console.warn('[march-core] error cerrando navegador:', e.message); }
  }
  _stopOpenClaw();
  if (_osSensor) {
    try { _osSensor.stop(); } catch(e) { console.warn('[march-core] error deteniendo sensor:', e.message); }
  }
  _proactive?.stop();
}

// ── OpenClaw Server ────────────────────────────────────────────────────────────

function _startOpenClaw() {
  const serverPath = path.join(__dirname, '..', 'openclaw-server.js');
  if (!fs.existsSync(serverPath)) {
    console.warn('[march-core] openclaw-server.js no encontrado — herramientas desactivadas');
    _bus.emit('openclaw:available', { available: false });
    return;
  }

  try {
    _openclawProcess = cp.fork(serverPath, [], { stdio: 'pipe' });

    _openclawProcess.stdout?.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg) console.log('[openclaw-server]', msg);
    });

    _openclawProcess.stderr?.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg) console.error('[openclaw-server]', msg);
    });

    _openclawProcess.on('exit', (code) => {
      console.log(`[march-core] OpenClaw terminado (código ${code})`);
      _openclawProcess = null;
      getOpenClawBridge().resetAvailabilityCache();
      _bus.emit('openclaw:available', { available: false });
    });

    _openclawProcess.on('error', (err) => {
      console.error('[march-core] error en OpenClaw:', err.message);
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
        } else if (retries < 15) {
          setTimeout(check, 400);
        } else {
          console.warn('[march-core] OpenClaw no respondió después de 15 intentos');
          _openclawProcess?.kill();
          _openclawProcess = null;
          _bus.emit('openclaw:available', { available: false });
        }
      }).catch(() => {
        if (retries < 15) setTimeout(check, 400);
        else _bus.emit('openclaw:available', { available: false });
      });
    };

    setTimeout(check, 1500);
  } catch (e) {
    console.error('[march-core] error iniciando OpenClaw:', e.message);
    _bus.emit('openclaw:available', { available: false });
  }
}

function _stopOpenClaw() {
  if (_openclawProcess) {
    console.log('[march-core] deteniendo OpenClaw...');
    try {
      _openclawProcess.kill('SIGTERM');
      setTimeout(() => {
        if (_openclawProcess) {
          try { _openclawProcess.kill('SIGKILL'); } catch (_) {}
          _openclawProcess = null;
        }
      }, 3000);
    } catch (e) {
      console.warn('[march-core] error deteniendo OpenClaw:', e.message);
    }
  }
  getOpenClawBridge().resetAvailabilityCache();
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

  // FIX: truncado del prompt COMPLETO, aquí al final — antes esto pasaba
  // dentro de GroqSerializer.serialize(), antes de que se pegaran
  // BehaviorModel, las reglas de OpenClaw y el catálogo MCP, así que el
  // presupuesto de tokens nunca contaba esas secciones (podían crecer sin
  // límite real). Ver GroqSerializer.js — ahí se quitó el truncado viejo.
  if (result.systemPrompt.length > MAX_SYSTEM_CHARS) {
    console.warn(`[march-core] system prompt truncado: ${result.systemPrompt.length} → ${MAX_SYSTEM_CHARS} chars`);
    result.systemPrompt = result.systemPrompt.slice(0, MAX_SYSTEM_CHARS) + '\n\n[contexto truncado por longitud]';
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
  setActiveWorkspace,
};