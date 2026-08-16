// @ts-check
/**
 * IdentitySerializer.js — builder ÚNICO identidad → texto de system prompt.
 *
 * Reemplaza la duplicación que había en dos consumidores, cada uno con su
 * propia copia del mismo mapping:
 *
 *   - `serializeIdentity()`  → formato completo/canónico (antes
 *     `GroqSerializer._buildIdentitySection`). Salida byte a byte idéntica.
 *   - `serializeMinimal()`   → formato legacy Fase 0 (antes
 *     `GroundingMinimo.serializeIdentity`), usado solo por el fallback.
 *     Salida byte a byte idéntica.
 *   - `serializeMoodDelta()` → sección delta dinámica corta (Fase B del motor
 *     de identidad): mood transitorio agregado como `## Estado actual`, con
 *     plantillas fijas de `identity.dynamics.json` (nunca texto libre del LLM)
 *     filtradas por `voice.forbidden_phrases` — modula el tono, no la base.
 *
 * `identity.json` sigue siendo la única fuente de verdad de quién es Kaoru;
 * este módulo solo la serializa, no la reescribe.
 */

'use strict';

const { getIdentity } = require('./IdentityStore.js');
const { getDynamicsConfig } = require('./DynamicsConfig.js');

/**
 * @typedef {import('./DynamicsConfig.js').DynamicsConfigShape} DynamicsConfigShape
 */

// ── Tipos (misma forma que identity.json) ────────────────────────────────────

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
 * @typedef {{
 *   mood: string,
 *   intensity: number,
 *   reason: string | null,
 * }} MoodSnapshot
 */

// ── Formato completo/canónico (GroqSerializer) ───────────────────────────────

/**
 * FIX: la versión original leía identity.personality e identity.uncertainty_voice,
 * que no existen en identity.json — ahora usa la forma real: character, voice,
 * uncertainty_behaviors, relationship, limits. Misma salida que producía
 * `GroqSerializer._buildIdentitySection`.
 * @param {Identity} identity
 * @returns {string}
 */
function serializeIdentity(identity) {
  const lines = ['# Identidad'];
  if (identity.name) lines.push(`Te llamas ${identity.name}.`);
  lines.push(identity.core || 'Soy tu asistente personal.');
  lines.push(
    'Cuando te pregunten quién eres, respóndelo con tus propias palabras, en tu voz habitual (breve y con carácter), no recites esta definición literalmente.'
  );

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
    '- Hablar por voz y expresar emociones con el avatar.'
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
      lines.push('', '### Rasgos', ...char.traits.map((t) => `- ${t}`));
    }
    if (char.dislikes?.length) {
      lines.push('', '### Lo que me disgusta', ...char.dislikes.map((d) => `- ${d}`));
    }
  }

  const voice = identity.voice;
  if (voice) {
    lines.push('', '## Cómo hablo');
    if (voice.style) lines.push(voice.style);
    if (voice.rhythm) lines.push(voice.rhythm);
    if (voice.formality) lines.push(voice.formality);
    if (voice.forbidden_phrases?.length) {
      lines.push(
        '',
        '### Nunca digo cosas como',
        voice.forbidden_phrases.map((p) => `"${p}"`).join(', ')
      );
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
    const bits = [ctx.time, ctx.session, ctx.system].filter(
      (/** @type {string | undefined} */ b) => b
    );
    if (bits.length) lines.push('', '## Conciencia de contexto', .../** @type {string[]} */ (bits));
  }

  const lim = identity.limits;
  if (lim?.what_i_am_not?.length) {
    lines.push('', '## Límites', lim.what_i_am_not.join(' '));
    if (lim.identity_stability) lines.push(lim.identity_stability);
  }

  lines.push('', '## Formato de respuesta');
  lines.push(
    'Puedes usar **Markdown** para dar formato a tus mensajes: negrita, cursiva, listas, tablas, bloques de código, etc.'
  );
  lines.push('Si necesitas mostrar un diagrama, usa bloques de código mermaid:');
  lines.push('```mermaid');
  lines.push('graph TD;');
  lines.push('    A-->B;');
  lines.push('```');
  lines.push('Tus respuestas serán renderizadas con soporte completo de Markdown y Mermaid.');

  return lines.join('\n');
}

// ── Formato legacy Fase 0 (GroundingMinimo, solo fallback) ───────────────────

/**
 * Misma salida que producía `GroundingMinimo.serializeIdentity`. Se mantiene
 * byte a byte idéntica: es el formato del camino de emergencia cuando el
 * pipeline de grounding no está disponible.
 * @typedef {{
 *   core: string,
 *   character?: { summary?: string, traits?: string[] },
 *   voice?: { style?: string, forbidden_phrases?: string[] },
 *   uncertainty_behaviors?: Record<string, { description?: string }>,
 *   limits?: { what_i_am_not?: string[] },
 * }} MinimalIdentity
 */

/**
 * @param {MinimalIdentity} identity
 * @returns {string}
 */
function serializeMinimal(identity) {
  const lines = [];

  lines.push(`# QUIÉN SOY`);
  lines.push(identity.core);
  lines.push('');

  if (identity.character) {
    lines.push(`# CARÁCTER`);
    lines.push(identity.character.summary ?? '');
    if (identity.character.traits?.length) {
      identity.character.traits.forEach((t) => lines.push(`- ${t}`));
    }
    lines.push('');
  }

  if (identity.voice) {
    lines.push(`# VOZ Y ESTILO`);
    lines.push(identity.voice.style ?? '');
    if (identity.voice.forbidden_phrases?.length) {
      lines.push(`Nunca uso estas frases: ${identity.voice.forbidden_phrases.join(' | ')}`);
    }
    lines.push('');
  }

  if (identity.uncertainty_behaviors) {
    lines.push(`# CÓMO ME COMPORTO CUANDO NO SÉ ALGO`);
    const ub = identity.uncertainty_behaviors;
    lines.push(`Cuando no sé algo: ${ub.doesnt_know?.description ?? ''}`);
    lines.push(`Cuando estoy insegura: ${ub.is_unsure?.description ?? ''}`);
    lines.push(`Cuando me equivoco: ${ub.was_wrong?.description ?? ''}`);
    lines.push(`Cuando me sorprenden: ${ub.is_surprised?.description ?? ''}`);
    lines.push('');
  }

  if (identity.limits?.what_i_am_not?.length) {
    lines.push(`# LO QUE NO SOY`);
    identity.limits.what_i_am_not.forEach((l) => lines.push(`- ${l}`));
    lines.push('');
  }

  return lines.join('\n');
}

// ── Sección delta dinámica (Fase B del motor de identidad) ───────────────────

/**
 * Sección delta corta del estado emocional actual. Vuelve '' si el mood es
 * 'default' o no hay plantilla en `identity.dynamics.json`. Las plantillas son
 * texto FIJO (determinista, sin LLM) y pasan por el filtro de
 * `voice.forbidden_phrases` — el mood modula tono e intensidad, nunca
 * contradice la identidad base.
 *
 * @param {MoodSnapshot | null} mood
 * @returns {string}
 */
function serializeMoodDelta(mood) {
  if (!mood || mood.mood === 'default' || !mood.reason) return '';

  const cfg = getDynamicsConfig().mood_engine || {};
  const lines = cfg.notes?.[mood.mood];
  if (!Array.isArray(lines) || lines.length === 0) return '';

  // Regla dura: ninguna señal dinámica puede violar voice.forbidden_phrases.
  const voice = /** @type {{voice?: {forbidden_phrases?: string[]}}} */ (getIdentity()).voice;
  const forbidden = (voice?.forbidden_phrases || []).map((p) => p.trim()).filter(Boolean);
  const safe = lines.filter((l) => !forbidden.some((f) => f && String(l).includes(f)));
  if (safe.length === 0) return '';

  return ['## Estado actual', '', ...safe].join('\n');
}

module.exports = { serializeIdentity, serializeMinimal, serializeMoodDelta };
