// @ts-check
'use strict';

/**
 * AsrClient.js — transcripción de voz local (Vosk) vía subproceso Python.
 *
 * Espejo de TTS: el renderer graba PCM 16k mono, lo empaqueta como WAV y lo
 * envía por IPC; este módulo lanza `asr_stream.py` (main process) con el modelo
 * Vosk, le entrega el WAV por stdin y devuelve la transcripción por stdout.
 *
 * El modelo se resuelve en `models/vosk-es/` (gitignored, lo descarga el
 * usuario: `vosk-model-small-es-0.42`). Nunca se bloquea al main: usa spawn
 * asíncrono y el WAV se alimenta por stdin sin archivo temporal.
 */

const path = require('path');
const fs = require('fs');
const cp = require('child_process');

const APP_ROOT = path.join(__dirname, '..', '..');
const ASR_SCRIPT = path.join(APP_ROOT, 'asr_stream.py');

// Seam de test: permite apuntar la resolución del modelo a otro root sin tocar
// APP_ROOT (const a nivel de módulo).
let _modelRoot = APP_ROOT;
/** @param {string} root */
function _setModelRoot(root) {
  _modelRoot = root;
}

/**
 * @typedef {object} AsrOptions
 * @property {string} pythonBin Intérprete Python (resuelto por main).
 * @property {Buffer|Uint8Array|ArrayBuffer} wav Audio WAV (PCM 16kHz mono 16-bit).
 * @property {string} [lang] Idioma del modelo (default 'es').
 * @property {string} [modelPath] Ruta explícita al modelo; si falta, resuelve `models/vosk-es/`.
 */

/**
 * Resuelve la ruta del modelo Vosk. Devuelve null si no existe ninguno.
 * @param {string} [appRoot]
 * @returns {string|null}
 */
function resolveAsrModel(appRoot = APP_ROOT) {
  const candidates = [
    path.join(appRoot, 'models', 'vosk-es'),
    path.join(appRoot, 'models', 'vosk-model-small-es-0.42'),
    path.join(appRoot, 'models', 'vosk-model-es-0.42'),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      // sigue con el siguiente candidato
    }
  }
  return null;
}

/**
 * Transcribe un WAV (PCM 16k mono) con Vosk. Resuelve con el texto; rechaza
 * con Error si el subproceso falla (código de salida, modelo ausente, WAV
 * inválido) o si `asr_stream.py` reportó un error en stderr.
 * @param {AsrOptions} opts
 * @returns {Promise<string>}
 */
function transcribeWav({ pythonBin, wav, lang = 'es', modelPath }) {
  return new Promise((resolve, reject) => {
    if (!pythonBin) {
      reject(new Error('pythonBin requerido'));
      return;
    }
    const model = modelPath || resolveAsrModel(_modelRoot);
    if (!model) {
      reject(
        new Error(
          'Modelo Vosk no encontrado — descargalo en models/vosk-es/ (ej. vosk-model-small-es-0.42)'
        )
      );
      return;
    }
    const wavBuf = Buffer.isBuffer(wav) ? wav : Buffer.from(new Uint8Array(wav || []));
    let proc;
    try {
      proc = cp.spawn(pythonBin, [ASR_SCRIPT, '--model', model, '--lang', lang]);
    } catch (e) {
      reject(e);
      return;
    }
    /** @type {Buffer[]} */
    const outChunks = [];
    /** @type {Buffer[]} */
    const errChunks = [];
    proc.stdout.on('data', (c) => outChunks.push(c));
    proc.stderr.on('data', (c) => errChunks.push(c));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(errChunks).toString('utf8').slice(0, 400);
        reject(new Error(`ASR failed (exit ${code}): ${stderr}`));
        return;
      }
      resolve(Buffer.concat(outChunks).toString('utf8').trim());
    });
    const stdin = proc.stdin;
    stdin.on('error', () => {});
    stdin.end(wavBuf);
  });
}

module.exports = { transcribeWav, resolveAsrModel, ASR_SCRIPT, APP_ROOT, _setModelRoot };
