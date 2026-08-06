/**
 * ContextAssembler.js — Fase 3 (actualizado)
 *
 * CAMBIOS respecto a Fase 2:
 *   - build() acepta toolIntent en el destructuring
 *   - Lo pasa al contextPackage para que el GroqSerializer lo inyecte
 *   - Todo lo demás igual
 */

const { GroqSerializer } = require('./serializers/GroqSerializer.js');
const { GeminiSerializer, OpenAISerializer } = require('./serializers/GeminiOpenAISerializer.js');
const { getIdentity: getIdentityStore } = require('../identity/IdentityStore.js');

const SERIALIZERS = {
  groq: new GroqSerializer(),
  gemini: new GeminiSerializer(),
  openai: new OpenAISerializer(),
};

// ── Sanitización de privacidad ─────────────────────────────────────────────
// Limpia URLs, identificadores de perfil, paths del sistema de los nombres
// de aplicaciones que se envían al LLM. Sin esto, cada conversación filtra
// qué sitios web visita el usuario, qué archivos tiene abiertos, etc.
const URL_REGEX = /(?:https?:\/\/)?[\w-]+\.\w+(?:\/[^\s)]*)?/gi;
// Patrones de Chrome/Chromium: "chrome-nombredecosa-Default" → "Chrome"
const CHROME_PROFILE_REGEX = /^chrome-[^-]+/i;
const PROFILE_DIR_REGEX = /\s*\(.*(?:Default|Profile\s*\d+|Guest)\).*$/gi;

function _sanitizeAppName(raw) {
  if (!raw || typeof raw !== 'string') return raw;
  let s = raw;
  // Reemplazar URLs con "[URL]"
  s = s.replace(URL_REGEX, '[URL]');
  // Limpiar "chrome-nombredominado-Default" → "Chrome"
  s = s.replace(CHROME_PROFILE_REGEX, 'Chrome');
  // Limpiar "(Default)", "(Profile 1)" etc
  s = s.replace(PROFILE_DIR_REGEX, '');
  // Eliminar paths del sistema que puedan filtrar estructura de directorios
  s = s.replace(/(?:\/[a-zA-Z0-9_.-]+)+/g, '/…');
  // Limpiar espacios múltiples
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s || raw;
}

function _sanitizeOSContext(ctx) {
  if (!ctx) return ctx;
  return {
    ...ctx,
    friendlyName: _sanitizeAppName(ctx.friendlyName),
    title: _sanitizeAppName(ctx.title),
    openWindowsSummary: ctx.openWindowsSummary
      ? ctx.openWindowsSummary
          .split(', ')
          .map((w) => _sanitizeAppName(w))
          .join(', ')
      : null,
    todaySummary: ctx.todaySummary
      ? ctx.todaySummary
          .split(', ')
          .map((w) => _sanitizeAppName(w))
          .join(', ')
      : null,
  };
}

function buildOSContext(osSensor) {
  if (!osSensor) return _buildMinimalOSContext();

  const ctx = osSensor.getCurrentContext();
  if (!ctx) return _buildMinimalOSContext();

  const now = new Date();
  const hour = now.getHours();
  let timeOfDay;
  if (hour >= 5 && hour < 12) timeOfDay = 'mañana';
  else if (hour >= 12 && hour < 18) timeOfDay = 'tarde';
  else if (hour >= 18 && hour < 22) timeOfDay = 'noche';
  else timeOfDay = 'madrugada';

  const days = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const timeStr = now.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  const dayName = days[now.getDay()];

  const raw = {
    time: timeStr,
    date: now.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' }),
    timeOfDay,
    dayName,
    timeFormatted: `Son las ${timeStr} del ${dayName} por la ${timeOfDay}.`,
    platform: process.platform,
    app: ctx.app ?? null,
    friendlyName: ctx.friendlyName ?? null,
    title: ctx.title ?? null,
    category: ctx.category ?? null,
    elapsed: ctx.elapsed ?? 0,
    elapsedFormatted: ctx.elapsedFormatted ?? '0s',
    idleSecs: ctx.idleSecs ?? null,
    idleFormatted: ctx.idleFormatted ?? null,
    openWindowsSummary: ctx.openWindowsSummary ?? null,
    todaySummary: osSensor.getTodaySummary() ?? null,
  };
  return _sanitizeOSContext(raw);
}

function _buildMinimalOSContext() {
  const now = new Date();
  const hour = now.getHours();
  let timeOfDay;
  if (hour >= 5 && hour < 12) timeOfDay = 'mañana';
  else if (hour >= 12 && hour < 18) timeOfDay = 'tarde';
  else if (hour >= 18 && hour < 22) timeOfDay = 'noche';
  else timeOfDay = 'madrugada';

  const days = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const timeStr = now.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  const dayName = days[now.getDay()];

  return {
    time: timeStr,
    date: now.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' }),
    timeOfDay,
    dayName,
    timeFormatted: `Son las ${timeStr} del ${dayName} por la ${timeOfDay}.`,
    platform: process.platform,
    app: null,
    friendlyName: null,
    title: null,
    category: null,
    elapsed: 0,
    elapsedFormatted: '0s',
    idleSecs: null,
    idleFormatted: null,
    openWindowsSummary: null,
    todaySummary: null,
  };
}

class ContextAssembler {
  constructor() {
    this._osSensor = null;
  }

  setOSSensor(osSensor) {
    this._osSensor = osSensor;
  }

  /**
   * @param {object} opts
   * @param {Array}  opts.sessionHistory
   * @param {object} opts.retrievalResult
   * @param {string} opts.activeProvider
   * @param {object} opts.toolIntent       — resultado de IntentDetector (Fase 3)
   */
  build({
    sessionHistory = [],
    retrievalResult = null,
    activeProvider = 'groq',
    toolIntent = null,
  }) {
    const identity = getIdentityStore();
    const osCtx = buildOSContext(this._osSensor);

    const history = sessionHistory.slice(0, -1);
    const currentMsg = sessionHistory.length > 0 ? sessionHistory[sessionHistory.length - 1] : null;

    const contextPackage = {
      identity,
      osContext: osCtx,
      persistentMemory: retrievalResult
        ? { nodes: retrievalResult.nodes, episodes: retrievalResult.episodeNodes }
        : { nodes: [], episodes: [] },
      sessionHistory: history,
      currentMessage: currentMsg,
      toolIntent, // ← Fase 3: el GroqSerializer lo lee e inyecta en el system prompt
    };

    const serializer = SERIALIZERS[activeProvider] ?? SERIALIZERS.groq;
    const result = serializer.serialize(contextPackage);
    const estimatedTokens = Math.round(result.systemPrompt.length / 4);

    console.log(
      `[context-assembler] provider=${activeProvider}` +
        ` tokens≈${estimatedTokens}` +
        ` nodes=${retrievalResult?.nodes?.length ?? 0}` +
        ` episodes=${retrievalResult?.episodeNodes?.length ?? 0}` +
        ` app=${osCtx.friendlyName ?? 'none'}` +
        ` toolIntent=${toolIntent?.action ?? 'none'}`
    );

    return result;
  }
}

module.exports = { ContextAssembler, buildOSContext };
