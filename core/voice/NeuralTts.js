// @ts-check
'use strict';

const { randomUUID } = require('crypto');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { EdgeTTS } = require('node-edge-tts');

/**
 * Sintetiza la voz en el proceso principal. Node y la librería se distribuyen
 * con Electron, por lo que el usuario no necesita instalar Python.
 * @param {{text?: unknown, voice?: unknown, rate?: unknown, pitch?: unknown}} args
 * @returns {Promise<Buffer>}
 */
async function synthesize(args = {}) {
  const text = String(args.text || '').trim();
  if (!text || text.length > 10000) throw new Error('TTS: texto vacío o demasiado largo');
  const voice = String(args.voice || 'ja-JP-NanamiNeural');
  const rate = String(args.rate || '+10%');
  const pitch = String(args.pitch || '+20Hz');
  if (!/^[a-zA-Z0-9-]+$/.test(voice)) throw new Error('TTS: voice contiene caracteres inválidos');
  if (!/^[+-]\d{1,3}%$/.test(rate)) throw new Error('TTS: rate debe tener formato +/-N%');
  if (!/^[+-]\d{1,3}Hz$/.test(pitch)) throw new Error('TTS: pitch debe tener formato +/-NHz');

  const file = path.join(os.tmpdir(), `kaoru-tts-${randomUUID()}.mp3`);
  try {
    const tts = new EdgeTTS({
      voice,
      lang: voice.split('-').slice(0, 2).join('-'),
      rate,
      pitch,
      outputFormat: 'audio-24khz-96kbitrate-mono-mp3',
      timeout: 20000,
    });
    await tts.ttsPromise(text, file);
    const audio = await fs.readFile(file);
    if (!audio.length) throw new Error('TTS: el servicio devolvió audio vacío');
    return audio;
  } finally {
    await fs.unlink(file).catch(() => {});
  }
}

module.exports = { synthesize };
