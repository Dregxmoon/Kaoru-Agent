// @ts-nocheck
// init.js — secuencia de arranque del núcleo: migración de la BD, creación de
// graph/grounding/session, sensores, ProactiveEngine, BehaviorModel, planner,
// MCP, LSP, skills, plugins, permisos, telemetría, IntentDetector y workspace
// inicial.

const path = require('path');
const fs = require('fs');

const { getStateGraph } = require('../state-graph/StateGraph.js');
const { GroundingEngine } = require('../grounding/GroundingEngine.js');
const { SessionManager } = require('../state-graph/SessionManager.js');
const { StateUpdater } = require('../state-graph/StateUpdater.js');
const { OSSensor } = require('../../infrastructure/sensors/OSSensor.js');
const { LinuxOSSensor } = require('../../infrastructure/sensors/LinuxOSSensor.js');
const { GitWatcher } = require('../../infrastructure/sensors/GitWatcher.js');
const { SystemWatcher } = require('../../infrastructure/sensors/SystemWatcher.js');
const { TitleWatcher } = require('../../infrastructure/sensors/TitleWatcher.js');
const { ClipboardWatcher } = require('../../infrastructure/sensors/ClipboardWatcher.js');
const { UpcomingEventsWatcher } = require('../../infrastructure/sensors/UpcomingEventsWatcher.js');
const { getEventBus } = require('../../infrastructure/event-bus/EventBus.js');
const { LSPErrorWatcher } = require('../../infrastructure/sensors/LSPErrorWatcher.js');
const { SymbolIndex } = require('../lsp/SymbolIndex.js');
const { ProactiveEngine } = require('../behavior/ProactiveEngine.js');
const { ProposalStore } = require('../behavior/ProposalStore.js');
const { LearningEngine } = require('../learning/LearningEngine.js');
const { TrustModel } = require('../trust/TrustModel.js');
const { ProactiveExecutor } = require('../behavior/ProactiveExecutor.js');
const { TelemetryStore } = require('../telemetry/TelemetryStore.js');
const { BehaviorModel } = require('../behavior/BehaviorModel.js');
const { getPlanner, setProjectCWD } = require('../planner/Planner.js');
const { getOpenClawBridge } = require('../planner/OpenClawBridge.js');
const { getMCPManager } = require('../mcp/MCPManager.js');
const TaskDetector = require('../task/TaskDetector.js');
const { getToolRegistry } = require('../task/ToolRegistry.js');
const { getPluginManager } = require('../plugins/PluginManager.js');
const { PermissionManager } = require('../security/PermissionManager.js');
const { getIntentDetector } = require('../grounding/IntentDetector.js');
const LLMProvider = require('../llm/LLMProvider.js');
const {
  setUsageTracker,
  setCatalogCachePath,
  refreshRemoteCatalog,
} = LLMProvider;
const { UsageTracker } = require('../observability/UsageTracker.js');
const logger = require('../observability/Logger.js');

const state = require('./state.js');
const {
  loadLLMConfig,
  loadMCPConfig,
  readSensorsConfig,
  readAutonomyConfig,
} = require('./config.js');
const { startOpenClaw } = require('./openclaw.js');
const { scheduleDailyPrune } = require('./stats.js');
const { setActiveWorkspace } = require('./workspace.js');

// Migración: el archivo de memoria se llamaba march.db en versiones previas
// (y en la carpeta de datos del usuario ~/.config/vtuber-overlay). Se renombra
// a core.db una única vez, sin tocar la config ni los datos. Si ya existe
// core.db (reinstall, carpeta nueva), no se hace nada.
const LEGACY_DB_FILE = 'march.db';

function migrateLegacyDb(dir) {
  if (!dir) return;
  const legacy = path.join(dir, LEGACY_DB_FILE);
  if (!fs.existsSync(legacy)) return;
  if (fs.existsSync(path.join(dir, 'core.db'))) return;
  for (const suffix of ['', '-wal', '-shm']) {
    const from = legacy + suffix;
    if (fs.existsSync(from)) fs.renameSync(from, path.join(dir, 'core.db') + suffix);
  }
  logger.info('init', '[core] BD legacy migrada a core.db');
}

function init(app) {
  if (state.initialized) {
    logger.warn('init', '[core] init() llamado más de una vez — ignorando');
    return { graph: state.graph, grounding: state.grounding, session: state.session };
  }
  state.initialized = true;

  state.app = app;
  state.bus = getEventBus();

  migrateLegacyDb(app ? app.getPath('userData') : path.join(__dirname, '..', '..', 'data'));

  const dbPath = app
    ? path.join(app.getPath('userData'), 'core.db')
    : process.env.ASISTENTE_DATA_DIR
      ? path.join(process.env.ASISTENTE_DATA_DIR, 'core.db')
      : path.join(__dirname, '..', '..', 'data', 'core.db');

  state.configPath = app ? path.join(app.getPath('userData'), 'config.json') : null;

  // Observabilidad: logger a archivo + usage tracker persistido a disco.
  // Best-effort — si no hay app (tests/headless) queda en memoria.
  if (app) {
    const dataDir = app.getPath('userData');
    setUsageTracker(new UsageTracker(path.join(dataDir, 'usage.jsonl')));
    setCatalogCachePath(path.join(dataDir, 'llm-catalog.json'));
    const logDir = path.join(dataDir, 'logs');
    try {
      fs.mkdirSync(logDir, { recursive: true });
    } catch (_) {
      /* best-effort */
    }
    logger.attachFile(path.join(logDir, 'assistant.log'));
  }

  state.graph = getStateGraph(dbPath);
  if (process.env.DEBUG)
    logger.info(
      'init',
      '[core] graph.usingFallback:',
      state.graph.usingFallback,
      '| _graph._db:',
      !!state.graph._db
    );
  state.grounding = new GroundingEngine(state.graph);
  state.session = new SessionManager(state.graph, state.grounding);
  state.updater = new StateUpdater(state.graph);

  // Inicializar detector de emociones y enforcement (evolutionary memory)
  state.graph.initEmotionDetector(LLMProvider);

  const SensorClass =
    process.platform === 'win32' ? OSSensor : process.platform === 'linux' ? LinuxOSSensor : null;

  if (SensorClass) {
    state.osSensor = new SensorClass(state.graph);
    state.osSensor.start();
    logger.info('init', `[core] ${SensorClass.name} iniciado (${process.platform})`);
  } else {
    state.osSensor = null;
    logger.info('init', `[core] OSSensor no disponible para ${process.platform}`);
  }

  state.proactive = new ProactiveEngine(state.graph, {
    store: (state.proposalStore = new ProposalStore({
      filePath: app ? path.join(app.getPath('userData'), 'proactive_feedback.json') : null,
    })),
    // Fase C: contexto de código para los mensajes proactivos. Getters lazy
    // porque lspErrorWatcher/symbolIndex se crean MÁS ABAJO en init(); cuando
    // el engine consulta (en caliente), ya existen.
    getFocusedFile: () => state.lspErrorWatcher?.getFocusedFile?.() ?? null,
    getSymbols: (file) => state.symbolIndex?.getSymbolsFor?.(file) ?? Promise.resolve([]),
    // B: últimos turnos del CHAT para que los mensajes proactivos no repitan
    // lo que ya se habló (antes solo veían mensajes PROACTIVOS previos).
    getRecentChatTurns: () => {
      try {
        return state.session?.getHistory?.().slice(-4) ?? [];
      } catch {
        return [];
      }
    },
    // C: sesión activa para leer la emoción del trend tracker sin llamada LLM.
    getCurrentSessionId: () => state.session?.getSessionId?.() ?? null,
    // P1: quickfixes del LSP como fuente de parche determinista (antes del LLM).
    getCodeActions: async (file, line, character, context = null) => {
      if (!state.lspManager?.isRunning) return null;
      try {
        return await state.lspManager.codeActions(file, line, character, context);
      } catch {
        return null;
      }
    },
    executor: (state.proactiveExecutor = new ProactiveExecutor({
      getWorkspace: () => state.activeWorkspace,
      // Fase D: guard de archivos abiertos en el editor + verificación LSP
      // post-parche (pull real al LSPManager).
      getOpenFiles: () => state.lspErrorWatcher?.getOpenFiles() ?? [],
      // Guard híbrido: distinguir "abierto y quieto" (aplica) de "editando
      // activamente" (se niega). Focused del watcher + idle del OS sensor.
      getFocusedFile: () => state.lspErrorWatcher?.getFocusedFile?.() ?? null,
      getIdleSecs: () => state.osSensor?.getCurrentContext?.()?.idleSecs ?? null,
      getDiagnostics: async (absPath) => {
        if (!state.lspManager?.isRunning) return null;
        try {
          return await state.lspManager.getDiagnostics(absPath);
        } catch {
          return null;
        }
      },
      notifyChanged: (absPath, content) => {
        try {
          state.lspManager?.changeDocument(absPath, content);
        } catch {}
      },
      waitForDiagnostics: async (absPath) => {
        if (!state.lspManager?.isRunning) return null;
        try {
          return await state.lspManager.waitForDiagnostics(absPath);
        } catch {
          return null;
        }
      },
    })),
  });
  state.proactive.setAutonomyMode(readAutonomyConfig());
  logger.info('init', `[core] autonomía: ${state.proactive.getAutonomyMode()}`);

  // ── Fase 3, ítem 2: aprendizaje que cierra el círculo ─────────────────────
  // LearningEngine recalibra los pesos de proactividad desde el feedback y
  // registra los outcomes de tareas. El gate lee los pesos aprendidos del
  // ProposalStore (misma instancia) vía getLearnedWeights().
  state.learning = new LearningEngine({
    filePath: app ? path.join(app.getPath('userData'), 'learning_feedback.json') : null,
    proposalStore: state.proposalStore,
  });
  state.learning.calibrate();

  // ── Fase 3, ítem 4: modelo de confianza dinámico (costo×éxito) ───────────
  // TrustModel aprende de los outcomes de tareas + coste real qué modo/
  // configuración resuelve mejor; se alimenta en agent.js (mismo hook que
  // LearningEngine) y sugiere modo de forma conservadora.
  state.trust = new TrustModel({
    filePath: app ? path.join(app.getPath('userData'), 'trust_feedback.json') : null,
  });

  state.behavior = new BehaviorModel(state.graph);
  state.planner = getPlanner();
  state.bridge = getOpenClawBridge();
  state.mcp = getMCPManager();
  state.taskDetector = TaskDetector;
  state.toolRegistry = getToolRegistry();
  state.toolRegistry.setMCPManager(state.mcp);
  state.toolRegistry.setOpenClawBridge(state.bridge);

  state.lspManager = new (require('../lsp/LSPManager.js').LSPManager)();
  state.toolRegistry.setLSPManager(state.lspManager);

  // ── Fase D: índice de símbolos + watcher de errores LSP ─────────────────
  // El LSP pasa a ser un SENSOR del camino proactivo: el watcher convierte
  // los diagnósticos (severidad 1 = errores) en señales `lsp:error`, y el
  // índice de símbolos da contexto de función/clase al parche. Nunca rompe
  // el arranque: sin LSP o sin workspace solo trackea el foco del editor.
  state.symbolIndex = new SymbolIndex({ lsp: state.lspManager });
  state.lspErrorWatcher = new LSPErrorWatcher({
    lsp: state.lspManager,
    getWorkspace: () => state.activeWorkspace,
    getCurrentTitle: () => state.osSensor?.getCurrentContext()?.title || '',
    getSymbols: (file) => state.symbolIndex.getSymbolsFor(file),
  });

  state.skillManager = new (require('../skills/SkillManager.js').SkillManager)({
    skillsDir: path.join(__dirname, '..', '..', 'skills'),
    db: !state.graph.usingFallback && state.graph._db ? state.graph._db : null,
    threshold: 0.35,
    topK: 3,
    // Loop de feedback de skills: estadísticas de éxito por skill desde
    // LearningEngine → umbral/ranking adaptativos en match().
    statsProvider:
      state.learning && typeof state.learning.skillStats === 'function'
        ? () => state.learning.skillStats({ minUses: 2 })
        : null,
  });
  if (!state.graph.usingFallback && state.graph._db) {
    state.skillManager
      .scan(true)
      .then(() => {
        logger.info('init', '[core] skills escaneadas');
        state.skillManager
          .index()
          .then(() => {
            logger.info('init', '[core] skills indexadas');
          })
          .catch((e) => logger.warn('init', '[core] error indexando skills:', e.message));
      })
      .catch((e) => logger.warn('init', '[core] error escaneando skills:', e.message));
  }

  const projectCWD = app ? app.getAppPath() : process.cwd();
  setProjectCWD(projectCWD);

  // ── Plugins locales ─────────────────────────────────────────────────────────
  // Extienden el pipeline con tools propias (registradas en ToolRegistry con
  // id `plugin.<nombre>.<tool>` y despachadas en Planner._executePlugin) y
  // hooks (registerHook). Nunca rompen el arranque: si un plugin falla, se
  // loggea y se sigue. Los plugins se cargan de plugins/ en el root del repo.
  try {
    state.pluginManager = getPluginManager();
    state.pluginManager.bind({
      registry: state.toolRegistry,
      dispatch: async (toolId, args) => {
        // El dispatch real lo provee el propio plugin que registró la tool;
        // si el PluginManager no tiene dispatch de plugins con handler, se
        // delega a la tool registrada vía su función en el contexto.
        const plug = state.pluginManager._plugins.find((p) => toolId.startsWith(`plugin.${p.id}.`));
        if (plug?.api?.run) {
          const name = toolId.slice(`plugin.${plug.id}.`.length);
          return plug.api.run(name, args);
        }
        return { ok: false, error: `tool de plugin no encontrada: ${toolId}` };
      },
    });
    state.pluginManager.load().then((n) => {
      if (n > 0) {
        const registered = state.pluginManager.registerAll({
          db: !state.graph.usingFallback && state.graph._db ? state.graph._db : null,
          workspace: () => state.activeWorkspace,
          mcp: state.mcp,
        });
        logger.info('init', `[core] plugins registrados: ${registered.join(', ')}`);
      }
    });
  } catch (e) {
    logger.warn('init', '[core] plugin manager no disponible:', e.message);
  }

  // ── Permisos granulares (allow/ask/deny, patrón opencode) ────────────────
  // Reglas por herramienta + carpeta persistidas en userData/permissions.json.
  // El AgentLoop las consulta ANTES de ejecutar cualquier
  // herramienta; el default sigue siendo 'ask' para alto impacto (el flujo de
  // aprobación existente), y el usuario puede elevar/denegar por regla.
  try {
    state.permissionManager = new PermissionManager({
      filePath: app ? path.join(app.getPath('userData'), 'permissions.json') : null,
      defaultAction: 'ask',
    });
    logger.info(
      'init',
      `[core] permisos cargados: ${state.permissionManager.list().length} regla(s)`
    );
  } catch (e) {
    logger.warn('init', '[core] permission manager no disponible:', e.message);
    state.permissionManager = null;
  }

  if (state.osSensor) {
    state.grounding.setOSSensor(state.osSensor);
    state.proactive.setOSSensor(state.osSensor);
  }

  // ── Sensores de señales ────────────────────────────────────────────────────
  // Vigilan git, sistema, títulos de ventana, portapapeles (opt-in) y
  // recordatorios próximos. Cada uno emite eventos al bus que el
  // ProactiveEngine ya consume. Nunca rompen el arranque: si uno falla,
  // se loggea y el resto sigue normal. Config: cfg.sensors = { git, system,
  // title, clipboard, events } (todos activos salvo clipboard, que es
  // opt-in por privacidad).
  const sensorsCfg = readSensorsConfig();
  const startSensor = (label, factory) => {
    try {
      const s = factory();
      s.start();
      return s;
    } catch (e) {
      logger.warn('init', `[core] sensor ${label} no disponible:`, e.message);
      return null;
    }
  };
  if (sensorsCfg.git !== false) {
    state.gitWatcher = startSensor('git', () => new GitWatcher({ workspace: projectCWD }));
  }
  if (sensorsCfg.system !== false) {
    state.systemWatcher = startSensor('system', () => new SystemWatcher());
  }
  if (sensorsCfg.title !== false) {
    state.titleWatcher = startSensor('title', () => new TitleWatcher());
  }
  if (sensorsCfg.clipboard === true) {
    state.clipboardWatcher = startSensor('clipboard', () => new ClipboardWatcher());
  }
  if (sensorsCfg.events !== false) {
    state.eventsWatcher = startSensor(
      'upcoming-events',
      () => new UpcomingEventsWatcher({ graph: state.graph })
    );
  }
  logger.info(
    'init',
    `[core] sensores de señales: git=${state.gitWatcher ? 'on' : 'off'} system=${state.systemWatcher ? 'on' : 'off'} title=${state.titleWatcher ? 'on' : 'off'} clipboard=${state.clipboardWatcher ? 'on' : 'off'} eventos=${state.eventsWatcher ? 'on' : 'off'}`
  );

  // ── Fase E: telemetría local ─────────────────────────────────────────────
  // Mide uso real (mensajes/día, tiempo de respuesta, silencios, reuso) en
  // JSON local. El baseline de la tasa de aceptación vive en ProposalStore
  // desde la Fase A — aquí solo se agregan los turnos de conversación.
  state.telemetry = new TelemetryStore({
    filePath: app ? path.join(app.getPath('userData'), 'telemetry.json') : null,
  });

  // ── IntentDetector ────────────────────────────────────────────────────────
  // FIX Fase 3b: cargar sqlite-vec en la misma conexión del StateGraph
  // ANTES de instanciar el IntentDetector. Sin esto, intent_vectors no
  // existe para esa conexión y el detector falla silenciosamente.
  if (!state.graph.usingFallback && state.graph._db) {
    try {
      const sqliteVec = require('sqlite-vec');
      sqliteVec.load(state.graph._db);
      logger.info('init', '[core] sqlite-vec cargado en StateGraph DB');

      state.detector = getIntentDetector(state.graph._db);
      state.detector
        .warmup()
        .then(() => {
          logger.info('init', '[core] IntentDetector listo');
        })
        .catch((e) => {
          logger.warn('init', '[core] IntentDetector warmup falló:', e.message);
        });

      // Recall semántico de memoria (StateGraph.queryNodesSemantic) — misma
      // extensión, misma conexión, tabla vec0 separada de intent_vectors.
      // Backfill de nodos viejos sin embedding corre en segundo plano, en
      // lotes chicos, sin bloquear el arranque ni el primer mensaje.
      if (state.graph.enableVectorSearch()) {
        state.graph
          .backfillEmbeddings()
          .catch((e) => logger.warn('init', '[core] backfill de embeddings falló:', e.message));
      }
    } catch (e) {
      logger.warn('init', '[core] IntentDetector no disponible:', e.message);
      state.detector = null;
    }
  } else {
    logger.warn('init', '[core] IntentDetector desactivado (DB no disponible)');
  }

  state.initiativeUnsub = state.bus.on('initiative:trigger', (payload) => {
    if (process.env.DEBUG)
      logger.info('init', `[core] initiative: "${payload.suggestion?.slice(0, 60)}"`);
    state.lastProposal = payload.proposal
      ? { id: payload.proposal.id, type: payload.proposal.type }
      : null;
    if (state.onInitiative) state.onInitiative(payload);
  });

  // Fase B: resultado de ejecutar una propuesta proactiva (el clic "Sí, hazlo"
  // ya se procesó en el ProactiveEngine). Se reenvía al renderer para que
  // confirme en el bubble de la propuesta con la verificación REAL.
  state.proposalExecutedUnsub = state.bus.on('proposal:executed', (payload) => {
    if (process.env.DEBUG)
      logger.info('init', `[core] proposal:executed ok=${payload.ok} "${payload.detail || ''}"`);
    if (state.onProposalResult) state.onProposalResult(payload);
  });

  scheduleDailyPrune();
  loadLLMConfig();
  loadMCPConfig();

  // Catálogo remoto (models.dev): best-effort, NO bloquea el init — si la red
  // falla degrada en silencio al catálogo curado o al cache en disco.
  refreshRemoteCatalog();

  // Workspace inicial — cargar ANTES de startOpenClaw para pasar
  // OPENCLAW_ALLOWED_PATH con el directorio correcto. El workspace SIGUE el
  // directorio desde el que se lanza la app (o ASISTENTE_WORKSPACE si se
  // define); el valor persistido de config.json ya no se impone al arrancar.
  const _envWorkspace = process.env.ASISTENTE_WORKSPACE;
  const _initialWorkspace = _envWorkspace || projectCWD;
  state.activeWorkspace = _initialWorkspace;

  startOpenClaw(_initialWorkspace);

  // Workspace inicial async (MCP filesystem)
  if (_initialWorkspace) {
    state.mcpReadyPromise
      .then(() => setActiveWorkspace(_initialWorkspace))
      .then((r) => {
        if (r.ok) {
          logger.info(
            'init',
            `[core] workspace inicial (${_envWorkspace ? 'ASISTENTE_WORKSPACE' : 'default (directorio de la app)'}):`,
            r.path
          );
          state.proactive.start();
          // Fase C: ofrecer retomar lo pendiente (recordatorios) al arrancar.
          state.proactive
            .pendingRecap()
            .catch((e) => logger.warn('init', '[core] error en recap de pendientes:', e.message));
          // Fase D: watcher de errores LSP (con su propio scope).
          if (readSensorsConfig().lsp !== false && state.lspErrorWatcher) {
            state.lspErrorWatcher.start();
            logger.info('init', '[core] LSPErrorWatcher activo');
          }
        } else logger.warn('init', '[core] workspace inicial inválido:', r.error);
      });
  }

  if (state.graph.usingFallback) {
    const reason = state.graph.fallbackReason || '';
    const isMissingModule = /BETTER_SQLITE3_MISSING|Cannot find module|no disponible/.test(reason);
    logger.error('init', '');
    logger.error('init', '╔══════════════════════════════════════════════════════════╗');
    logger.error('init', '║  ADVERTENCIA CRITICA — MEMORIA NO PERSISTENTE        ║');
    logger.error('init', '║                                                          ║');
    logger.error('init', '║  El asistente está usando MemoryDB (RAM temporal).       ║');
    logger.error('init', '║  Todo lo aprendido esta sesión se perderá al cerrar.    ║');
    if (isMissingModule) {
      logger.error('init', '║  Causa: better-sqlite3 no pudo inicializarse.              ║');
      logger.error('init', '║  Solución: npm install                                    ║');
    } else {
      logger.error('init', `║  Causa: ${String(reason).slice(0, 46).padEnd(46)}║`);
    }
    logger.error('init', '╚══════════════════════════════════════════════════════════╝');
    logger.error('init', '');
    state.bus.emit('memory-status', { usingFallback: true, reason });
  }

  logger.info('init', '[core] inicializado (Fase 3)');
  return { graph: state.graph, grounding: state.grounding, session: state.session };
}

module.exports = {
  init,
  migrateLegacyDb,
};
