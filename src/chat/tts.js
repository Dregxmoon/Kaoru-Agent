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
// Limpia el texto para TTS: deja SOLO el mensaje hablado de Kaoru. Elimina
// bloques de código (fences), código inline, HTML crudo, líneas de actividad
// de tools (Write/Edit/Bash), rutas de archivo, instrucciones y símbolos —
// la voz no debe leer código, comandos ni notación técnica.
function cleanForTTS(text) {
  return (
    String(text || '')
      // Bloques de código fences (```...``` o ~~~...~~~) con o sin lenguaje.
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/~~~[\s\S]*?~~~/g, ' ')
      // HTML crudo completo o fragmentos (entre corchetes angulares).
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<!DOCTYPE[\s\S]*?>(\s*<html[\s\S]*?<\/html>)?/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      // Líneas de actividad del agente: "Write(ruta)", "✓ write", "Edit(...)",
      // "Bash(...)", "ok · 59ms" y similares (tool name + paréntesis o check).
      .replace(
        /^[ \t]*[✓✔✗]?\s*(write|edit|apply_patch|read|bash|grep|web_search|browser|openclaw)\b.*$/gim,
        ' '
      )
      .replace(/^[ \t]*[✓✔✗]\s*[a-z_]+.*$/gim, ' ')
      .replace(/^[ \t]*ok[ \t]*·?[ \t]*[\d.]+ms.*$/gim, ' ')
      .replace(/^[ \t]*ok[ \t]*$/gim, ' ')
      // Links markdown: dejar el texto, quitar la URL completa (ANTES de rutas,
      // para que el '/' de la URL no la confunda con una ruta de archivo).
      .replace(/\[([^\]]*)\]\((?:[^)\s]+|[^)]*?\([^)]*\))\)/g, '$1')
      .replace(/https?:\/\/\S+/gi, ' ')
      // Rutas de archivo sueltas (absolutas o relativas, con / y extensión) y
      // comandos /xxx. Se requieren 2+ segmentos o 1 segmento con extensión para
      // no comerse palabras sueltas ni fechas (12/03/2024).
      .replace(/(^|[\s,;.:])\/[A-Za-z0-9_.-]+(?:[/\\][A-Za-z0-9_.-]+)+/gi, '$1 ')
      .replace(
        /(^|[\s,;.:])[A-Za-z][A-Za-z0-9_.-]*(?:[/\\][A-Za-z0-9_.-]+)+(?:\.[a-z0-9]{1,5})?/gi,
        '$1 '
      )
      // Comandos /comando al inicio de línea o precedidos por espacio.
      .replace(/(^|\s)\/[a-z-]+(?=\s|$)/gi, '$1')
      // Rutas sueltas de un solo segmento (/archivo.ext) y nombres de tools del
      // flujo agente que no son lenguaje hablado (read_file, write_file, ...).
      .replace(/(^|[\s,;.:])\/[A-Za-z0-9_.-]+\.[a-z0-9]{1,5}(?=\s|$|[),;.])/gi, '$1 ')
      .replace(
        /\b(?:read_file|write_file|edit_file|apply_patch|web_search|list_files|run_bash|tool_use)\b/gi,
        ' '
      )
      // Headers markdown y resto de formato.
      .replace(/#{1,6}\s+/g, '')
      .replace(/\*\*(.+?)\*\*/g, '$1') // quitar negritas
      .replace(/\*(.+?)\*/g, '$1') // quitar cursivas
      .replace(/`{1,3}[^`]*`{1,3}/g, '') // quitar código inline
      .replace(/\[(.+?)\]\(.+?\)/g, '$1') // quitar links residuales, dejar texto
      // Símbolos y emojis (checks, alertas, iconos). Los emojis con variante de
      // presentación (VS16) se quitan aparte para no romper la clase de chars.
      .replace(/[✓✔✗🚀✨🎉]/gu, ' ')
      .replace(/⚠️|🗑️|📁|💾|📂|🔍|❤️/gu, ' ')
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
      // Normalizar espacios y puntuación sobrante.
      .replace(/\s*[·••,;:]\s*/g, ' ')
      .replace(/[`*_~#>|]/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
  );
}
async function speak(text) {
  if (_ttsMuted) return;
  if (isSpeaking) return;
  isSpeaking = true;
  setAgentState('speaking', 'Hablando');
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
  // Solo volver a "listo" si nadie más cambió el estado mientras hablaba.
  if (getAgentState() === 'speaking') setAgentState('idle', 'Listo');
}
