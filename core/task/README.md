# core/task — Detección, planificación y ejecución de tareas

Este módulo implementa el pipeline de "tareas" de March: decide si un mensaje
del usuario es una instrucción operativa (algo que ejecutar) o una conversación
normal, clasifica el dominio, y mantiene un registro de las herramientas
disponibles para ejecutarla.

Convive con el viejo sistema de intenciones (IntentDetector/GroqSerializer)
pero no lo reemplaza del todo — la parte de *tasks* se lleva aparte para no
contaminar el prompt de la identidad con decenas de reglas de detección.

## Archivos

### TaskDetector.js — Clasificador de intención operativa

Toma un texto y devuelve:

- `isTask`: si es una instrucción accionable o solo charla
- `domain`: el área (code, git, shell, web, filesystem, docker, etc.)
- `confidence`: qué tan seguro está del match (high/medium/low/none)
- `goal`: fragmento del texto que disparó la detección

Filtra saludos, confirmaciones simples y preguntas existenciales antes de
entrar en los patrones, para no mandar "hola" al planificador como si fuera
una tarea. Los dominios están ponderados por peso (code=10, git=10,
filesystem=9, shell=8, etc.) y si hay matching múltiple, gana el de mayor
peso acumulado. Si el peso total es >= 20 se considera alta confianza.

### PlanParser.js — Extracción de planes desde respuestas del LLM

Busca bloques delimitados con ```plan ... ``` en la respuesta del LLM y los
convierte en una estructura de pasos con estado (done/false). Si no encuentra
bloques con delimitador, hace un fallback buscando líneas sueltas con el
formato `- [ ] descripción` o `- [x] descripción`. Devuelve `null` si no hay
nada parseable.

### ToolRegistry.js — Catálogo de herramientas disponibles

Registra los schemas de OpenClaw (exec, read, write, edit, apply_patch,
code_execution, browser, web_search) y consulta al MCPManager por herramientas
externas. Tiene métodos para:

- `getCatalog(domain?)`: todas las herramientas, opcionalmente filtradas por
  dominio
- `getToolById(id)`: lookup individual
- `serializeToPrompt(domain?, maxTools?)`: genera el bloque de texto plano que
  se inyecta en el system prompt del LLM, con formato de uso y reglas

Las herramientas de alto impacto (write, edit, code_execution, etc.) tienen
`highImpact: true` para que el planificador sepa que debe pedir confirmación.

## Cómo se integra

1. `TaskDetector.detect(userMessage)` se llama desde `MarchCore.generatePlan()`
   antes de armar el contexto del LLM.
2. Si detecta una tarea con suficiente confianza, se inyecta `toolIntent` en
   el serializador (GroqSerializer) para que el LLM vea el dominio y la
   intención.
3. La respuesta del LLM pasa por `PlanParser.parsePlan()` para extraer pasos
   estructurados.
4. El plan extraído se presenta al usuario en la UI (modo task) o se ejecuta
   directo (modo conversacional).
5. `ToolRegistry.serializeToPrompt()` alimenta el system prompt con lo que el
   LLM puede ejecutar y cómo pedirlo.
