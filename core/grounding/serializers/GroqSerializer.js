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
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Identity ──────────────────────────────────────────────────────────────────
const IDENTITY_PATH = path.join(__dirname, '../identity/identity.json');
let _identityCache = null;

function _getIdentity() {
  if (_identityCache) return _identityCache;
  try {
    _identityCache = JSON.parse(fs.readFileSync(IDENTITY_PATH, 'utf-8'));
  } catch {
    _identityCache = { name: 'March 7th', core: 'Soy March 7th.' };
  }
  return _identityCache;
}

// ── Límite de tokens del sistema ──────────────────────────────────────────────
// Groq/Llama-3.3-70B: contexto de 32k tokens. Reservamos ~1.5k para la
// respuesta y ~2k para el historial de sesión, lo que deja ~28k para
// el system prompt + memoria.
const MAX_SYSTEM_CHARS = 14_000; // ~3.5k tokens — conservador pero amplio

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

Conversa naturalmente con el usuario, confirma lo que vas a hacer, y luego incluye el bloque.
Si necesitas más información (ruta del archivo, nombre, etc.), pregunta ANTES de incluir el bloque.
`.trim(),

  // El LLM DEBERÍA usar el formato estructurado si confirma la intención
  medium: (intent) => `
## POSIBLE INTENCIÓN DE HERRAMIENTA (confianza media: ${(intent.confidence * 100).toFixed(0)}%)

Es posible que el usuario quiera ejecutar: **${intent.action}**
${intent.tool ? `Herramienta disponible: \`${intent.tool}\`\n` : ''}
Si confirmas que esto es lo que el usuario quiere, incluye al final de tu respuesta:

${_buildFormatExample(intent.action)}

Si es solo una pregunta o conversación, responde normalmente sin el bloque.
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

function _buildIdentitySection(identity) {
  const lines = [
    `# Identidad`,
    identity.core || identity.description || 'Soy March 7th.',
  ];

  if (identity.personality) {
    lines.push('', '## Personalidad', identity.personality);
  }

  if (identity.uncertainty_voice) {
    lines.push('', '## Cómo expreso incertidumbre', identity.uncertainty_voice);
  }

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

  return lines.join('\n');
}

function _buildMemorySection(persistentMemory) {
  if (!persistentMemory) return '';

  const parts = [];

  if (persistentMemory.nodes?.length > 0) {
    parts.push('## Lo que sé del usuario y sus proyectos');
    for (const node of persistentMemory.nodes.slice(0, 8)) {
      const label = node.label || node.id;
      const props = node.properties ? JSON.stringify(node.properties).slice(0, 200) : '';
      parts.push(`- **${label}** (${node.type}): ${props}`);
    }
  }

  if (persistentMemory.episodes?.length > 0) {
    parts.push('', '## Episodios recientes relevantes');
    for (const ep of persistentMemory.episodes.slice(0, 5)) {
      const when = ep.created_at
        ? new Date(ep.created_at * 1000).toLocaleDateString('es-MX')
        : 'antes';
      parts.push(`- [${when}] ${ep.label || ep.summary || ep.id}`);
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

    const id = identity ?? _getIdentity();

    // Construir secciones del system prompt
    const sections = [
      _buildIdentitySection(id),
      _buildOSSection(osContext),
      _buildMemorySection(persistentMemory),
      _buildToolIntentSection(toolIntent),   // ← inyección Fase 3
    ].filter(Boolean);

    let systemPrompt = sections.join('\n\n---\n\n');

    // Truncar si es demasiado largo (no debería pasar en uso normal)
    if (systemPrompt.length > MAX_SYSTEM_CHARS) {
      console.warn(`[groq-serializer] system prompt truncado: ${systemPrompt.length} → ${MAX_SYSTEM_CHARS} chars`);
      systemPrompt = systemPrompt.slice(0, MAX_SYSTEM_CHARS) + '\n\n[contexto truncado por longitud]';
    }

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