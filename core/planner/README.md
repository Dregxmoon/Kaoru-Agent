# Ejecución de acciones y agente (`core/planner/`)

Interpreta las intenciones del LLM y las ejecuta como acciones reales en el sistema del usuario — con
control de impacto, confinamiento de rutas y aprobación explícita para lo que toca el disco o la red.

---

## `Planner.js` — orquestador de ejecución

Analiza la respuesta del LLM en busca de bloques de acción (````action ... ````) y decide qué ejecutar:

1. Parseo de intenciones (`ActionParser`).
2. Clasificación de impacto (bajo → automático, alto → requiere aprobación).
3. Sanitización de rutas y comandos.
4. Bloqueo de rutas sensibles (`~/.ssh`, credenciales, cookies de navegador).
5. Ejecución a través de `OpenClawBridge` o `BrowserBridge`.

## `AgentLoop.js` — bucle agente (LLM → herramienta → resultado)

El modo `task`/`agent` ejecuta un bucle cerrado:

```mermaid
sequenceDiagram
    participant U as Usuario
    participant A as AgentLoop
    participant LLM as LLM (tool-calling)
    participant T as Herramienta (OpenClaw/MCP/Browser)

    U->>A: mensaje con intención de acción
    loop hasta tope de iteraciones (8–25)
        A->>LLM: prompt + toolset resuelto (Skill > MCP > OpenClaw)
        LLM-->>A: toolCall nativo
        alt acción de alto impacto
            A->>U: solicita aprobación (fail-closed)
            U-->>A: aprobada / denegada
        end
        A->>T: ejecuta acción real
        T-->>A: resultado real
        A->>LLM: resultado → siguiente paso
    end
    LLM-->>A: texto final
    A-->>U: respuesta
```

- **Tool-calling nativo primero** (`completeWithTools`), con fallback textual si falla el parseo o el
  proveedor.
- **Aprobación** para acciones de alto impacto (con handler y timeout *fail-closed*).
- **Límite de iteraciones** configurable (8–25) y resultado truncado para el contexto.
- **Resolución de herramientas** (Skill > MCP > OpenClaw) inyectada en el prompt.

## `StructuredActionParser.js`

Parser determinista para bloques de acción estructurados:

```
ACCIÓN: create_file | ARCHIVO: main.js
```

Con fallback al parser regex del `Planner` si el modelo no usa el formato estructurado.

## `OpenClawBridge.js` — puente de ejecución

- `exec` / `read` / `write` / `edit` / `list_directory` → servicio OpenClaw (localhost) o mock local.
- `browser` / `web_search` → `BrowserBridge` (Playwright, navegador propio del asistente).
- `apply_patch` / `code_execution` → OpenClaw.
- Verifica disponibilidad del servicio cada 30 s y reporta disponibilidad al motor proactivo.

## `BrowserBridge.js` — navegador headless propio

Navegador Chromium headless mantenido con Playwright, **separado del navegador personal del usuario**:
navegación, lectura de páginas, capturas de pantalla y búsqueda web sin API key.

---

## Matriz de acciones e impacto

| Acción | Requiere aprobación |
|---|---|
| `read` / `read_file` | No |
| `list_directory` | No |
| `edit` / `write` / `create_file` | Sí |
| `exec` / `run_command` | Sí |
| `browser` / `web_search` | Sí |
| `apply_patch` | Sí |
| `code_execution` | Sí |

---

## Verificación

`test_agent_loop` (38) y `test_agent_loop_mode` (14): loop, adaptación a resultados reales, límite de
iteraciones, aprobaciones, *fail-closed* y tool-calling nativo. `test_tools_e2e`, `test_openclaw_*` y
`test_server_security`: puentes y seguridad. Ver `tests/README.md`.
