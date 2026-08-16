# AGENTS.md

Reglas de proyecto para cualquier agente (este asistente u otro) que trabaje
en el repositorio Asistente-Vtuber.

## Stack y convenciones

- **Runtime:** Electron 28 (main + 2 ventanas con `contextIsolation:true` y
  `sandbox` acotado). CommonJS puro — NO uses ESM ni `import`.
- **Lenguaje:** JavaScript con JSDoc estricto. Los módulos nuevos del pipeline
  deben incluir `// @ts-check` y cumplir `npm run typecheck` (tsc con
  `noImplicitAny`/`strictNullChecks`). No introduzcas TypeScript con build.
- **Estilo:** Prettier (comillas simples, `printWidth: 100`) y ESLint sin
  errores. Corre `npm run format` antes de commitear.
- **Pruebas:** suite por archivo en `tests/` (runner = Node de Electron vía
  `ELECTRON_RUN_AS_NODE=1`). Nunca uses `node` del sistema para correr pruebas
  que toquen `better-sqlite3`/`sqlite-vec` (ABI distinto).
- **Módulos nativos:** `better-sqlite3`/`sqlite-vec` usan ABI de V8 → se
  reconstruyen contra Electron (`npm run rebuild`). `onnxruntime-node` es
  **NAPI** (ABI estable): NO se reconstruye con electron-rebuild — si falla con
  `Module did not self-register`, el prebuild está corrupto y se repara
  reinstalando el paquete (`npm install onnxruntime-node` o `npm ci`).
  `EmbedService.checkNativeBindings()` diagnostica esto en runtime.

## Reglas del agente de código

1. **Edición determinista:** usa `edit` con coincidencia única. Si `old_text`
   no es único o no existe, NO modifiques el archivo; pide más contexto.
2. **Verificación:** tras editar código, ejecuta `node --check` sobre los
   archivos tocados y la suite de tests relevante. El LSP está disponible
   (`get_diagnostics`, `go_to_definition`, etc.).
3. **No bloquees el main process:** usa tools asíncronas (`exec` con `spawn`,
   nunca `spawnSync`). Un comando largo nunca debe congelar la app.
4. **No commits no pedidos:** jamás hagas `git commit`/`push` sin que el
   usuario lo solicite explícitamente.
5. **Secrets:** nunca registres, loguees ni commitees API keys ni tokens.
   El acceso a credenciales va por `KeychainManager`/`_getApiKey`.

## Estructura

- `core/` — núcleo de inteligencia (contexto, planner, agent loop, memoria).
- `core/grounding/` — ensamblado del system prompt y serializers.
- `core/rules/` — reglas del proyecto (`AGENTS.md`/`CLAUDE.md`/`.cursorrules` → prompt).
- `core/plugins/` — `PluginManager`: carga plugins locales con tools + hooks.
- `plugins/` — plugins del usuario (carpeta con `plugin.json` + `index.js`).
- `ipc/` — puente renderer ↔ núcleo (`ipcMain.handle`).
- `src/chat/` — ventana de chat (renderer aislado; usa `window.assistant`).
- `openclaw-server.js` — servidor local de tools (exec/read/write/edit/grep).

## Cancelación de generación

`agent-run` (IPC) crea un `AbortController` por ejecución; `agent-cancel` lo
aborta. El `signal` se propaga por `Core.runAgent` → `AgentLoop.run` →
`LLMProvider.post/postStream` (rechaza con `AbortError`, `code: 'ABORTED'`).
El loop revisa `signal.aborted` en cada iteración.

Si el usuario te pide algo que contradiga estas reglas, prioriza estas reglas.
