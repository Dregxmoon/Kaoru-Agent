// @ts-nocheck
const logger = require('../observability/Logger.js');
// context.js — construcción del context para el LLM (buildContext): ensambla
// el system prompt desde BehaviorModel, IntentDetector, TaskDetector,
// GroundingEngine, reglas del proyecto, herramientas, skills y modos
// (chat/plan/execute/agent), con truncado inteligente por secciones.

const LLMProvider = require('../llm/LLMProvider.js');
const { BehaviorModel } = require('../behavior/BehaviorModel.js');
const { buildRulesSection } = require('../rules/ProjectRules.js');
const { resolveToolset } = require('../task/ToolResolver.js');
const { getProjectCWD } = require('../planner/Planner.js');
const { buildGestureSection } = require('../behavior/GestureVocabulary.js');
const { readGesturesConfig } = require('./config.js');

const state = require('./state.js');

// FIX: presupuesto de tokens del system prompt COMPLETO — antes vivía
// dentro de GroqSerializer.js y se aplicaba antes de pegar BehaviorModel,
// las reglas de OpenClaw y el catálogo MCP. Ahora se aplica aquí, al
// final de buildContext(), sobre el prompt ya ensamblado del todo.
const MAX_SYSTEM_CHARS = 14_000; // ~3.5k tokens — conservador pero amplio
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
      } catch (_) { logger.debug('context', 'package.json corrupto o no parseable'); }
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
      } catch (_) { logger.debug('context', 'escaneo de tsconfig.json falló'); }
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
    } catch (_) { logger.debug('context', 'readdir de cwd falló'); }
    const items = entries
      .filter((e) => !e.startsWith('.') && e !== 'node_modules' && e !== 'dist')
      .slice(0, WORKSPACE_STACK_MAX_ENTRIES);
    if (items.length > 0) lines.push(`- Raíz: ${items.join('  ')}`);

    // Rama git: lectura directa de .git/HEAD (sin invocar `git`).
    try {
      const head = fs.readFileSync(path.join(cwd, '.git', 'HEAD'), 'utf-8').trim();
      const m = head.match(/^ref:\s*refs\/heads\/(.+)$/);
      if (m) lines.push(`- Rama git: ${m[1]}`);
    } catch (_) { logger.debug('context', 'lectura de .git/HEAD falló'); }

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

// ── Context ───────────────────────────────────────────────────────────────────

async function buildContext(sessionHistory, activeProvider, options = {}) {
  const provider = activeProvider || LLMProvider.getActiveProvider() || 'groq';
  const mode = options.mode || 'chat'; // 'plan' | 'execute' | 'chat'
  const approvedPlan = options.plan || null;

  const lastUserMsg = [...sessionHistory].reverse().find((m) => m.role === 'user');
  const userText = lastUserMsg?.content || '';

  const osCtx = state.osSensor?.getCurrentContext() ?? null;

  // BehaviorModel
  let behaviorCtx = null;
  if (state.behavior) {
    try {
      // Get adaptation profile from evolutionary memory
      let adaptationProfile = null;
      if (state.graph && typeof state.graph.getAdaptiveEngine === 'function') {
        try {
          const adaptiveEngine = state.graph.getAdaptiveEngine();
          if (adaptiveEngine) {
            adaptationProfile = adaptiveEngine.buildAdaptationProfile();
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

      // Get enforcement rules from PromptEnforcer
      let enforcementRules = null;
      if (state.graph && typeof state.graph.getPromptEnforcer === 'function') {
        try {
          const enforcer = state.graph.getPromptEnforcer();
          if (enforcer) {
            enforcementRules = enforcer.enforce(emotionalCtx, null, null);
          }
        } catch (e) {
          logger.debug('context', '[core] error getting enforcement rules:', e.message);
        }
      }

      behaviorCtx = state.behavior.evaluate(userText, osCtx, sessionHistory, adaptationProfile, emotionalCtx);
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
    });
  } else {
    const Fallback = require('../llm/GroundingMinimo.js');
    result = Fallback.buildContext(sessionHistory);
  }

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
    resolvedTools = await resolveToolset({
      userMessage: userText,
      domain: taskIntent?.domain || null,
      toolRegistry: state.toolRegistry,
      skillManager: state.skillManager || null,
      mcpManager: state.mcp || null,
      db: state.graph && !state.graph.usingFallback && state.graph._db ? state.graph._db : null,
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

  // ── Fase 3 ítem 2: lo aprendido (chat) ────────────────────────────────────
  // Se anexa al final (lo MENOS importante) para que el truncado inteligente
  // lo elimine primero bajo presión de presupuesto, sin tocar el resto.
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
 *   - tailSections: bloques opcionales añadidos al FINAL del ensamblado (modo
 *     agent: skills → recall de memoria → catálogo → loop). Se eliminan desde
 *     el inicio de su encabezado hasta el final del prompt, de menor a mayor
 *     importancia, antes de tocar las secciones del prompt base.
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

  // 1) Bloques tail del modo agent: se quitan desde su encabezado hasta el
  //    final del prompt, de menor a mayor importancia. Son bloques añadidos
  //    después del ensamblado base y NO están delimitados por `---`, así que
  //    el corte es por línea de encabezado (skills → recall → catálogo → loop).
  for (const section of opts.tailSections || []) {
    if (out.length <= max) break;
    const markerIdx = out.indexOf(section.marker);
    if (markerIdx === -1) continue;
    const lineStart = out.lastIndexOf('\n', markerIdx - 1) + 1;
    const removed = out.slice(lineStart);
    out = out.slice(0, lineStart);
    logger.info('context', `[core] sección "${section.name}" eliminada (${removed.length} chars)`);
  }

  // 2) Secciones `---`-delimitadas del prompt base, de menor a mayor
  //    importancia: impresiones → MCP → OpenClaw → episodios → memoria → OS →
  //    comportamiento → tools intent → identidad. Las impresiones (modelo
  //    inferido del usuario, F3.3) son la sección NO crítica por excelencia:
  //    se recortan PRIMERO, antes que la identidad (critical, nunca se toca).
  const sectionMarkers = [
    { name: 'Impresiones', marker: '## Impresiones (no confirmadas', keepIf: null },
    { name: 'Adaptación', marker: '## Adaptación al usuario', keepIf: null },
    { name: 'MCP', marker: '# HERRAMIENTAS MCP', keepIf: null },
    { name: 'OpenClaw', marker: '# HERRAMIENTAS DISPONIBLES', keepIf: null },
    { name: 'Plan', marker: '# MODO PLAN', keepIf: null },
    { name: 'Execute', marker: '# MODO EJECUCIÓN', keepIf: null },
    { name: 'Episodios', marker: '## Episodios recientes', keepIf: null },
    { name: 'Memoria', marker: '## Lo que sé del usuario', keepIf: null },
    { name: 'OS', marker: '## Contexto actual', keepIf: null },
    { name: 'Behavior', marker: '# COMPORTAMIENTO ESTE TURNO', keepIf: null },
    { name: 'Intent', marker: '## INTENCIÓN DE HERRAMIENTA', keepIf: null },
  ];
  for (const section of sectionMarkers) {
    if (out.length <= max) break;
    const markerIdx = out.indexOf(section.marker);
    if (markerIdx === -1) continue;
    // Encontrar el inicio de la sección (línea anterior ---\n\n o principio)
    const sectionStart = out.lastIndexOf('\n\n---\n\n', markerIdx);
    const from = sectionStart >= 0 ? sectionStart + 6 : markerIdx;
    // Encontrar el fin (siguiente --- o fin del string)
    const remaining = out.slice(from + 1);
    const nextSep = remaining.indexOf('\n\n---\n\n');
    const sectionEnd = nextSep >= 0 ? from + 1 + nextSep : out.length;
    const sectionText = out.slice(from, sectionEnd);
    out = out.slice(0, from) + out.slice(sectionEnd);
    logger.info(
      'context',
      `[core] sección "${section.name}" eliminada (${sectionText.length} chars)`
    );
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
};
