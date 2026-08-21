// @ts-nocheck
'use strict';

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const Diff = require('diff');
const crypto = require('crypto');
const { dirSet } = require('./core/utils/ignoreDirs.js');
const { isUrlSafe } = require('./core/security/UrlGuard.js');
const logger = require('./core/observability/Logger.js');

// P3: límite de confianza anti prompt-injection — el texto de páginas web de
// terceros NO es confiable (una página puede llevar instrucciones ocultas
// para el agente). webfetch/websearch devuelven contenido delimitado como
// no confiable y neutralizan patrones de inyección antes de que entre al LLM.
const { wrapUntrusted, wrapUntrustedItems } = require('./core/grounding/untrustedContent.js');

// G.1: puerto configurable vía OPENCLAW_PORT (para tests y despliegues
// embebidos); default 18789 mantiene compatibilidad.
const DEFAULT_PORT = 18789;
const PORT = parseInt(process.env.OPENCLAW_PORT, 10) || DEFAULT_PORT;

// ── Configuración desde entorno ─────────────────────────────────────────────

const API_KEY = process.env.OPENCLAW_API_KEY || null;
const ALLOWED_PATH = process.env.OPENCLAW_ALLOWED_PATH
  ? path.resolve(process.env.OPENCLAW_ALLOWED_PATH)
  : process.cwd();

// Sin API_KEY → servidor se niega a arrancar (fail closed)
// Solo cuando se ejecuta como script (no al ser importado como módulo)
if (require.main === module && !API_KEY) {
  logger.error('openclaw-server', 'OPENCLAW_API_KEY no definida — abortando');
  process.exit(1);
}

// ── Límites ─────────────────────────────────────────────────────────────────

const MAX_REQUEST_BODY = 10 * 1024 * 1024; // 10 MB
const RATE_LIMIT_WINDOW = 1000; // 1 segundo
const RATE_LIMIT_MAX = 100; // 100 req/s máximo

const MAX_EXEC_OUTPUT = 5 * 1024 * 1024; // 5 MB
const MAX_EXEC_TIMEOUT = 120_000; // 2 min
const MAX_CODE_TIMEOUT = 60_000; // 1 min

// ── Rate limiter ────────────────────────────────────────────────────────────

const requestTimestamps = [];

function _checkRateLimit() {
  const now = Date.now();
  while (requestTimestamps.length > 0 && requestTimestamps[0] < now - RATE_LIMIT_WINDOW) {
    requestTimestamps.shift();
  }
  if (requestTimestamps.length >= RATE_LIMIT_MAX) return false;
  requestTimestamps.push(now);
  return true;
}

// ── Auditoría ───────────────────────────────────────────────────────────────
// Cada ejecución de herramienta se registra en memoria (últimas 1000) y se
// persiste en un archivo JSONL (auditoría forense que sobrevive reinicios).
// La ruta se configura con OPENCLAW_AUDIT_PATH; default: tmp del SO.

const AUDIT_LOG_PATH =
  process.env.OPENCLAW_AUDIT_PATH || path.join(require('os').tmpdir(), 'openclaw-audit.jsonl');

const auditLog = [];

function _appendAuditFile(entry) {
  try {
    const dir = path.dirname(AUDIT_LOG_PATH);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(AUDIT_LOG_PATH, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // El audit no debe romper la ejecución de herramientas
  }
}

function _audit(tool, params, ok, detail) {
  const entry = {
    ts: new Date().toISOString(),
    tool,
    params: _sanitizeParamsForLog(tool, params),
    ok,
    detail,
  };
  auditLog.push(entry);
  const status = ok ? 'OK' : 'FAIL';
  logger.info('openclaw-audit', `${entry.ts} ${tool} ${status} — ${detail}`);
  if (auditLog.length > 1000) auditLog.shift();
  _appendAuditFile(entry);
}

function _sanitizeParamsForLog(tool, params) {
  if (!params) return {};
  const safe = { ...params };
  if (safe.content) safe.content = `<${Buffer.byteLength(safe.content, 'utf-8')} bytes>`;
  if (safe.code) safe.code = `<${Buffer.byteLength(safe.code, 'utf-8')} bytes>`;
  if (safe.patch) safe.patch = `<${safe.patch.length} chars>`;
  if (safe.command) safe.command = safe.command.slice(0, 200);
  if (safe.old_text) safe.old_text = safe.old_text.slice(0, 80);
  if (safe.new_text) safe.new_text = safe.new_text.slice(0, 80);
  return safe;
}

// ── Lista de patrones de comandos peligrosos (defense-in-depth) ────────────

// NOTA HONESTA: esto es defensa en profundidad de una sola capa, NO una
// sandbox. Un blocklist por regex sobre el string crudo es evadible por
// diseño (codificación base64, variables de entorno, alias, comillas
// partidas, sustitución de comandos anidada). No lo trates como el
// mecanismo real de seguridad — el mecanismo real es que isHighImpact()
// en ActionParser.js pide aprobación humana para CUALQUIER exec que no
// esté en una lista explícita de comandos de solo lectura conocidos
// (ver SAFE_READONLY_PATTERNS ahí) — eso es lo que no se puede
// evadir con un truco de shell, porque no depende de reconocer el ataque,
// depende de reconocer lo seguro. Este blocklist es un segundo cinturón
// además de esa aprobación, para el caso de un comando ya aprobado que
// resulta ser más destructivo de lo que parecía.
const BLOCKED_COMMAND_PATTERNS = [
  /\brm\s+-rf?\b/i,
  /\b(shutdown|reboot|poweroff|halt)\b/i,
  /\bkill\s+-9\b/,
  /\b(curl|wget)\b.*\|\s*(sh|bash|zsh)\b/i,
  /\b(dd|mkfs|fdisk|parted|mkswap)\b/,
  /:\(\)\s*\{/,
  /\bchmod\s+777\b/i,
  /\bchown\s/i,
  /\bsudo\s/i,
  /\bsu\s+-/i,
  /\bpasswd\b/i,
  /\/etc\/(passwd|shadow|sudoers|fstab|crontab)\b/,
  // patrones de ofuscación comunes — no exhaustivo, ver nota arriba
  /\bbase64\s+(-d|--decode)\b/i,
  /\beval\b/i,
  /\bexec\s+\d*<>/i,
  /\$\{?IFS\}?/,
  /\bxxd\s+-r\b/i,
  /\bprintf\b.*\\x/i,
  /\/dev\/(tcp|udp)\//i,
];

function _isBlockedCommand(command) {
  return BLOCKED_COMMAND_PATTERNS.some((re) => re.test(command));
}

// P2: env limpio para procesos hijos. El proceso hijo hereda process.env por
// defecto — si la app corre con GITHUB_TOKEN, OPENAI_API_KEY u otras
// credenciales en el entorno, un comando aprobado (o el script de
// code_execution) podría exfiltra-las. La política vive en core/utils/childEnv.js
// (ÚNICA fuente, compartida con MCP y plugins): conserva lo necesario para
// herramientas habituales (PATH, HOME, LANG, locales) pero ELIMINA variables
// que son claves/tokens. Esto NO es un sandbox de proceso (ver nota de
// BLOCKED_COMMAND_PATTERNS): es defensa en profundidad para no exponer
// credenciales del entorno a comandos que no las necesitan.
const { safeChildEnv } = require('./core/utils/childEnv.js');

function _safeChildEnv() {
  const env = safeChildEnv();
  // Dentro del sandbox, `--ro-bind / /` introduce una frontera de mount que
  // git no cruza por defecto. Permitir el descubrimiento del repo a través
  // de ella (el acceso real a los archivos sigue acotado al workspace).
  if (_sandboxEnabled) env.GIT_DISCOVERY_ACROSS_FILESYSTEM = '1';
  return env;
}

// ── Sandbox de proceso (bubblewrap) ──────────────────────────────────────────
// 2.1: sandbox de proceso REAL para comandos aprobados. Bubblewrap (bwrap)
// crea namespaces de mount/pid/ipc/user: todo el filesystem se monta de solo
// lectura y únicamente el workspace (ALLOWED_PATH) + /tmp quedan escribibles,
// con ~/.ssh aislado para no exponer llaves. Un comando escapista (base64,
// variables, sustitución anidada, comillas partidas) ya no puede escribir
// fuera del workspace ni leer secretos del usuario. NO se aísla la red porque
// git push/webfetch necesitan salida real.
//
// Degradación transparente: si bwrap no existe, no es Linux o el self-test
// falla (kernel sin user namespaces), el sandbox se desactiva y se conserva el
// comportamiento anterior — nunca rompe el server. Desactivable con
// OPENCLAW_SANDBOX=0.
let _sandboxEnabled = false;
let _sandboxReason = null;
(function _initSandbox() {
  try {
    if (process.env.OPENCLAW_SANDBOX === '0') {
      _sandboxReason = 'desactivado por OPENCLAW_SANDBOX=0';
      return;
    }
    if (process.platform !== 'linux') {
      _sandboxReason = `plataforma no soportada (${process.platform})`;
      return;
    }
    const which = require('child_process')
      .execFileSync('which', ['bwrap'], {
        encoding: 'utf-8',
      })
      .trim();
    if (!which) {
      _sandboxReason = 'bwrap no encontrado en PATH';
      return;
    }
    require('child_process').execFileSync(
      which,
      ['--ro-bind', '/', '/', '--tmpfs', '/tmp', '--unshare-user', 'true'],
      { stdio: 'ignore', timeout: 10_000 }
    );
    _sandboxEnabled = true;
    logger.info('openclaw-server', 'sandbox de proceso: bwrap habilitado');
  } catch (e) {
    _sandboxReason = `bwrap no usable: ${e.message}`;
    _sandboxEnabled = false;
  }
})();

// ── Toolchain de Node dentro del sandbox ─────────────────────────────────────
// CAUSA RAIZ observada en producción: con `--ro-bind / /` + `--tmpfs $HOME`,
// las toolchains instaladas EN el home (nvm, fnm, volta...) desaparecen del
// sandbox → `bwrap: execvp npm: No such file or directory` aunque `node` esté
// disponible. Se resuelve en dos planos complementarios:
//   - Binds: el directorio raíz bajo $HOME que contiene cada binario de la
//     toolchain se remonta read-only SOBRE el tmpfs. No afloja el aislamiento:
//     el resto del home (dotfiles, .ssh, claves) sigue invisible; solo se
//     expone la toolchain, que es lo que un comando aprobado necesita para
//     correr (oa npm/npx/tsc).
//   - Rewrite: como red de seguridad, si el lanzador sigue sin resolverse por
//     PATH (cadenas de symlink raras), se reescribe a la ruta REAL del binario
//     (`node <cli>.js` para scripts JS, o la ruta absoluta para binarios).
// Solo aplica a bins whitelisteados de herramienta; el workspace
// (ALLOWED_PATH) nunca entra en esta ruta.
const TOOLCHAIN_BINS = ['node', 'npm', 'npx', 'tsc', 'ts-node', 'tsx', 'yarn', 'pnpm'];

/** Ruta de un binario en el HOST (sin llegar a ejecutarlo). */
function _whichBin(bin) {
  try {
    const out = require('child_process')
      .execFileSync('which', [bin], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      .trim();
    return out || null;
  } catch {
    return null;
  }
}

/** Resuelve la cadena completa de symlinks de una ruta. */
function _resolveReal(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Ancestro más alto de `p` todavía bajo $HOME (el dir cuyo árbol hay que
 * remontar para que `p` sea visible en el sandbox). Devuelve null si la ruta
 * NO vive bajo $HOME — entonces `--ro-bind / /` ya la expone y no hace falta
 * nada (system dirs como /usr/bin ya son visibles).
 */
function _maskedRoot(p) {
  const home = process.env.HOME || '';
  if (!home || p === home || !p.startsWith(home + '/')) return null;
  let cur = p;
  for (;;) {
    const parent = path.dirname(cur);
    if (parent === home || parent === cur) return cur;
    cur = parent;
  }
}

// Resuelto UNA vez al arrancar: las toolchains no cambian a mitad de sesión.
/** @type {string[]} dirs bajo $HOME a remontar read-only */
const TOOLCHAIN_BINDS = [];
/** @type {Map<string, { launch: string, real: string, masked: boolean }>} */
const TOOLCHAIN_LAUNCHERS = new Map();
if (_sandboxEnabled) {
  for (const bin of TOOLCHAIN_BINS) {
    const launch = _whichBin(bin);
    if (!launch) continue;
    const real = _resolveReal(launch);
    const root = _resolveReal(_maskedRoot(real) || _maskedRoot(launch));
    const masked = root != null;
    if (masked && !TOOLCHAIN_BINDS.includes(root)) TOOLCHAIN_BINDS.push(root);
    TOOLCHAIN_LAUNCHERS.set(bin, { launch, real, masked });
  }
}

/**
 * Envuelve `commandArgs` en bwrap para aislar el proceso hijo. Si el sandbox
 * no está activo devuelve los args tal cual (comportamiento original).
 * Con `detach: true` (comando con backgrounding `&`) se omite `--die-with-parent`:
 * es la única variación necesaria para que un proceso en background sobreviva a
 * la salida del exec (bwrap sigue con `--unshare-pid`/`--ro-bind / /`/tmpfs, así
 * que el aislamiento se conserva; el bg queda en el mismo mount namespace).
 * @param {string[]} commandArgs
 * @param {{ detach?: boolean }} [opts]
 * @returns {string[]}
 */
function _wrapSandbox(commandArgs, opts = {}) {
  if (!_sandboxEnabled) return commandArgs;
  const home = process.env.HOME || '/tmp';
  const wrap = ['bwrap', '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts'];
  if (!opts.detach) wrap.push('--die-with-parent');
  wrap.push(
    '--new-session',
    '--ro-bind',
    '/',
    '/',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    '--tmpfs',
    home
  );
  // Toolchains instaladas en $HOME (nvm/fnm/volta): se remontan sobre el
  // tmpfs para que npm/npx/tsc sean ejecutables dentro del sandbox.
  for (const dir of TOOLCHAIN_BINDS) {
    if (dir !== ALLOWED_PATH) wrap.push('--ro-bind', dir, dir);
  }
  wrap.push('--bind', ALLOWED_PATH, ALLOWED_PATH, '--', ...commandArgs);
  return wrap;
}

/**
 * Reescribe el lanzador a la ruta REAL del binario de la toolchain cuando su
 * resolución por PATH dentro del sandbox no se garantiza (binarios que viven
 * en $HOME). `node <cli>.js` para scripts con shebang Node; ruta absoluta
 * para binarios compilados. Solo toca bins whitelisteados.
 * @param {string[]} args
 * @returns {string[]}
 */
function _rewriteToolchainCommand(args) {
  if (!args || args.length === 0) return args;
  const hit = TOOLCHAIN_LAUNCHERS.get(args[0]);
  if (!hit || !hit.masked || !hit.real) return args;
  if (/\.(js|cjs|mjs)$/.test(hit.real)) {
    // Script JS con shebang Node → ejecutarlo con node (que sí es visible).
    return ['node', hit.real, ...args.slice(1)];
  }
  // Binario compilado (node/npx...): se invoca el ejecutable real directo,
  // sin volver a envolverlo en node (eso duplicaría el argv como script).
  return [hit.real, ...args.slice(1)];
}

function _buildCommandArgs(fullCommand) {
  const args = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < fullCommand.length; i++) {
    const ch = fullCommand[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === ' ' && !inSingle && !inDouble) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }
    if (ch === '\\' && i + 1 < fullCommand.length) {
      current += fullCommand[++i];
      continue;
    }
    current += ch;
  }
  if (current) args.push(current);
  return args;
}

// Shell builtins / operadores que `spawn` no puede ejecutar sin un shell real
// (`cd`, `&&`, `||`, `;`, pipes `|`/`>>`, redirección `>`/`<`, backgrounding
// `&` simple, `$(...)`/backticks). exec corre `sh -c` cuando el llamador manda
// `shell: true` O cuando el comando contiene esta sintaxis (detección
// automática): antes un comando como `cd x && ...` o `python3 ... > log 2>&1 &`
// se pasaba literal a spawn/bwrap y fallaba (`execvp cd: No such file or
// directory`, `unrecognized arguments`). El sandbox sigue envolviendo `sh -c`,
// así que la detección automática no lo debilita. La detección queda exportada
// para tests y para que el agente pueda pedir shell explícito si lo prefiere.
const _SHELL_SYNTAX_RE = /(^|\s)cd(\s|$)|(\|\||&&|;|\||>>|>|<|\$\()|`|(^|\s)&(\s|$)/;

/**
 * @param {string} command
 * @returns {boolean}
 */
function _needsShellCommand(command) {
  return _SHELL_SYNTAX_RE.test(command);
}

// Backgrounding `&` simple (no `2>&1` ni `&&`): un proceso en background
// (`cmd > log 2>&1 &`) debe sobrevivir a la salida del exec. Se usa para
// correr ese comando en modo "detach" del sandbox (sin --die-with-parent).
const _DETACH_RE = /(^|\s)&(\s|$)/;

/**
 * @param {string} command
 * @returns {boolean}
 */
function _hasBackgroundOperator(command) {
  return _DETACH_RE.test(command);
}

// `node -e '<script>'` / `node --eval '<script>'` donde el script está entre
// comillas (simples o dobles) y PUEDE ser multilínea. El tokenizador sin shell
// y la detección de shell no pueden manejar esto de forma fiable: comillas
// anidadas, saltos de línea, backslashes de regex y operadores JS (`||`, `&&`,
// `;`, `|`) se corrompen o se confunden con sintaxis de shell, y un script
// vacío caía con "-e requires an argument". En vez de seguir escapando, se
// extrae el script CRUDO (tal como lo escribió el LLM, sin desescapar nada) y
// se pasa a `node -` por stdin — el mismo modo de evaluación que `node -e`,
// que además conserva `require()` relativo al cwd y top-level `await`.
const NODE_EVAL_RE = /^\s*(node|nodejs)\s+(?:-e|--eval)\s+([\s\S]*)$/;

/**
 * @param {string} command
 * @returns {{ bin: string, script: string }|null}
 *   Script crudo listo para stdin, o null si no aplica (ahí el comando sigue
 *   el camino normal). Solo cuando el script está entre comillas y no hay nada
 *   después del cierre; sin comillas el camino actual ya funciona.
 */
function _extractNodeEvalScript(command) {
  const m = NODE_EVAL_RE.exec(command);
  if (!m) return null;
  const bin = m[1];
  const rest = m[2];
  if (!rest) return null;
  let script;
  if (rest[0] === "'") {
    const end = rest.indexOf("'", 1);
    if (end === -1) return null; // comilla sin cerrar: no tocar
    script = rest.slice(1, end);
    if (rest.slice(end + 1).trim()) return null; // contenido tras el cierre
  } else if (rest[0] === '"') {
    let i = 1;
    let closed = false;
    for (; i < rest.length; i++) {
      const ch = rest[i];
      if (ch === '\\') {
        i += 1; // el carácter escapado (p.ej. \" o \\n) no cierra la comilla
        continue;
      }
      if (ch === '"') {
        closed = true;
        break;
      }
    }
    if (!closed) return null;
    script = rest.slice(1, i);
    if (rest.slice(i + 1).trim()) return null;
  } else {
    return null; // sin comillas: el camino normal (tokenizado) ya funciona
  }
  return { bin, script };
}

// Un script `node -e` que LEE su propio stdin (readline, prompt-sync,
// process.stdin) no puede ir por `node -`: ahí el stdin lo consume node para
// el programa y el script se quedaría esperando data que nunca llega. Ese caso
// sigue el camino normal (inline), que ya funciona para scripts de 1 línea.
const STDIN_USAGE_RE = /process\.stdin|readline|prompt-sync|\/dev\/stdin/;

/**
 * @param {string} script
 * @returns {boolean}
 */
function _scriptReadsStdin(script) {
  return STDIN_USAGE_RE.test(script);
}

// ── Rutas inmutablemente protegidas (nunca accesibles) ─────────────────────

const PathGuard = require('./core/security/PathGuard.js');

const IMMUTABLE_PATH_PATTERNS = PathGuard.IMMUTABLE_PATH_PATTERNS;

function _isImmutablePath(filePath) {
  return PathGuard.isImmutablePath(filePath);
}

// Calcula qué líneas cambiaron entre oldContent y newContent para el split
// visual viejo/actualizado de la UI (edit/apply_patch). Devuelve arrays de
// números de línea (1-based) que se añadieron o se quitaron.
function _diffLineMarkers(oldContent, newContent) {
  const added = [];
  const removed = [];
  let oldLine = 1;
  let newLine = 1;
  for (const change of Diff.diffLines(oldContent || '', newContent || '')) {
    const lines = change.value.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    if (change.removed) {
      for (let i = 0; i < lines.length; i++) removed.push(oldLine + i);
      oldLine += lines.length;
    } else if (change.added) {
      for (let i = 0; i < lines.length; i++) added.push(newLine + i);
      newLine += lines.length;
    } else {
      oldLine += lines.length;
      newLine += lines.length;
    }
  }
  return { addedLines: added, removedLines: removed };
}

// Patch unificado del cambio (para el bloque visual de diff en el chat).
function _diffPatch(filePath, oldContent, newContent) {
  try {
    return Diff.createTwoFilesPatch(
      'a/' + path.basename(filePath),
      'b/' + path.basename(filePath),
      oldContent || '',
      newContent || '',
      '',
      '',
      { context: 3 }
    );
  } catch (_) {
    return '';
  }
}

// Realpath del ancestro existente más cercano a `p` (para rutas de archivos
// que aún no existen, p.ej. al escribir uno nuevo), manteniendo el resto
// del path como sufijo literal. Cierra la vía de escape por symlink: si un
// directorio intermedio es un symlink hacia fuera de ALLOWED_PATH, el realpath
// lo resuelve y _isOutsideAllowed lo detecta. Delegado a PathGuard (lógica
// compartida con FileResolver).
function _realpathNearest(p) {
  return PathGuard.realpathNearest(p);
}

function _isOutsideAllowed(filePath) {
  return PathGuard.isOutsideAllowed(filePath, ALLOWED_PATH);
}

// ── Handlers ────────────────────────────────────────────────────────────────

const DEFAULT_IGNORED = dirSet(['.git']);

function _splitIgnore(ignore) {
  if (!ignore) return DEFAULT_IGNORED;
  return new Set(
    String(ignore)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .concat([...DEFAULT_IGNORED])
  );
}

function _minimatchGlob(pattern) {
  const mm = require('minimatch').minimatch || require('minimatch');
  return (relPath) => mm(relPath, pattern, { dot: true });
}

function _collectFiles(base, opts = {}) {
  const { ignore, includeMatcher, maxFiles = 4000 } = opts;
  const ignored = _splitIgnore(ignore);
  const out = [];
  const stack = [base];

  while (stack.length > 0 && out.length < maxFiles) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) break;
      if (ignored.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
      } else if (entry.isFile()) {
        if (includeMatcher) {
          const rel = path.relative(ALLOWED_PATH, abs).split(path.sep).join('/');
          if (!includeMatcher(rel) && !includeMatcher(entry.name)) continue;
        }
        out.push(abs);
      }
    }
  }
  return out;
}

// ── Herramientas web (webfetch/websearch) ────────────────────────────────────

const MAX_WEB_BYTES = 512 * 1024; // 512 KB de texto por página
const MAX_WEB_TIMEOUT = 20_000; // 20 s

function _htmlToText(html) {
  return (html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function _httpGet(urlString, redirectsLeft = 3) {
  // Defensa: validar que la URL no apunte a una IP interna/loopback/link-local
  const urlCheck = await isUrlSafe(urlString, { timeout: 3000 });
  if (!urlCheck.safe) {
    throw new Error(`URL bloqueada por seguridad: ${urlCheck.reason}`);
  }

  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlString);
    } catch (e) {
      reject(new Error(`URL inválida: ${urlString}`));
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      reject(new Error(`Protocolo no soportado: ${parsed.protocol}`));
      return;
    }
    const lib = parsed.protocol === 'https:' ? require('https') : require('http');
    const req = lib.get(
      parsed,
      { headers: { 'User-Agent': 'Kaoru-assistant/1.0 (+local desktop assistant)' } },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
          res.resume();
          const next = new URL(res.headers.location, parsed).toString();
          _httpGet(next, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        if (status >= 400) {
          res.resume();
          reject(new Error(`HTTP ${status}`));
          return;
        }
        const chunks = [];
        let size = 0;
        let truncated = false;
        res.on('data', (c) => {
          if (size >= MAX_WEB_BYTES) {
            truncated = true;
            return;
          }
          size += c.length;
          chunks.push(c);
        });
        res.on('end', () => {
          resolve({
            statusCode: status,
            contentType: res.headers['content-type'] || '',
            truncated,
            body: Buffer.concat(chunks).toString('utf-8'),
          });
        });
        res.on('error', reject);
      }
    );
    req.setTimeout(MAX_WEB_TIMEOUT, () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', reject);
  });
}

/**
 * Extrae resultados del HTML de DuckDuckGo (html.duckduckgo.com/html).
 * Función pura — testeable sin red.
 * @param {string} html
 * @returns {Array<{title: string, url: string, snippet: string}>}
 */
function _parseDuckDuckGoHTML(html) {
  const out = [];
  const itemRe = /<div[^>]*class="result[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="result|$)/gi;
  let m;
  const seen = new Set();
  while ((m = itemRe.exec(html)) !== null && out.length < 10) {
    const block = m[1];
    const titleM = /<a[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    const urlM = /<a[^>]*class="result__a"[^>]*href="([^"]+)"/i.exec(block);
    const snipM = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    const title = titleM ? _htmlToText(titleM[1]).trim() : '';
    let url = urlM ? urlM[1] : '';
    if (url.startsWith('//duckduckgo.com/l/?uddg=')) {
      try {
        url = decodeURIComponent(url.replace('//duckduckgo.com/l/?uddg=', ''));
      } catch (_) {
        /* mantener url cruda */
      }
    }
    const snippet = snipM ? _htmlToText(snipM[1]).trim() : '';
    if (title && url && !seen.has(url)) {
      seen.add(url);
      out.push({ title, url, snippet });
    }
  }
  return out;
}

const HANDLERS = {
  exec(input) {
    const command = input.command;
    const rawCwd = input.cwd || ALLOWED_PATH;
    const cwd = path.isAbsolute(rawCwd) ? rawCwd : path.resolve(ALLOWED_PATH, rawCwd);
    const timeout = Math.min((input.timeout || 15) * 1000, MAX_EXEC_TIMEOUT);

    if (!command) return { error: 'command required' };
    if (_isBlockedCommand(command)) return { error: 'command blocked by server security policy' };
    if (_isOutsideAllowed(cwd)) return { error: `cwd outside allowed path: ${cwd}` };

    // `node -e '<script>'` con script entre comillas (puede ser multilínea):
    // el script se pasa por stdin con `node -` en vez de tokenizarlo inline.
    // Sin un shell real, el tokenizado del script (comillas anidadas, saltos
    // de línea, backslashes de regex, operadores JS `||`/`&&`/`;` que la
    // detección de shell malinterpreta) era imposible de garantizar y la
    // verificación fallaba con "-e requires an argument" o un script corrupto.
    // `node -` evalúa EXACTAMENTE igual que `node -e` (require relativo al
    // cwd, top-level await) y elimina el problema de escaping por completo.
    // Solo se reescribe si el llamador no provee `stdin` (ahí el script
    // interactivo SÍ necesita el pipe para su propio input).
    let stdinValue = input.stdin != null ? String(input.stdin) : null;
    let args;
    let nodeEval = null;
    if (input.shell !== true && stdinValue == null) {
      const ev = _extractNodeEvalScript(command);
      if (ev && !_scriptReadsStdin(ev.script)) nodeEval = ev;
    }
    if (nodeEval) {
      stdinValue = nodeEval.script;
      args = _rewriteToolchainCommand([nodeEval.bin, '-']);
    } else if (input.shell === true || _needsShellCommand(command)) {
      // Shell real: lo pide el llamador (`shell: true`) o se detecta solo cuando
      // el comando necesita un shell para interpretarse (`cd`/`&&`/pipes/
      // redirección/backgrounding). Sin el flag ni la sintaxis, los argumentos
      // se pasan separados a spawn — y aunque se use shell, `sh -c` queda
      // envuelto en bwrap y el blocklist ya se aplicó sobre el string crudo.
      args = ['sh', '-c', command];
    } else {
      args = _rewriteToolchainCommand(_buildCommandArgs(command));
    }
    if (!args || args.length === 0) return { error: 'empty command after parsing' };

    // Programas interactivos (readline/prompt-sync): si el llamador manda el
    // input en `stdin`, se escribe en el pipe del hijo y luego se cierra; si no
    // hay input, se cierra el stdin de inmediato para que el programa no quede
    // colgado esperando teclas hasta el timeout.

    // Async con spawn (no spawnSync): un comando largo NO bloquea el proceso
    // main ni el event loop del server (antes congelaba la app entera).
    return new Promise((resolve) => {
      // Detach: si el comando manda algo a background (`&`), el sandbox omite
      // --die-with-parent para que ese proceso sobreviva (p.ej. un http.server
      // que el agente levanta para verificar). El proceso principal se sigue
      // matando con el timeout (ver abajo).
      const detach = _hasBackgroundOperator(command);
      const sandboxArgs = _wrapSandbox(args, { detach });
      const child = spawn(sandboxArgs[0], sandboxArgs.slice(1), {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: _safeChildEnv(),
      });
      const stdout = [];
      const stderr = [];
      let outSize = 0;
      let errSize = 0;
      let killed = false;

      if (child.stdin) {
        if (stdinValue != null) child.stdin.write(stdinValue);
        child.stdin.end();
      }

      child.stdout.on('data', (c) => {
        outSize += c.length;
        if (outSize <= MAX_EXEC_OUTPUT) stdout.push(c);
      });
      child.stderr.on('data', (c) => {
        errSize += c.length;
        if (errSize <= MAX_EXEC_OUTPUT) stderr.push(c);
      });

      // Timeout: primero SIGTERM (bwrap lo reenvía al init del sandbox y el
      // pid namespace se desarma), y solo si a los 500ms sigue colgado, SIGKILL.
      // Antes un SIGKILL directo a bwrap dejaba huérfano el proceso colgado.
      const killTimer = () => {
        killed = true;
        child.kill('SIGTERM');
        setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // ya cerró
          }
        }, 500);
      };
      const timer = setTimeout(killTimer, timeout);

      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({
          result: {
            stdout: Buffer.concat(stdout).toString('utf-8'),
            stderr: Buffer.concat(stderr).toString('utf-8'),
            exitCode: null,
            signal: null,
            error: e.message,
          },
        });
      });

      child.on('close', (code, signal) => {
        clearTimeout(timer);
        resolve({
          result: {
            stdout: Buffer.concat(stdout).toString('utf-8'),
            stderr: Buffer.concat(stderr).toString('utf-8'),
            exitCode: code,
            signal: killed ? 'timeout' : signal || null,
            error: null,
          },
        });
      });
    });
  },

  read(input) {
    const filePath = path.resolve(ALLOWED_PATH, input.path || '');
    if (_isOutsideAllowed(filePath)) return { error: `path outside allowed zone: ${filePath}` };
    if (!fs.existsSync(filePath)) return { error: `File not found: ${filePath}` };

    const content = fs.readFileSync(filePath, input.encoding || 'utf-8');
    return { result: content };
  },

  write(input) {
    const filePath = path.resolve(ALLOWED_PATH, input.path || '');
    if (_isOutsideAllowed(filePath)) return { error: `path outside allowed zone: ${filePath}` };

    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const mode = input.mode === 'append' ? 'append' : 'write';
    const content = input.content ?? '';
    const encoding = input.encoding || 'utf-8';

    // Modo append: para escribir archivos MUY grandes en partes (el write
    // completo se puede truncar a mitad del contenido). Crea el archivo si no
    // existe y agrega al final; nunca reescribe lo ya escrito.
    if (mode === 'append' && fs.existsSync(filePath)) {
      fs.appendFileSync(filePath, content, encoding);
      return {
        result: `Appended ${Buffer.byteLength(content, encoding)} bytes to ${filePath}`,
      };
    }

    // Vista previa de diff: el contenido ACTUAL del archivo (si existe) es el
    // "antes". Cubre tanto el archivo nuevo (oldContent = '') como el write
    // que SOBREESCRIBE un archivo existente entero — el caso de mayor riesgo,
    // donde el usuario debe ver claramente todo lo que se pierde. Solo tiene
    // sentido para encodings de texto: con base64/binario el diff sería basura.
    const textEncoding = !encoding || /^utf-?8$/i.test(String(encoding));
    let oldContent = '';
    if (textEncoding && fs.existsSync(filePath)) {
      try {
        oldContent = fs.readFileSync(filePath, 'utf-8');
      } catch (_) {
        oldContent = '';
      }
    }

    fs.writeFileSync(filePath, content, encoding);
    const base = { result: `Written ${Buffer.byteLength(content, encoding)} bytes to ${filePath}` };
    if (!textEncoding) return base;
    return {
      ...base,
      oldContent,
      newContent: content,
      patch: _diffPatch(filePath, oldContent, content),
      ..._diffLineMarkers(oldContent, content),
    };
  },

  edit(input) {
    const filePath = path.resolve(ALLOWED_PATH, input.path || '');
    if (_isOutsideAllowed(filePath)) return { error: `path outside allowed zone: ${filePath}` };
    if (!fs.existsSync(filePath)) return { error: `File not found: ${filePath}` };

    const oldText = input.old_text ?? input.oldString;
    const newText = input.new_text ?? input.newString;
    if (typeof oldText !== 'string' || oldText.length === 0) {
      return { error: 'old_text is required and must be non-empty' };
    }
    if (typeof newText !== 'string') {
      return { error: 'new_text is required' };
    }

    const content = fs.readFileSync(filePath, 'utf-8');

    // Coincidencia exacta y determinista: si old_text no aparece o aparece más
    // de una vez, fallamos sin modificar nada. Reemplazar la primera ocurrencia
    // a ciegas es impredecible cuando el archivo tiene texto repetido.
    let firstIndex = -1;
    let count = 0;
    let searchFrom = 0;
    while (true) {
      const idx = content.indexOf(oldText, searchFrom);
      if (idx === -1) break;
      if (firstIndex === -1) firstIndex = idx;
      count += 1;
      searchFrom = idx + oldText.length;
    }

    if (count === 0) {
      return { error: `old_text no se encontró en ${filePath}. No se modificó nada.` };
    }
    if (count > 1) {
      return {
        error: `old_text aparece ${count} veces en ${filePath} — el reemplazo es ambiguo. No se modificó nada. Incluye más contexto alrededor para que coincida de forma única.`,
      };
    }

    const newContent =
      content.slice(0, firstIndex) + newText + content.slice(firstIndex + oldText.length);
    fs.writeFileSync(filePath, newContent, 'utf-8');
    return {
      result: `Edited ${filePath} (1 reemplazo exacto)`,
      oldContent: content,
      newContent,
      patch: _diffPatch(filePath, content, newContent),
      ..._diffLineMarkers(content, newContent),
    };
  },

  apply_patch(input) {
    const filePath = path.resolve(ALLOWED_PATH, input.path || '');
    if (_isOutsideAllowed(filePath)) return { error: `path outside allowed zone: ${filePath}` };
    if (!fs.existsSync(filePath)) return { error: `File not found: ${filePath}` };

    const content = fs.readFileSync(filePath, 'utf-8');

    let patched;
    try {
      patched = Diff.applyPatch(content, input.patch);
    } catch (e) {
      return {
        error: `El patch tiene mal el conteo de líneas en el header @@ -N,M +N,M @@ (no coincide con las líneas reales del hunk): ${e.message}. No se aplicó nada, el archivo sigue intacto.`,
      };
    }

    if (patched === false) {
      return {
        error: `El patch no coincide con el contenido actual de ${filePath} — el archivo pudo haber cambiado desde que se generó el patch, o el contexto está mal. No se aplicó nada, el archivo sigue intacto.`,
      };
    }

    fs.writeFileSync(filePath, patched, 'utf-8');
    return {
      result: `Patch applied to ${filePath}`,
      oldContent: content,
      newContent: patched,
      patch: _diffPatch(filePath, content, patched),
      ..._diffLineMarkers(content, patched),
    };
  },

  grep(input) {
    const pattern = input.pattern;
    if (!pattern) return { error: 'pattern required' };
    let regex;
    try {
      regex = new RegExp(pattern);
    } catch (e) {
      return { error: `regex inválido: ${e.message}` };
    }

    const base = path.resolve(ALLOWED_PATH, input.path || '.');
    if (_isOutsideAllowed(base)) return { error: `path outside allowed zone: ${base}` };
    if (!fs.existsSync(base)) return { error: `Path not found: ${base}` };

    const include = input.include ? _minimatchGlob(input.include) : null;
    const ignore = input.ignore || 'node_modules,.git,dist,build,.env,package-lock.json';
    const maxResults = Math.min(input.max_results || 50, 500);

    const files = _collectFiles(base, { ignore, includeMatcher: include, maxFiles: 4000 });
    const matches = [];
    for (const file of files) {
      if (matches.length >= maxResults) break;
      let content;
      try {
        content = fs.readFileSync(file, 'utf-8');
      } catch (e) {
        continue; // binarios o ilegibles
      }
      let m;
      while ((m = regex.exec(content)) !== null && matches.length < maxResults) {
        const lineStart = content.lastIndexOf('\n', m.index) + 1;
        const lineEnd = content.indexOf('\n', m.index);
        const line = content.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
        matches.push({
          path: path.relative(ALLOWED_PATH, file),
          line: content.slice(0, lineStart).split('\n').length,
          text: line.length > 300 ? line.slice(0, 300) + '…' : line,
        });
        if (regex.lastIndex === m.index) regex.lastIndex += 1;
        if (m[0] === '') break;
      }
    }
    if (matches.length === 0) return { result: { count: 0, matches: [] } };
    return { result: { count: matches.length, matches, truncated: matches.length >= maxResults } };
  },

  glob(input) {
    const pattern = input.pattern;
    if (!pattern) return { error: 'pattern required' };
    const base = path.resolve(ALLOWED_PATH, input.path || '.');
    if (_isOutsideAllowed(base)) return { error: `path outside allowed zone: ${base}` };
    if (!fs.existsSync(base)) return { error: `Path not found: ${base}` };

    const matcher = _minimatchGlob(pattern);
    const files = _collectFiles(base, { ignore: 'node_modules,.git,dist,build', maxFiles: 10000 });
    const matched = files.map((f) => path.relative(ALLOWED_PATH, f)).filter((rel) => matcher(rel));
    return { result: { count: matched.length, files: matched.slice(0, 200) } };
  },

  code_execution(input) {
    const code = input.code;
    const timeout = Math.min((input.timeout || 10) * 1000, MAX_CODE_TIMEOUT);
    if (!code) return { error: 'code required' };

    return new Promise((resolve) => {
      const sandboxArgs = _wrapSandbox(['python3', '-c', code]);
      const child = spawn(sandboxArgs[0], sandboxArgs.slice(1), {
        stdio: 'pipe',
        windowsHide: true,
        env: _safeChildEnv(),
      });
      const stdout = [];
      const stderr = [];
      let outSize = 0;
      let errSize = 0;
      let killed = false;

      child.stdout.on('data', (c) => {
        outSize += c.length;
        if (outSize <= MAX_EXEC_OUTPUT) stdout.push(c);
      });
      child.stderr.on('data', (c) => {
        errSize += c.length;
        if (errSize <= MAX_EXEC_OUTPUT) stderr.push(c);
      });

      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGKILL');
      }, timeout);

      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({
          result: {
            stdout: Buffer.concat(stdout).toString('utf-8'),
            stderr: Buffer.concat(stderr).toString('utf-8'),
            exitCode: null,
            signal: null,
            error: e.message,
          },
        });
      });

      child.on('close', (code_, signal) => {
        clearTimeout(timer);
        resolve({
          result: {
            stdout: Buffer.concat(stdout).toString('utf-8'),
            stderr: Buffer.concat(stderr).toString('utf-8'),
            exitCode: code_,
            signal: killed ? 'timeout' : signal || null,
            error: null,
          },
        });
      });
    });
  },

  /**
   * Obtiene el contenido de una URL como texto plano (sin navegador).
   * Ligero y barato — distinto de 'browser', que usa Playwright.
   */
  async webfetch(input) {
    if (!input.url) return { error: 'url required' };
    try {
      const res = await _httpGet(input.url);
      const text = _htmlToText(res.body);
      return {
        result: {
          url: res.finalUrl || input.url,
          statusCode: res.statusCode,
          contentType: res.contentType,
          truncated: res.truncated,
          text: wrapUntrusted(text.slice(0, MAX_WEB_BYTES)),
        },
      };
    } catch (e) {
      return { error: e.message };
    }
  },

  /** Búsqueda web ligera vía DuckDuckGo HTML (sin API key). */
  async websearch(input) {
    const query = input.query;
    if (!query) return { error: 'query required' };
    const max = Math.min(input.max_results || 5, 10);
    try {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const res = await _httpGet(url);
      const results = _parseDuckDuckGoHTML(res.body).slice(0, max);
      return { result: { query, results: wrapUntrustedItems(results) } };
    } catch (e) {
      return { error: e.message };
    }
  },
};

// ── Autenticación ───────────────────────────────────────────────────────────

// Comparación en tiempo constante — timingSafeEqual lanza si los buffers
// tienen longitud distinta, así que ese caso se resuelve aparte (la
// longitud de una API key no es secreta en sí misma, el contenido sí).
function _safeEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function _authenticate(headers) {
  if (!API_KEY) return true;
  // X-Api-Key (legacy, para compatibilidad con OpenClawBridge actual)
  const provided = headers['x-api-key'] || headers['X-Api-Key'] || '';
  if (provided && _safeEqual(provided, API_KEY)) return true;
  // Authorization: Bearer (estándar)
  const auth = headers['authorization'] || headers['Authorization'] || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match !== null && _safeEqual(match[1], API_KEY);
}

// ── HTTP Server ─────────────────────────────────────────────────────────────

function respond(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function handleTool(body) {
  const tool = body.tool;
  const input = body.input || {};

  const handler = HANDLERS[tool];
  if (!handler) return { error: `Unknown tool: ${tool}` };

  try {
    const result = await handler(input);
    _audit(tool, input, !result.error, result.error || 'ok');
    return result;
  } catch (e) {
    _audit(tool, input, false, e.message);
    return { error: e.message };
  }
}

const server = http.createServer((req, res) => {
  // Rate limit
  if (!_checkRateLimit()) {
    return respond(res, 429, { error: 'rate limit exceeded' });
  }

  // Health check (sin autenticación)
  if (req.method === 'GET' && req.url === '/health') {
    return respond(res, 200, {
      status: 'ok',
      sandbox: _sandboxEnabled ? 'bwrap' : 'disabled',
      sandboxReason: _sandboxEnabled ? null : _sandboxReason,
    });
  }

  // Autenticación
  if (!_authenticate(req.headers)) {
    return respond(res, 401, { error: 'unauthorized — invalid or missing API key' });
  }

  if (req.method === 'POST' && req.url === '/v1/tool') {
    let body = '';
    let bodySize = 0;

    req.on('data', (chunk) => {
      bodySize += chunk.length;
      if (bodySize > MAX_REQUEST_BODY) {
        req.destroy(new Error('request body too large'));
        return;
      }
      body += chunk;
    });

    req.on('end', () => {
      if (req.destroyed) return;
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        return respond(res, 400, { error: 'Invalid JSON' });
      }
      handleTool(parsed).then((result) => {
        if (result.error) respond(res, 400, result);
        else respond(res, 200, result);
      });
    });

    return;
  }

  respond(res, 404, { error: 'Not found' });
});

// ── Function: start/stop server programmatically ──────────────────────────

async function startServer(port = PORT) {
  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => {
      logger.info('openclaw-server', `escuchando en http://127.0.0.1:${port}`);
      logger.info('openclaw-server', `allowed path: ${ALLOWED_PATH}`);
      logger.info('openclaw-server', `auth: ${API_KEY ? 'enabled' : 'disabled'}`);
      resolve(server);
    });
    server.once('error', reject);
  });
}

async function stopServer() {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

// ── Graceful shutdown ───────────────────────────────────────────────────────

function _gracefulShutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000);
}

// Arrancar solo si es el entry point (no al ser importado como módulo)
if (require.main === module) {
  startServer(PORT).catch((e) => {
    logger.error('openclaw-server', `error al iniciar: ${e.message}`);
    process.exit(1);
  });
  process.on('SIGTERM', _gracefulShutdown);
  process.on('SIGINT', _gracefulShutdown);
}

// ── Exportar para testing ───────────────────────────────────────────────────
module.exports = {
  startServer,
  stopServer,
  _authenticate,
  _isOutsideAllowed,
  _isImmutablePath,
  _isBlockedCommand,
  _safeChildEnv,
  HANDLERS,
  handleTool,
  _checkRateLimit,
  _htmlToText,
  _parseDuckDuckGoHTML,
  _buildCommandArgs,
  _needsShellCommand,
  _hasBackgroundOperator,
  _extractNodeEvalScript,
  _scriptReadsStdin,
  _rewriteToolchainCommand,
  _wrapSandbox,
  _whichBin,
  sandboxEnabled: () => _sandboxEnabled,
  sandboxReason: () => _sandboxReason,
  TOOLCHAIN_BINDS: () => [...TOOLCHAIN_BINDS],
  API_KEY: () => API_KEY,
  ALLOWED_PATH: () => ALLOWED_PATH,
};
