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

| Módulo | Canales que expone | Responsabilidad |
|---|---|---|
| `window-model-handlers.js` | overlay/modelo/vistas | ventana overlay, click-through, cambios de modelo Live2D, `broadcastViewsChanged` |
| `memory-handlers.js` | `memory-add-turn`, `memory-stats`, `initiative-decision`, `grounding-build-context`, `generate-plan`, `os-get-context`, `os-get-today-*` | turnos, contexto, memoria, sensores del SO |
| `config-handlers.js` | config/keys/python-bin | leer/guardar `config.json`, API keys, binario de Python |
| `init-vectors-handlers.js` | `init-vectors`, `proactive-*`, `exec-command` | indexado vectorial, comandos de ejecución |
| `openclaw-handlers.js` | `openclaw-*`, `plan-*`, `agent-run` | puente OpenClaw, planes con aprobación, `runAgent` |
| `mcp-handlers.js` | MCP/workspace/telemetria | servidores MCP, workspace activo, telemetría |
| `github-handlers.js` | `github-*` | login OAuth, issues/PRs |

## Flujo típico

1. El renderer llama `ipcRenderer.invoke('memory-stats')` (canal `handle`) o envía `ipcRenderer.send(...)` (canal `on`).
2. El handler invoca la API correspondiente de `core/` y devuelve el resultado.
3. Los eventos del núcleo se propagan al renderer con `webContents.send(...)` (p. ej. propuestas proactivas, solicitudes de aprobación de herramientas).

Los canales de aprobación (`plan-approval-needed` / `agent-approval-needed`) son
el único camino por el que una herramienta de alto impacto llega a ejecutarse:
el renderer muestra el diálogo y la respuesta vuelve por
`plan-approval-response` / `agent-approval-response`.

---

## Verificación

El smoke test de arranque real (sin errores en el renderer) y la suite completa
(`npm test`) cubren los flujos IPC; ver `tests/README.md`.
