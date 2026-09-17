// @ts-nocheck
const logger = require('../observability/Logger.js');
// context.js — construcción del context para el LLM (buildContext): ensambla
// el system prompt desde BehaviorModel, IntentDetector, TaskDetector,
// GroundingEngine, reglas del proyecto, herramientas, skills y modos
// (chat/plan/execute/agent), con truncado inteligente por secciones.

const LLMProvider = require('../llm/LLMProvider.js');
const { BehaviorModel } = require('../behavior/BehaviorModel.js');
const { buildRulesSection } = require('../rules/ProjectRules.js');
const { resolveToolset, shouldPreferDesktopOrchestrators } = require('../task/ToolResolver.js');
const { getProjectCWD } = require('../planner/Planner.js');
const { buildGestureSection } = require('../behavior/GestureVocabulary.js');
const { readGesturesConfig } = require('./config.js');
const { _computeTurnEngagement } = require('../state-graph/evolution/FeedbackScorer.js');

const state = require('./state.js');

// FIX: presupuesto de tokens del system prompt COMPLETO — antes vivía
// dentro de GroqSerializer.js y se aplicaba antes de pegar BehaviorModel,
// las reglas de OpenClaw + catálogo MCP. Ahora se aplica aquí, al
// final de buildContext(), sobre el prompt ya ensamblado del todo.
const MAX_SYSTEM_CHARS = 14_000; // ~3.5k tokens — conservador pero amplio

// ── Fusión intent→task: tool de OpenClaw → id de dominio (TaskDetector) ───
// Tabla de datos para sintetizar taskIntent desde IntentDetector cuando el
// regex no vio tarea (típico en otros idiomas). Sin esta fusión, "open amazon"
// moriría como charla aunque los embeddings la detecten como open_website.
const TOOL_DOMAIN_IDS = Object.freeze({
  launch_app: 'system',
  open_website: 'web',
  play_media: 'multimedia',
  browser: 'web',
  web_search: 'web',
  websearch: 'web',
  webfetch: 'web',
  desktop_snapshot: 'system',
  desktop_screenshot: 'system',
  pointer_click: 'system',
  window_list: 'system',
  window_focus: 'system',
  ui_get_state: 'system',
  ui_wait: 'system',
  ui_click: 'system',
  ui_type: 'system',
  ui_press: 'system',
  ui_select: 'system',
  ui_scroll: 'system',
  window_close: 'system',
  desktop_capabilities: 'system',
  process_list: 'system',
  process_stop: 'system',
  camera_status: 'system',
  open_camera: 'system',
});

/** @param {unknown} tool @returns {{id: string}|null} dominio mínimo para fusión */
function _domainForTool(tool) {
  const id = TOOL_DOMAIN_IDS[String(tool || '')];
  return id ? { id } : null;
}

/**
 * Fusión por inferencia (multilenguaje sin regex por idioma): si el
 * TaskDetector (regex, español-primero) no vio tarea pero el IntentDetector
 * (embeddings, catálogo ES+EN) sí detectó una tool de acción con confianza,
 * sintetiza la intención. Así "open amazon" funciona sin una sola línea de
 * inglés hardcodeado en patrones: la similitud semántica decide.
 * @param {object|null} taskIntent resultado de TaskDetector.detect (puede ser null)
 * @param {object|null} toolIntent resultado de IntentDetector.detect (puede ser null)
 * @param {unknown} userText mensaje original del usuario
 * @returns {object|null} taskIntent fusionada o null si no aplica
 */
function fuseTaskIntent(taskIntent, toolIntent, userText) {
  try {
    if (
      (!taskIntent || taskIntent.isTask !== true) &&
      toolIntent &&
      toolIntent.detected &&
      (toolIntent.level === 'high' || toolIntent.level === 'medium')
    ) {
      const fusedDomain = _domainForTool(toolIntent.tool);
      if (fusedDomain) {
        return {
          isTask: true,
          confidence: toolIntent.level === 'high' ? 'medium' : 'low',
          domain: fusedDomain,
          goal: String(userText || '').slice(0, 200),
          specificity: 'vague',
          _debug: { fusedFrom: `intent:${toolIntent.action}`, matchedDomains: [] },
        };
      }
    }
  } catch (e) {
    logger.warn('context', '[core] fusión intent→task error:', e.message);
  }
  return null;
}
const TRUNCATION_SUFFIX = '\n\n[contexto truncado por longitud]';
const MCP_CATALOG_LIMIT = 40;

// ── Fase 3: stack del workspace activo ────────────────────────────────────────
// Sección compacta del proyecto sobre el que el asistente trabaja (lenguaje,
// scripts, dependencias, estructura raíz y rama git). Se lee SOLO con fs
// (sin subprocesos) y se inyecta antes del early-return del modo agent para
// llegar a todos los modos y entrar en el presupuesto de truncado.

const WORKSPACE_STACK_MAX_ENTRIES = 14;

/** Devuelve la sección del workspace activo o '' si no hay cwd usable. */
function buildWorkspaceStackSection(cwd) {
  if (!cwd || typeof cwd !== 'string') return '';
  const fs = require('fs');
  const path = require('path');
  try {
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return '';
    const lines = ['# WORKSPACE ACTIVO (PROYECTO)'];

    let lang = 'desconocido';
    let pkg = null;
    const pkgPath = path.join(cwd, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      } catch (_) {
        logger.debug('context', 'package.json corrupto o no parseable');
      }
    }
    // TypeScript solo si hay fuentes .ts de verdad (un tsconfig puede ser solo
    // para typecheck con JSDoc, como en este mismo repo — no es motivo para
    // escribir .ts).
    const hasTs = fs.existsSync(path.join(cwd, 'tsconfig.json'));
    let tsSources = false;
    if (hasTs) {
      try {
        const scanDirs = ['src', 'lib', 'app'];
        tsSources =
          fs.readdirSync(cwd).some((e) => e.endsWith('.ts')) ||
          scanDirs.some((d) => {
            try {
              return fs.readdirSync(path.join(cwd, d)).some((f) => f.endsWith('.ts'));
            } catch (_) {
              return false;
            }
          });
      } catch (_) {
        logger.debug('context', 'escaneo de tsconfig.json falló');
      }
    }
    if (pkg) {
      lang =
        hasTs && tsSources
          ? 'TypeScript'
          : pkg.type === 'module'
            ? 'JavaScript (ESM)'
            : 'JavaScript (CommonJS)';
    } else if (fs.existsSync(path.join(cwd, 'pyproject.toml'))) {
      lang = 'Python (Poetry)';
    } else if (fs.existsSync(path.join(cwd, 'requirements.txt'))) {
      lang = 'Python';
    } else if (fs.existsSync(path.join(cwd, 'go.mod'))) {
      lang = 'Go';
    } else if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) {
      lang = 'Rust';
    } else if (fs.existsSync(path.join(cwd, 'Gemfile'))) {
      lang = 'Ruby';
    }

    lines.push(`- Proyecto: ${pkg?.name || path.basename(cwd)}`);
    lines.push(`- Ruta: ${cwd}`);
    lines.push(`- Lenguaje/stack: ${lang}`);

    if (pkg) {
      const scripts = pkg.scripts ? Object.keys(pkg.scripts) : [];
      if (scripts.length > 0) {
        lines.push(`- Scripts: ${scripts.slice(0, 8).join(', ')}`);
      }
      const deps = Object.keys(pkg.dependencies || {}).length;
      const devDeps = Object.keys(pkg.devDependencies || {}).length;
      let manager = 'npm';
      if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))) manager = 'pnpm';
      else if (fs.existsSync(path.join(cwd, 'yarn.lock'))) manager = 'yarn';
      else if (fs.existsSync(path.join(cwd, 'bun.lockb'))) manager = 'bun';
      lines.push(`- Dependencias: ${deps} deps + ${devDeps} dev (${manager})`);
    }

    let entries = [];
    try {
      entries = fs.readdirSync(cwd);
    } catch (_) {
      logger.debug('context', 'readdir de cwd falló');
    }
    const items = entries
      .filter((e) => !e.startsWith('.') && e !== 'node_modules' && e !== 'dist')
      .slice(0, WORKSPACE_STACK_MAX_ENTRIES);
    if (items.length > 0) lines.push(`- Raíz: ${items.join('  ')}`);

    // Rama git: lectura directa de .git/HEAD (sin invocar `git`).
    try {
      const head = fs.readFileSync(path.join(cwd, '.git', 'HEAD'), 'utf-8').trim();
      const m = head.match(/^ref:\s*refs\/heads\/(.+)$/);
      if (m) lines.push(`- Rama git: ${m[1]}`);
    } catch (_) {
      logger.debug('context', 'lectura de .git/HEAD falló');
    }

    return lines.join('\n');
  } catch (_) {
    return '';
  }
}

// ── Fase 3: veracidad del código ─────────────────────────────────────────────
// Reglas contra los fallos reales de una sesión de producción (sesión de
// TypeScript/fibonacci): código no verificado, salidas inventadas, lenguajes
// mezclados y ejemplos inconsistentes entre mensajes.

const CODE_VERACITY_RULE = `# VERACIDAD DEL CÓDIGO

- No afirmes que un código "funciona" o "da este resultado" salvo que lo hayas
  EJECUTADO de verdad (node, tests, etc.). Si no pudiste ejecutarlo, dilo y
  marca el resultado como sin verificar.
- No inventes salidas: números exactos, hashes, listas de archivos o mensajes
  de error que no provienen de una ejecución real.
- Escribe el código en el MISMO lenguaje/stack del proyecto o del que el
  usuario está aprendiendo. No mezcles lenguajes sin avisar.
- Mantén los ejemplos CONSISTENTES entre mensajes: si mostraste una función
  con 2 parámetros, no la reescribas con 1 en el siguiente mensaje.
- Antes de mostrar código, confirma con las herramientas (grep/read/tsc) que
  las APIs, funciones y firmas que citas existen de verdad.
- Si un comando falla (EISDIR, no such file, permiso), cambia de estrategia
  en vez de repetirlo o de fingir que funcionó.`;

// Estilo de conversación (feedback directo del usuario): cero emojis,
// markdown para el formato, interés genuino por lo que dice y VERACIDAD
// sobre la historia compartida — nada de inventar recuerdos o temas previos.
const CONVERSATION_STYLE_RULE = `# ESTILO DE CONVERSACIÓN

## Emojis: PROHIBIDOS
- NO uses NINGÚN emoji, nunca. Ni uno. En ninguna respuesta.
- Para dar formato usá MARKDOWN: **negritas**, listas, \`código\`. Es más
  limpio y elegante.
- El entusiasmo se expresa con PALABRAS, no con símbolos.

## Interés genuino por la persona
- ANTES de proponer actividades o cambiar de tema, ENGANCHATE con lo que
  acaba de decir: hacé una pregunta de seguimiento sobre SU situación,
  validá cómo se siente, o profundizá en el detalle que mencionó.
- No respondas con menús de opciones ("¿querés A, B o C?") cuando la persona
  está charlando: seguí la conversación que ella abrió.
- Si te cuenta algo personal (escuela, trabajo, planes), interesate de verdad:
  preguntá cómo se siente, qué le preocupa, qué espera.

## Veracidad de la historia compartida
- No inventes recuerdos: si mencionás algo "que pasó antes", debe estar en
  tu memoria/contexto real. Un recuerdo falso rompe la confianza.
- Si no recordás algo, decilo naturalmente ("no lo tengo fresco, contame")
  en vez de improvisar un pasado falso.`;

// ── Context ───────────────────────────────────────────────────────────────────

// Estado para feedback loop: almacena el contexto del turno anterior
const _prevTurnContext = {
  enforcement: null,
  emotionalCtx: null,
  adaptationType: null,
  sessionId: null,
};

async function buildContext(sessionHistory, activeProvider, options = {}) {
  const provider = activeProvider || LLMProvider.getActiveProvider() || 'groq';
  const mode = options.mode || 'chat'; // 'plan' | 'execute' | 'chat'
  const approvedPlan = options.plan || null;

  // Evaluar la respuesta del turno anterior (feedback loop)
  const currentSessionId = state.session?.getSessionId?.() ?? null;
  if (
    _prevTurnContext.enforcement &&
    state.graph &&
    _prevTurnContext.sessionId === currentSessionId
  ) {
    try {
      const evaluator = state.graph.getResponseEvaluator?.();
      if (evaluator) {
        // El historial actual termina en el mensaje que responde a la salida
        // pendiente. Antes se medía `history[length - 2]`, que normalmente era
        // la propia respuesta de Kaoru y atribuía su longitud como engagement.
        const lastUserMsg = [...sessionHistory].reverse().find((m) => m.role === 'user');
        const engagement = lastUserMsg
          ? _computeTurnEngagement(lastUserMsg.content || '', sessionHistory.length > 2)
          : 0.5;
        evaluator.evaluate(engagement, currentSessionId);
      }
    } catch (e) {
      logger.debug('context', '[core] error evaluando respuesta anterior:', e.message);
    }
  }

  const lastUserMsg = [...sessionHistory].reverse().find((m) => m.role === 'user');
  const userText = lastUserMsg?.content || '';

  const osCtx = state.osSensor?.getCurrentContext() ?? null;

  // BehaviorModel
  let behaviorCtx = null;
  let enforcementRules = null;
  _prevTurnContext.adaptationType = null;
  if (state.behavior) {
    try {
      // Get adaptation profile from evolutionary memory
      let adaptationProfile = null;
      if (state.graph && typeof state.graph.getAdaptiveEngine === 'function') {
        try {
          const adaptiveEngine = state.graph.getAdaptiveEngine();
          if (adaptiveEngine) {
            adaptationProfile = adaptiveEngine.buildAdaptationProfile();
            // Registrar adaptación para feedback loop
            if (adaptationProfile && adaptationProfile.confidence > 0.2) {
              const adaptationType =
                adaptationProfile.emotionalContext && adaptationProfile.emotionalIntensity > 0.3
                  ? 'emotionalContext'
                  : adaptationProfile.responseLength !== 'normal'
                    ? 'responseLength'
                    : adaptationProfile.technicalLevel !== 'moderate'
                      ? 'technicalLevel'
                      : adaptationProfile.formality !== 'neutral'
                        ? 'formality'
                        : null;
              const feedbackScorer = state.graph.getFeedbackScorer?.();
              if (feedbackScorer && adaptationType) {
                feedbackScorer.recordAdaptation(adaptationType, adaptationProfile.styleHint || '');
              }
              _prevTurnContext.adaptationType = adaptationType;
            }
            // Serializar perfil para inyectar al LLM
            if (adaptationProfile && adaptationProfile.confidence > 0.1) {
              const {
                AdaptiveResponseEngine,
              } = require('../state-graph/evolution/AdaptiveResponseEngine.js');
              const adaptationHint = AdaptiveResponseEngine.serialize(adaptationProfile);
              if (adaptationHint) {
                behaviorCtx = { ...behaviorCtx, adaptationHint };
              }
            }
          }
        } catch (e) {
          logger.warn('context', '[core] error getting adaptation profile:', e.message);
        }
      }

      // Get emotional context from LLMEotionDetector
      let emotionalCtx = null;
      if (state.graph && typeof state.graph.getLLMEotionDetector === 'function') {
        try {
          const detector = state.graph.getLLMEotionDetector();
          if (detector) {
            emotionalCtx = await detector.detect(userText, { history: sessionHistory });
          }
        } catch (e) {
          logger.debug('context', '[core] error getting emotional context:', e.message);
        }
      }

      // Record emotional trend for this turn
      if (
        emotionalCtx &&
        state.graph &&
        typeof state.graph.getEmotionalTrendTracker === 'function'
      ) {
        try {
          const trendTracker = state.graph.getEmotionalTrendTracker();
          if (trendTracker && state.session?._sessionId) {
            trendTracker.recordTurn(state.session._sessionId, emotionalCtx, userText);
          }
        } catch (e) {
          logger.debug('context', '[core] error recording emotional trend:', e.message);
        }
      }

      // Get enforcement rules from PromptEnforcer
      if (state.graph && typeof state.graph.getPromptEnforcer === 'function') {
        try {
          const enforcer = state.graph.getPromptEnforcer();
          if (enforcer) {
            enforcementRules = enforcer.enforce(
              emotionalCtx,
              null,
              null,
              state.session?._sessionId
            );
          }
        } catch (e) {
          logger.debug('context', '[core] error getting enforcement rules:', e.message);
        }
      }

      // Agregar tendencias emocionales al enforcement
      if (state.session?._sessionId && state.graph && enforcementRules) {
        try {
          const trendTracker = state.graph.getEmotionalTrendTracker?.();
          if (trendTracker) {
            const trendHint = trendTracker.buildTrendHint(state.session._sessionId);
            if (trendHint && enforcementRules.rules) {
              enforcementRules.rules.push(trendHint);
            }
          }
        } catch (e) {
          logger.debug('context', '[core] error getting trend hint:', e.message);
        }
      }

      // Almacenar contexto para evaluación en el próximo turno
      _prevTurnContext.enforcement = enforcementRules;
      _prevTurnContext.emotionalCtx = emotionalCtx;
      _prevTurnContext.sessionId = currentSessionId;

      behaviorCtx = state.behavior.evaluate(
        userText,
        osCtx,
        sessionHistory,
        adaptationProfile,
        emotionalCtx
      );
      state.bus.emit('behavior:evaluated', behaviorCtx);
    } catch (e) {
      logger.warn('context', '[core] error en BehaviorModel:', e.message);
    }
  }

  // IntentDetector
  let toolIntent = null;
  if (state.detector) {
    try {
      toolIntent = await state.detector.detect(userText);
      if (toolIntent.detected) {
        logger.info(
          'context',
          `[core] toolIntent: ${toolIntent.action}` +
            ` (${(toolIntent.confidence * 100).toFixed(0)}%, ${toolIntent.level})`
        );
      }
    } catch (e) {
      logger.warn('context', '[core] IntentDetector error:', e.message);
    }
  }

  // TaskDetector — detecta si el usuario quiere hacer una tarea (no solo charlar)
  let taskIntent = null;
  try {
    taskIntent = state.taskDetector.detect(userText);
    if (taskIntent.isTask) {
      logger.info(
        'context',
        `[core] taskIntent: ${taskIntent.domain?.id || 'indefinido'}` +
          ` (confianza: ${taskIntent.confidence})`
      );
    }
  } catch (e) {
    logger.warn('context', '[core] TaskDetector error:', e.message);
  }

  // Fusión por inferencia (multilenguaje sin regex por idioma): ver
  // fuseTaskIntent(). Así "open amazon" funciona sin una sola línea de inglés
  // hardcodeado en patrones: la similitud semántica decide.
  const fused = fuseTaskIntent(taskIntent, toolIntent, userText);
  if (fused) {
    taskIntent = fused;
    logger.info(
      'context',
      `[core] taskIntent fusionada por embeddings: ${fused.domain.id} (tool ${toolIntent.tool})`
    );
  }

  // Semantic fallback shares the existing embedding service and vector space.
  let detectionPath = taskIntent?.isTask ? (fused ? 'fusion' : 'regex') : 'none';
  if (
    state.detector &&
    (!taskIntent?.isTask || !taskIntent.domain || taskIntent.confidence === 'none')
  ) {
    try {
      const { classify } = require('../task/IntentClassifier.js');
      const EmbedService = require('../grounding/EmbedService.js');
      const classified = await classify(userText, { embedFn: EmbedService.embedText });
      if (classified.isTask && classified.domain && classified.level !== 'none') {
        taskIntent = {
          isTask: true,
          confidence: 'medium',
          domain: classified.domain,
          goal: String(userText || '').slice(0, 200),
          specificity: 'vague',
        };
        detectionPath = 'classifier';
      }
    } catch (e) {
      logger.warn('context', '[core] semantic fallback failed:', e.message);
    }
  }
  const { detectLanguage } = require('../grounding/LanguageProfile.js');
  const language = detectLanguage(userText, { override: options.languageOverride || null });
  try {
    require('../telemetry/DetectionTelemetry.js').recordDetection({
      path: detectionPath,
      domain: taskIntent?.domain,
      confidence: taskIntent?.confidence,
      lang: language.code,
    });
    state.telemetry?.recordDetectionPath?.(detectionPath);
  } catch (_) {
    require('../observability/SwallowedErrors.js').swallow('context.detectionTelemetry');
  }

  // GroundingEngine
  let result;
  if (state.grounding) {
    result = await state.grounding.buildContext(sessionHistory, provider, toolIntent, {
      // Fase 1: la memoria persistente (nodos semánticos + episodios) SÍ llega
      // al prompt en producción. Antes era opt-in (`=== true`) y ningún call
      // site real la activaba — todo el pipeline de retrieval/embeddings
      // corría cada turno para descartar el resultado en el serializer. La
      // sección ya está acotada en el serializer (8 nodos + 3 episodios) y el
      // truncado por presupuesto la protege (context.js → MAX_SYSTEM_CHARS).
      includeMemory: options.includeMemory !== false,
      languageOverride: options.languageOverride || null,
    });
  } else {
    const Fallback = require('../llm/GroundingMinimo.js');
    result = Fallback.buildContext(sessionHistory);
  }

  result.language = language;
  result.detectionPath = detectionPath;

  // BehaviorModel — inyectar sección
  if (behaviorCtx) {
    const behaviorSection = BehaviorModel.serialize(behaviorCtx);
    if (behaviorSection) {
      result.systemPrompt = result.systemPrompt + '\n\n' + behaviorSection;
    }
  }

  // ── Reglas del proyecto (AGENTS.md) — patrón opencode ──────────────────
  // Se leen del workspace activo con caché por mtime y se inyectan ANTES del
  // early-return del modo agent, así llegan a todos los modos (chat, plan,
  // execute, agent). Tienen prioridad sobre las reglas generales.
  const rulesSection = buildRulesSection(getProjectCWD());
  if (rulesSection) {
    result.systemPrompt = result.systemPrompt + '\n\n' + rulesSection;
  }

  // ── Fase 3: stack del workspace + veracidad de código ──────────────────
  // Se inyectan ANTES del early-return del modo agent (llegan a todos los
  // modos) y entran en el presupuesto de truncado. El stack se lee con fs
  // (sin subprocesos); la regla de veracidad es estática y corta.
  const workspaceStack = buildWorkspaceStackSection(getProjectCWD());
  if (workspaceStack) {
    result.systemPrompt = result.systemPrompt + '\n\n' + workspaceStack;
  }
  result.systemPrompt = result.systemPrompt + '\n\n' + CODE_VERACITY_RULE;
  result.systemPrompt = result.systemPrompt + '\n\n' + CONVERSATION_STYLE_RULE;

  // ── Gestos dirigidos por el LLM ──────────────────────────────────────────
  // Sección dinámica: el vocabulario se extrae del model3.json activo (nombres
  // reales de expresiones/motions, en cualquier idioma). El LLM solo elige de
  // la lista; el GestureEngine orquesta la reproducción. Gate por config
  // gestures.enabled && gestures.llmDriven; si no hay modelo activo o gestos,
  // la sección es '' y no se inyecta nada.
  try {
    const gesturesCfg = readGesturesConfig();
    if (gesturesCfg && gesturesCfg.enabled !== false && gesturesCfg.llmDriven !== false) {
      const gestureSection = buildGestureSection(state.activeModel3Path, {
        mappings: gesturesCfg.mappings || {},
      });
      if (gestureSection) {
        result.systemPrompt = result.systemPrompt + '\n\n' + gestureSection;
      }
    }
  } catch (e) {
    logger.warn('context', '[core] sección de gestos omitida:', e.message);
  }

  // ── Tool Resolution (Fase 1): siempre resolver herramientas ─────────────
  // Fase 1: el toolset completo está disponible en TODOS los modos, sin
  // importar el nivel de confianza de IntentDetector. La intención detectada
  // solo influye en CÓMO se sugieren las acciones en el texto del prompt,
  // nunca en SI el modelo puede ejecutar herramientas.
  let toolCatalog = null;
  let resolvedTools = null;
  try {
    const matchedDomains = (taskIntent?._debug?.matchedDomains || [])
      .map((item) => item?.domain)
      .filter(Boolean);
    resolvedTools = await resolveToolset({
      userMessage: userText,
      domain: taskIntent?.domain || null,
      domains: matchedDomains,
      preferOrchestrators: shouldPreferDesktopOrchestrators(taskIntent),
      toolRegistry: state.toolRegistry,
      skillManager: state.skillManager || null,
      mcpManager: state.mcp || null,
      db: state.graph && !state.graph.usingFallback && state.graph._db ? state.graph._db : null,
      capabilityStatsProvider:
        state.learning && typeof state.learning.capabilityStats === 'function'
          ? () => state.learning.capabilityStats({ minUses: 2 })
          : null,
    });
    toolCatalog = resolvedTools?.promptCatalog || null;
  } catch (e) {
    logger.warn('context', '[core] error en resolución de herramientas:', e.message);
  }
  if (!toolCatalog) {
    toolCatalog = state.toolRegistry.serializeToPrompt(taskIntent?.domain || null);
  }

  // ── MODE: AGENT (loop cerrado) ─────────────────────────────────────────
  // Fase 1: nativeToolSchemas se pasa al AgentLoop para completeWithTools()
  // en todos los turnos, filtrado solo por precedencia (Skill > MCP > OpenClaw).
  if (mode === 'agent') {
    // El modo agent retorna antes que los demás modos, por lo que estas dos
    // señales críticas deben incorporarse aquí: reglas aprendidas y errores
    // actuales del workspace.
    if (enforcementRules && enforcementRules.rules.length) {
      const enforcer = state.graph?.getPromptEnforcer?.();
      const section = enforcer?.serialize?.(enforcementRules);
      if (section) result.systemPrompt += '\n\n' + section;
    }
    if (state.lspErrorWatcher) {
      try {
        const errors = state.lspErrorWatcher.getRecentErrors?.({ limit: 5 }) || [];
        if (errors.length > 0) {
          const ws = state.activeWorkspace || state.openclawWorkspace || '';
          const lines = errors.map((e) => {
            const rel =
              ws && e.filePath.startsWith(ws) ? e.filePath.slice(ws.length + 1) : e.filePath;
            return `- ${rel}:${e.line + 1} [${e.language}] ${e.message}${e.source ? ` (${e.source})` : ''}`;
          });
          let section = `## Errores actuales del workspace (LSP)\n${lines.join('\n')}`;
          if (section.length > 1400) section = section.slice(0, 1400) + '\n…';
          result.systemPrompt += '\n\n' + section;
        }
      } catch (e) {
        logger.debug('context', '[core] error armando diagnósticos LSP para agent:', e.message);
      }
    }
    // El presupuesto de MAX_SYSTEM_CHARS se aplica en AgentLoop.run(), DESPUÉS
    // del ensamblado completo (AGENT_LOOP_SYSTEM + catálogo + recall + skills),
    // no aquí: truncar antes de los appends hacía que el presupuesto no contara
    // todo lo que se añadía después. Ver core/planner/AgentLoop.js.
    return {
      ...result,
      behaviorCtx,
      toolIntent,
      taskIntent,
      mode,
      nativeToolSchemas: resolvedTools?.nativeToolSchemas || null,
      nativeMcpMap: resolvedTools?.nativeMcpMap || {},
      allowedToolNames: resolvedTools?.allowedToolNames || null,
      toolCatalog,
      resolvedSkills: resolvedTools?.matchedSkills || null,
    };
  }

  // ── Skill knowledge injection (Fase 4) ──────────────────────────────────
  if (state.skillManager && typeof state.skillManager.buildInjection === 'function') {
    try {
      const skillBlock = await state.skillManager.buildInjection(
        userText,
        state.graph && !state.graph.usingFallback && state.graph._db ? state.graph._db : null
      );
      if (skillBlock) {
        result.systemPrompt += '\n\n' + skillBlock;
      }
    } catch (e) {
      logger.warn('context', '[core] error inyectando skills:', e.message);
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
        approvedPlan.steps
          .filter((s) => !s.done)
          .map((s, i) => `  ${i + 1}. ${s.description}`)
          .join('\n') +
        '\n';
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
        approvedPlan.steps
          .filter((s) => !s.done)
          .map((s, i) => `  ${i + 1}. ${s.description}`)
          .join('\n') +
        '\n';
    }
  }

  // ── MODE: CHAT (modo normal, sin planificación) ────────────────────────────
  // Fase 1: las herramientas están disponibles siempre que OpenClaw esté
  // activo, sin importar el nivel de intención detectado. IntentDetector
  // solo influye en las sugerencias textuales (GroqSerializer), no en el
  // acceso a herramientas.
  if (mode === 'chat') {
    if (state.bridge?.getStats()?.available) {
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
        'Ejecutar: git push origin main\n' +
        'El sistema los ejecutará en orden automáticamente.';
    }

    // MCP — independiente de toolIntent y de si OpenClaw está disponible.
    if (state.mcp?.hasConnectedServers()) {
      const mcpTools = state.mcp.listAllTools();
      if (mcpTools.length) {
        result.systemPrompt += buildMCPCatalogPrompt(mcpTools);
      }
    }
  }

  // Enforcement rules (memoria evolutiva)
  if (enforcementRules && enforcementRules.rules.length) {
    const enforcer = state.graph?.getPromptEnforcer?.();
    if (enforcer) {
      const enforcementSection = enforcer.serialize(enforcementRules);
      if (enforcementSection) {
        result.systemPrompt = result.systemPrompt + '\n\n' + enforcementSection;
      }
    }
  }

  // ── Diagnósticos LSP recientes (solo modo agente/tarea) ───────────────────
  // Lectura barata: cache del watcher (poll cada 30s), cero pulls LSP. Le da
  // al agente conciencia de qué está roto sin tener que pedirlo. Presupuesto
  // acotado: máx 5 errores, ~1200 chars — el truncado lo elimina temprano si
  // hay presión de tokens.
  if ((mode === 'agent' || mode === 'execute') && state.lspErrorWatcher) {
    try {
      const errors = state.lspErrorWatcher.getRecentErrors?.({ limit: 5 }) || [];
      if (errors.length > 0) {
        const ws = state.activeWorkspace || state.openclawWorkspace || '';
        const lines = errors.map((e) => {
          const rel =
            ws && e.filePath.startsWith(ws) ? e.filePath.slice(ws.length + 1) : e.filePath;
          return `- ${rel}:${e.line + 1} [${e.language}] ${e.message}${e.source ? ` (${e.source})` : ''}`;
        });
        let section = `\n\n## Errores detectados en el workspace (LSP)\nEl usuario tiene estos errores SIN resolver ahora mismo — considera ofrecer ayuda:\n${lines.join('\n')}`;
        if (section.length > 1400) section = section.slice(0, 1400) + '\n…';
        result.systemPrompt += section;
      }
    } catch (e) {
      logger.debug('context', '[core] error armando sección de diagnósticos LSP:', e.message);
    }
  }

  // ── Fase 3 ítem 2: lo aprendido (chat) ────────────────────────────────────
  // Se anexa al final; el recortador lo elimina después de memoria y episodios,
  // antes de tocar el catálogo de herramientas.
  try {
    const learningSection = state.learning?.buildPromptSection?.();
    if (learningSection) result.systemPrompt += '\n\n' + learningSection;
  } catch (_) {}

  // Truncado inteligente: si el prompt excede MAX_SYSTEM_CHARS, elimina
  // secciones COMPLETAS empezando por la menos importante, en vez de cortar
  // a mitad de una instrucción (que rompe el formato estructurado). En modo
  // agent lo aplica AgentLoop tras el ensamblado completo; aquí solo para
  // chat/plan/execute (ver truncateSystemPrompt()).
  result.systemPrompt = truncateSystemPrompt(result.systemPrompt, {
    tailSections: [{ name: 'Lo aprendido (feedback)', marker: '# LO APRENDIDO (FEEDBACK)' }],
  });

  return {
    ...result,
    behaviorCtx,
    toolIntent,
    taskIntent,
    mode,
    nativeToolSchemas: resolvedTools?.nativeToolSchemas || null,
    allowedToolNames: resolvedTools?.allowedToolNames || null,
  };
}

/**
 * Truncado inteligente del system prompt: si excede el presupuesto elimina
 * secciones COMPLETAS empezando por la menos importante, en vez de cortar a
 * mitad de una instrucción (que rompería el formato estructurado).
 *
 * @param {string} systemPrompt prompt ya ensamblado del todo.
 * @param {{max?: number, tailSections?: Array<{name: string, marker: string}>}} [opts]
 *   - max: presupuesto en chars (por defecto MAX_SYSTEM_CHARS).
 *   - tailSections: encabezados de bloques opcionales añadidos al ensamblado.
 *     Se integran con las secciones base: memoria → episodios → feedback →
 *     otros bloques opcionales → catálogo. Cada corte termina en el siguiente
 *     bloque; nunca elimina todo el resto del prompt.
 * @returns {string}
 */
function truncateSystemPrompt(systemPrompt, opts = {}) {
  const max = opts.max ?? MAX_SYSTEM_CHARS;
  if (systemPrompt.length <= max) return systemPrompt;
  logger.warn(
    'context',
    `[core] system prompt excede: ${systemPrompt.length} > ${max} chars, recortando...`
  );

  let out = systemPrompt;

  // Un único orden para memoria base y bloques añadidos por AgentLoop.
  // El catálogo es el último recurso, independientemente de dónde se añadió.
  const sectionMarkers = [
    { name: 'Impresiones', marker: '## Impresiones (no confirmadas' },
    { name: 'Memoria', marker: '## Lo que sé del usuario' },
    { name: 'Memoria recall', marker: '# CONTEXTO RELEVANTE DE MEMORIA' },
    { name: 'Episodios', marker: '## Recuerdos episódicos' },
    { name: 'Lo aprendido (feedback)', marker: '# LO APRENDIDO (FEEDBACK)' },
    { name: 'Adaptación', marker: '## Adaptación al usuario' },
    { name: 'Skills', marker: '---\n\n**Skills activas' },
    { name: 'Intenciones pendientes', marker: '# INTENCIONES ACTIVAS PENDIENTES' },
    { name: 'OS', marker: '## Contexto actual' },
    { name: 'Behavior', marker: '# COMPORTAMIENTO ESTE TURNO' },
    { name: 'Intent', marker: '## INTENCIÓN DE HERRAMIENTA' },
    { name: 'Plan', marker: '# MODO PLAN' },
    { name: 'Execute', marker: '# MODO EJECUCIÓN' },
    { name: 'Loop agente', marker: '# MODO AGENTE' },
  ];
  const catalogs = [
    { name: 'MCP', marker: '# HERRAMIENTAS MCP' },
    { name: 'Catálogo de tools', marker: '# HERRAMIENTAS DISPONIBLES' },
  ];
  const knownMarkers = new Set([...sectionMarkers, ...catalogs].map((section) => section.marker));
  const extraSections = (opts.tailSections || []).filter(
    (section) => !knownMarkers.has(section.marker)
  );
  const ordered = [...sectionMarkers, ...extraSections, ...catalogs];

  // Solo encabezados al inicio de línea: no interpretar menciones en prosa.
  const findMarker = (text, marker, offset = 0) => {
    let index = text.indexOf(marker, offset);
    while (index > 0 && text[index - 1] !== '\n') index = text.indexOf(marker, index + 1);
    return index;
  };
  for (const section of ordered) {
    while (out.length > max) {
      const from = findMarker(out, section.marker);
      if (from === -1) break;
      const contentStart = from + section.marker.length;
      let end = out.length;
      // Nunca borrar secciones posteriores junto con el bloque seleccionado.
      for (const boundary of ordered) {
        const next = findMarker(out, boundary.marker, contentStart);
        if (next !== -1) end = Math.min(end, next);
      }
      const separator = out.indexOf('\n\n---\n\n', contentStart);
      if (separator !== -1) end = Math.min(end, separator);
      // También conservar bloques nuevos no incluidos en la lista de recorte.
      const heading = out.indexOf('\n# ', contentStart);
      if (heading !== -1) end = Math.min(end, heading + 1);
      if (catalogs.some((catalog) => catalog.marker === section.marker)) {
        logger.warn(
          'context',
          '[core] intentando recortar catálogo de tools — esto puede causar tool_calls_total=0'
        );
      }
      const removed = out.slice(from, end);
      out = out.slice(0, from) + out.slice(end);
      logger.info(
        'context',
        `[core] sección "${section.name}" eliminada (${removed.length} chars)`
      );
    }
    if (out.length <= max) break;
  }

  // 3) Si sigue excediendo después de eliminar secciones opcionales, truncado
  //    duro al final conservando el inicio (identidad).
  if (out.length > max) {
    const budget = max - TRUNCATION_SUFFIX.length;
    logger.warn('context', `[core] truncado duro: ${out.length} → ${max} chars (solo identidad)`);
    out = out.slice(0, Math.max(0, budget)) + TRUNCATION_SUFFIX;
  }

  return out;
}

/**
 * Construye el bloque de system prompt que le enseña al LLM qué tools MCP
 * hay disponibles ahora mismo y el formato exacto para usarlas. Se limita
 * a 40 tools para no inflar el prompt si hay muchos servidores conectados.
 */
function buildMCPCatalogPrompt(mcpTools) {
  const lines = mcpTools.slice(0, MCP_CATALOG_LIMIT).map((t) => {
    const desc = (t.description || '').replace(/\s+/g, ' ').slice(0, 100);
    return `  - SERVIDOR=${t.server} | HERRAMIENTA=${t.tool}${desc ? ' — ' + desc : ''}`;
  });

  return (
    '\n\n# HERRAMIENTAS MCP DISPONIBLES\n' +
    'Tienes acceso a estas herramientas de servidores MCP conectados. ' +
    'SOLO debes usarlas si el comando que necesitas NO se puede ejecutar con OpenClaw ' +
    '(Ejecutar: <comando>). Para listar archivos, leer archivos, o escribir archivos ' +
    'usa SIEMPRE OpenClaw (Ejecutar: ls <ruta>, Ejecutar: cat <archivo>, etc.).\n\n' +
    'Herramientas disponibles (copia EXACTAMENTE el SERVIDOR y HERRAMIENTA de esta lista):\n' +
    lines.join('\n') +
    '\n\n' +
    'Para usar una herramienta MCP, responde con este formato EXACTO (sin comillas alrededor de SERVIDOR y HERRAMIENTA):\n' +
    '```action\n' +
    'ACCIÓN: mcp_call | SERVIDOR: filesystem | HERRAMIENTA: list_directory | PARAMS: {"path": "/ruta"}\n' +
    '```\n' +
    'Atajo equivalente con el nombre completo servidor.herramienta (ARCHIVO→path, CONTENIDO→content, etc.):\n' +
    '```action\n' +
    'MCP_TOOL: filesystem.write_file | ARCHIVO: /ruta/archivo.txt\n' +
    'CONTENIDO: contenido del archivo\n' +
    '```\n' +
    'El SERVIDOR y HERRAMIENTA deben coincidir EXACTAMENTE con la lista de arriba, incluyendo mayúsculas. ' +
    'PARAMS debe ser JSON válido en una sola línea. ' +
    'El sistema pedirá confirmación al usuario antes de ejecutar cualquier herramienta MCP.'
  );
}

module.exports = {
  buildContext,
  buildMCPCatalogPrompt,
  buildWorkspaceStackSection,
  CODE_VERACITY_RULE,
  truncateSystemPrompt,
  fuseTaskIntent,
  _prevTurnContext,
};
