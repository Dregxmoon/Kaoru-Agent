// @ts-check
'use strict';

/**
 * overlay-handlers.js — Fase 2, ítem 6: capacidades del overlay vía IPC.
 *
 * Con `sandbox:true` el preload del overlay (src/preload.js) es fino: ya no
 * puede `require` fs/path/child_process ni los módulos core. Toda la lógica
 * que antes vivía ahí se mueve al proceso main y se expone como canales IPC
 * whitelisteados. El renderer (src/index.html) los llama con `invoke` y
 * conserva los mismos nombres (fs.existsSync, ModelAugmenter, ttsStream,
 * loader de módulos core).
 */

const path = require('path');
const fs = require('fs');
const cp = require('child_process');
const { ipcMain } = require('electron');

const logger = require('../core/observability/Logger.js');
const ModelAugmenter = require('../core/behavior/ModelAugmenter.js');

/** @param {unknown} e @returns {string} */
function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}

// Fuentes de los módulos core que el overlay necesita EJECUTAR en su propia
// página (GestureEngine recibe el objeto Live2D real creado por PIXI, que no
// puede cruzar el contextBridge). Se entregan en un lote: el loader de la
// página hace `require()` síncronos al ejecutarlos, así que necesita todos los
// fuentes disponibles de una vez. ModelAugmenter NO va en el lote: se expone
// como proxy IPC (métodos acotados), igual que en el renderer.
const CORE_SOURCES = {
  GestureLexicon: 'GestureLexicon.js',
  GestureHeuristic: 'GestureHeuristic.js',
  GestureEngine: 'GestureEngine.js',
  agentStates: 'agentStates.js',
};

/**
 * @param {any} _ctx Estado compartido del proceso main (se ignora: los
 *   handlers del overlay son autocontenidos).
 */
function register(_ctx) {
  const coreBehaviorDir = path.join(__dirname, '..', 'core', 'behavior');

  ipcMain.handle('overlay-core-sources', () => {
    /** @type {Record<string, string>} */
    const out = {};
    for (const [name, file] of Object.entries(CORE_SOURCES)) {
      try {
        out[name] = fs.readFileSync(path.join(coreBehaviorDir, file), 'utf8');
      } catch (e) {
        logger.warn('overlay-handlers', `[overlay] no se pudo leer ${file}:`, errMsg(e));
      }
    }
    return out;
  });

  ipcMain.handle('overlay-fs-exists', (_e, p) => {
    try {
      return fs.existsSync(String(p || ''));
    } catch {
      return false;
    }
  });

  ipcMain.handle('overlay-augment-model', (_e, model3Path) => {
    try {
      return ModelAugmenter.augmentModel(model3Path);
    } catch (e) {
      logger.warn('overlay-handlers', '[overlay] augmentModel falló:', errMsg(e));
      return { settings: null, gestures: { modelName: '', expressions: [], motions: [] } };
    }
  });

  ipcMain.handle('overlay-list-gestures', (_e, model3Path) => {
    try {
      return ModelAugmenter.listGestures(model3Path);
    } catch (e) {
      logger.warn('overlay-handlers', '[overlay] listGestures falló:', errMsg(e));
      return { modelName: '', expressions: [], motions: [] };
    }
  });

  // TTS: lanza tts_stream.py en main, captura el audio y lo devuelve como
  // Buffer (structured clone → Uint8Array en el renderer). La página lo
  // decodifica con su AudioContext/HTMLAudioElement (API del DOM, no puede
  // moverse a main).
  ipcMain.handle(
    'overlay-tts-stream',
    (_e, args = {}) =>
      new Promise((resolve, reject) => {
        if (!args.pythonBin) {
          reject(new Error('pythonBin requerido'));
          return;
        }
        /** @type {Buffer[]} */
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
          resolve(Buffer.concat(chunks));
        });
        proc.on('error', reject);
      })
  );
}

module.exports = { register };
