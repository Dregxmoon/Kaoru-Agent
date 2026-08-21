'use strict';

/**
 * embedChildProcess.js — proceso hijo standalone para embeddings (recuperación NAPI).
 *
 * onnxruntime-node es NAPI single-load: una vez cargado en un proceso, no puede
 * recargarse (ni en worker_threads nuevos ni en el main thread). Si el worker
 * principal muere DESPUÉS de haber cargado el modelo, EmbedService fork-ea
 * este script como child_process.fork() — un proceso OS separado con su propio
 * espacio de memoria, donde el binding NAPI puede cargarse limpio.
 *
 * Protocolo (IPC via process.send / process.on('message')):
 *   main → child: { id: number, text: string }
 *   child → main: { type: 'ready' }
 *   child → main: { type: 'result', id, embedding: number[] }
 *   child → main: { type: 'error', id, message }
 *   child → main: { type: 'fatal', message }
 *
 * Las peticiones se serializan (una por vez) igual que embedWorker.js.
 */

(async () => {
  try {
    const { pipeline } = await import('@xenova/transformers');
    const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      progress_callback: undefined,
    });

    process.send({ type: 'ready' });

    let chain = Promise.resolve();
    process.on('message', (msg) => {
      chain = chain
        .then(async () => {
          const output = await embedder(String(msg.text), { pooling: 'mean', normalize: true });
          const arr = Array.from(output.data);
          process.send({ type: 'result', id: msg.id, embedding: arr });
        })
        .catch((e) => {
          process.send({
            type: 'error',
            id: msg.id,
            message: String((e && e.message) || e),
          });
        });
    });
  } catch (e) {
    process.send({ type: 'fatal', message: String((e && e.message) || e) });
  }
})();
