// @ts-nocheck
'use strict';

// Preload del overlay (src/index.html).
//
// Sandbox: la página corre con contextIsolation:true y nodeIntegration:false.
// Todo el acceso a Node (fs, child_process, módulos core) vive aquí y se
// expone de forma acotada vía contextBridge como window.assistant. Los
// scripts remotos (pixi.js, live2dcubismcore) cargan en la página SIN acceso
// a Node: si un CDN se compromete, ya no pueden tocar el sistema.

const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');
const fs = require('fs');
const cp = require('child_process');

const { assertAllowed } = require('../ipc/channel-whitelist.js');

const ModelAugmenter = require('../core/behavior/ModelAugmenter.js');

// Bridge acotado: la página del overlay SOLO recibe las funciones concretas
// que usa (augmentModel para el modelo 3D y listGestures para el
// GestureEngine cargado en la página). NUNCA el módulo completo — así la
// página (y los CDN) no pueden llegar a resetCache ni a otros internos.
function _boundedModelAugmenter() {
  return {
    augmentModel: (model3Path) => ModelAugmenter.augmentModel(model3Path),
    listGestures: (model3Path) => ModelAugmenter.listGestures(model3Path),
  };
}

// Fuente de los módulos core que la página necesita EJECUTAR en su propio
// mundo (GestureEngine): el engine recibe el objeto Live2D real creado por
// PIXI en la página, que no puede cruzar el contextBridge (copia profunda
// inviable) y que tampoco admite `new` sobre proxies del bridge. La página
// los carga con un loader mínimo que SOLO puede resolver estos nombres —
// nada de esto expone Node/fs/child_process a la página ni a los CDN.
const coreBehaviorDir = path.join(__dirname, '..', 'core', 'behavior');
const coreSources = {
  GestureLexicon: fs.readFileSync(path.join(coreBehaviorDir, 'GestureLexicon.js'), 'utf8'),
  GestureHeuristic: fs.readFileSync(path.join(coreBehaviorDir, 'GestureHeuristic.js'), 'utf8'),
  GestureEngine: fs.readFileSync(path.join(coreBehaviorDir, 'GestureEngine.js'), 'utf8'),
};

// TTS: lanza tts_stream.py, captura el audio en bytes y lo devuelve como
// Uint8Array. La página lo decodifica con su AudioContext (API del DOM, no
// puede moverse al preload).
function ttsStream(args = {}) {
  return new Promise((resolve, reject) => {
    if (!args.pythonBin) {
      reject(new Error('pythonBin requerido'));
      return;
    }
    const chunks = [];
    const proc = cp.spawn(args.pythonBin, [
      path.join(__dirname, '..', 'tts_stream.py'),
      '--voice',
      args.voice || 'ja-JP-NanamiNeural',
      '--rate',
      args.rate || '+8%',
      '--pitch',
      args.pitch || '+18Hz',
      '--text',
      args.text || '',
    ]);
    proc.stdout.on('data', (c) => chunks.push(c));
    proc.on('close', (code) => {
      if (code !== 0 || chunks.length === 0) {
        reject(new Error('TTS failed'));
        return;
      }
      resolve(new Uint8Array(Buffer.concat(chunks)));
    });
    proc.on('error', reject);
  });
}

contextBridge.exposeInMainWorld('assistant', {
  // IPC con whitelist de canales (ipc/channel-whitelist.js) — el renderer no
  // puede invocar canales internos no previstos.
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

  // Node acotado.
  pathJoin: (...parts) => path.join(...parts),
  existsSync: (p) => fs.existsSync(p),
  cwd: () => process.cwd(),
  ttsStream,

  // Módulos core. Las clases ES no se pueden instanciar con `new` a través de
  // contextBridge (el proxy las invoca como función y un constructor ES lanza
  // "Class constructor X cannot be invoked without 'new'") y, más importante,
  // el GestureEngine recibe el objeto Live2D real (creado por PIXI en la
  // página) que tampoco puede cruzar el bridge. Por eso GestureEngine se
  // carga en la página vía getCoreModuleSource; aquí solo se expone la
  // ModelAugmenter, que se usa como objeto de métodos (augmentModel devuelve
  // objetos planos serializables) y sí puede pasar por el bridge.
  getCoreModuleSource: (name) => coreSources[name] || null,
  ModelAugmenter: _boundedModelAugmenter(),
});
