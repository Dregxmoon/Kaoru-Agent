// @ts-check
'use strict';

/**
 * syntax-verify.js — Verificación de sintaxis UNIVERSAL para archivos mutados
 * por el AgentLoop, sea cual sea la extensión.
 *
 * Complementa a web-verify.js (que valida .html en Chromium). Con esto el
 * pipeline cubre: JS/TS, Python, JSON, shell, CSS, YAML… y degrada con
 * gracia ("skipped") cuando no hay checker disponible para una extensión.
 *
 * Principios:
 *   - Nunca lanza; timeouts por chequeo (nada congela el run).
 *   - Sin herramientas externas obligatorias: node usa process.execPath
 *     (Electron en modo Node), python se sondea con caché.
 *   - Los checks son SOLO LECTURA (py_compile escribe __pycache__ → se usa
 *     compile() embebido vía -c para evitar side-effects).
 */

const fs = require('fs');
const path = require('path');
const logger = require('../observability/Logger.js');
const { spawn } = require('child_process');

const CHECK_TIMEOUT_MS = 10_000;

// ── utilidades ──────────────────────────────────────────────────────────────

/** @param {string} cmd @param {string[]} args @param {number} [timeoutMs] @param {NodeJS.ProcessEnv} [env] */
function _runCmd(cmd, args, timeoutMs = CHECK_TIMEOUT_MS, env = process.env) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    } catch {
      return resolve({ ok: false, unavailable: true, error: 'spawn falló' });
    }
    let out = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, error: `timeout (${timeoutMs}ms)` });
    }, timeoutMs);
    child.stdout?.on('data', (d) => (out += d));
    child.stderr?.on('data', (d) => (out += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, unavailable: true, error: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: String(out || '').trim() });
    });
  });
}

/** Python bin con sondaje y caché (ASISTENTE_PYTHON_BIN gana si existe). */
/** @type {string|null} */
let _pythonBin = null;
async function _getPythonBin() {
  if (_pythonBin) return _pythonBin;
  const candidates = [];
  if (process.env.ASISTENTE_PYTHON_BIN && fs.existsSync(process.env.ASISTENTE_PYTHON_BIN)) {
    candidates.push(process.env.ASISTENTE_PYTHON_BIN);
  }
  candidates.push('python3', 'python');
  for (const c of candidates) {
    const r = await _runCmd(c, ['-c', 'print(1)'], 5000);
    if (r.ok && !r.unavailable) {
      _pythonBin = c;
      return c;
    }
  }
  return null;
}

// ── checkers por extensión ─────────────────────────────────────────────────

/** .js/.mjs/.cjs → node --check usando el propio runtime del proceso. */
/** @param {string} file */
async function checkJs(file) {
  // Electron como Node: mismo intérprete que ejecuta la app, sin GUI.
  const r = await _runCmd(process.execPath, ['--input-type=module', '--eval', ''], 3000);
  if (r.unavailable) return { ok: true, skipped: 'node no disponible' };
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, ['--check', file], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      });
    } catch (e) {
      return resolve({ ok: true, skipped: e instanceof Error ? e.message : String(e) });
    }
    let out = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, errors: [`node --check timeout`] });
    }, CHECK_TIMEOUT_MS);
    child.stdout?.on('data', (d) => (out += d));
    child.stderr?.on('data', (d) => (out += d));
    child.on('error', (e) =>
      resolve({ ok: true, skipped: e instanceof Error ? e.message : String(e) })
    );
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(
        code === 0
          ? { ok: true }
          : { ok: false, errors: [`sintaxis JS inválida: ${out.trim().slice(-300)}`] }
      );
    });
  });
}

/** .py → compile() embebido (sin escribir __pycache__). */
/** @param {string} file */
async function checkPython(file) {
  const py = await _getPythonBin();
  if (!py) return { ok: true, skipped: 'python no disponible' };
  const code =
    `import sys\n` +
    `src = open(sys.argv[1], encoding='utf-8').read()\n` +
    `try:\n` +
    `    compile(src, sys.argv[1], 'exec')\n` +
    `except SyntaxError as e:\n` +
    `    print(f'SyntaxError: {e.msg} (línea {e.lineno})')\n` +
    `    sys.exit(1)\n`;
  const r = await _runCmd(py, ['-c', code, file]);
  return r.unavailable
    ? { ok: true, skipped: r.error }
    : r.ok
      ? { ok: true }
      : { ok: false, errors: [`sintaxis Python inválida: ${r.output.slice(-300)}`] };
}

/** .json → JSON.parse nativo. */
/** @param {string} file */
async function checkJson(file) {
  try {
    JSON.parse(fs.readFileSync(file, 'utf-8'));
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      errors: [
        `JSON inválido: ${e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200)}`,
      ],
    };
  }
}

/** .sh/.bash → bash -n (parse sin ejecutar). */
/** @param {string} file */
async function checkShell(file) {
  const r = await _runCmd('bash', ['-n', file]);
  return r.unavailable
    ? { ok: true, skipped: 'bash no disponible' }
    : r.ok
      ? { ok: true }
      : { ok: false, errors: [`shell inválida: ${r.output.slice(-250)}`] };
}

/**
 * .css → smoke estructural: llaves balanceadas fuera de comentarios/strings.
 * No valida propiedades (eso requiere parser completo), pero atrapa el caso
 * típico del LLM: regla sin cerrar o cierre de más.
 */
/** @param {string} file */
async function checkCss(file) {
  let css = fs.readFileSync(file, 'utf-8');
  css = css.replace(/\/\*[\s\S]*?\*\//g, ''); // comentarios
  css = css.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''"); // strings
  let depth = 0;
  for (const ch of css) {
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    if (depth < 0) break;
  }
  return depth === 0
    ? { ok: true }
    : {
        ok: false,
        errors: [
          `CSS desbalanceado: ${depth > 0 ? `faltan ${depth} cierre(s) de }` : `${-depth} } de más`}`,
        ],
      };
}

/** .ts/.tsx → invocar tsc --noCheck; TypeScript 7 ya no expone transpileModule en CJS. */
/** @param {string} file */
async function checkTs(file) {
  try {
    const packageDir = path.dirname(require.resolve('typescript/package.json'));
    const cli = path.join(packageDir, 'lib', 'tsc.js');
    if (!fs.existsSync(cli)) return { ok: true, skipped: 'typescript no instalado' };
    const r = await _runCmd(
      process.execPath,
      [
        cli,
        '--ignoreConfig',
        '--noEmit',
        '--noCheck',
        '--pretty',
        'false',
        '--skipLibCheck',
        '--target',
        'ES2022',
        file,
      ],
      CHECK_TIMEOUT_MS,
      { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    );
    return r.unavailable
      ? { ok: true, skipped: r.error }
      : r.ok
        ? { ok: true }
        : {
            ok: false,
            errors: [`TypeScript inválido: ${(r.output || r.error || '').slice(-300)}`],
          };
  } catch (_) {
    return { ok: true, skipped: 'typescript no instalado' };
  }
}

/** .yml/.yaml → js-yaml si está disponible (skip graceful si no). */
/** @param {string} file */
async function checkYaml(file) {
  let yaml = null;
  try {
    const optionalRequire = /** @type {(name:string)=>any} */ (require);
    yaml = optionalRequire('js-yaml');
  } catch {}
  if (!yaml) return { ok: true, skipped: 'yaml parser no instalado' };
  try {
    yaml.load(fs.readFileSync(file, 'utf-8'));
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      errors: [
        `YAML inválido: ${e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200)}`,
      ],
    };
  }
}

/** @type {Record<string,(file:string)=>Promise<any>>} */
const CHECKERS = {
  '.js': checkJs,
  '.mjs': checkJs,
  '.cjs': checkJs,
  '.py': checkPython,
  '.json': checkJson,
  '.sh': checkShell,
  '.bash': checkShell,
  '.css': checkCss,
  '.ts': checkTs,
  '.tsx': checkTs,
  '.yml': checkYaml,
  '.yaml': checkYaml,
};

/** Extensiones con checker disponible (para que el caller filtre antes). */
const SUPPORTED_EXTS = Object.keys(CHECKERS);

/**
 * Verifica la sintaxis de los archivos dados según su extensión.
 * Archivos sin checker (.md, .txt, imágenes…) → skip silencioso.
 * @param {string[]} files - rutas absolutas
 * @param {{ maxFiles?: number }} [opts]
 * @returns {Promise<{ ok: boolean, results: Array<{ file: string, ext: string, ok: boolean, skipped?: string, errors?: string[] }> }>}
 */
async function verifySyntax(files, { maxFiles = 6 } = {}) {
  /** @type {Array<{ file: string, ext: string, ok: boolean, skipped?: string, errors?: string[] }>} */
  const results = [];
  let checked = 0;

  for (const file of files || []) {
    if (checked >= maxFiles) break;
    if (!fs.existsSync(file)) continue;
    const ext = path.extname(file).toLowerCase();
    const checker = CHECKERS[ext];
    if (!checker) continue; // extensión sin checker → ni cuenta
    checked++;
    let res;
    try {
      res = await checker(file);
    } catch (e) {
      res = { ok: true, skipped: `checker falló: ${e instanceof Error ? e.message : String(e)}` };
    }
    results.push({
      file,
      ext,
      ok: !!res.ok,
      ...(res.skipped ? { skipped: res.skipped } : {}),
      ...(res.errors ? { errors: res.errors } : {}),
    });
    logger.info(
      'syntax-verify',
      `[syntax-verify] ${path.basename(file)}: ${
        res.ok
          ? res.skipped
            ? `skip (${res.skipped})`
            : 'ok ✓'
          : `INVÁLIDO — ${(res.errors || []).join(' ').slice(0, 100)}`
      }`
    );
    if (!res.ok) break; // primer fallo basta para iterar
  }

  const failed = results.find((r) => !r.ok);
  return { ok: !failed, results };
}

module.exports = { verifySyntax, SUPPORTED_EXTS, CHECKERS };
