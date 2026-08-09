// @ts-nocheck
'use strict';

/**
 * embedWorker.js — worker_threads para embeddings (F2.1-D).
 *
 * El cómputo ONNX de @xenova/transformers (modelo Xenova/all-MiniLM-L6-v2) es
 * trabajo CPU síncrono: si corre en el main process congela la UI/el loop del
 * agente mientras infiere. Este script lo mueve fuera del main thread.
 *
 * Protocolo (request/response vía postMessage):
 *   main  → worker: { id, text }
 *   worker → main:  { type:'ready' } (tras cargar el modelo)
 *   worker → main:  { type:'result', id, embedding: Float32Array } (transferido)
 *   worker → main:  { type:'error', id, message }
 *   worker → main:  { type:'fatal', message } (falló la carga del modelo)
 *
 * Las peticiones se serializan (una por vez) porque el pipeline no garantiza
 * concurrencia segura entre llamadas simultáneas.
 */

const { parentPort } = require('worker_threads');

(async () => {
  try {
    const { pipeline } = await import('@xenova/transformers');
    const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      progress_callback: undefined, // silenciar en producción
    });

    parentPort.postMessage({ type: 'ready' });

    let chain = Promise.resolve();
    parentPort.on('message', (msg) => {
      chain = chain
        .then(async () => {
          const output = await embedder(String(msg.text), { pooling: 'mean', normalize: true });
          const data = output.data; // Float32Array (384)
          parentPort.postMessage({ type: 'result', id: msg.id, embedding: data }, [data.buffer]);
        })
        .catch((e) => {
          parentPort.postMessage({
            type: 'error',
            id: msg.id,
            message: String((e && e.message) || e),
          });
        });
    });
  } catch (e) {
    parentPort.postMessage({ type: 'fatal', message: String((e && e.message) || e) });
  }
})();
