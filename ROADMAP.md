# Hoja de Ruta — Asistente Personal → agente completo (v3)

> Roadmap consolidado v3. Actualiza v2 con verificación fresca contra produccion
> (post-merge del módulo de gestos y de las fases 0-2 de este roadmap) y agrega
> autenticación de la aplicación como fase nueva.

**Etiquetas (dos ejes):** 🔍 verificado en produccion ahora mismo · 🏗️ existe en local, sin verificar · 🧠 diseño propuesto · [papel] solo escrito · [spike] prototipado · [implementado] en el código real.

---

## 0. Estado verificado en esta sesión

- ✅ **GestureEngine.js — resuelto.** 🔍 `node --check` pasa limpio contra produccion. El bloque de código huérfano después de `_resetPose()` ya no está.
- ✅ **ModelAugmenter.js — resuelto.** 🔍 El bug del grupo "Idle" quedó arreglado: las motions **referenciadas** en el `model3.json` ahora preservan su grupo original (una bajo `Motions.Idle` con archivo `mtn_00.motion3.json` queda en `Idle`); el regex `/idle/i` por nombre solo aplica a lo **descubierto en disco sin referencia**, con fallback a nombre si el grupo original es `""` (quirk de 免费模型艾莲). Suite `test_gesture_heuristic` 37/37, regresión 1025→1025 en verde.
- 🔍 Tamaños actualizados post-merge de gestos: `main.js` 1382 líneas (+15), `chat.html` 2502 (+57), `index.html` 512 (+46). La separación de archivos (Fase 3) sigue siendo sobre los mismos tres archivos, un poco más grandes.
- ✅ **LSPManager.js — multi-instancia verificada.** 🔍 `node --check` pasa limpio. Suite completa 1044/1044. Detección por manifiesto funciona: Plataforma-Japones → typescript, workspace Python → python. Python arranca con pyright vía npyright-langserver --stdio`, obtiene símbolos reales (Function, Variables), stop en 22ms. Push de diagnostics de pyright funciona en probe manual con rootUri-only (sin rootPath/workspaceFolders).

## 1. La meta

"Nivel OpenCode/Claude Code" en el sentido de igualar benchmarks públicos con equipos de research no es una meta realista para un dev solo. La meta real: **un agente en el que developers confíen para tareas reales, con una identidad (proactividad + personaje) que ningún competidor tiene.** Evidencia antes que escala, seguridad antes que alcance.

⚠️ **Nota de escalada de seguridad:** Fase 1 (contextIsolation) pasa de "Alta" a **bloqueante** en cuanto arranca §10 (Git/GitHub) — con credenciales de GitHub en juego, un XSS en el renderer deja de ser "toca tus archivos locales" y pasa a "actúa en tu nombre en GitHub".

## 2. Fase 0 — Bugs bloqueantes/urgentes (resueltos)

- ✅ GestureEngine.js no cargaba (SyntaxError) — resuelto, verificado en produccion.
- ✅ ModelAugmenter.js perdía el grupo "Idle" en motions referenciadas — resuelto, verificado en esta sesión (ver §0).

## 3. Fase 1 — Seguridad (parcial)

- ✅ **Unificar credenciales en el KeychainManager** — `LLMProvider` ahora resuelve las keys por sí mismo con prioridad **llavero > env > config.json** (`_applyKeychainOverlay`), con helpers `storeProviderApiKey` / `removeProviderApiKey` / `migrateApiKeysToKeychain`. `main.js` migra al arranque las keys que sigan en texto plano en `config.json` y las elimina del archivo; `save-llm-keys` con llavero activo ya no persiste keys en texto plano (y al desactivarlo limpia el llavero). Suite `test_keychain_integration` 19/19. [implementado]
- ✅ **Revisión de `webSecurity: false`** — la ventana de chat pasa a `webSecurity: true` (sin `allowRunningInsecureContent`); verificado que carga su Live2D local sin errores. El overlay se mantiene en `webSecurity: false` porque el SDK Live2D depende de fetch `file://` relajado para cargar `.model3.json`/texturas; resolverlo bien es reemplazar por protocolo custom, no un toggle. [implementado]
- ⚠️ **`contextIsolation: false` / `nodeIntegration: true`** — pendiente. `chat.html` (2502 líneas) usa `require()` directo de core (LLMProvider 16×, GestureEngine 17×, AgentManager, CommandRegistry, FileResolver) + `child_process`, así que resolverlo es **mover AgentManager/LLMProvider/CommandRegistry al proceso principal** y exponer una API acotada por `contextBridge` (preload). Es un refactor grande, no un toggle. **Bloqueante solo cuando arranque §10.** [papel]

## 4. Fase 2 — CI (implementada)

- ✅ **`.github/workflows/ci.yml`** — corre `tests/run-all.sh` (regresión completa) en cada push/PR a `dev` y `produccion`: `npm ci` (el postinstall instala Electron y reconstruye better-sqlite3), luego `ELECTRON_RUN_AS_NODE=1 … init_vectors.js` para indexar intenciones antes de los tests, y `npm test`. Es el gate que protege produccion. [implementado]
- ✅ **Job opcional `build-portable`** — empaqueta `electron-builder --win portable` al mergear a produccion (con wine); `continue-on-error` para no tumbar la señal del CI de tests. [implementado]

## 5. Fase 3 — Separación de archivos grandes

> Progreso: 3a (CommandRegistry) ✅, 3b (StateGraph) ✅, 3c (main.js) ✅, 3d (chat.html) ✅, limpieza de comentarios ✅.

- ✅ **`core/commands/CommandRegistry.js` → `core/commands/*.js`.** `general.js` (clear/memory/stats/telemetria/export/olvida), `llm.js` (model/provider/agent/code/skill), `config.js` (credenciales), `dev.js` (init/review/plan/fix/undo/retry), `model.js` (cambio-modelo/modelo-vistas/gestos). `CommandRegistry.js` queda como core (Map/register/_parse/CATEGORIES/help) que carga categorías con `require('./X')(register)`. Se eliminó un `retry` duplicado (quedaba en general.js y dev.js) — el arranque ya no loguea "ya registrado".
- ✅ **`core/state-graph/StateGraph.js` → `core/state-graph/stores/*.js`.** `NodeStore` (CRUD+forget), `VectorIndex` (sqlite-vec+backfill), `SessionStore`, `AppHistoryStore`, `RelationsStore`, `DecayStore`, `constants.js`. `StateGraph.js` queda como fachada: ciclo de vida (init/schema/fallback MemoryDB), cola de embeddings y delegación. Ports exactos del SQL/retorno originales; la cola de embeddings se mantiene en la fachada (la usa NodeStore y VectorIndex).
- ✅ **`main.js` (1439) → `ipc/*-handlers.js`.** Estado global pasa a objeto compartido `S` (`ipc/state.js`). 6 módulos con `register(ctx)`: `window-model-handlers.js` (overlay/modelo/vistas), `memory-handlers.js` (memoria/grounding/OS sensor), `config-handlers.js` (config/keys/python-bin), `init-vectors-handlers.js` (init-vectors/proactive/exec-command), `openclaw-handlers.js` (openclaw/plan/agent-run), `mcp-handlers.js` (MCP/workspace/telemetria). `main.js` queda como orquestador (~700 líneas): ciclo de vida, ventanas, tray, control server, auto-init. Los helpers compartidos (getModelViewMode, broadcastViewsChanged, etc.) se exponen vía `ctx`. Verificado: 51 handlers IPC registrados, arranque real de la app sin errores.
- ✅ **`src/chat.html` → `src/chat/*.js`.** El `<script>` inline de ~2000 líneas pasa a 8 módulos con scope global compartido, en orden de dependencia: `core.js`, `messages.js`, `mcp.js`, `process.js`, `input.js`, `tts.js`, `live2d.js`, `ipc.js`. `chat.html` queda en 501 líneas (layout + CDNs + 8 tags `<script src="chat/X.js">`). Bugs del split resueltos: `_applyWorkspaceUI is not defined` (el invoke de workspace se movió a `messages.js`, después de cargar la función) y rutas del renderer (`__dirname` se resuelve contra el directorio del documento, no del script → `../core/...` correcto, `../../core/...` falla). Verificado: `node --check` OK en los 8, smoke test de carga en orden, suite 1044/1044, arranque real sin errores en el renderer.
- 🔍 `core/behavior/ProactiveEngine.js` (1642) y `core/Core.js` (1468) — los dos más grandes del proyecto. Sin desglose detallado todavía.
- `src/index.html` (512), `core/planner/Planner.js`, `core/llm/LLMProvider.js` — tamaño razonable. No tocar todavía.

## 6. Fase 4 — Mejoras internas (calidad/DX)

- Logger centralizado — reemplazar las ~334 llamadas sueltas a `console.*`.
- ESLint + Prettier — no hay config en el repo.
- Tests dedicados para `EventBus.js` y `KeychainManager.js`.
- JSDoc parejo en módulos públicos (`Core.js`, `LLMProvider.js`, `ToolRegistry.js`).
- Convertir los TODO/FIXME/HACK dispersos en issues de GitHub.
- Migrar el test runner casero a Vitest/Jest cuando el ABI de Electron lo permita.
- ModelAugmenter: evitar doble cómputo entre `listGestures()` y `augmentModel()`.

## 7. Fase G — Loop de calidad + contexto real del proyecto

### G.1 — LSP para todos los lenguajes, no solo JS/TS ✅ [implementado]
- ✅ Tabla externa `infrastructure/lsp/servers.json` con configuración por lenguaje: command, args, filePatterns, manifests, installCmd, npx, heavy.
- ✅ Detección por manifiesto: `package.json` → TS/JS, `pyproject.toml` → Python, `go.mod` → Go, `Cargo.toml` → Rust, `pom.xml`/`build.gradle` → Java, `Gemfile` → Ruby, `composer.json` → PHP.
- ✅ `LSPManager` multi-instancia (`Map<language, instance>`) con routing por extensión de archivo.
- ✅ Python arranca con pyright vía npx (pyright-langserver --stdio). Smoke test verificado: initialize, getDocumentSymbols, stop (22ms con shutdown timeout corto).
- ✅ `workspaceFolders` + `rootPath` en initialize para resolución correcta del workspace.
- 🔍 Pull diagnostics (textDocument.diagnostic) no se declara para evitar que pyright deje de publicar push. Publicación vía publishDiagnostics funciona en servers TS; en pyright depende del cwd del proceso (quirk conocido).
- Compat: `_serverConfig` getter público para LSPErrorWatcher (línea 254). `detectLanguagesForWorkspace` retorna array de lenguajes detectados (repos poliglota).

### G.2 — Test runner estructurado ✅ [implementado]
- ✅ `tests/run_tests.sh` — produce JSON a stdout con la misma lógica que `run-all.sh`.
- Salida: `{passed, failed, total, exitCode, suites:[{name, passed, failed, total, exitCode}]}`.
- `--pretty` para formato indentado, sin flag para JSON compacto (más fácil de parsear).
- Exit code 0 si todo pasa, 1 si hay fallos. Usado por CI (`.github/workflows/ci.yml`).

### G.3 — Índice de workspace (2 capas) ✅ [implementado - capa estructural]
- ✅ `WorkspaceIndex` — analiza workspace vía manifiestos de G.1.
- Detecta: lenguajes, package manager (npm/yarn/pnpm/bun/cargo/go/bundler/composer/pip), test runner (jest/vitest/mocha/ava/npm-scripts), frameworks (react/vue/svelte/next/nuxt/electron), config files.
- Cache con TTL 5min, `invalidate()`, `getStats()`.
- 🔍 Capa semántica (embeddings en sqlite-vec, .gitignore, reindexado incremental) pendiente.

### G.4 — Generalizar ProactiveExecutor vía catálogo de herramientas ✅ [implementado]
- ✅ `TOOL_CATALOG` — cada tool declara: `validate`, `preview`, `execute`, `normalizeResult`.
- `preview()` y `execute()` despachan genéricamente vía el catálogo (sin if/switch por tool).
- `normalizeResult` permite tools con resultado raw diferente a `detail` (ej: git_status).
- `TOOL_CATALOG` exportado para extensión futura (agregar tools = agregar entrada al catálogo).
- Suite 1044/1044 en verde.

### G.5 — LSP a nivel opencode (LSP.0–LSP.3) ⚠️ [implementado parcial] — falta verificación e2e real

- ✅ **LSP.0 — cliente LSP robusto (`core/lsp/LSPManager.js`).** Responde requests server→client: `workspace/configuration`, `workspace/workspaceFolders`, `window/workDoneProgress/create`, `client/registerCapability`/`unregisterCapability` → null, desconocidas → `MethodNotFound`. Capabilities `window.workDoneProgress`, `workspace.configuration`, `didChangeWatchedFiles` (dynamic). Tras `initialized` envía `workspace/didChangeConfiguration`. `didChangeWatchedFiles` (Created/Changed) en open/changeDocument. `waitForDiagnostics(filePath, {debounceMs=300, timeoutMs=3000})` en instancia y manager. `initTimeoutMs` por servidor (45s java). Tests `test_lsp_requests` 49/49.
- ✅ **LSP.1 — feedback de diagnósticos tras cada edición (patrón opencode, `AgentLoop.js` + `ProactiveExecutor.js`).** Tras `write`/`edit`/`apply_patch`/`create_file`/`edit_file` exitosos: `changeDocument` + `waitForDiagnostics`, y si hay errores se anexa `result.lspDiagnostics` + bloque `_formatDiagnostics` al resumen inyectado al LLM. ProactiveExecutor acepta `waitForDiagnostics` inyectable (reemplaza `sleep(verifyDelayMs)` en apply_patch). Tests `test_agent_loop_lsp` 29/29.
- ✅ **Bug real arreglado:** loop infinito cuando el LLM respondía texto final tras un edit — `AgentLoop.js:235` reusaba el prompt original como contexto de parse en cada iteración y `ActionParser` legacy re-detectaba el MISMO "edita X" → re-ejecución hasta `max_iterations_reached`. Fix: en iteraciones >0 se pasa `currentUserMsg` (resultado de la herramienta); `ActionParser` ignora mensajes de bookkeeping `[Resultado de herramienta …]`/`[ERROR de herramienta …]` para detección de intento de edición. Regresión en verde.
- ✅ **Recovery/reconexión (G.5).** Salida inesperada del proceso → reinicio con backoff exponencial (`restartDelayMs`×2^n, techo `maxRestartDelayMs`), contador de intentos con límite `maxRestartAttempts` (cede y emite `crashed`); un server que llevaba `restartStableMs` activo se considera sano y resetea el contador (los cuelgues puntuales se recuperan indefinidamente, un crash-loop se corta). Tras el reinicio re-abre los documentos que estaban abiertos (`_reopenAfterRestart` → didOpen) para que changeDocument/waitForDiagnostics sigan funcionando. `stop()` cancela el reinicio programado.
- ✅ **LSP.2 — auto-aprovisionamiento.** Si el binario no existe y la config lo habilita (`autoInstall: true`), se ejecuta `installCmd` y se reintenta UNA vez antes de fallar (`_runInstall` con timeout 120s). Mecanismo testado; por defecto los servers quedan en manual (los npx ya se auto-instalan con `-y`; auto-provisionar `go install`/`gem`/`composer` en runtime es opt-in deliberado).
- ✅ **LSP.3 — tools semánticas.** `hover` (contenido plano + lenguaje), `rename` (devuelve los workspace edits SIN aplicarlos — el agente los revisa antes de tocar archivos) y `code_actions` (contexto con los diagnósticos cacheados, sin aplicar). En LSPManager (routing por extensión) + dispatch en AgentLoop (`LSP_TOOLS`). Tests en `test_lsp_requests` (7-9) y `test_agent_loop_lsp` (Test 6 hover).
- ⚠️ **Bloqueante para llamarlo "robusto" — e2e real pendiente.** El happy-path post-edit solo está probado con mocks. El server TS no arranca sin `typescript` en node_modules del workspace ("Could not find a valid TypeScript installation") y el TPM de Groq quedó agotado → falta un run contra un language server real (workspace con TS instalado) confirmando el feedback post-edit de punta a punta.
- ⚠️ **LSP.4/LSP.5 pendientes.** Contexto enriquecido (imports/tipos/símbolos del archivo antes de editar) y operación (cierre ordenado con backoff global, telemetría, supervisión de procesos huérfanos). El manejo de monorepo/poliglota real queda como parte de LSP.2 cuando haya un caso concreto.
- ⚠️ **Ambientales que bloquean validación:** `better-sqlite3` NODE_MODULE_VERSION mismatch (119 vs 147) → DB en memoria sin persistencia; harness openclaw-server con auth intermitente (401 en test_server_security/test_integration_stress — pre-existente, sin relación con LSP).

## 8. Benchmark de tareas reales [spike → recurrente]

- ✅ **Spike validado:** `Core.runAgent()` invocable programáticamente con `evalMode` (harness standalone en `benchmarks/`, sin Electron, con server OpenClaw aislado + key por env `LLM_KEY_GROQ`). Auto-aprueba tools de alto impacto para correr headless.
- ✅ **Infraestructura:** `benchmarks/lib/harness.js` (levanta openclaw-server con key compartida, `Core.init()` standalone, `runAgent` en evalMode), `benchmarks/run.js` (por tarea: workspace git limpio → N corridas → verify.sh → serie histórica en `benchmarks/results/<id>.json`), primera tarea `rename-multiply` con template en git.
- ✅ **Bug de agente descubierto y arreglado por el benchmark:** `StructuredActionParser` no reconocía los aliases modernos `ACCIÓN: write/edit/read` (solo `create_file`/`edit_file`), y `ACCIÓN: exec` caía en `{raw: fields}` sin extraer `COMANDO`. Fix: aliases + case `exec`. Test dedicado `test_structured_parser_aliases` 12/12; suite total 1056/1056.
- ⚠️ **Bloqueo operativo:** la key de Groq (tier gratis) tiene rate limits agresivos (TPD 100k para smart, TPM 6k para fast) que impiden las 3 corridas por tarea en una misma sesión. Con el fix del parser aplicado falta re-correr la tarea para medir pass@3 real.
- [ ] 15-30 tareas representativas, usando el propio historial de bugs (Fase 0 revertido) como primeras tareas — ya se conoce el resultado correcto.
- [ ] `verify.sh` de cada tarea usa `run_tests` de G.2 (hoy cada tarea tiene su propio verify.sh; migrar el que aplique a suites reales).
- [ ] 3 corridas por tarea (no-determinismo del LLM), `pass@3` o promedio, serie histórica — runner ya persiste la serie; falta completar corridas sin rate limit.
- [ ] Publicar los números aunque sean modestos. Es el gate de decisión para §11/§12.

## 9. Configuración de la aplicación (settings/UI)

> Ya anotado en la Fase H original ("política configurable sin código", "onboarding del slider de autonomía", "batch de propuestas"). Se trae acá porque conecta con Git/GitHub (§10) y Auth (§11) — las tres tocan la misma superficie de UI de configuración.

- Pesos/umbrales del gate y SLOs editables desde JSON documentado (hoy viven en constantes con defaults).
- Panel de settings con el slider de autonomía visible (observe | suggest | act).
- Sección de credenciales unificada: LLM, GitHub PAT (§10) y futuros providers — todos por el mismo flujo de KeychainManager, un solo lugar en la UI.
- Modo "no molestar" / batch de propuestas.

## 10. Git y GitHub — tooling nativo + MCP [implementado parcial]

- 🔍 **Implementado**: `git_status`, `git_diff`, `git_log`, `git_branch` (solo lectura) y `git_commit`, `git_stash`, `git_merge`, `git_rebase` (mutadores, aprobación + detección estructurada de conflictos) en `core/git/GitManager.js` — JSON, no texto de terminal, `execFile` con array de args (sin shell).
- **GitHub nativo**: `github_repo_info`, `github_issue_list/create/comment/close`, `github_pr_list/create/review`, `github_actions_status` en `core/github/GitHubManager.js` — cliente REST con `fetch`, control total del formato.
- **Credenciales**: token en el KeychainManager (key `github_token`), resolución aislada en `_resolveToken()` (memoria → llavero → env). Dos flujos: **OAuth Device Flow (RFC 8628)** como flujo principal distribuible (`/github login` abre el navegador con el código pre-cargado y hace polling en background hasta que autorizás; solo necesita un `client_id` público, sin secret) y **PAT** para power users/CI (`/github login <PAT>` valida contra la API antes de persistir). El token nunca se filtra en salida/logs/config.
- **Conexión de cuenta**: comando `/github` (`login` device-flow con navegador, `login <PAT>` directo, `client-id <ID>` para configurar la OAuth App, `whoami`, `logout`, `status`). Listo para distribuir: token solo en main/keychain, sin fallback a texto plano. Si el llavero no está disponible, advierte que la sesión es efímera.
- **MCP**: el servidor oficial de GitHub sigue disponible como opción opt-in del usuario vía MCPManager (ya trata tools MCP como alto impacto). Sin código MCP nuevo: es config.
- ⚠️ **Pendiente**: `contextIsolation` (Fase 1) — solo bloqueante si el PAT llega al renderer; por diseño el token vive en main (KeychainManager), nunca cruza al renderer.

## 11. Autenticación de la aplicación

### 11.1 — Bloqueo local de la app (tiene sentido ya, bajo costo) 🧠 [papel]
- PIN o contraseña simple para abrir la ventana principal (lock local, como el PIN de una app de notas).
- El hash vive en el Keychain, nunca en `config.json` en texto plano.
- Timeout de sesión opcional (re-pedir PIN tras N minutos de inactividad), configurable desde §9.

### 11.2 — Patrón de auth reutilizable ya existente
- 🔍 Ya hay dos implementaciones locales sólidas: el token de `openclaw-server.js` (fail-closed, comparación timing-safe, rate limiting, audit log) y el `CONTROL_API_TOKEN` del puerto 3131 (mismo patrón + validación de Origin/Referer para bloquear `<img src="http://localhost:3131/…">`). El PIN de 11.1 se apoya en el mismo criterio de diseño.

### 11.3 — Cuentas/licencias (solo si vendés, no antes) 🧠 [papel], condicionado
- No se construye salvo camino de venta con backend propio. Con modelo BYOK como producto de escritorio, un archivo de licencia local verificado offline alcanza. No priorizarlo hasta tener claro el camino de venta.

## 12. Subagentes auto-detectados 🧠 [papel] — después del Benchmark

- ⚠️ No arranca sin (a) un número de benchmark que justifique la inversión. El requisito de Fase J (rate-limit con cola) ya está resuelto — paralelizar amplifica aciertos y fallos, y la cola por provider serializa y prioriza las llamadas.
- 🔍 `Planner.js` ya modela `step.dependsOn`, estados por paso, `requiresApproval` por paso — el modelo de datos para un DAG ya existe, falta la ejecución paralela real.
- `_runPlan()` de `for` secuencial a pasos paralelos sin dependencia mutua, cada uno como instancia propia de `AgentLoop`; `_activePlan` de slot único a registro de planes concurrentes; señal de complejidad en `TaskDetector`; aislamiento por git worktree/branch (fallback secuencial si no hay git).

## 13. Continuidad de contexto — compactación + fail-over 🧠 [papel] — después del Benchmark

- ⚠️ La más cara y riesgosa. No se prioriza sin saber vía benchmark + G.3 si la causa real de fallas es falta de contexto de proyecto (lo arregla G.3) o quedarse sin ventana en sesiones largas.
- Estimación de tokens por sesión/AgentLoop, tabla de ventana por proveedor, trigger al 75-80%, compactación de turnos viejos + nodos tocados, formato de resumen agnóstico, fail-over con aviso transparente.
- No habilitar fail-over por default sin medirlo contra el benchmark.

## 14. Posicionamiento

- **Proactividad** → gancho literal para devs (el motor de decisión detecta cosas sin que nadie pregunte).
- **Compañero/personaje** → filtro de audiencia correcto, no decoración.
- **Agente de código** → el motor detrás de las dos anteriores, no el diferenciador en sí.

## 15. Hardening de ejecución (sandbox)

- Usuario del SO con permisos reducidos para el proceso del asistente, o `vm2`/`isolated-vm`/contenedor liviano para code execution, antes de subir la autonomía por default o distribuir — más urgente con §10 (credenciales de GitHub).

## 16. Backlog visual — pausado, sin cambios

- Lip-sync real durante TTS, gestos ligados al contenido/mood en vez de al azar, STT, reacción visual del avatar al estado del agente. Retomar cuando el core demuestre valor con evidencia real.

## 17. Orden general

```
Fase 0 (bugs: GestureEngine + ModelAugmenter) + Fase 1-2 (seguridad base + CI) ✅
        ↓
Fase G completa (G.1 LSP multi-lenguaje → G.2 test runner → G.3 índice de
workspace → G.4 generalizar ProactiveExecutor)
        ↓
Benchmark de tareas reales (§8) — spike primero. PUNTO DE DECISIÓN para
Subagentes/Continuidad de contexto.
        ↓
Configuración de la app (§9) + Autenticación local (§11.1-11.2) — se hacen
juntas: comparten UI de settings y patrón de Keychain
        ↓
Git/GitHub nativo + MCP (§10) — Fase 1 pasa a bloqueante en cuanto arranca
        ↓
Posicionamiento comunicado desde el día uno (§14)
        ↓
Hardening de ejecución (§15) — recién acá tiene sentido distribuir a terceros
        ↓
─── todo lo siguiente condicionado al número del Benchmark ───
        ↓
Fase J (rate-limit con cola) → Subagentes (§12) → Continuidad de contexto (§13)
        ↓
Fase H/I ya planeadas (calibración fina, multi-workspace)
        ↓
Autenticación de cuentas/licencia (§11.3) — solo si el camino de venta lo requiere
        ↓
Backlog visual (§16)
```

## Resumen de esfuerzo (v3, estados al día)

| Fase | Bloquea release | Riesgo | Urgencia | Madurez |
|---|---|---|---|---|
| 0 — Bugs GestureEngine + ModelAugmenter | No | Bajo | Hecho | [implementado] 🔍 |
| 1 — Seguridad (keychain + webSecurity) | No → bloqueante con §10 | Medio-alto | Alta | [implementado] parcial |
| 1 — contextIsolation | No → bloqueante con §10 | Medio-alto | Alta → crítica con §10 | [papel] |
| 2 — CI | No | Bajo | Hecho | [implementado] |
| 3 — Separación de archivos | No | Bajo por ítem | Media | [implementado] (3a-3d + limpieza) |
| 4 — Mejoras internas | No | Bajo | Baja-media | [papel] |
| G.1 — LSP multi-lenguaje | No | Bajo | Hecho | [implementado] |
| G.2 — Test runner estructurado | No | Bajo-medio | Hecho (usado por CI) | [implementado] |
| G.3 — Índice de workspace | No | Medio | Hecho (capa estructural) | [implementado] parcial |
| G.4 — Generalizar ProactiveExecutor | No | Medio | Hecho | [implementado] |
| G.5 — LSP nivel opencode (LSP.0–LSP.3) | No | Bajo | Alta (falta e2e real) | [implementado] parcial |
| Benchmark de tareas reales | No | Bajo | Alta (gate de decisión) | [spike → recurrente] |
| 9 — Configuración de la app | No | Bajo | Media-alta (destraba §10/§11) | [papel] |
| 10 — Git/GitHub nativo + MCP | No | Medio | Alta | [implementado] parcial |
| 11.1/11.2 — Auth local (PIN) | No | Bajo (reusa patrón existente) | Media | [papel] |
| 11.3 — Cuentas/licencia | Solo si hay venta con backend | Medio | Baja, condicionada | [papel] |
| 15 — Hardening de ejecución | Sí, para distribuir | Medio-alto | Media | [papel] |
| J — Rate-limit con cola | No | Bajo-medio | Prerequisito duro de §12 | [implementado] |
| 12 — Subagentes | No | Alto | Media, condicionada al Benchmark | [papel] |
| 13 — Continuidad de contexto | No | Medio-alto | Media, condicionada al Benchmark | [papel] |
| 16 — Backlog visual | No | Bajo-medio | Baja (pausado) | — |

## Changelog

- **v3 → hoy (§10, conexión):** Comando `/github` con **OAuth Device Flow (RFC 8628)**: `login` (sin arg) usa el `client_id` guardado con `client-id <ID>`, abre el navegador en `verification_uri_complete` (código pre-cargado) y hace polling en background (`authorization_pending`/`slow_down`/`expired_token`/`access_denied`) con notificación por chat al conectar; `login <PAT>` valida contra la API antes de persistir y nunca filtra el token; `whoami`; `logout`; `status`. Token en llavero (`github_token`) y memoria; sesión efímera con aviso si el llavero no está. `GitHubManager.configure` acepta `token: null` para limpiar memoria en logout. Tests `test_github_command` 37/37 + `test_oauth_device_flow` 16/16; regresión 1296 passed (2 fallos ambientales pre-existentes). Listo para distribuir: token solo en main/keychain, sin fallback a texto plano.
- **v3 → hoy (§10):** Git nativo (`core/git/GitManager.js`): `git_status/diff/log/branch` (lectura) + `git_commit/stash/merge/rebase` (mutadores con aprobación y conflictos estructurados), salida JSON vía `execFile` (sin shell). GitHub nativo (`core/github/GitHubManager.js`): `repo_info`, `issue_list/create/comment/close`, `pr_list/create/review`, `actions_status` con PAT via KeychainManager (`github_token`) y transport `fetch` inyectable. Dispatch en AgentLoop (sets `GIT_TOOLS`/`GITHUB_TOOLS`, patrón LSP); aprobación en `ActionParser.isHighImpact`; schemas en catálogo (ToolRegistry), nativos LLM (ToolSchemas) y resolución (ToolResolver). Tests: `test_git_manager` 32/32, `test_github_manager` 25/25, `test_agent_loop_git` 49/49; regresión 1243 passed (2 fallos ambientales pre-existentes). MCP de GitHub queda como opción opt-in sin código nuevo.
- **v3 → hoy (Fase J):** Cola de requests por provider implementada (`core/llm/RequestQueue.js`): concurrency 1 por defecto (serial), prioridad (`priority`), cooldown por 429 con `parseRetryAfterMs` (cubre "try again in X" y "retry in XmYs"), presupuesto de espera `maxWaitMs` (rechazo limpio tipo rate-limit en vez de cuelgue), stats, `flush`, `disable`/`enable`. LLMProvider enruta cada llamada (`complete`/`completeTask`/`completeWithTools` ahora aceptan `opts` con `priority`/`maxWaitMs`), expone `getQueueStats()`, y `enabled:false` da bypass total. Harness del benchmark cableado con `maxWaitMs` 15min. Tests `test_request_queue` 27/27; regresión 1080 passed (2 fallos ambientales pre-existentes). Desbloquea Benchmark §8 y §12 (subagentes).
- **v3 → hoy (G.5):** LSP.0 (cliente robusto) + LSP.1 (feedback post-edit) + **recovery con backoff y límite de reinicios** + **LSP.2 auto-provisioning** (`installCmd` con reintento, opt-in) + **LSP.3 tools semánticas** (`hover`/`rename`/`code_actions`, rename sin aplicar). Tests: `test_lsp_requests` 49/49, `test_agent_loop_lsp` 29/29, regresión 1053 passed (2 fallos ambientales del harness, pre-existentes). Pendiente: e2e real contra language server (TS faltante en node_modules + TPM de Groq) y LSP.4/LSP.5 (ver G.5).
- **v3 → hoy (benchmark):** Spike del Benchmark (§8) validado: `Core.runAgent()` con `evalMode` corre headless contra Groq real (harness `benchmarks/`). La primera corrida de la tarea `rename-multiply` reveló un bug real del agente (`StructuredActionParser` no reconocía `write`/`edit`/`exec` en el fallback textual) — arreglado con aliases y test 12/12. Suite 1056/1056. Pendiente: re-correr las 3 corridas por tarea (bloqueado por rate limits de la key gratis de Groq).
- **v3 → hoy:** Fase 3d completada: `src/chat.html` (2502 → 501 líneas) con su `<script>` inline separado en `src/chat/*.js` (8 módulos, orden de carga estricto). Limpieza de comentarios viejos (sin líneas separadoras `──`, sin emojis decorativos) en `src/chat/*.js`, `main.js`, `core/commands/*.js`, `core/state-graph/stores/*.js`, `ipc/*.js`, `StateGraph.js`, `chat.html`. Verificado: suite 1044/1044, `node --check` OK, boot real sin errores en el renderer.
- **v3 → hoy:** Fase 3a-3c completada (CommandRegistry → `commands/*.js`; StateGraph → `stores/*.js`; main.js → `ipc/*-handlers.js` con estado compartido `S`), suite 1044/1044 y arranque real de la app verificados. G.1-G.4 completas con sus commits a dev y produccion.
- **v3 → hoy (anterior):** Fase 0 completada (ModelAugmenter verificado en produccion con suite 37/37 y regresión 1044 en verde); Fase 2 CI/CD implementada (`.github/workflows/ci.yml` + build portable); Fase 1 avanzada (KeychainManager para credenciales de LLM con migración automática y `test_keychain_integration` 19/19; `webSecurity: true` en la ventana de chat); `contextIsolation` queda documentado como el pendiente que se vuelve bloqueante con §10.
- **v2 → v3:** verificación fresca contra produccion; tamaños de archivos grandes actualizados; nueva Fase 9 (Configuración), nueva Fase 11 (Autenticación en 3 niveles), Fase 10 explícita en nativo+MCP en paralelo; orden general intercala Configuración+Auth junto a Git/GitHub antes del hardening.
