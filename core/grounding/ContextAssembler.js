/**
 * ContextAssembler.js — Fase 3 (actualizado)
 *
 * CAMBIOS respecto a Fase 2:
 *   - build() acepta toolIntent en el destructuring
 *   - Lo pasa al contextPackage para que el GroqSerializer lo inyecte
 *   - Todo lo demás igual
 */

const fs   = require('fs');
const path = require('path');

const { GroqSerializer }                     = require('./serializers/GroqSerializer.js');
const { GeminiSerializer, OpenAISerializer } = require('./serializers/GeminiOpenAISerializer.js');

const SERIALIZERS = {
  groq:   new GroqSerializer(),
  gemini: new GeminiSerializer(),
  openai: new OpenAISerializer(),
};

const IDENTITY_PATH = path.join(__dirname, '../identity/identity.json');
let _identity = null;

function getIdentity() {
  if (_identity) return _identity;
  try {
    _identity = JSON.parse(fs.readFileSync(IDENTITY_PATH, 'utf-8'));
  } catch(e) {
    console.warn('[context-assembler] no se pudo cargar identity.json:', e.message);
    _identity = { name: 'March 7th', core: 'Soy March 7th.' };
  }
  return _identity;
}

function buildOSContext(osSensor) {
  if (!osSensor) return _buildMinimalOSContext();

  const ctx = osSensor.getCurrentContext();

  const now  = new Date();
  const hour = now.getHours();
  let timeOfDay;
  if      (hour >= 5  && hour < 12) timeOfDay = 'mañana';
  else if (hour >= 12 && hour < 18) timeOfDay = 'tarde';
  else if (hour >= 18 && hour < 22) timeOfDay = 'noche';
  else                               timeOfDay = 'madrugada';

  const days    = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
  const timeStr = now.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  const dayName = days[now.getDay()];

  return {
    time:               timeStr,
    date:               now.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' }),
    timeOfDay,
    dayName,
    timeFormatted:      `Son las ${timeStr} del ${dayName} por la ${timeOfDay}.`,
    platform:           process.platform,
    app:                ctx.app              ?? null,
    friendlyName:       ctx.friendlyName     ?? null,
    title:              ctx.title            ?? null,
    category:           ctx.category         ?? null,
    elapsed:            ctx.elapsed          ?? 0,
    elapsedFormatted:   ctx.elapsedFormatted ?? '0s',
    idleSecs:           ctx.idleSecs         ?? null,
    idleFormatted:      ctx.idleFormatted    ?? null,
    openWindowsSummary: ctx.openWindowsSummary ?? null,
    todaySummary:       osSensor.getTodaySummary() ?? null,
  };
}

function _buildMinimalOSContext() {
  const now  = new Date();
  const hour = now.getHours();
  let timeOfDay;
  if      (hour >= 5  && hour < 12) timeOfDay = 'mañana';
  else if (hour >= 12 && hour < 18) timeOfDay = 'tarde';
  else if (hour >= 18 && hour < 22) timeOfDay = 'noche';
  else                               timeOfDay = 'madrugada';

  const days    = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
  const timeStr = now.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  const dayName = days[now.getDay()];

  return {
    time:               timeStr,
    date:               now.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' }),
    timeOfDay,
    dayName,
    timeFormatted:      `Son las ${timeStr} del ${dayName} por la ${timeOfDay}.`,
    platform:           process.platform,
    app:                null,
    friendlyName:       null,
    title:              null,
    category:           null,
    elapsed:            0,
    elapsedFormatted:   '0s',
    idleSecs:           null,
    idleFormatted:      null,
    openWindowsSummary: null,
    todaySummary:       null,
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
  build({ sessionHistory = [], retrievalResult = null, activeProvider = 'groq', toolIntent = null }) {
    const identity = getIdentity();
    const osCtx    = buildOSContext(this._osSensor);

    const history    = sessionHistory.slice(0, -1);
    const currentMsg = sessionHistory.length > 0
      ? sessionHistory[sessionHistory.length - 1]
      : null;

    const contextPackage = {
      identity,
      osContext: osCtx,
      persistentMemory: retrievalResult
        ? { nodes: retrievalResult.nodes, episodes: retrievalResult.episodeNodes }
        : { nodes: [], episodes: [] },
      sessionHistory: history,
      currentMessage: currentMsg,
      toolIntent,   // ← Fase 3: el GroqSerializer lo lee e inyecta en el system prompt
    };

    const serializer      = SERIALIZERS[activeProvider] ?? SERIALIZERS.groq;
    const result          = serializer.serialize(contextPackage);
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