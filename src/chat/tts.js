// Input
function getAudioCtx() {
  if (!audioCtx || audioCtx.state === 'closed') audioCtx = new AudioContext();
  return audioCtx;
}
function cleanForTTS(text) {
  return text
    .replace(/#{1,6}\s+/g, '')          // quitar headers markdown
    .replace(/\*\*(.+?)\*\*/g, '$1')    // quitar negritas
    .replace(/\*(.+?)\*/g, '$1')        // quitar cursivas
    .replace(/`{1,3}[^`]*`{1,3}/g, '') // quitar código
    .replace(/\[(.+?)\]\(.+?\)/g, '$1') // quitar links, dejar texto
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu,'')
    .replace(/\s{2,}/g, ' ').trim();
}
async function speak(text) {
  if (isSpeaking) return;
  isSpeaking = true;
  const spokenText = cleanForTTS(text);
  const scriptPath = path.join(__dirname, '..', 'tts_stream.py');
  if (chatGestureEngine && chatGestureEngine.enabled) chatGestureEngine.setEmotion(chatDetectEmotion(spokenText));
  try {
    const pythonBin = await getPythonBin();
    if (!pythonBin) throw new Error('No se encontró un intérprete de Python — TTS no disponible');
    await new Promise((resolve, reject) => {
      const chunks = [];
      const proc = cp.spawn(pythonBin, [scriptPath,'--voice',TTS_VOICE,'--rate','+10%','--pitch','+20Hz','--text',spokenText]);
      proc.stdout.on('data', c => chunks.push(c));
      proc.on('close', async (code) => {
        if (code !== 0 || !chunks.length) { reject(new Error('TTS failed')); return; }
        try {
          const buf = Buffer.concat(chunks);
          const ab  = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
          const ctx = getAudioCtx();
          const audioBuf = await ctx.decodeAudioData(ab);
          const src = ctx.createBufferSource();
          src.buffer = audioBuf; src.connect(ctx.destination); src.start(0);
          src.onended = resolve;
        } catch(e) { reject(e); }
      });
      proc.on('error', reject);
    });
  } catch {
    const utt = new SpeechSynthesisUtterance(spokenText);
    utt.lang = 'ja-JP'; utt.pitch = 1.3; utt.rate = 1.05;
    await new Promise(r => { utt.onend = r; speechSynthesis.speak(utt); });
  }
  isSpeaking = false;
}
