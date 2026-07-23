# Bus de eventos interno

Único canal de comunicación entre componentes del sistema. Implementación pub/sub singleton.

## Archivos

### EventBus.js 
Bus de eventos con métodos `on()`, `once()`, `off()`, `emit()`.

**Eventos definidos:**

| Evento | Emisor | Consumidores |
|---|---|---|
| `os:app-changed` | OSSensor | ProactiveEngine, BehaviorModel |
| `os:app-tick` | OSSensor | ProactiveEngine |
| `os:idle-changed` | OSSensor | ProactiveEngine |
| `os:windows-updated` | OSSensor | — |
| `memory:turn-added` | MarchCore | ProactiveEngine |
| `memory:node-saved` | StateUpdater | — |
| `session:started` | MarchCore | — |
| `session:closed` | MarchCore | — |
| `initiative:trigger` | ProactiveEngine | MarchCore → Chat UI |
| `initiative:dismiss` | ProactiveEngine | Chat UI |
| `plan:started` | Planner | Chat UI |
| `plan:step-start` | Planner | Chat UI |
| `plan:step-done` | Planner | Chat UI |
| `plan:finished` | Planner | Chat UI |
| `openclaw:available` | MarchCore | Chat UI |
| `march:memory-status` | MarchCore | Chat UI |

**Patrón de uso:**
```js
const { getEventBus } = require('../event-bus/EventBus.js');
const bus = getEventBus();
bus.on('os:app-changed', (data) => { /* reaccionar */ });
bus.emit('os:app-changed', { app: 'firefox', friendlyName: 'Firefox' });
```
