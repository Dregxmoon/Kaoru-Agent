/**
 * GroundingEngine.js — Fase 3 (actualizado)
 *
 * CAMBIOS respecto a Fase 2:
 *   - buildContext() acepta toolIntent como tercer parámetro
 *   - Lo pasa al ContextAssembler para que el GroqSerializer lo inyecte
 */

const fs   = require('fs');
const path = require('path');

const { RetrievalPlanner } = require('./RetrievalPlanner.js');
const { ContextAssembler } = require('./ContextAssembler.js');

class GroundingEngine {
  constructor(stateGraph) {
    this._graph     = stateGraph;
    this._planner   = new RetrievalPlanner(stateGraph);
    this._assembler = new ContextAssembler();
    this._osSensor  = null;
  }

  setOSSensor(osSensor) {
    this._osSensor = osSensor;
    this._assembler.setOSSensor(osSensor);
    console.log('[grounding] OSSensor conectado');
  }

  /**
   * @param {Array}  sessionHistory
   * @param {string} activeProvider
   * @param {object} toolIntent      — resultado de IntentDetector (Fase 3, opcional)
   */
  async buildContext(sessionHistory = [], activeProvider = 'groq', toolIntent = null) {
    try {
      const currentMsg = sessionHistory[sessionHistory.length - 1];
      const userText   = currentMsg?.role === 'user' ? currentMsg.content : '';
      const osCtx      = this._osSensor?.getCurrentContext() ?? null;

      const retrievalResult = await this._planner.plan(userText, osCtx);

      const result = this._assembler.build({
        sessionHistory,
        retrievalResult,
        activeProvider,
        toolIntent,
      });

      return result;

    } catch(e) {
      console.error('[grounding] error en pipeline, usando fallback:', e.message);
      return this._fallback(sessionHistory);
    }
  }

  _fallback(sessionHistory) {
    try {
      const Fallback = require('../llm/GroundingMinimo.js');
      return Fallback.buildContext(sessionHistory);
    } catch(e2) {
      console.error('[grounding] fallback también falló:', e2.message);
      return {
        systemPrompt: 'Eres March 7th. Responde con tu personalidad habitual.',
        messages: sessionHistory.slice(-1),
      };
    }
  }

  getOSSensor() { return this._osSensor; }

  getOSContext() {
    if (this._osSensor) return this._osSensor.getCurrentContext();
    const now  = new Date();
    const hour = now.getHours();
    let timeOfDay = hour >= 5 && hour < 12 ? 'mañana' : hour < 18 ? 'tarde' : hour < 22 ? 'noche' : 'madrugada';
    const days = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
    return {
      time: now.toLocaleTimeString('es-MX', { hour:'2-digit', minute:'2-digit' }),
      timeOfDay,
      dayName: days[now.getDay()],
      timeFormatted: `Son las ${now.toLocaleTimeString('es-MX', { hour:'2-digit', minute:'2-digit' })} del ${days[now.getDay()]} por la ${timeOfDay}.`,
      app: null, friendlyName: null, category: null, elapsed: 0,
    };
  }
}

let _contextEngine = null;

function getOSContextPublic() {
  if (!_contextEngine) _contextEngine = new GroundingEngine(null);
  return _contextEngine.getOSContext();
}

function getIdentity() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '../identity/identity.json'), 'utf-8'));
  } catch(e) {
    return { name: 'March 7th', core: 'Soy March 7th.' };
  }
}

module.exports = { GroundingEngine, getOSContext: getOSContextPublic, getIdentity };
