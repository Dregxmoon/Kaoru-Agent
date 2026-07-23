# Interfaz de usuario

Ventanas de Electron que renderizan el avatar Live2D y la interfaz de chat.

## Archivos

### index.html 
Ventana overlay del avatar Live2D. Renderiza el modelo Cubism usando Pixi.js + live2d-display.

**Características:**
- Canvas Live2D con animaciones y físicas
- Siempre al frente (`alwaysOnTop: true`)
- Fondo transparente con click-through
- Indicador de estado: despierto/escuchando/procesando
- Burbuja de texto temporal para comandos de voz
- Se comunica con main process vía IPC

### chat.html 
Ventana completa de interfaz de chat con March.

**Componentes:**
| Sección | Propósito |
|---|---|
| Header | Indicador de estado, selector de modo, badge OpenClaw/MCP, tema |
| Messages | Burbujas de chat con markdown, typewriter, divisores de sesión |
| Input area | Input de texto, botones de adjuntar/STT/enviar |
| Model panel | Canvas Live2D integrado con vistas (full/half/head) |
| Settings modal | Configuración de API keys (Groq, Gemini, OpenAI) |
| MCP modal | Administración de servidores MCP (biblioteca + JSON manual) |

**Eventos IPC que maneja:**
| Evento | Propósito |
|---|---|
| `init-theme` | Tema inicial (dark/sakura) |
| `init-mode` | Modo inicial (conversación/tareas) |
| `chat-message` | Mensaje entrante desde main process |
| `chat-speak` | Texto a sintetizar por TTS |
| `memory-status` | Estado del banner de memoria |
| `openclaw-status` | Disponibilidad de OpenClaw |
| `plan-*` | Eventos del plan de ejecución |
| `march-initiative` | Mensaje iniciado por March |
| `stt-*` | Eventos de reconocimiento de voz |

**Tecnologías:** HTML + CSS (variables, temas, animaciones), Vanilla JS con `require()` de Electron (marked, DOMPurify, Pixi.js, Live2D).
