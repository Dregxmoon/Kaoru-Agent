// @ts-nocheck
'use strict';

// github-handlers.js — IPC para las operaciones de GitHub.
//
// La ventana de chat corre con webSecurity: true, así que window.fetch no
// puede llamar a GitHub (CORS). El renderer pide acá que el proceso principal
// haga la llamada HTTP (sin CORS) y le devuelve la respuesta ya parseada.
// Esto cubre el device flow, el PAT y todas las tools de GitHub del agente.
//
// 'github-fetch'      → { url, init } → { ok, status, statusText, body }
// 'github-client-id'  → resuelve el Client ID (env de main → llavero)

const { ipcMain } = require('electron');

const CLIENT_ID_KEY = 'github_client_id';

function register(ctx) {
  const KeychainManager = ctx.KeychainManager;

  ipcMain.handle('github-fetch', async (_e, { url, init } = {}) => {
    if (!url) throw new Error('github-fetch requiere url');
    const opts = { ...(init || {}) };
    if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof URLSearchParams)) {
      opts.body = JSON.stringify(opts.body);
    }
    const res = await fetch(url, opts);
    const ct = String(res.headers.get('content-type') || '');
    const body = ct.includes('json') ? await res.json() : await res.text();
    return { ok: res.ok, status: res.status, statusText: res.statusText, body };
  });

  ipcMain.handle('github-client-id', async () => {
    if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_ID.trim()) {
      return process.env.GITHUB_CLIENT_ID.trim();
    }
    try {
      const v = KeychainManager.getKey(CLIENT_ID_KEY);
      if (v && v.trim()) return v.trim();
    } catch {}
    return null;
  });

  // Estado de la sesión de GitHub para el panel de settings (§9): si hay
  // token conectado, quién está logueado y si hay client_id para device flow.
  // Nunca devuelve el token.
  ipcMain.handle('github-status', async () => {
    let token = null;
    try {
      token = KeychainManager.getKey('github_token');
    } catch {}
    const gh = require('../core/github/GitHubManager.js').getGitHubManager();
    let login = null;
    if (token) {
      try {
        const who = await gh.whoami();
        login = (who && who.login) || null;
      } catch {}
    }
    return {
      connected: !!token,
      login,
      clientIdSet: !!(await _keychainHas(KeychainManager, CLIENT_ID_KEY)),
    };
  });
}

async function _keychainHas(K, key) {
  try {
    const v = K.getKey(key);
    return !!v && !!v.trim();
  } catch {
    return false;
  }
}

module.exports = { register };
