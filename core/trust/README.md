# Modelo de confianza (`core/trust/`)

Decide qué modo de agente recomendar (`smart`/`fast`) según el **costo × éxito** real de tareas
pasadas, por proveedor/modelo/modo. Es la base de la "autonomía adaptativa": si un modo falla más
de la cuenta, el asistente deja de proponerlo.

## `TrustModel.js`

`class TrustModel` (exporta `MODE_BUDGET`, `MIN_ATTEMPTS`, `RECOMMEND_THRESHOLD`, `MODE_ADVANTAGE`):

- **Score de confianza** por tripleta proveedor/modelo/modo con _additive smoothing_ sobre los
  outcomes de tareas (`success`/`failure`, ponderados por dificultad de `core/learning/difficulty.js`).
- **Recomendación conservadora** de modo (umbral de ventaja mínima antes de recomendar cambio; falla
  a `RECOMMEND_THRESHOLD` → modo por defecto).
- Persistencia JSON **never-throw** en `data/trust_feedback.json`.

## API pública (`core/core/trust.js`)

`getTrustData` · `getTrustStats` · `trustScore` · `recommendMode` · `recordTrustOutcome` · `resetTrust`.

Los outcomes se registran al terminar cada tarea del agente (junto a `recordTaskOutcome` del
`LearningEngine`); `recommendMode` alimenta la resolución de modo automático en
`core/core/agent.js`.

## Etiqueta

```
core/trust
        ├── TrustModel.js   # Score costo×éxito + recomendación de modo
        └── README.md
```

Verificación: `test_trust`.
