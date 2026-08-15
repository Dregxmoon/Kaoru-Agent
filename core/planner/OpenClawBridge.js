// @ts-nocheck
/**
 * OpenClawBridge.js — Fase 3 v2
 *
 * Fix v1 → v2:
 *   browser y web_search ahora se ejecutan con BrowserBridge.js
 *   (Playwright real, headless) en lugar de pasar por el mock HTTP.
 *   El resto de herramientas (exec, read, write, edit, apply_patch,
 *   code_execution) siguen yendo a OpenClaw/mock vía HTTP.
 *
 * Interfaz HTTP entre el asistente y OpenClaw (localhost:18789), más
 * BrowserBridge para navegación real.
 *
 * El asistente decide QUÉ hacer. OpenClaw/BrowserBridge lo ejecutan.
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
const logger = require('../observability/Logger.js');

const http = require('http');
const BrowserBridge = require('./BrowserBridge.js');

// G.1: puerto del servidor de control configurable (OPENCLAW_PORT). El bridge
// lo lee en cada uso para que funcione con el server en puertos alternos
// (tests, despliegues embebidos).
function _openclawPort() {
  const fromEnv = parseInt(process.env.OPENCLAW_PORT, 10);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 18789;
}

function _openclawBase() {
  return `http://127.0.0.1:${_openclawPort()}`;
}

const DEFAULT_TIMEOUT = 30_000;
// FIX Fase 0.1: la key se lee en el momento del request, no al cargar el módulo.
// Core._startOpenClaw() genera la key DESPUÉS de que este módulo ya fue
// require()-do (línea 38 en Core.js) y la entrega vía setApiKey(). Con un
// const de módulo el cliente nunca mandaría el header de auth. Se prefiere el
// store en memoria (setApiKey) sobre el env: Core borra OPENCLAW_API_KEY del
// process del padre (Fase 1) para no dejar la key expuesta en env heredado.
let _apiKeyStore = null;
function setApiKey(key) {
  _apiKeyStore = key || null;
}
function _getApiKey() {
  if (_apiKeyStore) return _apiKeyStore;
  return process.env.OPENCLAW_API_KEY || null;
}

// Herramientas que se resuelven con el navegador propio del asistente,
// no con el servidor HTTP de OpenClaw/mock.
const BROWSER_TOOLS = new Set(['browser', 'web_search']);

// ── Tipos de herramientas y sus schemas (para las que sí van por HTTP) ────────

const TOOL_SCHEMAS = {
  exec: (params) => ({
    tool: 'exec',
    input: {
      command: params.command,
      cwd: params.cwd || undefined,
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
    input: {
      path: params.path,
      old_text: params.old_text ?? params.oldString,
      new_text: params.new_text ?? params.newString,
    },
  }),

  apply_patch: (params) => ({
    tool: 'apply_patch',
    input: { path: params.path, patch: params.patch },
  }),

  code_execution: (params) => ({
    tool: 'code_execution',
    input: { code: params.code, timeout: params.timeout || 10 },
  }),

  grep: (params) => ({
    tool: 'grep',
    input: {
      pattern: params.pattern,
      path: params.path || undefined,
      include: params.include || undefined,
      ignore: params.ignore || undefined,
      max_results: params.max_results || 50,
    },
  }),

  glob: (params) => ({
    tool: 'glob',
    input: { pattern: params.pattern, path: params.path || undefined },
  }),
};

// ── Helper HTTP ───────────────────────────────────────────────────────────────

function postJSON(url, body, timeoutMs = DEFAULT_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const parsed = new URL(url);

    const apiKey = _getApiKey();
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    };
    if (apiKey) {
      headers['X-Api-Key'] = apiKey;
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const options = {
      hostname: parsed.hostname,
      port: Number(parsed.port) || 18789,
      path: parsed.pathname,
      method: 'POST',
      headers,
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
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
      port: Number(parsed.port) || 18789,
      path: parsed.pathname,
      method: 'GET',
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (c) => {
        data += c;
      });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: { raw: data } });
        }
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.on('error', reject);
    req.end();
  });
}

// ── OpenClawBridge ────────────────────────────────────────────────────────────

class OpenClawBridge {
  constructor() {
    this._available = null;
    this._lastPing = 0;
    this._pingInterval = 60_000;
    this._actionLog = [];
    this._maxLog = 200;
    this._sandbox = null;
  }

  // ── Disponibilidad ──────────────────────────────────────────────────────────

  async isAvailable(force = false) {
    const now = Date.now();
    const ttl = this._available ? this._pingInterval : 2000;
    if (!force && this._available !== null && now - this._lastPing < ttl) {
      return this._available;
    }

    try {
      const res = await getJSON(`${_openclawBase()}/health`, 3000);
      this._available = res.status === 200;
      if (res.status === 200) {
        const sandbox = res.body?.sandbox;
        this._sandbox =
          sandbox === 'bwrap' || sandbox === 'disabled'
            ? { enabled: sandbox === 'bwrap', reason: res.body?.sandboxReason || null }
            : null;
      }
    } catch {
      this._available = false;
      this._sandbox = null;
    }

    this._lastPing = now;

    if (!this._available) {
      logger.warn('OpenClawBridge', '[openclaw] no disponible en', _openclawBase());
    } else {
      logger.info('OpenClawBridge', '[openclaw] disponible');
    }

    return this._available;
  }

  resetAvailabilityCache() {
    this._available = null;
    this._lastPing = 0;
    this._sandbox = null;
  }

  // Estado de aislamiento de proceso del server (bwrap), capturado del /health.
  // Devuelve null cuando no hay información (server fuera de línea o health sin
  // el campo sandbox) — los consumidores deben tratar null como "sin aviso".
  getSandboxStatus() {
    return this._sandbox ? { ...this._sandbox } : null;
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
        logger.info(
          'OpenClawBridge',
          `[openclaw] ejecutando vía BrowserBridge: ${tool}`,
          JSON.stringify(params).slice(0, 120)
        );
        const browserResult =
          tool === 'web_search'
            ? await BrowserBridge.executeWebSearch(params)
            : await BrowserBridge.executeBrowserAction(params);

        const elapsed = Date.now() - t0;
        this._log({ tool, params, ok: true, result: browserResult.result, elapsed });
        logger.info(
          'OpenClawBridge',
          `[openclaw] ${tool} completado en ${elapsed}ms (BrowserBridge)`
        );

        return {
          ok: true,
          result: browserResult.result,
          error: browserResult.error || null,
          tool,
          elapsed,
        };
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
    } catch (e) {
      return this._err(tool, `Parámetros inválidos: ${e.message}`, t0);
    }

    logger.info(
      'OpenClawBridge',
      `[openclaw] ejecutando: ${tool}`,
      JSON.stringify(params).slice(0, 120)
    );

    let res;
    try {
      res = await postJSON(`${_openclawBase()}/v1/tool`, body, opts.timeout || DEFAULT_TIMEOUT);
    } catch (e) {
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

    // Edit/apply_patch: el server adjunta oldContent/newContent y las líneas
    // cambiadas para el split visual viejo/actualizado. Se propagan como `meta`
    // para que la UI los pueda pintar sin mezclarlos con lo que ve el LLM
    // (`result` sigue siendo el string de resumen).
    const meta =
      res.body && typeof res.body === 'object' && res.body.oldContent
        ? {
            oldContent: res.body.oldContent,
            newContent: res.body.newContent,
            addedLines: res.body.addedLines,
            removedLines: res.body.removedLines,
          }
        : null;

    this._log({ tool, params, ok: true, result, elapsed });
    logger.info('OpenClawBridge', `[openclaw] ${tool} completado en ${elapsed}ms`);

    return { ok: true, result, meta, error: null, tool, elapsed };
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
    logger.warn('OpenClawBridge', `[openclaw] error en ${tool}: ${error}`);
    return { ok: false, result: null, error, tool, elapsed };
  }

  getActionLog(n = 20) {
    return this._actionLog.slice(-n);
  }

  getStats() {
    const total = this._actionLog.length;
    const ok = this._actionLog.filter((e) => e.ok).length;
    const failed = total - ok;
    const tools = [...new Set(this._actionLog.map((e) => e.tool))];
    return { total, ok, failed, tools, available: this._available };
  }
}

let _instance = null;
function getOpenClawBridge() {
  if (!_instance) _instance = new OpenClawBridge();
  return _instance;
}

module.exports = { OpenClawBridge, getOpenClawBridge, setApiKey };
