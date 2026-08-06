/**
 * GroundingMinimo.js — Fase 0
 *
 * Construye el Context Package mínimo que recibe el LLM en cada turno:
 *   - Identity Core completo (quién es el asistente)
 *   - Últimas N interacciones de la sesión actual (working memory)
 *   - Contexto básico del OS: hora, día, plataforma
 *
 * En Fase 1 esto se expande con State Graph (memoria entre sesiones).
 * En Fase 2 se expande con OS Sensor (app activa, actividad del usuario).
 * Por ahora: mínimo funcional para que el asistente deje de responder con strings aleatorios.
 */

const { getIdentity: getIdentityStore } = require('../identity/IdentityStore.js');

// ── Cargar Identity Core ──────────────────────────────────────────────────────
let _identity = null;

function getIdentity() {
  if (_identity) return _identity;
  _identity = getIdentityStore();
  console.log('[grounding] identity.json cargado');
  return _identity;
}

// ── Contexto del OS ───────────────────────────────────────────────────────────
function getOSContext() {
  const now = new Date();
  const hour = now.getHours();

  let timeOfDay;
  if (hour >= 5 && hour < 12) timeOfDay = 'mañana';
  else if (hour >= 12 && hour < 18) timeOfDay = 'tarde';
  else if (hour >= 18 && hour < 22) timeOfDay = 'noche';
  else timeOfDay = 'madrugada';

  const days = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const dayName = days[now.getDay()];

  return {
    time: now.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }),
    date: now.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' }),
    timeOfDay,
    dayName,
    platform: process.platform,
    formatted: `Son las ${now.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })} del ${dayName} por la ${timeOfDay}.`,
  };
}

// ── Serializar Identity Core a texto ──────────────────────────────────────────
function serializeIdentity(identity) {
  const lines = [];

  lines.push(`# QUIÉN SOY`);
  lines.push(identity.core);
  lines.push('');

  if (identity.character) {
    lines.push(`# CARÁCTER`);
    lines.push(identity.character.summary);
    if (identity.character.traits?.length) {
      identity.character.traits.forEach((t) => lines.push(`- ${t}`));
    }
    lines.push('');
  }

  if (identity.voice) {
    lines.push(`# VOZ Y ESTILO`);
    lines.push(identity.voice.style);
    if (identity.voice.forbidden_phrases?.length) {
      lines.push(`Nunca uso estas frases: ${identity.voice.forbidden_phrases.join(' | ')}`);
    }
    lines.push('');
  }

  if (identity.uncertainty_behaviors) {
    lines.push(`# CÓMO ME COMPORTO CUANDO NO SÉ ALGO`);
    const ub = identity.uncertainty_behaviors;
    lines.push(`Cuando no sé algo: ${ub.doesnt_know?.description}`);
    lines.push(`Cuando estoy insegura: ${ub.is_unsure?.description}`);
    lines.push(`Cuando me equivoco: ${ub.was_wrong?.description}`);
    lines.push(`Cuando me sorprenden: ${ub.is_surprised?.description}`);
    lines.push('');
  }

  if (identity.limits?.what_i_am_not?.length) {
    lines.push(`# LO QUE NO SOY`);
    identity.limits.what_i_am_not.forEach((l) => lines.push(`- ${l}`));
    lines.push('');
  }

  return lines.join('\n');
}

// ── Serializar working memory (historial de sesión) ───────────────────────────
function serializeWorkingMemory(history, maxTurns = 8) {
  if (!history || history.length === 0) return '';

  // Tomar los últimos maxTurns mensajes (excluir el actual que se está procesando)
  const recent = history.slice(-maxTurns);

  const lines = ['# CONVERSACIÓN ACTUAL (esta sesión)'];
  recent.forEach((msg) => {
    const role = msg.role === 'user' ? 'Usuario' : 'Asistente';
    lines.push(`${role}: ${msg.content}`);
  });

  return lines.join('\n');
}

// ── Construir System Prompt completo ─────────────────────────────────────────

/**
 * Construye el system prompt completo para un turno.
 *
 * @param {Array}  sessionHistory — [{role: 'user'|'assistant', content: string}]
 *                                  historial de la sesión actual (sin el mensaje actual)
 * @returns {string} — system prompt listo para enviar al LLM
 */
function buildSystemPrompt(sessionHistory = []) {
  const identity = getIdentity();
  const os = getOSContext();

  const sections = [];

  // 1. Identidad
  sections.push(serializeIdentity(identity));

  // 2. Contexto temporal
  sections.push(`# CONTEXTO ACTUAL`);
  sections.push(os.formatted);
  sections.push('');

  // 3. Working memory (últimas interacciones de esta sesión)
  const memSection = serializeWorkingMemory(sessionHistory, 8);
  if (memSection) {
    sections.push(memSection);
    sections.push('');
  }

  // 4. Instrucción final
  sections.push(`# INSTRUCCIÓN`);
  sections.push(
    `Responde como la asistente personal. Sé concisa cuando el momento lo pide, más extensa cuando el tema lo merece. No uses las frases prohibidas. No te presentes a ti misma en cada mensaje. Responde en el idioma en que te hablen.`
  );

  return sections.join('\n');
}

/**
 * Construye el array de mensajes para el LLM.
 * Separa el historial del mensaje actual para que el LLM lo vea como conversación.
 *
 * @param {Array}  sessionHistory — historial completo incluyendo el mensaje actual
 * @returns {{ messages: Array, systemPrompt: string }}
 */
function buildContext(sessionHistory = []) {
  // El último mensaje es el actual (del usuario)
  // Los anteriores son el historial para working memory en el system prompt
  const history = sessionHistory.slice(0, -1);
  const current = sessionHistory.slice(-1);

  const systemPrompt = buildSystemPrompt(history);

  // Para el LLM solo enviamos el mensaje actual como "user"
  // (el historial ya está serializado en el system prompt como contexto)
  // Esto mantiene el prompt limpio y dentro del context window
  const messages = current.length > 0 ? current : [];

  return { messages, systemPrompt };
}

module.exports = { buildContext, getOSContext, getIdentity };
