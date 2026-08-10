// @ts-nocheck
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Preload thin del overlay (src/index.html) con sandbox:true.
//
// Con el sandbox de Chromium habilitado, el preload corre en un contexto
// aislado donde SOLO puede require('electron') (contextBridge/ipcRenderer) —
// nada de fs/path/child_process, ni módulos core, ni módulos de la app. Toda
// la lógica Node del overlay vive ahora en el proceso main
// (ipc/overlay-handlers.js) y este preload solo expone la firma
// invoke/send/on con una allowlist local por ventana.
//
// La lista de canales de abajo es el subconjunto del overlay de
// ipc/channel-whitelist.js (que sigue siendo la fuente documentada): si la
// página (o un CDN comprometido) intenta llamar un canal que no está aquí,
// el preload lo rechaza antes de tocar ipcRenderer.
const INVOKE_ALLOWLIST = new Set([
  // Config del modelo / vistas (canales existentes del overlay)
  'gesture-config',
  'get-python-bin',
  'get-model-info',
  'views-get',
  // Capacidades del overlay movidas a main (sandbox:true)
  'overlay-core-sources',
  'overlay-fs-exists',
  'overlay-augment-model',
  'overlay-list-gestures',
  'overlay-tts-stream',
]);

const SEND_ALLOWLIST = new Set([
  'drag-move',
  'drag-start',
  'model-dblclick',
  'model-hover',
  'view-changed',
]);

const ON_ALLOWLIST = new Set(['gesture', 'model-changed', 'set-view', 'speak', 'views-changed']);

function assertAllowed(kind, channel) {
  const list =
    kind === 'invoke' ? INVOKE_ALLOWLIST : kind === 'send' ? SEND_ALLOWLIST : ON_ALLOWLIST;
  if (typeof channel !== 'string' || !list.has(channel)) {
    throw new Error(`[ipc-whitelist] canal '${String(channel)}' no permitido para ${kind}()`);
  }
}

contextBridge.exposeInMainWorld('assistant', {
  invoke: (channel, ...args) => {
    assertAllowed('invoke', channel);
    return ipcRenderer.invoke(channel, ...args);
  },
  send: (channel, ...args) => {
    assertAllowed('send', channel);
    return ipcRenderer.send(channel, ...args);
  },
  on: (channel, listener) => {
    assertAllowed('on', channel);
    const wrapped = (_e, ...args) => listener(_e, ...args);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
});
