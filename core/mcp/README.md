# Model Context Protocol

Cliente MCP que permite conectar servidores externos de herramientas a March.

## Archivos

### MCPManager.js 
Gestiona el ciclo de vida completo de servidores MCP conectados vía `npx -y <paquete>` (stdio).

**Responsabilidades:**
- Conectar servidores MCP por nombre (desde registro oficial o configuración manual)
- Reconexión automática con backoff exponencial tras fallos
- Namespacing de herramientas por servidor (ej: `filesystem:list_directory`)
- Listar herramientas disponibles de todos los servidores conectados
- Búsqueda en el registro oficial de servidores MCP
- Desconexión ordenada al cerrar la app

**API:**
| Función | Propósito |
|---|---|
| `init(servers)` | Inicializa servidores desde config.json |
| `addServer(serverCfg)` | Agrega y conecta un nuevo servidor |
| `removeServer(id)` | Desconecta y elimina un servidor |
| `toggleServer(id, enabled)` | Activa/desactiva sin eliminar |
| `listServers()` | Lista servidores con estado |
| `listAllTools()` | Lista herramientas de todos los servidores |
| `hasConnectedServers()` | ¿Hay algún servidor conectado? |
| `searchRegistry(query)` | Busca servidores en el registro oficial |
| `disconnectAll()` | Desconecta todos |

**Independencia:** Si no hay servidores configurados, March funciona exactamente igual. Las herramientas MCP se inyectan como un bloque separado en el system prompt, después del contexto del SO y antes de las instrucciones finales.
