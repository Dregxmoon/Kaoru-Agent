# Abstracción de proveedores de LLM

Capa que unifica el acceso a diferentes proveedores de modelos de lenguaje con fallback automático.

## Archivos

### LLMProvider.js 
Abstracción sobre proveedores de LLM.

**Proveedores soportados:**
| Proveedor | Modelo rápido | Modelo tareas |
|---|---|---|
| Groq | `llama-3.3-70b-versatile` | `accounts/liquid/liquid-2-120b` (Kimi K2) |
| Gemini | `gemini-2.0-flash-exp` | — |
| OpenAI | `gpt-4o-mini` | — |

**API:**
- `configure(config)` — configura API keys desde config.json
- `getActiveProvider()` — retorna el proveedor actual
- `complete(messages, systemPrompt)` — modo conversacional
- `completeTask(messages, systemPrompt)` — modo tareas (Kimi K2)
- `getModels(mode)` — lista de modelos disponibles para un modo

**Características:**
- Fallback automático: Groq → Gemini → OpenAI
- Reintento exponencial con jitter (hasta 3 intentos por proveedor)
- Límite de 5 fallas consecutivas antes de cambiar de proveedor
- Sin dependencia de API keys externas (las guarda en config.json local)

### GroundingMinimo.js 
Ensamblador de contexto mínimo (legado, Fase 0). Se usa como fallback cuando GroundingEngine no está disponible. Solo incluye: identidad básica, últimos N mensajes, contexto temporal simple (hora, fecha, plataforma).
