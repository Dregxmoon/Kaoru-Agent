// @ts-nocheck
/**
 * LocalToolBridge.js — puente local de herramientas de Kaoru
 *
 * Fix v1 → v2:
 *   browser y web_search ahora se ejecutan con BrowserBridge.js
 *   (Playwright real, headless) en lugar de pasar por el mock HTTP.
 *   El resto de herramientas (exec, read, write, edit, apply_patch,
 *   code_execution) van al host local de Kaoru vía HTTP autenticado.
 *
 * Interfaz HTTP entre Kaoru y su host local de herramientas, más
 * BrowserBridge para navegación real.
 *
 * El agente propone QUÉ hacer. Las políticas autorizan y los bridges lo ejecutan.
 *
 * Herramientas disponibles:
 *   exec           — comandos shell (vía host local)
 *   browser        — navegación real (vía BrowserBridge / Playwright)
 *   web_search     — búsqueda real (vía BrowserBridge / Playwright)
 *   read           — leer archivos (vía host local)
 *   write          — escribir archivos (vía host local)
 *   edit           — modificar archivos (vía host local)
 *   apply_patch    — parches multi-bloque (vía host local)
 *   code_execution — ejecutar Python (vía host local)
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
const { getDesktopControl, SITE_ALIASES, _normalize } = require('../desktop/DesktopControl.js');
const { getDesktopAutomation } = require('../desktop/DesktopAutomation.js');
const { WebsiteResolver } = require('../desktop/WebsiteResolver.js');
const { isUrlSafe } = require('../security/UrlGuard.js');

// ── Resolución de destinos web (Fase A1 + P0) ───────────────────────────────
// Tubo único compartido con DesktopControl (`core/desktop/WebsiteResolver.js`):
// URL https → alias conocido (atajo, no lista blanca) → búsqueda real con
// scoring de relevancia + UrlGuard. Ningún destino queda hardcodeado.

// G.1: puerto del servidor de control configurable (OPENCLAW_PORT). El bridge
// lo lee en cada uso para que funcione con el server en puertos alternos
// (tests, despliegues embebidos).
function _localToolPort() {
  const fromEnv = parseInt(process.env.KAORU_TOOL_HOST_PORT || process.env.OPENCLAW_PORT, 10);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 18789;
}

function _localToolBase() {
  return `http://127.0.0.1:${_localToolPort()}`;
}

const DEFAULT_TIMEOUT = 30_000;
// FIX Fase 0.1: la key se lee en el momento del request, no al cargar el módulo.
// El ciclo de vida del host genera la key DESPUÉS de que este módulo ya fue
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
// no con el host HTTP local.
const BROWSER_TOOLS = new Set(['browser', 'web_search']);
const DESKTOP_TOOLS = new Set([
  'list_apps',
  'launch_app',
  'open_website',
  'play_media',
  'desktop_snapshot',
  'desktop_screenshot',
  'pointer_click',
  'window_list',
  'window_focus',
  'ui_get_state',
  'ui_wait',
  'ui_click',
  'ui_type',
  'ui_press',
  'ui_select',
  'ui_scroll',
  'window_close',
  'desktop_capabilities',
  'process_list',
  'process_stop',
  'camera_status',
  'open_camera',
]);

const DESKTOP_ACTIONS = {
  window_focus: 'focus',
  ui_click: 'click',
  ui_type: 'type',
  ui_press: 'press',
  ui_select: 'select',
  ui_scroll: 'scroll',
  window_close: 'close',
};

function _safeLogParams(tool, params) {
  const safe = { ...params };
  if (Object.prototype.hasOwnProperty.call(safe, 'value')) {
    safe.valueLength = String(safe.value ?? '').length;
    delete safe.value;
  }
  if (tool === 'play_media' || tool === 'web_search') {
    safe.queryLength = String(safe.query ?? '').length;
    delete safe.query;
  }
  for (const field of ['url', 'target']) {
    if (typeof safe[field] !== 'string') continue;
    try {
      const parsed = new URL(safe[field]);
      parsed.search = '';
      parsed.hash = '';
      safe[field] = parsed.href;
    } catch (_) {}
  }
  return safe;
}

function _safeBrowserLogResult(result) {
  if (!result || typeof result !== 'object') return result;
  const { dataUrl: _discarded, ...safe } = result;
  for (const field of ['url', 'previousUrl']) {
    if (typeof safe[field] !== 'string') continue;
    try {
      const parsed = new URL(safe[field]);
      parsed.search = '';
      parsed.hash = '';
      safe[field] = parsed.href;
    } catch (_) {}
  }
  if (Array.isArray(safe.tabs)) {
    safe.tabs = safe.tabs.map((tab) => _safeBrowserLogResult(tab));
  }
  return safe;
}

function _failureClass(error) {
  const text = String(error || '').toLowerCase();
  if (/captcha|verificaci[oó]n humana/.test(text)) return 'human_challenge';
  if (/obsolet|expir|cambi[oó] o ya no existe/.test(text)) return 'stale_observation';
  if (/timeout|agot[oó]/.test(text)) return 'timeout';
  if (/aprobaci[oó]n|permiso|deneg/.test(text)) return 'permission';
  if (/aplicaci[oó]n no encontrada|ejecutable no encontrado/.test(text)) return 'app_not_found';
  if (/selector|elemento|localizador|control/.test(text)) return 'target_not_found';
  if (/at-spi|ui automation|backend|runtime electron/.test(text)) return 'backend_unavailable';
  if (/url bloqueada|destino no seguro|protocolo/.test(text)) return 'network_policy';
  return 'execution_error';
}

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
      reject(new Error(`Motor local de Kaoru: timeout después de ${timeoutMs}ms`));
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

// ── LocalToolBridge ───────────────────────────────────────────────────────────

class LocalToolBridge {
  constructor(options = {}) {
    this._available = null;
    this._lastPing = 0;
    this._pingInterval = 60_000;
    this._actionLog = [];
    this._maxLog = 200;
    this._sandbox = null;
    this._desktopControl = options.desktopControl || getDesktopControl();
    this._desktopAutomation = options.desktopAutomation || getDesktopAutomation();
    this._mediaResolver = options.mediaResolver || BrowserBridge.findFirstYouTubeVideo;
    this._mediaPlayer = options.mediaPlayer || BrowserBridge.playYouTubeMedia;
    this._browserPreferences = { mediaControl: null, preferred: 'default' };
    // Inyectable para tests del guard verificar ⇒ managed (producción: Playwright real).
    this._managedNavigator =
      options.managedNavigator || ((input) => BrowserBridge.executeBrowserAction(input));
    // Inyectables solo para tests; en producción caen a BrowserBridge/UrlGuard reales.
    this._webSearch = options.webSearch || BrowserBridge.executeWebSearch;
    this._websiteUrlGuard = options.urlGuard || isUrlSafe;
    this._websiteResolver = new WebsiteResolver({
      aliases: SITE_ALIASES,
      webSearch: this._webSearch,
      urlGuard: this._websiteUrlGuard,
    });
    // P0: el mismo contrato en ambas capas. Si el control de escritorio admite
    // resolver, se le inyecta este resolver para que `DesktopControl` directo
    // resuelva igual que el bridge (sin doble búsqueda: el bridge pre-resuelve
    // a URL https y el control la toma directa).
    if (
      this._desktopControl &&
      typeof this._desktopControl.setWebsiteResolver === 'function' &&
      typeof this._desktopControl.getWebsiteResolver === 'function' &&
      !this._desktopControl.getWebsiteResolver()
    ) {
      this._desktopControl.setWebsiteResolver(this._websiteResolver);
    }
  }

  /** @param {string} rawTarget */
  _resolveWebsiteTarget(rawTarget) {
    return this._websiteResolver.resolve(rawTarget);
  }

  /**
   * Preferencias de TLD del usuario (p.ej. ['mx','es'] desde su idioma) para
   * el scoring del resolver. Lo llama AgentLoop por run; el resolver
   * compartido beneficia a bridge y DesktopControl a la vez.
   * @param {string[]} [hints]
   */
  setLocaleHints(hints) {
    if (this._websiteResolver && typeof this._websiteResolver.setLocaleHints === 'function') {
      this._websiteResolver.setLocaleHints(hints);
    }
  }

  /** La preferencia del usuario prevalece sobre la propuesta del modelo. */
  setBrowserPreferences(preferences = {}) {
    const mediaControl = String(preferences.mediaControl || '').toLowerCase();
    const preferred = String(preferences.preferred || 'default').toLowerCase();
    this._browserPreferences = {
      mediaControl: ['external', 'managed'].includes(mediaControl) ? mediaControl : null,
      preferred: ['default', 'brave', 'chrome', 'chromium', 'edge', 'firefox'].includes(preferred)
        ? preferred
        : 'default',
    };
  }

  /** Normaliza la acción antes del permiso para que el consentimiento describa la ejecución real. */
  applyUserPreferences(action) {
    if (!action || action.tool !== 'play_media' || !this._browserPreferences.mediaControl) {
      return action;
    }
    const external = this._browserPreferences.mediaControl === 'external';
    return {
      ...action,
      params: {
        ...(action.params || {}),
        control: this._browserPreferences.mediaControl,
        browser:
          external && this._browserPreferences.preferred !== 'default'
            ? this._browserPreferences.preferred
            : undefined,
      },
    };
  }

  /** Referencia interna para ligar permisos de misión a la aplicación observada. */
  getDesktopAutomation() {
    return this._desktopAutomation;
  }

  // ── Disponibilidad ──────────────────────────────────────────────────────────

  async isAvailable(force = false) {
    const now = Date.now();
    const ttl = this._available ? this._pingInterval : 2000;
    if (!force && this._available !== null && now - this._lastPing < ttl) {
      return this._available;
    }

    try {
      const res = await getJSON(`${_localToolBase()}/health`, 3000);
      this._available = res.status === 200;
      if (res.status === 200) {
        const sandbox = res.body?.sandbox;
        this._sandbox =
          sandbox === 'bwrap' || sandbox === 'appcontainer' || sandbox === 'disabled'
            ? { enabled: sandbox !== 'disabled', reason: res.body?.sandboxReason || null }
            : null;
      }
    } catch {
      this._available = false;
      this._sandbox = null;
    }

    this._lastPing = now;

    if (!this._available) {
      logger.warn('LocalToolBridge', '[local-tools] no disponible en', _localToolBase());
    } else {
      logger.info('LocalToolBridge', '[local-tools] disponible');
    }

    return this._available;
  }

  resetAvailabilityCache() {
    this._available = null;
    this._lastPing = 0;
    this._sandbox = null;
  }

  // Estado de aislamiento de proceso del server (bwrap/AppContainer),
  // capturado del /health.
  // Devuelve null cuando no hay información (server fuera de línea o health sin
  // el campo sandbox) — los consumidores deben tratar null como "sin aviso".
  getSandboxStatus() {
    return this._sandbox ? { ...this._sandbox } : null;
  }

  // ── Ejecución principal ─────────────────────────────────────────────────────

  /**
   * Ejecuta una herramienta. Despacha a BrowserBridge (Playwright) para
   * browser/web_search, o al host HTTP local para el resto.
   */
  async execute(tool, params = {}, opts = {}) {
    const t0 = Date.now();

    // Estas tools controlan el escritorio visible local y no dependen del
    // proceso HTTP local. La aprobación ocurre antes, en AgentLoop.
    if (DESKTOP_TOOLS.has(tool)) {
      try {
        let desktopResult;
        let resolvedTargetInfo = null;
        let forcedManaged = false;
        if (tool === 'open_website' && params && params.target) {
          // Resolución en runtime (Fase A1): reemplaza el target crudo por
          // una URL https ya resuelta (alias o búsqueda) antes de decidir
          // managed vs external. El resto del código sigue viendo una URL,
          // como antes — no rompe el flujo existente, solo elimina el
          // callejón sin salida de "sitio no reconocido".
          const resolved = await this._resolveWebsiteTarget(params.target);
          resolvedTargetInfo = resolved;
          params = { ...params, target: resolved.url };
          // Guard determinista verificar ⇒ managed: si hay que leer o
          // comprobar algo dentro de la página, external (navegador personal
          // ciego) no puede cumplirlo. El MODELO lo pide por inferencia
          // (needsVerification, en cualquier idioma); el bridge lo impone.
          if (
            params.needsVerification === true &&
            (params.control !== 'managed' || params.browser)
          ) {
            params = { ...params, control: 'managed', browser: undefined };
            forcedManaged = true;
          }
        }
        if (tool === 'desktop_snapshot') {
          desktopResult = await this._desktopAutomation.snapshot(params);
        } else if (tool === 'desktop_screenshot') {
          desktopResult = await this._desktopAutomation.screenshot(params);
        } else if (tool === 'pointer_click') {
          desktopResult = await this._desktopAutomation.pointerClick(params);
        } else if (tool === 'window_list') {
          desktopResult = await this._desktopAutomation.listWindows(params);
        } else if (tool === 'ui_get_state') {
          desktopResult = this._desktopAutomation.getState(params);
        } else if (tool === 'ui_wait') {
          desktopResult = await this._desktopAutomation.waitFor(params);
        } else if (DESKTOP_ACTIONS[tool]) {
          desktopResult = await this._desktopAutomation.execute(DESKTOP_ACTIONS[tool], params);
        } else if (tool === 'open_website' && params.control === 'managed' && !params.browser) {
          const rawTarget = String(params.target || '').trim();
          const candidate = SITE_ALIASES[_normalize(rawTarget)] || rawTarget;
          let parsed;
          try {
            parsed = new URL(candidate);
          } catch (_) {
            throw new Error('Usa un sitio conocido o una URL HTTPS completa');
          }
          if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
            throw new Error('El navegador administrado solo admite URLs HTTPS sin credenciales');
          }
          const navigated = await this._managedNavigator({
            action: 'navigate',
            mode: 'managed',
            url: parsed.href,
          });
          desktopResult = {
            kind: 'website',
            browser: 'kaoru-managed-chromium',
            ...navigated.result,
          };
        } else if (tool === 'play_media') {
          const service = String(params.service || 'youtube')
            .trim()
            .toLowerCase();
          const query = String(params.query || '').trim();
          if (service !== 'youtube')
            throw new Error(`Servicio multimedia no permitido: ${service}`);
          if (!query || query.length > 200)
            throw new Error('play_media requiere una consulta válida');
          if ([...query].some((character) => character.charCodeAt(0) < 32)) {
            throw new Error('La consulta multimedia contiene caracteres no permitidos');
          }
          const control = String(
            this._browserPreferences.mediaControl || params.control || 'managed'
          ).toLowerCase();
          if (!['managed', 'external'].includes(control)) {
            throw new Error(`Modo de control multimedia no permitido: ${control}`);
          }
          const playback =
            control === 'managed'
              ? await this._mediaPlayer(query)
              : {
                  kind: 'media',
                  service,
                  query,
                  url: await this._mediaResolver(query),
                  browser: this._browserPreferences.preferred,
                  playing: false,
                  verified: false,
                };
          const mediaUrl = new URL(playback.url);
          if (
            mediaUrl.protocol !== 'https:' ||
            mediaUrl.hostname !== 'www.youtube.com' ||
            mediaUrl.pathname !== '/watch' ||
            !/^[A-Za-z0-9_-]{6,20}$/.test(mediaUrl.searchParams.get('v') || '')
          ) {
            throw new Error('El resolver multimedia devolvió un destino no permitido');
          }
          mediaUrl.searchParams.set('autoplay', '1');
          if (control === 'external') {
            const preferredBrowser =
              this._browserPreferences.preferred !== 'default'
                ? this._browserPreferences.preferred
                : undefined;
            const opened = await this._desktopControl.execute('open_website', {
              target: mediaUrl.href,
              browser: preferredBrowser,
            });
            desktopResult = {
              ...playback,
              url: mediaUrl.href,
              openedUrl: opened.url,
              browser: opened.browser,
              autoplayRequested: true,
              opened: true,
              requiresUserAction: true,
            };
          } else {
            if (!playback.playing || !playback.verified) {
              throw new Error(
                'El navegador administrado quedó abierto, pero no pudo verificar la reproducción'
              );
            }
            desktopResult = { ...playback, url: mediaUrl.href, autoplayRequested: true };
          }
        } else {
          desktopResult = await this._desktopControl.execute(tool, params);
          if (tool === 'launch_app' && desktopResult?.kind === 'application' && desktopResult.app) {
            const windowEvidence = await this._desktopAutomation.waitForWindow({
              application: desktopResult.app,
              timeout: 8000,
            });
            desktopResult = {
              ...desktopResult,
              verified: windowEvidence.verified,
              status: windowEvidence.verified ? 'completed' : 'spawned_unverified',
              windowEvidence,
            };
          }
        }
        if (tool === 'open_website' && resolvedTargetInfo && desktopResult) {
          desktopResult = {
            ...desktopResult,
            ...(forcedManaged ? { forcedManaged: true } : {}),
            resolvedBy: resolvedTargetInfo.resolvedBy,
            ...(resolvedTargetInfo.resolvedBy === 'search'
              ? {
                  resolvedFromQuery: resolvedTargetInfo.query,
                  ...(typeof resolvedTargetInfo.score === 'number'
                    ? { score: resolvedTargetInfo.score }
                    : {}),
                  ...(resolvedTargetInfo.cached === true ? { cached: true } : {}),
                }
              : {}),
          };
        }
        const elapsed = Date.now() - t0;
        let logResult =
          tool === 'desktop_snapshot' ||
          tool === 'desktop_screenshot' ||
          tool === 'window_list' ||
          tool === 'ui_get_state'
            ? { kind: desktopResult.kind, nodeCount: desktopResult.nodes?.length || 0 }
            : desktopResult;
        if (tool === 'play_media' && logResult && typeof logResult === 'object') {
          const { query: _privateQuery, ...safeMediaResult } = logResult;
          logResult = safeMediaResult;
        }
        this._log({ tool, ok: true, result: logResult, elapsed });
        return { ok: true, result: desktopResult, error: null, tool, elapsed };
      } catch (error) {
        return this._err(tool, error instanceof Error ? error.message : String(error), t0);
      }
    }

    // ── browser / web_search → BrowserBridge (Playwright real) ───────────────
    if (BROWSER_TOOLS.has(tool)) {
      try {
        logger.info(
          'LocalToolBridge',
          `[local-tools] ejecutando vía BrowserBridge: ${tool}`,
          JSON.stringify(params).slice(0, 120)
        );
        const browserResult =
          tool === 'web_search'
            ? await BrowserBridge.executeWebSearch(params)
            : await BrowserBridge.executeBrowserAction(params);

        const elapsed = Date.now() - t0;
        this._log({
          tool,
          params: _safeLogParams(tool, params),
          ok: true,
          result: _safeBrowserLogResult(browserResult.result),
          elapsed,
        });
        logger.info(
          'LocalToolBridge',
          `[local-tools] ${tool} completado en ${elapsed}ms (BrowserBridge)`
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

    // ── resto de herramientas → host HTTP local ──────────────────────────────
    const builder = TOOL_SCHEMAS[tool];
    if (!builder) {
      return this._err(tool, `Herramienta desconocida: ${tool}`, t0);
    }

    const available = await this.isAvailable();
    if (!available) {
      return this._err(tool, 'El motor local de herramientas de Kaoru no está disponible.', t0);
    }

    let body;
    try {
      body = builder(params);
    } catch (e) {
      return this._err(tool, `Parámetros inválidos: ${e.message}`, t0);
    }

    logger.info(
      'LocalToolBridge',
      `[local-tools] ejecutando: ${tool}`,
      JSON.stringify(params).slice(0, 120)
    );

    let res;
    try {
      res = await postJSON(`${_localToolBase()}/v1/tool`, body, opts.timeout || DEFAULT_TIMEOUT);
    } catch (e) {
      this._available = false;
      return this._err(tool, `Error de red: ${e.message}`, t0);
    }

    const elapsed = Date.now() - t0;

    if (res.status !== 200) {
      const errMsg = res.body?.error || res.body?.message || `HTTP ${res.status}`;
      const failureClass = _failureClass(errMsg);
      this._log({
        tool,
        params: _safeLogParams(tool, params),
        ok: false,
        error: errMsg,
        failureClass,
        elapsed,
      });
      return { ok: false, result: null, error: errMsg, failureClass, tool, elapsed };
    }

    const result = res.body?.result ?? res.body;

    // Edit/apply_patch (y write desde F: vista previa de diff): el server
    // adjunta oldContent/newContent y las líneas cambiadas para el split
    // visual viejo/actualizado. Se propagan como `meta` para que la UI los
    // pueda pintar sin mezclarlos con lo que ve el LLM (`result` sigue siendo
    // el string de resumen). Se usa hasOwnProperty porque oldContent puede ser
    // '' (write a archivo nuevo): con un truthy-check se perdería el meta.
    const hasMeta =
      res.body &&
      typeof res.body === 'object' &&
      Object.prototype.hasOwnProperty.call(res.body, 'oldContent');
    const meta = hasMeta
      ? {
          oldContent: res.body.oldContent,
          newContent: res.body.newContent,
          patch: res.body.patch,
          addedLines: res.body.addedLines,
          removedLines: res.body.removedLines,
        }
      : null;

    this._log({ tool, params: _safeLogParams(tool, params), ok: true, result, elapsed });
    logger.info('LocalToolBridge', `[local-tools] ${tool} completado en ${elapsed}ms`);

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
    const failureClass = _failureClass(error);
    this._log({ tool, ok: false, error, failureClass, elapsed });
    logger.warn('LocalToolBridge', `[local-tools] error en ${tool}: ${error}`);
    return { ok: false, result: null, error, failureClass, tool, elapsed };
  }

  getActionLog(n = 20) {
    return this._actionLog.slice(-n);
  }

  getStats() {
    const total = this._actionLog.length;
    const ok = this._actionLog.filter((e) => e.ok).length;
    const failed = total - ok;
    const tools = [...new Set(this._actionLog.map((e) => e.tool))];
    const failures = {};
    const byTool = {};
    for (const entry of this._actionLog) {
      const toolStats = byTool[entry.tool] || { total: 0, ok: 0, failed: 0, successRate: 0 };
      toolStats.total++;
      if (entry.ok) toolStats.ok++;
      else toolStats.failed++;
      toolStats.successRate = toolStats.total ? toolStats.ok / toolStats.total : 0;
      byTool[entry.tool] = toolStats;
      if (!entry.failureClass) continue;
      failures[entry.failureClass] = (failures[entry.failureClass] || 0) + 1;
    }
    return { total, ok, failed, tools, failures, byTool, available: this._available };
  }
}

let _instance = null;
function getLocalToolBridge() {
  if (!_instance) _instance = new LocalToolBridge();
  return _instance;
}

// Alias temporales para plugins y módulos de versiones anteriores.
const OpenClawBridge = LocalToolBridge;
const getOpenClawBridge = getLocalToolBridge;

module.exports = {
  LocalToolBridge,
  getLocalToolBridge,
  OpenClawBridge,
  getOpenClawBridge,
  setApiKey,
  _failureClass,
};
