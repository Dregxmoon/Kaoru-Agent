# core/grounding/serializers/ — Serializadores de contexto

Convierten el paquete de contexto (`ContextPackage`) en el formato específico que cada proveedor de LLM espera.

## Archivos

### GroqSerializer.js 
Serializador principal. Construye el system prompt en 4 secciones separadas por `---`:

1. **Identidad** — "¿Quién es March 7th?" (desde `identity.json`)
2. **Contexto del SO** (`## Contexto actual`) — app activa, ventanas, tiempo de uso, actividad de hoy
3. **Memoria persistente** — nodos y episodios relevantes del StateGraph
4. **Intención de herramienta** — instrucciones de formato estructurado si el IntentDetector encontró toolIntent

Funciones clave:
- `_buildOSSection()` — renderiza el contexto del SO en texto legible, incluye nota para que el LLM no intente usar herramientas MCP para responder qué apps están abiertas
- `_buildMemorySection()` — renderiza nodos y episodios de memoria
- `_buildToolIntentSection()` — inyecta instrucciones de parseo para acciones estructuradas

### GeminiOpenAISerializer.js 
Extiende GroqSerializer. Cambios:
- Gemini: `system_instruction` va separado de `messages[]`
- OpenAI: mismo formato que Groq, con ajustes menores de tono

### Mecanismo de selección
En `ContextAssembler.build()` se selecciona el serializador según `activeProvider`:
```js
const serializer = SERIALIZERS[activeProvider] ?? SERIALIZERS.groq;
```
