#!/usr/bin/env python3
"""asr_stream.py — STT local con Vosk (offline).

Espejo inverso de tts_stream.py: lee un WAV (PCM 16 kHz mono 16-bit) por
stdin, lo transcribe con el modelo Vosk indicado y escribe la transcripción
(texto plano) por stdout. Cualquier error va a stderr y sale con código != 0
para que el main (AsrClient) lo convierta en un Error legible.

Uso:
    python asr_stream.py --model models/vosk-es < clip.wav

El modelo se descarga aparte (gitignored en models/vosk-es/):
    vosk-model-small-es-0.42
"""

import argparse
import io
import json
import sys
import wave


def main():
    ap = argparse.ArgumentParser(description="STT local con Vosk (WAV por stdin).")
    ap.add_argument("--model", required=True, help="ruta al modelo Vosk")
    ap.add_argument("--lang", default="es")
    args = ap.parse_args()

    try:
        from vosk import KaldiRecognizer, Model
    except ImportError as e:  # pragma: no cover
        print(json.dumps({"error": f"vosk no está instalado en Python: {e}"}), file=sys.stderr)
        sys.exit(2)

    raw = sys.stdin.buffer.read()
    try:
        w = wave.open(io.BytesIO(raw), "rb")
        if w.getframerate() != 16000 or w.getnchannels() != 1 or w.getsampwidth() != 2:
            print(
                json.dumps(
                    {
                        "error": (
                            f"WAV debe ser PCM 16 kHz mono 16-bit "
                            f"(es {w.getframerate()} Hz, {w.getnchannels()} ch)"
                        )
                    }
                ),
                file=sys.stderr,
            )
            sys.exit(3)
        pcm = w.readframes(w.getnframes())
    except Exception as e:
        print(json.dumps({"error": f"WAV inválido: {e}"}), file=sys.stderr)
        sys.exit(3)

    try:
        model = Model(args.model)
    except Exception as e:
        print(json.dumps({"error": f"no se pudo cargar el modelo ({args.model}): {e}"}), file=sys.stderr)
        sys.exit(4)

    rec = KaldiRecognizer(model, 16000)
    # Alimentar de a bloques: vosk emite partials pero solo interesa el final.
    CHUNK = 8000
    for i in range(0, len(pcm), CHUNK):
        rec.AcceptWaveform(pcm[i : i + CHUNK])
    final = json.loads(rec.FinalResult())
    print(final.get("text", "").strip())


if __name__ == "__main__":
    main()