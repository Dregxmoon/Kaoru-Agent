## ASISTENTE PERSONAL 

**Un compañero de escritorio con IA que observa el sistema operativo, recuerda con contexto, y actúa solo cuando tiene permiso — con un motor de decisión determinista y auditable.**

Una plataforma de asistencia personal que vive en el escritorio del usuario. Combina un avatar Live2D, un modelo de lenguaje conversacional, memoria semántica persistente con decaimiento temporal, percepción en tiempo real del sistema operativo, y un motor de proactividad que decide *cuándo* hablar, *cuándo* callar y *cómo* entregar su ayuda — sin depender de un chatbot reactivo ni de temporizadores ciegos.

---

## 1. Propuesta de valor

### ¿Qué problema resuelve?

Los asistentes de escritorio tradicionales son **reactivos**: esperan a que el usuario escriba. Este asistente está diseñado para ser **proactivo de forma responsable**:

- **Observa en silencio.** Detecta contexto real del sistema operativo: aplicación activa, tiempo de enfoque, inactividad, señales de riesgo en el repositorio (`.env` sin ignorar, conflictos de merge, commits sin push), errores del editor (LSP) y eventos próximos del calendario.
- **Habla cuando aporta.** Cada mensaje proactivo está justificado por un **score de relevancia determinista** (no por corazonadas del modelo), pasa por un *gate de contexto* que respeta el momento del usuario (foco, inactividad, presupuesto diario), y se entrega como **propuesta con consentimiento**: el asistente propone, el usuario decide.
- **Recuerda con contexto.** Mantiene un grafo de conocimiento persistente sobre el usuario (proyectos, preferencias, hechos) con búsqueda semántica local y decaimiento temporal — lo de ayer pesa más que lo de hace tres semanas, sin descartar lo importante.
- **Ejecuta con defensa en profundidad.** Las acciones de alto impacto (edición de archivos, comandos de shell, navegación web, herramientas externas) requieren aprobación explícita, están confinadas al proyecto del usuario y se verifican post-ejecución con rollback automático si algo sale mal.

### Segmentos objetivo

| Segmento | Valor entregado |
|---|---|
| **Desarrolladores** | Asistente de código proactivo: detecta errores LSP en el editor, propone parches con diff y verificación real, cuida la higiene del repo (`.env`, conflictos, commits) y ejecuta tareas vía MCP/OpenClaw con control total. |
| **Usuarios de escritorio** | Compañero persistente con memoria: retoma hilos pendientes, recuerda lo que importa, ofrece ayuda contextual en el momento adecuado y respeta la privacidad (todo local). |
| **Creadores y streamers** | Overlay Live2D en tiempo real con voz sintetizada (Edge TTS), reconocimiento de voz offline (Vosk) y personalidad consistente. |

### Diferenciadores

1. **Decisión auditable.** El motor proactivo usa un núcleo determinista (`DecisionCore`) con *reason codes* en cada decisión: cualquier mensaje proactivo puede rastrearse hasta su puntuación, sus pesos y su política. El LLM **produce contenido, nunca decide** cuándo hablar.
2. **Privacidad por diseño.** Memoria, embeddings, telemetría y preferencias viven en la máquina del usuario (SQLite + modelos locales ONNX). No se sube nada por defecto.
3. **Soberanía de proveedores.** Soporta Groq, Google Gemini y OpenAI con fallback automático y reintento exponencial. Sin vendor lock-in.
4. **Extensible por MCP.** Cliente Model Context Protocol propio: cualquier servidor de herramientas del ecosistema se conecta sin tocar el núcleo.
5. **Autonomía calibrada por datos.** Un slider de autonomía (`observe | suggest | act`) más un modelo de receptividad que ajusta la frecuencia y el presupuesto según la respuesta real del usuario.

---

## 2. Arquitectura del sistema

```mermaid
flowchart TD
    subgraph UI["Capa UI (Electron)"]
        OVERLAY["Overlay Live2D<br/>src/index.html"]
        CHAT["Chat<br/>src/chat.html"]
        BUBBLE["Propuestas proactivas<br/>con consentimiento"]
    end

    subgraph IPC["Capa IPC — main.js"]
        ADD["addTurn()"]
        BUILD["buildContext()"]
        AGENT["runAgent()"]
        DECIDE["handleProposalDecision()"]
    end

    subgraph CORE["Core — orquestador"]
        subgraph CHAT_FLOW["Conversación"]
            GROUND["Grounding<br/>intención + memoria"]
            LOOP["AgentLoop<br/>LLM → tool → resultado"]
        end
        subgraph MEM["Memoria"]
            GRAPH["StateGraph<br/>SQLite + vectores"]
        end
        subgraph PROACT["Motor proactivo"]
            DECISION["Decisión determinista<br/>score + gate + SLO"]
            PROPOSAL["Propuesta + ejecución<br/>con permiso"]
        end
        GROUND --> LOOP
    end

    subgraph PERC["Percepción y acción"]
        SENSORS["Sensores<br/>SO · Git · LSP · título · eventos"]
        LLM["LLM Providers<br/>Groq / Gemini / OpenAI"]
        TOOLS["OpenClaw · MCP · Browser"]
    end

    OVERLAY --> CHAT
    CHAT --> ADD --> GROUND
    CHAT --> AGENT --> LOOP
    CHAT --> BUILD --> GROUND
    GRAPH --> GROUND
    SENSORS --> DECISION
    DECISION --> PROPOSAL --> BUBBLE
    BUBBLE --> DECIDE --> PROPOSAL
    LLM --> LOOP
    LOOP --> TOOLS
```

### Flujo conversacional

1. El usuario escribe un mensaje → `Core.buildContext()` ensambla identidad, contexto del SO, memoria recuperada e intención.
2. `IntentDetector` (embeddings locales) y `TaskDetector` clasifican si hay intención de acción y en qué dominio.
3. `AgentLoop` (modo agente) ejecuta el bucle **LLM → herramienta → resultado → LLM** con un tope de iteraciones; o `complete()`/`completeWithTools()` para respuestas directas.
4. La respuesta se renderiza en el chat (markdown sanitizado) y se persiste la sesión incrementalmente.

### Flujo proactivo (motor de decisión Fase F)

```mermaid
flowchart LR
    S["Sensor<br/>señal cruda"] --> N["Normalizador<br/>candidato"]
    N --> R["Score de relevancia"]
    R --> G["Gate de contexto<br/>foco / presupuesto / cola"]
    G --> P["Política<br/>ACT · QUEUE · DROP · ESCALATE"]
    P --> L["LLM genera CONTENIDO<br/>(nunca decide)"]
    L --> U["Propuesta con consentimiento"]
    U -->|"outcome"| REC["Receptividad"]
    REC -->|"ajusta"| G
```

Todo mensaje proactivo es una **propuesta** con botones de aceptar/descartar; las mutaciones se ejecutan solo tras la confirmación, con preview, verificación post-acción y rollback.

---

## 3. Capacidades técnicas

### Memoria semántica con decaimiento temporal
Grafo de conocimiento en SQLite + `sqlite-vec`, embeddings locales (`all-MiniLM-L6-v2` vía ONNX), búsqueda por similitud coseno ponderada por recencia, decaimiento automático de nodos viejos y resolución de contradicciones (sobrescribir / acumular / archivar).

### Proactividad responsable
Motor de iniciativa en dos niveles: heurística barata + núcleo determinista de decisión (score, gate de contexto, presupuesto dinámico, cola de diferidos) y **el LLM como generador de contenido**. El modelo de receptividad calibra frecuencia y presupuesto con datos reales de aceptación/descartes.

### Agente de código profundo
Detección de errores del editor vía **LSP real** (typescript-language-server): sensor de errores, índice de símbolos, propuestas de parche con diff, verificación post-ejecución con el LSP y `node --check`, y rollback automático si el parche rompe el archivo.

### Ejecución de acciones gobernada
Ninguna acción de alto impacto se ejecuta sin aprobación explícita. Combina: whitelist de herramientas, confinamiento de rutas al proyecto, bloqueo de rutas sensibles (credenciales, `.env`, cookies), idempotencia por `proposalId` y verificación real post-acción.

### Multi-proveedor de LLM
Groq · Google Gemini · OpenAI con cadena de fallback, reintento exponencial con jitter, límite de fallas consecutivas por proveedor y modo de "rate-limit" con mensajes accionables.

### Model Context Protocol (MCP)
Cliente MCP propio (stdio), reconexión automática con backoff, namespacing de herramientas por servidor y catálogo dinámico inyectado al prompt del LLM.

### Automatización de navegador
`BrowserBridge` con Playwright headless: navegación, lectura de páginas, capturas y búsqueda web — separado del navegador personal del usuario.

### Masa de herramientas
`grep` (búsqueda regex por contenido), `glob` (patrones de archivos) y `subagent` (sub-agente anidado) se suman a la whitelist de `AgentLoop`: el asistente explora el proyecto sin volcar todo al contexto, con límites de resultados y profundidad.

### Sandbox de renderers
Ambas ventanas (overlay Live2D y chat) corren con `nodeIntegration:false` + `contextIsolation:true` y preloads acotados (`src/preload.js`, `src/chat/preload.js`) que exponen una API mínima vía `contextBridge`: los scripts remotos de PixiJS/Live2D no tienen acceso a Node, `require`, `process` ni `child_process`. `GestureEngine` (una clase ES que necesita `new` y recibe el objeto Live2D real) se ejecuta **en la página** vía un loader mínimo (`__coreLoader`) que solo resuelve fuentes whitelisteadas de `GestureLexicon`/`GestureHeuristic`/`GestureEngine`. Los comandos `/` se ejecutan en el mundo aislado con `fs`/`path` reales de Node (método `runCommand` del preload); la página nunca recibe `fs`/`path` crudos.

### Contexto largo con memoria
Al compactar la historia, `AgentLoop` persiste el resumen como episodio en el grafo semántico y al inicio de cada run inyecta el recall de episodios relevantes al objetivo actual — reconstruye contexto en tareas largas o retomadas.

### Telemetría local
`TelemetryStore`: turnos, sesiones, silencios, tiempos de respuesta y reporte mensual con deltas — para responder "¿estamos mejor que el mes pasado?" con datos locales.

---

## 4. Stack tecnológico

| Capa | Tecnología |
|---|---|
| Runtime de escritorio | Electron 28 |
| Modelo de personaje | Live2D Cubism 5 (Pixi.js + live2d-display) |
| Persistencia | SQLite (`better-sqlite3`) + `sqlite-vec` |
| Embeddings locales | `@xenova/transformers` (ONNX Runtime, `all-MiniLM-L6-v2`) |
| Reconocimiento de voz | Vosk (offline) |
| Síntesis de voz | Edge TTS (streaming vía Python) |
| Automatización de navegador | Playwright |
| Modelos de lenguaje | Groq (Llama 3.3 70B) · Google Gemini · OpenAI |
| Protocolo de herramientas | Model Context Protocol (`@modelcontextprotocol/sdk`) |
| Renderizado de chat | `marked` + `DOMPurify` |

---

## 5. Estructura del proyecto

```
├── core/                      # Núcleo de inteligencia y orquestación
│   ├── Core.js           #   Orquestador central (init, sesiones, contexto)
│   ├── agents/                #   Definiciones de agentes especializados
│   ├── behavior/              #   Comportamiento + motor de proactividad
│   ├── commands/              #   Registro de comandos (/comando)
│   ├── decision/              #   Núcleo determinista de decisión proactiva
│   ├── git/                   #   Wrapper nativo de Git (git_status, push, merge…)
│   ├── github/                #   Cliente REST de GitHub (issues, PRs, OAuth device flow)
│   ├── grounding/             #   Pipeline de contexto (intención, memoria, serializers)
│   ├── identity/              #   Personalidad del asistente (identity.json)
│   ├── llm/                   #   Abstracción de proveedores de LLM
│   ├── lsp/                   #   Cliente LSP + índice de símbolos
│   ├── mcp/                   #   Cliente Model Context Protocol
│   ├── planner/               #   Agente: parsing, loop de ejecución, bridges
│   ├── skills/                #   Sistema de skills (inyección contextual)
│   ├── state-graph/           #   Grafo de conocimiento persistente
│   ├── task/                  #   Detección de tareas + registro de herramientas
│   └── telemetry/             #   Telemetría local (métricas de uso)
├── ipc/                       # Capa IPC (puente renderer ↔ núcleo)
│   ├── state.js               #   Estado compartido del proceso principal
│   └── *-handlers.js          #   Handlers por dominio (openclaw, mcp, github, …)
├── infrastructure/            # # Capa de bajo nivel
│   ├── database/              #   Inicialización de índices vectoriales
│   ├── event-bus/             #   Bus de eventos interno (pub/sub)
│   ├── keychain/              #   Llavero del SO (credenciales seguras)
│   └── sensors/               #   Sensores de señales (git, LSP, sistema, etc.)
├── src/                       # Interfaz (overlay Live2D + ventana de chat)
│   ├── preload.js         #   Preload del overlay (API sandboxed vía contextBridge)
│   └── chat/preload.js    #   Preload del chat (API sandboxed vía contextBridge)
├── models/                    # Modelos Live2D (solo "March 7th" se versiona; los importados por el usuario no se suben)
├── skills/                    # Skills del proyecto (code-review, git-workflow, testing)
├── tests/                     # Suite de pruebas (unitarias + integración)
└── docs/                      # Documentación técnica y de arquitectura
```

---

## 6. Inicio rápido

### Requisitos
- Node.js ≥ 18 y npm
- Python 3 con `edge-tts` (solo si se usa síntesis de voz)
- Sistema operativo: Windows (sensor nativo) o Linux/Hyprland (sensor Wayland)

### Instalación

```bash
npm install            # instala dependencias y electron (postinstall)
npm run rebuild        # reconstruye módulos nativos (better-sqlite3)
cp config.example.json ~/.config/vtuber-overlay/config.json   # Linux
# o: %APPDATA%/vtuber-overlay/config.json                      # Windows
```

### Configuración

En `config.json` (fuente de claves) o `.env` (alternativa):

```json
{
  "activeModel": "March 7th",
  "activeWorkspace": "~/mis-proyectos/panel",
  "llm": {
    "primary": "groq",
    "apiKeys": { "groq": "", "gemini": "", "openai": "" },
    "fallback": ["gemini", "openai"]
  },
  "autonomy": "suggest",
  "sensors": { "git": true, "system": true, "title": true, "clipboard": false, "events": true, "lsp": true },
  "mcp": { "servers": [] }
}
```

| Clave | Descripción |
|---|---|
| `activeModel` | Modelo Live2D activo (carpeta dentro de `models/`) |
| `activeWorkspace` | Carpeta/proyecto activo sobre el que opera el asistente |
| `llm.primary` | Proveedor principal (`groq` / `gemini` / `openai`) |
| `llm.apiKeys` | Claves API por proveedor (o `LLM_KEY_*` en `.env`) |
| `llm.fallback` | Cadena de fallback entre proveedores |
| `autonomy` | `observe` (solo observa) · `suggest` (propone, default) · `act` (actúa con confirmación) |
| `sensors.*` | Activa/desactiva sensores de señales (git, sistema, título, portapapeles, eventos, LSP) |
| `mcp.servers` | Servidores MCP a conectar al arrancar |

### Cambiar el modelo Live2D

El modelo se elige en tiempo real sin reiniciar:

- **Comando** `/cambio-modelo` en el chat lista los modelos disponibles en `models/`; `/cambio-modelo <nombre>` activa uno (con autocompletado al escribir `/cambio-modelo `).
- **Arrastra y suelta** la carpeta de un modelo sobre la ventana de chat para importarlo y activarlo automáticamente.

Cada modelo es una carpeta dentro de `models/` que contiene al menos un archivo `.model3.json` (Live2D Cubism). El cambio se propaga al instante al overlay y al chat vía IPC, y queda guardado en `config.json` como `activeModel`.

Los modelos que el usuario importa se guardan en `models/`, quedan excluidos del repositorio (`.gitignore` del proyecto y global de git) y no se suben a GitHub; solo el modelo por defecto (`March 7th`) forma parte del repo.

### Gestos del modelo (expresiones y animaciones)

Muchos modelos traen carpetas con `*.exp3.json` / `*.motion3.json` que su `model3.json` **no referencia**, así que el SDK jamás las carga y el modelo se queda quieto. El asistente los **descubre y los inyecta en memoria** al cargar (`core/behavior/ModelAugmenter.js`) — sin tocar los archivos del modelo — y les asocia estados de ánimo mediante un léxico multilingüe (`core/behavior/GestureLexicon.js` + `GestureHeuristic.js`).

- **Automático:** el overlay y el mini-avatar del chat reaccionan al tono de voz (`speak`), a los mensajes del usuario y a los eventos del flujo (iniciativa, propuestas, planes, agentes, comandos). Cooldowns y revertido automático los controla `core/behavior/GestureEngine.js`.
- **Manual:** el comando `/gestos` lista los gestos reales del modelo activo y cuáles están mapeados a emociones; `/gestos test <gesto|emoción>` los previsualiza en el mini-avatar (p. ej. `/gestos test angry`, `/gestos test 哭`, `/gestos test zhaiyan`).
- **Configuración:** el bloque `gestures` de `config.json` ajusta `enabled`, `cooldownMs`, `minIntervalMs`, `durationMs`, `ambient` (gestos aleatorios de fondo) y `mappings` (mood → gesto explícito por modelo).

### Workspace del proyecto

El asistente trabaja sobre un **workspace activo** — la carpeta/proyecto real del usuario, distinta de la carpeta donde corre la app:

- **Seleccionar:** botón del workspace en la barra superior del chat, o variable de entorno `ASISTENTE_WORKSPACE`. Queda persistido en `config.json` como `activeWorkspace`.
- **`/init`**: analiza el proyecto activo (package.json, extensiones, estructura) y lo guarda en memoria persistente.
- **`@archivo`**: al escribir `@` se listan todos los archivos del proyecto y se van filtrando mientras se escribe (Tab/flechas/Enter para insertar). Los comandos de archivo (`/init`, `/open`, …) y las referencias `@` resuelven contra el **workspace activo**, no contra la carpeta de la app.
- Al iniciar, la sesión anterior se retoma en silencio (sin mensaje de "mensajes recuperados").

### Ejecutar

```bash
npm start
```

También expone una **Control API** de diagnóstico en `http://localhost:3131` (token en el log de arranque): `/help`, `/stats`, `/telemetry/report`, `/debug/lsp-scan`.

### Probar

```bash
# Regresión completa (todas las suites bajo el Node de Electron)
npm test

# O una suite individual (también requiere el ABI de Electron)
ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron tests/test_skills.js
```

> `better-sqlite3` y `sqlite-vec` están compilados para el **ABI de Electron**, no para el Node
> del sistema: las suites que tocan memoria/persistencia (indexado en BD y matching semántico)
> deben correr con `ELECTRON_RUN_AS_NODE=1`. `test_intent_detection` exige haber ejecutado antes
> `init_vectors.js` (también bajo Electron) para indexar las intenciones en `data/core.db`.

---

## 7. Estado del proyecto

| Componente | Estado |
|---|---|
| Overlay Live2D + chat | ✅ Operativo |
| Memoria semántica persistente | ✅ Operativo |
| Sensor de SO (Windows/Linux) | ✅ Operativo |
| Ejecución de acciones con consentimiento | ✅ Operativo |
| MCP + agentes + skills | ✅ Operativo |
| Motor de decisión proactiva (Fase F) | ✅ Operativo |
| Telemetría local | ✅ Operativo |
| Agente de código profundo (LSP) | ✅ Operativo |

El proyecto se desarrolla por fases — ver [`ROADMAP.md`](./ROADMAP.md) para la estrategia completa y las siguientes entregas.

---

## 8. Documentación

| Documento | Contenido |
|---|---|
| [`ROADMAP.md`](./ROADMAP.md) | Visión, estrategia y hoja de ruta |
| [`docs/arquitectura.md`](./docs/arquitectura.md) | Diagrama de arquitectura detallado |
| [`core/`](./core/README.md) | Núcleo de inteligencia y orquestación |
| [`core/git/`](./core/git/README.md) | Integración nativa con Git |
| [`core/github/`](./core/github/README.md) | Cliente REST de GitHub y OAuth |
| [`infrastructure/`](./infrastructure/README.md) | Capa de bajo nivel |
| [`ipc/`](./ipc/README.md) | Capa IPC (renderer ↔ núcleo) |
| [`src/`](./src/README.md) | Interfaz de usuario |
| [`tests/`](./tests/README.md) | Estrategia de pruebas |

---

## 9. Pruebas y capturas

La suite de pruebas es **ejecutable e independiente por archivo** (`tests/`), con cobertura de comandos, motor de proactividad, detección de intenciones, skills, integraciones LSP, Git/GitHub y seguridad de la Control API. La regresión completa se ejecuta con `npm test` (usando el Node de Electron): **1371 pruebas en verde** (incluyen regresiones del fix LSP G.1, del parser de CONTENIDO multilínea, de la compactación de contexto, del edit determinista, de las tools grep/glob/subagent y de la compactación con memoria). Antes de correrla, cierra el asistente para que las suites de seguridad puedan levantar su propio servidor en `:18789` (si la app está corriendo, `test_server_security` y `test_integration_stress` fallan por conflicto de puerto).

### Pruebas

La suite de pruebas ejecutándose y el comando `/init`, que analiza el proyecto desde el chat:

![Suite de pruebas](./screenshots/05-tests.png)

![Comando /init](./screenshots/09-init.png)

### Datos

La Control API de diagnóstico (`http://localhost:3131`, token por sesión — incluye `/help`, `/telemetry/stats`, `/telemetry/report`, `/debug/lsp-scan`, `/workspace` y `/chat`) y la telemetría local que compara el uso mes a mes con `/telemetria`:

![Control API](./screenshots/06-control-api.png)

![Telemetría local](./screenshots/10-telemetria.png)

### El asistente en acción

El overlay Live2D con el modelo por defecto (**March 7th**) sobre el escritorio, el chat con una conversación real, el panel de comandos `/stats`, el renderizado de Markdown, una propuesta proactiva y las vistas del modelo:

| | |
|---|---|
| ![Overlay March 7th](./screenshots/01-overlay-desktop.png) | ![Personaje March 7th](./screenshots/02-overlay-character.png) |

![Conversación en el chat](./screenshots/03-chat-conversacion.png)

![Propuesta proactiva](./screenshots/07-propuesta.png)

![Renderizado Markdown](./screenshots/08-markdown.png)

![Vistas del modelo](./screenshots/11-overlay-vistas.png)

![Modelos disponibles](./screenshots/12-modelos.png)

> Los modelos mostrados en `12-modelos.png` son de terceros y de uso de fan: *hutao* y *huohuo* © HoYoverse; *Miku* Solo **March 7th** se distribuye con el repositorio (ver [Licencia y atribuciones](#10-licencia-y-atribuciones)).


---

## 10. Licencia y atribuciones

El código fuente se distribuye bajo licencia **MIT** — ver [`LICENSE`](./LICENSE).

**Los assets del modelo Live2D de `models/March 7th/`** son propiedad de Cognosphere Pte. Ltd. / HoYoverse (personaje *March 7th* de *Honkai: Star Rail*) y se usan aquí como contenido de fan sin fines comerciales. Es el único modelo que se distribuye con el repo; los modelos que el usuario importa quedan fuera del control de versiones. Cualquier reutilización de este proyecto debe proveer su propio modelo o excluir esa carpeta.

Este proyecto es un trabajo de fan **no oficial**, sin afiliación con Cognosphere Pte. Ltd. ni con HoYoverse.
