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
const { verifyHtmlFiles } = require('./web-verify.js');
const { verifySyntax } = require('./syntax-verify.js');
const { computeDiffPreview } = require('../git/FileDiff.js');
const { getGitHubManager } = require('../github/GitHubManager.js');
const { RunMetrics } = require('./run-metrics.js');
const { getMoodEngine } = require('../identity/MoodEngine.js');
const { runVerifyPlan, buildVerifyFailureNotice } = require('./verify-runner.js');
const { estimateDifficulty } = require('../learning/difficulty.js');
const { RepositoryIntelligence } = require('../lsp/RepositoryIntelligence.js');
const {
  collectEditedFiles,
  analyzeSubagentReport,
  formatSubagentDiscrepancy,
} = require('./subagent-report.js');
const { getSubagentRegistry, _toolAllowed } = require('./SubagentRegistry.js');
const { buildStepProgress } = require('./StepExecutionLedger.js');
const { wrapUntrusted } = require('../grounding/untrustedContent.js');
const { assessAction, requestActionApproval } = require('../security/AuthorizedToolExecutor.js');
const {
  MutationJournal,
  isMutatingAction,
  isSuccessfulMutationResult,
  extractMutationPaths,
} = require('./MutationJournal.js');

const VALID_MODES = new Set(['smart', 'fast', 'task', 'conversational']);

// Tools LSP que se despachan al LSPManager (no al puente OpenClaw).
const LSP_TOOLS = new Set([
  'get_diagnostics',
  'go_to_definition',
  'find_references',
  'go_to_implementation',
  'completion',
  'signature_help',
  'call_hierarchy',
  'get_symbols',
  'workspace_symbols',
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
const SUBAGENT_TOOLS = new Set(['subagent', 'task', 'subagent_batch']);

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

// Tool-call nativo cuyo nombre vino en el formato textual `MCP_TOOL:
// <servidor>.<herramienta>` (p.ej. "MCP_TOOL: filesystem.write_file"). El
// prompt del catálogo enseña ese formato y algunos modelos lo replican como
// FUNCTION NAME en tool-calling en vez de usar el schema nativo. Sin
// normalización, el nombre llega tal cual a OpenClawBridge → "Herramienta
// desconocida". Aquí se traduce a la pseudo-tool 'mcp' (MCPManager), el mismo
// destino que usa StructuredActionParser con MCP_TOOL en el fallback textual.
const NATIVE_MCP_TOOL_CALL_RE = /^MCP_TOOL:\s*([^.\s]+)\.([^.\s]+)$/;

function _nativeToolCallToAction(tc, nativeMcpMap = {}) {
  const raw = String(tc.tool || '');
  const rawParams = tc.params && typeof tc.params === 'object' ? { ...tc.params } : {};
  const stepOrdinal = Number(rawParams.step_ordinal || rawParams.stepOrdinal || 0) || undefined;
  delete rawParams.step_ordinal;
  delete rawParams.stepOrdinal;
  const dynamicMcp = nativeMcpMap[raw];
  if (dynamicMcp) {
    return {
      tool: 'mcp',
      params: { server: dynamicMcp.server, tool: dynamicMcp.tool, args: rawParams },
      stepOrdinal,
      callId: tc.id || tc.callId || null,
      description: `${dynamicMcp.server}.${dynamicMcp.tool}: ${JSON.stringify(tc.params).slice(0, 100)}`,
      source: 'native_tool_call',
    };
  }
  const mcpMatch = NATIVE_MCP_TOOL_CALL_RE.exec(raw);
  if (mcpMatch) {
    return {
      tool: 'mcp',
      params: { server: mcpMatch[1], tool: mcpMatch[2], args: rawParams },
      stepOrdinal,
      callId: tc.id || tc.callId || null,
      description: `${raw}: ${JSON.stringify(tc.params).slice(0, 100)}`,
      source: 'native_tool_call',
    };
  }
  return {
    tool: _canonicalToolName(raw),
    params: rawParams,
    stepOrdinal,
    callId: tc.id || tc.callId || null,
    description: `${raw}: ${JSON.stringify(tc.params).slice(0, 100)}`,
    source: 'native_tool_call',
  };
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
/**
 * BUG-1 (auditoría): detecta respuestas que PROMETEN ediciones sin que haya
 * ocurrido ninguna mutación exitosa en el run. Caso real: el modelo dijo
 * "¡Listo, ya está! 🌟" tras solo cat+ls. Determinista — sin LLM.
 * @param {string} responseText
 * @param {Array<{ok?: boolean, tool?: string, _action?: {tool?: string}}>} toolResults
 * @returns {string|null} resumen del claim, o null si no hay problema
 */
function _detectUnverifiedEditClaims(responseText, toolResults) {
  const hadSuccessfulMutation = (toolResults || []).some(_isSuccessfulMutation);
  if (hadSuccessfulMutation) return null;
  const text = String(responseText || '');
  if (!text.trim()) return null;
  const CLAIM_RE =
    /\b(apliqu[ée]|aplicados|modifiqu[ée]|edit[ée]|cambi[ée]|cre[ée]|creado|escrib[ée]|actualic[ée]|correg[ée]|arregl[ée]|parche aplicado|ya est[aá]|listo[,!]?\s*ya)\b/i;
  const CODE_CTX_RE = /\b(archivo|c[oó]digo|parche|[a-z]\.(py|js|ts|json|md)|funci[oó]n)\b/i;
  const m = text.match(CLAIM_RE);
  if (m && CODE_CTX_RE.test(text)) {
    return `afirma "${m[0]}"`;
  }
  return null;
}

const MUTATION_FOLLOW_THROUGH_MAX_ROUNDS = 2;
const MUTATION_ACTION_RE =
  /\b(crea(r)?|haz|diseña(r)?|desarrolla(r)?|construye|implementa(r)?|edita(r)?|modifica(r)?|cambia(r)?|corrige|corregir|arregla(r)?|escribe|escribir|añade|agrega|elimina(r)?|borra(r)?|vac[ií]a(r)?|create|build|implement|edit|modify|change|fix|write|add|delete|remove)\b/i;
const MUTATION_TARGET_RE =
  /\b(archivo|carpeta|directorio|c[oó]digo|proyecto|sitio|p[aá]gina|landing|web|aplicaci[oó]n|app|interfaz|componente|funci[oó]n|configuraci[oó]n|file|folder|directory|code|project|site|page|application|component|function|config)\b/i;
const EXPLANATION_REQUEST_RE =
  /^\s*(c[oó]mo|how\s+to|explica|expl[ií]came|ens[eé][ñn]ame|dime\s+c[oó]mo|qu[eé]\s+har[ií]as|what\s+would)\b/i;
const OBSERVABLE_TASK_RE =
  /\b(ejecuta|ejecutar|corre|correr|abre|abrir|ábreme|lanza|inicia|reproduce|reproducir|pon|poner|prueba|probar|verifica|verificar|analiza|analizar|investiga|investigar|revisa|revisar|busca|buscar|implementa|implementar|fix|run|open|play|test|verify|analy[sz]e|investigate|review)\b/i;
const INTERACTIVE_ACTION_RE =
  /(?:^|\s)(?:abre|abrir|ábreme|lanza|inicia|reproduce|reproducir|pon|poner|haz\s+clic|pulsa|presiona|escribe|selecciona|cierra|open|launch|play|click|press|type|select|close)(?=\s|$|[.,;:!?])/i;
const UI_TOOLS = new Set([
  'browser',
  'desktop_mission',
  'list_apps',
  'launch_app',
  'open_website',
  'play_media',
  'desktop_snapshot',
  'desktop_screenshot',
  'pointer_click',
  'window_list',
  'window_focus',
  'ui_get_state',
  'ui_wait',
  'ui_click',
  'ui_type',
  'ui_press',
  'ui_select',
  'ui_scroll',
  'window_close',
  'desktop_capabilities',
  'process_list',
  'process_stop',
  'camera_status',
  'open_camera',
]);
const UNTRUSTED_UI_TOOLS = new Set([
  'desktop_snapshot',
  'desktop_screenshot',
  'window_list',
  'window_focus',
  'ui_get_state',
  'ui_wait',
  'ui_click',
  'ui_type',
  'ui_press',
  'ui_select',
  'ui_scroll',
  'window_close',
  'process_list',
]);

function _isVerifiedInteractiveResult(result) {
  if (!result?.ok) return false;
  if (result.tool === 'ui_wait') {
    return result.result?.verified === true;
  }
  if (result.tool === 'play_media') return result.result?.verified === true;
  if (result.tool === 'launch_app' || result.tool === 'open_website') {
    return result.result?.verified === true;
  }
  if (result.tool === 'browser') {
    return result.result?.verified === true || result.result?.intentVerified === true;
  }
  if (UI_TOOLS.has(result.tool)) {
    return result.result?.intentVerified === true;
  }
  return true;
}

/** La petición exige un cambio observable, no sólo una explicación. */
function _expectsMutation(userMessage) {
  const text = String(userMessage || '').trim();
  if (!text || EXPLANATION_REQUEST_RE.test(text)) return false;
  return MUTATION_ACTION_RE.test(text) && MUTATION_TARGET_RE.test(text);
}

/** La petición exige al menos una herramienta o evidencia externa observable. */
function _expectsObservableExecution(userMessage) {
  const text = String(userMessage || '').trim();
  if (!text || EXPLANATION_REQUEST_RE.test(text)) return false;
  return OBSERVABLE_TASK_RE.test(text);
}

/** Contrato terminal uniforme para Core, IPC y consumidores internos. */
function _buildExecutionSummary(result, plan) {
  const cancelled = result?.cancelled === true;
  const failed = Boolean(result?.error) || result?.verify?.status === 'failed';
  const state = cancelled ? 'cancelled' : failed ? 'paused' : 'completed';
  const stepStates = Array.isArray(result?.plan?.stepStates) ? result.plan.stepStates : [];
  const pending = stepStates.find(
    (step) => !['completed', 'skipped'].includes(String(step?.status || 'pending'))
  );
  const ordinal = Number(pending?.ordinal) || null;
  return {
    state,
    resumable: state === 'paused' || state === 'cancelled',
    reason: result?.error ? String(result.error) : cancelled ? 'cancelled' : null,
    resumePoint:
      ordinal && Array.isArray(plan?.steps)
        ? { ordinal, description: String(plan.steps[ordinal - 1] || '') }
        : null,
    evidence: {
      successfulTools: (result?.toolResults || []).filter((item) => item?.ok).length,
      successfulMutations: (result?.toolResults || []).filter(_isSuccessfulMutation).length,
      planDone: Number(result?.plan?.done) || 0,
      planTotal: Number(result?.plan?.total) || 0,
      verification: result?.verify?.status ? String(result.verify.status) : null,
    },
  };
}

/** Reconoce mutaciones exitosas aunque hayan pasado por MCP o exec. */
function _isSuccessfulMutation(result) {
  return isSuccessfulMutationResult(result);
}

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
 * Tools git de SOPORTE que nunca avanzan la tarea por sí solas (información o
 * guardar/restaurar estado). Un ok:true en ellas NO cuenta como progreso:
 * - git informativo (status/diff/log/...) lee el estado, no lo produce;
 * - git_stash guarda/restaura — el falso positivo del backlog 1.5: stash ok
 *   marcaba progreso y reseteaba el contador anti-estancamiento, permitiendo
 *   martillar la tool sin aviso.
 * NOTA: `read` SÍ cuenta como progreso por diseño (una lectura exitosa de un
 * archivo rompe la racha de fallas del anti-stuck; el agente está avanzando
 * en el contexto, no repitiendo la misma llamada fallida).
 */
const NO_PROGRESS_TOOLS = new Set([
  'git_status',
  'git_diff',
  'git_log',
  'git_show',
  'git_branch',
  'git_remote',
  'git_tag',
  'git_blame',
  'git_stash',
]);

/**
 * ¿Un resultado de herramienta marca progreso? Sí si terminó ok:true y la tool
 * NO es de soporte, o si el meta reporta un cambio real en el filesystem/estado
 * (p.ej. write/edit con changed:true). Un ok:false sin cambio real NO cuenta.
 */
function _marksProgress(result) {
  if (!result) return false;
  if (result.ok) return !NO_PROGRESS_TOOLS.has(result.tool);
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

/**
 * ¿Un comando de `exec` es de SOLO LECTURA y por tanto cacheable dentro del
 * run? Solo comandos que no mutan el filesystem ni el repo: su resultado no
 * puede cambiar salvo que otra tool modifique el estado (en ese caso el caché
 * se invalida). Comandos mutadores/informativos variables se ejecutan fresco.
 */
function _isCacheableExecCommand(command) {
  const cmd = String(command || '').trim();
  return (
    /^(?:ls|dir|pwd|which|whoami|uname)\b/.test(cmd) ||
    /^(?:git)\s+(?:status|log|diff|show|branch|remote|tag|blame)\b/.test(cmd)
  );
}

/** Escapa un path para usarlo como argumento de shell en comillas dobles. */
function _shellQuoteArg(value) {
  return '"' + String(value).replace(/["\\$`]/g, '\\$&') + '"';
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
// Iteraciones adaptativas: tope ABSOLUTO tras las extensiones (el presupuesto
// inicial se extiende de a bloques mientras el run muestra progreso sostenido).
const MAX_ITERATIONS_ABS = 40;
const RESULT_TRUNCATE_LIMIT = 4000;
const READ_RESULT_TRUNCATE_LIMIT = 8000;
const VERIFY_REPAIR_MAX_ROUNDS = 2;

// Self-critique (opcional, opts.selfCritique): al terminar el loop con una
// respuesta de texto, un paso extra le pide al LLM comparar el resultado
// contra la INTENCIÓN original del usuario (no solo criterios técnicos como
// tests/lint). Si el veredicto es INCOMPLETA y quedan iteraciones, el
// feedback vuelve al loop para corregir/continuar. Acotado para no abrir un
// bucle infinito.
const SELF_CRITIQUE_MAX_ROUNDS = 2;
// Web-verify: rondas máximas de corrección para páginas .html generadas.
const WEB_VERIFY_MAX_ROUNDS = 2;

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

// Plan explícito (opcional, opts.planning): para tareas complejas (smart +
// dificultad alta) se genera un plan de pasos ANTES de arrancar el bucle y se
// inyecta al prompt. El loop ejecuta anclado a ese plan; la reflexión compara
// contra él; el resultado expone cuántos pasos quedaron hechos.
const PLANNING_MAX_STEPS = 6;
const PLANNING_MIN_STEPS = 2;
const PLANNING_DIFFICULTY_THRESHOLD = 0.5;

// Bloques que AgentLoop añade al prompt DESPUÉS del ensamblado base. El
// truncado final (truncateSystemPrompt) delimita cada bloque e integra su
// prioridad con la memoria base. El catálogo se recorta como último recurso,
// contando TODO lo ensamblado (no solo el base).
const TAIL_SECTIONS = [
  { name: 'Lo aprendido (feedback)', marker: '# LO APRENDIDO (FEEDBACK)' },
  { name: 'Skills', marker: '---\n\n**Skills activas' },
  { name: 'Intenciones pendientes', marker: '# INTENCIONES ACTIVAS PENDIENTES' },
  { name: 'Memoria recall', marker: '# CONTEXTO RELEVANTE DE MEMORIA' },
  { name: 'Loop agente', marker: '# MODO AGENTE' },
  { name: 'Catálogo de tools', marker: '# HERRAMIENTAS DISPONIBLES' },
];

// Presupuesto del system prompt del MODO AGENTE. El prompt base de buildContext
// (identidad + comportamiento + contexto OS/memoria/episodios + MCP) ya ronda
// los ~10.5K chars; sumado a AGENT_LOOP_SYSTEM (~3.7K) + catálogo de tools
// (~8.6K) supera con holgura los 14K del presupuesto de chat, y el truncado
// eliminaba SIEMPRE "Loop agente" y "Catálogo de tools" → el modelo no sabía
// que podía usar herramientas y respondía sin ejecutar nada (tool_calls_total:
// 0 en producción). El modo agent tiene presupuesto propio y más amplio; chat/
// plan/execute conservan MAX_SYSTEM_CHARS (14K) intacto.
const AGENT_MAX_SYSTEM_CHARS = 40_000;

// G.1: compactación de contexto. Cuando la historia de iteraciones crece, los
// turnos viejos se condensan en un resumen determinista (no se re-envía todo
// el historial crudo a cada turno): el objetivo + lista de acciones ejecutadas.
const COMPACT_MIN_TURNS = 14; // tuplas de historial que disparan compactación
const COMPACT_KEEP_TAIL = 8; // turnos recientes que se conservan íntegros

/** Añade el paso del plan a cada schema sin modificar el catálogo compartido. */
function _withPlanStepSchemas(tools, plan) {
  if (!Array.isArray(tools) || !plan?.steps?.length) return tools;
  return tools.map((tool) => {
    const inputSchema = tool?.inputSchema || tool?.parameters;
    if (!inputSchema || inputSchema.type !== 'object') return tool;
    const patched = {
      ...inputSchema,
      properties: {
        ...(inputSchema.properties || {}),
        step_ordinal: {
          type: 'integer',
          minimum: 1,
          maximum: plan.steps.length,
          description: 'Número del paso del plan que esta llamada ejecuta o verifica.',
        },
      },
    };
    return tool.inputSchema ? { ...tool, inputSchema: patched } : { ...tool, parameters: patched };
  });
}

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
    let steps = Array.isArray(it.goal_plan) ? it.goal_plan : [];
    if (!steps.length && typeof it.steps === 'string') {
      try {
        steps = JSON.parse(it.steps);
      } catch (_) {}
    } else if (Array.isArray(it.steps)) {
      steps = it.steps;
    }
    const stepNames = steps
      .map((s) => {
        if (typeof s === 'string') return s;
        if (!s) return null;
        const label = s.description || s.label;
        return label ? `[${s.status || 'pending'}] ${label}` : null;
      })
      .filter(Boolean)
      .slice(0, 5);
    const progress = it.last_progress ? ` Progreso: ${it.last_progress}` : '';
    const stepLine = stepNames.length ? ` Pasos: ${stepNames.join(' → ')}` : '';
    const resume = it.resume_point?.step?.description
      ? ` Próximo foco: ${it.resume_point.step.description} (${it.resume_point.state}).`
      : '';
    const criteria = Array.isArray(it.resume_point?.step?.successCriteria)
      ? ` Criterios: ${it.resume_point.step.successCriteria.slice(0, 3).join('; ')}.`
      : '';
    lines.push(`- Meta: ${it.goal}${progress}${stepLine}${resume}${criteria}`);
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

Archivos MUY grandes (más de ~300 líneas): escribilos EN PARTES para no cortar
el contenido a mitad (un write enorme se puede truncar). Primero \`write\` con la
primera parte y luego \`write\` con el parámetro \`mode: "append"\` para el resto.
Nunca reescribas entero un archivo grande si solo cambia una parte: usá \`edit\`.

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
ACCIÓN: launch_app | APLICACIÓN: firefox
\`\`\`

\`\`\`action
ACCIÓN: open_website | SITIO: youtube | NAVEGADOR: firefox
\`\`\`

Para una petición compuesta de buscar y reproducir, usa una sola acción:
\`\`\`action
ACCIÓN: play_media | SERVICIO: youtube | QUERY: video de guitarra | CONTROL: managed
\`\`\`

Para una meta que encadena varios resultados en aplicaciones de escritorio,
usa \`desktop_mission\` con la meta completa, las aplicaciones del alcance y
pasos con postcondiciones observables. Interpreta la petición en el idioma del
usuario; no dependas de palabras clave. La misión se autoriza como conjunto y
solo se declara completa si cada postcondición aparece en el entorno real.
Para una única acción sencilla usa la herramienta directa.
Si el proveedor no admite llamadas nativas a herramientas, emite el plan
como JSON en un solo bloque de acción, por ejemplo:
\`\`\`action
ACCIÓN: desktop_mission
PARAMS: {"goal":"Abrir el informe y confirmar la cita","applications":["Editor","Agenda"],"steps":[{"description":"Abrir el informe en Editor","expected":{"type":"window_visible","application":"Editor","name":"Informe - Editor"}},{"description":"Confirmar la cita en Agenda","expected":{"type":"ui_visible","application":"Agenda","name":"Confirmada","role":"label"}}]}
\`\`\`

Para controlar una aplicación nativa en Linux o Windows, primero usa
\`desktop_snapshot\` (o \`window_list\`). Solo después usa la referencia \`ui-N\`
y el \`observationId\` devueltos con window_focus/ui_get_state/ui_click/ui_type/ui_press/
ui_select/ui_scroll/window_close. Usa \`ui_wait\` para esperar una postcondición y declara
\`expected\` siempre que sea
posible. Las referencias expiran y nunca debes inventarlas ni reutilizarlas
después de que cambie la interfaz.

Para controlar una web, primero usa \`browser\` con action=snapshot o tabs.
Las acciones que cambian la página deben repetir sessionId, pageId y
expectedOrigin exactamente como fueron observados. Después de cada acción,
observa otra vez antes de decidir la siguiente.

## Regla de modo: verificar ⇒ managed (C4)

\`open_website\` tiene dos modos con consecuencias distintas:
- \`CONTROL: external\` abre el navegador PERSONAL del usuario y Kaoru queda
  CIEGA (no ve ni puede leer la página). Úsalo SOLO para "solo ábrelo".
- \`CONTROL: managed\` (o la tool \`browser\` con mode=managed) usa el Chromium
  propio y VERIFICABLE de Kaoru. Úsalo SIEMPRE que debas leer, buscar o
  comprobar algo DENTRO de la página (precio, disponibilidad, texto, video).
Si la petición incluye "busca", "dime si", "verifica", "está disponible" o
"reproduce", NUNCA uses external: no podrías cumplirla.

## Receta: buscar un producto y verificar disponibilidad (shop-lookup)

Para "abre <tienda> y dime si <producto> está disponible / a qué precio":
1. \`open_website\` con el nombre de la tienda (se resuelve solo, no necesita URL).
2. \`browser\` mode=managed: snapshot → type en el buscador → click buscar.
3. \`browser\` get_text del resultado (precio/disponibilidad) y snapshot si hace falta.
4. Responde citando la evidencia (precio + URL). Si la página pide CAPTCHA o
   login, informa y deja el navegador abierto para continuar manual: nunca
   inventes disponibilidad.

## Receta: escribir en una app de escritorio (office-writer)

Para "abre <app> y escribe <texto>":
1. \`list_apps\` si no conoces el nombre exacto → \`launch_app\`.
2. Espera la ventana (\`window_list\`/\`desktop_snapshot\`) antes de actuar.
3. Escribe por bloques con \`ui_type\` sobre la referencia observada y verifica
   con \`ui_get_state\`/\`ui_wait\` (expected con el texto esperado).
4. Guarda y confirma el archivo en disco cuando aplique; si algo no se pudo
   verificar, dilo explícitamente en el cierre.

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
6. SI HAY UNA SECCIÓN "# PLAN DE EJECUCIÓN" EN EL PROMPT, EJECUTALA DIRECTAMENTE
   sin preguntar ni esperar confirmación: cada paso es una casilla "- [ ]" que
   debes completar en orden con tus herramientas, sin saltarte ninguno. Si una
   herramienta falla, corregí el error vos mismo y continuá con el paso (o la
   estrategia alternativa) — no te detengas a preguntar. Solo si un paso se
   vuelve inviable, replanificá y avisá.
7. USA HERRAMIENTAS SOLO CUANDO LA TAREA LO REQUIERA. Saludos, preguntas
   sobre ti mismo ("quién eres", tu identidad, tu personalidad), preguntas de
   conversación y dudas que ya puedes responder con lo que sabes se contestan
   DIRECTAMENTE, sin llamar ninguna herramienta. browser y web_search son
   SOLO para información externa actual que no puedes conocer (noticias,
   datos en vivo, páginas web). NO busques en internet cosas que ya sabes,
   como tu propia identidad — eso desperdicia recursos y el rate-limit.
8. DETENTE EN CUANTO LA TAREA PEDIDA ESTÉ COMPLETA. Si la acción que pidió
   el usuario terminó con éxito (p. ej. un push a git que confirma éxito, o
   un archivo escrito correctamente), tu turno TERMINA: responde confirmando
   y NO ejecutes más herramientas. No sigas "buscando más acciones", no
   repitas trabajo ya hecho y no hagas mejoras, refactors ni pasos extra que
   no te pidieron.
9. NO TOQUES ARCHIVOS QUE NO SON PARTE DE LA TAREA. Si el usuario pidió, por
   ejemplo, subir cambios a git, no edites código ni archivos del repo. Si en
   el camino ves un problema en algo no relacionado, menciónalo en la
   respuesta, pero NO lo arregles por tu cuenta — un edit no solicitado
   cuenta como salirse del alcance y consume llamadas innecesariamente.
10. MODIFICAR PARTES DE UN ARCHIVO EXISTENTE = edit, NO write. Cuando el
    archivo ya existe y solo hay que cambiar una o unas pocas líneas
    (color, texto, una función), usa \`\`\`action edit con old_text (fragmento
    EXACTO que ya está en el archivo) y new_text (el reemplazo). write es para
    archivos NUEVOS o para reescribir el archivo ENTERO cuando el cambio
    afecta la mayoría del contenido. Antes de decidir, lee el archivo con
    read_file si no conoces su contenido exacto.
11. VERIFICACIÓN CON HONESTIDAD EN EL CIERRE. Si intentaste verificar la
    tarea (con node -e, un test, typecheck, lint, un comando de ejecución...)
    y ese intento falló SIN un reintento que pasara, tu texto final DEBE
    decirlo explícitamente: qué lograste comprobar, qué falló y qué quedó SIN
    verificar. "Se ve bien" o "parece correcto" NO equivale a "se verificó":
    inspeccionar con read/head/grep nunca reemplaza una ejecución real que
    pasó. No afirmes que algo se "verificó" si la última ejecución real de la
    verificación terminó en error y no hubo un reintento exitoso — si no se
    pudo comprobar, decilo, no lo des por sentado.
12. SI TE FALTA UN DATO, PREGUNTA UNA COSA CONCRETA (en el idioma del
    usuario) en vez de adivinar: qué tienda, dónde guardar, cuál de las
    opciones que te devolvió una herramienta. Si el error de una herramienta
    lista candidatos ("Vi estas opciones: ..."), ofrécelos tal cual. Una
    pregunta curiosa y precisa vale más que tres acciones adivinadas.

## Verificar lógica JS sin shell

Para verificar fragmentos de JS usá \`node -e\` con el script entre comillas.
Podés escribir el script en VARIAS LÍNEAS dentro del COMANDO: el parser lo
preserva completo y el server lo evalúa vía stdin, así que las comillas
internas, backslashes de regex y operadores \`||\`/\`&&\`/\`;\` no se
corrompen:

\`\`\`action
ACCIÓN: run_command
COMANDO: node -e '
const a = 40 + 2;
if (a !== 42) process.exit(1);
console.log("ok");
'
\`\`\`

En un COMANDO de una sola línea separá las sentencias con punto y coma.
\`\\n\` dentro de un string JS es un escape válido, pero NO lo uses entre
sentencias (rompe la sintaxis). Evitá heredocs (\`cat > archivo << 'EOF'\`) y
pipelines/redirecciones largas: dependen de un shell real y son frágiles en
este entorno de ejecución.
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
    this._repositoryIntelligence =
      opts.repositoryIntelligence ||
      new RepositoryIntelligence({
        workspace: () => AP.PROJECT_CWD || process.cwd(),
        getSymbols: async (file) => {
          if (!this._lsp?.getDocumentSymbols) return [];
          try {
            return await this._lsp.getDocumentSymbols(file);
          } catch (_) {
            return [];
          }
        },
      });
    this._git = opts.git || getGitManager();
    this._github = opts.github || getGitHubManager();
    this._graph = opts.graph || null;
    this._mcp = opts.mcpManager || null;
    this._compactionPersisted = false;
    this._checkpoint = opts.checkpoint || null;
    this._manageCheckpoint = opts.manageCheckpoint !== false;
    this._telemetry = opts.telemetry || null;
    // Caché por-run de tools de solo lectura (read + exec read-only). Se
    // limpia al arrancar cada run y se invalida ante mutaciones (write/edit,
    // git, exec no-cacheable). Evita re-leer/re-ejecutar lo mismo en un run.
    this._readCache = new Map();
    this._execCache = new Map();
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

  // LLM para el fallback textual de un subagente según su perfil: 'fast'
  // bindea completeForMode con modo explícito (completeTask siempre es smart).
  _llmForMode(mode) {
    if (!mode || mode === 'smart' || mode === 'inherit') return this._getLLM();
    return LLMProvider.completeForMode.bind(LLMProvider, undefined, undefined, mode);
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
    // Debe existir antes de hooks y de _runInternal: el finally emite métricas
    // incluso si una excepción ocurre antes de entrar al bucle.
    this._metrics = new RunMetrics();
    const t0 = Date.now();
    let result;
    try {
      if (opts.pluginManager?.runHook && opts.beforeAgentRunHandled !== true) {
        await opts.pluginManager.runHook('beforeAgentRun', {
          mode: this._mode,
          taskIntent: opts.taskIntent || null,
        });
      }
      result = await this._runInternal(userMessage, systemPrompt, messages, opts);
      // Ledger por paso: una tool exitosa deja evidencia, pero solo completa
      // el paso si esa evidencia es compatible o el verificador la confirma.
      if (this._plan && result) {
        result.plan = {
          ...buildStepProgress(
            this._plan,
            Array.isArray(result.toolResults) ? result.toolResults : [],
            result.verify || null
          ),
          fallback: this._plan.fallback === true,
        };
        // Publica el ledger final después de aplicar la verificación. El último
        // evento emitido dentro del bucle puede preceder a esa verificación y
        // dejar el HUD visualmente incompleto aunque la tarea ya haya acabado.
        if (typeof opts.onPlan === 'function') {
          try {
            opts.onPlan({ kind: 'progress', ...result.plan, goalId: this._currentGoalId });
          } catch (_) {}
        }
      }
      if (result && this._steeringApplied > 0) {
        result.steering = { applied: this._steeringApplied };
      }
      // La ruta de producción exige una terminación demostrable: una respuesta
      // textual no puede cerrar una tarea si el ledger todavía tiene pasos o si
      // la verificación falló. Los tests/consumidores de AgentLoop pueden
      // conservar el contrato laxo omitiendo strictCompletion.
      if (opts.strictCompletion === true && result && !result.cancelled) {
        const expectedMutation = _expectsMutation(userMessage);
        const expectedObservableExecution = _expectsObservableExecution(userMessage);
        const successfulMutation = (result.toolResults || []).some(_isSuccessfulMutation);
        const successfulTool = (result.toolResults || []).some((item) => item?.ok);
        // Un plan parcialmente atribuido no basta por sí solo para declarar
        // fallo: un único verify global puede cubrir varias acciones. Sí es
        // fallo cuando la intención exigía mutar y no existe ninguna mutación
        // observable, que es el caso típico de la simulación textual.
        const incompletePlan =
          (expectedMutation && !successfulMutation) ||
          (expectedObservableExecution && !successfulTool);
        const failedVerification = result.verify?.status === 'failed';
        if (!result.error && (incompletePlan || failedVerification)) {
          const done = Number(result.plan?.done) || 0;
          const total = Number(result.plan?.total) || 0;
          const reason = failedVerification
            ? 'la verificación del proyecto falló'
            : `el plan quedó incompleto (${done}/${total} pasos)`;
          result.error = failedVerification ? 'verification_failed' : 'plan_incomplete';
          result.response =
            `${String(result.response || '').trim()}\n\n[Estado de ejecución: INCOMPLETA — ${reason}. La tarea permanece activa y se reanudará desde el siguiente paso verificable.]`.trim();
        }
      }
      if (
        opts.strictCompletion === true &&
        result &&
        this._plan &&
        (result.error || result.cancelled) &&
        !String(result.response || '').includes('se reanudará desde el siguiente paso')
      ) {
        const done = Number(result.plan?.done) || 0;
        const total = Number(result.plan?.total) || this._plan.steps.length;
        result.response =
          `${String(result.response || '').trim()}\n\n[Estado de ejecución: PAUSADA — ${done}/${total} pasos con evidencia. La tarea permanece activa y debe reanudarse desde el paso pendiente; no se simuló su finalización.]`.trim();
      }
      // Rollback transaccional opt-in. Solo se ejecuta si el usuario/config lo
      // habilitó, la verificación falló y el checkpoint afirma que es
      // reversible. La política no la decide el LLM.
      if (
        result?.verify?.status === 'failed' &&
        opts.rollbackOnVerificationFailure === true &&
        checkpoint
      ) {
        try {
          await checkpoint.finalize();
          const metadata = checkpoint.metadata();
          if (metadata?.canRevert) {
            const rollback = await checkpoint.revert(false);
            result.rollback = { attempted: true, ...rollback };
            if (rollback.ok) {
              result.response =
                `${String(result.response || '').trim()}\n\n[Rollback automático aplicado: los cambios de esta ejecución se revirtieron porque la verificación falló.]`.trim();
            }
          } else {
            result.rollback = {
              attempted: false,
              ok: false,
              reason: metadata?.reason || 'checkpoint_not_reversible',
            };
          }
        } catch (e) {
          result.rollback = { attempted: true, ok: false, error: String(e.message || e) };
          logger.warn('AgentLoop', `[rollback] no se pudo revertir el run: ${e.message}`);
        }
      }
      if (result) result.execution = _buildExecutionSummary(result, this._plan);
      if (opts.pluginManager?.runHook) {
        await opts.pluginManager.runHook('afterAgentRun', {
          result,
          mode: this._mode,
        });
      }
      return result;
    } finally {
      if (this._manageCheckpoint) {
        try {
          await checkpoint.finalize();
        } catch (e) {
          logger.warn('AgentLoop', `[checkpoint] finalize falló: ${e.message}`);
        }
      }
      // Instrumentación por-run: emite métricas de ejecución SIEMPRE (éxito,
      // error o cancelación), sin tocar el contrato del valor de retorno
      // (se agrega solo el campo extra `metrics` al resultado).
      this._emitRunMetrics({ result, t0 });
      if (opts.pluginManager?.runHook) {
        await opts.pluginManager.runHook('agentStop', {
          result: result || null,
          elapsedMs: Date.now() - t0,
        });
      }
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
    this._reportMode = Boolean(opts.reportMode);
    const domain = taskIntent?.domain || null;
    const llm = opts.llm || this._llm || this._getLLM();
    const parser = getStructuredActionParser(AP.PROJECT_CWD);
    // Streaming: opts.onToken(text) recibe los fragmentos del LLM en vivo
    // para pintarlos en el chat mientras se generan (patrón opencode).
    const onToken = typeof opts.onToken === 'function' ? opts.onToken : null;
    const signal = opts.signal || null;
    this._signal = signal;
    this._steeringApplied = 0;
    // Instrumentación por-run: acumuladores que se emiten al terminar (ver
    // _emitRunMetrics en run()). Por-instancia: los subagentes son otro
    // AgentLoop, así sus métricas no contaminan las del run padre.
    // Progreso de subagentes: si el padre lo suscribe, cada run anidado reporta
    // sus fases vía opts.onSubagentProgress (el padre lo re-emite con el nombre
    // del perfil).
    this._onSubagentProgress =
      typeof opts.onSubagentProgress === 'function' ? opts.onSubagentProgress : null;
    // Gate de herramientas por perfil de subagente: si está definido, las tools
    // fuera del conjunto se bloquean en runtime (defensa en profundidad sobre el
    // filtrado de schemas/catálogo).
    this._allowedToolNames = opts.allowedToolNames instanceof Set ? opts.allowedToolNames : null;
    this._readCache.clear();
    this._execCache.clear();
    // Verificación forzada y reflexión intermedia: se capturan para que los
    // runs anidados (subagentes) hereden la misma política.
    this._verifyPlan = opts.verify || null;
    this._reflectionOpt = opts.reflection || null;
    this._currentToolResolver = opts.toolResolver || null;
    this._currentPermissionManager = opts.permissionManager || null;
    this._currentPluginManager = opts.pluginManager || null;
    this._currentSkillManager = opts.skillManager || null;
    this._currentSkillDb = opts.skillDb || null;
    const contextTokens = Number(opts.contextWindowTokens || 0);
    this._historyCharBudget =
      contextTokens > 0 ? Math.max(12_000, Math.floor(contextTokens * 4 * 0.45)) : 48_000;
    this._currentGoalId = Number(opts.currentGoalId) || null;
    this._currentOnPlan = typeof opts.onPlan === 'function' ? opts.onPlan : null;
    const llmOpts = onToken ? { onToken } : {};
    if (signal) llmOpts.signal = signal;
    if (opts.temperature != null) llmOpts.temperature = opts.temperature;
    else if (this._mode === 'smart') llmOpts.temperature = 0.2;

    // ── Tool resolution (Fase 5): Skill > MCP > OpenClaw ────────────
    let tools = opts.tools || null;
    let toolCatalog = this._toolRegistry.serializeToPrompt(domain);
    let resolvedSkills = opts.matchedSkills || null;
    let nativeMcpMap = opts.nativeMcpMap || {};
    /** @type {string[]} */
    const injectedSkills = [];
    // Los subagentes con perfil restringido inyectan un catálogo YA filtrado
    // (las tools prohibidas no se anuncian en el prompt del run anidado).
    if (opts.toolCatalog) toolCatalog = opts.toolCatalog;
    const toolResolver = opts.toolResolver || null;

    if (toolResolver && !tools) {
      try {
        const resolved = await toolResolver.resolveToolset({
          userMessage,
          domain,
          toolRegistry: this._toolRegistry,
          skillManager: opts.skillManager || null,
          mcpManager: opts.mcpManager || null,
          db: opts.skillDb || null,
          matchedSkills: opts.matchedSkills || null,
          capabilityStatsProvider: opts.capabilityStatsProvider || null,
        });
        if (resolved.nativeToolSchemas) tools = resolved.nativeToolSchemas;
        if (resolved.promptCatalog) toolCatalog = resolved.promptCatalog;
        resolvedSkills = resolved.matchedSkills;
        nativeMcpMap = resolved.nativeMcpMap || {};
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
        const skillBlock = await skillManager.buildInjection(
          userMessage,
          opts.skillDb || null,
          resolvedSkills
        );
        if (skillBlock) {
          agentPrompt = agentPrompt + '\n\n' + skillBlock;
          // Nombres para los chips de resultado (skillManager.lastInjection
          // lo setea buildInjection justo arriba).
          if (Array.isArray(skillManager.lastInjection?.names)) {
            injectedSkills.push(...skillManager.lastInjection.names);
          }
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

    // Estado ejecutivo efímero de la sesión. Nunca concede permisos ni
    // sustituye una aprobación: solo recuerda el foco y su estado observable.
    if (typeof opts.workingMemorySection === 'string' && opts.workingMemorySection.trim()) {
      agentPrompt += '\n\n' + opts.workingMemorySection;
    }

    // ── Fase 3 ítem 2: lo aprendido (feedback de proactividad + outcomes de
    //    tareas). El LearningEngine lo produce; el loop lo anexa como el
    //    bloque opcional (se recorta después de memoria y episodios).
    if (typeof opts.learningSection === 'string' && opts.learningSection.trim()) {
      agentPrompt += '\n\n' + opts.learningSection;
    }

    // ── Truncado FINAL tras el ensamblado completo ────────────────────────
    // El presupuesto de MAX_SYSTEM_CHARS debe contar AGENT_LOOP_SYSTEM +
    // catálogo + recall + skills, no solo el systemPrompt base (que en modo
    // agent ya no se trunca en buildContext). Se eliminan bloques COMPLETOS
    // priorizando memoria, episodios y feedback antes que las herramientas,
    // sin borrar bloques posteriores al seleccionado.
    const systemBudget =
      contextTokens > 0
        ? Math.max(16_000, Math.min(120_000, Math.floor(contextTokens * 4 * 0.35)))
        : AGENT_MAX_SYSTEM_CHARS;
    agentPrompt = truncateSystemPrompt(agentPrompt, {
      max: systemBudget,
      tailSections: TAIL_SECTIONS,
    });

    // ── Idioma de respuesta (multilenguaje por inferencia) ────────────────
    // Se anexa DESPUÉS del truncado para garantizar su supervivencia: es una
    // línea, no compite por presupuesto. El protocolo de tools no cambia (la
    // línea lo dice explícitamente); solo mutan las palabras hacia el usuario.
    this._responseLanguage =
      opts.responseLanguage && typeof opts.responseLanguage === 'object'
        ? opts.responseLanguage
        : null;
    try {
      const { responseLanguageLine, localeFor } = require('../grounding/LanguageProfile.js');
      if (this._responseLanguage)
        agentPrompt += '\n\n' + responseLanguageLine(this._responseLanguage);
      const derived = localeFor(this._responseLanguage?.code || 'es');
      const BrowserBridge = require('./BrowserBridge.js');
      if (typeof BrowserBridge.setDefaultLocale === 'function') {
        BrowserBridge.setDefaultLocale(derived.locale);
      }
      if (this._bridge && typeof this._bridge.setLocaleHints === 'function') {
        this._bridge.setLocaleHints(derived.tldHints);
      }
    } catch (_) {
      require('../observability/SwallowedErrors.js').swallow('AgentLoop.language');
    }

    // ── Fase de plan explícito (mejora de calidad) ─────────────────────────
    // Toda tarea smart de la ruta de producción recibe un plan ANTES de
    // arrancar el bucle. Si el modelo no entrega pasos parseables o la llamada
    // falla, se usa un plan local conservador para no simular ejecución ni
    // perder el punto de reanudación.
    const storedGoalPlan = Array.isArray(opts.currentGoalPlan) ? opts.currentGoalPlan : [];
    this._plan = storedGoalPlan.length
      ? {
          steps: storedGoalPlan.map((step) => String(step.description || '')),
          criteria: storedGoalPlan.map((step) => String(step.successCriteria?.[0] || '')),
          stepStates: storedGoalPlan.map((step) => ({
            ordinal: Number(step.ordinal),
            status: String(step.status || 'pending'),
            evidence: Array.isArray(step.verification?.evidence) ? step.verification.evidence : [],
          })),
          text: this._renderPlanSection(
            storedGoalPlan.map((step) => String(step.description || '')),
            storedGoalPlan.map((step) => String(step.successCriteria?.[0] || ''))
          ),
        }
      : null;
    // Tool de alto impacto cuya aprobación expiró (sin respuesta del usuario a
    // tiempo) en este run. Si el run cierra con texto, el aviso se anexa a la
    // respuesta final: nunca puede sonar a "todo listo" si una acción quedó
    // denegada por timeout sin que el usuario lo supiera activamente.
    this._approvalExpiredTool = null;
    let repositorySnapshot = '';
    if (!this._plan && this._shouldPlan(userMessage, taskIntent, opts)) {
      repositorySnapshot = await this._buildRepositorySnapshot(userMessage);
      this._repositorySnapshot = repositorySnapshot;
      if (typeof opts.onPlan === 'function') {
        try {
          opts.onPlan({ kind: 'reconnaissance', summary: repositorySnapshot });
        } catch (_) {}
      }
    }
    if (this._plan) {
      agentPrompt += '\n\n' + this._plan.text;
      if (typeof opts.onPlan === 'function') {
        try {
          const done = this._plan.stepStates.filter((step) => step.status === 'completed').length;
          opts.onPlan({
            kind: 'resumed',
            goalId: this._currentGoalId,
            steps: this._plan.steps,
            criteria: this._plan.criteria,
            stepStates: this._plan.stepStates,
            done,
            total: this._plan.steps.length,
          });
        } catch (_) {}
      }
      logger.info(
        'AgentLoop',
        `[agent-loop] retomando plan persistente de ${this._plan.steps.length} pasos`
      );
    } else if (this._shouldPlan(userMessage, taskIntent, opts)) {
      try {
        let plan = await this._buildPlan({
          userMessage,
          taskIntent,
          toolCatalog,
          llm,
          llmOpts,
          signal,
          repositorySnapshot,
        });
        if (!plan) {
          plan = this._buildFallbackPlan({ userMessage, taskIntent });
          logger.warn('AgentLoop', '[agent-loop] proveedor sin plan válido; usando plan local');
        }
        if (plan && plan.steps && plan.steps.length) {
          this._plan = plan;
          agentPrompt = agentPrompt + '\n\n' + plan.text;
          if (opts.currentGoalId && this._graph?.createGoalPlan) {
            this._graph.createGoalPlan(
              Number(opts.currentGoalId),
              plan.steps.map((description, index) => ({
                description,
                successCriteria: plan.criteria[index] ? [plan.criteria[index]] : [],
              }))
            );
          }
          logger.info(
            'AgentLoop',
            `[agent-loop] plan de ${plan.steps.length} pasos generado e inyectado`
          );
          // Plan visible en el chat (opts.onPlan): el payload con los pasos se
          // reenvía al renderer para pintar el HUD de progreso mientras corre.
          if (typeof opts.onPlan === 'function') {
            try {
              opts.onPlan({
                kind: 'created',
                goalId: this._currentGoalId,
                steps: plan.steps,
                criteria: plan.criteria,
                done: 0,
                total: plan.steps.length,
                fallback: plan.fallback === true,
              });
            } catch (_) {
              logger.debug('AgentLoop', 'emitión de progress falló');
            }
          }
        }
      } catch (e) {
        if (e?.code === 'ABORTED' || e?.name === 'AbortError') {
          this._plan = this._buildFallbackPlan({ userMessage, taskIntent });
          if (opts.currentGoalId && this._graph?.createGoalPlan) {
            this._graph.createGoalPlan(
              Number(opts.currentGoalId),
              this._plan.steps.map((description, index) => ({
                description,
                successCriteria: this._plan.criteria[index] ? [this._plan.criteria[index]] : [],
              }))
            );
          }
          return this._makeAbortResponse(0, []);
        }
        logger.warn('AgentLoop', `[agent-loop] planificación falló: ${e.message}`);
        this._plan = this._buildFallbackPlan({ userMessage, taskIntent });
        agentPrompt += '\n\n' + this._plan.text;
        if (opts.currentGoalId && this._graph?.createGoalPlan) {
          this._graph.createGoalPlan(
            Number(opts.currentGoalId),
            this._plan.steps.map((description, index) => ({
              description,
              successCriteria: this._plan.criteria[index] ? [this._plan.criteria[index]] : [],
            }))
          );
        }
      }
    }
    tools = _withPlanStepSchemas(tools, this._plan);
    this._currentTools = tools;
    this._currentNativeMcpMap = nativeMcpMap;

    const iterationHistory = [...(messages || [])];
    const desktopMissionReviews = new Map();
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
    // Guarda determinista: una petición imperativa de cambio no puede cerrarse
    // después de sólo leer/listar o de una tool fallida. Es independiente de
    // selfCritique para que también proteja el modo fast.
    let mutationFollowThroughRounds = 0;
    let observableFollowThroughRounds = 0;
    // Verificación de artefactos (web + sintaxis universal): rondas de
    // corrección cuando archivos mutados fallan validación al cierre.
    let webVerifyRounds = 0;
    const mutationJournal = new MutationJournal({ cwd: AP.PROJECT_CWD });
    /** @type {Set<string>} rutas absolutas de TODOS los archivos mutados con éxito */
    const mutatedFiles = mutationJournal.files;
    // Reflexión intermedia (opts.reflection): fallas de herramientas
    // acumuladas en este run y rondas de reflexión agotadas.
    let toolFailures = 0;
    let reflectionRounds = 0;
    let failuresAtLastReflection = 0;
    let verifyRepairRounds = 0;
    const runStartedAt = Date.now();
    const maxElapsedMs = Math.max(0, Number(opts.maxElapsedMs) || 0);
    const maxToolCalls = Math.max(0, Number(opts.maxToolCalls) || 0);

    for (let i = 0; i < this.maxIterations; i++) {
      if (
        (maxElapsedMs > 0 && Date.now() - runStartedAt >= maxElapsedMs) ||
        (maxToolCalls > 0 && toolResults.length >= maxToolCalls)
      ) {
        return {
          response:
            lastResponseText ||
            'La ejecución alcanzó el presupuesto configurado antes de completar la tarea.',
          iterations: i,
          toolResults,
          error: 'budget_exhausted',
          budget: {
            elapsedMs: Date.now() - runStartedAt,
            toolCalls: toolResults.length,
            maxElapsedMs: maxElapsedMs || null,
            maxToolCalls: maxToolCalls || null,
          },
        };
      }
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
      // Steering en caliente: las correcciones del usuario se consumen SOLO
      // entre iteraciones, nunca en mitad de una tool. No conceden permisos ni
      // reemplazan el plan durable; se agregan como restricciones/prioridades
      // para la siguiente decisión del modelo.
      if (typeof opts.consumeSteering === 'function') {
        let steeringUpdates = [];
        try {
          const consumed = opts.consumeSteering();
          steeringUpdates = Array.isArray(consumed) ? consumed : [];
        } catch (e) {
          logger.warn('AgentLoop', `[steering] no se pudo consumir la cola: ${e.message}`);
        }
        for (const update of steeringUpdates.slice(0, 20)) {
          const text = String(update?.text || update || '')
            .trim()
            .slice(0, 4000);
          if (!text) continue;
          iterationHistory.push({
            role: 'user',
            content:
              `[ACTUALIZACIÓN DEL USUARIO DURANTE LA EJECUCIÓN]\n${text}\n\n` +
              'Integra esta prioridad o restricción en el plan activo. No la interpretes como aprobación de herramientas ni como permiso para omitir verificaciones.',
          });
          this._steeringApplied++;
          if (typeof opts.onProgress === 'function') {
            try {
              opts.onProgress({
                iteration: i + 1,
                phase: 'steering',
                status: 'applied',
                count: this._steeringApplied,
              });
            } catch (_) {}
          }
        }
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
            return this._makeAbortResponse(i + 1, toolResults);
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
              return this._makeAbortResponse(i + 1, toolResults);
            }
            return {
              response: this._withExpiredApprovalNotice(
                this._completedSummary(toolResults) +
                  `La ejecución se detuvo porque el proveedor no pudo generar la respuesta final. Detalle: ${e2.message}`
              ),
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
            return this._makeAbortResponse(i + 1, toolResults);
          }
          return {
            response: this._withExpiredApprovalNotice(
              this._completedSummary(toolResults) +
                `La ejecución se detuvo porque el proveedor no pudo generar la respuesta final. Detalle: ${e.message}`
            ),
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
            response: this._withExpiredApprovalNotice('El modelo no respondió.'),
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
        actions = toolCalls.map((tc) => _nativeToolCallToAction(tc, nativeMcpMap));
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

      // Las interfaces cambian después de cada acción. Ejecutar varias tools UI
      // decididas sobre la misma captura usa estado obsoleto y produce clics
      // incorrectos. El loop conserva una sola acción UI por iteración para que
      // el modelo observe su resultado antes de decidir la siguiente.
      const firstUiAction = actions.find((action) => UI_TOOLS.has(action.tool));
      if (firstUiAction) actions = [firstUiAction];

      if (actions.length === 0) {
        const latestMission = toolResults
          .filter((result) => result?.tool === 'desktop_mission')
          .at(-1);
        if (latestMission && !latestMission.ok) {
          const state = latestMission.result || {};
          const completed = Math.max(0, Number(state.completed) || 0);
          const total = Math.max(completed, Number(state.total) || 0);
          const resumePoint = Number(state.resumePoint) || completed + 1;
          return {
            response: `La misión de escritorio quedó ${state.status === 'cancelled' ? 'cancelada' : 'pausada'}: ${completed}/${total} resultados verificados. Paso pendiente: ${resumePoint}. Motivo: ${latestMission.error || 'verificación pendiente'}.`,
            iterations: i + 1,
            toolResults,
            error: 'desktop_mission_incomplete',
          };
        }
        const mutationExpected = !opts.reportMode && _expectsMutation(userMessage);
        const observableExpected = !opts.reportMode && INTERACTIVE_ACTION_RE.test(userMessage);
        const mutationObserved = toolResults.some(_isSuccessfulMutation);
        const mediaPlaybackExpected =
          observableExpected && /\b(youtube|video|m[uú]sica|canci[oó]n)\b/i.test(userMessage);
        const observableExecutionObserved = mediaPlaybackExpected
          ? toolResults.some(
              (result) =>
                result?.ok && result?.tool === 'play_media' && result?.result?.verified === true
            )
          : toolResults.some(_isVerifiedInteractiveResult);
        const permissionStopped = toolResults.some(
          (result) =>
            !result?.ok &&
            /deneg|rechaz|approval|aprobaci[oó]n|permiso/i.test(String(result?.error || ''))
        );
        if (
          mutationExpected &&
          !mutationObserved &&
          !permissionStopped &&
          mutationFollowThroughRounds < MUTATION_FOLLOW_THROUGH_MAX_ROUNDS &&
          i + 1 < this.maxIterations
        ) {
          mutationFollowThroughRounds++;
          iterationHistory.push({
            role: 'user',
            content:
              '[CUMPLIMIENTO PENDIENTE] La petición original exige un cambio observable, pero ninguna herramienta de mutación terminó correctamente. ' +
              'No cierres con una explicación ni declares que terminaste: revisa los resultados, cambia de estrategia y usa una herramienta disponible de escritura/edición. ' +
              'La autorización y ejecución siguen a cargo de Kaoru.',
          });
          logger.warn(
            'AgentLoop',
            `[agent-loop] cambio solicitado sin mutación exitosa — replanteo ${mutationFollowThroughRounds}/${MUTATION_FOLLOW_THROUGH_MAX_ROUNDS}`
          );
          continue;
        }
        if (
          observableExpected &&
          !observableExecutionObserved &&
          !permissionStopped &&
          observableFollowThroughRounds < MUTATION_FOLLOW_THROUGH_MAX_ROUNDS &&
          i + 1 < this.maxIterations
        ) {
          observableFollowThroughRounds++;
          iterationHistory.push({
            role: 'user',
            content:
              '[EJECUCIÓN PENDIENTE] La petición original exige una acción observable, pero todavía no ejecutaste ninguna herramienta correctamente. ' +
              'No respondas con conversación genérica ni pidas repetir la solicitud: selecciona la herramienta adecuada del catálogo y ejecútala. ' +
              'Para buscar y reproducir un video de YouTube usa play_media con control managed en una sola llamada. Abrir la portada o los resultados no completa la reproducción.',
          });
          logger.warn(
            'AgentLoop',
            `[agent-loop] acción observable sin tool exitosa — replanteo ${observableFollowThroughRounds}/${MUTATION_FOLLOW_THROUGH_MAX_ROUNDS}`
          );
          continue;
        }

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

        // ── Verificación de artefactos (web + sintaxis universal) ──────────
        // Si el run mutó archivos, se validan ANTES de declarar la tarea
        // lista: .html en Chromium (web-verify) y el resto por extensión
        // (syntax-verify: py/json/sh/css/ts/yaml/js). Con fallos → feedback
        // al loop para que el modelo CORRIJA (máx WEB_VERIFY_MAX_ROUNDS).
        // Caso Pac-Man: juego injugable entregado como terminado — esto lo
        // detecta y obliga a arreglarlo. Caso calcular.py roto: igual.
        const htmlFiles = [];
        const codeFiles = [];
        for (const f of mutatedFiles) {
          if (/\.html?$/i.test(f)) htmlFiles.push(f);
          else codeFiles.push(f);
        }
        if (
          (htmlFiles.length > 0 || codeFiles.length > 0) &&
          webVerifyRounds < WEB_VERIFY_MAX_ROUNDS &&
          !opts.reportMode &&
          opts.webVerify !== false &&
          !(signal && signal.aborted)
        ) {
          webVerifyRounds++;
          const [webCheck, synCheck] = await Promise.all([
            htmlFiles.length ? verifyHtmlFiles(htmlFiles) : null,
            codeFiles.length ? verifySyntax(codeFiles) : null,
          ]);
          const failures = [];
          if (webCheck && webCheck.ok === false) {
            const bad = webCheck.results.find((r) => !r.ok && !r.skipped);
            if (bad)
              failures.push(
                `PÁGINA WEB "${bad.file}" falla al abrirse:\n${(bad.errors || [])
                  .slice(0, 5)
                  .map((e) => `- ${e}`)
                  .join('\n')}`
              );
          }
          if (synCheck && synCheck.ok === false) {
            for (const r of synCheck.results) {
              if (!r.ok && !r.skipped)
                failures.push(
                  `ARCHIVO "${r.file}" (${r.ext}) tiene errores de sintaxis:\n${(r.errors || [])
                    .slice(0, 3)
                    .map((e) => `- ${e}`)
                    .join('\n')}`
                );
            }
          }
          if (failures.length > 0) {
            logger.warn(
              'AgentLoop',
              `[agent-loop] verificación de artefactos FALLÓ (${failures.length}) — ronda ${webVerifyRounds}/${WEB_VERIFY_MAX_ROUNDS}, pidiendo corrección`
            );
            iterationHistory.push({
              role: 'user',
              content:
                `[VERIFICACIÓN AUTOMÁTICA DE ARCHIVOS FALLÓ]\n` +
                `${failures.join('\n\n')}\n\n` +
                `Leé los archivos involucrados, corregí las causas (edit/write) y volvé a dar tu respuesta final. ` +
                `No declares que está terminado sin corregir estos errores.`,
            });
            // Continúa el loop: el próximo turno del LLM ve el feedback y corrige.
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
        if (
          verify?.status === 'failed' &&
          opts.verifyRepair === true &&
          !opts.reportMode &&
          verifyRepairRounds < VERIFY_REPAIR_MAX_ROUNDS &&
          i + 1 < this.maxIterations &&
          !(signal && signal.aborted)
        ) {
          verifyRepairRounds++;
          iterationHistory.push({
            role: 'user',
            content:
              `[VERIFICACIÓN DEL PROYECTO FALLÓ — reparación ${verifyRepairRounds}/${VERIFY_REPAIR_MAX_ROUNDS}]\n` +
              `Comando: ${verify.command || 'desconocido'}\n` +
              `Salida relevante:\n${verify.stderr || '(sin stderr)'}\n\n` +
              'Inspecciona la causa, corrige los archivos necesarios y vuelve a ejecutar la verificación. No cierres la tarea mientras siga fallando.',
          });
          logger.warn(
            'AgentLoop',
            `[agent-loop] verify falló — reparación ${verifyRepairRounds}/${VERIFY_REPAIR_MAX_ROUNDS}`
          );
          continue;
        }
        // En reportMode (subagente) el aviso NO se mete en el texto del reporte:
        // contaminaría el audit de resumen (el comando incluye nombres de
        // archivo). El estado viaja en `result.verify` y el padre decide.
        if (verify && verify.status === 'failed' && !opts.reportMode) {
          responseText += buildVerifyFailureNotice(verify);
        }
        // Auditoría BUG-1: verificación determinista de promesas vs realidad —
        // si el texto final afirma ediciones pero CERO mutaciones tuvieron
        // éxito en el run, se marca y se advierte al usuario (el caso
        // "¡Listo! 🌟" sin haber editado nada).
        const falseClaim = _detectUnverifiedEditClaims(responseText, toolResults);
        let response = this._withExpiredApprovalNotice(responseText);
        if (falseClaim) {
          logger.warn(
            'AgentLoop',
            `[agent-loop] ⚠ respuesta promete ediciones (${falseClaim}) sin NINGUNA mutación exitosa en el run`
          );
          response +=
            '\n\n[NOTA DEL SISTEMA: esta respuesta afirma cambios que NO se ejecutaron — verificado por el pipeline. Pedí que lo haga de nuevo o revisá manualmente.]';
        }
        return {
          response,
          iterations: i + 1,
          toolResults,
          verify,
          unverifiedEdits: falseClaim || undefined,
          skillsUsed: injectedSkills.slice(0, 5),
          artifactRounds: webVerifyRounds,
          mutationJournal: mutationJournal.toJSON(),
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
        if (maxToolCalls > 0 && toolResults.length >= maxToolCalls) break;
        if (
          action.tool === 'desktop_mission' &&
          action.params &&
          typeof action.params === 'object'
        ) {
          // El modelo define el plan, pero la meta autorizada siempre es la
          // petición original; un plan influido por contenido externo no puede
          // sustituir lo que el usuario pidió en el diálogo de autorización.
          action.params = {
            ...action.params,
            goal: opts.originalUserMessage || userMessage,
          };
          const {
            reviewMissionPlan,
            validatePlanReview,
          } = require('../desktop/MissionPlanReviewer.js');
          const reviewKey = JSON.stringify(action.params);
          let review = desktopMissionReviews.get(reviewKey);
          if (!review) {
            const rawReview = await (opts.reviewDesktopMissionPlan || reviewMissionPlan)(
              action.params,
              {
                signal,
              }
            );
            review = validatePlanReview(
              rawReview,
              Array.isArray(action.params.steps) ? action.params.steps.length : 0
            );
            desktopMissionReviews.set(reviewKey, review);
          }
          if (review.covered !== true) {
            const gaps = [
              ...(review.gaps || []),
              ...(review.weakSteps || []).map((n) => `Paso ${n}`),
            ]
              .slice(0, 8)
              .join('; ');
            const feedback =
              `[Misión de escritorio bloqueada antes de pedir autorización: ` +
              `${review.error || 'mission_plan_incomplete'}. ${gaps || 'Revisa cobertura y resultados observables.'} ` +
              `Reformula el plan completo y sus postcondiciones.]`;
            iterationHistory.push({ role: 'user', content: feedback });
            lastToolResult = {
              ok: false,
              error: review.error || 'mission_plan_incomplete',
              tool: 'desktop_mission',
            };
            continue;
          }
        }
        const assessment = assessAction(action, {
          permissionManager: opts.permissionManager || null,
          workspace: AP.PROJECT_CWD || process.cwd(),
          missionGrant: opts.missionGrant || null,
          forceApproval:
            action.tool === 'desktop_mission' ||
            Boolean(opts.missionGrant && !opts.missionGrant.allows(action)),
        });
        const { requiresApproval, permissionAction } = assessment;
        // Instrumentación: cada tool solicitada por el agente cuenta (aunque
        // luego se bloquee/deniegue/cancele — igual fue pedida).
        this._metrics.trackTool(action.tool);

        // ── Gate de herramientas por perfil de subagente ─────────────────────
        // Los subagentes con tools restringidas (explorador/investigador) solo
        // pueden ejecutar tools permitidas, aunque el parser o el LLM intente
        // llamar otra (defensa en profundidad sobre el catálogo filtrado).
        if (this._allowedToolNames && !this._allowedToolNames.has(action.tool)) {
          iterationHistory.push({
            role: 'user',
            content: `[Herramienta "${action.tool}" no está permitida en este perfil de subagente — continúa sin ella o busca otra estrategia]`,
          });
          lastToolResult = {
            ok: false,
            error: 'bloqueada_por_perfil',
            tool: action.tool,
          };
          continue;
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

        // ── Vista previa de diff (aprobación informada) ─────────────────────
        // Para mutaciones de archivos (write/edit/apply_patch) se calcula en
        // memoria el diff real ANTES de pedir aprobación, y se adjunta al
        // action para que onApprovalNeeded lo incluya en el card. Nunca
        // bloquea ni es prerequisito de seguridad: si falla o da null (edit
        // ambiguo, patch que no aplica) la aprobación sigue, y la UI lo
        // comunica como "vista previa no disponible".
        if (MUTATOR_TOOLS.has(action.tool) && action._diffPreview === undefined) {
          try {
            action._diffPreview = computeDiffPreview({
              tool: action.tool,
              params: action.params,
              cwd: AP.PROJECT_CWD,
            });
          } catch (e) {
            logger.warn(
              'AgentLoop',
              `[diff-preview] falló el cálculo para ${action.tool}: ${e.message}`
            );
            action._diffPreview = null;
          }
        }

        const approval = await requestActionApproval(assessment, action, {
          onApprovalNeeded: opts.onApprovalNeeded,
          missionGrant: opts.missionGrant || null,
        });
        if (approval.prompted) this._metrics.trackApproval(approval.approved);
        if (!approval.approved && approval.reason === 'approval_handler_missing') {
          iterationHistory.push({
            role: 'user',
            content: `[Herramienta "${action.tool}" requiere aprobación pero no hay handler — BLOQUEADA. Continúa sin ella o informa que no puedes ejecutarla.]`,
          });
          lastToolResult = { ok: false, error: 'sin_handler_aprobacion', tool: action.tool };
          continue;
        }
        if (!approval.approved) {
          const isTimeout = approval.reason === 'timeout';
          if (isTimeout) this._approvalExpiredTool = action.tool;
          iterationHistory.push({
            role: 'user',
            content: isTimeout
              ? `[La herramienta "${action.tool}" NO se ejecutó: el tiempo de aprobación expiró sin tu respuesta — continúa sin ella o busca otra estrategia]`
              : `[Herramienta "${action.tool}" cancelada por el usuario — continúa sin ella o busca otra estrategia]`,
          });
          lastToolResult = {
            ok: false,
            error: isTimeout ? 'aprobacion_expirada' : 'cancelada_por_usuario',
            tool: action.tool,
          };
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
        if (isMutatingAction(action)) {
          try {
            const mutationPaths = extractMutationPaths(action, AP.PROJECT_CWD);
            if (mutationPaths.length > 0) {
              for (const mutationPath of mutationPaths) {
                await this._activeCheckpoint.onBeforeMutation({
                  tool: 'write',
                  params: { path: mutationPath },
                });
              }
            } else if (typeof this._activeCheckpoint.onBeforeUnknownMutation === 'function') {
              await this._activeCheckpoint.onBeforeUnknownMutation();
            }
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
          } else if (action.tool === 'subagent_batch') {
            result = await this._executeSubagentBatch(action);
          } else if (SUBAGENT_TOOLS.has(action.tool)) {
            result = await this._executeSubagent(action);
          } else if (action.tool === 'mcp') {
            // Pseudo-tool MCP (de mcp_call / MCP_TOOL en fallback textual):
            // va a MCPManager, NUNCA a OpenClawBridge.
            result = await this._executeMCP(action, signal);
          } else if (action.tool === 'plugin') {
            // Pseudo-tool de plugins (de plugin_call en fallback textual).
            result = await this._executePlugin(action);
          } else if (action._needsInstructionResolve) {
            result = await this._executeResolvedEdit(action);
          } else if (action.tool === 'memory_search') {
            // Memory tool: search in Kaoru's memory
            result = await this._executeMemorySearch(action);
          } else if (action.tool === 'memory_log_interaction') {
            // Memory tool: log user interaction
            result = await this._executeMemoryLogInteraction(action);
          } else if (action.tool === 'desktop_mission') {
            const { DesktopMissionLoop } = require('../desktop/DesktopMissionLoop.js');
            const mission = new DesktopMissionLoop({ bridge: this._bridge, graph: this._graph });
            const missionResult = await mission.run(action.params, {
              planReview: desktopMissionReviews.get(JSON.stringify(action.params)),
              systemPrompt,
              messages,
              llm: opts.llm,
              signal,
              permissionManager: opts.permissionManager || null,
              onApprovalNeeded: opts.onApprovalNeeded,
              onProgress: opts.onProgress,
              onPlan: opts.onPlan,
              sessionId: opts.sessionId || '',
              workspace: opts.workspace || AP.PROJECT_CWD || process.cwd(),
            });
            result = {
              ok: missionResult.status === 'completed',
              result: missionResult,
              error: missionResult.status === 'completed' ? null : missionResult.error,
              tool: 'desktop_mission',
              elapsed: missionResult.elapsedMs || 0,
            };
          } else if (action.tool === 'read') {
            // Caché por-run de read: mismo archivo + encoding devuelve el
            // mismo resultado mientras no se mute ese archivo (la
            // invalidación borra la entrada en write/edit/apply_patch).
            result = await this._cachedRead(action);
          } else if (action.tool === 'exec') {
            // Caché por-run de exec SOLO LECTURA (ls/pwd/which/git status...).
            // Comandos mutadores se ejecutan fresco e invalidan el caché.
            result = await this._cachedExec(action);
          } else {
            result = await this._bridge.execute(action.tool, action.params);
          }
        } catch (e) {
          result = { ok: false, error: e.message, result: null, tool: action.tool, elapsed: 0 };
        }

        if (opts.pluginManager?.runHook) {
          await opts.pluginManager.runHook(result.ok ? 'afterTool' : 'afterToolFailure', {
            tool: action.tool,
            params: action.params,
            result,
          });
        }

        if (SUBAGENT_TOOLS.has(action.tool)) {
          const nestedJournal = result?.result?.mutationJournal;
          mutationJournal.merge(nestedJournal, action.tool);
          for (const file of nestedJournal?.files || []) mutatedFiles.add(path.resolve(file));
        }

        // ── Invalidación del caché de solo-lectura ─────────────────────────
        // Una mutación real (write/edit/apply_patch, git, cualquier exec no
        // cacheable con éxito) puede cambiar el filesystem o el repo: el
        // resultado cacheado (read del archivo, git status/log) quedaría
        // viejo. Solo se invalida ante éxito; un fallo no cambia el estado.
        if (result && result.ok) {
          mutationJournal.record(result, action);
          if (isMutatingAction(action)) {
            this._repositoryIntelligence?.invalidate?.(
              extractMutationPaths(action, AP.PROJECT_CWD || process.cwd())
            );
          }
          // Verificación de artefactos: rastrear TODOS los archivos mutados.
          // Caso exec: los LLMs suelen crear archivos con redirecciones
          // (`echo '{...}' > config.json`) — se detectan por patrón.
          if (action.tool === 'exec') {
            const cmd = String(action.params?.command || '');
            const redir = cmd.match(
              />\s*(\S+\.(html?|json|py|js|mjs|cjs|sh|bash|css|ts|tsx|ya?ml))\b/i
            );
            if (redir) {
              const target = redir[1].replace(/^["']|["']$/g, '');
              try {
                mutatedFiles.add(
                  require('path').isAbsolute(target)
                    ? require('path').resolve(target)
                    : require('path').resolve(AP.PROJECT_CWD || process.cwd(), target)
                );
              } catch {}
            }
          }
          if (isMutatingAction(action)) {
            this._execCache.clear();
            const p = action.params?.path || action.params?.filePath || '';
            // Verificación de artefactos: rastrear TODOS los archivos mutados
            // (.html → web-verify en Chromium; resto → sintaxis por extensión).
            if (p) {
              try {
                mutatedFiles.add(require('path').resolve(p));
              } catch {}
            }
            for (const k of Array.from(this._readCache.keys())) {
              if (k.endsWith(`::${p}`)) this._readCache.delete(k);
            }
          } else if (GIT_TOOLS.has(action.tool) || GITHUB_TOOLS.has(action.tool)) {
            this._execCache.clear();
          }
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
        let syntaxError = null;
        if (result.ok && EDIT_TOOLS.has(action.tool)) {
          lspFeedback = await this._lspFeedbackForEdit(result, action);
          if (lspFeedback && lspFeedback.diagnostics && lspFeedback.diagnostics.length > 0) {
            result.lspDiagnostics = lspFeedback.diagnostics;
          }
          // El LSP y el parser son oráculos complementarios: checkJs puede no
          // marcar ciertas construcciones inválidas para el runtime. Ejecutar
          // siempre el chequeo sintáctico barato evita aceptar un falso verde.
          syntaxError = await this._syntaxCheckForEdit(
            action.params?.path || action.params?.filePath
          );
          if (syntaxError) result.syntaxError = syntaxError;
        }

        let resultSummary;
        if (result.ok) {
          resultSummary = this._summarizeResult(result, action);
          if (lspFeedback && lspFeedback.diagnostics && lspFeedback.diagnostics.length > 0) {
            resultSummary +=
              '\n\n' + this._formatDiagnostics(lspFeedback.filePath, lspFeedback.diagnostics);
            if (lspFeedback.stale) {
              resultSummary +=
                '\n[NOTA: el LSP aún no terminó de analizar el cambio — estos diagnósticos pueden estar desactualizados.]';
            }
          } else if (lspFeedback && lspFeedback.stale) {
            // Cache vacía + timeout = "aún sin datos", NO "sin errores".
            resultSummary +=
              '\n[LSP: el análisis post-edición no llegó a tiempo — no asumas que el archivo está libre de errores; verifica con get_diagnostics si es crítico.]';
          }
          if (syntaxError) {
            resultSummary += '\n\n' + syntaxError;
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
        resultSummaries.push(
          `${action.callId ? `[tool_call_id=${action.callId}] ` : ''}${resultSummary}`
        );
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
          plan: this._plan || null,
        });
        if (reflection && reflection.verdict === 'CAMBIAR_PLAN' && !(signal && signal.aborted)) {
          reflectionRounds++;
          failuresAtLastReflection = toolFailures;
          const replacement = await this._buildPlan({
            userMessage,
            taskIntent,
            toolCatalog,
            llm,
            llmOpts,
            signal,
            repositorySnapshot: this._repositorySnapshot || repositorySnapshot,
            correctionContext:
              `${reflection.reason || reflection.message}\n` +
              this._formatActionsSummary(toolResults.slice(-8)),
          });
          if (replacement?.steps?.length) {
            this._plan = replacement;
            tools = _withPlanStepSchemas(tools, replacement);
            iterationHistory.push({
              role: 'user',
              content: `${reflection.message}\n\n${replacement.text}`,
            });
            if (this._currentGoalId && this._graph?.replaceGoalPlan) {
              this._graph.replaceGoalPlan(
                this._currentGoalId,
                replacement.steps.map((description, index) => ({
                  description,
                  successCriteria: replacement.criteria[index] ? [replacement.criteria[index]] : [],
                }))
              );
            }
            if (this._currentOnPlan) {
              try {
                this._currentOnPlan({
                  kind: 'replaced',
                  goalId: this._currentGoalId,
                  steps: replacement.steps,
                  criteria: replacement.criteria,
                  done: 0,
                  total: replacement.steps.length,
                });
              } catch (_) {}
            }
          } else {
            iterationHistory.push({ role: 'user', content: reflection.message });
          }
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
          logger.info('AgentLoop', `[agent-loop] reflexión ABANDONAR: ${reflection.reason}`);
          iterationHistory.push({ role: 'user', content: reflection.message });
        } else {
          // Veredicto CONTINUAR (o fallo de la llamada): no gastar rondas,
          // solo marcar para no re-disparar con las mismas fallas.
          failuresAtLastReflection = toolFailures;
        }
      }

      // ── Progreso del plan (HUD del chat) ─────────────────────────────────
      // Tras cada iteración se reenvía el conteo de pasos completados para que
      // el renderer actualice el widget de plan en vivo (opts.onPlan).
      if (this._plan && typeof opts.onPlan === 'function') {
        try {
          const progress = buildStepProgress(this._plan, toolResults, null);
          opts.onPlan({
            kind: 'progress',
            goalId: this._currentGoalId,
            steps: this._plan.steps,
            criteria: this._plan.criteria,
            done: progress.done,
            total: this._plan.steps.length,
            stepStates: progress.stepStates,
          });
        } catch (_) {}
      }

      // ── Iteraciones adaptativas ──────────────────────────────────────────
      // Cerca del límite y con progreso sostenido (las últimas tools todas
      // ok:true), se extiende el presupuesto de a bloques, acotado a
      // MAX_ITERATIONS_ABS. Si no hay progreso (fallas en cadena), no se
      // extiende: es señal de estancamiento, no de avance.
      if (i >= this.maxIterations - 3 && this.maxIterations < MAX_ITERATIONS_ABS) {
        const okRecent = toolResults.slice(-3).filter((r) => r && r.ok).length;
        if (okRecent >= 3) {
          this.maxIterations = Math.min(MAX_ITERATIONS_ABS, this.maxIterations + 5);
          logger.info(
            'AgentLoop',
            `[agent-loop] presupuesto extendido a ${this.maxIterations} iteraciones (progreso sostenido)`
          );
        }
      }
    }

    const finalResponse =
      'He alcanzado el límite de iteraciones sin completar la tarea. ' +
      'Puedes pedirme que continúe o reformular la instrucción.';

    return {
      response: this._withExpiredApprovalNotice(lastResponseText || finalResponse),
      iterations: this.maxIterations,
      toolResults,
      mutationJournal: mutationJournal.toJSON(),
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
    let effectivePlan = plan ? { ...plan } : {};
    let impact = null;
    try {
      const changedFiles = [];
      for (const result of toolResults || []) {
        if (!isSuccessfulMutationResult(result)) continue;
        changedFiles.push(
          ...extractMutationPaths(
            result._action || { tool: result.tool, params: result.params || {} },
            AP.PROJECT_CWD || process.cwd()
          )
        );
      }
      if (changedFiles.length && this._repositoryIntelligence?.analyzeFiles) {
        impact = await this._repositoryIntelligence.analyzeFiles(changedFiles);
        const focused = Array.isArray(impact?.commands) ? impact.commands : [];
        const configured = Array.isArray(effectivePlan.commands)
          ? effectivePlan.commands
          : effectivePlan.command
            ? [effectivePlan.command]
            : [];
        const commands = [...new Set([...focused, ...configured])];
        if (commands.length) {
          effectivePlan = { ...effectivePlan, command: commands[0], commands };
        }
      }
    } catch (error) {
      logger.warn(
        'AgentLoop',
        `[repository-intelligence] selección focal degradada: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    const result = await runVerifyPlan(effectivePlan, {
      bridge: this._bridge,
      isSmart: this._mode === 'smart',
      toolResults,
      editTools: EDIT_TOOLS,
      mutationPredicate: isSuccessfulMutationResult,
      signal: this._signal,
    });
    if (impact) {
      result.impact = {
        changedFiles: impact.seeds,
        relatedTests: impact.tests,
        dependents: impact.dependents,
        risk: impact.risk,
        rationale: impact.rationale,
      };
    }
    return result;
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
      const stale = Array.isArray(diagnostics) && diagnostics.stale === true;
      return { filePath: abs, diagnostics: Array.isArray(diagnostics) ? diagnostics : [], stale };
    } catch (e) {
      logger.warn('AgentLoop', `[agent-loop] feedback LSP post-edit falló: ${e.message}`);
      return null;
    }
  }

  /**
   * Caché por-run de la tool `read`: la misma ruta + encoding devuelve el
   * mismo resultado mientras el archivo no se mute (la invalidación en el
   * dispatch borra la entrada tras write/edit/apply_patch del path).
   * @param {{ params?: object }} action
   * @returns {Promise<object>}
   */
  async _cachedRead(action) {
    const params = action.params || {};
    const filePath = params.path || params.filePath || '';
    const encoding = params.encoding || 'utf-8';
    const startLine = Number(params.start_line || params.startLine || 0);
    const maxLines = Number(params.max_lines || params.maxLines || 0);
    const key = `${encoding}:${startLine}:${maxLines}::${filePath}`;
    const cached = this._readCache.get(key);
    if (cached !== undefined) {
      return { ...cached, cached: true, elapsed: 0 };
    }
    const result = await this._bridge.execute('read', params);
    if (result && result.ok) this._readCache.set(key, result);
    return result;
  }

  /**
   * Caché por-run de `exec` SOLO PARA comandos de solo lectura (ls/pwd/which/
   * git status/log/diff/branch...). Un comando mutador o variable se ejecuta
   * fresco y, si tiene éxito, invalida el caché de exec (el estado pudo
   * cambiar). El dispatch además invalida el caché tras write/edit/apply_patch
   * y tras tools git/github.
   * @param {{ params?: object }} action
   * @returns {Promise<object>}
   */
  async _cachedExec(action) {
    const params = action.params || {};
    const command = String(params.command || '').trim();
    if (!_isCacheableExecCommand(command)) {
      const result = await this._bridge.execute('exec', params);
      if (result && result.ok) this._execCache.clear();
      return result;
    }
    const cached = this._execCache.get(command);
    if (cached !== undefined) {
      return { ...cached, cached: true, elapsed: 0 };
    }
    const result = await this._bridge.execute('exec', params);
    if (result && result.ok) this._execCache.set(command, result);
    return result;
  }

  /**
   * Verificación de sintaxis por-paso (patrón opencode "verify tras editar"):
   * tras una edición exitosa de un archivo JS se corre `node --check` por el
   * MISMO bridge de exec. Solo se ejecuta cuando el LSP no dio feedback (si el
   * LSP ya validó el archivo, es la fuente autoritativa y no duplicamos
   * trabajo). Devuelve un string de error legible o null. Nunca lanza.
   * @param {string|undefined} filePath
   * @returns {Promise<string|null>}
   */
  async _syntaxCheckForEdit(filePath) {
    if (!filePath || !/\.(?:js|cjs|mjs)$/i.test(filePath)) return null;
    try {
      const abs = path.resolve(filePath);
      if (!fs.existsSync(abs)) return null;
      const r = await this._bridge.execute('exec', {
        command: `node --check ${_shellQuoteArg(abs)}`,
      });
      if (!r || r.ok) return null;
      const detail = String(r.error || r.result?.stderr || '');
      const brief = detail.trim().split('\n').filter(Boolean).slice(0, 4).join(' ');
      return `[Sintaxis] node --check detectó un error en ${filePath}: ${brief || 'error desconocido'}`;
    } catch (_) {
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

  /**
   * Aplica los edits de un WorkspaceEdit del LSP (rename) a disco vía bridge.
   * Los edits por archivo se ordenan por posición DESCENDENTE para que las
   * sustituciones no desplacen los offsets de las siguientes.
   * @param {Array<{ filePath: string, edits: Array<{ range: object, newText: string }> }>} fileEdits
   * @returns {Promise<string[]>} archivos escritos
   */
  async _applyWorkspaceEdits(fileEdits) {
    const written = [];
    for (const fe of fileEdits || []) {
      if (!fe?.filePath || !Array.isArray(fe.edits) || fe.edits.length === 0) continue;
      const abs = path.resolve(fe.filePath);
      if (!fs.existsSync(abs)) continue;
      const readRes = await this._bridge.execute('read', { path: abs });
      if (!readRes?.ok || typeof readRes.result !== 'string') continue;

      const sorted = [...fe.edits].sort((a, b) => {
        const pa = a.range?.start || {};
        const pb = b.range?.start || {};
        return pb.line - pa.line || (pb.character ?? 0) - (pa.character ?? 0);
      });

      const lines = readRes.result.split('\n');
      for (const edit of sorted) {
        const sLine = edit.range?.start?.line;
        const eLine = edit.range?.end?.line;
        if (
          typeof sLine !== 'number' ||
          typeof eLine !== 'number' ||
          sLine < 0 ||
          eLine >= lines.length
        ) {
          continue;
        }
        const startCh = edit.range.start.character ?? 0;
        const endCh = edit.range.end.character ?? lines[eLine].length;
        const head = String(lines[sLine]).slice(0, startCh);
        const tail = String(lines[eLine]).slice(endCh);
        const replacement = String(edit.newText ?? '').split('\n');
        replacement[0] = head + replacement[0];
        replacement[replacement.length - 1] = replacement[replacement.length - 1] + tail;
        lines.splice(sLine, eLine - sLine + 1, ...replacement);
      }

      const writeRes = await this._bridge.execute('write', {
        path: abs,
        content: lines.join('\n'),
      });
      if (writeRes?.ok) written.push(abs);
    }
    return written;
  }
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

    // workspace_symbols busca en TODO el proyecto: sin filePath ni filtro por
    // extensión (usa el índice del server primario).
    if (action.tool === 'workspace_symbols') {
      const query = params.query || params.symbol || raw.query || '';
      if (!query || !String(query).trim()) {
        return failShape('workspace_symbols requiere query (nombre o parte del símbolo a buscar).');
      }
      try {
        return okShape(await this._lsp.getWorkspaceSymbols(String(query)));
      } catch (e) {
        return failShape(e.message);
      }
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
        case 'go_to_implementation':
          return okShape(
            await this._lsp.goToImplementation(filePath, params.line, params.character)
          );
        case 'completion':
          return okShape(await this._lsp.completion(filePath, params.line, params.character));
        case 'signature_help':
          return okShape(await this._lsp.signatureHelp(filePath, params.line, params.character));
        case 'call_hierarchy':
          return okShape(
            await this._lsp.callHierarchy(filePath, params.line, params.character, params.direction)
          );
        case 'hover':
          return okShape(await this._lsp.hover(filePath, params.line, params.character));
        case 'rename': {
          const edits = await this._lsp.rename(
            filePath,
            params.line,
            params.character,
            params.newName
          );
          // LSP.3: por defecto rename SOLO calcula los edits (el agente los
          // revisa). Con apply:true los escribe vía bridge — la aprobación de
          // alto impacto ya se pidió antes del dispatch (ActionParser).
          if (params.apply === true && Array.isArray(edits) && edits.length > 0) {
            if (edits.some((edit) => edit.resourceOperation)) {
              return failShape(
                'El rename incluye operaciones de recursos (crear/renombrar/borrar). Se devolvieron para revisión pero no se autoaplican.'
              );
            }
            const applied = await this._applyWorkspaceEdits(edits);
            return okShape({ applied: true, files: applied, edits });
          }
          return okShape({
            applied: false,
            hint: 'Edits calculados SIN aplicar. Revisa el resultado y vuelve a llamar con apply:true para escribirlos.',
            edits,
          });
        }
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
  async _executeMCP(action, signal = null) {
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

      const result = await mgr.callTool(server, tool, args || {}, { signal, timeout: 30_000 });
      const text =
        (result?.content || [])
          .filter((c) => c.type === 'text')
          .map((c) => c.text)
          .join('\n') || JSON.stringify(result);
      return {
        ok: result?.isError !== true,
        result: text,
        error: result?.isError ? text : null,
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

  // ── Memory Tools ──────────────────────────────────────────────────────────

  /**
   * Execute memory_search tool.
   * @param {object} action
   * @returns {Promise<object>}
   */
  async _executeMemorySearch(action) {
    const t0 = Date.now();
    const params = action.params || {};
    const { query, type, limit = 10 } = params;

    if (!query) {
      return {
        ok: false,
        result: null,
        error: 'memory_search requiere query',
        tool: 'memory_search',
        elapsed: Date.now() - t0,
      };
    }

    if (!this._graph) {
      return {
        ok: false,
        result: null,
        error: 'StateGraph no disponible',
        tool: 'memory_search',
        elapsed: Date.now() - t0,
      };
    }

    try {
      let results = [];

      // Search by type if specified
      if (type) {
        results = this._graph.getNodesByType({ type, limit, minImportance: 0 });
      } else {
        // Semantic search
        try {
          results = await this._graph.queryNodesSemantic(query, { limit });
        } catch (e) {
          // Fallback to keyword search
          results = this._graph.queryNodes({ search: query, limit });
        }
      }

      // Format results
      const formatted = results.map((node) => ({
        id: node.id,
        type: node.type,
        label: node.label,
        content: node.content,
        importance: node.importance,
        tags: JSON.parse(node.tags || '[]'),
      }));

      return {
        ok: true,
        result: formatted,
        error: null,
        tool: 'memory_search',
        elapsed: Date.now() - t0,
      };
    } catch (e) {
      return {
        ok: false,
        result: null,
        error: e.message,
        tool: 'memory_search',
        elapsed: Date.now() - t0,
      };
    }
  }

  /**
   * Execute memory_log_interaction tool.
   * @param {object} action
   * @returns {Promise<object>}
   */
  async _executeMemoryLogInteraction(action) {
    const t0 = Date.now();
    const params = action.params || {};
    const { type, content, metadata = {} } = params;

    if (!type || !content) {
      return {
        ok: false,
        result: null,
        error: 'memory_log_interaction requiere type y content',
        tool: 'memory_log_interaction',
        elapsed: Date.now() - t0,
      };
    }

    if (!this._graph) {
      return {
        ok: false,
        result: null,
        error: 'StateGraph no disponible',
        tool: 'memory_log_interaction',
        elapsed: Date.now() - t0,
      };
    }

    try {
      const interactionId = this._graph.logInteraction({
        type,
        content,
        metadata,
        sessionId: this._sessionId || null,
      });

      return {
        ok: interactionId !== null,
        result: { id: interactionId },
        error: interactionId === null ? 'Error al registrar interacción' : null,
        tool: 'memory_log_interaction',
        elapsed: Date.now() - t0,
      };
    } catch (e) {
      return {
        ok: false,
        result: null,
        error: e.message,
        tool: 'memory_log_interaction',
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
   * Conjunto de herramientas de un perfil de subagente: filtra el catálogo
   * completo por allow/deny/read_only y devuelve el catálogo de prompt ya
   * filtrado + el Set de nombres para el gate de runtime. `restricted` indica
   * si el perfil limita tools (deny/read_only/allow parcial) — el general no.
   */
  _profileTools(profile) {
    let catalog = { tools: [] };
    try {
      catalog = this._toolRegistry.getCatalog(null);
    } catch (_) {}
    const allowAll = profile.tools.allow.includes('*');
    const restricted =
      profile.readOnly || !allowAll || (profile.tools.deny && profile.tools.deny.length > 0);
    const allowed = catalog.tools.filter((t) => _toolAllowed(profile, t.name));
    const names = new Set(allowed.map((t) => t.name));
    // Tools pseudo-estructurales de solo lectura que el parser textual puede
    // emitir y no vienen en el catálogo; no se bloquean en perfiles restringidos.
    names.add('webfetch');
    let text = null;
    try {
      text = this._toolRegistry.serializeToPrompt(null, 30, names);
    } catch (_) {}
    return { catalog: text, names, restricted };
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

    // ── Perfil del subagente (F1): general / explorador / investigador / user ──
    const agentName = params.agent || 'general';
    const profile = getSubagentRegistry().resolve(agentName);
    if (!profile) {
      const known = getSubagentRegistry()
        .list()
        .map((p) => p.name)
        .join(', ');
      return {
        ok: false,
        error: `perfil de subagente desconocido: "${agentName}" (perfiles: ${known})`,
        result: null,
        tool: action.tool,
        elapsed: 0,
      };
    }

    const maxIters = Math.min(params.max_iterations || profile.max_iterations || 8, 15);
    // El modo del run anidado sigue al perfil (fast = modelo barato/rápido del
    // mismo provider) o hereda el del padre.
    const nestedMode = profile.mode === 'fast' ? 'fast' : this._mode;
    let nested;
    try {
      nested = new AgentLoop({
        bridge: this._bridge,
        llm: this._llm,
        lsp: this._lsp,
        git: this._git,
        github: this._github,
        graph: this._graph,
        mcpManager: this._mcp,
        checkpoint: this._activeCheckpoint,
        manageCheckpoint: false,
        mode: nestedMode,
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

    // Herramientas permitidas para este perfil: catálogo del prompt filtrado
    // por allow/deny/read_only + conjunto de nombres para el gate de runtime
    // del run anidado (defensa en profundidad). Solo aplica a perfiles
    // RESTRINGIDOS: el general mantiene el catálogo completo de siempre.
    const profileTools = this._profileTools(profile);

    try {
      const nestedOpts = {
        taskIntent: this._currentTaskIntent || null,
        signal: this._signal,
        // Los subagentes heredan la política de verificación y reflexión del run
        // padre: una tarea delegada NO puede mutar sin sellado post-acción ni
        // sin auto-crítica (inconsistencia de política corregida).
        verify: this._verifyPlan || null,
        reflection: this._reflectionOpt || null,
        toolResolver: this._currentToolResolver,
        permissionManager: this._currentPermissionManager,
        pluginManager: this._currentPluginManager,
        skillManager: this._currentSkillManager,
        skillDb: this._currentSkillDb,
        tools: this._llm
          ? null
          : profileTools.restricted && Array.isArray(this._currentTools)
            ? this._currentTools.filter((tool) => profileTools.names.has(tool.name))
            : this._currentTools,
        nativeMcpMap: this._currentNativeMcpMap || {},
        // El resumen final del subagente es un reporte, no una orden: no debe
        // pasar por el parser de prosa (evita que "modifiqué X" re-dispare una
        // edición no pedida). Las ediciones del subagente se expresan con
        // bloques de acción estructurados o tool calls nativos.
        reportMode: true,
      };
      if (profile.mode === 'fast') {
        // Fallback textual del subagente con su PROPIO modo (fast), no el smart
        // del padre (completeTask siempre es smart).
        nestedOpts.llm = this._llmForMode('fast');
      }
      if (profileTools.restricted) {
        if (profileTools.catalog) nestedOpts.toolCatalog = profileTools.catalog;
        if (profileTools.names.size > 0) nestedOpts.allowedToolNames = profileTools.names;
      }
      if (profile.temperature != null) nestedOpts.temperature = profile.temperature;
      if (this._onSubagentProgress) {
        nestedOpts.onProgress = (p) => this._onSubagentProgress({ ...p, agent: agentName });
      }
      const out = await nested.run(subTask, SUBAGENT_SYSTEM, [], nestedOpts);
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
        mutationJournal: out.mutationJournal || null,
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
      const nestedOk =
        !out.error && !out.truncated && !out.cancelled && out.verify?.status !== 'failed';
      return {
        ok: nestedOk,
        result: resultPayload,
        error: nestedOk
          ? null
          : out.error ||
            (out.truncated ? 'subagente_agoto_iteraciones' : null) ||
            (out.verify?.status === 'failed' ? 'subagente_no_verificado' : 'subagente_incompleto'),
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

  /** Ejecuta investigación paralela con perfiles que no pueden mutar. */
  async _executeSubagentBatch(action) {
    const t0 = Date.now();
    const tasks = Array.isArray(action?.params?.tasks) ? action.params.tasks.slice(0, 4) : [];
    if (tasks.length < 2) {
      return {
        ok: false,
        result: null,
        error: 'tasks requiere entre 2 y 4 subtareas',
        tool: action.tool,
        elapsed: 0,
      };
    }
    for (const item of tasks) {
      const profile = getSubagentRegistry().resolve(item.agent || '');
      if (!profile || !profile.readOnly) {
        return {
          ok: false,
          result: null,
          error: `subagent_batch solo admite perfiles read_only: ${item.agent || 'sin perfil'}`,
          tool: action.tool,
          elapsed: Date.now() - t0,
        };
      }
    }
    const reports = await Promise.all(
      tasks.map((item) =>
        this._executeSubagent({ tool: 'subagent', params: item }).then((result) => ({
          task: item.task,
          agent: item.agent,
          ...result,
        }))
      )
    );
    return {
      ok: reports.every((report) => report.ok),
      result: { reports },
      error: reports.every((report) => report.ok) ? null : 'uno o más subagentes fallaron',
      tool: action.tool,
      elapsed: Date.now() - t0,
    };
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
   * Plan explícito — ¿esta tarea merece planificar antes de actuar?
   * Fase de calidad: opencode/claude-code generan un plan antes de tocar nada
   * para anclar el contexto y reducir la deriva. La ruta Core marca
   * `requirePlan` para todas las tareas smart; los usos directos conservan el
   * umbral de dificultad anterior.
   * @param {string} userMessage
   * @param {{ domain?: string|null }|null} taskIntent
   * @param {object} opts
   * @returns {boolean}
   */
  _shouldPlan(userMessage, taskIntent, opts = {}) {
    if (this._mode !== 'smart') return false;
    if (opts.reportMode) return false;
    if (opts.requirePlan === true) return true;
    if (opts.planning !== true) return false;
    const resumed = (opts.activeIntentions || []).find(
      (intention) => Number(intention.id) === Number(opts.currentGoalId)
    );
    if (resumed && Array.isArray(resumed.goal_plan) && resumed.goal_plan.length) return false;
    try {
      const difficulty = estimateDifficulty({ message: userMessage, taskIntent });
      return difficulty >= PLANNING_DIFFICULTY_THRESHOLD;
    } catch (_) {
      return false;
    }
  }

  /**
   * Genera el plan de ejecución con UNA llamada LLM estructurada (no
   * streamiea al chat: es control interno, igual que reflexión/auto-crítica).
   * Devuelve null si el modelo no entrega pasos parseables; el caller instala
   * entonces el plan local de respaldo y deja la tarea reanudable.
   * @param {object} p
   * @param {string} p.userMessage
   * @param {{ domain?: string|null }|null} p.taskIntent
   * @param {string|null} p.toolCatalog
   * @param {Function} p.llm
   * @param {object} p.llmOpts
   * @param {AbortSignal|null} p.signal
   * @returns {Promise<{steps: string[], criteria: string[], text: string}|null>}
   */
  async _buildRepositorySnapshot(userMessage) {
    const cwd = AP.PROJECT_CWD || process.cwd();
    try {
      return await this._repositoryIntelligence.buildPlanningContext(userMessage, {
        maxChars: 9000,
      });
    } catch (error) {
      logger.warn(
        'AgentLoop',
        `[repository-intelligence] reconocimiento degradado: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Fallback mínimo: no bloquea el main process ni intenta inferir impacto.
    let entries = [];
    try {
      entries = (await fs.promises.readdir(cwd, { withFileTypes: true }))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 80)
        .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
    } catch (_) {}
    let gitSummary = '';
    try {
      const status = await this._git?.status?.(cwd);
      if (status) gitSummary = JSON.stringify(status).slice(0, 1800);
    } catch (_) {}
    return [
      '# RECONOCIMIENTO DEL REPOSITORIO',
      `Raíz: ${cwd}`,
      'Modo degradado: el índice estructural no estuvo disponible.',
      gitSummary ? `Estado Git: ${gitSummary}` : 'Estado Git: no disponible',
      'Entradas de la raíz:',
      entries.map((file) => `- ${file}`).join('\n') || '- (vacío)',
      '',
      'El plan debe basarse en estas rutas reales. Si falta detalle, el primer paso debe inspeccionar símbolos o archivos relevantes antes de editar.',
    ]
      .join('\n')
      .slice(0, 7000);
  }

  async _buildPlan({
    userMessage,
    taskIntent,
    toolCatalog: _toolCatalog,
    llm,
    llmOpts,
    signal,
    repositorySnapshot = '',
    correctionContext = '',
  }) {
    const domain = taskIntent?.domain || null;
    const planPrompt = [
      '# PLANIFICACIÓN — desglosar la tarea antes de ejecutar',
      '',
      `Intención del usuario: ${String(userMessage).slice(0, 800)}`,
      domain ? `Dominio: ${domain}` : '',
      repositorySnapshot ? `\n${repositorySnapshot}` : '',
      correctionContext ? `\nMotivo de replanificación:\n${correctionContext}` : '',
      '',
      'Vas a ejecutar esta tarea en un bucle agente con herramientas (una por vez).',
      'Antes de empezar, generá un plan de ejecución de 2 a 6 pasos concretos.',
      'Cada paso debe ser UNA línea accionable: qué hacer y con qué',
      '(archivo/comando/herramienta), seguido de un criterio observable.',
      '',
      'Formato EXACTO (sin texto fuera de este bloque):',
      'PLAN:',
      '1. <paso 1> || VERIFICAR: <evidencia observable de éxito>',
      '2. <paso 2> || VERIFICAR: <evidencia observable de éxito>',
      '',
    ].join('\n');

    const planSystem = [
      'Eres la fase de planificación de un agente. Desglosás la tarea del usuario',
      'en pasos accionables y verificables antes de que el agente ejecute.',
      'Reglas:',
      `- Entre ${PLANNING_MIN_STEPS} y ${PLANNING_MAX_STEPS} pasos, ordenados y no redundantes.`,
      '- Cada paso menciona el archivo/comando/herramienta a usar. Nada vago',
      '  ("resolver el problema"): algo que el agente pueda ejecutar y verificar.',
      '- Cada criterio exige evidencia observable (salida, archivo, test o estado),',
      '  nunca frases subjetivas como "que quede bien".',
      '- No planifiques pasos de "confirmar con el usuario": el agente trabaja solo.',
      '- Si la tarea es trivial de una sola acción, es válido devolver SOLO 2 pasos',
      '  (leer lo necesario → ejecutar).',
    ].join('\n');

    try {
      const planSignal = signal || llmOpts?.signal || null;
      const raw = await llm(
        [{ role: 'user', content: planPrompt }],
        planSystem,
        planSignal ? { signal: planSignal } : {}
      );
      const text = typeof raw === 'string' ? raw : raw?.content || '';
      const steps = this._parsePlanSteps(text);
      if (!steps || steps.length < PLANNING_MIN_STEPS) return null;
      const criteria = this._parsePlanCriteria(text, steps);
      return { steps, criteria, text: this._renderPlanSection(steps, criteria) };
    } catch (e) {
      if (e?.code === 'ABORTED' || e?.name === 'AbortError') throw e;
      logger.warn('AgentLoop', `[agent-loop] planificación falló: ${e.message}`);
      return null;
    }
  }

  /**
   * Fallback local cuando el proveedor no puede generar el plan. No inventa
   * archivos ni afirma haber ejecutado nada: sólo deja un itinerario mínimo
   * con criterios observables para que la tarea pueda reanudarse.
   * @param {{userMessage:string,taskIntent?:object|null}} input
   * @returns {{steps:string[],criteria:string[],text:string,fallback:true}}
   */
  _buildFallbackPlan({ userMessage, taskIntent = null }) {
    const mutation = _expectsMutation(userMessage);
    const domain = String(taskIntent?.domain || 'la tarea')
      .replace(/[^\wáéíóúñ .-]/gi, '')
      .trim();
    const steps = mutation
      ? [
          `Inspeccionar el contexto real de ${domain} y localizar los archivos o entradas afectadas.`,
          'Aplicar el cambio solicitado mediante una herramienta de edición autorizada.',
          'Ejecutar la verificación disponible (sintaxis, tests, lint o comando del proyecto).',
          'Revisar la evidencia y cerrar sólo si el cambio y su verificación son observables.',
        ]
      : [
          `Inspeccionar el contexto real de ${domain} y reunir la evidencia necesaria.`,
          'Ejecutar la acción o análisis solicitado con las herramientas disponibles.',
          'Verificar el resultado y registrar cualquier bloqueo antes de cerrar.',
        ];
    const criteria = mutation
      ? [
          'Existe una ubicación real y un diagnóstico reproducible.',
          'Una mutación autorizada devuelve ok:true y deja evidencia del archivo o recurso.',
          'La verificación ejecutada devuelve resultado observable.',
          'El ledger del plan y la verificación no contienen pasos pendientes.',
        ]
      : [
          'La evidencia proviene de una lectura o herramienta real.',
          'La acción solicitada devuelve un resultado observable.',
          'El resultado queda verificado o se conserva como pendiente con motivo explícito.',
        ];
    return {
      steps,
      criteria,
      fallback: true,
      text: this._renderPlanSection(steps, criteria),
    };
  }

  /**
   * Extrae los pasos del bloque PLAN del texto del LLM.
   * @param {string} text
   * @returns {string[]}
   */
  _parsePlanSteps(text) {
    if (!text) return [];
    const steps = [];
    let inPlan = false;
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (/^PLAN\s*:?\s*$/i.test(t)) {
        inPlan = true;
        continue;
      }
      if (!inPlan) continue;
      const m = t.match(/^\d+[.)]\s*(.+)$/);
      if (m && m[1].trim()) {
        const description = m[1].split(/\s*\|\|\s*VERIFICAR\s*:\s*/i)[0].trim();
        if (description) steps.push(description);
      }
      if (steps.length >= PLANNING_MAX_STEPS) break;
    }
    return steps;
  }

  /**
   * Extrae un criterio observable por paso. Los modelos antiguos que todavía
   * devuelvan solo descripciones reciben un criterio conservador explícito.
   * @param {string} text
   * @param {string[]} steps
   * @returns {string[]}
   */
  _parsePlanCriteria(text, steps) {
    const explicit = [];
    let inPlan = false;
    for (const line of String(text || '').split('\n')) {
      const t = line.trim();
      if (/^PLAN\s*:?\s*$/i.test(t)) {
        inPlan = true;
        continue;
      }
      if (!inPlan) continue;
      const m = t.match(/^\d+[.)]\s*.+?\s*\|\|\s*VERIFICAR\s*:\s*(.+)$/i);
      if (m && m[1].trim()) explicit.push(m[1].trim());
      else if (/^\d+[.)]\s*/.test(t)) explicit.push('');
      if (explicit.length >= PLANNING_MAX_STEPS) break;
    }
    return steps.map(
      (step, index) => explicit[index] || `Confirmar con evidencia observable: ${step}`
    );
  }

  /**
   * Renderiza la sección que se inyecta al prompt del bucle.
   * @param {string[]} steps
   * @param {string[]} [criteria]
   * @returns {string}
   */
  _renderPlanSection(steps, criteria = []) {
    const lines = ['# PLAN DE EJECUCIÓN', ''];
    lines.push('Plan generado antes de actuar. Ejecutá los pasos en orden con tus');
    lines.push('herramientas, SIN pedir confirmación; si algo falla, corregilo y seguí:');
    for (const [index, step] of steps.entries()) {
      lines.push(`- [ ] ${step} (PASO ${index + 1})`);
      if (criteria[index]) lines.push(`  Evidencia requerida: ${criteria[index]}`);
    }
    lines.push('En cada tool call indica step_ordinal; en bloques textuales usa PASO: <número>.');
    return lines.join('\n');
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
   * @param {{steps: string[]}|null} p.plan - plan explícito del run (si hubo)
   * @returns {Promise<{verdict: string, message?: string, reason?: string} | null>}
   */
  async _reflect({ userMessage, toolResults, llm, llmOpts, signal, plan }) {
    const actionsSummary = this._formatActionsSummary(toolResults);

    const planBlock =
      plan && Array.isArray(plan.steps) && plan.steps.length
        ? [
            `Plan de ejecución declarado (${plan.steps.length} pasos):`,
            ...plan.steps.map((s, i) => `  ${i + 1}. ${s}`),
          ].join('\n')
        : null;

    const reflectPrompt = [
      `# REFLEXIÓN — evaluación del plan en curso`,
      ``,
      `Intención original del usuario:`,
      String(userMessage).slice(0, 600),
      ``,
      ...(planBlock ? [planBlock, ``] : []),
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
    const actionsSummary = this._formatActionsSummary(toolResults);

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
      const imageData = lastResult.result?.dataUrl;
      if (
        typeof imageData === 'string' &&
        /^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(imageData) &&
        imageData.length <= 3_000_000
      ) {
        return [
          { type: 'text', text: `[Resultado de herramienta "${lastResult.tool}"]:\n${summary}` },
          { type: 'image_url', image_url: { url: imageData, detail: 'low' } },
        ];
      }
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
  _buildLLMMessages(iterationHistory, currentUserMsg, userMessage, toolResults, _iteration) {
    const msgs = [{ role: 'user', content: userMessage }];
    const historyChars = iterationHistory.reduce(
      (total, message) => total + String(message?.content || '').length,
      0
    );

    if (
      (iterationHistory.length >= COMPACT_MIN_TURNS || historyChars > this._historyCharBudget) &&
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
    const actions = this._formatActionsSummary(toolResults, {
      empty: '  (ninguna todavía)',
      format: (t, params, ok) => `  - ${t.tool} (${ok})${params ? ' · ' + params : ''}`,
    });

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
    return (
      'Acciones completadas antes de la interrupción:\n\n' +
      done.map((r) => `✓ ${r.tool}`).join('\n') +
      '\n\n'
    );
  }

  /**
   * Construye la respuesta estándar cuando el usuario cancela la generación.
   * Centraliza la lógica para que los 4 paths de abort (planificación,
   * tool-calling, fallback, pure-text) devuelvan exactamente la misma forma.
   * @param {number} iterations
   * @param {Array} toolResults
   * @returns {{ response: string, iterations: number, toolResults: Array, cancelled: boolean, error: string }}
   */
  _makeAbortResponse(iterations, toolResults) {
    return {
      response: 'Generación cancelada por el usuario.',
      iterations,
      toolResults,
      cancelled: true,
      error: 'cancelled',
    };
  }

  /**
   * Formatea un array de toolResults en un resumen legible para prompts de
   * reflexión, auto-crítica y compactación. Centraliza la lógica de truncado
   * de params y el formateo ok/falló para evitar duplicación.
   * @param {Array} toolResults
   * @param {{ join?: string, empty?: string, format?: (t, params, ok) => string }} [opts]
   * @returns {string}
   */
  _formatActionsSummary(toolResults, opts = {}) {
    const joinSep = opts.join ?? '\n';
    const emptyMsg = opts.empty ?? '  (ninguna acción ejecutada)';
    const defaultFormat = (t, params, ok) => `  - ${t.tool}${params ? ' · ' + params : ''} → ${ok}`;
    const fmt = opts.format || defaultFormat;

    return (
      (toolResults || [])
        .map((t) => {
          const brief = t._action?.params || {};
          const params = Object.entries(brief)
            .map(
              ([k, v]) =>
                `${k}=${typeof v === 'string' ? v.slice(0, 60) : JSON.stringify(v)?.slice(0, 60)}`
            )
            .join(' ');
          const ok = t.ok ? 'OK' : `FALLÓ: ${t.error || ''}`;
          return fmt(t, params, ok);
        })
        .join(joinSep) || emptyMsg
    );
  }

  /**
   * Anexa a la respuesta final un aviso explícito cuando una herramienta de
   * alto impacto NO se ejecutó porque su aprobación expiró (timeout sin
   * respuesta del usuario). Sin esto el LLM podría cerrar con "todo listo"
   * mientras una acción quedó denegada en silencio. No aplica en reportMode
   * (subagentes): su texto es un reporte y el padre decide cómo contarlo.
   * @param {string} text
   * @returns {string}
   */
  _withExpiredApprovalNotice(text) {
    if (!this._approvalExpiredTool) return text;
    if (this._reportMode) return text;
    return (
      String(text || '') +
      `\n\n[Acción NO ejecutada] La herramienta "${this._approvalExpiredTool}" quedó DENEGADA: la aprobación expiró sin tu respuesta a tiempo. No se realizó ninguna escritura. Si la necesitás, pedímela de nuevo y aprobala antes de que venza.`
    );
  }

  _summarizeResult(result) {
    const raw = result.result;
    if (raw === null || raw === undefined) return 'Sin resultado.';

    if (typeof raw === 'string') {
      const limit = result.tool === 'read' ? READ_RESULT_TRUNCATE_LIMIT : RESULT_TRUNCATE_LIMIT;
      if (raw.length <= limit) return raw;
      const half = Math.floor(limit / 2);
      return (
        raw.slice(0, half) +
        `\n\n[... ${raw.length - limit} caracteres omitidos; usa read con start_line/max_lines para recuperar el tramo ...]\n\n` +
        raw.slice(-half)
      );
    }

    if (typeof raw === 'object') {
      if (typeof raw.dataUrl === 'string' && raw.mimeType) {
        const { dataUrl: _imageBytes, ...metadata } = raw;
        const description = `${JSON.stringify(metadata, null, 2)}\n[Captura disponible para la capa visual; usa una observación accesible cuando exista.]`;
        return UNTRUSTED_UI_TOOLS.has(result.tool) ? wrapUntrusted(description) : description;
      }
      if (typeof raw.content === 'string' && Number.isFinite(raw.total_lines)) {
        return [
          `[${raw.path || 'archivo'} · líneas ${raw.start_line}-${raw.end_line} de ${raw.total_lines} · eof=${Boolean(raw.eof)}${raw.next_line ? ` · next_line=${raw.next_line}` : ''}]`,
          raw.content.slice(0, READ_RESULT_TRUNCATE_LIMIT),
        ].join('\n');
      }
      if (raw.stdout !== undefined) {
        const stdout = (raw.stdout || '').trim();
        const stderr = (raw.stderr || '').trim();
        let summary = '';
        if (stdout) {
          const half = Math.floor(RESULT_TRUNCATE_LIMIT / 2);
          summary +=
            stdout.length <= RESULT_TRUNCATE_LIMIT
              ? stdout
              : `${stdout.slice(0, half)}\n[... stdout omitido: ${stdout.length - RESULT_TRUNCATE_LIMIT} chars ...]\n${stdout.slice(-half)}`;
        }
        if (stderr) {
          const stderrLimit = RESULT_TRUNCATE_LIMIT;
          summary +=
            (summary ? '\n' : '') +
            (stderr.length <= stderrLimit
              ? stderr
              : `[stderr, últimos ${stderrLimit} caracteres]\n${stderr.slice(-stderrLimit)}`);
        }
        if (raw.exitCode !== undefined && raw.exitCode !== 0) {
          summary += `\n[exit code: ${raw.exitCode}]`;
        }
        return summary || `[Comando ejecutado, sin salida]`;
      }
      const str = JSON.stringify(raw, null, 2);
      if (UNTRUSTED_UI_TOOLS.has(result.tool)) {
        return wrapUntrusted(str.slice(0, RESULT_TRUNCATE_LIMIT));
      }
      return str.length <= RESULT_TRUNCATE_LIMIT
        ? str
        : str.slice(0, RESULT_TRUNCATE_LIMIT) + `\n[... truncado: ${str.length} chars]`;
    }

    return String(raw).slice(0, RESULT_TRUNCATE_LIMIT);
  }
}

module.exports = { AgentLoop, MAX_ITERATIONS, buildActiveIntentionsSection };
