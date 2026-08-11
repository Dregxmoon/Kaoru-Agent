# Ventana de chat (`src/chat/`)

La ventana de conversación del asistente (renderer **aislado**: `contextIsolation: true`,
`nodeIntegration: false`). La página `src/chat.html` carga estos módulos como scripts clásicos en
orden; solo ven el puente `window.assistant` construido por `preload.js`.

## Piezas

| Archivo            | Responsabilidad                                                                                                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `preload.js`       | Construye el puente `window.assistant` vía `contextBridge` (wrappers de LLMProvider, CommandRegistry, FileResolver, AgentManager, ModelAugmenter + invoke/send/on) y pre-renderiza `marked`/DOMPurify — la página solo recibe HTML saneado |
| `core.js`          | Bootstrap (primer script): shims del sandbox y dispatch de comandos                                                                                                                                                                        |
| `ipc.js`           | Listeners IPC: cierre, tema, mensajes entrantes, cambio de modelo/vistas, estado de OpenClaw                                                                                                                                               |
| `input.js`         | Entrada del chat: cursor de bloque estilo terminal, textarea multilínea, hints y autocompletado de comandos                                                                                                                                |
| `messages.js`      | Render de mensajes: burbujas por rol, Markdown + mermaid, chips de archivos                                                                                                                                                                |
| `activityBlock.js` | Bloques de actividad por tool (progreso del agente): líneas `Read()`/`Bash()`/`Edit()` con ok/err, expansión con diffs coloreados, spinner y reveal progresivo                                                                             |
| `process.js`       | Pipeline de proceso: compresión de historial si el asistente falla repetido, manejo del agent-run y streaming                                                                                                                              |
| `sessions.js`      | Modal de sesiones pasadas: retomar conversaciones cerradas vía IPC `sessions-list`/`session-load`                                                                                                                                          |
| `nodes.js`         | Vista del grafo de memoria (`/memoria`): layout force-directed (Fruchterman-Reingold) con nodos y aristas vía IPC `nodes-graph`                                                                                                            |
| `mcp.js`           | Panel de servidores MCP: listado, búsqueda en el registro, alta manual                                                                                                                                                                     |
| `permissions.js`   | Panel de permisos allow/ask/deny (reglas persistentes vía `core/security/PermissionManager`)                                                                                                                                               |
| `tts.js`           | Síntesis de voz: mute, AudioContext y `cleanForTTS` (limpia Markdown/emoji/código)                                                                                                                                                         |
| `live2d.js`        | Mini-avatar Live2D (PIXI + live2d-display), cambio de modelo, vistas y errores                                                                                                                                                             |

Estilo en `src/chat.css`; los estilos del mini-avatar en `src/css/`.
