# Ejecución de acciones

Interpreta las intenciones del LLM y las ejecuta como acciones reales en el sistema del usuario.

## Archivos

### Planner.js 
Toma la respuesta del LLM y decide qué ejecutar. Analiza texto narrativo buscando bloques de acción (````action ... ````).

**Flujo completo:**
1. Parseo de intenciones de la respuesta del LLM (ActionParser interno)
2. Clasificación de impacto (bajo → automático, alto → requiere aprobación)
3. Sanitización de rutas y comandos
4. Bloqueo de rutas sensibles (~/.ssh, credenciales, cookies de navegador)
5. Ejecución a través de OpenClawBridge o BrowserBridge

**Acciones soportadas:**
| Acción | Requiere aprobación |
|---|---|
| `read` / `read_file` | No |
| `list_directory` | No |
| `edit` / `write` / `create_file` | Sí |
| `exec` / `run_command` | Sí |
| `browser` / `web_search` | Sí |
| `apply_patch` | Sí |
| `code_execution` | Sí |

### StructuredActionParser.js 
Parser determinista para bloques de acción estructurados. Cuando el IntentDetector detecta toolIntent con alta confianza, el GroqSerializer inyecta instrucciones para que el LLM responda con formato exacto:
```action
ACCIÓN: create_file | ARCHIVO: main.js
```

Este parser extrae esos datos. Si no encuentra bloque estructurado, delega al parser regex del Planner.

### OpenClawBridge.js 
Puente HTTP al servicio OpenClaw (localhost:18789) o al mock local (`mock-openclaw.js`).

**Ruteo de acciones:**
- `exec` / `read` / `write` / `edit` / `list_directory` → OpenClaw API
- `browser` / `web_search` → BrowserBridge (Playwright)
- `apply_patch` / `code_execution` → OpenClaw

Verifica disponibilidad del servicio cada 30 segundos. Reporta tool availability al ProactiveEngine.

### BrowserBridge.js 
Navegador Chromium headless propio mantenido con Playwright. Sesión persistente para:
- Navegación web y lectura de páginas
- Capturas de pantalla
- Búsqueda en Google/Bing sin API key
- Independiente del navegador personal del usuario
