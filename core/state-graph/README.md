# Memoria persistente

Grafo de conocimiento semántico sobre SQLite. Almacena hechos sobre el usuario, episodios de conversación y relaciones entre conceptos.

## Archivos

### StateGraph.js 
Núcleo de la base de datos. Usa `better-sqlite3` + `sqlite-vec`.

**Tablas principales:**
| Tabla | Propósito |
|---|---|
| `nodes` | Hechos sobre el usuario (proyectos, preferencias, datos personales) |
| `node_relations` | Relaciones semánticas entre nodos |
| `node_vectors` | Embeddings 384d para búsqueda semántica |
| `sessions` | Metadatos de sesiones (inicio, fin, resumen, turnos) |
| `episodes` | Resúmenes de sesiones cerradas |
| `app_history` | Historial de aplicaciones usadas |

**Características:**
- Decaimiento temporal: nodos viejos se archivan automáticamente
- Búsqueda semántica por similitud coseno con ponderación por recencia
- Fallback a MemoryDB (RAM) si `better-sqlite3` no cargó
- Lazy access-time update: los nodos existentes no se marcan como viejos al leerlos

**API pública:**
| Función | Propósito |
|---|---|
| `startSession()` | Crea nueva sesión |
| `endSession(id, data)` | Cierra sesión con resumen |
| `updateSessionHistory(id, history)` | Persiste historial incremental |
| `findResumableSession(hours)` | Busca sesiones interrumpidas |
| `saveNode(node)` | Guarda un nodo de conocimiento |
| `queryNodesSemantic(text, limit)` | Búsqueda semántica por embeddings |
| `enableVectorSearch()` | Activa búsqueda vectorial |
| `backfillEmbeddings()` | Genera embeddings para nodos sin ellos |
| `runDecay()` | Archiva nodos viejos |

### SessionManager.js 
Gestiona el ciclo de vida de una sesión de conversación.

- `start()` — Crea sesión nueva y limpia duplicados acumulados
- `addTurn(role, content)` — Agrega turno y persiste incrementalmente
- `close()` — Procesa la sesión con StateUpdater y la marca como cerrada
- `getHistory()` — Retorna copia del historial actual

### StateUpdater.js 
Al cerrar una sesión, extrae hechos memorables de la conversación usando el LLM y los guarda como nodos en el grafo.

- `processSession(sessionId, history, turnCount)` — Procesa sesión completa
- `detectAndSaveInstant(userMessage)` — Guarda hechos inmediatos (sin LLM)
- `runDecay()` — Ejecuta decaimiento de nodos viejos
- Valida labels contra un conjunto fijo + labels dinámicos de proyectos/preferencias

### ContradictionResolver.js 
Resuelve conflictos entre información nueva y nodos existentes en el grafo.

**Políticas por tipo de label:**
| Política | Comportamiento | Ejemplos |
|---|---|---|
| `OVERWRITE` | Reemplaza valor anterior | `age`, `name`, `hometown` |
| `APPEND` | Acumula (con límite) | `likes`, `favorite_games` |
| `ARCHIVE` | Viejo se archiva, nuevo es activo | `project`, `working_on` |
| `TENSION` | Contradicción sin resolver | Datos irreconciliables |

La política se determina por el label del nodo. Labels no reconocidos van a `APPEND`.
