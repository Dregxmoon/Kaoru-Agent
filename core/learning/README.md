# Aprendizaje por feedback (`core/learning/`)

Cierra el círculo de la proactividad y del agente: los outcomes reales (aceptar/descartar una
propuesta, éxito/fracaso de una tarea) se convierten en pesos y lecciones reutilizables. Persistencia
JSON **never-throw** en `data/learning_feedback.json` (cae a memoria si falla).

## `LearningEngine.js`

Clase `LearningEngine` + exponente `MAX_TASK_OUTCOMES`. Conecta dos fuentes de feedback:

1. **Feedback proactivo** (Fase G del motor) — del `ProposalStore`
   (`core/behavior/proactive/proposal-store`): `deriveWeights` recalcula los pesos de scoring que el
   gate lee, y `ajustarScorePorAprendizaje` aplica un sesgo por tipo sobre la relevancia
   (`core/decision/DecisionCore.js`). `getLearnedWeights()` los publica para el gate.
2. **Outcomes de tareas** — evaluación de tareas completadas por el agente: cuando hay suficientes
   (≥ `MAX_TASK_OUTCOMES` considera muestreo) alimentan la sección `# LO APRENDIDO` del system prompt,
   y comparten los datos con el modelo de confianza (`core/trust/TrustModel.js`).

API pública expuesta desde `core/core/learning.js`: `getLearningData` · `getTaskOutcomes` ·
`getLearnedWeights` · `recordTaskOutcome` · `resetLearning` (usada por main/IPC/Control API).

## `difficulty.js`

`estimateDifficulty({message, taskIntent, messageCount})` — heurística determinista (sin LLM) que
acota la dificultad de una tarea a `[0, 1]`. La usan `LearningEngine` y `TrustModel` para contextualizar
resultados; persistencia y tests independientes de la API.

## Etiqueta

```
core/learning
        ├── LearningEngine.js   # Pesos de proactividad + "# LO APRENDIDO"
        ├── difficulty.js       # Heurística de dificultad [0,1]
        └── README.md
```

Verificación: `test_learning`. El feedback llega vía `ProposalStore`
(`core/behavior/proactive/README.md`, Fase G) y `recordTaskOutcome`; el gate lo aplica en
`core/decision/ContextGate.js`.
