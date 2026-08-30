// @ts-check
'use strict';

/**
 * difficulty.js — Fase 3, ítem 2/4: estimación determinista de la dificultad
 * de una tarea, usada para evaluar outcomes de aprendizaje (LearningEngine) y
 * como señal del modelo de confianza (TrustModel, ítem 4).
 *
 * Es un heurístico puro y acotado a [0,1]: no llama al LLM. Con el tiempo la
 * calibración puede sustituir este mapping (feedback de outcomes reales), pero
 * la heurística siempre debe ser la línea base.
 */

/**
 * @typedef {{ domain?: string | null }} TaskIntentLike
 */

const clamp = (/** @type {number} */ v, /** @type {number} */ min, /** @type {number} */ max) =>
  Math.min(max, Math.max(min, v));

/**
 * Señales sintácticas que sugieren una tarea compleja (código, herramientas,
 * comandos largos, múltiples pasos).
 */
const COMPLEXITY_PATTERNS = [
  /```/,
  /\b(?:\.js|\.ts|\.py|\.json|\.sh|\.md)\b/,
  /\b(?:function|class|const|let|require\s*\(|import\s)/,
  /\b(?:npm|yarn|pnpm|node|git|docker|pip)\b/,
  /(?:[A-Za-z0-9_./-]+\.\w{1,8}\s*){3,}/,
];

/**
 * Señales de INCERTIDUMBRE DE LOCALIZACIÓN: la persona no sabe DÓNDE está el
 * problema ni puede REPRODUCIRLO de forma estable ("falla a veces"). Estas
 * tareas exigen investigación exploratoria antes de tocar nada — son más
 * difíciles de lo que su sintaxis sugiere. Cada FACET presente suma +0.2
 * INDEPENDIENTE de las señales de código/longitud de arriba.
 */
const UNCERTAINTY_FACETS = [
  {
    // Localización: no sabe dónde mirar.
    patterns: [
      /no\s+s[ée]\s+d[oó]nde/i,
      /no\s+encuentro/i,
      /d[oó]nde\s+est[aá]\s+el?\s*(bug|error|problema)/i,
    ],
  },
  {
    // Reproducibilidad intermitente o investigación abierta.
    patterns: [
      /a\s+veces\s+(falla|pasa|ocurre)|falla\s+a\s+veces/i,
      /intermitente/i,
      /(?:investig[áa]|revis[áa]|mir[áa])\s+por\s+qu[ée]/i,
      /no\s+s[ée]\s+por\s+qu[ée]/i,
    ],
  },
];

/**
 * @param {object} [opts]
 * @param {string} [opts.message]          Mensaje de la tarea.
 * @param {TaskIntentLike|null} [opts.taskIntent] Intención detectada ({ domain, ... }).
 * @param {number} [opts.messageCount]     Mensajes previos en la sesión.
 * @returns {number} dificultad en [0, 1]
 */
function estimateDifficulty({ message = '', taskIntent = null, messageCount = 0 } = {}) {
  const text = String(message || '');
  let d = 0.2;

  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words > 40) d += 0.15;
  else if (words > 15) d += 0.1;

  for (const re of COMPLEXITY_PATTERNS) {
    if (re.test(text)) {
      d += 0.15;
      break;
    }
  }

  // Incertidumbre de localización: +0.2 por FACET presente (localización y/o
  // reproducibilidad intermitente), independiente de las señales de arriba.
  for (const facet of UNCERTAINTY_FACETS) {
    if (facet.patterns.some((re) => re.test(text))) d += 0.2;
  }

  if (taskIntent && taskIntent.domain && taskIntent.domain !== 'general') d += 0.15;
  if (text.length > 300) d += 0.1;
  // Sesión con mucho contexto previo → la tarea hereda más ambigüedad.
  d += Math.min(0.1, (messageCount || 0) * 0.01);

  return clamp(Math.round(d * 100) / 100, 0, 1);
}

module.exports = { estimateDifficulty };
