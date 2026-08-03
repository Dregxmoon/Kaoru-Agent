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

- 🔍 `src/chat.html` (2502 líneas, la mayoría en un único `<script>` inline). Separar en `chat/render.js`, `chat/commands.js`, `chat/ipc-bridge.js`, `chat/gestures.js`, `chat/settings.js`. **Prioridad más alta de esta fase** — sigue creciendo con cada feature de UI (gestos le sumó 57 líneas al mismo bloque).
- 🔍 `main.js` (1382 líneas, ~49 handlers de `ipcMain` de dominios sin relación). Extraer a `ipc/<dominio>-handlers.js` con `register*Handlers(ipcMain, core)`.
- 🔍 `core/state-graph/StateGraph.js` (1185 líneas, 5 responsabilidades: wrapper SQLite, CRUD de nodos, vectores, sesiones, telemetría de apps). Partir en `NodeStore`, `VectorIndex`, `SessionStore`, `AppHistoryStore`.
- 🔍 `core/commands/CommandRegistry.js` (852 líneas). El seam ya existe en `CATEGORIES`. Partir en `commands/general.js`, `commands/llm.js`, `commands/dev.js`, `commands/model.js`, `commands/config.js`. **Agregar gestos a CATEGORIES** (probablemente en 'Modelo').
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

### G.1 — LSP para todos los lenguajes, no solo JS/TS 🧠 [papel]
- 🔍 Hoy `LSPManager.js` (504 líneas) solo tiene typescript/javascript, ambos apuntando al mismo `typescript-language-server`. El cliente (spawn, JSON-RPC, timeout, diagnósticos) ya es agnóstico — esta fase extiende la tabla de qué servidor arrancar.
- **Resolución por manifiesto del proyecto, no por extensión:** `package.json` → TS/JS, `pyproject.toml`/`requirements.txt` → Python, `go.mod` → Go, `Cargo.toml` → Rust, `pom.xml`/`build.gradle` → Java, `Gemfile` → Ruby, `composer.json` → PHP.
- Tabla externa (JSON) `lenguaje → {installCmd, runCmd}` con auto-instalación la primera vez (npx/pip/go/cargo install).
- `LSPManager` pasa de un solo `_process` a `Map<lenguaje, instancia>` para repos poliglota.
- Alcance realista: arrancar por **Python** (después de JS/TS) y sumar el resto por demanda real.

### G.2 — Test runner estructurado 🧠 [papel]
- `run_tests` con salida estructurada (exit code + parseo best-effort por runner conocido). Sirve al loop de auto-verificación del agente y al verificador del benchmark.

### G.3 — Índice de workspace (2 capas) 🧠 [papel]
- Capa estructural (tipo de proyecto + convenciones vía los manifiestos de G.1) + capa semántica (embeddings por archivo/chunk en sqlite-vec, respetando `.gitignore`, reindexado incremental vía GitWatcher) + fallback de texto plano para lenguajes sin LSP.

### G.4 — Generalizar ProactiveExecutor vía catálogo de herramientas 🧠 [papel]
- Cada tool declara su contrato de proactividad junto a su schema (auto-ejecutable, cómo se verifica, cómo se revierte) — `ProactiveExecutor` deja de tener un `if` por tool.

## 8. Benchmark de tareas reales [spike → recurrente]

- Spike primero (1-2 tareas manuales) para validar `Core.runAgent()` invocable programáticamente con `evalMode`.
- 15-30 tareas representativas, usando el propio historial de bugs (Fase 0 revertido) como primeras tareas — ya se conoce el resultado correcto.
- `verify.sh` de cada tarea usa `run_tests` de G.2.
- 3 corridas por tarea (no-determinismo del LLM), `pass@3` o promedio, serie histórica.
- Publicar los números aunque sean modestos. Es el gate de decisión para §11/§12.

## 9. Configuración de la aplicación (settings/UI)

> Ya anotado en la Fase H original ("política configurable sin código", "onboarding del slider de autonomía", "batch de propuestas"). Se trae acá porque conecta con Git/GitHub (§10) y Auth (§11) — las tres tocan la misma superficie de UI de configuración.

- Pesos/umbrales del gate y SLOs editables desde JSON documentado (hoy viven en constantes con defaults).
- Panel de settings con el slider de autonomía visible (observe | suggest | act).
- Sección de credenciales unificada: LLM, GitHub PAT (§10) y futuros providers — todos por el mismo flujo de KeychainManager, un solo lugar en la UI.
- Modo "no molestar" / batch de propuestas.

## 10. Git y GitHub — tooling nativo + MCP [papel]

- 🔍 Cero integración real hoy — "github" solo aparece como palabra clave de intención en `TaskDetector.js`.
- ⚠️ Fase 1 (contextIsolation) pasa a **bloqueante** antes de que un PAT real llegue a producción.
- **Git local, tool propia (no exec crudo):** `git_status`, `git_diff`, `git_log`, `git_branch`, `git_commit`, `git_stash`, `git_merge/git_rebase` con detección estructurada de conflictos — JSON, no texto de terminal.
- **GitHub, dos caminos en paralelo:**
  - **Nativo** (tool propia): `github_pr_create/list/review`, `github_issue_create/comment/close`, `github_actions_status`, `github_repo_info`. Cliente REST liviano, control total del formato.
  - **MCP**: servidor oficial de GitHub como opción que el usuario elige activar. `MCPManager.js` 🔍 ya trata las tools MCP como alto impacto (aprobación siempre requerida).
  - Por qué ambos: MCP da cobertura amplia gratis pero menos control; nativo da control total pero hay que mantenerlo. La combinación es lo que ya usan herramientas de este tipo.
- **Credenciales:** un PAT de GitHub entra como provider más del KeychainManager, visible en §9.
- Etapa realista: PAT manual ahora → OAuth App solo si se distribuye a terceros.

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

- ⚠️ No arranca sin (a) un número de benchmark que justifique la inversión y (b) Fase J (rate-limit con cola) resuelta — paralelizar amplifica aciertos y fallos, y varias llamadas simultáneas chocan con la cola.
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
| 3 — Separación de archivos | No | Bajo por ítem | Media | [papel] |
| 4 — Mejoras internas | No | Bajo | Baja-media | [papel] |
| G.1 — LSP multi-lenguaje | No | Bajo | Alta | [papel] |
| G.2 — Test runner estructurado | No | Bajo-medio | Alta (compartido con Benchmark) | [papel] |
| G.3 — Índice de workspace | No | Medio | Alta | [papel] |
| G.4 — Generalizar ProactiveExecutor | No | Medio | Alta | [papel] |
| Benchmark de tareas reales | No | Bajo | Alta (gate de decisión) | [spike → recurrente] |
| 9 — Configuración de la app | No | Bajo | Media-alta (destraba §10/§11) | [papel] |
| 10 — Git/GitHub nativo + MCP | No | Medio | Alta | [papel] |
| 11.1/11.2 — Auth local (PIN) | No | Bajo (reusa patrón existente) | Media | [papel] |
| 11.3 — Cuentas/licencia | Solo si hay venta con backend | Medio | Baja, condicionada | [papel] |
| 15 — Hardening de ejecución | Sí, para distribuir | Medio-alto | Media | [papel] |
| J — Rate-limit con cola | No | Bajo-medio | Prerequisito duro de §12 | [papel] |
| 12 — Subagentes | No | Alto | Media, condicionada al Benchmark | [papel] |
| 13 — Continuidad de contexto | No | Medio-alto | Media, condicionada al Benchmark | [papel] |
| 16 — Backlog visual | No | Bajo-medio | Baja (pausado) | — |

## Changelog

- **v3 → hoy:** Fase 0 completada (ModelAugmenter verificado en produccion con suite 37/37 y regresión 1044 en verde); Fase 2 CI/CD implementada (`.github/workflows/ci.yml` + build portable); Fase 1 avanzada (KeychainManager para credenciales de LLM con migración automática y `test_keychain_integration` 19/19; `webSecurity: true` en la ventana de chat); `contextIsolation` queda documentado como el pendiente que se vuelve bloqueante con §10.
- **v2 → v3:** verificación fresca contra produccion; tamaños de archivos grandes actualizados; nueva Fase 9 (Configuración), nueva Fase 11 (Autenticación en 3 niveles), Fase 10 explícita en nativo+MCP en paralelo; orden general intercala Configuración+Auth junto a Git/GitHub antes del hardening.
