// @ts-check
'use strict';

/**
 * childEnv.js — política ÚNICA de entorno para procesos hijos.
 *
 * Unifica el criterio de "qué variables de entorno puede ver un proceso hijo",
 * que antes vivía duplicado con drift:
 *   - openclaw-server.js (su `_safeChildEnv` local para exec/code_execution).
 *   - MCPManager.js (pasaba `process.env` COMPLETO a servidores MCP — C1).
 *
 * Dos niveles según la confianza del hijo:
 *   - `safeChildEnv(extra)`  → estándar. Conserva un whitelist de vars útiles
 *     (PATH, HOME, locales...) + el resto de process.env EXCEPTO variables
 *     cuyo nombre delate credenciales (KEY/TOKEN/SECRET/PASSWORD/AUTH...).
 *     Es lo que usan exec, code_execution y los plugins para sus hijos.
 *   - `minimalChildEnv(extra)` → estricto para terceros. Solo PATH y HOME +
 *     lo que el llamador declare explícitamente. NUNCA arrastra process.env.
 *     Es lo que usan los servidores MCP (código de terceros no confiable).
 */

const STRIPPED_ENV_KEY_RE =
  /(^|_)(KEY|TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PAT|CREDENTIALS?|AUTH)(\b|_|$)/i;

const KEEP_ENV_KEYS = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TERM',
  'SHELL',
  'USER',
  'LOGNAME',
  'HOSTNAME',
  'DISPLAY',
  'XDG_RUNTIME_DIR',
  'GPG_TTY',
  'EDITOR',
  'VISUAL',
];

/**
 * Env estándar para procesos hijos semiconfiables (exec, code_execution,
 * plugins). Conserva las herramientas habituales (PATH, HOME, locales) y el
 * resto de process.env, pero elimina cualquier variable con nombre de
 * credencial para que un comando aprobado no pueda exfiltrarlas.
 *
 * @param {Record<string, string | undefined>} [extra] vars garantizadas por
 *   el llamador (ganan sobre process.env).
 * @returns {Record<string, string>}
 */
function safeChildEnv(extra = {}) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const key of KEEP_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = /** @type {string} */ (process.env[key]);
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (env[key] !== undefined) continue;
    if (STRIPPED_ENV_KEY_RE.test(key)) continue;
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * Env mínimo para terceros no confiables (servidores MCP): SOLO PATH y HOME,
 * más lo que el llamador declare explícitamente en `extra`. Nunca hereda
 * variables del proceso — un MCP no ve GITHUB_TOKEN, OPENAI_API_KEY, etc.
 *
 * @param {Record<string, string | undefined>} [extra]
 * @returns {Record<string, string>}
 */
function minimalChildEnv(extra = {}) {
  /** @type {Record<string, string>} */
  const env = {};
  if (process.env.PATH !== undefined) env.PATH = /** @type {string} */ (process.env.PATH);
  if (process.env.HOME !== undefined) env.HOME = /** @type {string} */ (process.env.HOME);
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

module.exports = { safeChildEnv, minimalChildEnv, STRIPPED_ENV_KEY_RE, KEEP_ENV_KEYS };
