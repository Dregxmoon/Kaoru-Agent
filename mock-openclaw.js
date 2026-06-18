/**
 * mock-openclaw.js — v3
 *
 * Fix v2 → v3:
 *   Bug commit — git commit -m "mensaje con espacios" se rompía en Windows
 *                porque cmd /c no maneja bien las comillas dobles.
 *                Solución: parsear el comando en args y usar spawnSync
 *                sin shell cuando es posible, o escapar comillas para cmd.
 *
 *   Bug read   — content.slice(0, 8000) truncaba archivos grandes.
 *                Eliminado el límite — se devuelve el archivo completo.
 *
 * Fixes anteriores mantenidos:
 *   Bug 3  — exec captura stdout+stderr reales
 *   Bug 11 — UTF-8 en stdout del servidor y execSync
 *   Bug 12 — siempre corre desde el directorio del proyecto
 */

'use strict';

const http = require('http');
const { spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const PROJECT_CWD = process.cwd();
console.log(`[mock] CWD del proyecto: ${PROJECT_CWD}`);

const PORT = 18789;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Parsea un comando string en [programa, ...args] para spawnSync.
 *
 * Maneja correctamente:
 *   git commit -m "mensaje con espacios"
 *   git push origin 7March
 *   npm install
 *
 * En Windows usamos cmd /c para compatibilidad con comandos built-in,
 * pero escapamos las comillas dobles dentro de argumentos -m "...".
 */
function buildSpawnArgs(command) {
  // Escapar comillas dobles dentro de -m "..." para cmd /c
  // cmd /c entiende "" como comilla literal dentro de una cadena entre comillas
  const escaped = command.replace(
    /(-m\s+)"((?:[^"\\]|\\.)*)"/g,
    (_, flag, msg) => `${flag}"${msg.replace(/"/g, '""')}"`
  );
  return escaped;
}

// ── Herramientas ──────────────────────────────────────────────────────────────

const TOOLS = {

exec: (input) => {
  const { command, cwd, timeout } = input;

  const BLOCKED = /\brm\s+-rf?\b|\bdel\s+\/[sqf]|\bformat\b|\bshutdown\b|\breboot\b|\bpoweroff\b/i;
  if (BLOCKED.test(command)) {
    return { result: '', error: `[mock] comando bloqueado: ${command}` };
  }

  const workDir = cwd || PROJECT_CWD;

  // Parsear el comando en tokens respetando comillas dobles y simples
  function parseArgs(cmd) {
    const args = [];
    let current = '';
    let inDouble = false;
    let inSingle = false;
    for (let i = 0; i < cmd.length; i++) {
      const c = cmd[i];
      if (c === '"' && !inSingle)  { inDouble = !inDouble; continue; }
      if (c === "'" && !inDouble)  { inSingle = !inSingle; continue; }
      if (c === ' ' && !inDouble && !inSingle) {
        if (current) { args.push(current); current = ''; }
        continue;
      }
      current += c;
    }
    if (current) args.push(current);
    return args;
  }

  const args    = parseArgs(command);
  const program = args.shift(); // "git"

  console.log(`[mock] exec: ${program} ${JSON.stringify(args)}`);

  try {
    const result = spawnSync(program, args, {
      cwd:      workDir,
      timeout:  (timeout || 30) * 1000,
      encoding: 'utf8',
      env:      { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });

    const stdout = (result.stdout || '').trim();
    const stderr = (result.stderr || '').trim();
    const code   = result.status ?? 0;

    console.log(`[mock] exec resultado: code=${code}`);

    if (result.error) return { result: '', error: result.error.message };

    if (code !== 0 && !stdout) {
      return { result: stderr || '', error: `Comando salió con código ${code}${stderr ? ': ' + stderr : ''}` };
    }

    const output = [stdout, stderr].filter(Boolean).join('\n--- stderr ---\n');
    return { result: output || `(sin salida, código ${code})` };

  } catch(e) {
    return { result: '', error: e.message };
  }
},

  web_search: (input) => {
    const { query, max_results = 5 } = input;
    console.log(`[mock] web_search: "${query}"`);
    return {
      result: [
        {
          title:   `Resultados para: ${query}`,
          url:     `https://google.com/search?q=${encodeURIComponent(query)}`,
          snippet: `[Mock] Búsqueda simulada para "${query}". En producción aparecerían resultados reales.`,
        },
        {
          title:   `${query} — Wikipedia`,
          url:     `https://es.wikipedia.org/wiki/${encodeURIComponent(query)}`,
          snippet: `[Mock] Artículo sobre ${query}.`,
        },
      ].slice(0, max_results),
    };
  },

  // Fix: sin límite de tamaño — devuelve el archivo completo
  read: (input) => {
    const { path: filePath } = input;
    try {
      const resolved = path.resolve(PROJECT_CWD, filePath);
      const content  = fs.readFileSync(resolved, { encoding: 'utf8' });
      console.log(`[mock] read: "${filePath}" → ${content.length} chars`);
      return { result: content }; // sin slice — archivo completo
    } catch(e) {
      return { result: '', error: `No se pudo leer ${filePath}: ${e.message}` };
    }
  },

  write: (input) => {
    const { path: filePath, content } = input;
    try {
      const resolved = path.resolve(PROJECT_CWD, filePath);
      if (!resolved.startsWith(PROJECT_CWD)) {
        return { result: '', error: '[mock] escritura fuera del workspace bloqueada' };
      }
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, content, { encoding: 'utf8' });
      console.log(`[mock] write: "${filePath}" → ${content.length} chars`);
      return { result: `Archivo escrito: ${filePath} (${content.length} chars)` };
    } catch(e) {
      return { result: '', error: e.message };
    }
  },

  browser: (input) => {
    const { action, url } = input;
    console.log(`[mock] browser: ${action} ${url || ''}`);
    return { result: `[Mock] browser "${action}"${url ? ' → ' + url : ''} simulado.` };
  },

  edit: (input) => {
    const { path: filePath, old_text, new_text } = input;
    try {
      const resolved = path.resolve(PROJECT_CWD, filePath);
      let content    = fs.readFileSync(resolved, 'utf8');
      if (!content.includes(old_text)) {
        return { result: '', error: `Texto no encontrado en ${filePath}` };
      }
      content = content.replace(old_text, new_text);
      fs.writeFileSync(resolved, content, 'utf8');
      return { result: `Editado: ${filePath}` };
    } catch(e) {
      return { result: '', error: e.message };
    }
  },

  code_execution: (input) => {
    const { code, timeout = 10 } = input;
    const tmp = path.join(require('os').tmpdir(), `march_code_${Date.now()}.py`);
    try {
      fs.writeFileSync(tmp, code, 'utf8');
      const result = spawnSync('python', [tmp], {
        cwd:      PROJECT_CWD,
        timeout:  timeout * 1000,
        encoding: 'utf8',
        env:      { ...process.env, PYTHONIOENCODING: 'utf-8' },
      });
      return { result: (result.stdout || '').trim() || (result.stderr || '').trim() };
    } catch(e) {
      return { result: '', error: e.message };
    } finally {
      try { fs.unlinkSync(tmp); } catch(_) {}
    }
  },
};

// ── Servidor HTTP ─────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', version: 'mock-3.0', tools: Object.keys(TOOLS), cwd: PROJECT_CWD }));
    return;
  }

  if (req.method === 'POST' && req.url === '/v1/tool') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        const { tool, input } = JSON.parse(body);
        console.log(`\n[mock] ← ${tool}`, JSON.stringify(input).slice(0, 200));

        const handler = TOOLS[tool];
        if (!handler) {
          res.writeHead(400);
          res.end(JSON.stringify({ result: '', error: `Herramienta desconocida: ${tool}` }));
          return;
        }

        const toolResult = handler(input);
        console.log(`[mock] → ${tool}:`, JSON.stringify(toolResult).slice(0, 200));

        res.writeHead(200);
        res.end(JSON.stringify(toolResult));

      } catch(e) {
        console.error('[mock] error:', e.message);
        res.writeHead(500);
        res.end(JSON.stringify({ result: '', error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n╔═══════════════════════════════════════════╗`);
  console.log(`║   Mock OpenClaw v3 corriendo en :${PORT}   ║`);
  console.log(`╠═══════════════════════════════════════════╣`);
  console.log(`║  CWD: ${PROJECT_CWD.slice(0, 35).padEnd(35)} ║`);
  console.log(`╠═══════════════════════════════════════════╣`);
  console.log(`║  Fixes aplicados:                         ║`);
  console.log(`║   ✓ Bug commit — comillas en cmd /c       ║`);
  console.log(`║   ✓ Bug read   — sin truncado de archivos ║`);
  console.log(`║   ✓ Bug 3      — stdout/stderr reales     ║`);
  console.log(`║   ✓ Bug 11     — UTF-8 encoding correcto  ║`);
  console.log(`║   ✓ Bug 12     — CWD fijo al proyecto     ║`);
  console.log(`╚═══════════════════════════════════════════╝\n`);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`❌ Puerto ${PORT} ocupado.`);
  else console.error('❌ Error:', e.message);
});