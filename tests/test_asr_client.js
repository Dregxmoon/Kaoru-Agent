'use strict';

// AsrClient — transcripción local con Vosk vía subproceso Python.
// Stub de cp.spawn (monkeypatch del child_process compartido): nunca se lanza
// Python real, el WAV que el main recibe del renderer se captura por stdin.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { EventEmitter } = require('events');

const cp = require('child_process');
const AsrClient = require('../core/voice/AsrClient.js');

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

let passed = 0;
let failed = 0;

function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  ${C.green('✓')} ${label}`);
    passed++;
  } else {
    console.log(`  ${C.red('✗')} ${label}`);
    if (detail) console.log(`    ${C.dim(detail)}`);
    failed++;
  }
}

/** Fake child process que emula stdout/stderr/stdin + close/error. */
function makeFakeChild(capture) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = (buf) => {
    capture.stdin = buf;
  };
  child.finish = (code, opts = {}) => {
    for (const c of opts.stdout || []) child.stdout.emit('data', c);
    for (const c of opts.stderr || []) child.stderr.emit('data', c);
    child.emit('close', code);
  };
  return child;
}

function testResolveAsrModel() {
  console.log(C.bold('\n── resolveAsrModel: busca modelos/vosk-es/ ──────────────────'));

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-model-'));
  const none = AsrClient.resolveAsrModel(base);
  assert(none === null, 'Sin models/vosk-es → null');

  fs.mkdirSync(path.join(base, 'models', 'vosk-es'), { recursive: true });
  const found = AsrClient.resolveAsrModel(base);
  assert(
    found === path.join(base, 'models', 'vosk-es'),
    'Con models/vosk-es/ → devuelve esa ruta',
    `obtuvo: ${found}`
  );

  const base2 = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-model-'));
  fs.mkdirSync(path.join(base2, 'models'), { recursive: true });
  const fromScratch = AsrClient.resolveAsrModel(base2);
  assert(fromScratch === null, 'models/ vacío → null');
}

function testPythonBinRequired() {
  console.log(C.bold('\n── transcribeWav: pythonBin requerido ───────────────────────'));

  const origSpawn = cp.spawn;
  let spawned = false;
  cp.spawn = () => {
    spawned = true;
    throw new Error('no debería llamar spawn');
  };
  try {
    return AsrClient.transcribeWav({ pythonBin: '', wav: Buffer.alloc(0) })
      .then(() => {
        assert(false, 'Rechaza sin pythonBin', 'resolvió sin error');
      })
      .catch((e) => {
        assert(e.message.includes('pythonBin requerido'), 'Rechaza sin pythonBin');
      })
      .finally(() => {
        assert(!spawned, 'No llama spawn sin pythonBin');
        cp.spawn = origSpawn;
      });
  } catch (e) {
    cp.spawn = origSpawn;
    throw e;
  }
}

function testModelMissing() {
  console.log(C.bold('\n── transcribeWav: modelo ausente → error claro ──────────────'));

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-empty-'));
  AsrClient._setModelRoot(empty);

  const origSpawn = cp.spawn;
  let spawned = false;
  cp.spawn = () => {
    spawned = true;
    throw new Error('no debería llamar spawn');
  };
  try {
    return AsrClient.transcribeWav({ pythonBin: '/usr/bin/python3', wav: Buffer.alloc(0) })
      .then(() => {
        assert(false, 'Rechaza sin modelo', 'resolvió sin error');
      })
      .catch((e) => {
        assert(
          e.message.includes('Modelo Vosk no encontrado'),
          'Rechaza sin modelo con mensaje accionable',
          e.message
        );
      })
      .finally(() => {
        assert(!spawned, 'No llama spawn sin modelo');
        cp.spawn = origSpawn;
      });
  } catch (e) {
    cp.spawn = origSpawn;
    throw e;
  }
}

function testTranscribeSuccess() {
  console.log(C.bold('\n── transcribeWav: éxito → devuelve el texto por stdout ───────'));

  const model = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-model-ok-'));
  const wav = Buffer.alloc(100);
  const capture = { args: null, stdin: null };
  const child = makeFakeChild(capture);

  const origSpawn = cp.spawn;
  cp.spawn = (cmd, args) => {
    capture.args = args;
    return child;
  };
  try {
    const p = AsrClient.transcribeWav({ pythonBin: '/usr/bin/python3', wav, modelPath: model });
    child.finish(0, { stdout: [Buffer.from('hola mundo')] });
    return p
      .then((text) => {
        assert(text === 'hola mundo', 'Resuelve con la transcripción', `obtuvo: "${text}"`);
        assert(capture.args[0] === AsrClient.ASR_SCRIPT, 'Argumento 0 = asr_stream.py');
        assert(capture.args[2] === model, 'Argumento --model = ruta del modelo');
        assert(capture.args[4] === 'es', 'Argumento --lang = es por defecto');
        assert(
          Buffer.isBuffer(capture.stdin) && capture.stdin.length === 100,
          'WAV entregado por stdin'
        );
      })
      .catch((e) => {
        assert(false, 'Resuelve con la transcripción', e.message);
      })
      .finally(() => {
        cp.spawn = origSpawn;
      });
  } catch (e) {
    cp.spawn = origSpawn;
    throw e;
  }
}

function testTranscribeNonZeroExit() {
  console.log(C.bold('\n── transcribeWav: exit ≠ 0 → rechaza con stderr ─────────────'));

  const model = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-model-fail-'));
  const capture = {};
  const child = makeFakeChild(capture);

  const origSpawn = cp.spawn;
  cp.spawn = () => child;
  try {
    const p = AsrClient.transcribeWav({
      pythonBin: '/usr/bin/python3',
      wav: Buffer.alloc(50),
      modelPath: model,
    });
    child.finish(1, { stderr: [Buffer.from('vosk: modelo inválido')] });
    return p
      .then(() => {
        assert(false, 'Rechaza con exit ≠ 0', 'resolvió sin error');
      })
      .catch((e) => {
        assert(e.message.includes('exit 1'), 'Incluye exit code en el mensaje', e.message);
        assert(e.message.includes('vosk: modelo inválido'), 'Incluye stderr truncado', e.message);
      })
      .finally(() => {
        cp.spawn = origSpawn;
      });
  } catch (e) {
    cp.spawn = origSpawn;
    throw e;
  }
}

function testSpawnThrows() {
  console.log(C.bold('\n── transcribeWav: spawn síncrono falla → rechaza ────────────'));

  const model = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-model-spawn-'));
  const origSpawn = cp.spawn;
  cp.spawn = () => {
    throw new Error('spawn ENOENT');
  };
  try {
    return AsrClient.transcribeWav({
      pythonBin: '/no/existe/python',
      wav: Buffer.alloc(10),
      modelPath: model,
    })
      .then(() => {
        assert(false, 'Rechaza cuando spawn lanza', 'resolvió sin error');
      })
      .catch((e) => {
        assert(e.message.includes('ENOENT'), 'Rechaza con el error de spawn', e.message);
      })
      .finally(() => {
        cp.spawn = origSpawn;
      });
  } catch (e) {
    cp.spawn = origSpawn;
    throw e;
  }
}

async function main() {
  testResolveAsrModel();
  await testPythonBinRequired();
  await testModelMissing();
  await testTranscribeSuccess();
  await testTranscribeNonZeroExit();
  await testSpawnThrows();

  console.log(C.bold('\n════════════════════════════════════════════════════════'));
  const total = passed + failed;
  console.log(
    C.bold(
      `  Resultado: ${C.green(passed + ' passed')}  ${failed > 0 ? C.red(failed + ' failed') : C.dim('0 failed')}  / ${total} total`
    )
  );
  console.log(C.bold('════════════════════════════════════════════════════════\n'));

  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(C.red('\nERROR FATAL:'), e.message);
  console.error(e.stack);
  process.exit(1);
});
