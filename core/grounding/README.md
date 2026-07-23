# core/grounding/ — Pipeline de contexto

Ensambla todo el contexto que recibe el LLM antes de generar una respuesta: memoria persistente, estado del sistema, intención del usuario.

## Archivos

### GroundingEngine.js 
Orquesta el pipeline completo:
1. Toma el mensaje del usuario + contexto del sensor de SO
2. `RetrievalPlanner.plan()` → recupera nodos relevantes del StateGraph
3. `IntentDetector.detect()` → detecta si hay intención de usar herramientas
4. `ContextAssembler.build()` → arma el paquete de contexto
5. Serializer → convierte a system prompt + messages

### ContextAssembler.js 
Construye el `contextPackage` que contiene:
- `identity` — personalidad de March 7th
- `osContext` — app activa, ventanas abiertas, tiempo de uso (vía `buildOSContext()`)
- `persistentMemory` — nodos y episodios recuperados
- `sessionHistory` — historial de la conversación actual
- `currentMessage` — último mensaje del usuario
- `toolIntent` — resultado de detección semántica

### IntentDetector.js 
Detecta si el usuario quiere ejecutar una acción usando embeddings locales (`all-MiniLM-L6-v2`) + búsqueda coseno en sqlite-vec.

**Niveles de confianza:**
| Nivel | Significado |
|---|---|
| `high` | El LLM debe responder con bloque de acción estructurado |
| `medium` | Sugerencia suave |
| `low / none` | Conversación normal |

### RetrievalPlanner.js 
Planifica qué nodos del grafo recuperar según el mensaje del usuario + contexto del SO. Usa búsqueda por similitud coseno con ponderación por recencia.

### serializers/

| Archivo | Propósito |
|---|---|
| `GroqSerializer.js` | Serializa para Groq/Llama: identidad, contexto SO, memoria, herramientas |
| `GeminiOpenAISerializer.js` | Extiende GroqSerializer; Gemini recibe `system_instruction` separado |
