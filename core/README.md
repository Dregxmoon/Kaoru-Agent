# Orquestación principal

Capa central del sistema. Inicializa, conecta y orquesta todos los subsistemas de inteligencia, memoria y ejecución.

## Archivos

### MarchCore.js
Archivador central e inicializador de todos los subsistemas. Su función `init()` arranca StateGraph, GroundingEngine, SessionManager, IntentDetector, BehaviorModel, ProactiveEngine y los conecta al EventBus.

**Responsabilidades:**
- Seleccionar el sensor de SO adecuado según `process.platform` (win32 → OSSensor, linux → LinuxOSSensor)
- Inicializar carga vectorial (sqlite-vec) y backfill de embeddings
- Conectar el sensor con GroundingEngine, InitiativeEngine y ProactiveEngine
- Inyectar las secciones de herramientas OpenClaw y MCP en el system prompt
- Cargar configuración LLM y MCP desde config.json

**API pública:**
| Función | Propósito |
|---|---|
| `init(app)` | Inicializa todo el sistema |
| `shutdown()` | Cierre ordenado (desconecta MCP, browser, sensor) |
| `startSession()` | Inicia sesión de conversación |
| `closeSession()` | Cierra sesión y extrae memoria |
| `addTurn(role, content)` | Agrega turno al historial |
| `buildContext(history, provider)` | Ensambla contexto completo para el LLM |
| `getOSSensor()` | Retorna el sensor de SO activo |

### Módulos hijos

| Carpeta | Propósito |
|---|---|
| `behavior/` | Modelo de comportamiento y proactividad autónoma |
| `grounding/` | Pipeline de ensamblado de contexto para el LLM |
| `identity/` | Personalidad de March 7th |
| `llm/` | Abstracción de proveedores de LLM |
| `mcp/` | Cliente Model Context Protocol |
| `planner/` | Parseo y ejecución de acciones |
| `prompt-composer/` | (eliminado — era dead code; el pipeline real usa GroqSerializer) |
| `state-graph/` | Grafo de conocimiento persistente (SQLite) |
