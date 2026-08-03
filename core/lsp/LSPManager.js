'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// ── Tabla de servidores LSP ──────────────────────────────────────────────
// G.1: la tabla de "qué servidor arrancar por lenguaje" vive en un JSON
// externo (infrastructure/lsp/servers.json), no en código. Cada entrada:
//   command/args          → cómo arrancar el server (los basados en npx se
//                           auto-instalan la primera vez, patrón ya usado por
//                           typescript-language-server).
//   languageId/filePatterns → qué lenguaje sirve y qué extensiones le tocan.
//   manifests             → qué archivos indican que el repo usa ese lenguaje.
//   installCmd            → guía/auto-instalación para los que no son npx.
const SERVERS_PATH = path.join(__dirname, '..', '..', 'infrastructure', 'lsp', 'servers.json');

let _serversCache = null;
function loadServersTable() {
  if (_serversCache) return _serversCache;
  try {
    _serversCache = JSON.parse(fs.readFileSync(SERVERS_PATH, 'utf-8'));
  } catch (e) {
    console.warn(`[lsp] no se pudo cargar la tabla de servidores (${SERVERS_PATH}):`, e.message);
    _serversCache = {};
  }
  return _serversCache;
}

// Timeout por request JSON-RPC: si el server se cuelga (o muere sin avisar),
// la promesa debe resolverse como fallo en vez de quedar colgada para siempre.
const REQUEST_TIMEOUT_MS = 20_000;

// ── Instancia individual (un proceso LSP por lenguaje) ─────────────────────
// G.1: antes LSPManager tenía UN solo _process. Ahora cada lenguaje vive en su
// propia instancia (repo Go + frontend TS = dos procesos en paralelo). Toda la
// maquinaria JSON-RPC de Fase D vive acá.
class _LSPInstance {
  constructor(serverConfig, languageKey) {
    this._languageKey = languageKey;
    this._serverConfig = serverConfig;
    this._process = null;
    this._requestId = 1;
    this._pending = new Map();
    this._buffer = '';
    this._capabilities = null;
    this._diagnostics = new Map();
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

  get languageId() {
    return this._serverConfig.languageId || this._languageKey;
  }

  start(workspacePath) {
    const config = this._serverConfig;
    this._workspacePath = path.resolve(workspacePath);

    if (!fs.existsSync(this._workspacePath)) {
      throw new Error(`Workspace path does not exist: ${this._workspacePath}`);
    }

    return new Promise((resolve, reject) => {
      let started = false;
      let proc;
      try {
        proc = spawn(config.command, config.args, {
          cwd: this._workspacePath,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env },
        });
      } catch (e) {
        reject(e);
        return;
      }

      this._process = proc;

      proc.on('error', (err) => {
        console.warn(`[lsp:${this._languageKey}] no se pudo lanzar ${config.command}: ${err.message}`);
        if (config.installCmd) {
          console.warn(`[lsp:${this._languageKey}] instalalo con: ${config.installCmd}`);
        }
        this._process = null;
        this._started = false;
        this._rejectAllPending(err.message);
        if (!started) { started = true; reject(err); }
      });

      proc.stdout.on('data', (data) => {
        this._buffer += data.toString();
        this._processBuffer();
      });

      proc.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) console.log(`[lsp:${this._languageKey}] ${msg}`);
      });

      proc.on('exit', (code) => {
        console.log(`[lsp:${this._languageKey}] proceso terminado (código ${code})`);
        this._process = null;
        this._started = false;
        this._rejectAllPending(`LSP server exited with code ${code}`);
        if (code !== 0 && code !== null) {
          this._scheduleRestart();
        }
      });

      // Send initialize request
      this._request('initialize', {
        processId: process.pid,
        rootUri: `file://${this._workspacePath}`,
        rootPath: this._workspacePath,
        workspaceFolders: [{ uri: `file://${this._workspacePath}`, name: path.basename(this._workspacePath) }],
        capabilities: {
          textDocument: {
            synchronization: { didSave: true },
            // G.1: NO declarar textDocument.diagnostic (pull) — pyright lo
            // interpreta como soporte pull y deja de enviar push (publishDiagnostics).
            // publicar solo publishDiagnostics activa el push en todos los servers.
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
    });
  }

  async stop() {
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    if (!this._process) return;
    try {
      // shutdown con timeout corto: pyright puede tardar en responder si está
      // ocupado analizando (typeshed) y no queremos bloquear el apagado 20s.
      await Promise.race([
        this._request('shutdown', null),
        new Promise(res => setTimeout(res, 2500)),
      ]);
    } catch (e) {
      console.warn(`[lsp:${this._languageKey}] shutdown request falló:`, e && e.message ? e.message : e);
    }
    this._notify('exit', null);
    // `npx` re-ejecuta el server en un hijo — matar npx no basta. Recorremos
    // /proc y matamos también a los descendientes.
    try {
      _killTree(this._process.pid);
    } catch (e) {
      console.warn(`[lsp:${this._languageKey}] killTree falló:`, e && e.message ? e.message : e);
    }
    try { this._process.kill(); }
    catch (e) { console.warn(`[lsp:${this._languageKey}] kill del proceso falló:`, e && e.message ? e.message : e); }
    this._process = null;
    this._started = false;
    this._diagnostics.clear();
    this._openedDocs.clear();
    // Cancela pendientes (p.ej. un shutdown que aún no respondió) y sus timers.
    this._rejectAllPending('LSP server stopped');
  }

  async openDocument(filePath) {
    const absPath = path.resolve(filePath);
    if (!fs.existsSync(absPath)) return;
    const uri = `file://${absPath}`;
    // Fase D: no re-enviar didOpen si el documento ya está abierto (muchos
    // servers lo toleran, pero reabrir resetea su estado del buffer).
    if (this._openedDocs.has(uri)) return;
    const content = fs.readFileSync(absPath, 'utf-8');

    this._openedDocs.set(uri, 1);
    this._notify('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: this.languageId,
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
      this._openedDocs.set(uri, 1);
      this._notify('textDocument/didOpen', {
        textDocument: { uri, languageId: this.languageId, version: 1, text: content },
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
      kindName: _symbolKindName(sym.kind),
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
      kindName: _symbolKindName(sym.kind),
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
      if (!this.isRunning && this._workspacePath) {
        console.log(`[lsp:${this._languageKey}] reiniciando servidor...`);
        this.start(this._workspacePath).catch(e => {
          console.warn(`[lsp:${this._languageKey}] error en reinicio:`, e.message);
        });
      }
    }, 2000);
  }
}

// ── LSPManager ──────────────────────────────────────────────────────────────
// G.1: gestiona N instancias (una por lenguaje). Las llamadas públicas
// enrutan por extensión de archivo a la instancia correcta.
class LSPManager {
  constructor() {
    this._instances = new Map();   // languageKey → _LSPInstance
    this._workspacePath = null;
    this._servers = loadServersTable();
  }

  get isRunning() {
    return [...this._instances.values()].some(i => i.isRunning);
  }

  get activeLanguages() {
    return [...this._instances.keys()];
  }

  get _serverConfig() {
    // Compat: LSPErrorWatcher lee `_lsp._serverConfig?.languageId`.
    const primary = this._primaryInstance();
    return primary ? primary._serverConfig : null;
  }

  get supportedFilePatterns() {
    const all = [];
    for (const inst of this._instances.values()) {
      for (const p of (inst._serverConfig.filePatterns || [])) {
        if (!all.includes(p)) all.push(p);
      }
    }
    return all;
  }

  _primaryInstance() {
    return this._instances.values().next().value || null;
  }

  _languageForFile(filePath) {
    const ext = path.extname(String(filePath)).toLowerCase();
    if (ext) {
      for (const [key, inst] of this._instances) {
        if ((inst._serverConfig.filePatterns || []).includes(ext)) return inst;
      }
    }
    return this._primaryInstance();
  }

  _startInstance(languageKey, workspacePath) {
    const config = this._servers[languageKey];
    if (!config) return null;
    const inst = new _LSPInstance(config, languageKey);
    this._instances.set(languageKey, inst);
    inst.start(workspacePath).catch((e) => {
      console.warn(`[lsp:${languageKey}] no disponible:`, e.message);
      this._instances.delete(languageKey);
    });
    return inst;
  }

  /**
   * Arranca los servidores del workspace. Sin `language` explícito detecta por
   * manifiesto (G.1): package.json/tsconfig → JS/TS; pyproject.toml →
   * Python; go.mod → Go; etc. La primera instancia es la primaria y su
   * arranque se espera; el resto corre en background sin romper.
   */
  async start(workspacePath, language = null) {
    await this.stop();

    const resolved = path.resolve(workspacePath);
    this._workspacePath = resolved;
    if (!fs.existsSync(resolved)) {
      throw new Error(`Workspace path does not exist: ${resolved}`);
    }

    const languages = language
      ? [language]
      : LSPManager.detectLanguagesForWorkspace(resolved);
    if (languages.length === 0) languages.push('javascript');

    const [primaryKey, ...restKeys] = languages;
    const primaryConfig = this._servers[primaryKey];
    if (!primaryConfig) {
      throw new Error(`sin configuración LSP para '${primaryKey}'`);
    }

    const primary = new _LSPInstance(primaryConfig, primaryKey);
    this._instances.set(primaryKey, primary);

    for (const key of restKeys) {
      if (!this._instances.has(key)) {
        this._startInstance(key, resolved);
      }
    }

    await primary.start(resolved);
    return primaryKey;
  }

  /** Arranca (o reinicia) un lenguaje puntual. */
  async startLanguage(language, workspacePath = null) {
    const config = this._servers[language];
    if (!config) throw new Error(`sin configuración LSP para '${language}'`);
    const resolved = workspacePath ? path.resolve(workspacePath) : this._workspacePath;
    if (!resolved) throw new Error('no hay workspace seteado para startLanguage');
    const existing = this._instances.get(language);
    if (existing) await existing.stop();
    const inst = new _LSPInstance(config, language);
    this._instances.set(language, inst);
    await inst.start(resolved);
    return inst;
  }

  /** Guía/ejecución de la instalación del server para un lenguaje. */
  install(language) {
    const config = this._servers[language];
    if (!config || !config.installCmd) return null;
    if (config.npx) {
      // Los basados en npx se auto-instalan en el primer start; nada que hacer.
      return null;
    }
    return config.installCmd;
  }

  async stop() {
    const instances = [...this._instances.values()];
    this._instances.clear();
    await Promise.all(instances.map(i => i.stop().catch(() => {})));
  }

  async openDocument(filePath) {
    const inst = this._languageForFile(filePath);
    if (inst) await inst.openDocument(filePath);
  }

  async changeDocument(filePath, content, version = null) {
    const inst = this._languageForFile(filePath);
    if (inst) await inst.changeDocument(filePath, content, version);
  }

  closeDocument(filePath) {
    const inst = this._languageForFile(filePath);
    if (inst) inst.closeDocument(filePath);
  }

  async getDiagnostics(filePath) {
    const inst = this._languageForFile(filePath);
    if (!inst) return [];
    return inst.getDiagnostics(filePath);
  }

  async goToDefinition(filePath, line, character) {
    const inst = this._languageForFile(filePath);
    if (!inst) return null;
    return inst.goToDefinition(filePath, line, character);
  }

  async findReferences(filePath, line, character) {
    const inst = this._languageForFile(filePath);
    if (!inst) return [];
    return inst.findReferences(filePath, line, character);
  }

  async getDocumentSymbols(filePath) {
    const inst = this._languageForFile(filePath);
    if (!inst) return [];
    return inst.getDocumentSymbols(filePath);
  }

  async getWorkspaceSymbols(query) {
    const inst = this._primaryInstance();
    if (!inst) return [];
    return inst.getWorkspaceSymbols(query);
  }

  // ── Detección por manifiesto (G.1) ─────────────────────────────────────

  /**
   * Resolución por manifiesto del proyecto, no por extensión de archivo:
   *   package.json / tsconfig.json → typescript | javascript
   *   pyproject.toml / requirements.txt / setup.py → python
   *   go.mod → go · Cargo.toml → rust · Gemfile → ruby
   *   composer.json → php · pom.xml / build.gradle → java
   * Devuelve TODOS los lenguajes detectados (repos poliglota).
   */
  static detectLanguagesForWorkspace(ws) {
    const root = path.resolve(ws);
    const has = (f) => { try { return fs.existsSync(path.join(root, f)); } catch { return false; } };
    const languages = [];

    // Familia JS/TS (comparten package.json, se resuelven juntas)
    if (has('package.json') || has('tsconfig.json')) {
      languages.push(LSPManager._jsIsTypescript(root) ? 'typescript' : 'javascript');
    }

    // Resto por manifiesto (orden de la tabla)
    for (const key of ['python', 'go', 'rust', 'ruby', 'php', 'java']) {
      const cfg = loadServersTable()[key];
      if (cfg && (cfg.manifests || []).some(has)) languages.push(key);
    }

    return languages;
  }

  /** Compat: primario de detectLanguagesForWorkspace (o 'javascript'). */
  static detectLanguageForWorkspace(ws) {
    const langs = LSPManager.detectLanguagesForWorkspace(ws);
    return langs[0] || 'javascript';
  }

  static _jsIsTypescript(root) {
    try {
      if (fs.existsSync(path.join(root, 'tsconfig.json'))) return true;
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      return Object.keys(deps).some(d => /^typescript(@|$)/.test(d) || d.startsWith('@types/'));
    } catch {
      return false;
    }
  }
}

// ── Módulo helpers ─────────────────────────────────────────────────────────

function _killTree(rootPid) {
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

function _symbolKindName(kind) {
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

let _instance = null;
function getLSPManager() {
  if (!_instance) _instance = new LSPManager();
  return _instance;
}

module.exports = { LSPManager, getLSPManager, _LSPInstance, loadServersTable };
