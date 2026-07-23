# core/behavior/ — Comportamiento y proactividad

Define CÓMO se comporta March y CUÁNDO debe tomar la iniciativa.

## Archivos

### BehaviorModel.js 
NO genera lenguaje. Evalúa en cada turno el estado del usuario y produce un `BehaviorContext` que describe cómo debe comportarse March:

| Campo | Valores | Descripción |
|---|---|---|
| `tone` | playful / curious / empathetic / dry / direct | Tono de la respuesta |
| `toolTendency` | none / low / medium / high | Inclinación a usar herramientas |
| `detailLevel` | concise / normal / thorough | Nivel de detalle |
| `proactiveScore` | 0.0 — 1.0 | Qué tanto debería tomar la iniciativa |
| `initiativeReason` | string | Por qué debería (o no) hablar |

Se evalúa usando: mensaje del usuario, contexto del SO, historial reciente, hora del día.

### ProactiveEngine.js 
Motor de proactividad autónoma. Se suscribe al EventBus y escucha eventos del sensor de SO para detectar patrones.

**Patrones detectados:**
| Patrón | Gatillo |
|---|---|
| `sustained_focus` | Misma app > 15 min |
| `context_switch` | Cambio de categoría de app |
| `return_from_afk` | Vuelta de inactividad |
| `special_hour` | Pasada cierta hora |
| `long_silence` | Sin hablar > umbral configurable |

Arquitectura de dos niveles: heurística barata decide si vale la pena evaluar; el LLM decide si realmente habla.


