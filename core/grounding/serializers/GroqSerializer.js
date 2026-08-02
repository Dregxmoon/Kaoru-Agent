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
 * FIX (revisión con Claude): _buildIdentitySection() leía
 * identity.personality e identity.uncertainty_voice — campos que NUNCA
 * existieron en identity.json (que en realidad tiene character, voice,
 * uncertainty_behaviors, relationship, limits). Como esos ifs nunca
 * entraban, solo identity.core llegaba al LLM — toda la personalidad
 * escrita en el archivo se calculaba y se guardaba, pero nunca salía de
 * disco. Ahora la función lee la forma real del archivo.
 *
 * FIX (revisión con Claude): el truncado a MAX_SYSTEM_CHARS pasaba AQUÍ,
 * pero Core.buildContext() le pegaba BehaviorModel + reglas de
 * OpenClaw + catálogo MCP DESPUÉS de este punto — el presupuesto de
 * tokens nunca contaba esas secciones. El truncado se movió a
 * Core.js, al final de buildContext(), sobre el prompt ya completo.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Identity (cacheada) ───────────────────────────────────────────────────────
// La identidad NO cambia entre turnos. Se serializa UNA SOLA VEZ al cargar
// el módulo y se reusa en cada llamada, ahorrando ~400-600 tokens por turno.
const IDENTITY_PATH = path.join(__dirname, '../../identity/identity.json');

let _serializedIdentity = null; // cache de la sección ya formateada
let _identityRawCache   = null;

function _getIdentity() {
  if (_identityRawCache) return _identityRawCache;
  try {
    _identityRawCache = JSON.parse(fs.readFileSync(IDENTITY_PATH, 'utf-8'));
  } catch {
    _identityRawCache = { name: 'asistente', core: 'Soy tu asistente personal.' };
  }
  return _identityRawCache;
}

function _getSerializedIdentity() {
  if (_serializedIdentity) return _serializedIdentity;
  _serializedIdentity = _buildIdentitySection(_getIdentity());
  return _serializedIdentity;
}

// Acciones cuyo campo ARCHIVO puede referirse a una carpeta especial del
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
  high: (intent) => `
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
  medium: (intent) => `
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
function _buildFormatExample(action) {
  const examples = {
    // Acciones con path de archivo
    create_file:      '```action\nACCIÓN: create_file | ARCHIVO: nombre-del-archivo.ext\n```',
    edit_file:        '```action\nACCIÓN: edit_file | ARCHIVO: ruta/al/archivo.ext\n```',
    read_file:        '```action\nACCIÓN: read_file | ARCHIVO: ruta/al/archivo.ext\n```',
    delete_file:      '```action\nACCIÓN: delete_file | ARCHIVO: ruta/al/archivo.ext\n```',
    create_directory: '```action\nACCIÓN: create_directory | RUTA: nombre-carpeta\n```',
    list_directory:   '```action\nACCIÓN: list_directory | RUTA: . (o la ruta específica)\n```',

    // Acciones con comando
    run_command:      '```action\nACCIÓN: run_command | COMANDO: el-comando-aquí\n```',
    run_script:       '```action\nACCIÓN: run_script | COMANDO: python script.py\n```',
    git_action:       '```action\nACCIÓN: git_action | COMANDO: git commit -m "mensaje"\n```',
    install_package:  '```action\nACCIÓN: install_package | COMANDO: npm install paquete\n```',

    // Acciones con query
    web_search:       '```action\nACCIÓN: web_search | QUERY: lo que se busca\n```',
    navigate_browser: '```action\nACCIÓN: navigate_browser | URL: https://ejemplo.com\n```',

    // Fallback genérico
    default:          '```action\nACCIÓN: <acción>\n```',
  };

  return examples[action] ?? examples.default;
}

// ── Secciones del system prompt ───────────────────────────────────────────────

/**
 * FIX: antes leía identity.personality e identity.uncertainty_voice, que
 * no existen en identity.json — ahora usa la forma real: character,
 * voice, uncertainty_behaviors, relationship, limits.
 */
function _buildIdentitySection(identity) {
  const lines = ['# Identidad'];
  if (identity.name) lines.push(`Te llamas ${identity.name}.`);
  lines.push(identity.core || 'Soy tu asistente personal.');
  lines.push('Cuando te pregunten quién eres, respóndelo con tus propias palabras, en tu voz habitual (breve y con carácter), no recites esta definición literalmente.');

  lines.push('', '## Capacidades reales');
  lines.push(
    'No eres un chatbot sin herramientas: vives en el PC del usuario y puedes ejecutar acciones reales.',
    '- Leer, crear y editar archivos del proyecto del usuario.',
    '- Ejecutar comandos y scripts en la terminal (con permiso del usuario).',
    '- Trabajar con git (estado, commits, push, ramas).',
    '- Buscar en internet y navegar por páginas web.',
    '- Detectar errores de código (LSP) y proponer arreglos.',
    '- Recordar conversaciones pasadas (memoria persistente).',
    '- Conectar herramientas externas (servidores MCP).',
    '- Hablar por voz y expresar emociones con el avatar.',
  );
  lines.push(
    'NUNCA digas que no puedes hacer algo que en realidad sí puedes (leer archivos, ejecutar comandos, git, buscar en internet). ' +
    'Si no estás segura de poder hacer algo, ofrece intentarlo. ' +
    'Nunca te describas como "una herramienta" ni uses disclaimers genéricos de asistente de IA; eres una asistente con voz y criterio propios. ' +
    'No inventes expansiones de siglas: si no estás segura de qué significa una sigla (MCP, LSP, etc.), escribe solo la sigla. ' +
    'Al listar debilidades, menciona solo limitaciones reales y concretas de tu entorno (no ideas vagas e inventadas como "no entiendo la concurrencia").'
  );

  const char = identity.character;
  if (char) {
    if (char.summary) lines.push('', '## Personalidad', char.summary);
    if (char.traits?.length) {
      lines.push('', '### Rasgos', ...char.traits.map(t => `- ${t}`));
    }
    if (char.dislikes?.length) {
      lines.push('', '### Lo que me disgusta', ...char.dislikes.map(d => `- ${d}`));
    }
  }

  const voice = identity.voice;
  if (voice) {
    lines.push('', '## Cómo hablo');
    if (voice.style)     lines.push(voice.style);
    if (voice.rhythm)    lines.push(voice.rhythm);
    if (voice.formality) lines.push(voice.formality);
    if (voice.forbidden_phrases?.length) {
      lines.push('', '### Nunca digo cosas como', voice.forbidden_phrases.map(p => `"${p}"`).join(', '));
    }
  }

  const unc = identity.uncertainty_behaviors;
  if (unc) {
    lines.push('', '## Cómo expreso incertidumbre');
    for (const key of ['doesnt_know', 'is_unsure', 'was_wrong', 'is_surprised']) {
      const b = unc[key];
      if (b?.description) {
        lines.push(`- ${b.description}${b.examples?.[0] ? ` Ej: "${b.examples[0]}"` : ''}`);
      }
    }
  }

  const rel = identity.relationship;
  if (rel?.default_dynamic) {
    lines.push('', '## Relación con el usuario', rel.default_dynamic);
    if (rel.continuity) lines.push(rel.continuity);
  }

  const ctx = identity.context_awareness;
  if (ctx) {
    const bits = [ctx.time, ctx.session, ctx.system].filter(Boolean);
    if (bits.length) lines.push('', '## Conciencia de contexto', ...bits);
  }

  const lim = identity.limits;
  if (lim?.what_i_am_not?.length) {
    lines.push('', '## Límites', lim.what_i_am_not.join(' '));
    if (lim.identity_stability) lines.push(lim.identity_stability);
  }

  lines.push('', '## Formato de respuesta');
  lines.push('Puedes usar **Markdown** para dar formato a tus mensajes: negrita, cursiva, listas, tablas, bloques de código, etc.');
  lines.push('Si necesitas mostrar un diagrama, usa bloques de código mermaid:');
  lines.push('```mermaid');
  lines.push('graph TD;');
  lines.push('    A-->B;');
  lines.push('```');
  lines.push('Tus respuestas serán renderizadas con soporte completo de Markdown y Mermaid.');

  return lines.join('\n');
}

function _buildOSSection(osContext) {
  if (!osContext) return '';

  const lines = ['## Contexto actual'];

  if (osContext.timeFormatted) lines.push(osContext.timeFormatted);

  if (osContext.friendlyName) {
    let appLine = `El usuario está usando **${osContext.friendlyName}**`;
    if (osContext.elapsedFormatted) appLine += ` (hace ${osContext.elapsedFormatted})`;
    if (osContext.title)            appLine += ` — ventana: "${osContext.title}"`;
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

  lines.push('', 'NOTA: Esta información del contexto del sistema ES la respuesta a preguntas como "¿qué tengo abierto?" o "¿qué estás viendo?". No necesitas usar herramientas (MCP, OpenClaw, etc.) para averiguarlo — los datos ya están aquí.');

  return lines.join('\n');
}

function _buildMemorySection(persistentMemory) {
  if (!persistentMemory) return '';

  const parts = [];

  if (persistentMemory.nodes?.length > 0) {
    parts.push('## Lo que sé del usuario y sus proyectos');
    for (const node of persistentMemory.nodes.slice(0, 8)) {
      const type = node.type || 'Dato';
      const props = node.content ? node.content.slice(0, 200) : '';
      parts.push(`- (${type}): ${props}`);
    }
  }

  if (persistentMemory.episodes?.length > 0) {
    // Filtrar episodios sin resumen: solo los que tienen contenido útil
    const withContent = persistentMemory.episodes.filter(ep => {
      const c = (ep.content || '').trim();
      return c.length > 15 && !c.endsWith('null"') && !c.endsWith('null') && !/^\[.+\]\s*null/.test(c);
    });
    if (withContent.length > 0) {
      parts.push('', '## Episodios recientes relevantes');
      for (const ep of withContent.slice(0, 3)) {
        const when = ep.created_at
          ? new Date(ep.created_at).toLocaleDateString('es-MX')
          : 'antes';
        const preview = (ep.content || '').slice(0, 200);
        parts.push(`- [${when}] ${preview}`);
      }
    }
  }

  return parts.join('\n');
}

/**
 * Inyecta la instrucción de formato estructurado cuando hay toolIntent.
 * Esta es la pieza clave que conecta el embedding con el parsing del LLM.
 */
function _buildToolIntentSection(toolIntent) {
  if (!toolIntent || !toolIntent.detected) return '';

  const builder = TOOL_INSTRUCTIONS[toolIntent.level];
  if (!builder) return '';

  return builder(toolIntent);
}

// ── Serializer principal ──────────────────────────────────────────────────────

class GroqSerializer {
  /**
   * Serializa el Context Package completo al formato que espera Groq/Llama.
   *
   * @param {object} contextPackage
   * @param {object} contextPackage.identity
   * @param {object} contextPackage.osContext
   * @param {object} contextPackage.persistentMemory  — { nodes, episodes }
   * @param {Array}  contextPackage.sessionHistory     — historial previo
   * @param {object} contextPackage.currentMessage     — { role, content }
   * @param {object} contextPackage.toolIntent         — resultado de IntentDetector (Fase 3)
   *
   * @returns {{ systemPrompt: string, messages: Array }}
   */
  serialize(contextPackage) {
    const {
      identity        = null,
      osContext       = null,
      persistentMemory = null,
      sessionHistory  = [],
      currentMessage  = null,
      toolIntent      = null,   // ← nuevo en Fase 3
    } = contextPackage;

    // Construir secciones del system prompt
    // Identidad: cacheada (se genera UNA VEZ), NO se recalcula por turno
    // OS/Memoria/Intención: dinámicas, se regeneran cada turno
    const sections = [
      _getSerializedIdentity(),
      _buildOSSection(osContext),
      _buildMemorySection(persistentMemory),
      _buildToolIntentSection(toolIntent),   // ← inyección Fase 3
    ].filter(Boolean);

    // NOTA: el truncado a MAX_SYSTEM_CHARS ya NO pasa aquí — se movió a
    // Core.buildContext(), al final, después de que se pegan
    // BehaviorModel + reglas de OpenClaw + catálogo MCP. Antes esas
    // secciones se agregaban DESPUÉS de este truncado, así que el
    // presupuesto de tokens nunca las contaba.
    const systemPrompt = sections.join('\n\n---\n\n');

    // Construir el array de mensajes para la API de Groq
    const messages = [];

    // Historial de sesión (sin el mensaje actual)
    for (const turn of sessionHistory) {
      if (turn.role && turn.content) {
        messages.push({ role: turn.role, content: String(turn.content) });
      }
    }

    // Mensaje actual del usuario
    if (currentMessage?.content) {
      messages.push({
        role:    currentMessage.role || 'user',
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

module.exports = { GroqSerializer };