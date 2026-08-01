'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const LSP_SERVERS = {
  typescript: {
    command: 'npx',
    args: ['-y', 'typescript-language-server', '--stdio'],
    languageId: 'typescript',
    filePatterns: ['.ts', '.tsx'],
  },
  javascript: {
    command: 'npx',
    args: ['-y', 'typescript-language-server', '--stdio'],
    languageId: 'javascript',
    filePatterns: ['.js', '.jsx', '.mjs'],
  },
};

// Timeout por request JSON-RPC: si el server se cuelga (o muere sin avisar),
// la promesa debe resolverse como fallo en vez de quedar colgada para siempre.
// Antes no había timeout: un `_request` sin respuesta dejaba la promesa en el
// aire y `_pending` crecía sin límite — error silencioso de Fase D.
const REQUEST_TIMEOUT_MS = 20_000;

class LSPManager {
  constructor() {
    this._process = null;
    this._requestId = 1;
    this._pending = new Map();
    this._buffer = '';
    this._capabilities = null;
    this._diagnostics = new Map();
    this._serverConfig = null;
    this._workspacePath = null;
    this._started = false;
    this._restartTimer = null;
    // Fase D: documentos ya abiertos en el server (uri → versión), para no
    // re-enviar didOpen sin necesidad y poder versionar los didChange.
    this._openedDocs = new Map();
  }

  get isRunning() {
    return this._process !== null && this._started;
  }

  get supportedFilePatterns() {
    if (!this._serverConfig) return [];
    return this._serverConfig.filePatterns || [];
  }

  async start(workspacePath, language = null) {
    if (this.isRunning) {
      await this.stop();
    }

    // Fase D: elegir el servidor según el contenido del workspace, no a ciegas
    // (antes se asumía typescript siempre, incluso para repos de otros lenguajes).
    const resolvedLanguage = language || LSPManager.detectLanguageForWorkspace(workspacePath);
    const config = LSP_SERVERS[resolvedLanguage] || LSP_SERVERS.typescript;
    this._serverConfig = config;
    this._workspacePath = path.resolve(workspacePath);

    if (!fs.existsSync(this._workspacePath)) {
      throw new Error(`Workspace path does not exist: ${this._workspacePath}`);
    }

    return new Promise((resolve, reject) => {
      try {
        this._process = spawn(config.command, config.args, {
          cwd: this._workspacePath,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env },
        });

        let started = false;

        this._process.stdout.on('data', (data) => {
          this._buffer += data.toString();
          this._processBuffer();
        });

        this._process.stderr.on('data', (data) => {
          const msg = data.toString().trim();
          if (msg) console.log('[lsp]', msg);
        });

        this._process.on('exit', (code) => {
          console.log(`[lsp] proceso terminado (código ${code})`);
          this._process = null;
          this._started = false;
          this._rejectAllPending(`LSP server exited with code ${code}`);
          if (code !== 0 && code !== null) {
            this._scheduleRestart();
          }
        });

        this._process.on('error', (err) => {
          console.error(`[lsp] error de proceso: ${err.message}`);
          this._process = null;
          this._started = false;
          this._rejectAllPending(err.message);
        });

        // Send initialize request
        this._request('initialize', {
          processId: process.pid,
          rootUri: `file://${this._workspacePath}`,
          rootPath: this._workspacePath,
          capabilities: {
            textDocument: {
              synchronization: { didSave: true },
              diagnostic: { relatedDocumentSupport: false },
              // Fase D: declarar soporte de publishDiagnostics activa el push
              // de diagnósticos en typescript-language-server (si no, la
              // configura `features.diagnosticsSupport=false` y nunca envía
              // errores — error silencioso detectado en la verificación en vivo).
              publishDiagnostics: { relatedInformation: true },
            },
            workspace: {
              symbol: {},
            },
          },
        }).then((result) => {
          this._capabilities = result.capabilities || {};
          // Send initialized notification
          this._notify('initialized', {});
          this._started = true;
          if (!started) { started = true; resolve(); }
        }).catch((err) => {
          if (!started) { started = true; reject(err); }
        });

        // Timeout safety
        setTimeout(() => {
          if (!started) {
            started = true;
            reject(new Error('LSP server did not initialize within 15s'));
            this.stop();
          }
        }, 15000);
      } catch (e) {
        reject(e);
      }
    });
  }

  async stop() {
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    if (!this._process) return;
    try {
      await this._request('shutdown', null);
    } catch (_) {}
    this._notify('exit', null);
    // `npx` re-ejecuta typescript-language-server en un hijo — matar npx no
    // basta. Recorremos /proc y matamos también a los descendientes.
    try {
      this._killTree(this._process.pid);
    } catch (_) {}
    this._process.kill();
    this._process = null;
    this._started = false;
    this._diagnostics.clear();
    this._openedDocs.clear();
  }

  _killTree(rootPid) {
    if (process.platform !== 'linux') return;
    const children = new Map();
    try {
      for (const entry of require('fs').readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        let ppid = -1;
        try {
          const stat = require('fs').readFileSync(`/proc/${entry}/stat`, 'utf-8');
          const close = stat.lastIndexOf(')');
          ppid = parseInt(stat.slice(close + 1).trim().split(/\s+/)[1], 10);
        } catch (_) {}
        if (!children.has(ppid)) children.set(ppid, []);
        children.get(ppid).push(parseInt(entry, 10));
      }
    } catch (_) { return; }
    const stack = [...(children.get(rootPid) || [])];
    while (stack.length) {
      const pid = stack.pop();
      try { process.kill(pid, 'SIGTERM'); } catch (_) {}
      stack.push(...(children.get(pid) || []));
    }
  }

  async openDocument(filePath) {
    const absPath = path.resolve(filePath);
    if (!fs.existsSync(absPath)) return;
    const uri = `file://${absPath}`;
    // Fase D: no re-enviar didOpen si el documento ya está abierto (muchos
    // servers lo toleran, pero reabrir resetea su estado del buffer).
    if (this._openedDocs.has(uri)) return;
    const ext = path.extname(absPath);
    const languageId = this._detectLanguage(ext);
    const content = fs.readFileSync(absPath, 'utf-8');

    this._openedDocs.set(uri, 1);
    this._notify('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId,
        version: 1,
        text: content,
      },
    });
  }

  async changeDocument(filePath, content, version = null) {
    const absPath = path.resolve(filePath);
    const uri = `file://${absPath}`;
    // Si el documento no estaba abierto, abrirlo con el contenido nuevo.
    if (!this._openedDocs.has(uri)) {
      const ext = path.extname(absPath);
      const languageId = this._detectLanguage(ext);
      this._openedDocs.set(uri, 1);
      this._notify('textDocument/didOpen', {
        textDocument: { uri, languageId, version: 1, text: content },
      });
      return;
    }
    // Fase D: versión incremental real — antes el version se quedaba en 2
    // para siempre y el server podía ignorar los didChange posteriores.
    const nextVersion = version ?? (this._openedDocs.get(uri) || 0) + 1;
    this._openedDocs.set(uri, nextVersion);
    this._notify('textDocument/didChange', {
      textDocument: { uri, version: nextVersion },
      contentChanges: [{ text: content }],
    });
  }

  /** Olvida un documento abierto (p.ej. al dejar de escanearlo). */
  closeDocument(filePath) {
    const uri = `file://${path.resolve(filePath)}`;
    if (!this._openedDocs.has(uri)) return;
    this._openedDocs.delete(uri);
    this._notify('textDocument/didClose', { textDocument: { uri } });
  }

  async getDiagnostics(filePath) {
    const absPath = path.resolve(filePath);
    const uri = `file://${absPath}`;

    // Ensure document is open
    await this.openDocument(filePath);

    // Request diagnostics via textDocument/diagnostic (if server supports pull diagnostics)
    // Fall back to tracked push diagnostics
    if (this._capabilities?.diagnosticProvider) {
      try {
        const result = await this._request('textDocument/diagnostic', {
          textDocument: { uri },
        });
        return result?.items || [];
      } catch (_) {}
    }

    // Push diagnostics: track from textDocument/publishDiagnostics notifications
    return this._diagnostics.get(uri) || [];
  }

  async goToDefinition(filePath, line, character) {
    const absPath = path.resolve(filePath);
    const uri = `file://${absPath}`;
    await this.openDocument(filePath);

    const result = await this._request('textDocument/definition', {
      textDocument: { uri },
      position: { line, character },
    });

    if (!result) return null;
    const locations = Array.isArray(result) ? result : [result];
    return locations.map(loc => ({
      uri: loc.uri,
      filePath: loc.uri ? decodeURIComponent(loc.uri.replace(/^file:\/\//, '')) : null,
      range: loc.range,
      line: loc.range?.start?.line,
      character: loc.range?.start?.character,
    }));
  }

  async findReferences(filePath, line, character) {
    const absPath = path.resolve(filePath);
    const uri = `file://${absPath}`;
    await this.openDocument(filePath);

    const result = await this._request('textDocument/references', {
      textDocument: { uri },
      position: { line, character },
      context: { includeDeclaration: true },
    });

    if (!result) return [];
    return result.map(loc => ({
      uri: loc.uri,
      filePath: loc.uri ? decodeURIComponent(loc.uri.replace(/^file:\/\//, '')) : null,
      range: loc.range,
      line: loc.range?.start?.line,
      character: loc.range?.start?.character,
    }));
  }

  async getDocumentSymbols(filePath) {
    const absPath = path.resolve(filePath);
    const uri = `file://${absPath}`;
    await this.openDocument(filePath);

    const result = await this._request('textDocument/documentSymbol', {
      textDocument: { uri },
    });

    if (!result) return [];
    return result.map(sym => ({
      name: sym.name,
      kind: sym.kind,
      kindName: this._symbolKindName(sym.kind),
      detail: sym.detail || '',
      range: sym.range,
      selectionRange: sym.selectionRange,
      children: sym.children,
    }));
  }

  async getWorkspaceSymbols(query) {
    const result = await this._request('workspace/symbol', { query });
    if (!result) return [];
    return result.map(sym => ({
      name: sym.name,
      kind: sym.kind,
      kindName: this._symbolKindName(sym.kind),
      location: sym.location,
      filePath: sym.location?.uri ? decodeURIComponent(sym.location.uri.replace(/^file:\/\//, '')) : null,
    }));
  }

  // ── JSON-RPC internals ───────────────────────────────────────────────

  _request(method, params) {
    return new Promise((resolve, reject) => {
      const id = this._requestId++;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`LSP request "${method}" timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);
      this._pending.set(id, { resolve, reject, method, timer });
      this._send({ jsonrpc: '2.0', id, method, params });
    });
  }

  _notify(method, params) {
    this._send({ jsonrpc: '2.0', method, params });
  }

  _send(message) {
    if (!this._process || !this._process.stdin.writable) return;
    const body = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(body, 'utf-8')}\r\n\r\n`;
    this._process.stdin.write(header + body);
  }

  _processBuffer() {
    const idx = this._buffer.indexOf('\r\n\r\n');
    if (idx === -1) return;

    const headerPart = this._buffer.slice(0, idx);
    const match = headerPart.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      this._buffer = '';
      return;
    }

    const contentLength = parseInt(match[1], 10);
    const bodyStart = idx + 4;
    if (this._buffer.length < bodyStart + contentLength) return;

    const body = this._buffer.slice(bodyStart, bodyStart + contentLength);
    this._buffer = this._buffer.slice(bodyStart + contentLength);

    try {
      const msg = JSON.parse(body);
      this._handleMessage(msg);
    } catch (_) {}

    // Process remaining buffer
    if (this._buffer.includes('\r\n\r\n')) {
      this._processBuffer();
    }
  }

  _handleMessage(msg) {
    // Response to a request
    if (msg.id !== undefined && msg.id !== null) {
      const pending = this._pending.get(msg.id);
      if (pending) {
        this._pending.delete(msg.id);
        if (pending.timer) clearTimeout(pending.timer);
        if (msg.error) {
          pending.reject(new Error(msg.error.message || 'LSP error'));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    // Notification
    if (msg.method === 'textDocument/publishDiagnostics') {
      const uri = msg.params?.uri;
      const diagnostics = msg.params?.diagnostics || [];
      this._diagnostics.set(uri, diagnostics);
    }
  }

  _rejectAllPending(reason) {
    for (const [id, pending] of this._pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this._pending.clear();
  }

  _scheduleRestart() {
    if (this._restartTimer) return;
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      if (!this.isRunning && this._workspacePath && this._serverConfig) {
        console.log('[lsp] reiniciando servidor...');
        this.start(this._workspacePath, this._getLanguageKey()).catch(e => {
          console.warn('[lsp] error en reinicio:', e.message);
        });
      }
    }, 2000);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Elige el lenguaje/servidor LSP según lo que hay en el workspace:
   *   - tsconfig.json o TS como dependencia → typescript
   *   - de lo contrario → javascript (typescript-language-server sirve ambos)
   */
  static detectLanguageForWorkspace(ws) {
    try {
      const root = path.resolve(ws);
      if (fs.existsSync(path.join(root, 'tsconfig.json'))) return 'typescript';
      const pkgPath = path.join(root, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
        const hasTS = Object.keys(deps).some(d => /^typescript(@|$)/.test(d) || d.startsWith('@types/'));
        if (hasTS) return 'typescript';
      }
    } catch(_) {}
    return 'javascript';
  }

  _detectLanguage(ext) {
    if (this._serverConfig) return this._serverConfig.languageId;
    const map = { '.ts': 'typescript', '.tsx': 'typescriptreact', '.js': 'javascript', '.jsx': 'javascriptreact', '.mjs': 'javascript' };
    return map[ext] || 'plaintext';
  }

  _getLanguageKey() {
    for (const [key, cfg] of Object.entries(LSP_SERVERS)) {
      if (cfg.command === this._serverConfig?.command) return key;
    }
    return 'typescript';
  }

  _symbolKindName(kind) {
    const names = {
      1: 'File', 2: 'Module', 3: 'Namespace', 4: 'Package', 5: 'Class',
      6: 'Method', 7: 'Property', 8: 'Field', 9: 'Constructor', 10: 'Enum',
      11: 'Interface', 12: 'Function', 13: 'Variable', 14: 'Constant',
      15: 'String', 16: 'Number', 17: 'Boolean', 18: 'Array',
      19: 'Object', 20: 'Key', 21: 'Null', 22: 'EnumMember',
      23: 'Struct', 24: 'Event', 25: 'Operator', 26: 'TypeParameter',
    };
    return names[kind] || `Kind_${kind}`;
  }
}

let _instance = null;
function getLSPManager() {
  if (!_instance) _instance = new LSPManager();
  return _instance;
}

module.exports = { LSPManager, getLSPManager };
