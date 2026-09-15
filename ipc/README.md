# Capa IPC (`ipc/`)

Puente Electron entre el renderer (`src/chat/*.js`, `src/index.html`) y el núcleo
(`core/`). Cada módulo registra sus canales con `register(ctx)` y recibe el
contexto compartido `S` + helpers de `main.js`; el resultado es un `main.js`
delgado que solo orquesta el ciclo de vida.

---

## `state.js` — estado compartido

`createSharedState(initial)` devuelve el objeto `S` único del proceso principal:
ventanas (`mainWindow`, `chatWindow`), `tray`, estado del overlay
(`isClickThrough`, `currentView`, `userHasMoved`), `chatTheme` y `activeModelId`.

## Handlers (uno por dominio)

| Módulo                     | Canales que expone                                                                                                              | Responsabilidad                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `window-model-handlers.js` | overlay/modelo/vistas                                                                                                           | ventana overlay, click-through, cambios de modelo Live2D, `broadcastViewsChanged`                                                   |
| `memory-handlers.js`       | `memory-add-turn`, `initiative-decision`, `grounding-build-context`, `sessions-*`, `memory-forget`, `list-skills`, `store-fact` | turnos, contexto, memoria, sesiones, skills                                                                                         |
| `config-handlers.js`       | config/keys/python-bin                                                                                                          | leer/guardar `config.json`, API keys, binario de Python                                                                             |
| `init-vectors-handlers.js` | `exec-command`                                                                                                                  | comandos de lectura acotados (último commit y lint); no modifica Git                                                              |
| `openclaw-handlers.js`     | `openclaw-available`, `openclaw-status`, `agent-run`, `agent-cancel`, `agent-steer`, `agent-run-status`                         | puente OpenClaw, ejecución/reanudación, correcciones en curso, aprobación y cancelación; expone el aislamiento efectivo del proceso |
| `mcp-handlers.js`          | MCP/workspace/telemetria                                                                                                        | servidores MCP, workspace activo, telemetría                                                                                        |
| `github-handlers.js`       | `github-*`                                                                                                                      | login OAuth, issues/PRs                                                                                                             |

## Flujo típico

1. El renderer llama `ipcRenderer.invoke('...')` (canal `handle`) o envía `ipcRenderer.send(...)` (canal `on`).
2. El handler invoca la API correspondiente de `core/` y devuelve el resultado.
3. Los eventos del núcleo se propagan al renderer con `webContents.send(...)` (p. ej. propuestas proactivas, solicitudes de aprobación de herramientas).

El canal `agent-cancel` aborta la ejecución en curso: crea un `AbortController` por `agent-run`
y `agent-cancel` lo aborta, propagando el `signal` por `Core.runAgent` → `AgentLoop.run` →
`LLMProvider` (rechaza con `AbortError`, `code: 'ABORTED'`).

Los resultados de `agent-run` propagan `meta` (p. ej. `addedLines`/`removedLines` de los diffs de
`edit`/`apply_patch`) para que la UI distinga lo nuevo de lo actualizado.

El canal de aprobación (`agent-approval-needed` / `agent-approval-response`) es el camino interactivo
para herramientas que la política resuelve como `ask`; una regla explícita `allow` puede ejecutar sin
tarjeta y `deny` bloquea antes del executor. Para las capacidades sensibles de escritorio, el handler
excluye la autoaprobación global y conserva el consentimiento por sesión. El renderer muestra el
diálogo y la respuesta vuelve por el mismo canal. Si el
usuario no responde dentro de `agent.approvalTimeoutMs` (config.json; default
120 s), el main envía `agent-approval-expired` para que la tarjeta se marque
como expirada y deniega la acción — el loop distingue este caso
(`aprobacion_expirada`) de una cancelación explícita y el cierre del agente lo
refleja en el texto final.

---

## Verificación

El smoke test de arranque real (sin errores en el renderer) y la suite completa
(`npm test`) cubren los flujos IPC; ver `tests/README.md`.
