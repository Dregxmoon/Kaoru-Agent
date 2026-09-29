'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0;
let failed = 0;

function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

async function testAsrPreservesSamples() {
  let wavBytes = 0;
  let speechInterrupted = false;
  const button = { classList: { toggle() {} }, title: '' };
  const context = {
    console,
    window: { kaoruI18n: { t: (key) => key, language: 'es' } },
    Uint8Array,
    Float32Array,
    Int16Array,
    ArrayBuffer,
    DataView,
    Event,
    document: {
      getElementById(id) {
        return id === 'mic-btn' ? { ...button, addEventListener() {} } : null;
      },
    },
    navigator: { mediaDevices: {} },
    assistant: {
      async asrStream(input) {
        wavBytes = input.wav.byteLength;
        return 'hola';
      },
    },
    getPythonBin: async () => '/usr/bin/python3',
    setAgentState() {},
    getAgentState: () => 'idle',
    interruptSpeech() {
      speechInterrupted = true;
    },
  };
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'chat', 'asr.js'), 'utf8'),
    context
  );
  vm.runInContext(
    `_recording = true;
     _micCtx = { sampleRate: 16000, state: 'closed' };
     _micSamples = [new Float32Array(1600).fill(0.25)];`,
    context
  );
  const transcription = await vm.runInContext('stopMicRecording()', context);
  assert(transcription === 'hola', 'transcribe el audio capturado');
  assert(
    wavBytes === 3244,
    'el WAV conserva las muestras antes de limpiar el buffer',
    `${wavBytes}`
  );

  context.navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [] });
  context.AudioContext = function AudioContext() {
    return {
      createMediaStreamSource: () => ({ connect() {} }),
      createScriptProcessor: () => ({ connect() {} }),
      createGain: () => ({ gain: {}, connect() {} }),
      destination: {},
    };
  };
  await vm.runInContext('startMicRecording()', context);
  assert(speechInterrupted, 'pulsar el micrófono interrumpe la voz antes de escuchar');
}

async function testTtsInterruptionInvalidatesPendingAudio() {
  let resolveTts;
  let audioCreated = 0;
  const context = {
    console,
    window: { kaoruI18n: { t: (key) => key, language: 'es' } },
    Blob,
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    localStorage: { getItem: () => null, setItem() {} },
    assistant: {
      ttsStream: () => new Promise((resolve) => (resolveTts = resolve)),
    },
    getPythonBin: async () => '/usr/bin/python3',
    getAgentState: () => 'speaking',
    setAgentState() {},
    chatGestureEngine: null,
    chatDetectEmotion: () => 'default',
    audioCtx: null,
    isSpeaking: false,
    speechSynthesis: { cancel() {}, speak() {} },
    SpeechSynthesisUtterance: function SpeechSynthesisUtterance() {},
    Audio: function Audio() {
      audioCreated++;
      return { play: async () => {}, pause() {}, currentTime: 0 };
    },
  };
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'chat', 'tts.js'), 'utf8'),
    context
  );
  const pending = vm.runInContext("speak('Hola, estoy hablando')", context);
  await new Promise((resolve) => setImmediate(resolve));
  vm.runInContext("interruptSpeech('microphone')", context);
  resolveTts(new Uint8Array([1, 2, 3]));
  await pending;
  assert(audioCreated === 0, 'una generación TTS interrumpida no comienza a reproducirse');
  assert(
    vm.runInContext('isSpeaking', context) === false,
    'la interrupción libera el estado speaking'
  );
  let revoked = false;
  context.URL.revokeObjectURL = () => {
    revoked = true;
  };
  context.assistant.ttsStream = async () => new Uint8Array([1, 2, 3]);
  const playing = vm.runInContext("speak('Segunda respuesta')", context);
  await new Promise((resolve) => setImmediate(resolve));
  vm.runInContext("interruptSpeech('microphone')", context);
  const settled = await Promise.race([
    playing.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 100)),
  ]);
  assert(settled && revoked, 'interrumpir reproducción termina la promesa y libera el Blob');
}

async function main() {
  await testAsrPreservesSamples();
  await testTtsInterruptionInvalidatesPendingAudio();
  console.log(`\nResultado: ${passed} passed · ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
