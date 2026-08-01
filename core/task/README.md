# Detección y ejecución de tareas (`core/task/`)

Pipeline de *tareas* del asistente: decide si un mensaje es una instrucción operativa (algo que ejecutar) o
conversación normal, clasifica el dominio, y mantiene el registro de herramientas disponibles para
ejecutarla. Convive con el sistema de intenciones (`IntentDetector`) sin contaminar el prompt de
identidad con reglas de detección.

---

## `TaskDetector.js` — clasificador de intención operativa

| Campo | Descripción |
|---|---|
| `isTask` | ¿Es una instrucción accionable o solo charla? |
| `domain` | Área de la tarea: code, git, shell, web, filesystem, docker, etc. |
| `confidence` | high / medium / low / none |
| `goal` | Fragmento del texto que disparó la detección |

Filtra saludos, confirmaciones simples y preguntas existenciales antes de entrar en los patrones.
Los dominios están ponderados por peso (code=10, git=10, filesystem=9, shell=8, …); con matching
múltiple gana el mayor peso acumulado y `peso ≥ 20` se considera alta confianza.

## `PlanParser.js` — extracción de planes

Busca bloques ```plan … ``` en la respuesta del LLM y los convierte en pasos con estado (`done`),
con fallback a líneas `- [ ]` / `- [x]`. Devuelve `null` si no hay nada parseable.

## `ToolRegistry.js` — catálogo de herramientas

Registra los schemas de OpenClaw (exec, read, write, edit, apply_patch, code_execution, browser,
web_search) y consulta al `MCPManager` por herramientas externas.

| Método | Propósito |
|---|---|
| `getCatalog(domain?)` | Todas las herramientas, opcionalmente filtradas por dominio |
| `getToolById(id)` | Lookup individual |
| `serializeToPrompt(domain?, maxTools?)` | Bloque de texto del system prompt con formato de uso |
| `setMCPManager / setOpenClawBridge / setLSPManager` | Inyección de fuentes de herramientas |

Las herramientas de alto impacto (`highImpact: true`) marcan la aprobación requerida.

## `ToolResolver.js` — resolución del toolset

Decide, por turno, **qué herramientas ve el LLM** y con qué precedencia (Skill > MCP > OpenClaw):

- Colecciona herramientas de OpenClaw, LSP y MCP.
- **Excluye dominios superpuestos** (MCP excluye OpenClaw; skills excluyen por `replaces_domains`).
- Produce `nativeToolSchemas` (para tool-calling) y `promptCatalog` (texto del system prompt).
- Registra las exclusiones para auditoría.

---

## Cómo se integra

1. `TaskDetector.detect(userMessage)` se llama desde `Core.generatePlan()` antes de armar el contexto.
2. Con tarea detectada, se inyecta `toolIntent` al serializador (GroqSerializer).
3. La respuesta del LLM pasa por `PlanParser.parsePlan()` para extraer pasos.
4. El plan se presenta en la UI (modo task) o se ejecuta directo (modo conversacional).
5. `ToolRegistry.serializeToPrompt()` alimenta el system prompt; `ToolResolver` decide el toolset final.

```mermaid
flowchart LR
    MSG["Mensaje del usuario"] --> TD["TaskDetector<br/>isTask / domain / confidence"]
    TD -->|"es tarea"| TI["toolIntent<br/>inyectado al serializador"]
    TD -->|"no es tarea"| CHAT["Conversación normal"]
    TI --> LLM["LLM"]
    LLM -->|"respuesta"| PP["PlanParser<br/>pasos con estado"]
    PP --> PLAN["Plan en la UI<br/>(modo task)"]
    LLM -->|"herramientas"| RES["ToolResolver<br/>Skill > MCP > OpenClaw"]
    TR["ToolRegistry<br/>catálogo + MCPManager"] --> RES
```

---

## Verificación

`test_tool_precedence` (43), `test_tool_visibility` (18), `test_tools_e2e`, `test_task` y
`test_tool_calling` — ver `tests/README.md`.
