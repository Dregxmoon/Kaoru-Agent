/**
 * ignoreDirs.js — lista única de carpetas de proyecto a ignorar.
 *
 * node_modules, dist, build, cachés… se excluyen en varios sitios con
 * copias separadas (GitManager al stagear, LSPErrorWatcher al indexar,
 * openclaw-server al recoger archivos). Esta módulo centraliza la lista
 * y ofrece dos presentaciones:
 *
 *   - dirSet(extras): Set de nombres de carpeta (match exacto por nombre).
 *   - dirRegexes(extras): regex de segmento de path (match en rutas completas).
 *
 * Cada consumidor pasa como extras solo lo que le es propio; así se unifica
 * la lista sin cambiar el comportamiento de ninguno.
 */

'use strict';

// Carpetas de dependencias/builds/cachés ignoradas en TODOS los contextos.
const PROJECT_IGNORE_DIRS = [
  'node_modules',
  'dist',
  'build',
  '.next',
  '.cache',
  '__pycache__',
];

/**
 * Set de nombres de carpeta ignorados (match exacto por entrada).
 * @param {string[]} [extras] - Carpetas adicionales específicas del consumidor.
 * @returns {Set<string>}
 */
function dirSet(extras = []) {
  return new Set([...PROJECT_IGNORE_DIRS, ...extras]);
}

/**
 * Regex de segmento de path para cada carpeta ignorada (match en rutas
 * completas, soporta separador Windows y POSIX).
 * @param {string[]} [extras] - Carpetas adicionales específicas del consumidor.
 * @returns {Array<RegExp>}
 */
function dirRegexes(extras = []) {
  return [...PROJECT_IGNORE_DIRS, ...extras].map(
    (name) => new RegExp(`(^|[\\\\/])${name}[\\\\/]`)
  );
}

module.exports = { PROJECT_IGNORE_DIRS, dirSet, dirRegexes };
