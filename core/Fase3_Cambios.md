# Fase 3 — Agente con Herramientas (OpenClaw)

## Resumen

March puede ahora ejecutar acciones reales en el PC a través de OpenClaw.
El flujo es: March decide qué hacer → Planner descompone → OpenClaw ejecuta.

**Archivos nuevos:**
```
core/
├── behavior/
│   └── BehaviorModel.js       ← NUEVO
└── planner/
    ├── Planner.js             ← NUEVO
    └── OpenClawBridge.js      ← NUEVO
```

**Archivos modificados:**
```
core/MarchCore.js              ← REEMPLAZAR completo
main.js                        ← AÑADIR bloque IPC al final
src/chat.html                  ← MODIFICAR (ver instrucciones)
```

---

## 1. Copiar archivos nuevos

```
core/behavior/BehaviorModel.js   → tu repositorio
core/planner/Planner.js          → tu repositorio
core/planner/OpenClawBridge.js   → tu repositorio
core/MarchCore.js                → REEMPLAZA el existente
```

---

## 2. Modificar main.js

### A. Antes de `app.whenReady()` — ya tienes esto, no cambia nada

### B. Añadir handlers IPC de Fase 3

Busca esta línea en `main.js`:

```js
ipcMain.handle('force-proactive', async (e, triggerType) => {
```

**Después** de ese handler (antes del cierre del bloque de IPC), añade
el contenido completo de `main_fase3_ipc.js`.

> ⚠️ El fragmento referencia `chatWindow` que ya existe en tu `main.js`.
> No necesitas declararlo de nuevo.

### C. En `app.whenReady().then(...)`, ANTES de `createChatWindow()`:

`MarchCore.init(app)` ya está — no cambia nada.

Los listeners de EventBus del fragmento IPC se registran solos al
ejecutarse el código; no necesitan ir dentro de `whenReady`.

---

## 3. Modificar src/chat.html

### A. Añadir CSS

Dentro del bloque `<style>` existente, al final (antes de `</style>`),
pega el bloque CSS de `chat_fase3_snippet.js`
(el bloque entre los comentarios `/* ... */` al inicio del archivo).

### B. Añadir estado y funciones JS

Dentro del bloque `<script>` al final del HTML, después de la línea:

```js
const sessionHistory      = [];
const MAX_SESSION_HISTORY = 20;
```

Añade:

```js
// ── Fase 3 ────────────────────────────────────────────────────────────────
let openclawAvailable = false;
let activePlanId      = null;
```

### C. Reemplazar processMessage()

Reemplaza la función `processMessage()` completa con la del snippet.
La diferencia clave es que ahora, después de recibir la respuesta del LLM,
intenta parsear acciones y ejecutarlas si OpenClaw está disponible.

### D. Añadir funciones nuevas

Después de `processMessage()`, añade estas funciones del snippet:

- `_executePlanWithUI(plan, msgDiv)`
- `_summarizePlanResult(goal, rawResult)`
- `_showApprovalCard({ planId, stepId, description, tool, params })`
- `_updateOpenClawBadge()`
- `checkOpenClaw()`

### E. Añadir IPC listeners

Junto al bloque de `ipcRenderer.on(...)` existente, añade los 5 listeners
del snippet:

```js
ipcRenderer.on('openclaw-status', ...)
ipcRenderer.on('plan-step-start', ...)
ipcRenderer.on('plan-step-done', ...)
ipcRenderer.on('plan-approval-needed', ...)
ipcRenderer.on('plan-finished', ...)
```

### F. Llamar checkOpenClaw() al arrancar

Dentro de `showWelcome()`, al final (antes del último `speak(text)`):

```js
// Verificar OpenClaw en paralelo, sin bloquear el saludo
checkOpenClaw().catch(() => {});
```

---

## 4. Instalar y arrancar OpenClaw

OpenClaw es un gateway de agente self-hosted. Debe correr en el mismo PC.

```bash
# Opción A — Docker (más fácil)
docker run -p 18789:18789 ghcr.io/openclaw/openclaw:latest

# Opción B — npm global
npm install -g openclaw
openclaw start --port 18789

# Opción C — desde el repo
git clone https://github.com/openclaw/openclaw
cd openclaw && npm install && npm start -- --port 18789
```

> March verifica automáticamente si OpenClaw está en `localhost:18789`
> al arrancar. Si no está, funciona en modo solo-texto (como antes).
> El badge en el header muestra `⚡ TOOLS` o `NO TOOLS` según el estado.

---

## 5. Verificar que funciona

Al arrancar con OpenClaw corriendo, en la consola de Electron verás:

```
[march-core] OpenClaw disponible — Fase 3 activa
[march-core] inicializado (Fase 3)
```

En el chat, el header mostrará el badge `⚡ TOOLS`.

Prueba con mensajes como:
- *"March, busca en la web las últimas novedades de Electron 28"*
- *"Ejecuta el comando: git status"*
- *"Lee el archivo package.json"*
- *"Busca en Google qué es el error EPERM en Node.js"*

---

## 6. Sistema de aprobación

Las acciones de **alto impacto** (comandos con `rm -rf`, escritura fuera
del workspace, `apply_patch`) requieren aprobación explícita del usuario.
March muestra una tarjeta con botones `✓ Ejecutar` / `✗ Cancelar`.

No hay forma de saltarse este paso desde el código — es el comportamiento
esperado según el documento maestro.

---

## 7. Lo que tiene March al terminar Fase 3

- ✅ Detecta intenciones de acción en sus propias respuestas
- ✅ Descompone objetivos en pasos ejecutables (Planner)
- ✅ Ejecuta herramientas via OpenClaw: exec, web_search, browser, read, write
- ✅ Muestra el progreso en tiempo real con una plan card en el chat
- ✅ Solicita aprobación para acciones de alto impacto
- ✅ Resume los resultados en voz de March tras ejecutar
- ✅ BehaviorModel ajusta tono y longitud de respuesta por turno
- ✅ Badge en el header indica estado de OpenClaw
- ✅ Si OpenClaw no está corriendo, funciona exactamente igual que antes

## 8. Lo que NO tiene todavía

- Subagentes (orquestar múltiples agentes en paralelo)
- Generación de imágenes
- Tareas programadas (cron)
- Memoria de acciones entre sesiones (el log del Planner es en RAM)
