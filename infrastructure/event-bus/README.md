# Bus de eventos interno (`infrastructure/event-bus/`)

Único canal de comunicación entre componentes del sistema. Implementación **pub/sub singleton**:
desacopla emisores de consumidores — un módulo nunca conoce la identidad de quien consume sus eventos.

---

## `EventBus.js`

API: `on()`, `once()`, `off()`, `emit()` (con utilidades de inspección para diagnóstico).

**Eventos definidos:**

| Evento | Emisor | Consumidores |
|---|---|---|
| `os:app-changed` | OSSensor | ProactiveEngine, BehaviorModel |
| `os:app-tick` | OSSensor | ProactiveEngine |
| `os:idle-changed` | OSSensor | ProactiveEngine |
| `os:windows-updated` | OSSensor | — |
| `git:redflag` | GitWatcher | ProactiveEngine |
| `system:warning` | SystemWatcher | ProactiveEngine |
| `os:error-title` | TitleWatcher | ProactiveEngine |
| `clipboard:copied` | ClipboardWatcher | ProactiveEngine |
| `memory:upcoming-event` | UpcomingEventsWatcher | ProactiveEngine |
| `lsp:error` | LSPErrorWatcher | ProactiveEngine |
| `memory:turn-added` | Core | ProactiveEngine |
| `memory:node-saved` | StateUpdater | — |
| `session:started` / `session:closed` | Core | — |
| `initiative:trigger` | ProactiveEngine | Core → Chat UI |
| `initiative:dismiss` | ProactiveEngine | Chat UI |
| `initiative:decision` | Chat UI | Core |
| `proposal:executed` | ProactiveExecutor | Core → Chat UI |
| `agent:completed` | Core | — |
| `plan:started` / `plan:step-start` / `plan:step-done` / `plan:finished` | Planner | Chat UI |
| `openclaw:available` | Core | Chat UI |
| `memory-status` | Core | Chat UI |

**Patrón de uso:**

```js
const { getEventBus } = require('../event-bus/EventBus.js');
const bus = getEventBus();

bus.on('os:app-changed', (data) => { /* reaccionar */ });
bus.emit('os:app-changed', { app: 'firefox', friendlyName: 'Firefox' });
```

---

## Flujo

```mermaid
flowchart LR
    subgraph EM["Emisores"]
        S1["OSSensor"]
        S2["GitWatcher"]
        S3["LSPErrorWatcher"]
        S4["Core"]
        S5["Chat UI"]
    end
    BUS["EventBus<br/>pub/sub singleton"]
    subgraph CONS["Consumidores"]
        C1["ProactiveEngine"]
        C2["BehaviorModel"]
        C3["Core"]
        C4["Chat UI"]
    end

    S1 --> BUS
    S2 --> BUS
    S3 --> BUS
    S4 --> BUS
    S5 --> BUS
    BUS --> C1
    BUS --> C2
    BUS --> C3
    BUS --> C4
```

---

## Por qué un bus

- **Desacoplamiento total:** agregar un sensor o un consumidor no toca al resto.
- **Escalabilidad proactiva:** el motor proactivo se suscribe a cualquier señal nueva sin cambios en
  los emisores (complementa `registerProfile()` de `SignalNormalizer`).
- **Diagnóstico:** permite inspeccionar eventos activos (`getActiveEvents`/`eventNames`) para auditoría.
