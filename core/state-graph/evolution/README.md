# Sistema de Memoria Evolutiva

## Descripción general

El Sistema de Memoria Evolutiva añade una capa oculta de inferencias comportamentales/emocionales a la arquitectura existente de StateGraph + SQLite. Rastrea patrones de comunicación del usuario, estados emocionales y momentum de temas para adaptar respuestas dinámicamente.

## Arquitectura

### Componentes nuevos (core/state-graph/evolution/)

1. **EvolutionStore.js** - Almacenamiento persistente para perfiles de comunicación y momentum de temas
   - Tabla `communication_profiles`: métricas de estilo basadas en EMA
   - Tabla `topic_momentum`: seguimiento de frecuencia de temas con scoring de momentum

2. **TraitLearner.js** - Inferencia comportamental determinística (por turno)
   - Detección de patrones emocionales (frustración, entusiasmo, confusión, etc.)
   - Medición de estilo de comunicación (longitud, formalidad, densidad técnica)
   - Sin llamadas al LLM - regex/estadísticas puras

3. **CommunicationStyleProfiler.js** - Adaptación de estilo basada en EMA
   - Rastrea preferencias del usuario a lo largo del tiempo
   - Genera hints para el system prompt de adaptación de respuestas

4. **TopicMomentumTracker.js** - Detección de temas calientes/fríos
   - Scoring de momentum con ventana deslizante (7 días)
   - Extrae temas de los mensajes del usuario
   - Proporciona contexto para triggers proactivos

5. **AdaptiveResponseEngine.js** - Combina todos los insights
   - Construye perfil de adaptación completo
   - Aplica ajustes emocionales
   - Serializa para inyección en el system prompt

## Puntos de integración

### Archivos modificados

1. **StateGraph.js**
   - Imports de componentes de evolution
   - Inicialización en `_initStores()`
   - Creación de schema para tablas de evolution
   - Accesores públicos para componentes de evolution

2. **SessionManager.js**
   - `addTurn()` llama a TraitLearner y TopicMomentumTracker por cada mensaje del usuario

3. **BehaviorModel.js**
   - `evaluate()` acepta perfil de adaptación
   - Aplica adaptaciones de estilo cuando la confianza > 0.2

4. **ContextAssembler.js**
   - Añade hint de estilo de comunicación al paquete de contexto

5. **GroqSerializer.js**
   - Función `_buildCommStyleSection()` para inyección en el system prompt
   - `serialize()` incluye commStyleHint

6. **curiosity.js mixin**
   - Candidatos topic_cold para triggers proactivos
   - Perfil de señal registrado para topic_cold

7. **config.js**
   - topic_cold en CURIOSITY_TYPES
   - Cooldown de topic_cold (4 horas)
   - Proposal hint para topic_cold

8. **context.js**
   - Sección Adaptation en prioridad de truncado

## Flujo de datos

```
Mensaje del usuario
    ↓
SessionManager.addTurn()
    ↓
┌─────────────────────────────────────────┐
│ TraitLearner.analyzeTurn()              │
│   - Detecta emociones                   │
│   - Mide métricas de estilo             │
│   - Actualiza perfiles en EvolutionStore│
└─────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────┐
│ TopicMomentumTracker.analyzeTurn()      │
│   - Extrae topics                       │
│   - Registra en EvolutionStore          │
│   - Actualiza scores de momentum        │
└─────────────────────────────────────────┘
    ↓
Ensamblaje de contexto (por turno)
    ↓
┌─────────────────────────────────────────┐
│ AdaptiveResponseEngine                  │
│   .buildAdaptationProfile()             │
│   - Obtiene estado emocional            │
│   - Obtiene preferencias de estilo      │
│   - Obtiene momentum de topics          │
│   - Aplica ajustes emocionales          │
└─────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────┐
│ BehaviorModel.evaluate()                │
│   - Aplica perfil de adaptación         │
│   - Ajusta longitud de respuesta        │
│   - Añade hints de estilo a notes       │
└─────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────┐
│ GroqSerializer.serialize()              │
│   - Construye sección commStyleHint     │
│   - Inyecta en system prompt            │
└─────────────────────────────────────────┘
    ↓
Respuesta del LLM (adaptada al estilo del usuario)
```

## Degradación graceful

- Todos los componentes funcionan sin LLM (determinístico)
- EvolutionStore maneja errores de base de datos gracefully
- TraitLearner y TopicMomentumTracker nunca bloquean el flujo principal
- Los hints de adaptación solo se inyectan cuando la confianza > 0.2
- El sistema degrada a comportamiento por defecto si los componentes de evolution no están disponibles

## Rendimiento

- Actualizaciones EMA: O(1) por métrica
- Seguimiento de topics: O(1) por mención, limitado a 50 topics
- Análisis emocional: O(1) por turno (matching de regex)
- Sin impacto en el hilo principal (todas las operaciones son rápidas)

## Tests

Ejecutar tests con:
```bash
ELECTRON_RUN_AS_NODE=1 node tests/test_evolutionary_memory.js
```

Los tests verifican:
- Carga de módulos
- Extracción de topics
- Detección de emociones
- Métricas de estilo
- Umbrales y constantes
- Integración con StateGraph y SessionManager
