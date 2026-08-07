// @ts-nocheck
'use strict';

// net.js — Transport de red para los módulos de GitHub.
//
// La ventana de chat corre con webSecurity: true (main.js), así que
// window.fetch NO puede llamar a https://github.com (CORS de origen file://).
// En Node/Electron main no hay CORS, pero en el renderer sí.
//
// Solución: si estamos en un renderer con ipcRenderer disponible, devolvemos
// un fetch que hace la llamada en el proceso principal vía IPC ('github-fetch').
// En cualquier otro contexto (Node, Electron RUN_AS_NODE, main) devolvemos
// null para que el caller use globalThis.fetch directamente.

let _cached = null;

function getRendererFetch() {
  if (_cached !== null) return _cached;
  _cached = null;
  try {
    // require('electron') en Node puro / ELECTRON_RUN_AS_NODE devuelve la
    // ruta al binario (un string) → .ipcRenderer es undefined → null.
    const electron = require('electron');
    if (!electron || !electron.ipcRenderer || typeof electron.ipcRenderer.invoke !== 'function') {
      return null;
    }
    _cached = async (url, init) => {
      const opts = { ...(init || {}) };
      // URLSearchParams no se clona bien por IPC; lo pasamos como string
      // (el Content-Type ya es application/x-www-form-urlencoded).
      if (opts.body && typeof opts.body === 'object' && opts.body instanceof URLSearchParams) {
        opts.body = opts.body.toString();
      }
      const res = await electron.ipcRenderer.invoke('github-fetch', { url, init: opts });
      if (!res || typeof res.ok !== 'boolean') {
        throw new Error(`github-fetch IPC falló para ${url}`);
      }
      return {
        ok: res.ok,
        status: res.status,
        statusText: res.statusText || '',
        json: async () => res.body,
        text: async () => (typeof res.body === 'string' ? res.body : JSON.stringify(res.body)),
      };
    };
  } catch {
    _cached = null;
  }
  return _cached;
}

module.exports = { getRendererFetch };
