"""
Voice_listener.py — escucha el micrófono y detecta wake words.
Ahora acepta --mic-index para usar el dispositivo seleccionado por el usuario.

Salida por stdout (una línea JSON por evento):
  {"type": "wake"}
  {"type": "command", "text": "abre el chat"}
  {"type": "error", "msg": "..."}

FIX (revisión con Claude): antes, find_best_microphone() y
validate_mic_index() abrían un sr.Microphone real por cada candidato
para "probarlo" — cada apertura crea una instancia nueva de
pyaudio.PyAudio() (Pa_Initialize()) y la destruye al cerrar
(Pa_Terminate()). Eso significaba 2-3+ ciclos completos de
init/terminate de PortAudio en el mismo proceso antes de la apertura
real en main(). En Linux con el backend ALSA, reinicializar PortAudio
varias veces seguidas en el mismo proceso corrompe el heap — es
exactamente el malloc()/free() corrupto que tumbaba el proceso cada
1.9-2.8s. Ahora el micrófono se elige por heurística de nombre, SIN
abrir ningún stream de prueba, así que solo hay UN ciclo real de
init/terminate en todo el programa.
"""

import sys
import json
import time
import argparse

def emit(obj):
    print(json.dumps(obj, ensure_ascii=False), flush=True)

try:
    import speech_recognition as sr
except ImportError:
    emit({"type": "error", "msg": "speech_recognition no instalado. Corre: pip install SpeechRecognition pyaudio"})
    sys.exit(1)

# ── Wake words ────────────────────────────────────────────────────────────────
WAKE_WORDS = [
    'marzo', 'march', '7 de marzo', 'siete de marzo',
    'hola marzo', 'oye marzo', 'hey marzo', 'march 7'
]

# ── Config ────────────────────────────────────────────────────────────────────
LISTEN_TIMEOUT   = 5
PHRASE_LIMIT     = 8
ENERGY_THRESHOLD = 300

recognizer = sr.Recognizer()
recognizer.energy_threshold         = ENERGY_THRESHOLD
recognizer.dynamic_energy_threshold = True
recognizer.pause_threshold          = 0.7


def transcribe(audio):
    try:
        return recognizer.recognize_google(audio, language='es-MX').lower().strip()
    except sr.UnknownValueError:
        return None
    except sr.RequestError as e:
        emit({"type": "error", "msg": f"STT error: {e}"})
        return None


def contains_wake(text):
    return any(w in text for w in WAKE_WORDS)


def extract_command(text):
    for w in sorted(WAKE_WORDS, key=len, reverse=True):
        idx = text.find(w)
        if idx != -1:
            return text[idx + len(w):].strip()
    return text


def find_best_microphone():
    """Elige el mejor candidato por nombre, SIN abrir ningún stream de
    audio real — ver nota de FIX arriba del archivo. Devuelve (idx, name)
    o (None, "default") si no hay candidatos viables por nombre."""
    names = sr.Microphone.list_microphone_names()

    PREFERRED = ['headset', 'auricular', 'razer', 'hyperx', 'rode', 'blue', 'usb audio', 'webcam']
    SKIP      = ['output', 'altavoc', 'speaker', 'spdif', 'hdmi', 'nvidia', 'mapper', 'spatial', 'game']

    candidates = []
    for i, name in enumerate(names):
        n = name.lower()
        if any(s in n for s in SKIP):
            continue
        score = next((10 - j for j, p in enumerate(PREFERRED) if p in n), 0)
        candidates.append((score, i, name))

    if not candidates:
        return None, "default"

    candidates.sort(reverse=True)
    score, idx, name = candidates[0]
    emit({"type": "log", "msg": f"micrófono elegido por nombre: [{idx}] {name}"})
    return idx, name


def validate_mic_index(index):
    """Verifica que el índice exista dentro del rango — sin abrir ningún
    stream de prueba (ver nota de FIX arriba del archivo). La validación
    real de si el dispositivo funciona pasa en el único open real, en
    main(), con fallback si falla."""
    names = sr.Microphone.list_microphone_names()
    if index < 0 or index >= len(names):
        return False, f"índice {index} fuera de rango (hay {len(names)} dispositivos)"
    return True, names[index]


def list_all_microphones():
    """Emite la lista completa de micrófonos al log."""
    names = sr.Microphone.list_microphone_names()
    for i, name in enumerate(names):
        emit({"type": "log", "msg": f"  [{i}] {name}"})


def _listen_loop(mic):
    """Loop principal de escucha — factorizado aparte para poder
    reusarlo tanto en el intento normal como en el fallback a mic
    default sin duplicar el código."""
    while True:
        try:
            # ── Fase 1: esperar wake word ─────────────────────────────────
            audio = recognizer.listen(mic, phrase_time_limit=PHRASE_LIMIT)
            text  = transcribe(audio)
            if not text:
                continue

            if not contains_wake(text):
                continue

            # Wake detectado
            emit({"type": "wake"})
            command = extract_command(text)

            if command:
                emit({"type": "command", "text": command})
                continue

            # ── Fase 2: escuchar comando ──────────────────────────────────
            emit({"type": "listening"})
            try:
                audio2 = recognizer.listen(mic, timeout=LISTEN_TIMEOUT, phrase_time_limit=PHRASE_LIMIT)
                text2  = transcribe(audio2)
                if text2:
                    emit({"type": "command", "text": text2})
                else:
                    emit({"type": "timeout"})
            except sr.WaitTimeoutError:
                emit({"type": "timeout"})

        except sr.WaitTimeoutError:
            continue
        except KeyboardInterrupt:
            break
        except Exception as e:
            emit({"type": "error", "msg": str(e)})
            time.sleep(1)


def main():
    parser = argparse.ArgumentParser(description='March 7th voice listener')
    parser.add_argument(
        '--mic-index', type=int, default=None,
        help='Índice del dispositivo de micrófono a usar (None = auto-detectar)'
    )
    args = parser.parse_args()

    emit({"type": "ready"})

    # Listar todos los micrófonos disponibles en el log
    emit({"type": "log", "msg": "Micrófonos disponibles:"})
    list_all_microphones()

    # Determinar qué micrófono usar (sin abrir ningún stream todavía)
    if args.mic_index is not None:
        emit({"type": "log", "msg": f"Usando micrófono indicado por el usuario: índice {args.mic_index}"})
        ok, info = validate_mic_index(args.mic_index)
        if ok:
            mic_index = args.mic_index
            mic_name  = info
            emit({"type": "log", "msg": f"Micrófono válido: {mic_name}"})
        else:
            emit({"type": "log", "msg": f"Micrófono {args.mic_index} no válido ({info}), usando auto-detección"})
            mic_index, mic_name = find_best_microphone()
    else:
        mic_index, mic_name = find_best_microphone()

    emit({"type": "log", "msg": f"Micrófono seleccionado: [{mic_index}] {mic_name}"})

    # FIX: único punto del programa donde se abre un stream de audio real.
    # Si falla, se cae UNA vez al default del sistema — no hay loop
    # probando candidatos, así que como mucho hay 2 ciclos de
    # Pa_Initialize()/Pa_Terminate() en todo el proceso (intento + fallback),
    # nunca los 3-4+ que causaban la corrupción de heap.
    try:
        with sr.Microphone(device_index=mic_index) as mic:
            recognizer.adjust_for_ambient_noise(mic, duration=1)
            emit({"type": "calibrated"})
            _listen_loop(mic)
    except KeyboardInterrupt:
        return
    except Exception as e:
        emit({"type": "log", "msg": f"no se pudo abrir micrófono [{mic_index}] ({e}), cayendo al default del sistema"})
        with sr.Microphone(device_index=None) as mic:
            recognizer.adjust_for_ambient_noise(mic, duration=1)
            emit({"type": "calibrated"})
            _listen_loop(mic)#


if __name__ == '__main__':
    main()