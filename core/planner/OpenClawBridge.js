/**
 * OpenClawBridge.js — Fase 3 v2
 *
 * Fix v1 → v2:
 *   browser y web_search ahora se ejecutan con BrowserBridge.js
 *   (Playwright real, headless) en lugar de pasar por el mock HTTP.
 *   El resto de herramientas (exec, read, write, edit, apply_patch,
 *   code_execution) siguen yendo a OpenClaw/mock vía HTTP.
 *
 * Interfaz HTTP entre March y OpenClaw (localhost:18789), más
 * BrowserBridge para navegación real.
 *
 * March decide QUÉ hacer. OpenClaw/BrowserBridge lo ejecutan.
 *
 * Herramientas disponibles:
 *   exec           — comandos shell (vía OpenClaw/mock)
 *   browser        — navegación real (vía BrowserBridge / Playwright)
 *   web_search     — búsqueda real (vía BrowserBridge / Playwright)
 *   read           — leer archivos (vía OpenClaw/mock)
 *   write          — escribir archivos (vía OpenClaw/mock)
 *   edit           — modificar archivos (vía OpenClaw/mock)
 *   apply_patch    — parches multi-bloque (vía OpenClaw/mock)
 *   code_execution — ejecutar Python (vía OpenClaw/mock)
 *
 * Contrato de respuesta de execute():
 * {
 *   ok:      boolean
 *   result:  any
 *   error:   string
 *   tool:    string
 *   elapsed: number
 * }
 */

'use strict';

const http = require('http');
const BrowserBridge = require('./BrowserBridge.js');

const OPENCLAW_BASE   = 'http://127.0.0.1:18789';
const DEFAULT_TIMEOUT = 30_000;
// FIX Fase 0.1: API_KEY se lee en el momento del request, no al cargar el módulo.
// MarchCore._startOpenClaw() (línea 205 en MarchCore.js) setea process.env.OPENCLAW_API_KEY
// DESPUÉS de que este módulo ya fue require()-do (línea 38 en MarchCore.js).
// Con un const de módulo, el cliente nunca manda el header de auth.
function _getApiKey() { return process.env.OPENCLAW_API_KEY || null; }

// Herramientas que se resuelven con el navegador propio de March,
// no con el servidor HTTP de OpenClaw/mock.
const BROWSER_TOOLS = new Set(['browser', 'web_search']);

// ── Tipos de herramientas y sus schemas (para las que sí van por HTTP) ────────

const TOOL_SCHEMAS = {
  exec: (params) => ({
    tool: 'exec',
    input: {
      command: params.command,
      cwd:     params.cwd     || undefined,
      timeout: params.timeout || 15,
    },
  }),

  read: (params) => ({
    tool: 'read',
    input: { path: params.path, encoding: params.encoding || 'utf-8' },
  }),

  write: (params) => ({
    tool: 'write',
    input: { path: params.path, content: params.content, encoding: params.encoding || 'utf-8' },
  }),

  edit: (params) => ({
    tool: 'edit',
    input: { path: params.path, old_text: params.old_text, new_text: params.new_text },
  }),

  apply_patch: (params) => ({
    tool: 'apply_patch',
    input: { path: params.path, patch: params.patch },
  }),

  code_execution: (params) => ({
    tool: 'code_execution',
    input: { code: params.code, timeout: params.timeout || 10 },
  }),
};

// ── Helper HTTP ───────────────────────────────────────────────────────────────

function postJSON(url, body, timeoutMs = DEFAULT_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const parsed  = new URL(url);

    const apiKey = _getApiKey();
    const headers = {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(payload),
    };
    if (apiKey) {
      headers['X-Api-Key'] = apiKey;
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const options = {
      hostname: parsed.hostname,
      port:     Number(parsed.port) || 18789,
      path:     parsed.pathname,
      method:   'POST',
      headers,
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: { result: data, raw: true } });
        }
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`OpenClaw timeout después de ${timeoutMs}ms`));
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function getJSON(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port:     Number(parsed.port) || 18789,
      path:     parsed.pathname,
      method:   'GET',
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: { raw: data } }); }
      });
    });

    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

// ── OpenClawBridge ────────────────────────────────────────────────────────────

class OpenClawBridge {
  constructor() {
    this._available    = null;
    this._lastPing     = 0;
    this._pingInterval = 60_000;
    this._actionLog    = [];
    this._maxLog       = 200;
  }

  // ── Disponibilidad ──────────────────────────────────────────────────────────

  async isAvailable(force = false) {
    const now = Date.now();
    const ttl = this._available ? this._pingInterval : 2000;
    if (!force && this._available !== null && (now - this._lastPing) < ttl) {
      return this._available;
    }

    try {
      const res = await getJSON(`${OPENCLAW_BASE}/health`, 3000);
      this._available = res.status === 200;
    } catch {
      this._available = false;
    }

    this._lastPing = now;

    if (!this._available) {
      console.warn('[openclaw] no disponible en', OPENCLAW_BASE);
    } else {
      console.log('[openclaw] disponible');
    }

    return this._available;
  }

  resetAvailabilityCache() {
    this._available = null;
    this._lastPing  = 0;
  }

  // ── Ejecución principal ─────────────────────────────────────────────────────

  /**
   * Ejecuta una herramienta. Despacha a BrowserBridge (Playwright) para
   * browser/web_search, o al servidor HTTP de OpenClaw/mock para el resto.
   */
  async execute(tool, params = {}, opts = {}) {
    const t0 = Date.now();

    // ── browser / web_search → BrowserBridge (Playwright real) ───────────────
    if (BROWSER_TOOLS.has(tool)) {
      try {
        console.log(`[openclaw] ejecutando vía BrowserBridge: ${tool}`, JSON.stringify(params).slice(0, 120));
        const browserResult = tool === 'web_search'
          ? await BrowserBridge.executeWebSearch(params)
          : await BrowserBridge.executeBrowserAction(params);

        const elapsed = Date.now() - t0;
        this._log({ tool, params, ok: true, result: browserResult.result, elapsed });
        console.log(`[openclaw] ${tool} completado en ${elapsed}ms (BrowserBridge)`);

        return { ok: true, result: browserResult.result, error: browserResult.error || null, tool, elapsed };
      } catch (e) {
        return this._err(tool, e.message, t0);
      }
    }

    // ── resto de herramientas → servidor HTTP de OpenClaw/mock ────────────────
    const builder = TOOL_SCHEMAS[tool];
    if (!builder) {
      return this._err(tool, `Herramienta desconocida: ${tool}`, t0);
    }

    const available = await this.isAvailable();
    if (!available) {
      return this._err(tool, 'OpenClaw no está corriendo. Inícialo en localhost:18789.', t0);
    }

    let body;
    try {
      body = builder(params);
    } catch(e) {
      return this._err(tool, `Parámetros inválidos: ${e.message}`, t0);
    }

    console.log(`[openclaw] ejecutando: ${tool}`, JSON.stringify(params).slice(0, 120));

    let res;
    try {
      res = await postJSON(`${OPENCLAW_BASE}/v1/tool`, body, opts.timeout || DEFAULT_TIMEOUT);
    } catch(e) {
      this._available = false;
      return this._err(tool, `Error de red: ${e.message}`, t0);
    }

    const elapsed = Date.now() - t0;

    if (res.status !== 200) {
      const errMsg = res.body?.error || res.body?.message || `HTTP ${res.status}`;
      this._log({ tool, params, ok: false, error: errMsg, elapsed });
      return { ok: false, result: null, error: errMsg, tool, elapsed };
    }

    const result = res.body?.result ?? res.body;

    this._log({ tool, params, ok: true, result, elapsed });
    console.log(`[openclaw] ${tool} completado en ${elapsed}ms`);

    return { ok: true, result, error: null, tool, elapsed };
  }

  // ── Atajos de herramientas ──────────────────────────────────────────────────

  async exec(command, opts = {}) {
    return this.execute('exec', { command, ...opts });
  }

  async webSearch(query, maxResults = 5) {
    return this.execute('web_search', { query, max_results: maxResults });
  }

  async navigate(url) {
    return this.execute('browser', { action: 'navigate', url });
  }

  async readFile(filePath) {
    return this.execute('read', { path: filePath });
  }

  async writeFile(filePath, content) {
    return this.execute('write', { path: filePath, content });
  }

  /**
   * Cierra el navegador de BrowserBridge. Llamar al cerrar la app.
   */
  async closeBrowser() {
    await BrowserBridge.closeBrowser();
  }

  // ── Registro de acciones ────────────────────────────────────────────────────

  _log(entry) {
    this._actionLog.push({ ...entry, ts: Date.now() });
    if (this._actionLog.length > this._maxLog) this._actionLog.shift();
  }

  _err(tool, error, t0) {
    const elapsed = Date.now() - t0;
    this._log({ tool, ok: false, error, elapsed });
    console.warn(`[openclaw] error en ${tool}: ${error}`);
    return { ok: false, result: null, error, tool, elapsed };
  }

  getActionLog(n = 20) {
    return this._actionLog.slice(-n);
  }

  getStats() {
    const total  = this._actionLog.length;
    const ok     = this._actionLog.filter(e => e.ok).length;
    const failed = total - ok;
    const tools  = [...new Set(this._actionLog.map(e => e.tool))];
    return { total, ok, failed, tools, available: this._available };
  }
}

let _instance = null;
function getOpenClawBridge() {
  if (!_instance) _instance = new OpenClawBridge();
  return _instance;
}

module.exports = { OpenClawBridge, getOpenClawBridge };