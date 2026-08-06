'use strict';

// Formateo de duraciones en texto humano, compartido por los serializers de
// uso (AppHistoryStore, OSSensor). Centraliza el patrón "Xs · Xm · Xh Ym".

/**
 * Formatea una duración en segundos como texto corto (60s → "1m").
 * @param {number} seconds
 * @returns {string}
 */
function formatElapsed(seconds) {
  if (!seconds || seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `${hrs}h ${rem}m` : `${hrs}h`;
}

module.exports = { formatElapsed };
