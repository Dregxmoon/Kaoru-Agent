'use strict';

const http = require('http');
const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

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
    const hunks = input.patch.split(/(?=@@ )/);

    let patched = content;
    for (const hunk of hunks) {
      const lines = hunk.split('\n');
      const header = lines[0];
      const m = header.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!m) continue;

      const oldStart = parseInt(m[1], 10);
      const oldLines = parseInt(m[2] || '1', 10);
      const newStart = parseInt(m[3], 10);

      const oldLines_arr = [];
      const newLines_arr = [];
      let i = 1;
      for (; i < lines.length; i++) {
        const l = lines[i];
        if (l.startsWith('-')) oldLines_arr.push(l.slice(1));
        else if (l.startsWith('+')) newLines_arr.push(l.slice(1));
        else if (l.startsWith(' ')) {
          oldLines_arr.push(l.slice(1));
          newLines_arr.push(l.slice(1));
        }
      }

      const contentLines = patched.split('\n');
      const before = contentLines.slice(0, oldStart - 1);
      const after = contentLines.slice(oldStart - 1 + oldLines_arr.length);
      patched = [...before, ...newLines_arr, ...after].join('\n');
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

process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
process.on('SIGINT', () => { server.close(() => process.exit(0)); });
