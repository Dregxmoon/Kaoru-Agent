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
// Cooldown tras deshabilitar el worker: pasado este tiempo se reintenta en vez
// de degradar la detección/recall a main thread (o LIKE) por el resto de la
// sesión. Sin esto, un fallo transitorio (binding bloqueado, modelo en
// descarga, lock de archivo) dejaba toda la sesión en modo degradado.
const RETRY_DISABLED_AFTER_MS = 5 * 60 * 1000;

// onnxruntime-node usa NAPI (ABI estable) — NO se reconstruye con
// electron-rebuild. El error "Module did not self-register" indica un prebuild
// corrupto o descarga parcial: la reparación es reinstalar el paquete.
const BINDING_REMEDIATION =
  '[embeddings] onnxruntime-node no cargó su binding nativo. Es un módulo NAPI (ABI estable), NO uses electron-rebuild: ' +
  'eso corrompería el prebuild. Reparalo reinstalando el paquete (npm install onnxruntime-node o npm ci).';
const SELF_REGISTER_RE = /did not self-register|onnxruntime_binding\.node|NODE_MODULE_VERSION/i;

/**
 * Diagnostica un fallo del worker: si viene del binding nativo de onnxruntime,
 * devuelve la remediación concreta; si no, null (el fallo es otra cosa).
 * @param {Error} err
 * @returns {string | null}
 */
function bindingFailureHint(err) {
  const msg = err && err.message ? String(err.message) : String(err);
  return SELF_REGISTER_RE.test(msg) ? BINDING_REMEDIATION : null;
}

/**
 * Verifica que el binding nativo de onnxruntime-node carga en este proceso.
 * Devuelve { ok: true } o { ok: false, error, hint } con la remediación.
 * @returns {{ ok: boolean; error?: string; hint?: string }}
 */
function checkNativeBindings() {
  try {
    require('onnxruntime-node');
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: msg,
      hint: bindingFailureHint(/** @type {Error} */ (e)) || BINDING_REMEDIATION,
    };
  }
}

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
// 0 = worker habilitado; si no, timestamp hasta el cual se evita el worker.
// Pasado el cooldown, embedText reintenta el worker (recuperación de sesión).
let _disabledUntil = 0;
/** @type {NodeJS.Timeout | null} */
let _idleTimer = null;
/** @type {(() => import('worker_threads').Worker) | null} */
let _workerFactory = null;

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
  const hint = bindingFailureHint(err);
  if (hint) logger.error('EmbedService', hint);
  if (_consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && !_disabledUntil) {
    _disabledUntil = Date.now() + RETRY_DISABLED_AFTER_MS;
    logger.error(
      'EmbedService',
      `[embeddings] ${MAX_CONSECUTIVE_FAILURES} fallos seguidos — worker deshabilitado ` +
        `${RETRY_DISABLED_AFTER_MS / 60000} min (reintento automático tras el cooldown)`
    );
  }
}

/** @returns {boolean} true si el worker está en cooldown (evitar intentarlo). */
function _workerDisabled() {
  return _disabledUntil !== 0 && Date.now() < _disabledUntil;
}

/** Si el cooldown ya expiró, re-habilita el worker para reintentarlo. */
function _tryRecoverWorker() {
  if (_disabledUntil && Date.now() >= _disabledUntil) {
    _disabledUntil = 0;
    _consecutiveFailures = 0;
    logger.warn('EmbedService', '[embeddings] cooldown agotado — reintentando worker');
  }
}

/**
 * Crea el worker real. Se extrae como seam para que los tests inyecten un
 * worker fake determinista (_debug_setWorkerFactory).
 * @returns {import('worker_threads').Worker}
 */
function _createWorker() {
  return new Worker(path.join(__dirname, 'embedWorker.js'));
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
      w = _workerFactory ? _workerFactory() : _createWorker();
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
          _disabledUntil = 0;
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
  if (_workerDisabled()) return _mainThreadFallback(text);
  _tryRecoverWorker();
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
  if (_workerDisabled()) return false;
  _tryRecoverWorker();
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
  _consecutiveFailures = 0;
  _disabledUntil = 0;
}

// ── Debug / tests ─────────────────────────────────────────────────────────────

/**
 * Inyecta un factory de worker (test determinista sin worker_threads real).
 * @param {(() => import('worker_threads').Worker) | null} fn
 */
function _debug_setWorkerFactory(fn) {
  _workerFactory = fn;
}

/** Reinicia el estado del servicio (workers, cooldown, contadores). */
function _debug_resetState() {
  _terminateWorker();
  const pending = [..._pending.values()];
  _pending.clear();
  for (const p of pending) p.reject(new Error('embed service reset'));
  _seq = 0;
  _consecutiveFailures = 0;
  _disabledUntil = 0;
  _workerFactory = null;
}

/**
 * Fuerza la deshabilitación del worker para probar cooldown/recuperación.
 * @param {number} relativeMs offset sobre Date.now() para _disabledUntil
 */
function _debug_forceDisable(relativeMs) {
  _consecutiveFailures = MAX_CONSECUTIVE_FAILURES;
  _disabledUntil = Date.now() + relativeMs;
}

/** @returns {{ consecutiveFailures: number; disabledUntil: number; disabled: boolean; workerAlive: boolean }} */
function _debug_getState() {
  return {
    consecutiveFailures: _consecutiveFailures,
    disabledUntil: _disabledUntil,
    disabled: _workerDisabled(),
    workerAlive: !!_worker,
  };
}

module.exports = {
  embedText,
  float32ToBuffer,
  warmup,
  dispose,
  checkNativeBindings,
  _debug_setWorkerFactory,
  _debug_resetState,
  _debug_forceDisable,
  _debug_getState,
  _debug_bindingHint: bindingFailureHint,
};
