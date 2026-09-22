# Interfaz de usuario (`src/`)

Dos ventanas Electron que renderizan el avatar Live2D y la interfaz de chat — la cara visible del asistente.

---

## `index.html` — overlay del avatar Live2D

Ventana overlay que renderiza el modelo Cubism usando **Pixi.js + live2d-display**.

- Canvas Live2D con animaciones y físicas.
- Siempre al frente (`alwaysOnTop`), fondo transparente con _click-through_.
- Indicadores de estado: despierto / escuchando / procesando.
- Burbuja de texto temporal para comandos de voz.
- Comunicación con el main process vía IPC (TTS, STT, estado).
- Carga el modelo Live2D activo (`models/`); se recarga en caliente al recibir `model-changed`.
- **Auto-fit por contenido + "piso"**: el tamaño de cada vista (full / half / head) se calcula de los
  límites reales del mesh (`coreModel.getDrawableVertexPositions`), no del canvas del modelo, para que
  cualquier modelo importado entre en pantalla. El borde inferior de la ventana es el "piso": en `full`
  los pies tocan el piso, en `half` la cintura, en `head` el cuello — la cabeza siempre arriba. Así un
  modelo pequeño queda anclado abajo (no flota en el medio). No hay desplazamiento suavizado ni
  rotación autónoma de encuadre: la vista elegida permanece fija. Las motions y expresiones del
  propio modelo conservan su suavidad, y los gestos pueden ampliar temporalmente su encuadre para
  no recortarse al sobresalir ligeramente del canvas.

## `chat.html` — ventana de chat

Interfaz completa de conversación con el asistente.

**Componentes:**

| Sección               | Propósito                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Header                | Workspace, modelo, estado, ajustes y botón de cancelar flujo                                                                                                 |
| Messages              | Burbujas con **streaming markdown incremental**, preview HTML en frame `sandbox`, chips de archivos, divisores de sesión, toast de **copiar al seleccionar** |
| Input area            | Texto con autocompletado de `/comando` y de `@archivo` (filtra mientras escribes), adjuntar, STT, enviar                                                     |
| Model panel           | Canvas Live2D integrado (vistas full / half / head) con **gestos LLM-driven** (`(gesto: x)`)                                                                 |
| Settings modal        | Proveedor/modelo, credenciales y permisos por capacidad: aplicaciones, navegador, pantalla, puntero, teclado, procesos y cámara                              |
| Propuestas proactivas | Burbujas de iniciativa con botones aceptar / descartar + resultado de ejecución                                                                              |

**Eventos IPC principales:**

| Evento                                     | Propósito                                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `init-theme`                               | Tema inicial (dark/sakura)                                                                                    |
| `chat-message`                             | Mensaje entrante desde el main process                                                                        |
| `memory-status`                            | Estado del banner de memoria                                                                                  |
| `openclaw-status`                          | Disponibilidad de OpenClaw                                                                                    |
| `initiative`                               | Mensaje iniciado proactivamente por el asistente                                                              |
| `initiative-decision`                      | Respuesta del usuario a una propuesta                                                                         |
| `agent-approval-needed` / `agent-progress` | Aprobaciones y progreso del bucle agente                                                                      |
| `agent-approval-expired`                   | La aprobación expiró (timeout): el card se marca como expirado y la acción NO se ejecutó                      |
| `plan-*`                                   | Eventos del plan actual; un run nuevo limpia planes anteriores y “continúa” retoma el último run interrumpido |
| `stt-*`                                    | Eventos de reconocimiento de voz                                                                              |
| `telemetry-report`                         | Reporte `/telemetria`                                                                                         |
| `model-changed`                            | Cambio de modelo Live2D (recarga del canvas)                                                                  |
| `views-changed`                            | Cambio del modo de vista del modelo (`full`/`half`/`head`/`random`, del comando `/modelo-vistas`)             |
| `resumed-session`                          | Sesión anterior retomada en silencio (repuebla el historial sin mensaje de sistema)                           |
| `workspace-changed`                        | Cambio del workspace activo (actualiza UI y resetea la caché de archivos)                                     |

**Tecnologías:** HTML + CSS (variables, temas, animaciones) + JavaScript de renderer aislado; las
dependencias permitidas (`marked`, `DOMPurify`, Pixi.js, Live2D) se exponen por loaders/preloads
acotados. La síntesis usa `core/voice/NeuralTts.js` en main, devuelve MP3 por IPC y
reproduce el audio con `HTMLAudioElement`; `cleanForTTS` limpia el texto hablado
(Markdown/emoji/código/comandos).

---

## Arquitectura de las ventanas

```mermaid
flowchart LR
    subgraph MAIN["main process"]
        CORE["Core"]
    end
    subgraph WIN1["index.html — overlay"]
        L2D["Canvas Live2D<br/>(Pixi.js + live2d-display)"]
        STT["STT (Vosk)"]
        TTS["TTS (edge-tts stream)"]
    end
    subgraph WIN2["chat.html — chat"]
        MSG["Mensajes<br/>(markdown + DOMPurify)"]
        PROPS["Propuestas proactivas"]
        SET["Ajustes y permisos"]
    end

    WIN1 <-->|"IPC"| CORE
    WIN2 <-->|"IPC"| CORE
    L2D <--> STT
    L2D --> TTS
    CORE -->|"initiative"| PROPS
    PROPS -->|"initiative-decision"| CORE
```

---

## Verificación

Cobertura del contrato IPC en `test_commands`, `test_server_security` y las suites E2E
(`tests/e2e/test_chat_to_agent_loop.js`). Ver `tests/README.md`.

Los mensajes y el contexto visible se pueden enviar al proveedor LLM configurado. La política
completa está en el [aviso de privacidad](../docs/web/privacy.html).
