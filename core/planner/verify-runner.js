// @ts-check
'use strict';

/**
 * verify-runner.js — ejecución del plan de verificación forzada del AgentLoop.
 *
 * Corre el comando de verificación por el MISMO camino que cualquier tool exec
 * (`bridge.execute('exec', { command, timeout })`), heredando el sandbox bwrap,
 * `_safeChildEnv` y el cap de MAX_EXEC_TIMEOUT del server. NO crea spawn propio.
 *
 * Política:
 *   - Solo en modo smart, solo si hubo mutaciones exitosas.
 *   - Fallos deterministas (exitCode ≠ 0) NO se reintentan; solo se reintenta
 *     un fallo transitorio (timeout del server / red caída).
 *   - Si no hay comando configurado pero se editaron archivos JS, se cierra con
 *     un sellado determinista mínimo (`node --check <archivos>`) en lugar de
 *     omitir la verificación silenciosamente.
 */

const path = require('path');

// segundos: cap del server (MAX_EXEC_TIMEOUT); el default del bridge es 15s.
const VERIFY_EXEC_TIMEOUT = 120;
// 1 intento para fallos deterministas (typecheck/lint/test/build fallan igual
// siempre: reintentar sin cambiar código no cambia el resultado).
const VERIFY_MAX_ATTEMPTS = 1;
// tope total con retry transitorio (1 intento + 1 reintento).
const VERIFY_RETRY_MAX_ATTEMPTS = VERIFY_MAX_ATTEMPTS + 1;
const VERIFY_RETRY_DELAY_MS = 1500;
const VERIFY_STDERR_TRUNCATE = 400;

const JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

/**
 * @typedef {object} ExecBody
 * @property {number} [exitCode]
 * @property {string} [stderr]
 * @property {string|null} [signal]
 * @property {string|null} [error]
 * @property {string} [stdout]
 */

/**
 * @typedef {object} ExecResult
 * @property {boolean} [ok]
 * @property {ExecBody|null} [result]
 * @property {string|null} [error]
 * @property {string} [tool]
 * @property {number} [elapsed]
 */

/**
 * @typedef {object} ToolAction
 * @property {ToolParams} [params]
 * @property {string} [tool]
 */

/**
 * @typedef {object} VerifyPlan
 * @property {string} [command]
 */

/**
 * @typedef {{ execute(tool: string, opts: object): Promise<object> }} ExecBridge
 */

/**
 * Ejecuta el plan de verificación.
 * @param {VerifyPlan|null|undefined} plan Plan de `resolveVerifyPlan`.
 * @param {{ bridge: ExecBridge, isSmart: boolean, toolResults?: Array<ToolResult>, editTools: Set<string>, signal?: AbortSignal|null }} ctx
 * @returns {Promise<object>} { status: 'passed'|'failed'|'skipped', reason?, command?, attempts?, ... }
 */
async function runVerifyPlan(plan, ctx) {
  const { bridge, isSmart, toolResults, editTools, signal } = ctx;
  if (!isSmart) return { status: 'skipped', reason: 'not_smart' };
  if (!toolResults || !toolResults.some((r) => r.tool && r.ok && editTools.has(r.tool))) {
    return { status: 'skipped', reason: 'no_mutations' };
  }

  // Sellado de calidad aunque no haya scripts ni config: si se mutaron archivos
  // JS, `node --check` verifica sintaxis (determinista, sin dependencias). Esto
  // evita que un proyecto sin package.json/scripts cierre el run sin sellado.
  let command = plan && plan.command ? plan.command : null;
  if (!command) {
    const fallback = buildNodeCheckFallback(toolResults, editTools);
    if (!fallback) return { status: 'skipped', reason: 'no_command' };
    command = fallback;
  }

  const t0 = Date.now();
  let attempts = 0;
  /** @type {ExecResult|null} */
  let res = null;
  for (;;) {
    attempts++;
    if (signal && signal.aborted)
      return { status: 'skipped', reason: 'aborted', command, attempts };
    try {
      res = /** @type {ExecResult} */ (
        await bridge.execute('exec', { command, timeout: VERIFY_EXEC_TIMEOUT })
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res = { ok: false, result: null, error: msg, tool: 'exec', elapsed: 0 };
    }
    if (verifyPassed(res)) break;
    const transient = verifyTransient(res);
    if (transient && attempts < VERIFY_RETRY_MAX_ATTEMPTS && !(signal && signal.aborted)) {
      await new Promise((r) => setTimeout(r, VERIFY_RETRY_DELAY_MS));
      continue;
    }
    break;
  }

  const elapsedMs = Date.now() - t0;
  if (verifyPassed(res)) {
    return { status: 'passed', command, attempts, exitCode: 0, signal: null, elapsedMs };
  }
  const body = res && res.result && typeof res.result === 'object' ? res.result : {};
  const stderr =
    (typeof body.stderr === 'string' ? body.stderr : '') || body.error || res.error || '';
  return {
    status: 'failed',
    command,
    attempts,
    exitCode: typeof body.exitCode === 'number' ? body.exitCode : null,
    signal: body.signal || null,
    stderr: stderr.slice(0, VERIFY_STDERR_TRUNCATE),
    elapsedMs,
  };
}

/**
 * @typedef {object} ToolParams
 * @property {string} [path]
 * @property {string} [filePath]
 * @property {string} [patch]
 * @property {string} [instructions]
 */

/**
 * @typedef {object} ToolResult
 * @property {boolean} [ok]
 * @property {string} [tool]
 * @property {ToolAction} [_action]
 * @property {ToolParams} [params]
 */

/**
 * Comando de sellado mínimo para proyectos sin scripts ni config: `node --check`
 * sobre los archivos JS realmente mutados (sin dependencias, determinista).
 * Devuelve null si no hay archivos JS editables.
 * @param {Array<ToolResult>|undefined} toolResults
 * @param {Set<string>} editTools
 * @returns {string|null}
 */
function buildNodeCheckFallback(toolResults, editTools) {
  const seen = new Set();
  const files = [];
  for (const r of toolResults || []) {
    if (!r || !r.ok || !r.tool) continue;
    if (!editTools.has(r.tool)) continue;
    const action = r._action || (r.params ? { params: r.params } : null);
    if (!action) continue;
    for (const p of extractEditedPaths(action)) {
      if (seen.has(p)) continue;
      seen.add(p);
      if (JS_EXTENSIONS.has(path.extname(p).toLowerCase())) files.push(p);
    }
  }
  if (files.length === 0) return null;
  // Comillas dobles: nombres de archivo con espacios no rompen el comando.
  return `node --check ${files.map((f) => `"${f.replace(/"/g, '\\"')}"`).join(' ')}`;
}

/** Paths que una action de edición toca: params.path/filePath + los `+++ b/`.
 *  @param {ToolAction} action
 *  @returns {string[]}
 */
function extractEditedPaths(action) {
  const params = action.params || {};
  const out = [];
  const p = params.path || params.filePath;
  if (typeof p === 'string' && p.trim()) out.push(p.trim());
  const patch = params.patch || params.instructions || '';
  if (typeof patch === 'string' && patch) {
    const re = /^\+\+\+ b\/(.+)$/gm;
    let m;
    while ((m = re.exec(patch))) {
      const pp = m[1].trim();
      if (pp && !pp.startsWith('/dev/null')) out.push(pp);
    }
  }
  return [...new Set(out)];
}

/** El exec del bridge NO marca ok:false por exitCode≠0 (HTTP 200 igual) → hay
 *  que mirar el `result` real. Pasó solo con exitCode 0.
 *  @param {ExecResult|null|undefined} res
 *  @returns {boolean}
 */
function verifyPassed(res) {
  if (!res) return false;
  if (res.ok === false) return false;
  const r = res.result;
  return !!(r && typeof r === 'object' && r.exitCode === 0);
}

/** Fallo cuyo resultado PUEDE variar en un segundo intento: timeout del server
 *  (SIGKILL, señal temporal) o error de red/servidor caído. Un exitCode≠0
 *  (lint/test falló) NO es transitorio: reintentar sin cambios en el código da
 *  exactamente el mismo resultado.
 *  @param {ExecResult|null|undefined} res
 *  @returns {boolean}
 */
function verifyTransient(res) {
  if (!res) return false;
  if (res.ok === false) {
    return /red|conexi[oó]n|no está corriendo|unavailable|timeout/i.test(res.error || '');
  }
  const r = res.result;
  if (!r || typeof r !== 'object') return false;
  return r.signal === 'timeout';
}

/** Aviso explícito anexado a la respuesta cuando la verificación falló.
 *  @param {{ command?: string, exitCode?: number|null, stderr?: string }} verify
 *  @returns {string}
 */
function buildVerifyFailureNotice(verify) {
  const exit = verify.exitCode != null ? `exit ${verify.exitCode}` : 'timeout';
  const detail = verify.stderr ? `: ${verify.stderr.trim()}` : '';
  return (
    `\n\n[Verificación] La tarea se completó pero la verificación (${verify.command}) ` +
    `falló (${exit})${detail}`
  );
}

module.exports = {
  runVerifyPlan,
  buildVerifyFailureNotice,
  buildNodeCheckFallback,
  extractEditedPaths,
  VERIFY_EXEC_TIMEOUT,
  VERIFY_MAX_ATTEMPTS,
  VERIFY_RETRY_MAX_ATTEMPTS,
  VERIFY_RETRY_DELAY_MS,
  VERIFY_STDERR_TRUNCATE,
};
