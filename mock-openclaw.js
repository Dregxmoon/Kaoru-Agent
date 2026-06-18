/**
 * mock-openclaw.js
 * Servidor mock de OpenClaw para probar Fase 3 sin el gateway real.
 * Corre en localhost:18789 y simula las herramientas: exec, web_search, read, write, browser.
 *
 * Uso: node mock-openclaw.js
 */

const http = require('http');
const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const PORT = 18789;

// ── Implementaciones reales de las herramientas ───────────────────────────────

const TOOLS = {

  // exec — ejecuta comandos shell REALES (solo comandos de lectura por seguridad)
  exec: (input) => {
    const { command, cwd, timeout } = input;

    // Bloquear comandos destructivos en el mock
    const BLOCKED = /\brm\b|\bdel\b|\bformat\b|\bshutdown\b|\breboot\b/i;
    if (BLOCKED.test(command)) {
      return { error: `[mock] comando bloqueado por seguridad: ${command}` };
    }

    try {
      const result = execSync(command, {
        cwd:      cwd || process.cwd(),
        timeout:  (timeout || 15) * 1000,
        encoding: 'utf-8',
      });
      return { result: result.trim() || '(sin salida)' };
    } catch(e) {
      return { result: e.stdout?.trim() || '', error: e.message };
    }
  },

  // web_search — simulado (devuelve resultados fake pero realistas)
  web_search: (input) => {
    const { query, max_results = 5 } = input;
    console.log(`[mock] web_search: "${query}"`);
    return {
      result: [
        {
          title:   `Resultados para: ${query}`,
          url:     `https://google.com/search?q=${encodeURIComponent(query)}`,
          snippet: `[Mock] Esta es una búsqueda simulada para "${query}". ` +
                   `En producción aquí aparecerían los resultados reales de la web.`,
        },
        {
          title:   `${query} — Wikipedia`,
          url:     `https://es.wikipedia.org/wiki/${encodeURIComponent(query)}`,
          snippet: `[Mock] Artículo de Wikipedia sobre ${query}.`,
        },
      ].slice(0, max_results),
    };
  },

  // read — lee archivos REALES del workspace
  read: (input) => {
    const { path: filePath, encoding = 'utf-8' } = input;
    try {
      // Resolver relativo al directorio del proyecto
      const resolved = path.resolve(process.cwd(), filePath);
      const content  = fs.readFileSync(resolved, encoding);
      return { result: content.slice(0, 8000) }; // truncar a 8KB
    } catch(e) {
      return { error: `No se pudo leer ${filePath}: ${e.message}` };
    }
  },

  // write — escribe archivos REALES (solo en el workspace)
  write: (input) => {
    const { path: filePath, content, encoding = 'utf-8' } = input;
    try {
      const resolved = path.resolve(process.cwd(), filePath);
      // Solo permitir escribir dentro del workspace
      if (!resolved.startsWith(process.cwd())) {
        return { error: '[mock] escritura fuera del workspace bloqueada' };
      }
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, content, encoding);
      return { result: `Archivo escrito: ${filePath} (${content.length} chars)` };
    } catch(e) {
      return { error: `No se pudo escribir ${filePath}: ${e.message}` };
    }
  },

  // browser — simulado
  browser: (input) => {
    const { action, url, selector } = input;
    console.log(`[mock] browser: ${action} ${url || selector || ''}`);
    return {
      result: `[Mock] Acción browser "${action}" simulada.` +
              (url ? ` URL: ${url}` : '') +
              ` En producción aquí se controlaría el navegador real.`,
    };
  },

  // edit — edita archivos REALES
  edit: (input) => {
    const { path: filePath, old_text, new_text } = input;
    try {
      const resolved = path.resolve(process.cwd(), filePath);
      let content    = fs.readFileSync(resolved, 'utf-8');
      if (!content.includes(old_text)) {
        return { error: `Texto no encontrado en ${filePath}` };
      }
      content = content.replace(old_text, new_text);
      fs.writeFileSync(resolved, content, 'utf-8');
      return { result: `Editado: ${filePath}` };
    } catch(e) {
      return { error: e.message };
    }
  },

  // code_execution — ejecuta Python REAL
  code_execution: (input) => {
    const { code, timeout = 10 } = input;
    const tmp = path.join(require('os').tmpdir(), `march_code_${Date.now()}.py`);
    try {
      fs.writeFileSync(tmp, code, 'utf-8');
      const result = execSync(`python "${tmp}"`, {
        timeout: timeout * 1000,
        encoding: 'utf-8',
      });
      return { result: result.trim() };
    } catch(e) {
      return { result: e.stdout?.trim() || '', error: e.message };
    } finally {
      try { fs.unlinkSync(tmp); } catch(_) {}
    }
  },
};

// ── Servidor HTTP ─────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', version: 'mock-1.0', tools: Object.keys(TOOLS) }));
    return;
  }

  // Ejecutar herramienta
  if (req.method === 'POST' && req.url === '/v1/tool') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { tool, input } = JSON.parse(body);
        console.log(`\n[mock] ← ${tool}`, JSON.stringify(input).slice(0, 120));

        const handler = TOOLS[tool];
        if (!handler) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: `Herramienta desconocida: ${tool}` }));
          return;
        }

        const result = handler(input);
        console.log(`[mock] → ${tool}:`, JSON.stringify(result).slice(0, 120));

        res.writeHead(200);
        res.end(JSON.stringify(result));

      } catch(e) {
        console.error('[mock] error:', e.message);
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n╔═══════════════════════════════════════════╗`);
  console.log(`║   Mock OpenClaw corriendo en :${PORT}     ║`);
  console.log(`╠═══════════════════════════════════════════╣`);
  console.log(`║  Herramientas activas:                    ║`);
  console.log(`║   ✓ exec        (comandos reales)         ║`);
  console.log(`║   ✓ web_search  (simulado)                ║`);
  console.log(`║   ✓ read        (archivos reales)         ║`);
  console.log(`║   ✓ write       (archivos reales)         ║`);
  console.log(`║   ✓ browser     (simulado)                ║`);
  console.log(`║   ✓ edit        (archivos reales)         ║`);
  console.log(`║   ✓ code_exec   (Python real)             ║`);
  console.log(`╠═══════════════════════════════════════════╣`);
  console.log(`║  Health: http://localhost:${PORT}/health   ║`);
  console.log(`╚═══════════════════════════════════════════╝\n`);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`❌ Puerto ${PORT} ocupado. ¿Ya hay algo corriendo ahí?`);
  } else {
    console.error('❌ Error del servidor:', e.message);
  }
});