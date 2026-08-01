'use strict';

/**
 * LSPErrorWatcher.js — Fase D: errores del LSP como señal proactiva.
 *
 * Vigila los diagnósticos del LSP en el workspace activo y emite `lsp:error`
 * cuando aparece un error real de código (severidad 1 = Error). Es la pieza
 * que convierte el LSP en un SENSOR del camino proactivo: el asistente no espera a
 * que el usuario le pida — si hay un error de código en el archivo que estás
 * tocando, lo nota y (con permiso) ofrece un parche.
 *
 * Reglas de diseño (mismas que GitWatcher/SystemWatcher):
 *   - Silencio total sin workspace o sin LSP: no emite, no tira errores.
 *   - Umbral por severidad: SOLO errores (1). Los warnings se ignoran por
 *     diseño (falsos positivos de linting no son señales — ROADMAP #17).
 *   - Emisión por flanco: dedup por archivo (hash de los errores), se re-emite
 *     solo cuando cambia el conjunto de errores. El cooldown por tipo del
 *     ProactiveEngine es el segundo freno.
 *   - Scope por workspace: jamás diagnostica archivos fuera de `getWorkspace()`
 *     y el payload siempre lleva `workspace` (ROADMAP #21).
 *   - Nunca lanza: cada scan está aislado; errores del LSP solo se loguean.
 *   - Editor tracker: mantiene el set de archivos "abiertos en el editor"
 *     (el enfocado detectado por el título de la ventana + inyección opcional),
 *     que el ProactiveExecutor usa para NO escribir sobre archivos abiertos.
 *
 * Todo inyectable para tests: `lsp`, `getWorkspace`, `getCurrentTitle`,
 * `getSymbols`, `listFiles`, `getDiagnostics`.
 */

const crypto     = require('crypto');
const fs         = require('fs');
const path       = require('path');

const { getEventBus } = require('../../infrastructure/event-bus/EventBus.js');

const DEFAULT_POLL_MS       = 30 * 1000;
const DEFAULT_MAX_SCAN      = 6;                 // archivos diagnosticados por poll
const DEFAULT_MAX_INDEXED   = 3000;              // límite del índice de archivos del workspace
const SEVERITY_ERROR        = 1;
const INDEX_TTL_MS          = 30 * 1000;

// Carpetas/globals que jamás se indexan (ruido o no-code).
const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.cache',
  'vendor', 'target', '.next', '.nuxt', '__pycache__', '.venv', 'venv',
]);

function _defaultListFiles(ws, max = DEFAULT_MAX_INDEXED) {
  const results = [];
  const walk = (dir, depth) => {
    if (results.length >= max) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (results.length >= max) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name) || depth >= 8) continue;
        walk(full, depth + 1);
      } else if (e.isFile()) {
        results.push(full);
      }
    }
  };
  walk(ws, 0);
  return results;
}

function _normalizeError(d) {
  return {
    code:      d.code || null,
    message:   (d.message || '').trim(),
    line:      d.range?.start?.line ?? 0,
    character: d.range?.start?.character ?? 0,
    severity:  d.severity ?? 1,
  };
}

function _hashErrors(errors) {
  return crypto.createHash('sha1').update(JSON.stringify(errors)).digest('hex');
}

class LSPErrorWatcher {
  constructor({
    lsp               = null,
    getWorkspace      = () => null,
    getCurrentTitle   = () => '',
    getSymbols        = null,
    getDiagnostics    = null,
    listFiles         = null,
    supportedExts     = ['.ts', '.tsx', '.js', '.jsx', '.mjs'],
    pollMs            = DEFAULT_POLL_MS,
    maxScanPerPoll    = DEFAULT_MAX_SCAN,
    severityThreshold = SEVERITY_ERROR,
    bus               = getEventBus(),
    extraOpenFiles    = null,          // () => string[] — archivos abiertos en el editor (inyección)
  } = {}) {
    this._lsp              = lsp;
    this._getWorkspace     = getWorkspace || (() => null);
    this._getCurrentTitle  = getCurrentTitle || (() => '');
    this._getSymbols       = getSymbols || null;
    this._getDiagnostics   = getDiagnostics || ((abs) => this._lsp?.getDiagnostics?.(abs) || Promise.resolve([]));
    this._listFiles        = listFiles || ((ws) => _defaultListFiles(ws, DEFAULT_MAX_INDEXED));
    this._supportedExts    = supportedExts;
    this._pollMs           = pollMs;
    this._maxScanPerPoll   = maxScanPerPoll;
    this._severityThreshold = severityThreshold;
    this._bus              = bus;
    this._extraOpenFiles   = extraOpenFiles || null;

    this._timer       = null;
    this._running     = false;
    this._polling     = false;

    this._workspace   = null;
    this._filesIndex  = [];        // lista cacheada de archivos soportados
    this._filesIndexAt = 0;

    this._openInEditor = new Set(); // absPath → archivos que el editor tiene abiertos
    this._focusedFile  = null;      // absPath del archivo actualmente enfocado
    this._signals      = new Map(); // absPath → hash del último error emitido
    this._lastErrors   = new Map(); // absPath → errores del último scan
    this._lastErrorMsg = null;
    this._emitted      = 0;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this.poll().catch(() => {});
    this._timer = setInterval(() => this.poll().catch(() => {}), this._pollMs);
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._running = false;
  }

  /** Fuerza un scan (debug/testing). */
  async poll() {
    if (this._polling) return;
    this._polling = true;
    try { await this._scan(); }
    catch(e) {
      this._lastErrorMsg = e.message;
      if (process.env.DEBUG) console.warn('[lsp-watcher]', e.message);
    } finally { this._polling = false; }
  }

  /**
   * Fase D: cambia de workspace (scope). Reset del estado previo — jamás se
   * mezclan errores/archivos abiertos entre proyectos (ROADMAP #21).
   */
  resetWorkspace(ws) {
    this._workspace     = ws || null;
    this._filesIndex    = [];
    this._filesIndexAt  = 0;
    this._openInEditor.clear();
    this._focusedFile   = null;
    this._signals.clear();
    this._lastErrors.clear();
  }

  // ── Escaneo ──────────────────────────────────────────────────────────────

  async _scan() {
    const ws = this._getWorkspace();
    if (!ws) return;
    this._workspace = ws;

    const focused = await this._detectFocusedFile(ws);
    if (focused && focused !== this._focusedFile) {
      this._focusedFile = focused;
      this._openInEditor.add(focused);
      if (this._lsp?.openDocument) {
        try { await this._lsp.openDocument(focused); } catch(e) { /* no rompe */ }
      }
    }

    const candidates = this._buildCandidates(ws, focused);
    for (const abs of candidates) {
      let diagnostics;
      try { diagnostics = await this._getDiagnostics(abs); } catch(e) {
        if (process.env.DEBUG) console.warn(`[lsp-watcher] diagnóstico ${path.basename(abs)}:`, e.message);
        continue;
      }
      const errors = (Array.isArray(diagnostics) ? diagnostics : [])
        .filter(d => (d.severity ?? SEVERITY_ERROR) === this._severityThreshold)
        .map(_normalizeError)
        .filter(e => e.message);

      this._lastErrors.set(abs, errors);

      const hash = _hashErrors(errors);
      if (hash === this._signals.get(abs)) continue;
      this._signals.set(abs, hash);
      if (!errors.length) continue;

      // Nuevo conjunto de errores → señal. Los símbolos se piden solo para el
      // archivo enfocado (o el primero), para no multiplicar requests al LSP.
      const rel = path.relative(ws, abs);
      let symbols = null;
      if (this._getSymbols && (abs === focused || abs === candidates[0])) {
        try { symbols = await this._getSymbols(abs); } catch(_) {}
      }
      this._emitted += 1;
      this._bus.emit('lsp:error', {
        file:      rel.split(path.sep).join('/'),
        absPath:   abs,
        workspace: ws,
        errors,
        count:     errors.length,
        focused:   abs === focused,
        symbols,
        // Lenguaje del archivo (el LLM debe parchear en el idioma correcto):
        // los errores llegan "en TS" (checkJs), pero el archivo es el que es.
        languageId: this._languageFor(abs),
        fileType:  path.extname(abs).toLowerCase(),
      });
    }
  }

  _detectFocusedFile(ws) {
    const title = this._getCurrentTitle() || '';
    const base  = this._basenameFromTitle(title);
    if (!base) return Promise.resolve(null);

    const files = this._filesFor(ws);
    const matches = files.filter(f => path.basename(f) === base);
    // Solo confiar en el foco si el nombre del archivo es inequívoco.
    return Promise.resolve(matches.length === 1 ? matches[0] : null);
  }

  _basenameFromTitle(title) {
    // "foo.ts — Proyecto — Visual Studio Code" / "foo.ts - Proyecto"
    const first = title.split(/\s+[—–-]\s+/)[0].trim();
    if (!first || first.includes(' ')) {
      // Puede ser una ruta ("/a/b/foo.ts") o un nombre compuesto; tomamos la
      // última parte con extensión soportada si el título parece un path.
      const segs = first.split(/[\\/]/);
      const last = segs[segs.length - 1];
      return (last && this._isSupported(last)) ? last : null;
    }
    return this._isSupported(first) ? first : null;
  }

  // Lenguaje del archivo para el payload de la señal: el tsserver sirve JS y
  // TS, y los errores `implicit any` (checkJs) "parecen TS" — pero el archivo
  // es lo que es. El LLM necesita esto para no anotar sintaxis TS en un .js.
  _languageFor(abs) {
    const ext = path.extname(abs).toLowerCase();
    if (ext === '.ts' || ext === '.tsx' || ext === '.mts' || ext === '.cts') return 'typescript';
    if (ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') return 'javascript';
    if (this._lsp?._serverConfig?.languageId) return this._lsp._serverConfig.languageId;
    return 'plaintext';
  }

  _filesFor(ws) {
    if (this._filesIndexAt && Date.now() - this._filesIndexAt < INDEX_TTL_MS && this._workspace === ws) {
      return this._filesIndex;
    }
    const all = this._listFiles(ws) || [];
    this._filesIndex = all.filter(f => this._isSupported(path.basename(f)));
    this._filesIndexAt = Date.now();
    return this._filesIndex;
  }

  _buildCandidates(ws, focused) {
    const files   = this._filesFor(ws);
    const withOld = this._signals.size ? Array.from(this._signals.keys()).filter(f => f.startsWith(ws)) : [];
    const seen    = new Set();
    const ordered = [];

    const push = (p) => {
      if (!p || seen.has(p)) return;
      seen.add(p);
      if (ordered.length < this._maxScanPerPoll) ordered.push(p);
    };

    // 1) El archivo enfocado (lo que el usuario está viendo ahora).
    push(focused);
    // 2) Archivos con errores ya vistos (re-visitar para detectar el fix).
    for (const f of withOld) push(f);
    // 3) Los primeros archivos del índice (señal de arranque / errores nuevos
    //    en otros archivos que el usuario no tiene enfocados).
    for (const f of files) push(f);
    return ordered;
  }

  _isSupported(base) {
    const ext = path.extname(base).toLowerCase();
    return this._supportedExts.includes(ext);
  }

  // ── Editor tracker ───────────────────────────────────────────────────────

  getOpenFiles() {
    const extra = this._extraOpenFiles ? this._extraOpenFiles() : [];
    const set   = new Set(this._openInEditor);
    for (const f of extra || []) {
      try { set.add(path.resolve(f)); } catch {}
    }
    return Array.from(set);
  }

  getFocusedFile() { return this._focusedFile; }

  /** Errores (severidad 1) del último scan de un archivo — verificación post-parche. */
  getErrorsFor(absPath) {
    return this._lastErrors.get(path.resolve(absPath)) || [];
  }

  getStats() {
    return {
      running:    this._running,
      workspace:  this._workspace,
      focused:    this._focusedFile,
      openFiles:  Array.from(this._openInEditor),
      signals:    this._signals.size,
      emitted:    this._emitted,
      lastError:  this._lastErrorMsg,
    };
  }
}

module.exports = { LSPErrorWatcher, SEVERITY_ERROR };
