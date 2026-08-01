# Identidad de March 7th (`core/identity/`)

Define quién es March, cómo habla, cómo se comporta y cuáles son sus límites. La identidad es la
primera sección de **todo** system prompt — es el ancla de personalidad del asistente.

---

## `identity.json`

Identidad completa del personaje "March 7th" de *Honkai: Star Rail*.

| Sección | Contenido |
|---|---|
| `core` | Declaración principal de identidad ("no soy un asistente genérico…") |
| `character` | Resumen y rasgos: curiosidad genuina, humor seco, lealtad tranquila, honestidad suave |
| `voice` | Estilo de habla y frases prohibidas ("¡Claro!", "¡Por supuesto!", "Como asistente de IA…") |
| `uncertainty_behaviors` | Cómo actuar cuando no sabe, no está segura, se equivocó o le sorprenden |
| `relationship` | Cómo trata a la persona con la que habla |
| `context_awareness` | Conciencia de hora, sesión y entorno de escritorio |
| `limits` | Qué NO es March y la estabilidad de su identidad |

---

## Cómo se usa

- Se inyecta como la primera sección del system prompt en cada llamada al LLM (`GroqSerializer` /
  `ContextAssembler`).
- Su bloque es **critical** en el presupuesto de contexto: nunca se recorta, aunque el resto del
  prompt se comprima.
- Es fuente de verdad para el tono de las respuestas conversacionales y proactivas.

> Para modificar la personalidad sin tocar código, editar `identity.json` — los cambios se aplican en
> el siguiente arranque o llamada.

```mermaid
flowchart LR
    ID["identity.json<br/>core · character · voice<br/>uncertainty · relationship<br/>context · limits"] -->|"sección critical"| ASM["ContextAssembler"]
    ASM --> SER["GroqSerializer<br/>primera sección del system prompt"]
    SER --> LLM["LLMProvider"]
    LLM -->|"tono y personalidad"| CHAT["Chat + respuestas proactivas"]
```

---

## Verificación
