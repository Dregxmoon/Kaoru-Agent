/**
 * InitiativeEngine.js — DEPRECADO (absorbido por ProactiveEngine.js v2)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Este engine YA NO dispara iniciativas propias. Todo lo que hacía —
 * escuchar 'os:app-tick', detectar categoría + tiempo en app, decidir si
 * vale la pena interrumpir — ahora vive en ProactiveEngine.js, con dos
 * diferencias importantes:
 *
 *   1. El mensaje ya NO sale de un array fijo de frases random
 *      ("Llevas rato en VSCode. ¿Cómo va el código?"). Ahora lo genera el
 *      LLM con memoria real, contexto del OS y criterio propio — puede
 *      decidir que no hay nada genuino que decir.
 *
 *   2. Ya no existe el "árbitro global" entre dos engines separados
 *      (_lastAnyInitiative / FIX #3 de la versión anterior). Con un solo
 *      engine emitiendo 'initiative:trigger', los cooldowns viven en un
 *      solo lugar y no hace falta coordinar dos relojes distintos.
 *
 * Este archivo se deja como un shim vacío — SOLO por compatibilidad, para
 * que MarchCore.js (que todavía lo instancia y llama setOSSensor /
 * setChatOpen / getStats) no necesite cambios. Si en MarchCore.js quieres
 * quitarlo del todo más adelante, es seguro borrar las líneas que lo
 * importan e instancian — no queda nada colgando de este archivo.
 * ─────────────────────────────────────────────────────────────────────────────
 */

class InitiativeEngine {
  constructor(_stateGraph) {
  }

  // No-ops mantenidos solo por compatibilidad con MarchCore.js
  setOSSensor(_osSensor) {}
  setChatOpen(_open) {}

  /** Forzar una iniciativa manualmente — se mantiene por si algún flujo de testing viejo lo llama. */
  forceInitiative(suggestion, actionType = 'manual') {
    const { getEventBus } = require('../../infrastructure/event-bus/EventBus.js');
    getEventBus().emit('initiative:trigger', {
      reason:     'manual',
      app:        'manual',
      suggestion,
      actionType,
      canHelp:    false,
      utility:    1.0,
    });
  }

  getStats() {
    return {
      deprecated: true,
      note: 'InitiativeEngine fue absorbido por ProactiveEngine.js v2 — revisa MarchCore.getStats().proactive para las stats reales de proactividad.',
    };
  }
}

module.exports = { InitiativeEngine };
