'use strict';

const http = require('http');
const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const Diff = require('diff');

const PORT = 18789;

function respond(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const HANDLERS = {

  exec(input) {
    const command = input.command;
    const cwd = input.cwd || process.cwd();
    const timeout = (input.timeout || 15) * 1000;
    if (!command) return { error: 'command required' };

    const r = spawnSync(command, [], {
      cwd, timeout,
      stdio: 'pipe',
      shell: true,
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024,
    });

    return {
      result: {
        stdout: r.stdout || '',
        stderr: r.stderr || '',
        exitCode: r.status,
        signal: r.signal,
        error: r.error ? r.error.message : null,
      },
    };
  },

  read(input) {
    const filePath = path.resolve(input.path);
    if (!fs.existsSync(filePath)) return { error: `File not found: ${filePath}` };

    const content = fs.readFileSync(filePath, input.encoding || 'utf-8');
    return { result: content };
  },

  write(input) {
    const filePath = path.resolve(input.path);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(filePath, input.content, input.encoding || 'utf-8');
    return { result: `Written ${Buffer.byteLength(input.content, input.encoding || 'utf-8')} bytes to ${filePath}` };
  },

  edit(input) {
    const filePath = path.resolve(input.path);
    if (!fs.existsSync(filePath)) return { error: `File not found: ${filePath}` };

    const content = fs.readFileSync(filePath, 'utf-8');
    if (!content.includes(input.old_text)) {
      return { error: 'old_text not found in file' };
    }

    const newContent = content.replace(input.old_text, input.new_text);
    fs.writeFileSync(filePath, newContent, 'utf-8');
    return { result: `Edited ${filePath}` };
  },

  apply_patch(input) {
    const filePath = path.resolve(input.path);
    if (!fs.existsSync(filePath)) return { error: `File not found: ${filePath}` };

    const content = fs.readFileSync(filePath, 'utf-8');

    // FIX (revisión con Claude): el motor anterior aplicaba el patch por
    // número de línea (oldStart) SIN comparar que las líneas que dice
    // borrar fueran las que de verdad están ahí — si el LLM se equivocaba
    // en el número de línea (algo común), esto corrompía el archivo en
    // silencio. Diff.applyPatch verifica el contexto real contra el
    // archivo antes de tocar nada.
    //
    // Dos formas distintas de fallar, dos mensajes distintos: si el
    // CONTENIDO no coincide (líneas de contexto/borrado distintas a lo
    // real), devuelve \`false\`. Si los CONTEOS del header @@ -N,M +N,M @@
    // no cuadran con el número real de líneas del hunk (el LLM cuenta mal
    // seguido), la librería lanza una excepción en vez de devolver false
    // — se captura aparte para dar un mensaje que March pueda entender y
    // usar para reintentar, en vez del error crudo del parser.
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

  code_execution(input) {
    const code = input.code;
    const timeout = (input.timeout || 10) * 1000;
    if (!code) return { error: 'code required' };

    const r = spawnSync('python3', ['-c', code], {
      timeout,
      stdio: 'pipe',
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024,
    });

    return {
      result: {
        stdout: r.stdout || '',
        stderr: r.stderr || '',
        exitCode: r.status,
        signal: r.signal,
        error: r.error ? r.error.message : null,
      },
    };
  },
};

function handleTool(body) {
  const tool = body.tool;
  const input = body.input || {};

  const handler = HANDLERS[tool];
  if (!handler) return { error: `Unknown tool: ${tool}` };

  try {
    return handler(input);
  } catch (e) {
    return { error: e.message };
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    respond(res, 200, { status: 'ok' });
    return;
  }

  if (req.method === 'POST' && req.url === '/v1/tool') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch { respond(res, 400, { error: 'Invalid JSON' }); return; }
      const result = handleTool(parsed);
      if (result.error) respond(res, 400, result);
      else respond(res, 200, result);
    });
    return;
  }

  respond(res, 404, { error: 'Not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[openclaw-server] escuchando en http://127.0.0.1:${PORT}`);
});

function _gracefulShutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000); // force exit si el cierre no se completa
}
process.on('SIGTERM', _gracefulShutdown);
process.on('SIGINT', _gracefulShutdown);
