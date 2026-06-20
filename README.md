# 🎭 March 7th — Asistente Virtual de Escritorio

Overlay de escritorio para Windows con el modelo Live2D de March 7th (Honkai: Star Rail).  
Flota sobre cualquier aplicación, responde preguntas con IA, escucha tu voz y habla con TTS.

---

## ✨ Características

- 🖼️ **Live2D** — modelo animado flotando sobre el escritorio, siempre visible
- 💬 **Chat con IA** — conectado a Groq, Gemini u OpenAI con fallback automático
- 🎙️ **Voz en tiempo real** — transcripción local con Vosk (sin internet, sin Google)
- 🔊 **TTS** — síntesis de voz con Edge TTS (voz de Nanami en japonés)
- 🌸 **Temas** — Dark y Sakura
- 🖱️ **Click-through** — el overlay no interrumpe lo que estás haciendo
- 📌 **Tray** — control completo desde el ícono de bandeja del sistema
- 🎤 **Wake word** — activa el chat por voz sin tocar el teclado

---

## ✅ Requisitos

| Herramienta | Versión recomendada |
|-------------|-------------------|
| Windows | 10 / 11 (64 bits) |
| [Node.js](https://nodejs.org) | v22 LTS |
| [Python](https://python.org) | 3.11+ |

---

## 🚀 Instalación

### 1. Clonar el repositorio

```bash
git clone https://github.com/Dregxmoon/Asistente-Vtuber.git
cd Asistente-Vtuber
```

### 2. Instalar dependencias de Node.js

```bash
npm install
```

> ⚠️ **Si Electron falla al instalar en Windows**, ejecuta esto en PowerShell:
> ```powershell
> [System.IO.File]::WriteAllText("$PWD\node_modules\electron\path.txt", "electron.exe")
> ```
> Luego vuelve a ejecutar `npm install`.

### 3. Instalar dependencias de Python

```bash
pip install -r requirements.txt
```

Dependencias incluidas:
- **vosk** — reconocimiento de voz offline en tiempo real
- **sounddevice** — captura de audio del micrófono
- **numpy** — procesamiento de audio
- **edge-tts** — síntesis de voz (TTS)

> 💡 La primera vez que uses el micrófono, el modelo de Vosk (~50MB) se descargará automáticamente en `models/vosk-es/`.

### 4. Configurar API Keys

Copia el archivo de ejemplo y edítalo:

```bash
cp config.example.json config.json
```

Abre `config.json` y agrega al menos una key:

```json
{
  "llm": {
    "primary": "groq",
    "apiKeys": {
      "groq":   "gsk_...",
      "gemini": "AIza...",
      "openai": "sk-proj-..."
    },
    "fallback": ["gemini", "openai"]
  }
}
```

> 🔒 `config.json` está en `.gitignore` — tus keys nunca se suben al repositorio.

Puedes obtener keys gratis en:
- [Groq](https://console.groq.com) — recomendado, muy rápido
- [Google AI Studio](https://aistudio.google.com) — Gemini gratis
- [OpenAI](https://platform.openai.com) — de pago

### 5. Iniciar la aplicación

```bash
npm start
```

---

## 🗂️ Estructura del proyecto

```
Asistente-Vtuber/
├── src/
│   ├── chat.html          # Ventana de chat con Live2D
│   └── index.html         # Overlay Live2D flotante
├── core/
│   └── llm/
│       ├── LLMProvider.js # Manejo de proveedores IA con fallback
│       └── GroundingMinimo.js # Personalidad y contexto de March
├── Models/
│   └── March 7th/         # Modelo Live2D (.model3.json + assets)
├── models/
│   └── vosk-es/           # Modelo de voz (se descarga automático)
├── main.js                # Proceso principal de Electron
├── stt_transcribe.py      # Transcripción de voz en tiempo real (Vosk)
├── tts_stream.py          # Síntesis de voz (Edge TTS)
├── Voice_listener.py      # Wake word y comandos de voz
├── requirements.txt       # Dependencias Python
├── package.json           # Dependencias Node.js
└── config.json            # API keys (NO se sube al repo)
```

---

## 🎮 Uso

### Overlay
- **Doble clic** en el modelo → abre/cierra el chat
- **Clic derecho** en el tray → menú de opciones
- **Tray → Bloquear** → permite arrastrar el modelo por la pantalla
- **Tray → Vista** → cambiar entre cuerpo completo, medio cuerpo o solo cabeza

### Chat
- Escribe y presiona **Enter** para enviar
- Botón 🎙️ → **mantén presionado para hablar**, suelta para transcribir
- El texto aparece en tiempo real mientras hablas
- Botón ⚙️ → configurar API keys sin reiniciar la app
- Arrastra archivos al chat para adjuntarlos

### Voz (wake word)
Pronuncia **"March"** o **"Hey March"** para activar el micrófono sin tocar nada.  
Comandos disponibles:
- *"Abre el chat"* → abre la ventana de chat
- *"Cierra el chat"* → cierra la ventana de chat
- Cualquier otra frase → se envía como mensaje al chat

---

## 🛠️ Solución de problemas

### Electron no inicia
```powershell
[System.IO.File]::WriteAllText("$PWD\node_modules\electron\path.txt", "electron.exe")
npm start
```

### Python no se encuentra
Si ves errores como `spawn python ENOENT`, edita `main.js` y cambia `PYTHON_BIN` a la ruta de tu Python:
```js
const PYTHON_BIN = 'C:/Users/TU_USUARIO/AppData/Local/Programs/Python/Python311/python.exe';
```

Para encontrar tu ruta exacta:
```powershell
(Get-Command python).Source
```

### El micrófono no funciona
1. Verifica que `sounddevice` y `vosk` estén instalados: `pip list`
2. Selecciona el micrófono correcto en el selector **MIC** en la parte inferior del chat
3. El modelo de voz se descarga automático la primera vez (~50MB)

### La IA no responde
1. Abre el chat → botón ⚙️ → verifica que tengas al menos una API key configurada
2. Groq es gratuito y el más rápido — [obtén tu key aquí](https://console.groq.com)

---

## 📦 Tecnologías

| Capa | Tecnología |
|------|-----------|
| Desktop | Electron |
| Animación | Live2D Cubism SDK + PixiJS |
| IA | Groq / Gemini / OpenAI |
| STT | Vosk (offline) |
| TTS | Edge TTS (Microsoft Neural) |
| Voz | SpeechRecognition + Python |

---

## 📝 Notas

- El modelo Live2D de March 7th pertenece a **HoYoverse** — uso personal únicamente, no distribuir.
- Las API keys se guardan localmente en `config.json` y nunca salen de tu equipo.
- Probado en Windows 10/11 con Python 3.11 y Node.js 22.
