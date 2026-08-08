// @ts-nocheck
// Input
let _ttsMuted = false;

function setTtsMuted(value) {
  _ttsMuted = !!value;
}

function isTtsMuted() {
  return _ttsMuted;
}

function getAudioCtx() {
  if (!audioCtx || audioCtx.state === 'closed') audioCtx = new AudioContext();
  return audioCtx;
}
function cleanForTTS(text) {
  return text
    .replace(/#{1,6}\s+/g, '') // quitar headers markdown
    .replace(/\*\*(.+?)\*\*/g, '$1') // quitar negritas
    .replace(/\*(.+?)\*/g, '$1') // quitar cursivas
    .replace(/`{1,3}[^`]*`{1,3}/g, '') // quitar código
    .replace(/\[(.+?)\]\(.+?\)/g, '$1') // quitar links, dejar texto
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
async function speak(text) {
  if (_ttsMuted) return;
  if (isSpeaking) return;
  isSpeaking = true;
  const spokenText = cleanForTTS(text);
  if (chatGestureEngine && chatGestureEngine.enabled)
    chatGestureEngine.setEmotion(chatDetectEmotion(spokenText));
  try {
    const pythonBin = await getPythonBin();
    if (!pythonBin) throw new Error('No se encontró un intérprete de Python — TTS no disponible');
    const u8 = await assistant.ttsStream({ pythonBin, text: spokenText });
    // NO usar WebAudio decodeAudioData: en Chromium 28 el decoder nativo
    // (AsyncAudioDecoder → AudioBuffer::AudioBuffer(AudioBus*)) crashea con
    // SEGV ante MP3 inválido/corto (exitCode 139, tumba el renderer). Se
    // reproduce con HTMLAudioElement + Blob URL (pipeline de media, robusto).
    const blob = new Blob([u8], { type: 'audio/mpeg' });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    await new Promise((resolve) => {
      audio.onended = resolve;
      audio.onerror = resolve;
      audio.play().catch(resolve);
    });
    URL.revokeObjectURL(url);
  } catch {
    const utt = new SpeechSynthesisUtterance(spokenText);
    utt.lang = 'ja-JP';
    utt.pitch = 1.3;
    utt.rate = 1.05;
    await new Promise((r) => {
      utt.onended = r;
      speechSynthesis.speak(utt);
    });
  }
  isSpeaking = false;
}
