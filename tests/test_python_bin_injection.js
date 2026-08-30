'use strict';

/**
 * test_python_bin_injection.js — verifica que chat-tts-stream y chat-asr-stream
 * IGNORAN args.pythonBin del renderer y usan SIEMPRE ctx.PYTHON_BIN (main process).
 */

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

let passed = 0;
let failed = 0;

function assert(condition, label, detail) {
  if (condition) {
    console.log(`  ${C.green('\u2713')} ${label}`);
    passed++;
  } else {
    console.log(`  ${C.red('\u2717')} ${label}`);
    if (detail) console.log(`    ${C.dim(detail)}`);
    failed++;
  }
}

// ── Mock setup ───────────────────────────────────────────────────────────────

// Capture what ipcMain.handle was registered with
const registeredHandlers = {};
const registeredOn = {};
const mockIpcMain = {
  handle: (channel, handler) => {
    registeredHandlers[channel] = handler;
  },
  on: (channel, handler) => {
    registeredOn[channel] = handler;
  },
  removeListener: () => {},
};

// Mock child_process — emit data on stdout so TTS doesn't fail with empty chunks
let lastSpawnCall = null;
const mockCp = {
  spawn: (bin, args) => {
    lastSpawnCall = { bin, args };
    const { EventEmitter } = require('events');
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.kill = () => {};
    process.nextTick(() => {
      proc.stdout.emit('data', Buffer.from('fake-audio'));
      proc.emit('close', 0);
    });
    return proc;
  },
};

// Mock AsrClient
let lastAsrCall = null;
const mockAsrClient = {
  transcribeWav: (opts) => {
    lastAsrCall = opts;
    return Promise.resolve({ text: 'mock transcription' });
  },
};

// Patch require cache to inject mocks
const Module = require('module');
const origResolve = Module._resolveFilename;
const patches = new Map();

function patchModule(targetPath, mock) {
  patches.set(targetPath, mock);
}

Module._resolveFilename = function (request, parent) {
  const resolved = origResolve.call(this, request, parent);
  if (patches.has(resolved)) return resolved;
  return resolved;
};

const origLoad = Module._load;
Module._load = function (request, parent) {
  const resolved = Module._resolveFilename.call(this, request, parent);
  if (patches.has(resolved)) return patches.get(resolved);
  return origLoad.call(this, request, parent);
};

// Apply mocks
const path = require('path');
patchModule(require.resolve('electron'), { ipcMain: mockIpcMain });
patchModule(path.join(__dirname, '..', 'node_modules', 'electron'), { ipcMain: mockIpcMain });
// Mock child_process
patchModule(require.resolve('child_process'), mockCp);
// Mock AsrClient
patchModule(require.resolve('../core/voice/AsrClient.js'), mockAsrClient);

// Now require chat-handlers and overlay-handlers (they will use our mocks)
const chatHandlers = require('../ipc/chat-handlers.js');
const overlayHandlers = require('../ipc/overlay-handlers.js');

// Restore Module._load after registration
Module._load = origLoad;
Module._resolveFilename = origResolve;

// ── Test 1: chat-tts-stream uses ctx.PYTHON_BIN, ignores args.pythonBin ──────
async function testTtsIgnoresRendererPythonBin() {
  console.log(C.bold('\n\u2500 chat-tts-stream: ignora args.pythonBin del renderer'));

  const FAKE_PYTHON = '/usr/bin/python3.11';
  const mockCtx = { PYTHON_BIN: FAKE_PYTHON };
  chatHandlers.register(mockCtx);

  const handler = registeredHandlers['chat-tts-stream'];
  assert(typeof handler === 'function', 'handler registrado');

  // Malicious args from a compromised renderer
  lastSpawnCall = null;
  await handler(
    {},
    {
      pythonBin: '/bin/sh',
      voice: 'test',
      rate: '+0%',
      pitch: '+0Hz',
      text: 'echo pwned',
    }
  );

  assert(lastSpawnCall !== null, 'cp.spawn fue llamado');
  assert(
    lastSpawnCall.bin === FAKE_PYTHON,
    'spawn usa ctx.PYTHON_BIN (/usr/bin/python3.11), NO args.pythonBin (/bin/sh)',
    `bin real: ${lastSpawnCall.bin}`
  );
  assert(lastSpawnCall.bin !== '/bin/sh', 'el binario NUNCA es /bin/sh (renderer malicioso)');
}

// ── Test 2: chat-tts-stream falla si ctx.PYTHON_BIN es null ─────────────────
async function testTtsFailsWithoutPythonBin() {
  console.log(C.bold('\n\u2500 chat-tts-stream: falla si Python no detectado'));

  chatHandlers.register({ PYTHON_BIN: null });
  const handler = registeredHandlers['chat-tts-stream'];

  lastSpawnCall = null;
  let error = null;
  try {
    await handler({}, { pythonBin: '/bin/sh', text: 'test' });
  } catch (e) {
    error = e;
  }

  assert(error !== null, 'lanza error cuando ctx.PYTHON_BIN es null');
  assert(
    error && error.message === 'Python no disponible',
    'mensaje de error correcto',
    `mensaje: ${error?.message}`
  );
  assert(lastSpawnCall === null, 'cp.spawn NO fue llamado');
}

// ── Test 3: chat-tts-stream falla si ctx no tiene PYTHON_BIN ────────────────
async function testTtsFailsWithoutCtx() {
  console.log(C.bold('\n\u2500 chat-tts-stream: falla si ctx no tiene PYTHON_BIN'));

  chatHandlers.register({}); // no PYTHON_BIN property
  const handler = registeredHandlers['chat-tts-stream'];

  lastSpawnCall = null;
  let error = null;
  try {
    await handler({}, { pythonBin: '/bin/sh', text: 'test' });
  } catch (e) {
    error = e;
  }

  assert(error !== null, 'lanza error cuando ctx no tiene PYTHON_BIN');
  assert(lastSpawnCall === null, 'cp.spawn NO fue llamado');
}

// ── Test 4: chat-asr-stream usa ctx.PYTHON_BIN ──────────────────────────────
async function testAsrIgnoresRendererPythonBin() {
  console.log(C.bold('\n\u2500 chat-asr-stream: ignora args.pythonBin del renderer'));

  const FAKE_PYTHON = '/usr/bin/python3.11';
  chatHandlers.register({ PYTHON_BIN: FAKE_PYTHON });
  const handler = registeredHandlers['chat-asr-stream'];

  lastAsrCall = null;
  await handler(
    {},
    {
      pythonBin: '/bin/sh',
      wav: Buffer.from('fake'),
      lang: 'es',
    }
  );

  assert(lastAsrCall !== null, 'AsrClient.transcribeWav fue llamado');
  assert(
    lastAsrCall.pythonBin === FAKE_PYTHON,
    'usa ctx.PYTHON_BIN, NO args.pythonBin',
    `pythonBin real: ${lastAsrCall.pythonBin}`
  );
}

// ── Test 5: chat-asr-stream falla si ctx.PYTHON_BIN es null ─────────────────
async function testAsrFailsWithoutPythonBin() {
  console.log(C.bold('\n\u2500 chat-asr-stream: falla si Python no detectado'));

  chatHandlers.register({ PYTHON_BIN: null });
  const handler = registeredHandlers['chat-asr-stream'];

  lastAsrCall = null;
  let error = null;
  try {
    await handler({}, { pythonBin: '/bin/sh', wav: Buffer.from('fake'), lang: 'es' });
  } catch (e) {
    error = e;
  }

  assert(error !== null, 'lanza error cuando ctx.PYTHON_BIN es null');
  assert(
    error && error.message === 'Python no disponible',
    'mensaje de error correcto',
    `mensaje: ${error?.message}`
  );
  assert(lastAsrCall === null, 'AsrClient NO fue llamado');
}

// ── Test 6: overlay-tts-stream uses ctx.PYTHON_BIN, ignores args.pythonBin ──
async function testOverlayTtsIgnoresRendererPythonBin() {
  console.log(C.bold('\n\u2500 overlay-tts-stream: ignora args.pythonBin del renderer'));

  const FAKE_PYTHON = '/usr/bin/python3.11';
  overlayHandlers.register({ PYTHON_BIN: FAKE_PYTHON });

  const handler = registeredHandlers['overlay-tts-stream'];
  assert(typeof handler === 'function', 'handler registrado');

  lastSpawnCall = null;
  await handler(
    {},
    {
      pythonBin: '/bin/sh',
      voice: 'test',
      rate: '+0%',
      pitch: '+0Hz',
      text: 'test',
    }
  );

  assert(lastSpawnCall !== null, 'cp.spawn fue llamado');
  assert(
    lastSpawnCall.bin === FAKE_PYTHON,
    'spawn usa ctx.PYTHON_BIN, NO args.pythonBin',
    `bin real: ${lastSpawnCall.bin}`
  );
  assert(lastSpawnCall.bin !== '/bin/sh', 'el binario NUNCA es /bin/sh (renderer malicioso)');
}

// ── Test 7: overlay-tts-stream falla si ctx.PYTHON_BIN es null ──────────────
async function testOverlayTtsFailsWithoutPythonBin() {
  console.log(C.bold('\n\u2500 overlay-tts-stream: falla si Python no detectado'));

  overlayHandlers.register({ PYTHON_BIN: null });
  const handler = registeredHandlers['overlay-tts-stream'];

  lastSpawnCall = null;
  let error = null;
  try {
    await handler({}, { pythonBin: '/bin/sh', text: 'test' });
  } catch (e) {
    error = e;
  }

  assert(error !== null, 'lanza error cuando ctx.PYTHON_BIN es null');
  assert(
    error && error.message === 'Python no disponible',
    'mensaje de error correcto',
    `mensaje: ${error?.message}`
  );
  assert(lastSpawnCall === null, 'cp.spawn NO fue llamado');
}

// ── Test 8: overlay-tts-stream falla si ctx no tiene PYTHON_BIN ─────────────
async function testOverlayTtsFailsWithoutCtx() {
  console.log(C.bold('\n\u2500 overlay-tts-stream: falla si ctx no tiene PYTHON_BIN'));

  overlayHandlers.register({});
  const handler = registeredHandlers['overlay-tts-stream'];

  lastSpawnCall = null;
  let error = null;
  try {
    await handler({}, { pythonBin: '/bin/sh', text: 'test' });
  } catch (e) {
    error = e;
  }

  assert(error !== null, 'lanza error cuando ctx no tiene PYTHON_BIN');
  assert(lastSpawnCall === null, 'cp.spawn NO fue llamado');
}

// ── Run ──────────────────────────────────────────────────────────────────────
async function runAll() {
  console.log(C.cyan(C.bold('  Kaoru \u2014 Test Suite: pythonBin injection prevention')));
  console.log(C.dim('  Verifica que TTS/ASR/overlay ignoran args.pythonBin del renderer'));

  await testTtsIgnoresRendererPythonBin();
  await testTtsFailsWithoutPythonBin();
  await testTtsFailsWithoutCtx();
  await testAsrIgnoresRendererPythonBin();
  await testAsrFailsWithoutPythonBin();
  await testOverlayTtsIgnoresRendererPythonBin();
  await testOverlayTtsFailsWithoutPythonBin();
  await testOverlayTtsFailsWithoutCtx();

  console.log(C.bold(`\n  Result: ${passed} ${C.green('passed')}, ${failed} ${C.red('failed')}\n`));
  process.exit(failed > 0 ? 1 : 0);
}

runAll().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
