// @ts-check
'use strict';

// TTS no depende de Python; ASR sigue usando únicamente el binario resuelto
// en main, nunca un ejecutable sugerido por el renderer.
const Module = require('module');
const assert = require('assert').strict;

/** @type {Record<string, Function>} */
const handlers = {};
const ipcMain = {
  handle: (/** @type {string} */ channel, /** @type {Function} */ fn) => {
    handlers[channel] = fn;
  },
  on: () => {},
  removeListener: () => {},
};

/** @type {any} */
let lastAsr;
/** @type {any} */
let lastTts;
const mocks = new Map([
  [require.resolve('electron'), { ipcMain }],
  [
    require.resolve('../core/voice/AsrClient.js'),
    {
      transcribeWav: (/** @type {any} */ args) => {
        lastAsr = args;
        return Promise.resolve({ text: 'hola' });
      },
    },
  ],
  [
    require.resolve('../core/voice/NeuralTts.js'),
    {
      synthesize: (/** @type {any} */ args) => {
        lastTts = args;
        return Promise.resolve(Buffer.from('audio'));
      },
    },
  ],
]);

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const resolved = Module._resolveFilename(request, parent, isMain);
  return mocks.has(resolved)
    ? mocks.get(resolved)
    : originalLoad.call(this, request, parent, isMain);
};
const chat = require('../ipc/chat-handlers.js');
const overlay = require('../ipc/overlay-handlers.js');
Module._load = originalLoad;

async function run() {
  chat.register({ PYTHON_BIN: null });
  overlay.register({ PYTHON_BIN: null });
  for (const channel of ['chat-tts-stream', 'overlay-tts-stream']) {
    lastTts = null;
    const result = await handlers[channel]({}, { text: 'hola', pythonBin: '/bin/sh' });
    assert.equal(Buffer.from(result).toString(), 'audio');
    assert.equal(lastTts.text, 'hola');
  }

  chat.register({ PYTHON_BIN: '/usr/bin/python3' });
  await handlers['chat-asr-stream']({}, { wav: Buffer.from('wav'), pythonBin: '/bin/sh' });
  assert.equal(lastAsr.pythonBin, '/usr/bin/python3');
  chat.register({ PYTHON_BIN: null });
  await assert.rejects(
    handlers['chat-asr-stream']({}, { wav: Buffer.from('wav') }),
    /Python no disponible/
  );
  console.log('TTS empaquetado sin Python; ASR usa Python de main: OK');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
