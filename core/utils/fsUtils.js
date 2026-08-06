'use strict';

// Utils compartidos de fs/json usados por todo el pipeline. Centralizan los
// patrones repetidos de leer JSON con fallback, append JSONL y delay.

const fs = require('fs');

/**
 * Lee y parsea un archivo JSON. Nunca lanza: devuelve `fallback` si el
 * archivo no existe, no es parseable o el acceso falla.
 * @param {string} filePath
 * @param {*} fallback
 * @returns {*}
 */
function readJsonFile(filePath, fallback = null) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

/**
 * Append de una línea JSONL (JSON + '\n'). Nunca lanza: un fallo de append se
 * ignora silenciosamente (los logs de auditoría/uso nunca deben romper el
 * flujo principal).
 * @param {string} filePath
 * @param {object} obj
 */
function appendJsonLine(filePath, obj) {
  try {
    fs.appendFileSync(filePath, JSON.stringify(obj) + '\n', 'utf-8');
  } catch (_) {
    /* no rompe el flujo principal */
  }
}

/**
 * Promise que se resuelve tras `ms` milisegundos.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { readJsonFile, appendJsonLine, delay };
