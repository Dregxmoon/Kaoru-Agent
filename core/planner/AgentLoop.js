// @ts-nocheck
'use strict';
const logger = require('../observability/Logger.js');

const path = require('path');
const fs = require('fs');
const { getOpenClawBridge } = require('./OpenClawBridge.js');
const { getStructuredActionParser } = require('./StructuredActionParser.js');
const { truncateSystemPrompt } = require('../core/context.js');
const AP = require('./ActionParser.js');
const LLMProvider = require('../llm/LLMProvider.js');
const { getToolRegistry } = require('../task/ToolRegistry.js');
const { getGitManager } = require('../git/GitManager.js');
const { WorkspaceCheckpoint, MUTATOR_TOOLS } = require('../git/WorkspaceCheckpoint.js');
const { getGitHubManager } = require('../github/GitHubManager.js');
const { RunMetrics } = require('./run-metrics.js');
const { getMoodEngine } = require('../identity/MoodEngine.js');
const { runVerifyPlan, buildVerifyFailureNotice } = require('./verify-runner.js');
const {
  collectEditedFiles,
  analyzeSubagentReport,
  formatSubagentDiscrepancy,
} = require('./subagent-report.js');

const VALID_MODES = new Set(['smart', 'fast', 'task', 'conversational']);

// Tools LSP que se despachan al LSPManager (no al puente OpenClaw).
const LSP_TOOLS = new Set([
  'get_diagnostics',
  'go_to_definition',
  'find_references',
  'get_symbols',
  'hover',
  'rename',
  'code_actions',
]);

// Tools Git nativas (§10) que se despachan al GitManager.
const GIT_TOOLS = new Set([
  'git_status',
  'git_diff',
  'git_log',
  'git_branch',
  'git_add',
  'git_commit',
  'git_stash',
  'git_merge',
  'git_rebase',
  'git_push',
]);

// Tools GitHub nativas (§10) que se despachan al GitHubManager.
const GITHUB_TOOLS = new Set([
  'github_repo_info',
  'github_issue_list',
  'github_issue_create',
  'github_issue_comment',
  'github_issue_close',
  'github_pr_list',
  'github_pr_create',
  'github_pr_review',
  'github_actions_status',
]);

// Tool de subagentes (§11): se despacha en proceso lanzando un AgentLoop anidado.
const SUBAGENT_TOOLS = new Set(['subagent', 'task']);

// Alias legacy → tool canónica de OpenClaw para TOOL-CALLS NATIVOS (formato
// JSON de function-calling). El parser estructurado ya normaliza estos nombres
// en el camino textual (StructuredActionParser.ACTION_TO_TOOL), pero los
// tool-calls nativos del LLM llegan con el nombre crudo — sin esto, Groq y
// otros modelos que emiten "run_command" revientan con "Herramienta
// desconocida" y el run termina en "El modelo no respondió".
const NATIVE_TOOL_ALIASES = {
  run_command: 'exec',
  run_script: 'exec',
  git_action: 'exec',
  install_package: 'exec',
  delete_file: 'exec',
  create_directory: 'exec',
  list_directory: 'exec',
  read_file: 'read',
  run_code: 'code_execution',
  fetch_web: 'webfetch',
  websearch: 'web_search',
  navigate_browser: 'browser',
  browser_action: 'browser',
  mcp_call: 'mcp',
  plugin_call: 'plugin',
  // create_file/edit_file NO van aquí: el bloque LEGACY_TO_TOOL más abajo las
  // normaliza con lógica extra (instrucción → contenido / resolución a diff).
};

function _canonicalToolName(tool) {
  return NATIVE_TOOL_ALIASES[tool] || tool;
}

// ── Anti-repetición (Fase 2) ─────────────────────────────────────────────────
// Un fallo mecánico real observado en producción: el mismo `Write` contra un
// DIRECTORIO (EISDIR) se repitió 3 veces seguidas, quemando iteraciones sin
// corregir nada. La causa: el loop reintroduce el error al LLM, pero nada
// impide que emita la MISMA llamada exacta de nuevo. Aquí se registran las
// llamadas ejecutadas por run (tool + hash de params) y, si una llamada que YA
// falló vuelve a pedirse idéntica, se SALTA y se inyecta un aviso al LLM para
// que cambie de estrategia. El dedupe es estricto: solo salta COPIA IDÉNTICA
// fallida; una variante (otro path, otra flag) no se ve afectada.

/** Hash FNV-1a de 32bits — estable y sin deps para claves de params. */
function _fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** Clave estable de una llamada: `tool#hash(params)`. */
function _toolCallKey(tool, params) {
  let json;
  try {
    json = JSON.stringify(params || {});
  } catch {
    json = String(params);
  }
  return `${tool}#${_fnv1a(json)}`;
}

/** Límite de llamadas registradas por run (FFO). */
const RECENT_TOOL_CALLS_MAX = 30;

/** Umbral de "mismo tool sin progreso": N llamadas consecutivas del mismo tool
 *  sin que ningún resultado marque avance (configurable vía opts). */
const STUCK_TOOL_THRESHOLD = 4;

/**
 * ¿Un resultado de herramienta marca progreso? Sí si terminó ok:true o si el
 * meta reporta un cambio real en el filesystem/estado (p.ej. write/edit con
 * changed:true). Un ok:false sin cambio real NO cuenta como progreso.
 */
function _marksProgress(result) {
  if (!result) return false;
  if (result.ok) return true;
  return Boolean(
    result.meta && (result.meta.changed || result.meta.created || result.meta.written)
  );
}

/**
 * Detecta "mismo tool N veces consecutivas sin progreso": recorre `recent`
 * desde el final y cuenta las entradas consecutivas del MISMO tool que no
 * marcaron progreso. Devuelve { attempts } si hay >= threshold; si no, null.
 * A diferencia de _findRepeatedFailure (copia EXACTA tool+params que falló),
 * esto detecta el estancamiento aunque los params varíen entre intentos.
 */
function _findStuckTool(action, recent, threshold) {
  if (!action || typeof action.tool !== 'string' || !(threshold >= 2)) return null;
  let count = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const c = recent[i];
    if (!c || c.tool !== action.tool) break;
    if (c.progress) break;
    count++;
  }
  if (count < threshold) return null;
  return { attempts: count };
}

/**
 * Si una llamada idéntica YA falló antes en este run, devuelve
 * { attempts, error }; si no, null (se puede ejecutar).
 * @param {{ tool: string, params?: object }} action
 * @param {Array<{ key: string, ok: boolean, error: string | null }>} recent
 */
function _findRepeatedFailure(action, recent) {
  const key = _toolCallKey(action.tool, action.params);
  let attempts = 0;
  let firstError = null;
  for (const c of recent) {
    if (c.key !== key) continue;
    attempts++;
    if (!c.ok && !firstError) firstError = c.error || 'error desconocido';
  }
  if (attempts === 0 || !firstError) return null;
  return { attempts, error: firstError };
}

/** Hint barato por código/patrón de error para guiar la próxima jugada. */
function _hintForToolError(error) {
  const e = String(error || '');
  if (/EISDIR|is a directory|\bESUCCESS\b/.test(e) && !/file/i.test(e)) {
    return 'El path apunta a un DIRECTORIO (EISDIR): la tool espera una ruta de ARCHIVO.';
  }
  if (/execvp.*No such file|not found/.test(e)) {
    return 'El ejecutable no existe en el sandbox. Usa rutas absolutas o un binario disponible (node por ejemplo).';
  }
  if (/permission|EACCES|EACCES|denied/.test(e)) {
    return 'Sin permisos para esa operación. Busca otra ruta o estrategia.';
  }
  if (/ENOENT/.test(e)) {
    return 'No existe el archivo/ruta (ENOENT). Verificá con ls/glob antes de escribir.';
  }
  return '';
}

// Máxima profundidad de subagentes anidados (previene recursión infinita).
const MAX_SUBAGENT_DEPTH = 2;

const SUBAGENT_SYSTEM = `Eres un subagente especializado que recibe una sub-tarea concreta y autocontenida.
Trabaja de forma autónoma y enfócate SOLO en la sub-tarea asignada. Usa las herramientas disponibles
(grep, glob, read, exec, web_search, browser) para investigar o modificar archivos si hace falta.

Al terminar, responde con un resumen CONCISO del resultado (máximo 200 palabras): qué hiciste, qué
encontraste o qué cambiaste, y cualquier detalle que el agente principal deba conocer. No hagas
preguntas ni pidas aprobación: tu única salida es el resumen final.`;

// Tools que mutan archivos: tras su ejecución se pide feedback LSP al server.
const EDIT_TOOLS = new Set(['write', 'edit', 'apply_patch', 'create_file', 'edit_file']);

const MAX_ITERATIONS = 25;
const RESULT_TRUNCATE_LIMIT = 800;

// Self-critique (opcional, opts.selfCritique): al terminar el loop con una
// respuesta de texto, un paso extra le pide al LLM comparar el resultado
// contra la INTENCIÓN original del usuario (no solo criterios técnicos como
// tests/lint). Si el veredicto es INCOMPLETA y quedan iteraciones, el
// feedback vuelve al loop para corregir/continuar. Acotado para no abrir un
// bucle infinito.
const SELF_CRITIQUE_MAX_ROUNDS = 2;

// Reflexión intermedia (opcional, opts.reflection): cuando en una iteración
// una herramienta falla y ya se acumularon varias fallas en el run, el loop se
// DETIENE a evaluar si el plan sigue siendo válido ("¿esto funcionó, debo
// cambiar de plan?") con una llamada LLM dedicada y estructurada — en vez de
// seguir martillando el error dentro del mismo bucle de tool-calling. El
// veredicto puede pedir replanear (el feedback vuelve al LLM) o abandonar.
// Determinista en el disparo y acotado para no abrir un bucle infinito.
const REFLECTION_MAX_ROUNDS = 2;
// Fallas de herramientas acumuladas en el run que disparan la primera
// reflexión (falta de "ajustar pronto" sin gastar llamadas en cada fallo).
const REFLECTION_MIN_FAILURES = 2;

// Bloques que AgentLoop añade al prompt DESPUÉS del ensamblado base. El
// truncado final (truncateSystemPrompt) los elimina desde el inicio de su
// encabezado hasta el final, de menor a mayor importancia, para respetar el
// presupuesto contando TODO lo ensamblado (no solo el base).
const TAIL_SECTIONS = [
  { name: 'Lo aprendido (feedback)', marker: '# LO APRENDIDO (FEEDBACK)' },
  { name: 'Skills', marker: '---\n\n**Skills activas' },
  { name: 'Intenciones pendientes', marker: '# INTENCIONES ACTIVAS PENDIENTES' },
  { name: 'Memoria recall', marker: '# CONTEXTO RELEVANTE DE MEMORIA' },
  { name: 'Catálogo de tools', marker: '# HERRAMIENTAS DISPONIBLES' },
  { name: 'Loop agente', marker: '# MODO AGENTE' },
];

// Presupuesto del system prompt del MODO AGENTE. El prompt base de buildContext
// (identidad + comportamiento + contexto OS/memoria/episodios + MCP) ya ronda
// los ~10.5K chars; sumado a AGENT_LOOP_SYSTEM (~3.7K) + catálogo de tools
// (~8.6K) supera con holgura los 14K del presupuesto de chat, y el truncado
// eliminaba SIEMPRE "Loop agente" y "Catálogo de tools" → el modelo no sabía
// que podía usar herramientas y respondía sin ejecutar nada (tool_calls_total:
// 0 en producción). El modo agent tiene presupuesto propio y más amplio; chat/
// plan/execute conservan MAX_SYSTEM_CHARS (14K) intacto.
const AGENT_MAX_SYSTEM_CHARS = 30_000;

// G.1: compactación de contexto. Cuando la historia de iteraciones crece, los
// turnos viejos se condensan en un resumen determinista (no se re-envía todo
// el historial crudo a cada turno): el objetivo + lista de acciones ejecutadas.
const COMPACT_MIN_TURNS = 14; // tuplas de historial que disparan compactación
const COMPACT_KEEP_TAIL = 8; // turnos recientes que se conservan íntegros

/**
 * Fase 3, ítem 1: sección de intenciones activas pendientes para el prompt.
 * Las filas del IntentionsStore traen `steps` como JSON string; aquí se
 * normalizan. Devuelve null si no hay intenciones (el caller omite el bloque).
 * @param {Array<object>} intentions
 * @returns {string | null}
 */
function buildActiveIntentionsSection(intentions) {
  if (!Array.isArray(intentions) || intentions.length === 0) return null;
  const lines = ['# INTENCIONES ACTIVAS PENDIENTES', ''];
  lines.push(
    'Hay metas de antes que quedaron en vuelo. Retómalas o coordínalas con la petición actual:'
  );
  for (const it of intentions) {
    let steps = [];
    if (typeof it.steps === 'string') {
      try {
        steps = JSON.parse(it.steps);
      } catch (_) {}
    } else if (Array.isArray(it.steps)) {
      steps = it.steps;
    }
    const stepNames = steps
      .map((s) => (typeof s === 'string' ? s : s && (s.description || s.label)))
      .filter(Boolean)
      .slice(0, 5);
    const progress = it.last_progress ? ` Progreso: ${it.last_progress}` : '';
    const stepLine = stepNames.length ? ` Pasos: ${stepNames.join(' → ')}` : '';
    lines.push(`- Meta: ${it.goal}${progress}${stepLine}`);
  }
  return lines.join('\n');
}

const AGENT_LOOP_SYSTEM = `
# MODO AGENTE — BUCLE DE EJECUCIÓN

Estás operando en un bucle agente: puedes solicitar una herramienta por vez
y recibirás el resultado real antes de decidir el siguiente paso.

## Cómo solicitar una herramienta

Usa este formato EXACTO dentro de tu respuesta:

\`\`\`action
ACCIÓN: <nombre> | ARCHIVO/COMANDO/QUERY/URL: <valor>
\`\`\`

Para write/edit incluye el contenido completo en CONTENIDO: (puede ser multilínea).
Ejemplo:
\`\`\`action
ACCIÓN: write | ARCHIVO: docs/README.md
CONTENIDO: # Demo

Todo el contenido del archivo, en varias líneas si hace falta.
\`\`\`

Ejemplos:
\`\`\`action
ACCIÓN: read_file | ARCHIVO: src/main.js
\`\`\`

\`\`\`action
ACCIÓN: run_command | COMANDO: git status
\`\`\`

\`\`\`action
ACCIÓN: web_search | QUERY: cómo instalar node
\`\`\`

\`\`\`action
ACCIÓN: mcp_call | SERVIDOR: filesystem | HERRAMIENTA: list_directory | PARAMS: {"path": "."}
\`\`\`

Para herramientas MCP también puedes usar el atajo MCP_TOOL con el nombre
completo \`servidor.herramienta\` del catálogo. Los campos ARCHIVO/RUTA/CONTENIDO
se pasan como argumentos de la tool:
\`\`\`action
MCP_TOOL: filesystem.write_file | ARCHIVO: docs/nota.md
CONTENIDO: Contenido del archivo.
\`\`\`

Puedes incluir el bloque \`\`\`action en cualquier parte de tu respuesta.
El resto del texto se mostrará al usuario.

## Reglas

1. SOLICITA UNA HERRAMIENTA POR VEZ. Espera el resultado antes de pedir la siguiente.
2. NO inventes resultados de comandos ni herramientas. Todo lo que ejecutes
   devolverá un resultado real que verás en el siguiente turno.
3. Si la tarea está completa o no necesitas más herramientas, responde
   normalmente sin el bloque \`\`\`action — el bucle terminará.
4. Si una herramienta falla, decide si puedes continuar con otra estrategia
   o si la tarea no se puede completar y responde informando el error.
5. NUNCA ejecutes acciones destructivas sin antes informar al usuario qué
   vas a hacer y por qué.
6. USA HERRAMIENTAS SOLO CUANDO LA TAREA LO REQUIERA. Saludos, preguntas
   sobre ti mismo ("quién eres", tu identidad, tu personalidad), preguntas de
   conversación y dudas que ya puedes responder con lo que sabes se contestan
   DIRECTAMENTE, sin llamar ninguna herramienta. browser y web_search son
   SOLO para información externa actual que no puedes conocer (noticias,
   datos en vivo, páginas web). NO busques en internet cosas que ya sabes,
   como tu propia identidad — eso desperdicia recursos y el rate-limit.
7. DETENTE EN CUANTO LA TAREA PEDIDA ESTÉ COMPLETA. Si la acción que pidió
   el usuario terminó con éxito (p. ej. un push a git que confirma éxito, o
   un archivo escrito correctamente), tu turno TERMINA: responde confirmando
   y NO ejecutes más herramientas. No sigas "buscando más acciones", no
   repitas trabajo ya hecho y no hagas mejoras, refactors ni pasos extra que
   no te pidieron.
8. NO TOQUES ARCHIVOS QUE NO SON PARTE DE LA TAREA. Si el usuario pidió, por
   ejemplo, subir cambios a git, no edites código ni archivos del repo. Si en
   el camino ves un problema en algo no relacionado, menciónalo en la
   respuesta, pero NO lo arregles por tu cuenta — un edit no solicitado
   cuenta como salirse del alcance y consume llamadas innecesariamente.
9. MODIFICAR PARTES DE UN ARCHIVO EXISTENTE = edit, NO write. Cuando el
   archivo ya existe y solo hay que cambiar una o unas pocas líneas
   (color, texto, una función), usa \`\`\`action edit con old_text (fragmento
   EXACTO que ya está en el archivo) y new_text (el reemplazo). write es para
   archivos NUEVOS o para reescribir el archivo ENTERO cuando el cambio
   afecta la mayoría del contenido. Antes de decidir, lee el archivo con
   read_file si no conoces su contenido exacto.
`;

const MODE_ALIAS = {
  task: 'smart',
  conversational: 'fast',
};

class AgentLoop {
  constructor(opts = {}) {
    this.maxIterations = opts.maxIterations || MAX_ITERATIONS;
    this._bridge = opts.bridge || getOpenClawBridge();
    this._toolRegistry = getToolRegistry();
    this._llm = opts.llm || null;
    this._lsp = opts.lsp || null;
    this._git = opts.git || getGitManager();
    this._github = opts.github || getGitHubManager();
    this._graph = opts.graph || null;
    this._mcp = opts.mcpManager || null;
    this._compactionPersisted = false;
    this._checkpoint = opts.checkpoint || null;
    this._telemetry = opts.telemetry || null;
    const rawMode = opts.mode || 'smart';
    if (!VALID_MODES.has(rawMode)) {
      logger.warn('AgentLoop', `[agent-loop] modo "${rawMode}" no reconocido, usando "smart"`);
      this._mode = 'smart';
    } else {
      this._mode = MODE_ALIAS[rawMode] || rawMode;
    }
  }

  /**
   * Shape estándar de un resultado de tool ({ok, result, error, tool, elapsed}).
   * Devuelve { okShape, failShape } ligados a la tool y al momento de inicio.
   * @param {object} action
   * @param {string} action.tool
   * @param {number} t0
   */
  _toolShapes(action, t0) {
    const okShape = (result) => ({
      ok: true,
      result,
      error: null,
      tool: action.tool,
      elapsed: Date.now() - t0,
    });
    const failShape = (error) => ({
      ok: false,
      result: null,
      error,
      tool: action.tool,
      elapsed: Date.now() - t0,
    });
    return { okShape, failShape };
  }

  _getLLM() {
    if (this._llm) return this._llm;
    if (!this._llmRef) {
      this._llmRef = LLMProvider.completeTask.bind(LLMProvider);
    }
    return this._llmRef;
  }

  /**
   * Punto de entrada del loop. Envuelve la ejecución con el WorkspaceCheckpoint:
   * la línea base se captura antes de la primera mutación (dentro del loop) y el
   * checkpoint se cierra (finalize) SIEMPRE al terminar, pase lo que pase.
   * @returns {Promise<object>}
   */
  async run(userMessage, systemPrompt, messages, opts = {}) {
    const checkpoint = this._checkpoint || new WorkspaceCheckpoint({ cwd: AP.PROJECT_CWD });
    this._activeCheckpoint = checkpoint;
    const t0 = Date.now();
    let result;
    try {
      result = await this._runInternal(userMessage, systemPrompt, messages, opts);
      return result;
    } finally {
      try {
        await checkpoint.finalize();
      } catch (e) {
        logger.warn('AgentLoop', `[checkpoint] finalize falló: ${e.message}`);
      }
      // Instrumentación por-run: emite métricas de ejecución SIEMPRE (éxito,
      // error o cancelación), sin tocar el contrato del valor de retorno
      // (se agrega solo el campo extra `metrics` al resultado).
      this._emitRunMetrics({ result, t0 });
    }
  }

  /**
   * Instrumentación por-run (Fase de métricas): construye el objeto de métricas
   * de ejecución y lo persiste vía la telemetría local (si está disponible).
   * Nunca lanza: un fallo aquí no puede romper el run ya terminado.
   * No altera el contrato de run(): solo agrega el campo extra `metrics`.
   *
   * @param {{ result?: object, t0: number }} ctx
   */
  _emitRunMetrics({ result, t0 }) {
    this._metrics.emit({ result, t0, telemetry: this._telemetry });
  }

  async _runInternal(userMessage, systemPrompt, messages, opts = {}) {
    const taskIntent = opts.taskIntent || null;
    this._currentTaskIntent = taskIntent;
    const domain = taskIntent?.domain || null;
    const llm = opts.llm || this._llm || this._getLLM();
    const parser = getStructuredActionParser(AP.PROJECT_CWD);
    // Streaming: opts.onToken(text) recibe los fragmentos del LLM en vivo
    // para pintarlos en el chat mientras se generan (patrón opencode).
    const onToken = typeof opts.onToken === 'function' ? opts.onToken : null;
    const signal = opts.signal || null;
    this._signal = signal;
    // Instrumentación por-run: acumuladores que se emiten al terminar (ver
    // _emitRunMetrics en run()). Por-instancia: los subagentes son otro
    // AgentLoop, así sus métricas no contaminan las del run padre.
    this._metrics = new RunMetrics();
    // Verificación forzada y reflexión intermedia: se capturan para que los
    // runs anidados (subagentes) hereden la misma política.
    this._verifyPlan = opts.verify || null;
    this._reflectionOpt = opts.reflection || null;
    const llmOpts = onToken ? { onToken } : {};
    if (signal) llmOpts.signal = signal;

    // ── Tool resolution (Fase 5): Skill > MCP > OpenClaw ────────────
    let tools = opts.tools || null;
    let toolCatalog = this._toolRegistry.serializeToPrompt(domain);
    const toolResolver = opts.toolResolver || null;

    if (toolResolver) {
      try {
        const resolved = await toolResolver.resolveToolset({
          userMessage,
          domain: taskIntent,
          toolRegistry: this._toolRegistry,
          skillManager: opts.skillManager || null,
          mcpManager: opts.mcpManager || null,
          db: opts.skillDb || null,
          matchedSkills: opts.matchedSkills || null,
        });
        if (resolved.nativeToolSchemas) tools = resolved.nativeToolSchemas;
        if (resolved.promptCatalog) toolCatalog = resolved.promptCatalog;
        if (resolved.excluded.length > 0) {
          logger.info(
            'AgentLoop',
            `[agent-loop] precedencia: ${resolved.precedence}, herramientas excluidas: ${resolved.excluded.map((e) => `${e.source}/${e.tool}`).join(', ')}`
          );
        }
        logger.info(
          'AgentLoop',
          `[agent-loop] precedencia de herramientas: ${resolved.precedence}${resolved.matchedSkills.length > 0 ? ` (skills: ${resolved.matchedSkills.map((s) => s.name).join(', ')})` : ''}`
        );
      } catch (e) {
        logger.warn('AgentLoop', `[agent-loop] error en resolución de herramientas: ${e.message}`);
      }
    }

    let agentPrompt =
      systemPrompt.replace(/\n+$/, '') +
      '\n\n' +
      AGENT_LOOP_SYSTEM.trim() +
      (toolCatalog ? '\n\n' + toolCatalog : '');

    // ── Memoria semántica (§12): contexto relevante de sesiones anteriores ──
    // Se inyecta al prompt (no a la historia) para reconstruir contexto en
    // tareas largas o retomadas sin inflar el tamaño del mensaje.
    if (this._graph) {
      try {
        const memoryContext = await this._recallMemory(userMessage);
        if (memoryContext) {
          agentPrompt += '\n\n' + memoryContext;
        }
      } catch (e) {
        logger.warn('AgentLoop', `[agent-loop] recall de memoria falló: ${e.message}`);
      }
    }

    // ── Skill injection ────────────────────────────────────────────────
    const skillManager = opts.skillManager || null;
    if (skillManager && typeof skillManager.buildInjection === 'function') {
      try {
        const skillBlock = await skillManager.buildInjection(userMessage, opts.skillDb || null);
        if (skillBlock) {
          agentPrompt = agentPrompt + '\n\n' + skillBlock;
          logger.info('AgentLoop', `[agent-loop] skills activas inyectadas en el prompt`);
        }
      } catch (e) {
        logger.warn(`AgentLoop`, `[agent-loop] error inyectando skills: ${e.message}`);
      }
    }

    // ── Fase 3 ítem 1: intenciones activas pendientes (metas persistentes) ──
    // El stack de metas en vuelo sobrevive al reinicio (IntentionsStore) y se
    // re-inyecta aquí para que el agente re-planifique al reanudar la sesión.
    if (opts.activeIntentions && opts.activeIntentions.length) {
      try {
        const intBlock = buildActiveIntentionsSection(opts.activeIntentions);
        if (intBlock) agentPrompt += '\n\n' + intBlock;
      } catch (e) {
        logger.warn(`AgentLoop`, `[agent-loop] error inyectando intenciones: ${e.message}`);
      }
    }

    // ── Fase 3 ítem 2: lo aprendido (feedback de proactividad + outcomes de
    //    tareas). El LearningEngine lo produce; el loop lo anexa como el
    //    bloque MENOS importante (primero en cortarse bajo presupuesto).
    if (typeof opts.learningSection === 'string' && opts.learningSection.trim()) {
      agentPrompt += '\n\n' + opts.learningSection;
    }

    // ── Truncado FINAL tras el ensamblado completo ────────────────────────
    // El presupuesto de MAX_SYSTEM_CHARS debe contar AGENT_LOOP_SYSTEM +
    // catálogo + recall + skills, no solo el systemPrompt base (que en modo
    // agent ya no se trunca en buildContext). Se eliminan bloques COMPLETOS
    // desde el menos importante (skills → recall → catálogo → loop), nunca a
    // mitad de una instrucción.
    agentPrompt = truncateSystemPrompt(agentPrompt, {
      max: AGENT_MAX_SYSTEM_CHARS,
      tailSections: TAIL_SECTIONS,
    });

    const iterationHistory = [...(messages || [])];
    let lastToolResult = null;
    const toolResults = [];
    // Anti-repetición (Fase 2): llamadas ejecutadas en este run (tool + hash de
    // params). Si una llamada idéntica ya falló, se salta y se avisa al LLM.
    const recentToolCalls = [];
    // Anti-estancamiento: N llamadas consecutivas del mismo tool sin progreso.
    // Configurable (opts.stuckToolThreshold), default STUCK_TOOL_THRESHOLD.
    const stuckToolThreshold =
      Number.isInteger(opts.stuckToolThreshold) && opts.stuckToolThreshold >= 2
        ? opts.stuckToolThreshold
        : STUCK_TOOL_THRESHOLD;
    let lastResponseText = null; // guarda último output del LLM para max_iterations
    // Self-critique (opts.selfCritique): cuántas pasadas de crítica se
    // agotaron en este run — acota el bucle de corrección (no infinito).
    let critiqueRounds = 0;
    // Reflexión intermedia (opts.reflection): fallas de herramientas
    // acumuladas en este run y rondas de reflexión agotadas.
    let toolFailures = 0;
    let reflectionRounds = 0;
    let failuresAtLastReflection = 0;

    for (let i = 0; i < this.maxIterations; i++) {
      // Cancelación por el usuario (AbortController): se revisa en cada
      // iteración para romper el bucle sin esperar al siguiente turno del LLM.
      if (signal && signal.aborted) {
        return {
          response: lastResponseText || 'Generación cancelada por el usuario.',
          iterations: i + 1,
          toolResults,
          cancelled: true,
          error: 'cancelled',
        };
      }
      const _itStart = Date.now();
      const currentUserMsg = i === 0 ? userMessage : this._buildToolResultMessage(lastToolResult);

      const llmMessages = this._buildLLMMessages(
        iterationHistory,
        currentUserMsg,
        userMessage,
        toolResults,
        i
      );

      // ── Llamada al LLM: intenta tool-calling nativo primero ────────────
      let responseText = null;
      let toolCalls = null;

      if (tools && llm === this._getLLM()) {
        try {
          const tcResult = await LLMProvider.completeWithTools(
            llmMessages,
            agentPrompt,
            tools,
            this._mode,
            llmOpts
          );
          responseText = tcResult.content;
          toolCalls = tcResult.toolCalls;
        } catch (e) {
          if (e?.code === 'ABORTED' || e?.name === 'AbortError') {
            return {
              response: 'Generación cancelada por el usuario.',
              iterations: i + 1,
              toolResults,
              cancelled: true,
              error: 'cancelled',
            };
          }
          logger.warn(
            'AgentLoop',
            '[agent-loop] tool-calling nativo falló, usando fallback texto:',
            e.message
          );
          try {
            const fallback = await llm(llmMessages, agentPrompt, llmOpts);
            responseText = typeof fallback === 'string' ? fallback : fallback?.content || '';
          } catch (e2) {
            if (e2?.code === 'ABORTED' || e2?.name === 'AbortError') {
              return {
                response: 'Generación cancelada por el usuario.',
                iterations: i + 1,
                toolResults,
                cancelled: true,
                error: 'cancelled',
              };
            }
            return {
              response:
                this._completedSummary(toolResults) +
                `¡No te preocupes, eso es todo! Solo me quedé sin cuota y no pude escribir el resumen final (error en tool-calling y fallback textual: ${e2.message})`,
              iterations: i + 1,
              toolResults,
              error: 'llm_failure',
            };
          }
        }
      } else {
        try {
          const raw = await llm(llmMessages, agentPrompt, llmOpts);
          responseText = typeof raw === 'string' ? raw : raw?.content || '';
        } catch (e) {
          if (e?.code === 'ABORTED' || e?.name === 'AbortError') {
            return {
              response: 'Generación cancelada por el usuario.',
              iterations: i + 1,
              toolResults,
              cancelled: true,
              error: 'cancelled',
            };
          }
          return {
            response:
              this._completedSummary(toolResults) +
              `¡No te preocupes, eso es todo! Solo me quedé sin cuota y no pude escribir el resumen final (error en LLM: ${e.message})`,
            iterations: i + 1,
            toolResults,
            error: 'llm_failure',
          };
        }
      }

      const hasNativeToolCalls = toolCalls && toolCalls.length > 0;
      if (process.env.DEBUG)
        logger.info(
          'AgentLoop',
          `[agent-loop-timing] iter ${i}: LLM ${Date.now() - _itStart}ms, toolCalls=${hasNativeToolCalls ? toolCalls.length : 0}`
        );
      if (!responseText || !responseText.trim()) {
        // Tool-calling nativo devuelve content vacío cuando el modelo SOLO llama
        // una herramienta — no es un "no respondió", hay que ejecutar la llamada.
        if (!hasNativeToolCalls) {
          return {
            response: 'El modelo no respondió.',
            iterations: i + 1,
            toolResults,
            error: 'empty_response',
          };
        }
        responseText = '';
      }

      lastResponseText = responseText;

      // ── Extraer acciones ───────────────────────────────────────────
      let actions = [];
      if (toolCalls && toolCalls.length > 0) {
        actions = toolCalls.map((tc) => ({
          tool: _canonicalToolName(tc.tool),
          params: tc.params,
          description: `${tc.tool}: ${JSON.stringify(tc.params).slice(0, 100)}`,
          source: 'native_tool_call',
        }));
      } else {
        // Contexto = mensaje actual (el prompt original en i=0, el resultado de la
        // herramienta en iteraciones siguientes). Re-usar el prompt original en i>0
        // hace que ActionParser legacy re-detecte el MISMO edit ("edita X") y lo
        // re-ejecute → loop infinito.
        // skipLegacy (ver StructuredActionParser.parse):
        //   - subagentes (reportMode): SIEMPRE — su texto sin bloque de acción es
        //     el resumen final, un reporte, nunca una orden.
        //   - loop principal: cuando el run YA ejecutó al menos una herramienta.
        //     Por diseño del prompt del bucle (regla 3: "responde normalmente sin
        //     el bloque ```action — el bucle terminará"), un texto sin bloque de
        //     acción tras haber trabajado es el CIERRE del run, no una instrucción.
        //     Escanear ese cierre con el parser legacy hace que frases naturales
        //     ("terminé la modificación del archivo X", "Terminé escribiendo el
        //     archivo Y") re-disparen una edición fantasma y se re-ejecute algo
        //     que el LLM nunca pidió. En i=0 (sin tools todavía) el fallback se
        //     conserva: ahí el texto de prosa del LLM SÍ es una posible orden
        //     (modo texto puro).
        actions = parser.parse(responseText, currentUserMsg, taskIntent, {
          skipLegacy: !!opts.reportMode || toolResults.length > 0,
        });
      }

      if (actions.length === 0) {
        // Self-critique (opcional): antes de dar por terminado el run con una
        // respuesta de texto, un paso extra le pide al LLM comparar el
        // resultado contra la INTENCIÓN original del usuario (no solo tests/
        // lint). Si el veredicto es INCOMPLETA, el feedback vuelve al loop
        // para cerrar la brecha. Acotado a SELF_CRITIQUE_MAX_ROUNDS.
        if (opts.selfCritique && critiqueRounds < SELF_CRITIQUE_MAX_ROUNDS) {
          const critique = await this._selfCritique({
            userMessage,
            responseText,
            toolResults,
            llm,
            llmOpts,
            signal,
          });
          if (critique && critique.continue && !(signal && signal.aborted)) {
            critiqueRounds++;
            iterationHistory.push({ role: 'user', content: critique.message });
            logger.info(
              'AgentLoop',
              `[agent-loop] auto-crítica ronda ${critiqueRounds}/${SELF_CRITIQUE_MAX_ROUNDS}: tarea incompleta, continuando`
            );
            continue;
          }
        }

        // ── Verificación forzada (opts.verify) ────────────────────────────
        // El run se cierra AHORA: el LLM no pidió más tools. Si el proyecto
        // define un comando de verificación y hubo una mutación exitosa, se
        // corre antes de devolver. NUNCA bloquea la tarea (los casos de skip
        // no tocan la respuesta) y, si falla tras los intentos acotados, el
        // run termina IGUAL — el resultado queda en `verify` y la respuesta
        // lo dice explícitamente (nunca un cierre silencioso).
        const verify = await this._runVerify(opts.verify, toolResults);
        // En reportMode (subagente) el aviso NO se mete en el texto del reporte:
        // contaminaría el audit de resumen (el comando incluye nombres de
        // archivo). El estado viaja en `result.verify` y el padre decide.
        if (verify && verify.status === 'failed' && !opts.reportMode) {
          responseText += buildVerifyFailureNotice(verify);
        }
        return {
          response: responseText,
          iterations: i + 1,
          toolResults,
          verify,
          error: null,
        };
      }

      // ── 2.2: red de seguridad — acciones no reconocidas ───────────────────
      // Un nombre de tool fuera de ACTION_TO_TOOL no debe descartarse en
      // silencio: se devuelve feedback al LLM (visible en el turno siguiente)
      // para que reformule, y se registra la señal para el usuario. Se procesa
      // DESPUÉS del cierre de `actions.length === 0` para que un bloque con
      // SOLO acciones desconocidas no se trague como "respuesta de texto" y
      // vuelva a iterar con el aviso.
      const unrecognized = actions.filter((a) => a && a.source === 'unrecognized');
      if (unrecognized.length > 0) {
        unrecognized.forEach(() => this._metrics.trackTool('unknown_action'));
        const names = unrecognized.map((u) => `"${u.action}"`).join(', ');
        const feedback =
          `[La acción ${names} no es reconocida por el asistente y no se ejecutó nada. ` +
          `Reformula tu petición con una acción válida, o si no puedes, avísale al usuario.]`;
        iterationHistory.push({ role: 'user', content: feedback });
        logger.warn('AgentLoop', `[agent-loop] acción no reconocida: ${names} — aviso al usuario`);
        actions = actions.filter((a) => a && a.source !== 'unrecognized');
      }

      // Normalizar nombres de tool legacy → modernos
      const LEGACY_TO_TOOL = {
        create_file: 'write',
        edit_file: 'edit',
      };
      for (const a of actions) {
        const modern = LEGACY_TO_TOOL[a.tool];
        if (modern) {
          a.tool = modern;
          if (modern === 'write' && a.params.instruction && !a.params.content) {
            a.params.content = a.params.instruction;
            delete a.params.instruction;
          }
          // edit_file → edit: los parsers legacy emiten la edición como
          // instrucción en lenguaje natural, pero la tool 'edit' exige
          // old_text/new_text exactos. Se guarda la instrucción y se resuelve
          // a un diff exacto con una llamada LLM focalizada antes de ejecutar
          // (ver _executeResolvedEdit). Con native tool calling el modelo ya
          // entrega old_text/new_text por schema, así que esto es solo el
          // fallback para parsers de texto.
          if (
            modern === 'edit' &&
            !a.params.old_text &&
            !a.params.oldString &&
            a.params.instruction
          ) {
            a._needsInstructionResolve = true;
            a._editInstruction = a.params.instruction;
            delete a.params.instruction;
          }
        }
      }

      // ── Ejecutar TODAS las acciones de esta iteración (no solo actions[0]) ──
      // Con native tool calling el modelo suele emitir varias tools en una
      // misma respuesta; antes solo corría la primera y el resto se descartaba.
      iterationHistory.push({ role: 'assistant', content: responseText });
      const resultSummaries = [];

      for (const action of actions) {
        const requiresApproval = AP.isHighImpact(action.tool, action.params);
        // Instrumentación: cada tool solicitada por el agente cuenta (aunque
        // luego se bloquee/deniegue/cancele — igual fue pedida).
        this._metrics.trackTool(action.tool);

        // ── Permisos granulares (allow/ask/deny) ─────────────────────────────
        // Patrón opencode: una regla persistente puede elevar una herramienta
        // de alto impacto a 'allow' (se ejecuta sin preguntar), bloquearla con
        // 'deny', o forzar 'ask'. El default es 'ask' solo para alto impacto.
        const permissionManager = opts.permissionManager || null;
        let permissionAction = requiresApproval ? 'ask' : 'allow';
        if (permissionManager && typeof permissionManager.check === 'function') {
          const targetPath =
            action.params?.path || action.params?.filePath || action.params?.cwd || '';
          const perm = permissionManager.check({
            tool: action.tool,
            path: targetPath,
            defaultAction: requiresApproval ? 'ask' : 'allow',
          });
          permissionAction = perm.action;
          if (process.env.DEBUG && perm.rule) {
            logger.info(
              'AgentLoop',
              `[agent-loop] permiso "${perm.action}" para ${action.tool} (regla: ${perm.rule.id})`
            );
          }
        }

        if (permissionAction === 'deny') {
          iterationHistory.push({
            role: 'user',
            content: `[Herramienta "${action.tool}" bloqueada por política de permisos — continúa sin ella o busca otra estrategia]`,
          });
          lastToolResult = {
            ok: false,
            error: 'bloqueada_por_permiso',
            tool: action.tool,
          };
          continue;
        }

        // ── Hook de plugins: beforeTool ─────────────────────────────────────
        // Los plugins pueden denegar una herramienta devolviendo
        // { deny: true, reason?: string } — se trata como cancelada por el
        // usuario y el loop continúa con otra estrategia.
        const pluginManager = opts.pluginManager || null;
        if (pluginManager && typeof pluginManager.runHook === 'function') {
          let hookOut = null;
          try {
            hookOut = await pluginManager.runHook('beforeTool', {
              tool: action.tool,
              params: action.params,
              requiresApproval,
            });
          } catch (e) {
            logger.warn('AgentLoop', `[agent-loop] hook beforeTool falló: ${e.message}`);
          }
          if (hookOut && hookOut.deny) {
            iterationHistory.push({
              role: 'user',
              content: `[Herramienta "${action.tool}" bloqueada por un plugin: ${hookOut.reason || 'denegada por política'} — continúa sin ella o busca otra estrategia]`,
            });
            lastToolResult = {
              ok: false,
              error: 'bloqueada_por_plugin',
              tool: action.tool,
            };
            continue;
          }
        }

        if (permissionAction === 'ask' && requiresApproval && opts.onApprovalNeeded) {
          const approved = await opts.onApprovalNeeded(action);
          this._metrics.trackApproval(approved);
          if (!approved) {
            iterationHistory.push({
              role: 'user',
              content: `[Herramienta "${action.tool}" cancelada por el usuario — continúa sin ella o busca otra estrategia]`,
            });
            lastToolResult = { ok: false, error: 'cancelada_por_usuario', tool: action.tool };
            continue;
          }
        } else if (requiresApproval && !opts.onApprovalNeeded && permissionAction !== 'allow') {
          iterationHistory.push({
            role: 'user',
            content: `[Herramienta "${action.tool}" requiere aprobación pero no hay handler — BLOQUEADA. Continúa sin ella o informa que no puedes ejecutarla.]`,
          });
          lastToolResult = { ok: false, error: 'sin_handler_aprobacion', tool: action.tool };
          continue;
        }

        // ── Anti-repetición (Fase 2) ─────────────────────────────────────────
        // Caso real de producción: el mismo Write contra un directorio (EISDIR)
        // se repitió 3 veces seguidas quemando iteraciones. Si esta llamada
        // EXACTA (tool + params) ya falló en este run, se salta y se le avisa
        // al LLM para que cambie de estrategia en vez de martillar el error.
        const repeat = _findRepeatedFailure(action, recentToolCalls);
        if (repeat) {
          iterationHistory.push({
            role: 'user',
            content: `[Ya intentaste exactamente ${action.tool} ${repeat.attempts} vez(es) en este run y falló: ${repeat.error}. NO lo repitas — cambia de estrategia (otro path, otra herramienta o pedí más contexto).]`,
          });
          lastToolResult = {
            ok: false,
            error: `repetida: ${repeat.error}`,
            tool: action.tool,
          };
          continue;
        }

        // ── Anti-estancamiento: mismo tool N veces sin progreso ─────────────
        // Complementa al dedupe exacto de arriba: este NO compara params, solo
        // cuenta cuántas llamadas consecutivas del mismo tool no produjeron
        // ningún avance real (ok:true o cambio en el estado). NO corta la
        // ejecución — le avisa al LLM para que decida, igual que el dedupe.
        const stuck = _findStuckTool(action, recentToolCalls, stuckToolThreshold);
        if (stuck) {
          iterationHistory.push({
            role: 'user',
            content: `[Llevás ${stuck.attempts} intentos con ${action.tool} sin avanzar (ningún resultado marcó progreso). Cambiá de estrategia: otro path, otra herramienta o pedí más contexto antes de volver a intentar.]`,
          });
        }

        // ── Checkpoint de workspace (revertir tarea) ─────────────────────────
        // Se captura la línea base ANTES de la primera mutación real (write/edit/
        // apply_patch). Nunca bloquea la ejecución: si falla, solo se loguea y el
        // run continúa igual.
        if (MUTATOR_TOOLS.has(action.tool)) {
          try {
            await this._activeCheckpoint.onBeforeMutation({
              tool: action.tool,
              params: action.params,
            });
          } catch (e) {
            logger.warn('AgentLoop', `[checkpoint] no se pudo capturar línea base: ${e.message}`);
          }
        }

        let result;
        if (opts.onProgress) {
          opts.onProgress({
            iteration: i + 1,
            tool: action.tool,
            params: action.params,
            phase: 'start',
          });
        }
        // Motor de identidad (Fase B): cada evento agent-progress alimenta el
        // estado emocional (default/gentle post-error). Nunca rompe el loop.
        try {
          getMoodEngine().noteProgress({ phase: 'start' });
        } catch (_) {}
        try {
          if (GIT_TOOLS.has(action.tool)) {
            result = await this._executeGitTool(action);
          } else if (GITHUB_TOOLS.has(action.tool)) {
            result = await this._executeGitHubTool(action);
          } else if (LSP_TOOLS.has(action.tool)) {
            result = await this._executeLSPTool(action);
          } else if (SUBAGENT_TOOLS.has(action.tool)) {
            result = await this._executeSubagent(action);
          } else if (action.tool === 'mcp') {
            // Pseudo-tool MCP (de mcp_call / MCP_TOOL en fallback textual):
            // va a MCPManager, NUNCA a OpenClawBridge.
            result = await this._executeMCP(action);
          } else if (action.tool === 'plugin') {
            // Pseudo-tool de plugins (de plugin_call en fallback textual).
            result = await this._executePlugin(action);
          } else if (action._needsInstructionResolve) {
            result = await this._executeResolvedEdit(action);
          } else {
            result = await this._bridge.execute(action.tool, action.params);
          }
        } catch (e) {
          result = { ok: false, error: e.message, result: null, tool: action.tool, elapsed: 0 };
        }

        result._action = action;
        // Reflexión intermedia: acumular fallas reales de herramientas (los
        // saltos por permiso/plugin/aprobación/anti-repetición no cuentan).
        if (
          !result.ok &&
          !/^(bloqueada|repetida|cancelada|sin_handler)/.test(String(result.error || ''))
        ) {
          toolFailures++;
          // Instrumentación: misma clasificación de falla real de tool.
          this._metrics.trackError();
        }
        // Registrar la llamada para el dedupe anti-repetición (Fase 2) y para
        // el detector anti-estancamiento (mismo tool sin progreso).
        recentToolCalls.push({
          key: _toolCallKey(action.tool, action.params),
          tool: action.tool,
          ok: result.ok,
          error: result.ok ? null : String(result.error || ''),
          progress: _marksProgress(result),
        });
        if (recentToolCalls.length > RECENT_TOOL_CALLS_MAX) recentToolCalls.shift();
        toolResults.push(result);
        lastToolResult = result;
        if (process.env.DEBUG)
          logger.info(
            'AgentLoop',
            `[agent-loop-timing] iter ${i}: tool=${action.tool} ${Date.now() - _itStart}ms`
          );

        if (opts.onProgress) {
          opts.onProgress({
            iteration: i + 1,
            tool: action.tool,
            params: action.params,
            phase: 'end',
            status: result.ok ? 'ok' : 'error',
            result: result.ok ? result.result : null,
            error: result.ok ? null : result.error,
            meta: result.meta || null,
          });
        }
        // Motor de identidad (Fase B): un fallo real de tool → estado ERROR →
        // mood 'gentle' para el próximo turno (tono uncertainty.was_wrong).
        try {
          getMoodEngine().noteProgress({ phase: 'end', status: result.ok ? 'ok' : 'error' });
        } catch (_) {}

        // ── LSP.1: feedback de diagnósticos tras editar (patrón opencode) ──
        // Cuando una tool que muta archivos tuvo éxito, se sincroniza el cambio
        // en el LSP y se espera el push fresco de diagnósticos; si aparecen
        // errores, se anexan al resumen que ve el LLM en el siguiente turno.
        let lspFeedback = null;
        if (result.ok && EDIT_TOOLS.has(action.tool)) {
          lspFeedback = await this._lspFeedbackForEdit(result, action);
          if (lspFeedback && lspFeedback.diagnostics && lspFeedback.diagnostics.length > 0) {
            result.lspDiagnostics = lspFeedback.diagnostics;
          }
        }

        let resultSummary;
        if (result.ok) {
          resultSummary = this._summarizeResult(result, action);
          if (lspFeedback && lspFeedback.diagnostics && lspFeedback.diagnostics.length > 0) {
            resultSummary +=
              '\n\n' + this._formatDiagnostics(lspFeedback.filePath, lspFeedback.diagnostics);
          }
        } else {
          // Fase 2: hint barato por patrón de error para guiar la próxima jugada
          // (p. ej. EISDIR → "pasaste un directorio"). Nunca sustituye el error
          // original, solo lo aclara.
          const hint = _hintForToolError(result.error);
          resultSummary = `[ERROR en ${action.tool}]: ${result.error || 'desconocido'}${
            hint ? ` — ${hint}` : ''
          }`;
        }

        logger.info(
          'AgentLoop',
          `[agent-loop] iteración ${i + 1}: ${action.tool} → ${result.ok ? 'OK' : 'FALLÓ'}`
        );
        resultSummaries.push(resultSummary);
      }

      if (resultSummaries.length > 0) {
        iterationHistory.push({ role: 'user', content: resultSummaries.join('\n\n') });
      }

      // ── Reflexión intermedia (opcional, opts.reflection) ────────────────
      // Tras una iteración con herramientas, si se acumularon fallas reales el
      // loop se DETIENE a evaluar el plan con una llamada LLM estructurada
      // (veredicto + razón) en vez de seguir reintentando a ciegas. Solo se
      // dispara cuando HAY fallas nuevas desde la última reflexión y quedan
      // rondas. El veredicto vuelve al historial para que el siguiente turno
      // replanifique o aborte.
      if (
        opts.reflection &&
        toolFailures >= REFLECTION_MIN_FAILURES &&
        toolFailures > failuresAtLastReflection &&
        reflectionRounds < REFLECTION_MAX_ROUNDS &&
        !(signal && signal.aborted)
      ) {
        const reflection = await this._reflect({
          userMessage,
          toolResults,
          llm,
          llmOpts,
          signal,
        });
        if (reflection && reflection.verdict === 'CAMBIAR_PLAN' && !(signal && signal.aborted)) {
          reflectionRounds++;
          failuresAtLastReflection = toolFailures;
          iterationHistory.push({ role: 'user', content: reflection.message });
          logger.info(
            'AgentLoop',
            `[agent-loop] reflexión ronda ${reflectionRounds}/${REFLECTION_MAX_ROUNDS}: CAMBIAR_PLAN`
          );
        } else if (
          reflection &&
          reflection.verdict === 'ABANDONAR' &&
          !(signal && signal.aborted)
        ) {
          reflectionRounds++;
          failuresAtLastReflection = toolFailures;
          iterationHistory.push({ role: 'user', content: reflection.message });
          logger.info('AgentLoop', `[agent-loop] reflexión ABANDONAR: ${reflection.reason}`);
        } else {
          // Veredicto CONTINUAR (o fallo de la llamada): no gastar rondas,
          // solo marcar para no re-disparar con las mismas fallas.
          failuresAtLastReflection = toolFailures;
        }
      }
    }

    const finalResponse =
      'He alcanzado el límite de iteraciones sin completar la tarea. ' +
      'Puedes pedirme que continúe o reformular la instrucción.';

    return {
      response: lastResponseText || finalResponse,
      iterations: this.maxIterations,
      toolResults,
      truncated: true,
      error: 'max_iterations_reached',
    };
  }

  /**
   * Verificación forzada (opts.verify): al cerrar el run, si el proyecto
   * define un comando de verificación y el run mutó archivos exitosamente,
   * se ejecuta el comando por el MISMO camino de cualquier tool exec
   * (`this._bridge.execute('exec', { command })`). No crea spawn propio.
   *
   * Scoping (idéntico a reflexión/selfCritique):
   *   - solo modo smart;
   *   - solo con `opts.verify` presente (los subagentes NO la reciben → nunca
   *     verifican, aunque hereden el modo);
   *   - solo si hubo una mutación EXITOSA (EDIT_TOOLS con ok:true).
   *
   * Fallos: un solo intento por default (typecheck/lint/build son
   * deterministas — reintentar sin pasar por el LLM da el mismo resultado).
   * Solo los fallos TRANSITORIOS (timeout del server o error de red/servidor
   * caído) merecen un segundo intento, porque ahí el resultado puede variar.
   * Tras agotar los intentos el run termina IGUAL: `status: 'failed'` en el
   * resultado y aviso explícito en la respuesta (nunca cierre silencioso).
   *
   * @param {{ enabled?: boolean, command?: string }|null|undefined} plan
   * @param {Array<{tool: string, ok: boolean}>} toolResults
   * @returns {Promise<{status: string, reason?: string, command?: string, attempts?: number, exitCode?: number|null, signal?: string|null, stderr?: string, elapsedMs?: number}>}
   */
  async _runVerify(plan, toolResults) {
    return runVerifyPlan(plan, {
      bridge: this._bridge,
      isSmart: this._mode === 'smart',
      toolResults,
      editTools: EDIT_TOOLS,
      signal: this._signal,
    });
  }

  /**
   * LSP.1: tras una edición exitosa, sincroniza el archivo en el LSP y espera
   * el push fresco de diagnósticos (patrón opencode). Devuelve null si no hay
   * LSP activo o la extensión no está soportada (feedback opcional, nunca rompe).
   */
  async _lspFeedbackForEdit(result, action) {
    const params = action.params || {};
    const filePath = params.path || params.filePath;
    if (!filePath || !this._lsp || !this._lsp.isRunning) return null;
    if (typeof this._lsp.supportsFile !== 'function' || !this._lsp.supportsFile(filePath))
      return null;
    try {
      const abs = path.resolve(filePath);
      if (!fs.existsSync(abs)) return null;
      const content = fs.readFileSync(abs, 'utf-8');
      await this._lsp.changeDocument(abs, content);
      const diagnostics = await this._lsp.waitForDiagnostics(abs);
      return { filePath: abs, diagnostics: Array.isArray(diagnostics) ? diagnostics : [] };
    } catch (e) {
      logger.warn('AgentLoop', `[agent-loop] feedback LSP post-edit falló: ${e.message}`);
      return null;
    }
  }

  /** Formatea diagnósticos del LSP para el resumen del turno. */
  _formatDiagnostics(filePath, diagnostics) {
    const errors = diagnostics.filter((d) => d.severity === 1).length;
    const warnings = diagnostics.filter((d) => d.severity === 2).length;
    const shown = diagnostics.slice(0, 10).map((d) => {
      const sev = d.severity === 1 ? 'error' : d.severity === 2 ? 'warning' : 'info';
      const line = d.range?.start?.line ?? '?';
      const char = d.range?.start?.character ?? '?';
      return `  - [${sev}] ${line}:${char} ${d.message}${d.code ? ` (${d.code})` : ''}`;
    });
    const count = diagnostics.length;
    const tail = count > 10 ? `\n  ... y ${count - 10} más` : '';
    return `[Diagnósticos LSP de ${filePath} tras la edición: ${count} (${errors} errores, ${warnings} warnings)]\n${shown.join('\n')}${tail}`;
  }

  /**
   * Despacho de tools LSP al LSPManager (get_diagnostics, get_symbols,
   * go_to_definition, find_references, hover, rename, code_actions). Devuelve
   * el mismo shape que el bridge ({ok, result, error, elapsed, tool}) para el
   * resto del loop.
   *
   * Casos informativos en vez de degradación silenciosa:
   *   - LSP no inicializado / ningún server activo → error claro.
   *   - Lenguaje no soportado por los servers activos → error explícito
   *     (en vez de caer al primario y devolver [] del server equivocado).
   */
  async _executeLSPTool(action) {
    const t0 = Date.now();
    const params = action.params || {};
    const raw = params.raw || {};
    const filePath =
      params.filePath || params.path || params.ARCHIVO || raw.ARCHIVO || raw.filePath;
    const { okShape, failShape } = this._toolShapes(action, t0);

    if (!this._lsp) {
      return failShape('LSP no disponible — el LSPManager no está inicializado.');
    }
    if (!this._lsp.isRunning) {
      return failShape('LSP no activo — ningún servidor LSP corriendo para este workspace.');
    }
    if (!filePath) {
      return failShape(`Falta el archivo (filePath) para la tool ${action.tool}.`);
    }
    if (!this._lsp.supportsFile(filePath)) {
      const langs =
        this._lsp.activeLanguages && this._lsp.activeLanguages.length
          ? this._lsp.activeLanguages.join(', ')
          : 'ninguno';
      return failShape(
        `El archivo ${filePath} no está soportado por el LSP activo. Servidores activos: ${langs}.`
      );
    }

    try {
      switch (action.tool) {
        case 'get_diagnostics':
          return okShape(await this._lsp.getDiagnostics(filePath));
        case 'get_symbols':
          return okShape(await this._lsp.getDocumentSymbols(filePath));
        case 'go_to_definition':
          return okShape(await this._lsp.goToDefinition(filePath, params.line, params.character));
        case 'find_references':
          return okShape(await this._lsp.findReferences(filePath, params.line, params.character));
        case 'hover':
          return okShape(await this._lsp.hover(filePath, params.line, params.character));
        case 'rename':
          return okShape(
            await this._lsp.rename(filePath, params.line, params.character, params.newName)
          );
        case 'code_actions':
          return okShape(
            await this._lsp.codeActions(filePath, params.line, params.character, params.context)
          );
        default:
          return failShape(`Tool LSP desconocida: ${action.tool}`);
      }
    } catch (e) {
      return failShape(e.message);
    }
  }

  /**
   * Ejecuta una tool de un servidor MCP conectado (pseudo-tool 'mcp', que
   * emiten mcp_call / MCP_TOOL en el fallback textual). A diferencia del
   * resto de tools — que van a OpenClawBridge — esto pasa por MCPManager,
   * independiente de si OpenClaw está corriendo.
   *
   * Validación: el nombre de la tool se contrasta contra el catálogo REAL
   * de tools MCP conectadas (listAllTools), no contra nombres fijos. Si el
   * modelo escribió un server/tool que no existe, se devuelve un error claro
   * con la lista de tools disponibles — en vez del "Herramienta desconocida:
   * mcp" genérico de OpenClawBridge.
   */
  async _executeMCP(action) {
    const t0 = Date.now();
    const { server, tool, args } = action.params || {};
    const toolLabel = `${server || '?'}.${tool || '?'}`;

    if (!server || !tool) {
      return {
        ok: false,
        result: null,
        error: 'mcp_call requiere SERVIDOR y HERRAMIENTA (o MCP_TOOL: servidor.herramienta)',
        tool: `mcp:${toolLabel}`,
        elapsed: Date.now() - t0,
      };
    }

    let mgr = this._mcp;
    if (!mgr) {
      try {
        const { getMCPManager } = require('../mcp/MCPManager.js');
        mgr = getMCPManager();
      } catch (e) {
        return {
          ok: false,
          result: null,
          error: `No se pudo cargar MCPManager: ${e.message}`,
          tool: `mcp:${toolLabel}`,
          elapsed: Date.now() - t0,
        };
      }
    }

    try {
      const catalog = typeof mgr.listAllTools === 'function' ? mgr.listAllTools() : [];
      const known = catalog.find(
        (t) => (t.server === server || t.serverId === server) && t.tool === tool
      );
      if (!known) {
        const available = catalog
          .map((t) => `${t.server}.${t.tool}`)
          .sort()
          .join(', ');
        const list = available
          ? ` Disponibles: ${available}.`
          : ' No hay herramientas MCP conectadas en este momento.';
        return {
          ok: false,
          result: null,
          error: `La tool MCP "${toolLabel}" no existe en el catálogo.${list} Revisa el nombre contra la lista de servidores conectados.`,
          tool: `mcp:${toolLabel}`,
          elapsed: Date.now() - t0,
        };
      }

      const result = await mgr.callTool(server, tool, args || {});
      const text =
        (result?.content || [])
          .filter((c) => c.type === 'text')
          .map((c) => c.text)
          .join('\n') || JSON.stringify(result);
      return {
        ok: true,
        result: text,
        error: null,
        tool: `mcp:${server}:${tool}`,
        elapsed: Date.now() - t0,
      };
    } catch (e) {
      return {
        ok: false,
        result: null,
        error: e.message,
        tool: `mcp:${server}:${tool}`,
        elapsed: Date.now() - t0,
      };
    }
  }

  /**
   * Ejecuta una tool de un plugin registrado (pseudo-tool 'plugin', que emite
   * plugin_call en el fallback textual). `params` espera `{ name, args }` o
   * `{ tool, args }`. Espeja Planner._executePlugin.
   */
  async _executePlugin(action) {
    const t0 = Date.now();
    const params = action.params || {};
    const toolId = params.name || params.tool;
    const args = params.args || {};

    if (!toolId) {
      return {
        ok: false,
        result: null,
        error: 'plugin_call requiere name/tool',
        tool: 'plugin',
        elapsed: Date.now() - t0,
      };
    }

    let mgr = null;
    try {
      const { getPluginManager } = require('../plugins/PluginManager.js');
      mgr = getPluginManager();
    } catch (e) {
      return {
        ok: false,
        result: null,
        error: `No se pudo cargar PluginManager: ${e.message}`,
        tool: `plugin:${toolId}`,
        elapsed: Date.now() - t0,
      };
    }

    try {
      if (typeof mgr._dispatch !== 'function') {
        return {
          ok: false,
          result: null,
          error: 'PluginManager no enlazado al dispatch',
          tool: `plugin:${toolId}`,
          elapsed: Date.now() - t0,
        };
      }
      const result = await mgr._dispatch(toolId, args);
      return {
        ok: result?.ok !== false,
        result: result?.result ?? null,
        error: result?.error || null,
        tool: `plugin:${toolId}`,
        elapsed: Date.now() - t0,
      };
    } catch (e) {
      return {
        ok: false,
        result: null,
        error: e.message,
        tool: `plugin:${toolId}`,
        elapsed: Date.now() - t0,
      };
    }
  }

  async _executeGitTool(action) {
    const t0 = Date.now();
    const params = action.params || {};
    // Default de cwd: parámetro explícito → workspace de la app → raíz del proceso.
    const cwd = params.cwd || params.CWD || process.env.ASISTENTE_WORKSPACE || AP.PROJECT_CWD;
    const { okShape, failShape } = this._toolShapes(action, t0);

    if (!this._git) {
      return failShape('Git no disponible — el GitManager no está inicializado.');
    }
    try {
      switch (action.tool) {
        case 'git_status':
          return okShape(await this._git.status(cwd));
        case 'git_diff':
          return okShape(await this._git.diff(cwd, { file: params.file, staged: params.staged }));
        case 'git_log':
          return okShape(await this._git.log(cwd, { count: params.count, file: params.file }));
        case 'git_branch':
          return okShape(await this._git.branch(cwd));
        case 'git_commit':
          return okShape(await this._git.commit(cwd, { message: params.message }));
        case 'git_add':
          return okShape(await this._git.add(cwd, params.paths));
        case 'git_stash':
          return okShape(
            await this._git.stash(cwd, { action: params.action, message: params.message })
          );
        case 'git_merge':
          return okShape(
            await this._git.merge(cwd, { branch: params.branch, message: params.message })
          );
        case 'git_rebase':
          return okShape(await this._git.rebase(cwd, { branch: params.branch }));
        case 'git_push':
          return okShape(
            await this._git.push(cwd, {
              remote: params.remote,
              branch: params.branch,
              force: params.force,
            })
          );
        default:
          return failShape(`Tool git desconocida: ${action.tool}`);
      }
    } catch (e) {
      return failShape(e.message);
    }
  }

  async _executeGitHubTool(action) {
    const t0 = Date.now();
    const params = action.params || {};
    const { okShape, failShape } = this._toolShapes(action, t0);

    if (!this._github) {
      return failShape('GitHub no disponible — el GitHubManager no está inicializado.');
    }
    if (!(await this._github.hasToken)) {
      return failShape(
        'No hay token de GitHub configurado. Guardalo con KeychainManager.setKey("github_token", "<PAT>").'
      );
    }
    try {
      switch (action.tool) {
        case 'github_repo_info':
          return okShape(await this._github.repoInfo(params.repo));
        case 'github_issue_list':
          return okShape(
            await this._github.issueList(params.repo, { state: params.state, limit: params.limit })
          );
        case 'github_issue_create':
          return okShape(
            await this._github.issueCreate(params.repo, {
              title: params.title,
              body: params.body,
              labels: params.labels,
            })
          );
        case 'github_issue_comment':
          return okShape(
            await this._github.issueComment(params.repo, {
              issue_number: params.issue_number,
              body: params.body,
            })
          );
        case 'github_issue_close':
          return okShape(
            await this._github.issueClose(params.repo, { issue_number: params.issue_number })
          );
        case 'github_pr_list':
          return okShape(
            await this._github.prList(params.repo, { state: params.state, limit: params.limit })
          );
        case 'github_pr_create':
          return okShape(
            await this._github.prCreate(params.repo, {
              title: params.title,
              head: params.head,
              base: params.base,
              body: params.body,
            })
          );
        case 'github_pr_review':
          return okShape(
            await this._github.prReview(params.repo, {
              pull_number: params.pull_number,
              event: params.event,
              body: params.body,
            })
          );
        case 'github_actions_status':
          return okShape(await this._github.actionsStatus(params.repo, { limit: params.limit }));
        default:
          return failShape(`Tool github desconocida: ${action.tool}`);
      }
    } catch (e) {
      return failShape(e.message);
    }
  }

  /**
   * §11: lanza un subagente autónomo (AgentLoop anidado) para resolver una
   * sub-tarea de forma independiente. Devuelve el resumen final del subagente.
   */
  async _executeSubagent(action) {
    const t0 = Date.now();
    const params = action.params || {};
    const task = params.task || params.description || '';
    if (!task) {
      return {
        ok: false,
        error: 'task (descripción) requerida',
        result: null,
        tool: action.tool,
        elapsed: 0,
      };
    }

    const depth = this._subagentDepth || 0;
    if (depth >= MAX_SUBAGENT_DEPTH) {
      return {
        ok: false,
        error: `profundidad máxima de subagentes alcanzada (${MAX_SUBAGENT_DEPTH})`,
        result: null,
        tool: action.tool,
        elapsed: 0,
      };
    }

    const maxIters = Math.min(params.max_iterations || 8, 15);
    let nested;
    try {
      nested = new AgentLoop({
        bridge: this._bridge,
        llm: this._llm,
        lsp: this._lsp,
        git: this._git,
        github: this._github,
        mode: this._mode,
        maxIterations: maxIters,
      });
      nested._subagentDepth = depth + 1;
    } catch (e) {
      return {
        ok: false,
        error: `no se pudo crear el subagente: ${e.message}`,
        result: null,
        tool: action.tool,
        elapsed: 0,
      };
    }

    const subTask = params.context ? `${task}\n\nContexto adicional:\n${params.context}` : task;

    try {
      const out = await nested.run(subTask, SUBAGENT_SYSTEM, [], {
        llm: this._llm,
        taskIntent: this._currentTaskIntent || null,
        signal: this._signal,
        onProgress: null,
        // Los subagentes heredan la política de verificación y reflexión del run
        // padre: una tarea delegada NO puede mutar sin sellado post-acción ni
        // sin auto-crítica (inconsistencia de política corregida).
        verify: this._verifyPlan || null,
        reflection: this._reflectionOpt || null,
        // El resumen final del subagente es un reporte, no una orden: no debe
        // pasar por el parser de prosa (evita que "modifiqué X" re-dispare una
        // edición no pedida). Las ediciones del subagente se expresan con
        // bloques de acción estructurados o tool calls nativos.
        reportMode: true,
      });
      const toolCalls = (out.toolResults || []).map((r) => `${r.tool}:${r.ok ? 'ok' : 'err'}`);
      const resultPayload = {
        response: out.response,
        iterations: out.iterations,
        truncated: !!out.truncated,
        error: out.error || null,
        toolCalls,
        // El sellado post-acción del subagente (verify heredado del padre): el
        // padre lo lee aunque el reporte en texto no lo mencione.
        verify: out.verify || null,
      };
      // Fiabilidad del resumen: si el subagente editó/creó archivos (según sus
      // toolResults REALES, no su texto), se compara lo que tocó contra lo que
      // menciona en el resumen. Si no coincide, se anexa una nota de discrepancia
      // para que el agente principal decida si confía o verifica — nunca bloquea.
      const editedFiles = collectEditedFiles(out.toolResults, EDIT_TOOLS, AP.PROJECT_CWD);
      if (editedFiles.length > 0) {
        const report = analyzeSubagentReport(out.response, editedFiles);
        if (report) {
          resultPayload.discrepancyNote = report;
          resultPayload.response =
            String(out.response || '') + '\n\n' + formatSubagentDiscrepancy(report);
        }
      }
      // Si el sellado falló, se anexa el aviso al reporte que ve el padre (tras
      // el audit, que ya corrió sobre el response limpio).
      if (out.verify && out.verify.status === 'failed') {
        resultPayload.response =
          String(resultPayload.response || '') + '\n\n' + buildVerifyFailureNotice(out.verify);
      }
      return {
        ok: true,
        result: resultPayload,
        tool: action.tool,
        elapsed: Math.round((Date.now() - t0) / 1000),
      };
    } catch (e) {
      return {
        ok: false,
        error: `subagente falló: ${e.message}`,
        result: null,
        tool: action.tool,
        elapsed: Math.round((Date.now() - t0) / 1000),
      };
    }
  }

  // Convierte una instrucción de edición en lenguaje natural a un diff exacto
  // (old_text/new_text) usando una llamada LLM focalizada, o a una reescritura
  // completa (mode 'write') si la instrucción lo amerita. Devuelve null si no
  // se pudo resolver de forma verificable.
  async _resolveEditFromInstruction(filePath, instruction) {
    if (!filePath || !instruction || typeof instruction !== 'string') return null;

    const readResult = await this._bridge.execute('read', { path: filePath });
    const content =
      typeof readResult?.result === 'string' ? readResult.result : readResult?.result?.content;
    if (typeof content !== 'string' || content.length === 0) return null;

    const llm = this._getLLM();
    const prompt =
      `Tengo el contenido del archivo "${filePath}" y una instrucción de edición.\n` +
      `Devuelve ÚNICAMENTE JSON válido:\n` +
      `- Si la edición es puntual: {"old_text": "<fragmento EXACTO a reemplazar, con contexto único>", "new_text": "<reemplazo>"}\n` +
      `- Si hay que reescribir el archivo entero: {"full": true, "content": "<contenido completo nuevo>"}\n\n` +
      `Instrucción: ${instruction}\n\n` +
      `CONTENIDO ACTUAL:\n\`\`\`\n${
        content.length > 30000 ? content.slice(0, 30000) + '\n...[truncado]' : content
      }\n\`\`\``;

    let raw;
    try {
      raw = await llm(
        [{ role: 'user', content: prompt }],
        'Eres un editor de código experto. Respondes únicamente JSON.',
        {}
      );
    } catch (e) {
      return null;
    }
    const text = typeof raw === 'string' ? raw : raw?.content || '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      const parsed = JSON.parse(m[0]);
      if (parsed.full && typeof parsed.content === 'string' && parsed.content.trim()) {
        return { mode: 'write', content: parsed.content };
      }
      if (
        typeof parsed.old_text === 'string' &&
        parsed.old_text &&
        typeof parsed.new_text === 'string' &&
        content.includes(parsed.old_text)
      ) {
        return { mode: 'edit', old_text: parsed.old_text, new_text: parsed.new_text };
      }
    } catch {
      // JSON inválido → sin resolución
    }
    return null;
  }

  async _executeResolvedEdit(action) {
    const t0 = Date.now();
    const filePath = action.params?.path;
    const instruction = action._editInstruction;
    let resolved;
    try {
      resolved = await this._resolveEditFromInstruction(filePath, instruction);
    } catch (e) {
      return {
        ok: false,
        error: `edit_no_resuelto: ${e.message}`,
        result: null,
        tool: action.tool,
        elapsed: 0,
      };
    }
    if (!resolved) {
      return {
        ok: false,
        error: 'edit_no_resuelto: la instrucción no se convirtió en un cambio exacto verificable',
        result: null,
        tool: action.tool,
        elapsed: Math.round((Date.now() - t0) / 1000),
      };
    }
    if (resolved.mode === 'write') {
      return this._bridge.execute('write', { path: filePath, content: resolved.content });
    }
    return this._bridge.execute('edit', {
      path: filePath,
      old_text: resolved.old_text,
      new_text: resolved.new_text,
    });
  }

  /**
   * Reflexión intermedia (opcional, opts.reflection): paso determinista que se
   * dispara cuando una iteración acumuló fallas de herramientas. Pide al LLM
   * evaluar el plan actual contra la intención original y devolver un veredicto
   * estructurado:
   *
   *   - CONTINUAR      → el plan sigue siendo viable; no hacer nada.
   *   - CAMBIAR_PLAN   → devuelve { verdict, message } con la razón; el loop
   *                      vuelve a poner ese mensaje en el historial para que el
   *                      siguiente turno replanifique.
   *   - ABANDONAR      → devuelve { verdict, message, reason }; el mensaje
   *                      instruye al LLM a responder al usuario con un resumen
   *                      honesto y terminar.
   *
   * Es un momento explícito de autocorrección: el loop se detiene a evaluar
   * "¿esto funcionó, debo cambiar de plan?" en lugar de seguir reintentando a
   * ciegas dentro del bucle de tool-calling. Nunca rompe ni bloquea el run (si
   * la llamada falla, devuelve null y el loop sigue con CONTINUAR).
   *
   * @param {object} p
   * @param {string} p.userMessage - intención original del usuario
   * @param {Array} p.toolResults - acciones ejecutadas hasta ahora
   * @param {Function} p.llm - función LLM resuelta del run
   * @param {object} p.llmOpts - { signal } ya preparado
   * @param {AbortSignal|null} p.signal
   * @returns {Promise<{verdict: string, message?: string, reason?: string} | null>}
   */
  async _reflect({ userMessage, toolResults, llm, llmOpts, signal }) {
    const actionsSummary =
      (toolResults || [])
        .map((t) => {
          const brief = t._action?.params || {};
          const params = Object.entries(brief)
            .map(
              ([k, v]) =>
                `${k}=${typeof v === 'string' ? v.slice(0, 60) : JSON.stringify(v)?.slice(0, 60)}`
            )
            .join(' ');
          return `  - ${t.tool}${params ? ' · ' + params : ''} → ${t.ok ? 'OK' : `FALLÓ: ${t.error || ''}`}`;
        })
        .join('\n') || '  (ninguna acción ejecutada)';

    const reflectPrompt = [
      `# REFLEXIÓN — evaluación del plan en curso`,
      ``,
      `Intención original del usuario:`,
      String(userMessage).slice(0, 600),
      ``,
      `Acciones ejecutadas hasta ahora:`,
      actionsSummary,
      ``,
      `Varias herramientas fallaron. Antes de seguir, evalúa si el plan actual`,
      `sigue siendo válido o hay que cambiarlo. Responde EXACTAMENTE una de:`,
      `VEREDICTO: CONTINUAR`,
      `VEREDICTO: CAMBIAR_PLAN`,
      `VEREDICTO: ABANDONAR`,
      ``,
      `Si es CAMBIAR_PLAN, añade una línea "RAZÓN: <qué salió mal y qué estrategia`,
      `alternativa propones>".`,
      `Si es ABANDONAR, añade una línea "RAZÓN: <por qué no se puede completar>".`,
      `Sé honesto: no marques CONTINUAR si el plan claramente no funciona.`,
    ].join('\n');

    const reflectSystem = [
      'Eres el paso de reflexión de un agente. Tu trabajo es evaluar si el plan',
      'de ejecución en curso sigue siendo viable o debe cambiar.',
      'CONSERVADOR: solo marca CAMBIAR_PLAN o ABANDONAR si hay evidencia clara de',
      'que la estrategia actual no lleva a la intención original del usuario.',
      'CAMBIAR_PLAN: hay una estrategia alternativa concreta y mejor.',
      'ABANDONAR: la tarea no se puede completar con las herramientas disponibles,',
      'o el objetivo cambió y no tiene sentido seguir.',
      'CONTINUAR: aún hay margen razonable para intentar otra cosa con el plan actual.',
    ].join('\n');

    try {
      // La reflexión NO streamiea al chat: es un paso interno de control.
      const reflectSignal = signal || llmOpts?.signal || null;
      const raw = await llm(
        [{ role: 'user', content: reflectPrompt }],
        reflectSystem,
        reflectSignal ? { signal: reflectSignal } : {}
      );
      const text = typeof raw === 'string' ? raw : raw?.content || '';
      if (/VEREDICTO:\s*CAMBIAR_PLAN/i.test(text)) {
        const reasonMatch = text.match(/RAZÓN:\s*([^\n]+)/i);
        const reason = reasonMatch
          ? reasonMatch[1].trim()
          : 'La estrategia actual no está funcionando.';
        return {
          verdict: 'CAMBIAR_PLAN',
          message: `[Reflexión del agente] El plan actual no está funcionando: ${reason}.\nCambia de estrategia y replanifica.`,
        };
      }
      if (/VEREDICTO:\s*ABANDONAR/i.test(text)) {
        const reasonMatch = text.match(/RAZÓN:\s*([^\n]+)/i);
        const reason = reasonMatch
          ? reasonMatch[1].trim()
          : 'La tarea no se puede completar con las herramientas disponibles.';
        return {
          verdict: 'ABANDONAR',
          reason,
          message: `[Reflexión del agente] La tarea no se puede completar: ${reason}.\nResponde al usuario con un resumen honesto de lo logrado, qué faltó y por qué, y termina.`,
        };
      }
    } catch (e) {
      if (e?.code === 'ABORTED' || e?.name === 'AbortError') throw e;
      logger.warn('AgentLoop', `[agent-loop] reflexión intermedia falló: ${e.message}`);
    }
    return null;
  }

  /**
   * Self-critique (opcional, opts.selfCritique): paso extra al terminar el
   * run con una respuesta de texto. Pide al LLM comparar el resultado contra
   * la INTENCIÓN original del usuario (no solo criterios técnicos) y devuelve
   * { continue: true, message } si el veredicto es INCOMPLETA — el loop usa
   * ese mensaje para continuar corrigiendo. Devuelve null si COMPLETA o si la
   * llamada falla (la auto-crítica nunca rompe ni bloquea el run).
   *
   * @param {object} p
   * @param {string} p.userMessage - intención original del usuario
   * @param {string} p.responseText - respuesta final del agente
   * @param {Array} p.toolResults - acciones ejecutadas
   * @param {Function} p.llm - función LLM resuelta del run
   * @param {object} p.llmOpts - { signal } ya preparado
   * @param {AbortSignal|null} p.signal
   */
  async _selfCritique({ userMessage, responseText, toolResults, llm, llmOpts, signal }) {
    const actionsSummary =
      (toolResults || [])
        .map((t) => {
          const brief = t._action?.params || {};
          const params = Object.entries(brief)
            .map(
              ([k, v]) =>
                `${k}=${typeof v === 'string' ? v.slice(0, 60) : JSON.stringify(v)?.slice(0, 60)}`
            )
            .join(' ');
          return `  - ${t.tool}${params ? ' · ' + params : ''} → ${t.ok ? 'OK' : `FALLÓ: ${t.error || ''}`}`;
        })
        .join('\n') || '  (ninguna acción ejecutada)';

    const critiquePrompt = [
      `# AUTO-CRÍTICA — verificación contra la intención original`,
      ``,
      `Intención original del usuario:`,
      String(userMessage).slice(0, 600),
      ``,
      `Acciones ejecutadas:`,
      actionsSummary,
      ``,
      `Respuesta final del agente:`,
      String(responseText || '').slice(0, 800),
      ``,
      `¿El resultado satisface COMPLETAMENTE la intención original del usuario?`,
      `Responde EXACTAMENTE una de estas dos líneas (sin texto extra):`,
      `VEREDICTO: COMPLETA`,
      `VEREDICTO: INCOMPLETA`,
      `Si es INCOMPLETA, añade una línea "RAZÓN: <qué falta o qué corregir>".`,
      `IMPORTANTE: la intención original es SOLO lo que el usuario pidió explícitamente.`,
      `Si el agente ya hizo lo pedido, marca COMPLETA y TERMINA — no inventes trabajo`,
      `extra ni interpretes de forma amplia instrucciones compuestas.`,
    ].join('\n');

    const critiqueSystem = [
      'Eres un crítico riguroso del agente. Evalúa el resultado final contra la',
      'intención original del usuario, NO solo contra criterios técnicos (tests,',
      'lint, diagnósticos). Si la tarea quedó incompleta, mal resuelta o se desvió',
      'de lo pedido, marca INCOMPLETA con una razón específica y accionable.',
      'Sé estricto pero justo: solo INCOMPLETA si hay una brecha real.',
      '',
      'Reglas de alcance:',
      '- La "intención original del usuario" cubre EXACTAMENTE lo que el usuario',
      '  pidió. NO incluye acciones que el usuario no mencionó directamente, ni',
      '  mejoras, refactors, cambios de estilo o "detalles" que el agente decidió',
      '  por su cuenta.',
      '- La tarea es COMPLETA si la acción pedida se ejecutó con éxito (p. ej. el',
      '  push a git terminó OK), aunque existan advertencias de lint/diagnósticos',
      '  en archivos que NO eran parte del pedido.',
      '- NO marques INCOMPLETA para "seguir mejorando" código o hacer cambios no',
      '  solicitados: las mejoras fuera de alcance NO son una brecha de la tarea.',
      '- Edits no solicitados sobre archivos no relacionados son una DESVIACIÓN:',
      '  si ocurrieron, la tarea ya se cumplió o el run debe terminar, no sumar',
      '  más trabajo.',
      '- Regla de ambigüedad: si dudas sobre si el usuario pidió algo adicional,',
      '  interpreta de forma CONSERVADORA — marca COMPLETA y no sigas actuando.',
      '  Cuando en duda, el run debe TERMINAR, no expandirse.',
    ].join('\n');

    try {
      // La auto-crítica NO streamiea al chat: es un paso interno de control.
      const critiqueSignal = signal || llmOpts?.signal || null;
      const raw = await llm(
        [{ role: 'user', content: critiquePrompt }],
        critiqueSystem,
        critiqueSignal ? { signal: critiqueSignal } : {}
      );
      const text = typeof raw === 'string' ? raw : raw?.content || '';
      if (/VEREDICTO:\s*INCOMPLETA/i.test(text)) {
        const reasonMatch = text.match(/RAZÓN:\s*([^\n]+)/i);
        const reason = reasonMatch
          ? reasonMatch[1].trim()
          : 'El resultado no cubre la intención original.';
        return {
          continue: true,
          message: `[Auto-crítica del agente] La tarea quedó incompleta: ${reason}.\nRevisa y corrige/termina lo que haga falta.`,
        };
      }
    } catch (e) {
      if (e?.code === 'ABORTED' || e?.name === 'AbortError') throw e;
      logger.warn('AgentLoop', `[agent-loop] auto-crítica falló: ${e.message}`);
    }
    return null;
  }

  _buildToolResultMessage(lastResult) {
    if (!lastResult) return null;

    const summary = this._summarizeResult(lastResult);
    if (lastResult.ok) {
      return `[Resultado de herramienta "${lastResult.tool}"]:\n${summary}`;
    }
    return `[ERROR en herramienta "${lastResult.tool}"]: ${lastResult.error || 'desconocido'}\n\nContinúa con otra estrategia o avísame si no puedes completar la tarea.`;
  }

  /**
   * G.1: compactación de contexto. Devuelve los mensajes que verá el LLM en la
   * iteración i:
   *   - el objetivo original siempre está presente,
   *   - si la historia creció, los turnos viejos se condensan en un resumen
   *     determinista (objetivo + acciones ejecutadas hasta ahora),
   *   - los últimos COMPACT_KEEP_TAIL turnos se conservan íntegros (para que el
   *     LLM tenga el estado reciente real, no un resumen),
   *   - y se anexa el mensaje de resultado de la última tool.
   */
  _buildLLMMessages(iterationHistory, currentUserMsg, userMessage, toolResults, iteration) {
    const msgs = [{ role: 'user', content: userMessage }];

    if (
      iterationHistory.length >= COMPACT_MIN_TURNS &&
      iterationHistory.length - COMPACT_KEEP_TAIL > 0
    ) {
      const keep = iterationHistory.slice(-COMPACT_KEEP_TAIL);
      const compacted = this._compactSummary(
        userMessage,
        toolResults,
        iterationHistory.length - COMPACT_KEEP_TAIL
      );
      if (compacted) msgs.push({ role: 'user', content: compacted });
      msgs.push(...keep);
      // §12: persistir una vez por run el resumen de compactación en memoria
      // vectorial para poder reconstruir contexto en sesiones futuras.
      this._rememberCompaction(
        userMessage,
        toolResults,
        iterationHistory.length - COMPACT_KEEP_TAIL
      );
    } else {
      msgs.push(...iterationHistory);
    }

    if (currentUserMsg) msgs.push({ role: 'user', content: currentUserMsg });
    return msgs;
  }

  /** Resumen determinista de lo hecho hasta ahora (para la compactación). */
  _compactSummary(userMessage, toolResults, droppedTurns) {
    const actions =
      (toolResults || [])
        .map((t) => {
          const ok = t.ok ? 'OK' : `FALLÓ: ${t.error || ''}`;
          const params = t._action?.params || {};
          const brief = Object.entries(params)
            .map(
              ([k, v]) =>
                `${k}=${typeof v === 'string' ? v.slice(0, 60) : JSON.stringify(v)?.slice(0, 60)}`
            )
            .join(' ');
          return `  - ${t.tool} (${ok})${brief ? ' · ' + brief : ''}`;
        })
        .join('\n') || '  (ninguna todavía)';

    return [
      `[RESUMEN DE LO HECHO HASTA AHORA — ${droppedTurns} turnos anteriores condensados para ahorrar contexto]`,
      `Objetivo original: ${String(userMessage).slice(0, 200)}`,
      `Acciones ejecutadas:\n${actions}`,
      'Continúa desde este punto; no repitas acciones ya completadas.',
    ].join('\n');
  }

  /**
   * §12: persiste una vez por run el resumen de compactación como un nodo
   * Episode (memoria vectorial) para reconstruir contexto en sesiones largas
   * o retomadas. Best-effort: nunca rompe el loop si falla.
   */
  _rememberCompaction(userMessage, toolResults, droppedTurns) {
    if (!this._graph || this._compactionPersisted) return;
    try {
      const summary = this._compactSummary(userMessage, toolResults, droppedTurns);
      const label = `Contexto compactado: ${String(userMessage).slice(0, 80)}`;
      const existing = this._graph._findNodesByLabel ? this._graph._findNodesByLabel(label) : [];
      if (Array.isArray(existing) && existing.length > 0) {
        this._graph.updateNode(existing[0].id, { content: summary });
      } else {
        this._graph.createNode({
          type: 'Episode',
          label,
          content: summary,
          importance: 0.7,
          tags: ['context-compaction'],
        });
      }
      this._compactionPersisted = true;
    } catch (e) {
      logger.warn('AgentLoop', `[agent-loop] persistir compactación falló: ${e.message}`);
    }
  }

  /**
   * §12: recall semántico de episodios de compactación previos relevantes al
   * objetivo actual. Devuelve un bloque de texto para inyectar al prompt.
   */
  async _recallMemory(userMessage) {
    if (!this._graph || !userMessage) return null;
    try {
      const episodes = await this._graph.queryNodesSemantic(userMessage, {
        type: 'Episode',
        limit: 3,
        includeArchived: false,
      });
      const relevant = (episodes || []).filter((n) => {
        let tags = [];
        try {
          tags = JSON.parse(n.tags || '[]');
        } catch {}
        return tags.includes('context-compaction');
      });
      if (relevant.length === 0) return null;

      const lines = relevant.map((n, i) => {
        const sim = n._similarity != null ? ` (similitud ${n._similarity.toFixed(2)})` : '';
        return `[Contexto ${i + 1} de memoria${sim}]\n${String(n.content).slice(0, 800)}`;
      });
      return [
        '# CONTEXTO RELEVANTE DE MEMORIA (sesiones previas)',
        'Usa esto si la tarea actual continúa o se relaciona con trabajo anterior:',
        ...lines,
      ].join('\n');
    } catch (e) {
      logger.warn('AgentLoop', `[agent-loop] recall de memoria falló: ${e.message}`);
      return null;
    }
  }

  /**
   * Resumen de lo ya logrado antes de un fallo de LLM. Lista las tools que
   * terminaron con éxito en iteraciones previas del loop; si no hubo ninguna
   * tool exitosa devuelve una cadena vacía (y el response queda solo con el
   * error, como antes). Evita que un fallo de LLM en la iteración i>0 borre
   * todo rastro del trabajo ya completado.
   */
  _completedSummary(toolResults) {
    const done = (toolResults || []).filter((r) => r && r.ok);
    if (done.length === 0) return '';
    return '¡La tarea quedó terminada! ✓\n\n' + done.map((r) => `✓ ${r.tool}`).join('\n') + '\n\n';
  }

  _summarizeResult(result) {
    const raw = result.result;
    if (raw === null || raw === undefined) return 'Sin resultado.';

    if (typeof raw === 'string') {
      if (raw.length <= RESULT_TRUNCATE_LIMIT) return raw;
      return (
        raw.slice(0, RESULT_TRUNCATE_LIMIT) +
        `\n\n[... resultado truncado: ${raw.length} caracteres totales]`
      );
    }

    if (typeof raw === 'object') {
      if (raw.stdout !== undefined) {
        const stdout = (raw.stdout || '').trim();
        const stderr = (raw.stderr || '').trim();
        let summary = '';
        if (stdout) {
          summary +=
            stdout.length <= RESULT_TRUNCATE_LIMIT
              ? stdout
              : stdout.slice(0, RESULT_TRUNCATE_LIMIT) +
                `\n[... stdout truncado: ${stdout.length} chars]`;
        }
        if (stderr) {
          summary +=
            (summary ? '\n' : '') +
            (stderr.length <= RESULT_TRUNCATE_LIMIT / 2
              ? stderr
              : stderr.slice(0, RESULT_TRUNCATE_LIMIT / 2) + `\n[... stderr truncado]`);
        }
        if (raw.exitCode !== undefined && raw.exitCode !== 0) {
          summary += `\n[exit code: ${raw.exitCode}]`;
        }
        return summary || `[Comando ejecutado, sin salida]`;
      }
      const str = JSON.stringify(raw, null, 2);
      return str.length <= RESULT_TRUNCATE_LIMIT
        ? str
        : str.slice(0, RESULT_TRUNCATE_LIMIT) + `\n[... truncado: ${str.length} chars]`;
    }

    return String(raw).slice(0, RESULT_TRUNCATE_LIMIT);
  }
}

module.exports = { AgentLoop, MAX_ITERATIONS, buildActiveIntentionsSection };
