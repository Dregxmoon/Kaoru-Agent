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

function _runCmd(cmd, args, timeoutMs = CHECK_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
      return resolve({ ok: true, skipped: e.message });
    }
    let out = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, errors: [`node --check timeout`] });
    }, CHECK_TIMEOUT_MS);
    child.stdout?.on('data', (d) => (out += d));
    child.stderr?.on('data', (d) => (out += d));
    child.on('error', (e) => resolve({ ok: true, skipped: e.message }));
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
async function checkJson(file) {
  try {
    JSON.parse(fs.readFileSync(file, 'utf-8'));
    return { ok: true };
  } catch (e) {
    return { ok: false, errors: [`JSON inválido: ${e.message.slice(0, 200)}`] };
  }
}

/** .sh/.bash → bash -n (parse sin ejecutar). */
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

/** .ts/.tsx → transpilar con typescript si está instalado (reporta sintaxis). */
async function checkTs(file) {
  try {
    const ts = require('typescript');
    const src = fs.readFileSync(file, 'utf-8');
    const diag = ts.transpileModule(src, {
      compilerOptions: { jsx: ts.JsxEmit.React },
      reportDiagnostics: true,
      fileName: file,
    }).diagnostics;
    if (diag && diag.length) {
      const msgs = diag.slice(0, 3).map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '));
      return { ok: false, errors: [`TypeScript inválido: ${msgs.join(' | ')}`] };
    }
    return { ok: true };
  } catch (_) {
    return { ok: true, skipped: 'typescript no instalado' };
  }
}

/** .yml/.yaml → js-yaml si está disponible (skip graceful si no). */
async function checkYaml(file) {
  let yaml = null;
  try {
    yaml = require('js-yaml');
  } catch {}
  if (!yaml) return { ok: true, skipped: 'yaml parser no instalado' };
  try {
    yaml.load(fs.readFileSync(file, 'utf-8'));
    return { ok: true };
  } catch (e) {
    return { ok: false, errors: [`YAML inválido: ${e.message.slice(0, 200)}`] };
  }
}

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
      res = { ok: true, skipped: `checker falló: ${e.message}` };
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
