# Telemetría local (`core/telemetry/`)

Métrica local de uso para responder con datos — no con percepciones — *"¿estamos mejor que el mes
pasado?"*. Todo se almacena en la máquina del usuario; no se envía nada por defecto.

---

## `TelemetryStore.js`

Registra métricas de uso del asistente:

| Métrica | Qué mide |
|---|---|
| **Turnos** | Mensajes del usuario procesados por el funnel de `Core.addTurn` |
| **Sesiones** | Sesiones de conversación iniciadas/cerradas |
| **Silencios** | Periodos sin interacción |
| **Tiempos de respuesta** | Latencia de las respuestas del asistente |
| **Reporte mensual** | Deltas y veredicto comparando el mes actual contra el anterior |

### Persistencia
- Archivo local (`telemetry.json` en el directorio de datos del usuario).
- Poda automática para evitar crecimiento ilimitado.

### Exposición
- **IPC:** `telemetry-report` → el comando `/telemetria` responde con las flechas ▲/▼ del mes.
- **Control API:** endpoint `GET /telemetry/report`.

---

## Cómo se alimenta

`Core.addTurn()` registra cada turno (es el *funnel* de toda conversación) y
`ProposalStore.getDecisions()` expone el historial de aceptación/descartes por tipo con timestamp —
eso da la **baseline** de aceptación por tipo de propuesta que consume el motor de decisión.

```mermaid
flowchart LR
    CHAT["Conversación<br/>usuario ↔ asistente"] -->|"addTurn"| TS["TelemetryStore<br/>turnos · sesiones · silencios<br/>tiempos de respuesta"]
    PROPS["ProposalStore<br/>decisiones por tipo"] -->|"baseline"| TS
    TS -->|"reporte mensual<br/>deltas + veredicto"| IPC["IPC telemetry-report"]
    IPC --> CMD["/telemetria ▲▼"]
    TS -->|"GET /telemetry/report"| API["Control API"]
```

Verificación: `test_telemetry` (47 tests).
