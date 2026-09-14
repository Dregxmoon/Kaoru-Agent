// @ts-check
'use strict';

/**
 * DetectionTelemetry.js — ¿por QUÉ vía se detectó cada intención?
 *
 * Vías posibles (en orden de intento en core/core/context.js):
 *   regex      → TaskDetector (rápido, español-primero)
 *   fusion     → fuseTaskIntent: IntentDetector semántico rescató al regex
 *   classifier → IntentClassifier por embeddings (multilingüe)
 *   arbitrator → IntentArbitrator LLM (zona gris, opt-in)
 *   none       → ninguna vía vio tarea (charla)
 *
 * Sesión en memoria (ring buffer, sin disco): responde "¿qué tan multilingüe
 * es Kaoru DE VERDAD?" sin migrar la DB. Los conteos persistentes por día
 * viven en TelemetryStore.recordDetectionPath().
 */

const PATHS = Object.freeze(['regex', 'fusion', 'classifier', 'arbitrator', 'none']);
const MAX_RECENT = 200;

/** @type {Array<{path: string, domain: string|null, confidence: unknown, lang: string|null, ts: number}>} */
let _recent = [];
/** @type {Record<string, number>} */
let _counts = { regex: 0, fusion: 0, classifier: 0, arbitrator: 0, none: 0 };

/** @param {unknown} path @returns {boolean} */
function isKnownPath(path) {
  return typeof path === 'string' && PATHS.includes(path);
}

/**
 * @typedef {object} DetectionEvent
 * @property {unknown} [path]
 * @property {unknown} [domain]
 * @property {unknown} [confidence]
 * @property {unknown} [lang]
 */

/**
 * @param {DetectionEvent} [event]
 */
function recordDetection(event = {}) {
  const evt = event || {};
  const path = isKnownPath(evt.path) ? /** @type {string} */ (evt.path) : 'none';
  const domain =
    evt.domain &&
    typeof evt.domain === 'object' &&
    typeof (/** @type {{id?: unknown}} */ (evt.domain).id) === 'string'
      ? /** @type {string} */ (/** @type {{id?: unknown}} */ (evt.domain).id)
      : typeof evt.domain === 'string'
        ? evt.domain
        : null;
  _counts[path] += 1;
  _recent.push({
    path,
    domain,
    confidence: evt.confidence ?? null,
    lang: typeof evt.lang === 'string' ? evt.lang : null,
    ts: Date.now(),
  });
  if (_recent.length > MAX_RECENT) _recent.splice(0, _recent.length - MAX_RECENT);
}

function getStats() {
  /** @type {Record<string, number>} */
  const byPathDomain = {};
  for (const record of _recent) {
    const key = `${record.path}|${record.domain || '-'}`;
    byPathDomain[key] = (byPathDomain[key] || 0) + 1;
  }
  return {
    total: Object.values(_counts).reduce((sum, count) => sum + count, 0),
    retained: _recent.length,
    byPath: { ..._counts },
    byPathDomain,
    recent: _recent.slice(-20),
  };
}

function reset() {
  _recent = [];
  _counts = { regex: 0, fusion: 0, classifier: 0, arbitrator: 0, none: 0 };
}

module.exports = {
  PATHS,
  isKnownPath,
  recordDetection,
  getStats,
  reset,
};
