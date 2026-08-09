// @ts-check
'use strict';

/**
 * EmbedService.js — embeddings en worker_threads (F2.1-D).
 *
 * Facade sobre core/grounding/embedWorker.js: mantiene UN worker singleton,
 * hace request/response con promesas por id y transfiere el Float32Array sin
 * copia. Si el worker no está disponible o falla de forma sostenida, cae al
 * embedder de main thread (IntentDetector.embedText) que es el comportamiento
 * histórico — nunca bloquea el pipeline por esto.
 *
 * El worker termina tras IDLE_TERMINATE_MS sin requests (un worker que haya
 * hecho un request/response mantiene vivo el proceso aunque esté unref'd, lo
 * que colgaba tests y scripts); al terminar por inactividad se reinicia bajo
 * demanda con la próxima llamada (~500ms si el modelo está en caché local).
 *
 * Uso:
 *   const { embedText, float32ToBuffer } = require('./EmbedService.js');
 *   const vec = await embedText('hola'); // Float32Array(384) normalizado L2
 *
 * Los tests reemplazan embedText/float32ToBuffer del módulo (referencias por
 * miembro, no desestructuradas en los call sites) para inyectar un embedder
 * determinista.
 */

const path = require('path');
const { Worker } = require('worker_threads');
const logger = require('../observability/Logger.js');

const EMBED_TIMEOUT_MS = 60_000; // una inferencia nunca debería tardar tanto
const WORKER_LOAD_TIMEOUT_MS = 90_000; // primera carga del modelo puede ser lenta
const IDLE_TERMINATE_MS = 60_000; // inactividad tras la cual se termina el worker
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Mensajes que envía embedWorker.js al main process.
 * @typedef {{ type: 'ready' } | { type: 'result'; id: number; embedding: Float32Array } | { type: 'error'; id: number; message: string } | { type: 'fatal'; message: string }} EmbedWorkerMessage
 */

/** @type {import('worker_threads').Worker | null} */
let _worker = null;
/** @type {Promise<import('worker_threads').Worker> | null} */
let _starting = null;
/** @type {Map<number, { resolve: (v: Float32Array) => void; reject: (e: Error) => void }>} */
let _pending = new Map();
let _seq = 0;
let _consecutiveFailures = 0;
let _disabled = false;
/** @type {NodeJS.Timeout | null} */
let _idleTimer = null;

function _clearIdleTimer() {
  if (_idleTimer) {
    clearTimeout(_idleTimer);
    _idleTimer = null;
  }
}

function _scheduleIdleTerminate() {
  _clearIdleTimer();
  _idleTimer = setTimeout(() => {
    _idleTimer = null;
    logger.info(
      'EmbedService',
      '[embeddings] worker inactivo, terminado (se reinicia bajo demanda en la próxima llamada)'
    );
    _terminateWorker();
  }, IDLE_TERMINATE_MS);
  // El timer no debe impedir la salida limpia si el proceso decide terminar.
  if (typeof _idleTimer.unref === 'function') _idleTimer.unref();
}

function _terminateWorker() {
  _clearIdleTimer();
  const w = _worker;
  _worker = null;
  if (w) {
    try {
      w.terminate();
    } catch {}
  }
}

/** @param {Error} err */
function _noteFailure(err) {
  _consecutiveFailures++;
  logger.warn('EmbedService', `[embeddings] worker_threads falló: ${err.message}`);
  if (_consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    _disabled = true;
    logger.error(
      'EmbedService',
      `[embeddings] ${MAX_CONSECUTIVE_FAILURES} fallos seguidos — worker deshabilitado, usando main thread`
    );
  }
}

/** @param {import('worker_threads').Worker} w @param {Error} err */
function _establishedFailed(w, err) {
  if (_worker === w) _worker = null;
  _noteFailure(err);
  const pending = [..._pending.values()];
  _pending.clear();
  for (const p of pending) p.reject(err);
}

/** @returns {Promise<import('worker_threads').Worker>} */
function _startWorker() {
  if (_worker) {
    _clearIdleTimer();
    return Promise.resolve(_worker);
  }
  if (_starting) return _starting;

  _clearIdleTimer();
  _starting = new Promise((resolve, reject) => {
    let ready = false;

    /**
     * @param {Error} err
     */
    const fail = (err) => {
      _worker = null;
      _starting = null;
      _noteFailure(err);
      reject(err);
    };

    /** @type {any} */
    let w;
    try {
      w = new Worker(path.join(__dirname, 'embedWorker.js'));
      // El worker NO debe mantener vivo el proceso: el main process ya tiene
      // sus propios handles (ventanas, etc.); en tests/scripts sin handles,
      // sin unref() el proceso quedaba colgado esperando al worker.
      w.unref();
    } catch (e) {
      fail(/** @type {Error} */ (e));
      return;
    }

    const loadTimer = setTimeout(() => {
      try {
        w.terminate();
      } catch {}
      fail(new Error('el embed worker no cargó el modelo a tiempo'));
    }, WORKER_LOAD_TIMEOUT_MS);

    w.on(
      'message',
      (
        /**
         * @type {EmbedWorkerMessage}
         */
        msg
      ) => {
        if (msg.type === 'ready') {
          if (ready) return;
          ready = true;
          clearTimeout(loadTimer);
          _worker = w;
          _starting = null;
          _consecutiveFailures = 0;
          resolve(w);
          _scheduleIdleTerminate();
        } else if (msg.type === 'result') {
          const p = _pending.get(msg.id);
          if (p) {
            _pending.delete(msg.id);
            p.resolve(msg.embedding);
          }
        } else if (msg.type === 'error') {
          const p = _pending.get(msg.id);
          if (p) {
            _pending.delete(msg.id);
            p.reject(new Error(msg.message));
          }
        } else if (msg.type === 'fatal') {
          clearTimeout(loadTimer);
          try {
            w.terminate();
          } catch {}
          if (!ready) fail(new Error(msg.message));
          else _establishedFailed(w, new Error(msg.message));
        }
      }
    );

    w.on(
      'error',
      (
        /**
         * @type {Error}
         */
        err
      ) => {
        clearTimeout(loadTimer);
        try {
          w.terminate();
        } catch {}
        if (!ready) fail(err);
        else _establishedFailed(w, err);
      }
    );

    w.on('exit', () => {
      clearTimeout(loadTimer);
      if (!ready) fail(new Error('el embed worker salió antes de estar listo'));
      else if (_worker === w) _establishedFailed(w, new Error('el embed worker terminó'));
    });
  });

  return _starting;
}

/** @param {import('worker_threads').Worker} w @param {string} text @returns {Promise<Float32Array>} */
function _request(w, text) {
  return new Promise((resolve, reject) => {
    const id = ++_seq;
    const timer = setTimeout(() => {
      if (_pending.delete(id)) reject(new Error('embedding timeout'));
    }, EMBED_TIMEOUT_MS);
    _pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
        _scheduleIdleTerminate();
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
        _scheduleIdleTerminate();
      },
    });
    w.postMessage({ id, text });
  });
}

/** @param {string} text */
function _mainThreadFallback(text) {
  const { embedText } = require('./IntentDetector.js');
  return embedText(text);
}

/**
 * Genera el embedding de un texto (Float32Array de 384 dims, normalizado L2).
 * Prefiere el worker; ante cualquier fallo cae al main thread.
 * @param {string} text
 * @returns {Promise<Float32Array>}
 */
async function embedText(text) {
  if (_disabled) return _mainThreadFallback(text);
  try {
    const w = await _startWorker();
    return await _request(w, String(text));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn('EmbedService', `[embeddings] usando main thread: ${msg}`);
    return _mainThreadFallback(text);
  }
}

/** Buffer binario (little-endian float32) listo para sqlite-vec. @param {Float32Array} arr */
function float32ToBuffer(arr) {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

/**
 * Pre-carga el modelo en el worker (fuera del main process) para que el
 * primer embedding real sea rápido. Devuelve false si el worker falla.
 * @returns {Promise<boolean>}
 */
async function warmup() {
  if (_disabled) return false;
  try {
    const w = await _startWorker();
    await _request(w, 'hola');
    logger.info('EmbedService', '[embeddings] worker precalentado');
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn('EmbedService', `[embeddings] warmup del worker falló: ${msg}`);
    return false;
  }
}

/** Libera el worker (al cerrar la app o al final de tests/scripts). */
function dispose() {
  _terminateWorker();
  const pending = [..._pending.values()];
  _pending.clear();
  for (const p of pending) p.reject(new Error('embed service cerrado'));
  _seq = 0;
}

module.exports = { embedText, float32ToBuffer, warmup, dispose };
