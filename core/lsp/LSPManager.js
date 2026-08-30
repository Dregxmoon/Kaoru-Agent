// @ts-nocheck
'use strict';
const logger = require('../observability/Logger.js');

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const os = require('os');
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
    logger.warn(
      'LSPManager',
      `[lsp] no se pudo cargar la tabla de servidores (${SERVERS_PATH}):`,
      e.message
    );
    _serversCache = {};
  }
  return _serversCache;
}

// Timeout por request JSON-RPC: si el server se cuelga (o muere sin avisar),
// la promesa debe resolverse como fallo en vez de quedar colgada para siempre.
const REQUEST_TIMEOUT_MS = 20_000;
// G.1: el pull de diagnósticos usa un timeout corto — si el worker de análisis
// del server está ocupado (pyright puede colgarse analizando ciertos archivos),
// no queremos bloquear la tool `diagnostics` 20s; caemos a la cache push.
const DIAGNOSTIC_PULL_TIMEOUT_MS = 5_000;
// Cold-start: el primer request tras initialize dispara la indexación del
// proyecto en servers como tsserver (repos grandes pueden tardar >60s en el
// primer documentSymbol con caché fría). Configurable por server vía
// `coldStartTimeoutMs` en servers.json.
const COLD_START_TIMEOUT_MS = 120_000;

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
    // LSP.0: initializationOptions/env/initTimeoutMs por server (servers.json)
    // + emisor interno para waitForDiagnostics (push fresco con debounce).
    this._initializationOptions = serverConfig.initializationOptions || null;
    this._env = serverConfig.env || null;
    this._initTimeoutMs = serverConfig.initTimeoutMs || 15000;
    this._emitter = new EventEmitter();
    // G.5 recovery: estado del ciclo de vida + config de reinicio por server.
    this._stopping = false;
    this._startedAt = null;
    this._restartAttempts = 0;
    this._maxRestartAttempts = serverConfig.maxRestartAttempts ?? 3;
    this._baseRestartDelayMs = serverConfig.restartDelayMs ?? 2000;
    this._maxRestartDelayMs = serverConfig.maxRestartDelayMs ?? 16000;
    this._stableMs = serverConfig.restartStableMs ?? 10000;
    // F2: cold-start adaptativo (primer request data con timeout largo) y
    // memoria de soporte pull de diagnósticos (null=desconocido, false=no).
    this._firstDataRequestDone = false;
    this._pullSupported = null;
  }

  get isRunning() {
    return this._process !== null && this._started;
  }

  get languageId() {
    return this._serverConfig.languageId || this._languageKey;
  }

  /**
   * Suscripción a eventos internos ('crashed'). Delega en el emitter privado:
   * la clase NO extiende EventEmitter (antes `inst.on(...)` lanzaba TypeError
   * y abortaba LSPManager.start() completo en repos multi-lenguaje).
   * @param {string} event
   * @param {(...args: unknown[]) => void} fn
   * @returns {this}
   */
  on(event, fn) {
    this._emitter.on(event, fn);
    return this;
  }

  off(event, fn) {
    this._emitter.off(event, fn);
    return this;
  }

  start(workspacePath) {
    const config = this._serverConfig;
    this._workspacePath = path.resolve(workspacePath);
    this._stopping = false;

    if (!fs.existsSync(this._workspacePath)) {
      throw new Error(`Workspace path does not exist: ${this._workspacePath}`);
    }

    // LSP.2: si el binario no existe y la config lo habilita (autoInstall),
    // se ejecuta installCmd y se reintenta UNA vez antes de fallar.
    const retriesLeft = config.autoInstall && config.installCmd ? 1 : 0;
    return this._resolveTsserverFallback()
      .catch((e) => {
        logger.warn(
          'LSPManager',
          `[lsp:${this._languageKey}] fallback de tsserver falló: ${e.message}`
        );
        return null;
      })
      .then((fallbackLib) => {
        if (fallbackLib) {
          // tls ≥6 quitó --tsserver-path de la CLI; la ruta va por
          // initializationOptions.tsserver.fallbackPath.
          this._initializationOptions = {
            ...(this._initializationOptions || {}),
            tsserver: {
              ...((this._initializationOptions || {}).tsserver || {}),
              fallbackPath: fallbackLib,
            },
          };
        }
        return this._doStart(this._workspacePath, { retriesLeft });
      });
  }

  /**
   * TypeScript ≥7 (nativo) ya no distribuye `tsserver.js`, que
   * typescript-language-server necesita. Si el TS del workspace no lo trae,
   * se instala typescript@5 en un directorio de caché compartido y se devuelve
   * su ruta `lib/` (el caller la inyecta en initializationOptions).
   * @returns {Promise<string|null>} directorio lib/ del TS de respaldo, o null
   */
  _resolveTsserverFallback() {
    if (!/typescript-language-server/.test((this._serverConfig.args || []).join(' '))) {
      return Promise.resolve(null);
    }
    const wsTsserver = path.join(
      this._workspacePath,
      'node_modules',
      'typescript',
      'lib',
      'tsserver.js'
    );
    if (fs.existsSync(wsTsserver)) return Promise.resolve(null);

    const fallbackDir = path.join(
      process.env.HOME || os.homedir(),
      '.cache',
      'kaoru-lsp',
      'typescript5'
    );
    const fallbackLib = path.join(fallbackDir, 'node_modules', 'typescript', 'lib');
    if (fs.existsSync(path.join(fallbackLib, 'tsserver.js'))) {
      logger.info(
        'LSPManager',
        `[lsp:${this._languageKey}] usando tsserver de caché (${fallbackDir})`
      );
      return Promise.resolve(fallbackLib);
    }

    logger.info(
      'LSPManager',
      `[lsp:${this._languageKey}] workspace con TypeScript sin tsserver — instalando typescript@5 en caché...`
    );
    fs.mkdirSync(fallbackDir, { recursive: true });
    return new Promise((resolve, reject) => {
      const child = spawn('npm', ['install', '--prefix', fallbackDir, 'typescript@5'], {
        cwd: fallbackDir,
        stdio: 'ignore',
        shell: process.platform === 'win32',
      });
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('timeout instalando typescript@5 de respaldo'));
      }, 120000);
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0 && fs.existsSync(path.join(fallbackLib, 'tsserver.js'))) {
          resolve(fallbackLib);
        } else {
          reject(new Error(`npm install typescript@5 salió con código ${code}`));
        }
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  _doStart(workspacePath, { retriesLeft }) {
    const config = this._serverConfig;

    return new Promise((resolve, reject) => {
      let started = false;
      let proc;
      try {
        proc = _spawnLspServer(config.command, config.args, {
          cwd: workspacePath,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, ...(this._env || {}) },
        });
      } catch (e) {
        reject(e);
        return;
      }

      this._process = proc;

      proc.on('error', async (err) => {
        logger.warn(
          'LSPManager',
          `[lsp:${this._languageKey}] no se pudo lanzar ${config.command}: ${err.message}`
        );
        if (config.installCmd && !config.autoInstall) {
          logger.warn(
            'LSPManager',
            `[lsp:${this._languageKey}] instalalo con: ${config.installCmd}`
          );
        }
        this._process = null;
        this._started = false;
        this._rejectAllPending(err.message);
        if (started) return;

        if (retriesLeft > 0) {
          started = true;
          try {
            logger.info(
              'LSPManager',
              `[lsp:${this._languageKey}] ${config.command} no existe — ejecutando instalación: ${config.installCmd}`
            );
            await this._runInstall(config.installCmd);
            if (this._stopping) {
              reject(new Error('LSP server stopped durante la instalación'));
              return;
            }
            resolve(await this._doStart(workspacePath, { retriesLeft: retriesLeft - 1 }));
          } catch (e2) {
            reject(new Error(`auto-install falló (${config.installCmd}): ${e2.message}`));
          }
          return;
        }

        started = true;
        reject(err);
      });

      proc.stdout.on('data', (data) => {
        this._buffer += data.toString();
        this._processBuffer();
      });

      proc.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) logger.info('LSPManager', `[lsp:${this._languageKey}] ${msg}`);
      });

      // QW-6: si el server muere (EPIPE) o el stdin se cierra, la escritura a
      // un stream sin handler de 'error' tira un Unhandled 'error' event que
      // crashea todo el proceso. Escuchamos el error y degradamos a no-op: la
      // próxima llamada ya comprueba `this._process`/writable y responde con
      // "LSP no disponible".
      proc.stdin.on('error', (err) => {
        if (err.code !== 'EPIPE') {
          logger.debug('LSPManager', `[lsp:${this._languageKey}] error en stdin: ${err.message}`);
        }
      });
      proc.stdin.on('close', () => {
        try {
          this._process?.stdin?.removeAllListeners('error');
        } catch {}
      });

      proc.on('exit', (code) => this._handleExit(code));

      // Send initialize request
      // G.1: pyright y otros servers push-based DEJAN de publicar
      // publishDiagnostics si el initialize incluye rootPath + workspaceFolders
      // (quirk verificado E2E). Por defecto se envía SOLO rootUri; los servers
      // que lo necesitan (go/java, multi-root) lo declaran con
      // `workspaceFolders: true` en servers.json.
      const wantFolders = this._serverConfig.workspaceFolders === true;
      const initializeParams = {
        processId: process.pid,
        rootUri: _toFileUri(this._workspacePath),
      };
      if (wantFolders) {
        initializeParams.rootPath = this._workspacePath;
        initializeParams.workspaceFolders = [
          { uri: _toFileUri(this._workspacePath), name: path.basename(this._workspacePath) },
        ];
      }
      initializeParams.initializationOptions = this._initializationOptions || undefined;
      initializeParams.capabilities = {
        // LSP.0: capabilities que los servers esperan de un cliente real.
        // workspace.configuration es REQUERIDO por servers como gopls/jdtls
        // (piden settings vía workspace/configuration); sin declararlo algunos
        // no terminan de inicializar o ignoran config.
        window: {
          workDoneProgress: true,
        },
        workspace: {
          configuration: true,
          didChangeWatchedFiles: { dynamicRegistration: true },
          symbol: {},
        },
        textDocument: {
          synchronization: { didSave: true },
          // G.1: NO declarar textDocument.diagnostic (pull) — pyright lo
          // interpreta como soporte pull y deja de enviar push (publishDiagnostics).
          // publicar solo publishDiagnostics activa el push en todos los servers.
          publishDiagnostics: { relatedInformation: true },
        },
      };
      this._request('initialize', initializeParams)
        .then((result) => {
          this._capabilities = result.capabilities || {};
          // Patrón opencode: tras `initialized`, aplicar la configuración del
          // server (workspace/didChangeConfiguration) con sus initializationOptions.
          if (this._initializationOptions) {
            this._notify('workspace/didChangeConfiguration', {
              settings: this._initializationOptions,
            });
          }
          // Send initialized notification
          this._notify('initialized', {});
          this._started = true;
          this._startedAt = Date.now();
          // El request `initialize` ya consumió el flag de cold-start:
          // resetearlo para que el PRIMER request data (post-init) sea el que
          // reciba el timeout largo mientras el server indexa el proyecto.
          this._firstDataRequestDone = false;
          // Warmup en background: un workspace/symbol vacío fuerza al server
          // a cargar/indexar el proyecto YA, sin bloquear nada. Así el primer
          // request real del agente encuentra al server caliente en vez de
          // absorber toda la latencia de carga fría.
          const warmup = this._request('workspace/symbol', { query: '' });
          warmup
            .catch(() => {})
            .finally(() => {
              logger.debug?.('LSPManager', `[lsp:${this._languageKey}] warmup completado`);
            });
          void warmup;
          if (!started) {
            started = true;
            clearTimeout(initTimer);
            resolve();
          }
        })
        .catch((err) => {
          if (!started) {
            started = true;
            clearTimeout(initTimer);
            reject(err);
          }
        });

      // Timeout safety (LSP.0: por-server — java/heavy necesita más de 15s)
      const initTimeoutMs = this._initTimeoutMs;
      const initTimer = setTimeout(() => {
        if (!started) {
          started = true;
          reject(new Error(`LSP server did not initialize within ${initTimeoutMs / 1000}s`));
          this.stop();
        }
      }, initTimeoutMs);
    });
  }

  /**
   * LSP.2: ejecuta installCmd (npm/gem/pip/go...) para aprovisionar el server
   * que falta. Bloquea hasta terminar (timeout 120s) o devuelve error.
   */
  _runInstall(installCmd) {
    return new Promise((resolve, reject) => {
      const { exec } = require('child_process');
      exec(installCmd, { timeout: 120000 }, (err, _stdout, stderr) => {
        if (err) reject(new Error((stderr || '').trim() || err.message));
        else resolve();
      });
    });
  }

  /**
   * G.5: salida del proceso LSP. Si fue inesperada (no stop() explícito) y no
   * llevaba suficiente tiempo estable, programa un reinicio con backoff.
   * Un server que llevaba > _stableMs activo se considera sano → el contador
   * de intentos se resetea (los cuelgues puntuales se recuperan indefinidamente);
   * un crash-loop temprano se corta al llegar a _maxRestartAttempts.
   */
  _handleExit(code) {
    const stable = this._startedAt && Date.now() - this._startedAt > this._stableMs;
    if (stable) this._restartAttempts = 0;
    logger.info('LSPManager', `[lsp:${this._languageKey}] proceso terminado (código ${code})`);
    this._process = null;
    this._started = false;
    this._rejectAllPending(`LSP server exited with code ${code}`);
    // Antes solo se reiniciaba con código != 0/null: un OOM (SIGKILL → code
    // null) o una salida limpia inesperada dejaban el LSP muerto hasta cambiar
    // de workspace. Ahora CUALQUIER salida no solicitada reinicia — el backoff
    // exponencial + _maxRestartAttempts frenan crash-loops.
    if (!this._stopping) {
      this._scheduleRestart();
    }
  }

  async stop() {
    this._stopping = true;
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    if (!this._process) {
      this._started = false;
      this._restartAttempts = 0;
      this._startedAt = null;
      return;
    }
    try {
      // shutdown con timeout corto: pyright puede tardar en responder si está
      // ocupado analizando (typeshed) y no queremos bloquear el apagado 20s.
      await Promise.race([
        this._request('shutdown', null),
        new Promise((res) => setTimeout(res, 2500)),
      ]);
    } catch (e) {
      logger.warn(
        'LSPManager',
        `[lsp:${this._languageKey}] shutdown request falló:`,
        e && e.message ? e.message : e
      );
    }
    this._notify('exit', null);
    // `npx` re-ejecuta el server en un hijo — matar npx no basta. Recorremos
    // /proc y matamos también a los descendientes.
    try {
      _killTree(this._process.pid);
    } catch (e) {
      logger.warn(
        'LSPManager',
        `[lsp:${this._languageKey}] killTree falló:`,
        e && e.message ? e.message : e
      );
    }
    try {
      this._process.kill();
    } catch (e) {
      logger.warn(
        'LSPManager',
        `[lsp:${this._languageKey}] kill del proceso falló:`,
        e && e.message ? e.message : e
      );
    }
    this._process = null;
    this._started = false;
    this._restartAttempts = 0;
    this._startedAt = null;
    this._diagnostics.clear();
    this._openedDocs.clear();
    // Cancela pendientes (p.ej. un shutdown que aún no respondió) y sus timers.
    this._rejectAllPending('LSP server stopped');
  }

  async openDocument(filePath) {
    const absPath = path.resolve(filePath);
    if (!fs.existsSync(absPath)) return;
    const uri = _toFileUri(absPath);
    // Fase D: no re-enviar didOpen si el documento ya está abierto (muchos
    // servers lo toleran, pero reabrir resetea su estado del buffer).
    if (this._openedDocs.has(uri)) return;
    const content = fs.readFileSync(absPath, 'utf-8');

    this._openedDocs.set(uri, 1);
    // LSP.0: mantener el server al día con cambios externos de archivos.
    this._notify('workspace/didChangeWatchedFiles', {
      changes: [{ uri, type: 1 }], // Created
    });
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
    const uri = _toFileUri(absPath);
    // Si el documento no estaba abierto, abrirlo con el contenido nuevo.
    if (!this._openedDocs.has(uri)) {
      this._openedDocs.set(uri, 1);
      this._notify('workspace/didChangeWatchedFiles', {
        changes: [{ uri, type: 1 }], // Created
      });
      this._notify('textDocument/didOpen', {
        textDocument: { uri, languageId: this.languageId, version: 1, text: content },
      });
      return;
    }
    // Fase D: versión incremental real — antes el version se quedaba en 2
    // para siempre y el server podía ignorar los didChange posteriores.
    const nextVersion = version ?? (this._openedDocs.get(uri) || 0) + 1;
    this._openedDocs.set(uri, nextVersion);
    this._notify('workspace/didChangeWatchedFiles', {
      changes: [{ uri, type: 2 }], // Changed
    });
    this._notify('textDocument/didChange', {
      textDocument: { uri, version: nextVersion },
      contentChanges: [{ text: content }],
    });
  }

  /** Olvida un documento abierto (p.ej. al dejar de escanearlo). */
  closeDocument(filePath) {
    const uri = _toFileUri(path.resolve(filePath));
    if (!this._openedDocs.has(uri)) return;
    this._openedDocs.delete(uri);
    this._notify('textDocument/didClose', { textDocument: { uri } });
  }

  /**
   * Espera el push fresco de publishDiagnostics para un archivo (con debounce).
   * Patrón opencode: tras abrir/editar un archivo, el server publica los
   * diagnósticos asincrónicamente; en vez de dormir un tiempo fijo, esperamos
   * el evento y devolvemos el conjunto más actual (o la cache en el timeout).
   */
  waitForDiagnostics(filePath, { debounceMs = 300, timeoutMs = 3000 } = {}) {
    const absPath = path.resolve(filePath);
    const uri = _toFileUri(absPath);

    return new Promise((resolve) => {
      let timer = null;
      let done = false;
      const finish = (diagnostics) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        this._emitter.removeListener('diagnostics', onDiagnostics);
        resolve(diagnostics);
      };
      const onDiagnostics = (eventUri, diagnostics) => {
        if (eventUri !== uri) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => finish(diagnostics), debounceMs);
      };
      this._emitter.on('diagnostics', onDiagnostics);
      // Timeout de seguridad: nunca colgarse esperando un push que no llega.
      // El resultado lleva `stale: true` — es la cache push posiblemente
      // DESACTUALIZADA (el server aún no procesó el cambio), no un conjunto
      // fresco. Los consumidores (feedback post-edit) lo reportan como tal.
      setTimeout(() => {
        const cached = this._diagnostics.get(uri) || [];
        try {
          Object.defineProperty(cached, 'stale', { value: true, enumerable: false });
        } catch (_) {}
        finish(cached);
      }, timeoutMs);
    });
  }

  async getDiagnostics(filePath) {
    const absPath = path.resolve(filePath);
    const uri = _toFileUri(absPath);

    // Ensure document is open
    await this.openDocument(filePath);

    // Pull first (LSP 3.17 textDocument/diagnostic). Aunque el server no lo
    // anuncie en capabilities (pyright no declara diagnosticProvider), la
    // mayoría lo soporta; si responde MethodNotFound o se agota el timeout,
    // se memoriza y los pulls siguientes van directo a la cache push — sin
    // repetir 5s de latencia muerta por archivo en servers sin pull.
    if (this._pullSupported !== false) {
      try {
        const result = await this._request(
          'textDocument/diagnostic',
          {
            textDocument: { uri },
          },
          DIAGNOSTIC_PULL_TIMEOUT_MS
        );
        this._pullSupported = true;
        if (result && Array.isArray(result.items)) {
          return result.items;
        }
      } catch (_) {
        // Timeout o MethodNotFound: marcar y confiar en push.
        if (this._pullSupported !== true) this._pullSupported = false;
      }
    }

    // Push diagnostics: track from textDocument/publishDiagnostics notifications
    return this._diagnostics.get(uri) || [];
  }

  async goToDefinition(filePath, line, character) {
    const absPath = path.resolve(filePath);
    const uri = _toFileUri(absPath);
    await this.openDocument(filePath);

    const result = await this._request('textDocument/definition', {
      textDocument: { uri },
      position: { line, character },
    });

    if (!result) return null;
    const locations = Array.isArray(result) ? result : [result];
    return locations.map((loc) => ({
      uri: loc.uri,
      filePath: loc.uri ? _fromFileUri(loc.uri) : null,
      range: loc.range,
      line: loc.range?.start?.line,
      character: loc.range?.start?.character,
    }));
  }

  async findReferences(filePath, line, character) {
    const absPath = path.resolve(filePath);
    const uri = _toFileUri(absPath);
    await this.openDocument(filePath);

    const result = await this._request('textDocument/references', {
      textDocument: { uri },
      position: { line, character },
      context: { includeDeclaration: true },
    });

    if (!result) return [];
    return result.map((loc) => ({
      uri: loc.uri,
      filePath: loc.uri ? _fromFileUri(loc.uri) : null,
      range: loc.range,
      line: loc.range?.start?.line,
      character: loc.range?.start?.character,
    }));
  }

  async getDocumentSymbols(filePath) {
    const absPath = path.resolve(filePath);
    const uri = _toFileUri(absPath);
    await this.openDocument(filePath);

    const result = await this._request('textDocument/documentSymbol', {
      textDocument: { uri },
    });

    if (!result) return [];
    return result.map((sym) => ({
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
    return result.map((sym) => ({
      name: sym.name,
      kind: sym.kind,
      kindName: _symbolKindName(sym.kind),
      location: sym.location,
      filePath: sym.location?.uri ? _fromFileUri(sym.location.uri) : null,
    }));
  }

  // ── LSP.3: tools semánticas (hover / rename / code actions) ─────────────

  /** Hover en una posición → contenido plano + lenguaje (LSP.3). */
  async hover(filePath, line, character) {
    const absPath = path.resolve(filePath);
    const uri = _toFileUri(absPath);
    await this.openDocument(filePath);

    const result = await this._request('textDocument/hover', {
      textDocument: { uri },
      position: { line, character },
    });
    if (!result) return null;

    const contents = result.contents;
    let text = '';
    let language = null;
    if (typeof contents === 'string') {
      text = contents;
    } else if (Array.isArray(contents)) {
      text = contents.map((c) => (typeof c === 'string' ? c : (c?.value ?? ''))).join('\n');
    } else if (contents && typeof contents === 'object') {
      text = contents.value ?? '';
      language = contents.language ?? null;
    }
    return { contents: text, language, range: result.range || null };
  }

  /**
   * Rename de un símbolo. Devuelve los edits workspace calculados SIN aplicarlos:
   * el agente (o el usuario) los revisa antes de tocar archivos. LSP.3.
   */
  async rename(filePath, line, character, newName) {
    if (!newName || typeof newName !== 'string' || !newName.trim()) {
      throw new Error('rename requiere newName (nombre nuevo del símbolo)');
    }
    const absPath = path.resolve(filePath);
    const uri = _toFileUri(absPath);
    await this.openDocument(filePath);

    const result = await this._request('textDocument/rename', {
      textDocument: { uri },
      position: { line, character },
      newName,
    });
    if (!result?.changes) return [];
    const edits = [];
    for (const [fileUri, textEdits] of Object.entries(result.changes)) {
      edits.push({
        filePath: _fromFileUri(fileUri),
        uri: fileUri,
        edits: textEdits,
      });
    }
    return edits;
  }

  /** Code actions disponibles en una posición (LSP.3). No las aplica. */
  async codeActions(filePath, line, character, context = null) {
    const absPath = path.resolve(filePath);
    const uri = _toFileUri(absPath);
    await this.openDocument(filePath);

    const diagnostics = context?.diagnostics || this._diagnostics.get(uri) || [];
    const result = await this._request('textDocument/codeAction', {
      textDocument: { uri },
      range: { start: { line, character }, end: { line, character } },
      context: { diagnostics },
    });
    if (!result) return [];
    return result.map((a) => ({
      title: a.title,
      kind: a.kind || null,
      diagnostics: a.diagnostics || [],
      edit: a.edit || null,
      command: a.command || null,
      isPreferred: !!a.isPreferred,
    }));
  }

  // ── JSON-RPC internals ───────────────────────────────────────────────

  _request(method, params, timeoutMs = REQUEST_TIMEOUT_MS, _isRetry = false) {
    // Cold-start adaptativo: el primer request data-request (post-initialize)
    // usa timeout largo — tsserver indexa el proyecto completo en la primera
    // documentSymbol/workspaceSymbols. Solo aplica al default; un timeout
    // explícito (pull de diagnósticos, shutdown) se respeta.
    let effectiveTimeout = timeoutMs;
    if (!_isRetry && !this._firstDataRequestDone && timeoutMs === REQUEST_TIMEOUT_MS) {
      effectiveTimeout = this._serverConfig?.coldStartTimeoutMs || COLD_START_TIMEOUT_MS;
      this._firstDataRequestDone = true;
    }
    return new Promise((resolve, reject) => {
      const id = this._requestId++;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        // Reintento único ante timeout con server vivo: durante la carga fría
        // de proyectos grandes tsserver puede dejar pasar el primer request
        // pero responde al instante al siguiente (verificado E2E). Todos los
        // requests LSP son de solo lectura — reintentar es seguro.
        if (!_isRetry && this.isRunning && method !== 'initialize' && method !== 'shutdown') {
          logger.info(
            'LSPManager',
            `[lsp:${this._languageKey}] ${method} excedió ${effectiveTimeout}ms — reintentando una vez...`
          );
          resolve(this._request(method, params, REQUEST_TIMEOUT_MS, true));
          return;
        }
        reject(new Error(`LSP request "${method}" timed out after ${effectiveTimeout}ms`));
      }, effectiveTimeout);
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
    // LSP.0: request server→client (tiene id Y method) — hay que responderla,
    // si no el server queda esperando y cualquier request posterior se cuelga.
    if (msg.id !== undefined && msg.id !== null && msg.method) {
      this._handleServerRequest(msg);
      return;
    }

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
      this._emitter.emit('diagnostics', uri, diagnostics);
    }
  }

  /** Respuestas a requests que el server le hace al cliente (LSP.0). */
  _handleServerRequest(msg) {
    const { id, method } = msg;
    try {
      switch (method) {
        case 'workspace/configuration':
          // El server pide su configuración por sección. Devolvemos lo que
          // corresponda de las initializationOptions (o un array vacío).
          if (msg.params?.items) {
            this._respond(
              id,
              msg.params.items.map((it) =>
                it?.section ? this._pickSection(it.section) : this._initializationOptions
              )
            );
          } else {
            this._respond(id, this._initializationOptions || []);
          }
          return;
        case 'workspace/workspaceFolders':
          this._respond(
            id,
            this._workspacePath
              ? [{ uri: _toFileUri(this._workspacePath), name: path.basename(this._workspacePath) }]
              : null
          );
          return;
        case 'window/workDoneProgress/create':
        case 'client/registerCapability':
        case 'client/unregisterCapability':
          this._respond(id, null);
          return;
        default:
          // Request desconocida: responder MethodNotFound para no dejar al
          // server esperando (evita timeouts de 20s en cadena).
          this._respondError(id, -32601, `Method not found: ${method}`);
      }
    } catch (e) {
      this._respondError(id, -32603, e.message);
    }
  }

  /** Recorre initializationOptions con la sección dotada (p.ej. "python.analysis"). */
  _pickSection(section) {
    const opts = this._initializationOptions;
    if (!opts) return null;
    let cur = opts;
    for (const part of String(section).split('.')) {
      if (cur == null || typeof cur !== 'object') return null;
      cur = cur[part];
    }
    return cur ?? null;
  }

  _respond(id, result) {
    this._send({ jsonrpc: '2.0', id, result });
  }

  _respondError(id, code, message) {
    this._send({ jsonrpc: '2.0', id, error: { code, message } });
  }

  _rejectAllPending(reason) {
    for (const [id, pending] of this._pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this._pending.clear();
  }

  _scheduleRestart() {
    if (this._restartTimer || this._stopping) return;
    if (this._restartAttempts >= this._maxRestartAttempts) {
      logger.error(
        'LSPManager',
        `[lsp:${this._languageKey}] servidor no se recupera tras ${this._maxRestartAttempts} reinicios — LSP de ${this._languageKey} desactivado.`
      );
      this._emitter.emit('crashed', this._languageKey);
      return;
    }
    this._restartAttempts++;
    const delay = Math.min(
      this._baseRestartDelayMs * Math.pow(2, this._restartAttempts - 1),
      this._maxRestartDelayMs
    );
    logger.info(
      'LSPManager',
      `[lsp:${this._languageKey}] reinicio programado en ${delay}ms (intento ${this._restartAttempts}/${this._maxRestartAttempts})`
    );
    this._restartTimer = setTimeout(async () => {
      this._restartTimer = null;
      if (this._stopping || this.isRunning || !this._workspacePath) return;
      try {
        await this.start(this._workspacePath);
        await this._reopenAfterRestart();
        logger.info('LSPManager', `[lsp:${this._languageKey}] servidor reiniciado`);
      } catch (e) {
        logger.warn('LSPManager', `[lsp:${this._languageKey}] error en reinicio: ${e.message}`);
      }
    }, delay);
  }

  /**
   * G.5: tras un reinicio, los documentos que estaban abiertos perdieron su
   * estado en el server (el proceso nuevo no los conoce). Se re-envía didOpen
   * para cada uno para que changeDocument/waitForDiagnostics sigan funcionando.
   */
  async _reopenAfterRestart() {
    const uris = [...this._openedDocs.keys()];
    this._openedDocs.clear();
    for (const uri of uris) {
      try {
        const filePath = _fromFileUri(uri);
        await this.openDocument(filePath);
      } catch (e) {
        logger.warn(
          'LSPManager',
          `[lsp:${this._languageKey}] no se pudo re-abrir ${uri}: ${e.message}`
        );
      }
    }
    if (uris.length > 0) {
      logger.info(
        'LSPManager',
        `[lsp:${this._languageKey}] ${uris.length} documento(s) re-abierto(s) tras el reinicio`
      );
    }
  }
}

// ── LSPManager ──────────────────────────────────────────────────────────────
// G.1: gestiona N instancias (una por lenguaje). Las llamadas públicas
// enrutan por extensión de archivo a la instancia correcta.
class LSPManager {
  constructor() {
    this._instances = new Map(); // languageKey → _LSPInstance
    this._workspacePath = null;
    this._servers = loadServersTable();
  }

  get isRunning() {
    return [...this._instances.values()].some((i) => i.isRunning);
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
      for (const p of inst._serverConfig.filePatterns || []) {
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

  /**
   * ¿Algún servidor LSP ACTIVO sirve la extensión de este archivo?
   * A diferencia de _languageForFile, NO cae a la instancia primaria: sirve
   * para que el agente sepa con claridad que el lenguaje no está soportado
   * (en vez de degradarse en silencio y recibir [] del server equivocado).
   */
  supportsFile(filePath) {
    const ext = path.extname(String(filePath)).toLowerCase();
    if (!ext) return false;
    for (const inst of this._instances.values()) {
      if ((inst._serverConfig.filePatterns || []).includes(ext)) return true;
    }
    return false;
  }

  _startInstance(languageKey, workspacePath) {
    const config = this._servers[languageKey];
    if (!config) return null;
    const inst = new _LSPInstance(config, languageKey);
    this._instances.set(languageKey, inst);
    // G.5: si una instancia se rinde tras los reinicios, el manager lo reporta
    // una vez (no loguear por instancia cada intento).
    inst.on('crashed', (lang) => {
      logger.error(
        'LSPManager',
        `[lsp] sin server LSP para '${lang}' tras agotar reinicios — las tools de ese lenguaje devolverán error explícito.`
      );
    });
    inst.start(workspacePath).catch((e) => {
      logger.warn('LSPManager', `[lsp:${languageKey}] no disponible:`, e.message);
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

    const languages = language ? [language] : LSPManager.detectLanguagesForWorkspace(resolved);
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

    try {
      await primary.start(resolved);
    } catch (e) {
      // Sin cleanup la instancia muerta quedaba en el mapa y tools/watcher
      // pagaban timeouts de 5-20s contra un proceso que nunca arrancó.
      this._instances.delete(primaryKey);
      throw e;
    }
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
    await Promise.all(instances.map((i) => i.stop().catch(() => {})));
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

  /**
   * Espera el push fresco de diagnósticos de un archivo (LSP.0). Routing por
   * extensión igual que getDiagnostics. Sin instancia → [] inmediato.
   */
  async waitForDiagnostics(filePath, opts = {}) {
    const inst = this._languageForFile(filePath);
    if (!inst) return [];
    return inst.waitForDiagnostics(filePath, opts);
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

  // ── LSP.3: tools semánticas (routing por extensión) ───────────────────

  async hover(filePath, line, character) {
    const inst = this._languageForFile(filePath);
    if (!inst) return null;
    return inst.hover(filePath, line, character);
  }

  async rename(filePath, line, character, newName) {
    const inst = this._languageForFile(filePath);
    if (!inst) return [];
    return inst.rename(filePath, line, character, newName);
  }

  async codeActions(filePath, line, character, context = null) {
    const inst = this._languageForFile(filePath);
    if (!inst) return [];
    return inst.codeActions(filePath, line, character, context);
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
    const has = (f) => {
      try {
        return fs.existsSync(path.join(root, f));
      } catch {
        return false;
      }
    };
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

    // Detección por extensión: workspaces reales suelen tener scripts sueltos
    // sin manifiesto (un deepseek.py en una subcarpeta, un deploy.sh). Si hay
    // suficientes archivos de un lenguaje SIN server detectado, arrancarlo
    // igual — el LSP vale más que el manifiesto. Bounded: máx 2 niveles de
    // profundidad, carpetas ruido ignoradas.
    for (const key of ['python', 'go', 'rust', 'ruby', 'php', 'java']) {
      if (languages.includes(key)) continue;
      const cfg = loadServersTable()[key];
      const patterns = (cfg?.filePatterns || []).map((p) => String(p).toLowerCase());
      if (!patterns.length) continue;
      if (LSPManager._countFilesByExts(root, patterns) >= 2) {
        languages.push(key);
      }
    }

    return languages;
  }

  /**
   * Cuenta archivos con las extensiones dadas hasta 2 niveles de profundidad,
   * ignorando node_modules/.git/etc. Corta apenas llega a `threshold`.
   * @param {string} root
   * @param {string[]} exts
   * @param {number} [threshold]
   * @returns {number}
   */
  static _countFilesByExts(root, exts, threshold = 2) {
    const SKIP = new Set([
      'node_modules',
      '.git',
      'dist',
      'out',
      'build',
      'coverage',
      'vendor',
      '.venv',
      'venv',
      '__pycache__',
    ]);
    let count = 0;
    const walk = (dir, depth) => {
      if (depth > 2 || count >= threshold) return;
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (count >= threshold) return;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!SKIP.has(e.name)) walk(full, depth + 1);
        } else if (e.isFile() && exts.includes(path.extname(e.name).toLowerCase())) {
          count++;
          if (count >= threshold) return;
        }
      }
    };
    walk(root, 0);
    return count;
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
      return Object.keys(deps).some((d) => /^typescript(@|$)/.test(d) || d.startsWith('@types/'));
    } catch {
      return false;
    }
  }
}

// ── Módulo helpers ─────────────────────────────────────────────────────────

// Construye un URI file:// correcto desde una ruta del filesystem. En Windows
// una ruta `C:\Users\x\main.ts` NO puede ir como `file://C:\Users\...` (URI
// inválido que tsserver rechaza): debe ser `file:///C:/Users/x/main.ts`
// (drive + forward slashes + triple slash).
function _toFileUri(filePath) {
  const absPath =
    process.platform === 'win32' ? path.win32.resolve(filePath) : path.resolve(filePath);
  if (process.platform === 'win32') {
    const withForwardSlashes = absPath.replace(/\\/g, '/');
    return `file:///${withForwardSlashes}`;
  }
  return `file://${absPath}`;
}

// Convierte un URI file:// devuelto por el server de vuelta a ruta local.
// `file:///C:/Users/x/main.ts` → `C:\Users\x\main.ts` en Windows.
function _fromFileUri(uri) {
  const decoded = decodeURIComponent(uri.replace(/^file:\/\//, ''));
  if (process.platform === 'win32') {
    return decoded.replace(/^\/([A-Za-z]:)/, '$1').replace(/\//g, '\\');
  }
  return decoded;
}

// Lanza el server LSP de forma portable:
//  - En Windows los binarios npm (npx, node, tsc...) son shims `.cmd` que
//    `spawn` no puede ejecutar directamente (ENOENT: ".cmd is not executable").
//    La única forma fiable de lanzarlos es `shell: true` (cmd.exe los resuelve)
//    o resolver el `.cmd` explícito. Usamos `shell: true` SOLO en win32.
//  - En Linux/macOS los binarios son ejecutables reales: spawn directo.
// `windowsHide` evita que salte una ventana de consola al arrancar el server.
function _spawnLspServer(command, args, options) {
  if (process.platform === 'win32') {
    return spawn(command, args, { ...options, shell: true, windowsHide: true });
  }
  return spawn(command, args, options);
}

// Mata el árbol de procesos del server LSP. En Linux se recorre /proc (npx
// lanza el server real en un hijo). En Windows `spawn` con shell:true deja el
// server como hijo de cmd.exe → hay que matarlo por árbol con taskkill /T.
function _killTree(rootPid) {
  if (process.platform === 'win32') {
    try {
      require('child_process').execFileSync('taskkill', ['/pid', String(rootPid), '/T', '/F'], {
        stdio: 'ignore',
      });
    } catch {}
    return;
  }
  if (process.platform !== 'linux') return;
  const children = new Map();
  try {
    for (const entry of require('fs').readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      let ppid = -1;
      try {
        const stat = require('fs').readFileSync(`/proc/${entry}/stat`, 'utf-8');
        const close = stat.lastIndexOf(')');
        ppid = parseInt(
          stat
            .slice(close + 1)
            .trim()
            .split(/\s+/)[1],
          10
        );
      } catch (_) {}
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid).push(parseInt(entry, 10));
    }
  } catch (_) {
    return;
  }
  const stack = [...(children.get(rootPid) || [])];
  while (stack.length) {
    const pid = stack.pop();
    try {
      process.kill(pid, 'SIGTERM');
    } catch (_) {}
    stack.push(...(children.get(pid) || []));
  }
}

function _symbolKindName(kind) {
  const names = {
    1: 'File',
    2: 'Module',
    3: 'Namespace',
    4: 'Package',
    5: 'Class',
    6: 'Method',
    7: 'Property',
    8: 'Field',
    9: 'Constructor',
    10: 'Enum',
    11: 'Interface',
    12: 'Function',
    13: 'Variable',
    14: 'Constant',
    15: 'String',
    16: 'Number',
    17: 'Boolean',
    18: 'Array',
    19: 'Object',
    20: 'Key',
    21: 'Null',
    22: 'EnumMember',
    23: 'Struct',
    24: 'Event',
    25: 'Operator',
    26: 'TypeParameter',
  };
  return names[kind] || `Kind_${kind}`;
}

let _instance = null;
function getLSPManager() {
  if (!_instance) _instance = new LSPManager();
  return _instance;
}

module.exports = {
  LSPManager,
  getLSPManager,
  _LSPInstance,
  loadServersTable,
  _toFileUri,
  _fromFileUri,
};
