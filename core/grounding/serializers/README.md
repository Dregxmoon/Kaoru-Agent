# Serializadores de contexto (`core/grounding/serializers/`)

Convierten el paquete de contexto (`ContextPackage`) en el formato exacto que cada proveedor de LLM
espera. Mantienen la responsabilidad del *formato* separada del *contenido*.

---

## `GroqSerializer.js`

Construye el system prompt en secciones separadas por `---`:

1. **Identidad** — quién es el asistente (desde `identity.json`).
2. **Contexto del SO** (`## Contexto actual`) — app activa, ventanas, tiempo de uso, actividad de hoy.
3. **Memoria persistente** — nodos y episodios relevantes del `StateGraph`.
4. **Intención de herramienta** — instrucciones de formato estructurado si el `IntentDetector` encontró
   `toolIntent`.

Detalles de implementación relevantes:
- `_buildOSSection()` — renderiza el contexto del SO en texto legible e instruye al modelo a no usar
  herramientas para responder qué apps están abiertas (esa info ya viene en el contexto).
- `_buildMemorySection()` — renderiza nodos y episodios de memoria persistente.
- `_buildToolIntentSection()` — inyecta las instrucciones de parseo para acciones estructuradas
  (`ACCIÓN: ... | ARCHIVO/COMANDO: ...`).

## Selección automática

En `ContextAssembler.build()`:

```js
const serializer = SERIALIZERS[activeProvider] ?? SERIALIZERS.groq;
```

Todos los providers comparten el formato de Groq: `GeminiOpenAISerializer.js` fue eliminado porque
sus clases (`GeminiSerializer`, `OpenAISerializer`) eran no-ops (devolvían `super.serialize()` sin
modificar nada). Las diferencias reales de transporte por proveedor (system_instruction separado en
Gemini, headers de Anthropic, etc.) viven en `LLMProvider`, no en el serializer.

```mermaid
flowchart LR
    PACK["ContextPackage<br/>identidad · SO · memoria · toolIntent"] --> ASM["ContextAssembler.build()"]
    ASM --> G["GroqSerializer<br/>secciones markdown"]
    G --> LLM["LLMProvider.complete()<br/>(transporte por proveedor)"]
```

---

## Verificación

`test_prompt_composer` (38 tests aprox.) cubre: presupuesto de contexto con drop de secciones no
críticas (la identidad es *critical* y nunca se recorta), orden de secciones, formato por proveedor
(markdown / XML / JSON-sections / provider-native) y compatibilidad con `LLMProvider.complete()`.