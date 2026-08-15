// @ts-nocheck
// ASR: entrada de voz (micrófono → WAV PCM 16k mono → chat-asr-stream).
//
// La grabación ocurre en el renderer (sandbox:true no permite capturar audio
// desde main). Se captura PCM directo con AudioContext(16000) +
// ScriptProcessorNode y se empaqueta como WAV en memoria — sin MediaRecorder
// (webm/opus obligaría a decodificar y agregaría dependencias) y sin
// decodeAudioData (crashea el renderer en Chromium 28 con MP3 inválido).
let _micStream = null;
let _micCtx = null;
let _micProcessor = null;
let _micSamples = [];
let _recording = false;

function _micButton() {
  return document.getElementById('mic-btn');
}

function _setMicButton(recording) {
  const btn = _micButton();
  if (btn) {
    btn.classList.toggle('recording', recording);
    btn.title = recording ? 'Detener y transcribir' : 'Entrada de voz (STT)';
  }
  setAgentState(recording ? 'listening' : 'idle', recording ? 'Escuchando...' : 'Listo');
}

async function startMicRecording() {
  if (_recording) return true;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setAgentState('error', 'Micrófono no disponible (getUserMedia)');
    return false;
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  _micStream = stream;
  const ctx = new AudioContext({ sampleRate: 16000 });
  _micCtx = ctx;
  const source = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  _micProcessor = processor;
  _micSamples = [];
  processor.onaudioprocess = (e) => {
    if (_recording) _micSamples.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  };
  source.connect(processor);
  // Gain 0: mantiene el grafo de audio vivo sin mandar el mic a los altavoces
  // (conectado a destination directo habría feedback).
  const mute = ctx.createGain();
  mute.gain.value = 0;
  processor.connect(mute);
  mute.connect(ctx.destination);
  _recording = true;
  _setMicButton(true);
  return true;
}

async function stopMicRecording() {
  if (!_recording) return null;
  _recording = false;
  _setMicButton(false);
  const ctx = _micCtx;
  try {
    if (_micProcessor) _micProcessor.disconnect();
  } catch {}
  try {
    if (ctx && ctx.state !== 'closed') ctx.close();
  } catch {}
  if (_micStream) _micStream.getTracks().forEach((t) => t.stop());
  _micProcessor = null;
  _micCtx = null;
  _micStream = null;

  const sampleLen = _micSamples.reduce((n, a) => n + a.length, 0);
  _micSamples = [];
  if (sampleLen < 1600) return null; // <100 ms de audio → ignorar (clic accidental)
  const merged = new Float32Array(sampleLen);
  let off = 0;
  for (const a of _micSamples) {
    merged.set(a, off);
    off += a.length;
  }
  const wav = encodeWavPcm(merged, ctx ? ctx.sampleRate : 16000);
  setAgentState('working', 'Transcribiendo...');
  try {
    const pythonBin = await getPythonBin();
    if (!pythonBin) throw new Error('No se encontró Python — STT no disponible');
    return await assistant.asrStream({ pythonBin, wav: new Uint8Array(wav), lang: 'es' });
  } finally {
    if (getAgentState() === 'working') setAgentState('idle', 'Listo');
  }
}

async function toggleMicRecording() {
  if (_recording) {
    const text = await stopMicRecording();
    if (text) {
      const input = document.getElementById('msg-input');
      const sep = input.value && !input.value.endsWith(' ') ? ' ' : '';
      input.value = (input.value + sep + text).trimStart();
      input.focus();
      input.dispatchEvent(new Event('input'));
    }
  } else {
    try {
      await startMicRecording();
    } catch {
      setAgentState('error', 'Sin permiso de micrófono');
    }
  }
}

// Empaqueta Float32 PCM en un WAV (PCM 16-bit mono). Devuelve un ArrayBuffer.
function encodeWavPcm(samples, sampleRate) {
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeStr = (offset, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  new Int16Array(buffer, 44, samples.length).set(pcm);
  return buffer;
}

const micBtn = _micButton();
if (micBtn) micBtn.addEventListener('click', toggleMicRecording);
