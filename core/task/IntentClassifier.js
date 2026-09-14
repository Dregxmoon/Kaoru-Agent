// @ts-check
'use strict';

/**
 * IntentClassifier.js — intenciones por INFERENCIA, no por palabras.
 *
 * Clasifica el mensaje del usuario en un dominio de tarea comparando su
 * embedding contra descripciones genéricas de cada dominio (coseno). Usa el
 * MISMO modelo central (EmbedModel.js): cero dependencias nuevas,
 * offline, ~ms por mensaje, sin listas por idioma.
 *
 * No reemplaza a TaskDetector de golpe: context.js lo usa cuando el regex
 * queda débil (sin tarea, sin confianza o sin dominio) y el regex queda como
 * fallback si los embeddings no están disponibles. La precisión por idioma
 * depende del modelo activo; los tests sintéticos no prueban esa cobertura.
 */

const { EMBED_DIMS } = require('../grounding/EmbedModel.js');

// Umbrales de similitud y margen entre dominios. El fallback semántico
// no autoriza acciones y puede rechazar mensajes ambiguos. Deben calibrarse
// con el modelo activo; los tests con vectores sintéticos prueban solo la lógica.
const THRESHOLD_HIGH = 0.7;
const THRESHOLD_LOW = 0.55;
const THRESHOLD_MARGIN = 0.08;

/**
 * Ejemplos realistas por dominio (ES+EN mezclado a propósito: el modelo
 * multilingüe los acerca sin importar el idioma del mensaje). Son CONSULTAS
 * concretas —incluidas compuestas— porque los embeddings separan mucho mejor
 * lo concreto que lo abstracto (medido en vivo: descripciones abstractas no
 * pasan de 0.55 ni en el mejor caso). No compiten con intent_catalog (allá
 * van acciones exactas con su tool); aquí solo importa el DOMINIO ganador.
 */
const DOMAIN_DESCRIPTIONS = Object.freeze({
  code: [
    'escribe una función que ordene una lista',
    'write a function that sorts a list',
    'corrige el bug del login',
  ],
  filesystem: [
    'crea una carpeta nueva para fotos',
    'create a new folder for photos',
    'lee el archivo de configuración',
    'muéstrame qué archivos hay aquí',
  ],
  git: ['haz un commit con los cambios', 'make a commit with the changes', 'sube esto a github'],
  shell: ['ejecuta npm test en la terminal', 'run npm test in the terminal', 'corre este comando'],
  web: [
    'abre amazon y busca un producto',
    'open amazon and check availability',
    'busca en internet cómo configurar algo',
    'ábreme la página de la tienda',
    'open amazon and check if the product is available',
    'abre amazon y mira si está disponible',
  ],
  system: [
    'abre mi libreoffice writer',
    'open writer and write an essay',
    'lanza el juego de ajedrez',
    'inicia blender',
  ],
  multimedia: [
    'ponme lo más reciente de youtube',
    'play the latest video from the channel',
    'reproduce un video de guitarra',
    'pon música para concentrarme',
  ],
  mcp: ['usa la herramienta externa de archivos', 'use the connected external tool'],
  package: [
    'instala el paquete express con npm',
    'install the express package',
    'pip install requests',
  ],
  docker: ['levanta los contenedores docker', 'start the docker containers', 'construye la imagen'],
  network: ['revisa si hay conexión a internet', 'check the internet connection'],
  data: ['analiza este csv y resume', 'analyze this csv file'],
});

/** @type {Map<string, Float32Array>} caché de embeddings de descripciones */
const _descriptionCache = new Map();

/**
 * @typedef {object} ClassifyResult
 * @property {boolean} isTask
 * @property {{id: string}|null} domain
 * @property {number} confidence
 * @property {'high'|'medium'|'none'} level
 * @property {Record<string, number>} scores
 */

/** @param {ArrayLike<number>} a @param {ArrayLike<number>} b @returns {number} */
function _cosine(a, b) {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA <= 0 || normB <= 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * @param {string[]} descriptions
 * @param {(text: string) => Promise<Float32Array|number[]>} embedFn
 * @returns {Promise<Array<Float32Array>>}
 */
async function _embedDescriptions(descriptions, embedFn) {
  /** @type {Array<Float32Array>} */
  const vectors = [];
  for (const text of descriptions) {
    const cached = _descriptionCache.get(text);
    if (cached) {
      vectors.push(cached);
      continue;
    }
    const raw = await embedFn(text);
    if (!raw || raw.length !== EMBED_DIMS) continue;
    const vector = raw instanceof Float32Array ? raw : Float32Array.from(raw);
    _descriptionCache.set(text, vector);
    vectors.push(vector);
  }
  return vectors;
}

function clearDescriptionCache() {
  _descriptionCache.clear();
}

/**
 * Clasifica un mensaje en un dominio de tarea por similitud de embeddings.
 * @param {unknown} text mensaje del usuario
 * @param {{embedFn?: (text: string) => Promise<Float32Array|number[]>, high?: number, low?: number, margin?: number}} [options] embedFn inyectable (tests) o EmbedService en producción
 * @returns {Promise<ClassifyResult>}
 */
async function classify(text, options = {}) {
  /** @type {ClassifyResult} */
  const empty = { isTask: false, domain: null, confidence: 0, level: 'none', scores: {} };
  const message = String(text || '').trim();
  const embedFn = options.embedFn;
  if (!message || typeof embedFn !== 'function') return empty;
  const high = typeof options.high === 'number' ? options.high : THRESHOLD_HIGH;
  const low = typeof options.low === 'number' ? options.low : THRESHOLD_LOW;
  const margin = typeof options.margin === 'number' ? options.margin : THRESHOLD_MARGIN;

  let queryVector;
  try {
    queryVector = await embedFn(message);
  } catch (_) {
    return empty;
  }
  if (!queryVector || queryVector.length !== EMBED_DIMS) return empty;

  /** @type {Record<string, number>} */
  const scores = {};
  let bestId = null;
  let bestScore = 0;
  let runnerUp = 0;
  for (const [id, descriptions] of Object.entries(DOMAIN_DESCRIPTIONS)) {
    let vectors;
    try {
      vectors = await _embedDescriptions(descriptions, embedFn);
    } catch (_) {
      continue;
    }
    let best = 0;
    for (const vector of vectors) {
      const sim = _cosine(queryVector, vector);
      if (sim > best) best = sim;
    }
    scores[id] = Math.round(best * 10000) / 10000;
    if (best > bestScore) {
      runnerUp = bestScore;
      bestScore = best;
      bestId = id;
    } else if (best > runnerUp) {
      runnerUp = best;
    }
  }
  // Sin margen no hay decisión: el ruido OOV ("nissaxter") o el empate de
  // charla ("qué hay de nuevo") deben caer a none, no a un dominio al azar.
  if (!bestId || bestScore < low || bestScore - runnerUp < margin) {
    return { ...empty, scores };
  }
  const level = bestScore >= high ? 'high' : 'medium';
  return {
    isTask: true,
    domain: { id: bestId },
    confidence: Math.round(bestScore * 10000) / 10000,
    level,
    scores,
  };
}

module.exports = {
  classify,
  clearDescriptionCache,
  DOMAIN_DESCRIPTIONS,
  THRESHOLD_HIGH,
  THRESHOLD_LOW,
  THRESHOLD_MARGIN,
};
