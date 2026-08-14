// @ts-check
'use strict';

// GestureVocabulary — construye la sección del system prompt que le dice al
// LLM qué gestos puede intercalar en su respuesta como marcadores inline
// `(gesto: <nombre>)`. El vocabulario se extrae del modelo Live2D ACTIVO en
// tiempo de ejecución (ModelAugmenter.listGestures + GestureHeuristic), así
// que funciona con cualquier modelo — incluidos los que traen nombres de
// gestos en otros idiomas (chino, japonés) que no caben en el vocabulario
// canónico. El motor (GestureEngine) es quien orquesta y resuelve el gesto
// final; el LLM solo elige de la lista que ve aquí.

const ModelAugmenter = require('./ModelAugmenter.js');
const GestureHeuristic = require('./GestureHeuristic.js');

const _cache = new Map(); // model3Path → sección (string | '')

// Máximo de gestos "extra" (nombres reales no mapeados) que se listan en el
// prompt para no inflarlo; el resto se omite con un "…". El LLM no necesita
// verlos todos para elegir bien.
const MAX_EXTRA_GESTURES = 12;

// Reglas fijas: moderación (máx. 2 por mensaje) y la sintaxis exacta. Se
// incluyen SIEMPRE que la sección exista; así el LLM no inventa formatos.
const RULES =
  'Reglas:\n' +
  '- Escribe los gestos como (gesto: <nombre>) dentro de tu texto, en el momento exacto en que el gesto ocurre (saludo, reacción, pausa de pensamiento, despedida).\n' +
  '- Usa como máximo 2 gestos por mensaje y solo cuando aporten naturalidad.\n' +
  '- Usa SOLO los nombres de la lista anterior; no inventes ni traduzcas otros.\n' +
  '- En respuestas puramente técnicas o de código, no uses gestos.';

/**
 * Construye la sección de gestos para el prompt de un modelo dado.
 * @param {string} model3Path ruta absoluta al model3.json
 * @param {{ mappings?: Object }} [opts]
 * @returns {string} sección lista para concatenar ('' si no hay gestos)
 */
function buildGestureSection(model3Path, opts = {}) {
  if (!model3Path || typeof model3Path !== 'string') return '';
  const cacheKey = `${model3Path}|${JSON.stringify(opts.mappings || {})}`;
  if (_cache.has(cacheKey)) return _cache.get(cacheKey);

  let gestures;
  try {
    gestures = ModelAugmenter.listGestures(model3Path);
  } catch {
    gestures = { modelName: '', expressions: [], motions: [] };
  }
  const hasAny = (gestures.expressions?.length || 0) + (gestures.motions?.length || 0) > 0;
  if (!hasAny) {
    _cache.set(cacheKey, '');
    return '';
  }

  // Moods canónicos que el modelo SÍ puede reproducir (map mood → gesto) +
  // gestos reales que no cayeron en ningún mood (nombres exactos, otros
  // idiomas, animaciones únicas). El LLM puede usar mood canónico O el nombre
  // real; el motor resuelve ambos.
  const { map, unmapped } = GestureHeuristic.resolveAll(gestures, {
    mappings: opts.mappings || {},
  });
  const moods = Object.keys(map);

  const lines = [
    '# GESTOS PARA TU AVATAR',
    'Puedes intercalar gestos del modelo en tu respuesta para animar al avatar.',
    '',
  ];
  if (moods.length) {
    lines.push(
      'Emociones y acciones (usa estos nombres): ' + moods.map((m) => `"${m}"`).join(', ') + '.'
    );
  }
  if (unmapped.length) {
    const shown = unmapped.slice(0, MAX_EXTRA_GESTURES);
    lines.push(
      'Gestos adicionales del modelo actual (usa el nombre EXACTO, aunque esté en otro idioma): ' +
        shown.map((n) => `"${n}"`).join(', ') +
        (unmapped.length > shown.length ? ', …' : '') +
        '.'
    );
  }
  lines.push('', RULES);

  const section = lines.join('\n');
  _cache.set(cacheKey, section);
  return section;
}

function resetCache() {
  _cache.clear();
}

module.exports = { buildGestureSection, resetCache };
