# Changelog

Todas las versiones notables de este proyecto se documentan en este archivo.

## [1.0.0] — 2026-08-04

### Corregido
- **LSP post-edit (Bug 1):** el `initialize` ya no envía `rootPath` + `workspaceFolders`
  por defecto. pyright (y servers similares) dejan de publicar `publishDiagnostics` cuando
  el cliente declara soporte de workspace folders y nunca inicializa el workspace
  (ver microsoft/pyright#6874, #11103). Ahora solo se envía `rootUri`; los servers que
  lo necesitan (go/java) lo declaran con `workspaceFolders: true` en `servers.json`.
  `getDiagnostics()` intenta SIEMPRE el pull `textDocument/diagnostic` primero con un
  timeout corto (5 s) y cae a la cache push si el worker está ocupado (evita bloquear
  la tool 20 s).
- **Fallback de escritura (Bug 2):** el parser de acciones estructuradas usaba el
  `userGoal` como contenido de `write`/`edit`. Ahora `CONTENIDO:` se extrae completo
  (incluido multilínea) y se usa como instruction; el objetivo solo es fallback.
- **Proactividad de alta calidad:** se eliminó la invitación a "comentario random" del
  prompt y se agregó un filtro de mensajes relleno (saludos/check-ins genéricos) en modo
  producción (gate admitió), para que el asistente no moleste con ruido.

### Agregado
- **LSP para más lenguajes:** `servers.json` ampliado a 20 lenguajes (c/cpp via clangd,
  csharp, kotlin, swift, dart, bash, lua, html/css/json via vscode-langservers-extracted,
  markdown via marksman, además de python, typescript/javascript, go, java, rust, ruby,
  php).
- **Subagentes paralelos:** `Planner` ejecuta ahora por oleadas: los pasos sin
  dependencias pendientes corren en paralelo (`Promise.all`) respetando el orden
  topológico. `planMultiStep` admite `id` estable para `dependsOn`.
- **Compactación de contexto:** `AgentLoop` condensa los turnos viejos en un resumen
  determinista (objetivo + acciones ejecutadas) cuando la historia crece, conservando
  los últimos turnos íntegros.
- **Benchmark:** `benchmarks/run.js` imprime un resumen global pass@k por tarea y
  agregado.
- **Seguridad:** bloqueo global de navegación a URLs remotas, `window.open` y webviews
  en `main.js` (mitiga el RCE vía renderer con `nodeIntegration`). Flags webPreferences
  explícitos y documentados en ambas ventanas.
- **Puerto configurable:** `OPENCLAW_PORT` permite levantar el server de control en un
  puerto alterno (el bridge lo respeta).
- **Tooling:** `.eslintrc.cjs`, `.prettierrc.json`, scripts `lint`/`lint:fix`/
  `format`/`format:check`, y este `CHANGELOG.md`.

### Pruebas
- Suite completa: **1452 pruebas en verde** (`npm test`).
- Nuevos tests: timeout del pull de diagnósticos, CONTENIDO multilínea, compactación de
  contexto, filtro de relleno en modo producción, edit determinista, grep/glob,
  subagentes y compactación con memoria.

## [1.1.0] — 2026-08-04

### Seguridad
- **Sandbox por defecto (renderers):** ambas ventanas pasan a `nodeIntegration:false` +
  `contextIsolation:true` con preloads acotados (`src/preload.js` y `src/chat/preload.js`)
  que exponen una API mínima vía `contextBridge` (`window.assistant`). La página —incluidos
  los scripts remotos de PixiJS/Live2D— ya no tiene acceso a Node, `require`, `process`
  ni `child_process`. Los módulos core (GestureEngine, ModelAugmenter, LLMProvider,
  CommandRegistry, FileResolver, AgentManager) y el TTS viven en el preload o en main.
- **`GestureEngine` se ejecuta en la página** vía un loader mínimo (`__coreLoader` en
  `src/index.html` y `src/chat/core.js`) que solo resuelve fuentes whitelisteadas de
  `GestureLexicon`/`GestureHeuristic`/`GestureEngine` expuestos por `getCoreModuleSource`
  en los preloads: la clase ES necesita `new` (no funciona sobre proxies del bridge) y
  recibe el objeto Live2D real que no puede cruzar el contextBridge.
- **Comandos `/` sin shims:** `runCommand` del preload del chat ejecuta los comandos con
  `fs`/`path` reales de Node en el mundo aislado (los shims de la página solo tenían
  `join`/`existsSync` y `/init`, `/open`, `/export` fallaban con "readdirSync is not a
  function"). La página nunca recibe `fs`/`path` crudos.
- **`lint`/`format` cubren `src/`:** los scripts incluyen los preloads y el JS del chat
  (overrides de entorno browser + globals compartidos en `.eslintrc.cjs`); se corrigió un
  bug latente (`projectCWD` fuera de scope en `Core.js`) y 22 escapes innecesarios.

### Fiabilidad
- **Edición determinista:** `edit` del server ahora aplica reemplazos por coincidencia
  exacta única. Si `old_text` no se encuentra o aparece más de una vez, falla SIN modificar
  el archivo y pide más contexto (patrón opencode). Acepta alias `oldString`/`newString`
  (schema del ToolRegistry) además de `old_text`/`new_text`.

### Masa de herramientas
- **`grep`:** búsqueda regex por contenido de archivos del proyecto (línea + texto,
  excluye `node_modules`/`.git`/`dist` por defecto, `include`/`ignore`/`max_results`).
- **`glob`:** listado de archivos por patrón glob.
- **`subagent`:** tool nativa que lanza un `AgentLoop` anidado para resolver una sub-tarea
  de forma autónoma (con límite de profundidad 2) y devuelve un resumen conciso. Se
  despacha en proceso (no por HTTP).

### Contexto largo
- **Compactación con memoria vectorial:** cuando `AgentLoop` compacta la historia, persiste
  el resumen como nodo `Episode` (tag `context-compaction`) en el StateGraph/sqlite-vec y,
  al inicio de cada run, inyecta en el prompt el recall semántico de episodios previos
  relevantes al objetivo actual — reconstruye contexto en tareas largas o retomadas.

### Pruebas
- Suite completa: **1371 pruebas en verde** (`npm test`; 2 suites de seguridad requieren
  el puerto `:18789` libre — cierran la app antes de correr).
- Nuevos tests: edición determinista (ambiguo/único/ausente), grep/glob, subagente
  (dispatch y límite de profundidad), compactación ↔ memoria.

