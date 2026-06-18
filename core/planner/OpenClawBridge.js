/**
 * OpenClawBridge.js — Fase 3
 *
 * Interfaz HTTP entre March y OpenClaw (localhost:18789).
 *
 * March decide QUÉ hacer. OpenClaw lo ejecuta. Esta separación es no negociable.
 * El Bridge solo traduce entre el mundo de March y la API de OpenClaw.
 *
 * Herramientas disponibles en OpenClaw:
 *   exec        — ejecutar comandos shell, gestionar procesos
 *   browser     — controlar navegador (navegar, clic, screenshots)
 *   web_search  — buscar en la web, obtener contenido de páginas
 *   read        — leer archivos del workspace
 *   write       — escribir archivos del workspace
 *   edit        — modificar archivos existentes
 *   apply_patch — modificar código con parches multi-bloque
 *   code_execution — ejecutar Python en sandbox
 *   tts         — texto a voz (independiente del TTS de March)
 *   cron        — tareas programadas
 *
 * Contrato de respuesta de execute():
 * {
 *   ok:      boolean   — la herramienta respondió sin error HTTP
 *   result:  any       — resultado crudo de OpenClaw
 *   error:   string    — mensaje de error si !ok
 *   tool:    string    — herramienta que se usó
 *   elapsed: number    — ms que tardó la llamada
 * }
 */

'use strict';

const http = require('http');

const OPENCLAW_BASE   = 'http://127.0.0.1:18789';
const DEFAULT_TIMEOUT = 30_000; // 30s — comandos shell pueden tardar

// ── Tipos de herramientas y sus schemas ───────────────────────────────────────

/**
 * Mapa de herramienta → cómo construir el body para OpenClaw.
 * Cada entrada es una función (params) → body para POST /v1/tool.
 */
const TOOL_SCHEMAS = {
  /**
   * exec — ejecutar un comando shell.
   * params: { command: string, cwd?: string, timeout?: number }
   */
  exec: (params) => ({
    tool: 'exec',
    input: {
      command: params.command,
      cwd:     params.cwd     || undefined,
      timeout: params.timeout || 15,
    },
  }),

  /**
   * web_search — buscar en la web.
   * params: { query: string, max_results?: number }
   */
  web_search: (params) => ({
    tool: 'web_search',
    input: {
      query:       params.query,
      max_results: params.max_results || 5,
    },
  }),

  /**
   * browser — controlar el navegador.
   * params: { action: 'navigate'|'click'|'screenshot'|'get_text', url?: string, selector?: string }
   */
  browser: (params) => ({
    tool: 'browser',
    input: params,
  }),

  /**
   * read — leer un archivo.
   * params: { path: string, encoding?: string }
   */
  read: (params) => ({
    tool: 'read',
    input: {
      path:     params.path,
      encoding: params.encoding || 'utf-8',
    },
  }),

  /**
   * write — escribir un archivo.
   * params: { path: string, content: string, encoding?: string }
   */
  write: (params) => ({
    tool: 'write',
    input: {
      path:     params.path,
      content:  params.content,
      encoding: params.encoding || 'utf-8',
    },
  }),

  /**
   * edit — modificar parte de un archivo existente.
   * params: { path: string, old_text: string, new_text: string }
   */
  edit: (params) => ({
    tool: 'edit',
    input: {
      path:     params.path,
      old_text: params.old_text,
      new_text: params.new_text,
    },
  }),

  /**
   * apply_patch — parche multi-bloque estilo diff.
   * params: { path: string, patch: string }
   */
  apply_patch: (params) => ({
    tool: 'apply_patch',
    input: {
      path:  params.path,
      patch: params.patch,
    },
  }),

  /**
   * code_execution — ejecutar Python en sandbox.
   * params: { code: string, timeout?: number }
   */
  code_execution: (params) => ({
    tool: 'code_execution',
    input: {
      code:    params.code,
      timeout: params.timeout || 10,
    },
  }),
};

// ── Helper HTTP ───────────────────────────────────────────────────────────────

function postJSON(url, body, timeoutMs = DEFAULT_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const parsed  = new URL(url);

    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || 18789,
      path:     parsed.pathname,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          // OpenClaw puede devolver texto plano en errores
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
      port:     parsed.port || 18789,
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
    this._available    = null;  // null = no chequeado aún
    this._lastPing     = 0;
    this._pingInterval = 60_000; // re-chequear disponibilidad cada 60s
    this._actionLog    = [];    // registro inmutable de acciones ejecutadas
    this._maxLog       = 200;
  }

  // ── Disponibilidad ──────────────────────────────────────────────────────────

  /**
   * Chequea si OpenClaw está corriendo.
   * Cachea el resultado por _pingInterval ms para no saturar.
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    const now = Date.now();
    if (this._available !== null && (now - this._lastPing) < this._pingInterval) {
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

  /**
   * Fuerza re-chequeo en el próximo isAvailable().
   */
  resetAvailabilityCache() {
    this._available = null;
    this._lastPing  = 0;
  }

  // ── Ejecución principal ─────────────────────────────────────────────────────

  /**
   * Ejecuta una herramienta de OpenClaw.
   *
   * @param {string} tool     — nombre de la herramienta (exec, web_search, browser...)
   * @param {object} params   — parámetros específicos de la herramienta
   * @param {object} [opts]
   * @param {number} [opts.timeout]       — ms máximo de espera (default: 30000)
   * @param {boolean} [opts.requireConfirm] — si true, el caller debe confirmar antes de llamar aquí
   *
   * @returns {Promise<{ok, result, error, tool, elapsed}>}
   */
  async execute(tool, params = {}, opts = {}) {
    const t0 = Date.now();

    // Validar herramienta
    const builder = TOOL_SCHEMAS[tool];
    if (!builder) {
      return this._err(tool, `Herramienta desconocida: ${tool}`, t0);
    }

    // Chequear disponibilidad
    const available = await this.isAvailable();
    if (!available) {
      return this._err(tool, 'OpenClaw no está corriendo. Inícialo en localhost:18789.', t0);
    }

    // Construir body
    let body;
    try {
      body = builder(params);
    } catch(e) {
      return this._err(tool, `Parámetros inválidos: ${e.message}`, t0);
    }

    console.log(`[openclaw] ejecutando: ${tool}`, JSON.stringify(params).slice(0, 120));

    // Llamar a OpenClaw
    let res;
    try {
      res = await postJSON(`${OPENCLAW_BASE}/v1/tool`, body, opts.timeout || DEFAULT_TIMEOUT);
    } catch(e) {
      this._available = false; // marcar como no disponible
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

  /**
   * Ejecutar un comando shell.
   * @param {string} command
   * @param {object} [opts] — { cwd, timeout }
   */
  async exec(command, opts = {}) {
    return this.execute('exec', { command, ...opts });
  }

  /**
   * Buscar en la web.
   * @param {string} query
   * @param {number} [maxResults]
   */
  async webSearch(query, maxResults = 5) {
    return this.execute('web_search', { query, max_results: maxResults });
  }

  /**
   * Navegar a una URL.
   * @param {string} url
   */
  async navigate(url) {
    return this.execute('browser', { action: 'navigate', url });
  }

  /**
   * Leer un archivo.
   * @param {string} filePath
   */
  async readFile(filePath) {
    return this.execute('read', { path: filePath });
  }

  /**
   * Escribir un archivo.
   * @param {string} filePath
   * @param {string} content
   */
  async writeFile(filePath, content) {
    return this.execute('write', { path: filePath, content });
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

  /**
   * Retorna el log de acciones ejecutadas (últimas N).
   * @param {number} [n]
   */
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

// Singleton — un solo bridge por proceso
let _instance = null;
function getOpenClawBridge() {
  if (!_instance) _instance = new OpenClawBridge();
  return _instance;
}

module.exports = { OpenClawBridge, getOpenClawBridge };
