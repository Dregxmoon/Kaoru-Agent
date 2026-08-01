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
| `memory:turn-added` | MarchCore | ProactiveEngine |
| `memory:node-saved` | StateUpdater | — |
| `session:started` / `session:closed` | MarchCore | — |
| `initiative:trigger` | ProactiveEngine | MarchCore → Chat UI |
| `initiative:dismiss` | ProactiveEngine | Chat UI |
| `initiative:decision` | Chat UI | MarchCore |
| `proposal:executed` | ProactiveExecutor | MarchCore → Chat UI |
| `agent:completed` | MarchCore | — |
| `plan:started` / `plan:step-start` / `plan:step-done` / `plan:finished` | Planner | Chat UI |
| `openclaw:available` | MarchCore | Chat UI |
| `march:memory-status` | MarchCore | Chat UI |

**Patrón de uso:**

```js
const { getEventBus } = require('../event-bus/EventBus.js');
const bus = getEventBus();

bus.on('os:app-changed', (data) => { /* reaccionar */ });
bus.emit('os:app-changed', { app: 'firefox', friendlyName: 'Firefox' });
```

---

## Por qué un bus

- **Desacoplamiento total:** agregar un sensor o un consumidor no toca al resto.
- **Escalabilidad proactiva:** el motor proactivo se suscribe a cualquier señal nueva sin cambios en
  los emisores (complementa `registerProfile()` de `SignalNormalizer`).
- **Diagnóstico:** permite inspeccionar eventos activos (`getActiveEvents`/`eventNames`) para auditoría.
