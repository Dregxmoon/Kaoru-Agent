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
    const ctx = getAudioCtx();
    const audioBuf = await ctx.decodeAudioData(u8.buffer);
    const src = ctx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(ctx.destination);
    src.start(0);
    await new Promise((resolve) => {
      src.onended = resolve;
    });
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
