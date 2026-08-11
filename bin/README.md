# Entry points CLI (`bin/`)

Puntos de entrada por terminal del asistente (sin ventana).

## `asistente.js`

Shim CLI tipo `opencode`: si el servidor de control está vivo en `:3131`, le notifica el workspace
nuevo y trae el chat al frente; si no, lanza la app apuntando al directorio actual. Es el binario
`asistente` de la instalación.

## `cli.js`

CLI headless (`asistente-cli`) con subcomandos:

- `run <consulta>` — consulta de una sola pasada.
- `chat` — REPL interactiva con streaming (`/exit`, `/checkpoint`, `/usage`).
- `sessions` — lista de sesiones pasadas.
- `checkpoint save|load|list|delete` — puntos de control de sesión.
- `usage` — consumo de LLM.
- `help`.

**Requiere el Node de Electron** (ABI de `better-sqlite3`/`sqlite-vec`):

```bash
ELECTRON_RUN_AS_NODE=1 npx electron bin/cli.js run "resumen del proyecto"
```
