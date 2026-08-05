'use strict';

// OAuthDeviceFlow.js — Flujo de autorización de dispositivo de GitHub (RFC 8628).
//
// Es el estándar para apps de escritorio/CLI: el usuario autoriza desde el
// navegador SIN exponer un client_secret (en este flujo solo se usa el
// client_id, que es público). Ideal para distribuir:
//   1. start()  → POST /login/device/code (client_id, scope)
//                   devuelve device_code + user_code + verification_uri.
//   2. abrir el navegador en verification_uri_complete (el código va prefilled).
//   3. poll()   → POST /login/oauth/access_token hasta que el usuario autoriza.
//
// Transport inyectable (this._fetch) para testear sin red real.

const { getRendererFetch } = require('./net.js');

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
const DEFAULT_SCOPE = 'repo read:user';

function _jsonHeaders(extra = {}) {
  return {
    Accept: 'application/json',
    'User-Agent': 'Asistente-Vtuber',
    ...extra,
  };
}

class OAuthDeviceFlow {
  constructor(opts = {}) {
    this._clientId = opts.clientId || null;
    const f = opts.fetch || getRendererFetch() || globalThis.fetch;
    if (typeof f !== 'function') {
      throw new Error('OAuthDeviceFlow necesita fetch (Node 18+/Electron 28+).');
    }
    // En el renderer, window.fetch exige this === window; si lo guardamos
    // desligado y lo llamamos como this._fetch(...) → "Illegal invocation".
    // Forzamos el receptor correcto en ambos entornos (Node ignora el `this`).
    this._fetch = (url, init) => f.call(globalThis, url, init);
    if (!this._clientId) {
      throw new Error('OAuthDeviceFlow necesita un clientId de una GitHub OAuth App.');
    }
  }

  async start(scope = DEFAULT_SCOPE) {
    const body = new URLSearchParams({ client_id: this._clientId, scope });
    const res = await this._fetch(DEVICE_CODE_URL, {
      method: 'POST',
      headers: _jsonHeaders({ 'Content-Type': 'application/x-www-form-urlencoded' }),
      body,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.device_code) {
      const err = new Error(data.error_description || data.error || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return {
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      // GitHub ya devuelve la URI con el código pre-cargado; si no, lo armamos.
      verificationUriComplete:
        data.verification_uri_complete ||
        (data.verification_uri
          ? `${data.verification_uri}?user_code=${encodeURIComponent(data.user_code)}`
          : null),
      expiresIn: data.expires_in,
      interval: data.interval,
    };
  }

  async poll(deviceCode) {
    const body = new URLSearchParams({
      client_id: this._clientId,
      device_code: deviceCode,
      grant_type: GRANT_TYPE,
    });
    const res = await this._fetch(ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: _jsonHeaders({ 'Content-Type': 'application/x-www-form-urlencoded' }),
      body,
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.access_token) {
      return {
        ok: true,
        accessToken: data.access_token,
        tokenType: data.token_type,
        scope: data.scope,
      };
    }
    // Errores del estándar: authorization_pending, slow_down, expired_token,
    // access_denied (y cualquiera que GitHub agregue).
    return {
      ok: false,
      error: data.error || 'unknown_error',
      errorDescription: data.error_description || null,
    };
  }
}

module.exports = { OAuthDeviceFlow, DEVICE_CODE_URL, ACCESS_TOKEN_URL, DEFAULT_SCOPE };
