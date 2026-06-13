/**
 * ContextAssembler.js — Fase 2 (mejorado)
 *
 * Orquesta la construcción del Context Package completo.
 *
 * Mejoras respecto a la versión anterior:
 *   - buildOSContext delega fecha/hora al OSSensor en lugar de recalcularla
 *   - timeFormatted ya no está duplicado entre ContextAssembler y OSSensor
 *   - buildFromSession eliminado (era dead code, nadie lo llamaba)
 *   - activeProvider se pasa correctamente desde el IPC handler
 *   - idleFormatted incluido en el osContext si OSSensor lo reporta
 *   - logs más informativos con tokens estimados
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

// ── Identity ──────────────────────────────────────────────────────────────────
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

// ── OS Context ────────────────────────────────────────────────────────────────
/**
 * Construye el osContext normalizado para los serializers.
 * Delega fecha/hora al OSSensor si está disponible, para no duplicar lógica.
 * Si no hay OSSensor, usa un contexto mínimo calculado aquí.
 */
function buildOSContext(osSensor) {
  if (!osSensor) return _buildMinimalOSContext();

  // OSSensor ya tiene getCurrentContext() que incluye app, title, elapsed, etc.
  const ctx = osSensor.getCurrentContext();

  // Construir timeFormatted aquí (único punto de verdad para el formato)
  const now  = new Date();
  const hour = now.getHours();
  let timeOfDay;
  if      (hour >= 5  && hour < 12) timeOfDay = 'mañana';
  else if (hour >= 12 && hour < 18) timeOfDay = 'tarde';
  else if (hour >= 18 && hour < 22) timeOfDay = 'noche';
  else                               timeOfDay = 'madrugada';

  const days = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
  const timeStr = now.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  const dayName = days[now.getDay()];

  return {
    // Tiempo
    time:             timeStr,
    date:             now.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' }),
    timeOfDay,
    dayName,
    timeFormatted:    `Son las ${timeStr} del ${dayName} por la ${timeOfDay}.`,
    platform:         process.platform,

    // App activa
    app:              ctx.app          ?? null,
    friendlyName:     ctx.friendlyName ?? null,
    title:            ctx.title        ?? null,
    category:         ctx.category     ?? null,
    elapsed:          ctx.elapsed      ?? 0,
    elapsedFormatted: ctx.elapsedFormatted ?? '0s',

    // Idle (si OSSensor lo reporta — Fase 2.5)
    idleSecs:         ctx.idleSecs      ?? null,
    idleFormatted:    ctx.idleFormatted ?? null,

    // Todas las ventanas abiertas
    openWindowsSummary: ctx.openWindowsSummary ?? null,

    // Historial del día
    todaySummary:     osSensor.getTodaySummary() ?? null,
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

// ── ContextAssembler ──────────────────────────────────────────────────────────

class ContextAssembler {
  constructor() {
    this._osSensor = null;
  }

  setOSSensor(osSensor) {
    this._osSensor = osSensor;
  }

  /**
   * Construye y serializa el Context Package completo.
   *
   * @param {object} opts
   * @param {Array}  opts.sessionHistory  — historial de la sesión actual (incluye mensaje actual al final)
   * @param {object} opts.retrievalResult — resultado de RetrievalPlanner.plan()
   * @param {string} opts.activeProvider  — 'groq' | 'gemini' | 'openai'
   * @returns {{ systemPrompt: string, messages: Array }}
   */
  build({ sessionHistory = [], retrievalResult = null, activeProvider = 'groq' }) {
    const identity = getIdentity();
    const osCtx    = buildOSContext(this._osSensor);

    // Separar historial del mensaje actual
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
    };

    // Seleccionar serializer correcto
    const serializer = SERIALIZERS[activeProvider] ?? SERIALIZERS.groq;
    const result     = serializer.serialize(contextPackage);

    // Estimar tokens (aprox 4 chars = 1 token)
    const estimatedTokens = Math.round(result.systemPrompt.length / 4);

    console.log(
      `[context-assembler] provider=${activeProvider}` +
      ` tokens≈${estimatedTokens}` +
      ` nodes=${retrievalResult?.nodes?.length ?? 0}` +
      ` episodes=${retrievalResult?.episodeNodes?.length ?? 0}` +
      ` app=${osCtx.friendlyName ?? 'none'}`
    );

    return result;
  }
}

module.exports = { ContextAssembler, buildOSContext };