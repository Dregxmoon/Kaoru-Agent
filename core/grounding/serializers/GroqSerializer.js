// @ts-check
/**
 * GroqSerializer.js — Fase 3 (actualizado)
 *
 * CAMBIOS respecto a la versión Fase 2:
 *   - _buildToolIntentSection() inyecta la intención detectada por
 *     IntentDetector en el system prompt con instrucciones de formato
 *     estructurado para el LLM.
 *   - Cuando hay toolIntent de nivel 'high' o 'medium', el LLM recibe
 *     instrucción explícita de responder con el bloque:
 *       ACCIÓN: <action> | ARCHIVO: <path>   (si aplica path)
 *       ACCIÓN: <action> | COMANDO: <cmd>    (si aplica comando)
 *       ACCIÓN: <action>                     (si solo action)
 *     Este formato estructurado lo extrae StructuredActionParser
 *     sin necesidad de regex frágil sobre narrativa libre.
 *   - Si toolIntent.level === 'none', el system prompt es idéntico
 *     al de Fase 2 — sin cambios para el flujo conversacional.
 *
 * Principio: el LLM sigue siendo el que decide y conversa.
 * El embedding le da un "hint" fuerte de qué se le está pidiendo,
 * y el formato estructurado hace que su respuesta sea parseable
 * de forma determinista.
 *
 * FIX (revisión con Claude): el builder de identidad (IdentitySerializer)
 * leía identity.personality e identity.uncertainty_voice — campos que NUNCA
 * existieron en identity.json (que en realidad tiene character, voice,
 * uncertainty_behaviors, relationship, limits). Como esos ifs nunca
 * entraban, solo identity.core llegaba al LLM — toda la personalidad
 * escrita en el archivo se calculaba y se guardaba, pero nunca salía de
 * disco. Ahora el builder lee la forma real del archivo (ver
 * core/identity/IdentitySerializer.js).
 *
 * FIX (revisión con Claude): el truncado a MAX_SYSTEM_CHARS pasaba AQUÍ,
 * pero Core.buildContext() le pegaba BehaviorModel + reglas de
 * OpenClaw + catálogo MCP DESPUÉS de este punto — el presupuesto de
 * tokens nunca contaba esas secciones. El truncado se movió a
 * Core.js, al final de buildContext(), sobre el prompt ya completo.
 */

'use strict';

const { getIdentity } = require('../../identity/IdentityStore.js');
const { serializeIdentity, serializeMoodDelta } = require('../../identity/IdentitySerializer.js');
const { getMoodEngine } = require('../../identity/MoodEngine.js');
const { getDynamicsConfig } = require('../../identity/DynamicsConfig.js');

// Presupuesto de caracteres para el historial de sesión en el contexto del
// LLM. Los turnos recientes se envían completos; el excedente se resume.
const MAX_HISTORY_CHARS = 8000;

// Presupuesto de caracteres para la sección de memoria del system prompt
// (F2.1): el recorte deja de ser por conteos fijos (8 nodos × 200 chars +
// 3 episodios × 200 chars ≈ 2.2KB) y pasa a ser por presupuesto real, de modo
// que entren más nodos cortos o menos nodos largos según lo que haya, siempre
// sin exceder el tope. Con el presupuesto global de 14k, 2.5k de memoria es
// ~18% del prompt.
const MEMORY_SECTION_CHARS = 2500;

// Presupuesto de chars para la sección de impresiones (F3.3). Más chico que el
// de memoria: las inferencias son hipótesis, no hechos — alcanza con las 8 más
// confiables y breves. La sección completa además es descartable por el
// truncado inteligente (se recorta primero, ver core/core/context.js).
const INFERRED_SECTION_CHARS = 1200;

// ── Identity (cacheada) ───────────────────────────────────────────────────────
// La identidad NO cambia entre turnos. Se serializa UNA SOLA VEZ al cargar
// el módulo y se reusa en cada llamada, ahorrando ~400-600 tokens por turno.
// El raw viene de IdentityStore (loader único de identity.json).

/**
 * @typedef {{
 *   summary?: string,
 *   traits?: string[],
 *   dislikes?: string[],
 * }} IdentityCharacter
 * @typedef {{
 *   style?: string,
 *   rhythm?: string,
 *   formality?: string,
 *   forbidden_phrases?: string[],
 * }} IdentityVoice
 * @typedef {{
 *   what_i_am_not?: string[],
 *   identity_stability?: string,
 * }} IdentityLimits
 * @typedef {{
 *   description?: string,
 *   examples?: string[],
 * }} UncertaintyBehavior
 * @typedef {{
 *   default_dynamic?: string,
 *   continuity?: string,
 * }} IdentityRelationship
 * @typedef {{
 *   time?: string,
 *   session?: string,
 *   system?: string,
 * }} IdentityContextAwareness
 * @typedef {{
 *   name: string, core: string, version?: string,
 *   character?: IdentityCharacter,
 *   voice?: IdentityVoice,
 *   uncertainty_behaviors?: Record<string, UncertaintyBehavior>,
 *   relationship?: IdentityRelationship,
 *   context_awareness?: IdentityContextAwareness,
 *   limits?: IdentityLimits,
 * }} Identity
 * @typedef {{ role: string, content: string, ts?: number }} HistoryTurn
 * @typedef {{
 *   timeFormatted?: string,
 *   friendlyName?: string,
 *   elapsedFormatted?: string,
 *   title?: string,
 *   idleFormatted?: string,
 *   openWindowsSummary?: string,
 *   todaySummary?: string,
 *   [key: string]: unknown,
 * }} OSContext
 * @typedef {object} ToolIntentCtx
 */

/** @type {string | null} */
let _serializedIdentity = null; // cache de la sección ya formateada
/** @type {Identity | null} */
let _identityRawCache = null;

function _getIdentity() {
  if (_identityRawCache) return _identityRawCache;
  _identityRawCache = /** @type {Identity} */ (getIdentity());
  return _identityRawCache;
}

function _getSerializedIdentity() {
  if (_serializedIdentity) return _serializedIdentity;
  _serializedIdentity = serializeIdentity(/** @type {Identity} */ (_getIdentity()));
  return _serializedIdentity;
}

/**
 * Override de identidad en runtime (editar la personalidad sin reiniciar la
 * app). Invalida ambas caches; la sección se reconstruye en la próxima llamada.
 *
 * @param {Identity} identity - Objeto de identidad nuevo (o raw del JSON).
 * @returns {boolean} true si el override se aplicó.
 */
function setIdentityOverride(identity) {
  if (!identity || typeof identity !== 'object') return false;
  _identityRawCache = identity;
  _serializedIdentity = null;
  return true;
} // Acciones cuyo campo ARCHIVO puede referirse a una carpeta especial del
// usuario (Descargas, Escritorio, etc.) en vez de algo dentro del proyecto.
const FILE_PATH_ACTIONS = new Set(['create_file', 'edit_file', 'read_file', 'delete_file']);

/**
 * FIX: antes no existía NINGUNA instrucción sobre esto — si el usuario
 * decía "créame un archivo en la carpeta descargas", el LLM adivinaba a
 * ciegas qué poner en ARCHIVO. A veces por suerte escribía exactamente
 * "descargas/archivo.txt" (que sí resuelve bien, ver resolveSmartPath en
 * mock-openclaw.js) pero con cualquier variación natural — "mis
 * descargas/...", "./descargas/...", "carpeta descargas/...", un path
 * absoluto con un usuario inventado — el archivo terminaba creándose
 * dentro del proyecto o en un lugar equivocado, sin ningún aviso.
 */
/** @param {string} action */
function _specialFolderNote(action) {
  if (!FILE_PATH_ACTIONS.has(action)) return '';
  return `
Si el usuario se refiere a una carpeta especial de SU sistema (Descargas,
Escritorio, Documentos, Imágenes, Música, Videos), usa EXACTAMENTE esa
palabra (en español, sin acentos si no estás seguro, minúscula) como
primer segmento de ARCHIVO — nada más delante, nada de "mi"/"carpeta"/"la":
  Correcto:   ARCHIVO: descargas/reporte.txt
  Incorrecto: ARCHIVO: mis descargas/reporte.txt
  Incorrecto: ARCHIVO: ./descargas/reporte.txt
  Incorrecto: ARCHIVO: C:\\Users\\usuario\\Downloads\\reporte.txt (nunca inventes una ruta absoluta con un usuario que no conoces)
Si NO se menciona ninguna carpeta especial, usa una ruta relativa normal (se resuelve dentro del proyecto).`;
}

// ── Formato de tool intent por level ─────────────────────────────────────────
const TOOL_INSTRUCTIONS = {
  // El LLM DEBE usar el formato estructurado
  high: (/** @type {{ action: string, confidence: number, tool?: string }} */ intent) =>
    `
## INTENCIÓN DE HERRAMIENTA DETECTADA (alta confianza: ${(intent.confidence * 100).toFixed(0)}%)

El usuario quiere ejecutar una acción en el sistema: **${intent.action}**
${intent.tool ? `Herramienta disponible: \`${intent.tool}\`\n` : ''}
**INSTRUCCIÓN CRÍTICA:** Al responder, DEBES incluir un bloque de acción con este formato exacto
(en una línea separada, al final de tu respuesta o donde sea relevante):

${_buildFormatExample(intent.action)}
${_specialFolderNote(intent.action)}

Conversa naturalmente con el usuario, confirma lo que vas a hacer, y luego incluye el bloque.
Si necesitas más información (ruta del archivo, nombre, etc.), pregunta ANTES de incluir el bloque.

Si no vas a incluir el bloque de acción, **NUNCA describas ni simules** qué
resultado tendría ejecutar algo (no inventes salidas de terminal, listados
de archivos, contenidos de archivo, ni resultados de comandos). Si no estás
seguro de si el usuario quiere ejecutar algo de verdad, pregunta.
`.trim(),

  // El LLM DEBERÍA usar el formato estructurado si confirma la intención
  medium: (/** @type {{ action: string, confidence: number, tool?: string }} */ intent) =>
    `
## POSIBLE INTENCIÓN DE HERRAMIENTA (confianza media: ${(intent.confidence * 100).toFixed(0)}%)

Es posible que el usuario quiera ejecutar: **${intent.action}**
${intent.tool ? `Herramienta disponible: \`${intent.tool}\`\n` : ''}
Si confirmas que esto es lo que el usuario quiere, incluye al final de tu respuesta:

${_buildFormatExample(intent.action)}
${_specialFolderNote(intent.action)}

Si es solo una pregunta o conversación, responde normalmente sin el bloque.

Si no vas a incluir el bloque de acción, **NUNCA describas ni simules** qué
resultado tendría ejecutar algo (no inventes salidas de terminal, listados
de archivos, contenidos de archivo, ni resultados de comandos). Si no estás
seguro de si el usuario quiere ejecutar algo de verdad, pregunta.
`.trim(),
};

/**
 * Genera el ejemplo de formato estructurado según el tipo de acción.
 * El LLM aprende el formato leyendo este ejemplo en el system prompt.
 */
/** @param {string} action */
function _buildFormatExample(action) {
  /** @type {Record<string, string>} */
  const examples = {
    // Acciones con path de archivo
    // 2.1: el ejemplo enseña el campo CONTENIDO — sin él el LLM nunca lo usa y
    // StructuredActionParser cae al fallback userGoal como instruction (ver
    // G.1 en StructuredActionParser._buildParams).
    create_file:
      '```action\nACCIÓN: create_file | ARCHIVO: nombre-del-archivo.ext\nCONTENIDO: el contenido completo del archivo (puede ser multilínea)\n```',
    edit_file:
      '```action\nACCIÓN: edit_file | ARCHIVO: ruta/al/archivo.ext\nCONTENIDO: qué cambio hacer en el archivo\n```',
    read_file: '```action\nACCIÓN: read_file | ARCHIVO: ruta/al/archivo.ext\n```',
    delete_file: '```action\nACCIÓN: delete_file | ARCHIVO: ruta/al/archivo.ext\n```',
    create_directory: '```action\nACCIÓN: create_directory | RUTA: nombre-carpeta\n```',
    list_directory: '```action\nACCIÓN: list_directory | RUTA: . (o la ruta específica)\n```',

    // Acciones con comando
    run_command: '```action\nACCIÓN: run_command | COMANDO: el-comando-aquí\n```',
    run_script: '```action\nACCIÓN: run_script | COMANDO: python script.py\n```',
    git_action: '```action\nACCIÓN: git_action | COMANDO: git commit -m "mensaje"\n```',
    install_package: '```action\nACCIÓN: install_package | COMANDO: npm install paquete\n```',

    // Acciones con query
    web_search: '```action\nACCIÓN: web_search | QUERY: lo que se busca\n```',
    websearch: '```action\nACCIÓN: websearch | QUERY: lo que se busca\n```',
    webfetch: '```action\nACCIÓN: webfetch | URL: https://ejemplo.com\n```',
    navigate_browser: '```action\nACCIÓN: navigate_browser | URL: https://ejemplo.com\n```',

    // Fallback genérico
    default: '```action\nACCIÓN: <acción>\n```',
  };

  return examples[action] ?? examples.default;
}

// ── Secciones del system prompt ───────────────────────────────────────────────

/**
 * Sección delta del estado emocional actual (Fase B del motor de identidad).
 * Se calcula por turno (NO es cacheable), se agrega como sección corta al
 * FINAL del prompt y entra en el presupuesto de truncado de Core.buildContext()
 * (bajo presión de longitud es lo primero que se cae). Vuelve '' si el mood
 * es 'default' o el motor está deshabilitado.
 */
function _buildMoodSection() {
  const dyn = getDynamicsConfig();
  if (dyn?.mood_engine?.enabled === false) return '';
  try {
    const engine = getMoodEngine();
    engine.noteTurn();
    return serializeMoodDelta(engine.resolve());
  } catch (e) {
    // El motor de mood nunca rompe el pipeline de contexto.
    return '';
  }
}

/** @param {OSContext | null | undefined} osContext */
function _buildOSSection(osContext) {
  if (!osContext) return '';

  const lines = ['## Contexto actual'];

  if (osContext.timeFormatted) lines.push(osContext.timeFormatted);

  if (osContext.friendlyName) {
    let appLine = `El usuario está usando **${osContext.friendlyName}**`;
    if (osContext.elapsedFormatted) appLine += ` (hace ${osContext.elapsedFormatted})`;
    if (osContext.title) appLine += ` — ventana: "${osContext.title}"`;
    lines.push(appLine + '.');
  }

  if (osContext.idleFormatted) {
    lines.push(`Tiempo sin actividad: ${osContext.idleFormatted}.`);
  }

  if (osContext.openWindowsSummary) {
    lines.push(`Otras ventanas abiertas: ${osContext.openWindowsSummary}.`);
  }

  if (osContext.todaySummary) {
    lines.push('', '### Actividad de hoy', osContext.todaySummary);
  }

  lines.push(
    '',
    'NOTA: Esta información del contexto del sistema ES la respuesta a preguntas como "¿qué tengo abierto?" o "¿qué estás viendo?". No necesitas usar herramientas (MCP, OpenClaw, etc.) para averiguarlo — los datos ya están aquí.'
  );

  return lines.join('\n');
}

/**
 * @typedef {{
 *   nodes?: Array<{ type?: string, content?: string, inferred?: number }>,
 *   episodes?: Array<{ content?: string, created_at?: string }>,
 * }} MemoryData
 */

/** @param {MemoryData | null | undefined} persistentMemory */
function _buildMemorySection(persistentMemory) {
  if (!persistentMemory) return '';

  // F2.1: la sección se arma bajo un presupuesto de chars (MEMORY_SECTION_CHARS)
  // en vez de conteos fijos. Cada nodo/episodio se recorta al espacio que
  // queda; se deja de incluir cuando no cabe, sin cortar a mitad de línea.
  const budget = MEMORY_SECTION_CHARS;
  let used = 0;
  const parts = [];

  /**
   * @param {string} line
   */
  const pushLine = (line) => {
    if (line.length > budget - used) return false;
    parts.push(line);
    used += line.length;
    return true;
  };

  const nodes = persistentMemory.nodes;
  if (nodes && nodes.length > 0) {
    if (!pushLine('## Lo que sé del usuario y sus proyectos')) return '';
    for (const node of nodes) {
      // F3.3 (defensa en profundidad): un nodo inferido ($1) NUNCA entra a la
      // sección de hechos, aunque llegue colado en persistentMemory.
      if (node.inferred === 1) continue;
      if (used >= budget) break;
      const type = node.type || 'Dato';
      const props = (node.content || '').slice(0, Math.min(200, budget - used));
      if (!pushLine(`- (${type}): ${props}`)) break;
    }
  }

  const episodes = persistentMemory.episodes;
  if (episodes && episodes.length > 0) {
    // Filtrar episodios sin resumen: solo los que tienen contenido útil
    const withContent = episodes.filter((ep) => {
      const c = (ep.content || '').trim();
      return (
        c.length > 15 && !c.endsWith('null"') && !c.endsWith('null') && !/^\[.+\]\s*null/.test(c)
      );
    });
    if (withContent.length > 0 && used + '\n## Episodios recientes relevantes'.length <= budget) {
      parts.push('', '## Episodios recientes relevantes');
      used += 2 + '## Episodios recientes relevantes'.length;
      for (const ep of withContent) {
        if (used >= budget) break;
        const when = ep.created_at ? new Date(ep.created_at).toLocaleDateString('es-MX') : 'antes';
        const preview = (ep.content || '').slice(0, Math.min(200, budget - used));
        if (!pushLine(`- [${when}] ${preview}`)) break;
      }
    }
  }

  return parts.join('\n');
}

/**
 * Sección de IMPRESIONES (F3.3): el modelo que el sistema infirió del usuario
 * (nodos `inferred=1`), marcado explícitamente como hipótesis no confirmadas.
 * Esta sección vive al lado de la memoria de HECHOS a propósito: si alguien
 * edita la división "hecho vs. inferencia" después, las encuentra juntas y
 * mantienen el mismo tono anti-fabricación.
 * @typedef {Array<{ label?: string, content?: string, confidence?: number }> | null | undefined} InferredModelData
 */

/** @param {InferredModelData} inferredModel */
function _buildInferredSection(inferredModel) {
  if (!inferredModel || !inferredModel.length) return '';

  const lines = ['## Impresiones (no confirmadas por el usuario)'];
  const name = _getIdentity().name || 'Kaoru';
  lines.push(
    `Estas son inferencias de ${name}, NO cosas que el usuario dijo. ` +
      `Nunca las presentes como un hecho ni las atribuyas al usuario ('me contaste que...'). ` +
      `Si son relevantes para la respuesta, formulalas como pregunta o hipótesis abierta, nunca como afirmación.`
  );

  let used = lines.join('\n').length;
  for (const node of inferredModel) {
    const content = String(node.content || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!content) continue;
    const conf = typeof node.confidence === 'number' ? node.confidence : 0;
    const pct = `${Math.round(conf * 100)}%`;
    const line = `- (${pct}) ${content.slice(0, 200)}`;
    if (used + line.length > INFERRED_SECTION_CHARS) break;
    lines.push(line);
    used += line.length;
  }
  return lines.join('\n');
}

/**
 * @typedef {{
 *   detected?: boolean,
 *   level?: 'high' | 'medium',
 *   action?: string,
 *   confidence?: number,
 *   tool?: string,
 * }} ToolIntentData
 */

/**
 * Inyecta la instrucción de formato estructurado cuando hay toolIntent.
 * Esta es la pieza clave que conecta el embedding con el parsing del LLM.
 * @param {ToolIntentData | null | undefined} toolIntent
 */
function _buildToolIntentSection(toolIntent) {
  if (!toolIntent || !toolIntent.detected || !toolIntent.level) return '';

  const builder = TOOL_INSTRUCTIONS[toolIntent.level];
  if (!builder) return '';

  // El toolIntent ya pasó las guardas de `detected` y `level`; action/confidence
  // siempre están presentes en runtime cuando llega del IntentDetector.
  return /** @type {(intent: ToolIntentData) => string} */ (builder)(toolIntent);
}

// ── Serializer principal ──────────────────────────────────────────────────────

/**
 * Sección de ESTILO DE COMUNICACIÓN: hint de adaptación al usuario basado en
 * el perfil de estilo aprendido. Se inyecta al final del system prompt y entra
 * en el presupuesto de truncado (baja prioridad).
 * @param {string} styleHint
 */
function _buildCommStyleSection(styleHint) {
  if (!styleHint || typeof styleHint !== 'string' || !styleHint.trim()) return '';
  return `## Adaptación al usuario\n${styleHint.trim()}`;
}

class GroqSerializer {
  /**
   * Serializa el Context Package completo al formato que espera Groq/Llama.
   *
   * @param {{
   *   identity?: Identity | null,
   *   osContext?: OSContext | null,
   *   persistentMemory?: MemoryData | null,
   *   inferredModel?: InferredModelData,
   *   sessionHistory?: Array<HistoryTurn>,
   *   currentMessage?: HistoryTurn | null,
   *   toolIntent?: ToolIntentData | null,
   * }} contextPackage
   *
   * @param {{ includeMemory?: boolean }} [opts]
   *   includeMemory: incluye las secciones de memoria del usuario (hechos
   *   persistentes + impresiones inferidas) en el prompt.
   *   Por defecto NO — la memoria local del usuario (nodos/episodios del
   *   StateGraph) no se envía a proveedores externos por defecto.
   *
   * @returns {{ systemPrompt: string, messages: Array<HistoryTurn> }}
   */
  serialize(contextPackage, opts = {}) {
    const {
      identity = null,
      osContext = null,
      persistentMemory = null,
      inferredModel = null,
      sessionHistory = [],
      currentMessage = null,
      toolIntent = null,
      commStyleHint = null,
    } = contextPackage;
    const includeMemory = opts.includeMemory === true;

    // Construir secciones del system prompt
    // Identidad: cacheada (se genera UNA VEZ), NO se recalcula por turno
    // OS/Memoria/Inferencias/Intención: dinámicas, se regeneran cada turno
    const sections = [
      _getSerializedIdentity(),
      _buildOSSection(osContext),
      includeMemory ? _buildMemorySection(persistentMemory) : '',
      includeMemory ? _buildInferredSection(inferredModel) : '',
      _buildToolIntentSection(toolIntent),
      _buildMoodSection(),
      commStyleHint ? _buildCommStyleSection(commStyleHint) : '',
    ].filter(Boolean);

    // NOTA: el truncado a MAX_SYSTEM_CHARS ya NO pasa aquí — se movió a
    // Core.buildContext(), al final, después de que se pegan
    // BehaviorModel + reglas de OpenClaw + catálogo MCP. Antes esas
    // secciones se agregaban DESPUÉS de este truncado, así que el
    // presupuesto de tokens nunca las contaba.
    const systemPrompt = sections.join('\n\n---\n\n');

    // Construir el array de mensajes para la API de Groq
    /** @type {Array<HistoryTurn>} */
    const messages = [];

    // Contexto incremental: presupuesto de caracteres para el historial. Los
    // turnos recientes entran COMPLETOS; los que exceden el presupuesto se
    // condensan en un único resumen al inicio (la conversación vieja no
    // puede comerse el presupuesto de tokens de la tarea actual).
    let budget = MAX_HISTORY_CHARS;
    /** @type {Array<HistoryTurn>} */
    const recent = [];
    /** @type {Array<HistoryTurn>} */
    const overflow = [];
    for (let i = sessionHistory.length - 1; i >= 0; i--) {
      const turn = sessionHistory[i];
      const size = (turn.content ? String(turn.content).length : 0) + 64;
      if (budget > 0 && size <= budget) {
        recent.unshift(turn);
        budget -= size;
      } else {
        overflow.unshift(turn);
      }
    }

    if (overflow.length > 0) {
      const summaryText = overflow
        .map(
          (t) =>
            `${t.role === 'user' ? 'Usuario' : 'Asistente'}: ${String(t.content || '').replace(/\s+/g, ' ')}`
        )
        .join('\n');
      const cap = MAX_HISTORY_CHARS;
      messages.push({
        role: 'system',
        content: `[Conversación anterior (resumen de ${overflow.length} turnos)]:\n${summaryText.slice(0, cap)}${summaryText.length > cap ? '\n…' : ''}`,
      });
    }

    // Historial de sesión reciente (sin el mensaje actual)
    for (const turn of recent) {
      if (turn.role && turn.content) {
        messages.push({ role: turn.role, content: String(turn.content) });
      }
    }

    // Mensaje actual del usuario
    if (currentMessage?.content) {
      messages.push({
        role: currentMessage.role || 'user',
        content: String(currentMessage.content),
      });
    }

    // Groq requiere al menos un mensaje en el array
    if (messages.length === 0) {
      messages.push({ role: 'user', content: '...' });
    }

    return { systemPrompt, messages };
  }
}

module.exports = {
  GroqSerializer,
  setIdentityOverride,
  _debug_buildFormatExample: _buildFormatExample,
};
