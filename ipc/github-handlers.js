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
}

module.exports = { register };
