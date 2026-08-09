'use strict';

/**
 * agentStates.js — taxonomía compartida de estados del agente.
 *
 * Un solo lugar de verdad para los 6 estados que puede mostrar la UI y que
 * reacciona el avatar (Cambio 1 del rediseño "Claude Code + AI Agent +
 * VTuber"). Sin dependencias — se puede requerir tanto desde core/ (Node)
 * como desde src/chat/*.js (renderer), evita duplicar los mismos strings
 * sueltos en cada archivo.
 */

const AGENT_STATES = Object.freeze({
  IDLE: 'idle',
  THINKING: 'thinking',
  WORKING: 'working',
  STREAMING: 'streaming',
  DONE: 'done',
  ERROR: 'error',
});

// Mood de GestureEngine que le corresponde a cada estado. Los nombres deben
// existir en GestureLexicon.MOODS — 'default' es el mood neutral ya usado
// como fallback en el resto del proyecto.
/** @type {Record<string, string>} */
const STATE_TO_MOOD = Object.freeze({
  [AGENT_STATES.IDLE]: 'default',
  [AGENT_STATES.THINKING]: 'think',
  [AGENT_STATES.WORKING]: 'think',
  [AGENT_STATES.STREAMING]: 'gentle',
  [AGENT_STATES.DONE]: 'happy',
  [AGENT_STATES.ERROR]: 'sad',
});

/**
 * Deriva el estado de un evento agent-progress (ver AgentLoop.js).
 * phase: 'start' (la tool arrancó) | 'end' (la tool terminó, con status).
 * @param {{phase?: string, status?: string}} progress
 * @returns {string} uno de AGENT_STATES
 */
function stateFromProgress(progress = {}) {
  if (progress.phase === 'start') return AGENT_STATES.WORKING;
  if (progress.phase === 'end') {
    return progress.status === 'ok' ? AGENT_STATES.WORKING : AGENT_STATES.ERROR;
  }
  // Compatibilidad con el payload viejo (sin phase, solo status post-hoc).
  if (progress.status === 'ok') return AGENT_STATES.WORKING;
  if (progress.status === 'error') return AGENT_STATES.ERROR;
  return AGENT_STATES.WORKING;
}

/**
 * Mood de GestureEngine para un estado del agente (default si desconocido).
 * @param {string} state - uno de AGENT_STATES
 * @returns {string}
 */
function moodForState(state) {
  return STATE_TO_MOOD[state] || STATE_TO_MOOD[AGENT_STATES.IDLE];
}

module.exports = { AGENT_STATES, STATE_TO_MOOD, stateFromProgress, moodForState };
