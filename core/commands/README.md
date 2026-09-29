# Chat commands

Commands run in the chat, not in the integrated terminal. `CommandRegistry.js` registers each canonical English name and its compatibility aliases. `/help` shows the canonical usage, aliases, and descriptions in the selected UI language; the slash command itself is not translated.

| Canonical | Existing alias | Purpose |
| --- | --- | --- |
| `/help` | — | Show current command help. |
| `/model` | — | Choose an AI provider/model. |
| `/memory-graph` | `/memoria` | Open the visual memory explorer. |
| `/history` | `/memory` | Show recent chat messages. `/memory` keeps its old meaning. |
| `/mute` | `/mudo` | Toggle speech output. |
| `/forget <text>` | `/olvida <texto>` | Archive matching memories. |
| `/sessions` | `/sesiones` | Open previous chats and terminals. |
| `/permissions` | `/permisos` | Open tool permissions. |
| `/workspace` | `/dir` | Choose a project folder. |
| `/usage [recent\|reset]` | `/uso [recientes\|reset]` | Show or reset LLM usage counters. |
| `/telemetry` | `/telemetria` | Show local activity comparison. |
| `/avatar-model` | `/cambio-modelo` | Choose the Live2D model. |
| `/avatar-view` | `/modelo-vistas` | Choose the avatar framing. |
| `/gestures` | `/gestos` | Inspect or test gestures. |
| `/revert-task` | `/revertir-tarea` | Inspect/recover a task checkpoint. |
| `/resume-task` | `/reanudar-tarea` | Resume a pending task. |
| `/goal-autonomy` | `/autonomia-meta` | Set governance for a goal. |
| `/tasks` | `/estado` | Inspect pending tasks. |

Other active commands are discoverable with `/help`. `/init`, `/review`, `/plan`, `/fix`, `/undo`, and `/code` are deliberately removed from the production index; do not document them as available. Changing the displayed language does not alter command behavior.

The chat renderer sends a command through the allowlisted `chat-run-command` IPC channel. Main builds the command context, runs the handler, and returns the result. `FileResolver.js` resolves `@file` references inside the active workspace; it is not a generic filesystem path escape hatch.

Run `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron tests/test_commands.js` for the command contract. More specific file- and IPC-level tests cover their respective handlers.
