# Orquestación interna (`core/core/`)

Torre de control del proceso main. Esta carpeta **no** es un "core dentro del core": es la fachada
operativa que `main.js` e `ipc/` usan. `state.js` centraliza el estado compartido para que los
submódulos no dependan entre sí en forma circular.

## Piezas clave

| Archivo                                           | Responsabilidad                                                                                                                                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init.js`                                         | Secuencia de arranque: migración de BD, grafo/grounding/sesiones, sensores, ProactiveEngine, BehaviorModel, planner, MCP, LSP, skills, plugins, permisos, telemetría y workspace inicial |
| `context.js`                                      | `buildContext`: ensambla el system prompt (BehaviorModel, intent/task, grounding, reglas, tools, skills, modos) con truncado _smart_ por sección (máx. ~14k)                             |
| `agent.js`                                        | `runAgent` / `resolveAgentMode`: bucle cerrado de tool-calling (AgentLoop) y resolución automática de modo por intención                                                                 |
| `session.js`                                      | `startSession`/`closeSession`/`getSessionHistory`/`restoreSessionHistory`/snapshot (checkpoints)                                                                                         |
| `misc.js`                                         | Callbacks del motor proactivo (`onInitiative`, `onProposalResult`, `handleProposalDecision`), canal de chat y helpers de prueba                                                          |
| `mcp.js` · `openclaw.js` · `lsp` (en `core/lsp/`) | Vida de los servidores MCP / herramientas locales (`openclaw-server.js`) con watchdog y limpieza de huérfanos en `/proc`                                                                 |
| `permissions.js` · `security`                     | Reglas allow/ask/deny expuestas al panel y la Control API                                                                                                                                |
| `learning.js` · `trust.js`                        | API pública de `LearningEngine` y `TrustModel` (pesos, outcomes, recomendación de modo)                                                                                                  |
| `intentions.js`                                   | Fachada sobre IntentionsStore (pila de objetivos persistente)                                                                                                                            |
| `stats.js` · `workspace.js`                       | Estadísticas/telemetría y cambio de workspace activo (reinicia OpenClaw, MCP fs y LSP)                                                                                                   |
| `shutdown.js`                                     | Apagado **ordenado**: mata huérfanos (timer SIGKILL de respaldo), desconecta MCP, detiene LSP/sensores/ProactiveEngine, cierra la BD                                                     |

## Etiqueta

```
core/core
        ├── init.js · context.js · agent.js · session.js · shutdown.js
        ├── misc.js · state.js · stats.js · workspace.js
        ├── intentions.js · learning.js · trust.js
        ├── mcp.js · openclaw.js · permissions.js · config.js
        └── README.md
```
