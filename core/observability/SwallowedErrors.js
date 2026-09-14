// @ts-check
'use strict';

/**
 * SwallowedErrors.js — contador de `catch` silenciosos.
 *
 * El codebase tiene ~200 `catch (_) {}` vacíos: correctos como defensa (un
 * fallo en telemetría, un sensor o un fallback no debe tumbar el flujo),
 * pero invisibles en producción. Este módulo los hace visibles SIN cambiar
 * semántica: contar nunca lanza, nunca bloquea, no requiere logger (cero
 * dependencias → cero riesgo de ciclos de require).
 *
 * Uso: `catch (_) { swallow('DesktopControl._listLinuxApps'); }`
 * El scope debe ser una etiqueta estable de archivo y función; nunca texto
 * del usuario, rutas, credenciales ni resultados de herramientas.
 * Lectura: `Core.getStats().swallowedErrors`; contador en memoria por proceso.
 */

/** @type {Record<string, number>} */
let _counts = Object.create(null);
let _total = 0;
const MAX_SCOPES = 500;

/**
 * @param {unknown} scope etiqueta estable del sitio (p.ej. 'BrowserBridge._ensureBrowser')
 */
function swallow(scope) {
  try {
    const key = typeof scope === 'string' && scope ? scope.slice(0, 120) : 'unknown';
    _total += 1;
    if (
      Object.prototype.hasOwnProperty.call(_counts, key) ||
      Object.keys(_counts).length < MAX_SCOPES
    ) {
      _counts[key] = (_counts[key] || 0) + 1;
    } else {
      _counts.__overflow = (_counts.__overflow || 0) + 1;
    }
  } catch (_) {
    // Contar nunca puede romper al llamador. Literalmente nunca.
  }
}

function getStats() {
  const byScope = Object.entries(_counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 50);
  return { total: _total, scopes: Object.keys(_counts).length, byScope };
}

function reset() {
  _counts = Object.create(null);
  _total = 0;
}

module.exports = { swallow, getStats, reset };
