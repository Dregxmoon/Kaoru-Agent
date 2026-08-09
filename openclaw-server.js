// @ts-nocheck
'use strict';

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const Diff = require('diff');
const crypto = require('crypto');
const { dirSet } = require('./core/utils/ignoreDirs.js');

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
  console.error('[openclaw-server] OPENCLAW_API_KEY no definida — abortando');
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
  console.log(`[audit] ${entry.ts} ${tool} ${status} — ${detail}`);
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
  return safeChildEnv();
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

// ── Rutas inmutablemente protegidas (nunca accesibles) ─────────────────────

const IMMUTABLE_PATH_PATTERNS = [
  /[\\/]\.ssh[\\/]/i,
  /[\\/]id_rsa$/i,
  /[\\/]id_ed25519$/i,
  /\.pem$/i,
  /\.pfx$/i,
  /\.key$/i,
  /[\\/]\.aws[\\/]/i,
  /\.env(\.|$)/i,
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

function _isImmutablePath(filePath) {
  return IMMUTABLE_PATH_PATTERNS.some((re) => re.test(filePath));
}

// Realpath del ancestro existente más cercano a `p` (para rutas de archivos
// que aún no existen, p.ej. al escribir uno nuevo), manteniendo el resto
// del path como sufijo literal. Cierra la vía de escape por symlink: si un
// directorio intermedio es un symlink hacia fuera de ALLOWED_PATH, el realpath
// lo resuelve y _isOutsideAllowed lo detecta.
function _realpathNearest(p) {
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

function _isOutsideAllowed(filePath) {
  try {
    const resolved = path.resolve(filePath);
    if (_isImmutablePath(resolved)) return true;
    const realResolved = _realpathNearest(resolved);
    if (_isImmutablePath(realResolved)) return true;
    const realAllowed = _realpathNearest(ALLOWED_PATH);
    const rel = path.relative(realAllowed, realResolved);
    return rel.startsWith('..') || path.isAbsolute(rel);
  } catch {
    return true;
  }
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

function _httpGet(urlString, redirectsLeft = 3) {
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

    const args = _buildCommandArgs(command);
    if (args.length === 0) return { error: 'empty command after parsing' };

    // Async con spawn (no spawnSync): un comando largo NO bloquea el proceso
    // main ni el event loop del server (antes congelaba la app entera).
    return new Promise((resolve) => {
      const child = spawn(args[0], args.slice(1), {
        cwd,
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

    fs.writeFileSync(filePath, input.content, input.encoding || 'utf-8');
    return {
      result: `Written ${Buffer.byteLength(input.content, input.encoding || 'utf-8')} bytes to ${filePath}`,
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
    return { result: `Edited ${filePath} (1 reemplazo exacto)` };
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
    return { result: `Patch applied to ${filePath}` };
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
      const child = spawn('python3', ['-c', code], {
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
    return respond(res, 200, { status: 'ok' });
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
      console.log(`[openclaw-server] escuchando en http://127.0.0.1:${port}`);
      console.log(`[openclaw-server] allowed path: ${ALLOWED_PATH}`);
      console.log(`[openclaw-server] auth: ${API_KEY ? 'enabled' : 'disabled'}`);
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
    console.error('[openclaw-server] error al iniciar:', e.message);
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
  API_KEY: () => API_KEY,
  ALLOWED_PATH: () => ALLOWED_PATH,
};
