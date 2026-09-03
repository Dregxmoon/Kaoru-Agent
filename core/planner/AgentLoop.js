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
const {
  collectEditedFiles,
  analyzeSubagentReport,
  formatSubagentDiscrepancy,
} = require('./subagent-report.js');
const { getSubagentRegistry, _toolAllowed } = require('./SubagentRegistry.js');

const VALID_MODES = new Set(['smart', 'fast', 'task', 'conversational']);

// Tools LSP que se despachan al LSPManager (no al puente OpenClaw).
const LSP_TOOLS = new Set([
  'get_diagnostics',
  'go_to_definition',
  'find_references',
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

// Tool-call nativo cuyo nombre vino en el formato textual `MCP_TOOL:
// <servidor>.<herramienta>` (p.ej. "MCP_TOOL: filesystem.write_file"). El
// prompt del catálogo enseña ese formato y algunos modelos lo replican como
// FUNCTION NAME en tool-calling en vez de usar el schema nativo. Sin
// normalización, el nombre llega tal cual a OpenClawBridge → "Herramienta
// desconocida". Aquí se traduce a la pseudo-tool 'mcp' (MCPManager), el mismo
// destino que usa StructuredActionParser con MCP_TOOL en el fallback textual.
const NATIVE_MCP_TOOL_CALL_RE = /^MCP_TOOL:\s*([^.\s]+)\.([^.\s]+)$/;

function _nativeToolCallToAction(tc) {
  const raw = String(tc.tool || '');
  const mcpMatch = NATIVE_MCP_TOOL_CALL_RE.exec(raw);
  if (mcpMatch) {
    return {
      tool: 'mcp',
      params: { server: mcpMatch[1], tool: mcpMatch[2], args: tc.params || {} },
      description: `${raw}: ${JSON.stringify(tc.params).slice(0, 100)}`,
      source: 'native_tool_call',
    };
  }
  return {
    tool: _canonicalToolName(raw),
    params: tc.params,
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
  const hadSuccessfulMutation = (toolResults || []).some(
    (r) => r?.ok && MUTATOR_TOOLS.has(r?._action?.tool || r?.tool || '')
  );
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
const RESULT_TRUNCATE_LIMIT = 800;

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
    this._git = opts.git || getGitManager();
    this._github = opts.github || getGitHubManager();
    this._graph = opts.graph || null;
    this._mcp = opts.mcpManager || null;
    this._compactionPersisted = false;
    this._checkpoint = opts.checkpoint || null;
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
    const t0 = Date.now();
    let result;
    try {
      result = await this._runInternal(userMessage, systemPrompt, messages, opts);
      // Progreso del plan explícito (si hubo): cuántos pasos se completaron
      // con herramientas exitosas. El caller (agent.js) lo usa para persistir
      // la intención si el run se interrumpe.
      if (this._plan && result && !result.plan) {
        const done = (result.toolResults || []).filter(
          (t) => t && t.ok && _marksProgress(t)
        ).length;
        result.plan = {
          steps: this._plan.steps,
          done: Math.min(done, this._plan.steps.length),
          total: this._plan.steps.length,
        };
      }
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
    this._reportMode = Boolean(opts.reportMode);
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
    const llmOpts = onToken ? { onToken } : {};
    if (signal) llmOpts.signal = signal;
    if (opts.temperature != null) llmOpts.temperature = opts.temperature;

    // ── Tool resolution (Fase 5): Skill > MCP > OpenClaw ────────────
    let tools = opts.tools || null;
    let toolCatalog = this._toolRegistry.serializeToPrompt(domain);
    // Los subagentes con perfil restringido inyectan un catálogo YA filtrado
    // (las tools prohibidas no se anuncian en el prompt del run anidado).
    if (opts.toolCatalog) toolCatalog = opts.toolCatalog;
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

    // ── Fase de plan explícito (mejora de calidad) ─────────────────────────
    // Para tareas complejas (smart + dificultad alta) se genera un plan de
    // pasos ANTES de arrancar el bucle y se inyecta al prompt DESPUÉS del
    // truncado (así nunca se corta). El loop ejecuta anclado a ese plan, la
    // reflexión compara contra él, y el resultado expone el progreso. Si el
    // modelo no entrega pasos parseables o la llamada falla, el run sigue sin
    // plan: nunca bloquea la tarea.
    this._plan = null;
    // Tool de alto impacto cuya aprobación expiró (sin respuesta del usuario a
    // tiempo) en este run. Si el run cierra con texto, el aviso se anexa a la
    // respuesta final: nunca puede sonar a "todo listo" si una acción quedó
    // denegada por timeout sin que el usuario lo supiera activamente.
    this._approvalExpiredTool = null;
    if (this._shouldPlan(userMessage, taskIntent, opts)) {
      try {
        const plan = await this._buildPlan({
          userMessage,
          taskIntent,
          toolCatalog,
          llm,
          llmOpts,
          signal,
        });
        if (plan && plan.steps && plan.steps.length) {
          this._plan = plan;
          agentPrompt = agentPrompt + '\n\n' + plan.text;
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
                steps: plan.steps,
                done: 0,
                total: plan.steps.length,
              });
            } catch (_) {
              logger.debug('AgentLoop', 'emitión de progress falló');
            }
          }
        }
      } catch (e) {
        if (e?.code === 'ABORTED' || e?.name === 'AbortError') {
          return this._makeAbortResponse(0, []);
        }
        logger.warn('AgentLoop', `[agent-loop] planificación falló: ${e.message}`);
      }
    }

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
    // Skills inyectadas en este run (para chips visuales en la respuesta).
    /** @type {string[]} */
    const injectedSkills = [];
    // Verificación de artefactos (web + sintaxis universal): rondas de
    // corrección cuando archivos mutados fallan validación al cierre.
    let webVerifyRounds = 0;
    /** @type {Set<string>} rutas absolutas de TODOS los archivos mutados con éxito */
    const mutatedFiles = new Set();
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
                  `¡No te preocupes, eso es todo! Solo me quedé sin cuota y no pude escribir el resumen final (error en tool-calling y fallback textual: ${e2.message})`
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
                `¡No te preocupes, eso es todo! Solo me quedé sin cuota y no pude escribir el resumen final (error en LLM: ${e.message})`
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
        actions = toolCalls.map((tc) => _nativeToolCallToAction(tc));
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

        if (permissionAction === 'ask' && requiresApproval && opts.onApprovalNeeded) {
          const decision = await opts.onApprovalNeeded(action);
          // onApprovalNeeded puede devolver boolean (true/false) o un objeto
          // rico { approved, reason }. El caso reason === 'timeout' distingue
          // una aprobación que EXPIRÓ (el usuario no respondió a tiempo) de
          // una denegación explícita — el cierre del run debe decirlo.
          const isObject = decision !== null && typeof decision === 'object';
          const isTimeout = isObject && decision.reason === 'timeout';
          const approved = isObject ? Boolean(decision.approved) : Boolean(decision);
          this._metrics.trackApproval(approved);
          if (!approved) {
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
          } else if (action.tool === 'memory_search') {
            // Memory tool: search in Kaoru's memory
            result = await this._executeMemorySearch(action);
          } else if (action.tool === 'memory_log_interaction') {
            // Memory tool: log user interaction
            result = await this._executeMemoryLogInteraction(action);
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

        // ── Invalidación del caché de solo-lectura ─────────────────────────
        // Una mutación real (write/edit/apply_patch, git, cualquier exec no
        // cacheable con éxito) puede cambiar el filesystem o el repo: el
        // resultado cacheado (read del archivo, git status/log) quedaría
        // viejo. Solo se invalida ante éxito; un fallo no cambia el estado.
        if (result && result.ok) {
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
          if (MUTATOR_TOOLS.has(action.tool)) {
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
          // Verify por-paso: si el LSP no cubrió el archivo (no hay feedback),
          // se valida la sintaxis del JS editado con node --check. Esto detecta
          // en el acto lo que antes solo aparecía en el verify final.
          if (!lspFeedback) {
            syntaxError = await this._syntaxCheckForEdit(
              action.params?.path || action.params?.filePath
            );
            if (syntaxError) result.syntaxError = syntaxError;
          }
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
          plan: this._plan || null,
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

      // ── Progreso del plan (HUD del chat) ─────────────────────────────────
      // Tras cada iteración se reenvía el conteo de pasos completados para que
      // el renderer actualice el widget de plan en vivo (opts.onPlan).
      if (this._plan && typeof opts.onPlan === 'function') {
        try {
          const okProgress = toolResults.filter((t) => t && t.ok && _marksProgress(t)).length;
          opts.onPlan({
            kind: 'progress',
            steps: this._plan.steps,
            done: Math.min(okProgress, this._plan.steps.length),
            total: this._plan.steps.length,
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
    const key = `${encoding}::${filePath}`;
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
   * Plan explícito — ¿esta tarea merece planificar antes de actuar?
   * Fase de calidad: opencode/claude-code generan un plan antes de tocar nada
   * para anclar el contexto y reducir la deriva. Se aplica solo a tareas
   * complejas (modo smart + dificultad alta), nunca a charla rápida ni a
   * subagentes (su run ya lo orquesta el padre).
   * @param {string} userMessage
   * @param {{ domain?: string|null }|null} taskIntent
   * @param {object} opts
   * @returns {boolean}
   */
  _shouldPlan(userMessage, taskIntent, opts = {}) {
    if (opts.planning !== true) return false;
    if (this._mode !== 'smart') return false;
    if (opts.reportMode) return false;
    if (opts.activeIntentions && opts.activeIntentions.length) return false;
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
   * Devuelve null si el modelo no entrega pasos parseables — el run sigue sin
   * plan, nunca se bloquea por esto.
   * @param {object} p
   * @param {string} p.userMessage
   * @param {{ domain?: string|null }|null} p.taskIntent
   * @param {string|null} p.toolCatalog
   * @param {Function} p.llm
   * @param {object} p.llmOpts
   * @param {AbortSignal|null} p.signal
   * @returns {Promise<{steps: string[], text: string}|null>}
   */
  async _buildPlan({ userMessage, taskIntent, toolCatalog, llm, llmOpts, signal }) {
    const domain = taskIntent?.domain || null;
    const planPrompt = [
      '# PLANIFICACIÓN — desglosar la tarea antes de ejecutar',
      '',
      `Intención del usuario: ${String(userMessage).slice(0, 800)}`,
      domain ? `Dominio: ${domain}` : '',
      '',
      'Vas a ejecutar esta tarea en un bucle agente con herramientas (una por vez).',
      'Antes de empezar, generá un plan de ejecución de 2 a 6 pasos concretos.',
      'Cada paso debe ser UNA línea accionable: qué hacer y con qué',
      '(archivo/comando/herramienta). No repitas pasos ni añadas verificación',
      'manual: el bucle ejecuta y observa los resultados reales por sí mismo.',
      '',
      'Formato EXACTO (sin texto fuera de este bloque):',
      'PLAN:',
      '1. <paso 1>',
      '2. <paso 2>',
      '',
    ].join('\n');

    const planSystem = [
      'Eres la fase de planificación de un agente. Desglosás la tarea del usuario',
      'en pasos accionables y verificables antes de que el agente ejecute.',
      'Reglas:',
      `- Entre ${PLANNING_MIN_STEPS} y ${PLANNING_MAX_STEPS} pasos, ordenados y no redundantes.`,
      '- Cada paso menciona el archivo/comando/herramienta a usar. Nada vago',
      '  ("resolver el problema"): algo que el agente pueda ejecutar y verificar.',
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
      return { steps, text: this._renderPlanSection(steps) };
    } catch (e) {
      if (e?.code === 'ABORTED' || e?.name === 'AbortError') throw e;
      logger.warn('AgentLoop', `[agent-loop] planificación falló: ${e.message}`);
      return null;
    }
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
      if (m && m[1].trim()) steps.push(m[1].trim());
      if (steps.length >= PLANNING_MAX_STEPS) break;
    }
    return steps;
  }

  /**
   * Renderiza la sección que se inyecta al prompt del bucle.
   * @param {string[]} steps
   * @returns {string}
   */
  _renderPlanSection(steps) {
    const lines = ['# PLAN DE EJECUCIÓN', ''];
    lines.push('Plan generado antes de actuar. Ejecutá los pasos en orden con tus');
    lines.push('herramientas, SIN pedir confirmación; si algo falla, corregilo y seguí:');
    for (const s of steps) lines.push(`- [ ] ${s}`);
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
    return '¡La tarea quedó terminada! ✓\n\n' + done.map((r) => `✓ ${r.tool}`).join('\n') + '\n\n';
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
