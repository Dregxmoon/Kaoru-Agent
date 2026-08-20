// @ts-check
'use strict';

/**
 * PathGuard — contención de rutas contra un "allowed path" (workspace/root).
 *
 * Lógica de seguridad compartida entre `openclaw-server.js` (ALLOWED_PATH) y
 * `core/commands/FileResolver.js` (workspace activo). Un solo lugar para evitar
 * el patrón de dos implementaciones divergentes (ver bug del "||" en
 * StructuredActionParser como precedente).
 *
 * - `_realpathNearest`: resuelve symlinks del ancestro existente más cercano,
 *   cerrando la vía de escape por symlink.
 * - `IMMUTABLE_PATH_PATTERNS` + `isImmutablePath`: rutas de sistema/sensibles
 *   (credenciales, /etc, /proc, ...) que nunca se deben leer/escribir.
 */

const path = require('path');
const fs = require('fs');

const IMMUTABLE_PATH_PATTERNS = [
  /[\\/]\.ssh[\\/]/i,
  /[\\/]id_rsa$/i,
  /[\\/]id_ed25519$/i,
  /\.pem$/i,
  /\.pfx$/i,
  /\.key$/i,
  /[\\/]\.aws[\\/]/i,
  // .env y variantes de entorno con credenciales reales (.env.local,
  // .env.production, .env.test, ...). Se EXCLUYEN los sufijos de plantilla
  // (.env.example/.env.sample/.env.template/.env.dist): son archivos legítimos
  // que el agente debe poder crear/editar sin fricción.
  /\.env(?:$|\.(?!example$|sample$|template$|dist$))/i,
  /[\\/]credentials/i,
  /[\\/]\.git-credentials/i,
  /[\\/]\.npmrc/i,
  /[\\/]wallet/i,
  /[\\/]\.pgpass/i,
  /^\/etc\/(shadow|passwd|sudoers|gshadow|fstab|crontab|hosts|hostname)$/,
  /^\/boot\//,
  /^\/sys\//,
  /^\/proc\//,
  /^\/dev\//,
];

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function isImmutablePath(filePath) {
  return IMMUTABLE_PATH_PATTERNS.some((re) => re.test(String(filePath || '')));
}

// Realpath del ancestro existente más cercano a `p` (para rutas de archivos
// que aún no existen, p.ej. al escribir uno nuevo), manteniendo el resto del
// path como sufijo literal. Cierra la vía de escape por symlink: si un
// directorio intermedio es un symlink hacia fuera de allowedPath, el realpath
// lo resuelve y isOutsideAllowed lo detecta.
/**
 * @param {string} p
 * @returns {string}
 */
function realpathNearest(p) {
  let cur = p;
  const tail = [];
  for (;;) {
    try {
      const base = fs.realpathSync(cur);
      return tail.length ? path.resolve(base, ...tail) : base;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

// Devuelve true si `filePath` está fuera de `allowedPath` (o es una ruta
// inmutable). Maneja escapes por `..` y por symlink.
/**
 * @param {string} filePath
 * @param {string} allowedPath
 * @returns {boolean}
 */
function isOutsideAllowed(filePath, allowedPath) {
  try {
    const resolved = path.resolve(String(filePath || ''));
    if (isImmutablePath(resolved)) return true;
    const realResolved = realpathNearest(resolved);
    if (isImmutablePath(realResolved)) return true;
    const realAllowed = realpathNearest(path.resolve(String(allowedPath || '')));
    const rel = path.relative(realAllowed, realResolved);
    return rel.startsWith('..') || path.isAbsolute(rel);
  } catch {
    return true;
  }
}

// Verifica que `candidate` (cwd o root solicitado) esté dentro de
// `allowedPath`. No necesita realpath: un cwd legítimo siempre es absoluto.
/**
 * @param {string} candidate
 * @param {string} allowedPath
 * @returns {boolean}
 */
function isCwdAllowed(candidate, allowedPath) {
  try {
    const resolved = path.resolve(String(candidate || ''));
    const realAllowed = realpathNearest(path.resolve(String(allowedPath || '')));
    const rel = path.relative(realAllowed, resolved);
    return !(rel.startsWith('..') || path.isAbsolute(rel));
  } catch {
    return false;
  }
}

module.exports = {
  IMMUTABLE_PATH_PATTERNS,
  isImmutablePath,
  realpathNearest,
  isOutsideAllowed,
  isCwdAllowed,
};
