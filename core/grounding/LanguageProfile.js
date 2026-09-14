// @ts-check
'use strict';

/**
 * LanguageProfile.js — el sistema no está enfocado a un idioma: muta según el
 * usuario, sin ramas de comportamiento por idioma en el código.
 *
 * Principio: el idioma vive en DOS lugares y solo dos — el texto libre del
 * usuario y la respuesta final. Todo lo intermedio (tools, params, formatos,
 * protocolos) es una interlingua canónica en inglés técnico que el LLM produce
 * por inferencia. Este módulo solo responde "¿en qué idioma habla el usuario
 * en este turno?" y deriva de ahí datos (locale, voz, modelo ASR). Ninguna
 * decisión de tarea se ramifica por idioma.
 *
 * Detección en dos capas, ambas genéricas:
 *   1. Escritura Unicode (rangos de script): 100% genérica, cero listas de
 *      palabras. Hiragana/Katakana→ja, Hangul→ko, Han→zh, etc.
 *   2. Latín: conteo de stopwords sobre una tabla mínima SOLO para detectar
 *      (no para decidir nada). Sin señal suficiente → default 'es' con
 *      confianza baja (Kaoru nació en español; el usuario puede fijar otro
 *      idioma en preferencias y eso siempre gana).
 */

/** @typedef {{code: string, name: string, confidence: number, source: 'script'|'stopwords'|'default'|'override'}} LanguageDetection */

/** Rangos de escritura → idioma. Tabla de datos, no lógica por idioma. */
const SCRIPT_RANGES = Object.freeze([
  { re: /[\u3040-\u309F\u30A0-\u30FF]/, code: 'ja', name: 'japonés' },
  { re: /[\uAC00-\uD7AF\u1100-\u11FF]/, code: 'ko', name: 'coreano' },
  { re: /[\u4E00-\u9FFF\u3400-\u4DBF]/, code: 'zh', name: 'chino' },
  { re: /[\u0400-\u04FF]/, code: 'ru', name: 'ruso' },
  { re: /[\u0600-\u06FF]/, code: 'ar', name: 'árabe' },
  { re: /[\u0E00-\u0E7F]/, code: 'th', name: 'tailandés' },
  { re: /[\u0900-\u097F]/, code: 'hi', name: 'hindi' },
  { re: /[\u0370-\u03FF]/, code: 'el', name: 'griego' },
  { re: /[\u0590-\u05FF]/, code: 'he', name: 'hebreo' },
]);

/**
 * Stopwords mínimas por idioma latino. SOLO detección: ninguna regla de tarea,
 * parser o serializer las consulta para decidir comportamiento.
 */
const LATIN_STOPWORDS = Object.freeze({
  es: ['el', 'la', 'que', 'de', 'una', 'los', 'está', 'gracias', 'hola', 'por'],
  en: ['the', 'and', 'you', 'please', 'thanks', 'hello', 'what', 'with', 'your'],
  pt: ['você', 'obrigado', 'para', 'uma', 'este', 'como', 'não', 'mais', 'muito'],
  fr: ['merci', 'bonjour', 'vous', 'avec', 'pour'],
  de: ['danke', 'bitte', 'und', 'für', 'haben'],
  it: ['grazie', 'ciao', 'come', 'sono', 'della'],
});

const LANGUAGE_NAMES = Object.freeze({
  es: 'español',
  en: 'inglés',
  pt: 'portugués',
  fr: 'francés',
  de: 'alemán',
  it: 'italiano',
  ja: 'japonés',
  ko: 'coreano',
  zh: 'chino',
  ru: 'ruso',
  ar: 'árabe',
  th: 'tailandés',
  hi: 'hindi',
  el: 'griego',
  he: 'hebreo',
});

const DEFAULT_CODE = 'es';

/** @param {string} code @returns {boolean} true si es un código conocido */
function _knownCode(code) {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(LANGUAGE_NAMES, code);
}

/** @param {string} code @returns {string} nombre del idioma (default si se desconoce) */
function _langName(code) {
  if (_knownCode(code)) return /** @type {Record<string, string>} */ (LANGUAGE_NAMES)[code];
  return /** @type {Record<string, string>} */ (LANGUAGE_NAMES)[DEFAULT_CODE];
}

/** @param {unknown} text @returns {string[]} */
function _words(text) {
  return (
    String(text || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .match(/[a-z\u00e0-\u00ff]+/g) || []
  );
}

/**
 * Detecta el idioma del texto del usuario en este turno.
 * @param {unknown} text mensaje del usuario
 * @param {{override?: string|null}} [options] idioma fijado por el usuario (siempre gana)
 * @returns {LanguageDetection}
 */
function detectLanguage(text, options = {}) {
  const override = String(options.override || '')
    .trim()
    .toLowerCase()
    .split('-')[0];
  if (override && _knownCode(override)) {
    return { code: override, name: _langName(override), confidence: 1, source: 'override' };
  }
  const message = String(text || '');
  if (!message.trim()) {
    return {
      code: DEFAULT_CODE,
      name: _langName(DEFAULT_CODE),
      confidence: 0,
      source: 'default',
    };
  }
  for (const script of SCRIPT_RANGES) {
    if (script.re.test(message)) {
      return { code: script.code, name: script.name, confidence: 0.9, source: 'script' };
    }
  }
  const tokens = _words(message);
  if (tokens.length === 0) {
    return {
      code: DEFAULT_CODE,
      name: _langName(DEFAULT_CODE),
      confidence: 0,
      source: 'default',
    };
  }
  let best = null;
  let bestScore = 0;
  let runnerUp = 0;
  for (const [code, stops] of Object.entries(LATIN_STOPWORDS)) {
    const stopSet = new Set(stops.flatMap((word) => _words(word)));
    const hits = tokens.filter((token) => stopSet.has(token)).length;
    const score = hits / Math.max(1, Math.min(tokens.length, 12));
    if (score > bestScore) {
      runnerUp = bestScore;
      bestScore = score;
      best = code;
    } else if (score > runnerUp) {
      runnerUp = score;
    }
  }
  if (best && bestScore > 0 && bestScore - runnerUp >= 0.05) {
    const confidence = Math.min(0.85, 0.45 + bestScore);
    return { code: best, name: _langName(best), confidence, source: 'stopwords' };
  }
  return {
    code: DEFAULT_CODE,
    name: _langName(DEFAULT_CODE),
    confidence: 0.35,
    source: 'default',
  };
}

/**
 * Datos derivados del idioma (locale, voz TTS, modelo ASR). Una sola tabla;
 * el comportamiento nunca se ramifica por idioma fuera de aquí.
 * @param {string} code código ISO detectado
 */
function localeFor(code) {
  const table = {
    es: {
      locale: 'es-MX',
      ttsVoice: 'es-MX-DaliaNeural',
      asrModel: 'vosk-es',
      tldHints: ['mx', 'es'],
    },
    en: { locale: 'en-US', ttsVoice: 'en-US-AriaNeural', asrModel: 'vosk-en', tldHints: ['com'] },
    pt: {
      locale: 'pt-BR',
      ttsVoice: 'pt-BR-FranciscaNeural',
      asrModel: 'vosk-pt',
      tldHints: ['br', 'pt'],
    },
    fr: { locale: 'fr-FR', ttsVoice: 'fr-FR-DeniseNeural', asrModel: 'vosk-fr', tldHints: ['fr'] },
    de: { locale: 'de-DE', ttsVoice: 'de-DE-KatjaNeural', asrModel: 'vosk-de', tldHints: ['de'] },
    it: { locale: 'it-IT', ttsVoice: 'it-IT-ElsaNeural', asrModel: 'vosk-it', tldHints: ['it'] },
    ja: { locale: 'ja-JP', ttsVoice: 'ja-JP-NanamiNeural', asrModel: 'vosk-ja', tldHints: ['jp'] },
    ko: { locale: 'ko-KR', ttsVoice: 'ko-KR-SunHiNeural', asrModel: 'vosk-ko', tldHints: ['kr'] },
    zh: {
      locale: 'zh-CN',
      ttsVoice: 'zh-CN-XiaoxiaoNeural',
      asrModel: 'vosk-zh',
      tldHints: ['cn'],
    },
    ru: {
      locale: 'ru-RU',
      ttsVoice: 'ru-RU-SvetlanaNeural',
      asrModel: 'vosk-ru',
      tldHints: ['ru'],
    },
    ar: { locale: 'ar-SA', ttsVoice: 'ar-SA-ZariyahNeural', asrModel: 'vosk-ar', tldHints: ['sa'] },
    th: {
      locale: 'th-TH',
      ttsVoice: 'th-TH-PremwadeeNeural',
      asrModel: 'vosk-th',
      tldHints: ['th'],
    },
    hi: { locale: 'hi-IN', ttsVoice: 'hi-IN-SwaraNeural', asrModel: 'vosk-hi', tldHints: ['in'] },
    el: { locale: 'el-GR', ttsVoice: 'el-GR-AthinaNeural', asrModel: 'vosk-el', tldHints: ['gr'] },
    he: { locale: 'he-IL', ttsVoice: 'he-IL-HilaNeural', asrModel: 'vosk-he', tldHints: ['il'] },
  };
  /** @type {Record<string, {locale: string, ttsVoice: string, asrModel: string, tldHints: string[]}>} */
  const byCode = table;
  return byCode[code] || byCode[DEFAULT_CODE];
}

/**
 * Línea de idioma para el system prompt: la ÚNICA instrucción de idioma que
 * recibe el modelo. El protocolo de tools no cambia (canónico en inglés).
 * @param {{code?: string, name?: string}|null|undefined} detection
 */
function responseLanguageLine(detection) {
  const code = (detection && detection.code) || DEFAULT_CODE;
  const name = (detection && detection.name) || _langName(DEFAULT_CODE);
  return (
    `# IDIOMA DE RESPUESTA (detectado del usuario: ${name})\n` +
    `Respond to the user in ${name} (${code}). Your free text, explanations and questions ` +
    `go in ${name}. Tool calls and \`\`\`action blocks always stay in the canonical English ` +
    `format — language never changes the tool protocol, only your words.`
  );
}

module.exports = {
  detectLanguage,
  localeFor,
  responseLanguageLine,
  LANGUAGE_NAMES,
  DEFAULT_CODE,
};
