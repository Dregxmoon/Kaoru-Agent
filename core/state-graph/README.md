# Memoria persistente (`core/state-graph/`)

Grafo de conocimiento semántico sobre SQLite: hechos sobre el usuario, episodios de conversación,
relaciones entre conceptos, historial de apps y una pila de intenciones — con búsqueda vectorial y
decaimiento temporal. Es la base de la memoria a largo plazo del asistente.

`StateGraph` es una **fachada** que posee el ciclo de vida (init, schema, migraciones, fallback),
la cola de embeddings y delega el resto en `stores/` (ver [`stores/README.md`](./stores/README.md)).

---

## Esquema

| Tabla            | Propósito                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `nodes`          | Hechos sobre el usuario (`User`, `Project`, `Preference`, `Belief`, `Episode`) con `importance`, `decay_rate`, `archived` |
| `node_relations` | Relaciones semánticas `(source_id, target_id, type, created_at)` — `ON DELETE CASCADE`                                    |
| `node_vectors`   | Embeddings 384d para búsqueda semántica — **tabla virtual `vec0`, creada de forma diferida** por `enableVectorSearch()`   |
| `sessions`       | Metadatos de sesiones (inicio, fin, resumen, turnos) + columna `history_json` para persistencia incremental               |
| `app_history`    | Historial de aplicaciones usadas (por día, con duración)                                                                  |
| `intentions`     | Pila de objetivos/planes persistentes (`active` / `done` / `dropped`)                                                     |

**Migración universal:** si la base viene con el esquema legacy de `node_relations`
(`from_id/to_id/rel_type`), se renombra a `node_relations_legacy` y se reinserta con el esquema nuevo
(`source_id/target_id/type`) **antes** de crear índices — sin esto el `CREATE INDEX` fallaba y el
arranque caía a memoria.

---

## Características

- **Decaimiento temporal** — `applyDecay()` (en `DecayStore`): `importance × (1 − decay_rate)^days`,
  archiva nodos con `importance < 0.05` y purga sus vectores. Se ejecuta con un throttle de ~20 h
  (marker `decay_marker.json` en `userData`) desde `SessionManager`.
- **Búsqueda semántica** — `queryNodesSemantic()` (en `VectorIndex`): embeddings en **worker thread**
  (`core/grounding/embedWorker.js` + fachada `EmbedService`, modelo `Xenova/all-MiniLM-L6-v2`, 384d),
  scoring `distanceToSimilarity × importance × recencyBoost` (semivida 21 días). Cae a `queryNodes`
  si el vector no está listo.
- **Fallback a memoria en RAM** si `better-sqlite3` no pudo cargar — el sistema sigue funcionando
  (`usingFallback`, con `fallbackReason`).
- **Acceso diferido a recencia** — `getWorldModel()` **no** toca `last_accessed_at` (se lee en cada
  turno; tocarlo destruiría el decay). `queryNodes`, `getRecentEpisodes` y `queryNodesSemantic` sí
  refrescan recencia.
- **Reconciliación** de información nueva vs. existente (`ContradictionResolver`) con políticas por
  label: `overwrite` · `archive_and_replace` · `append` (máx. 3 segmentos) · `tension` (ambas viven,
  unidas por `CONTRADICES`).
- **Consolidación** — `ConsolidatorStore`: episodios viejos → `Belief`s deterministas
  (`consolidacion_*`, enlace `CONSOLIDA`), piggybacked en `applyDecay()`.

## API pública principal (fachada)

| Función                                                                                                         | Propósito                                                      |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `init()` / `enableVectorSearch()`                                                                               | Abre la BD (o cae a RAM) y activa la tabla vectorial           |
| `createNode(opts)` / `upsertNode(opts)`                                                                         | Guarda un nodo (upsert por tipo+label) y agenda su embedding   |
| `updateNode(id, patch)` / `getNode(id)` / `forget(text)`                                                        | Actualiza / lee / archiva (soft-delete) nodos                  |
| `queryNodes(opts)`                                                                                              | Búsqueda por texto (LIKE), toca recencia                       |
| `queryNodesSemantic(text, opts)`                                                                                | Búsqueda vectorial ponderada por recencia                      |
| `getWorldModel()`                                                                                               | Los 30 nodos de identidad por importancia (sin tocar recencia) |
| `getRecentEpisodes(limit)` / `getLastSessions(limit)`                                                           | Episodios y sesiones recientes                                 |
| `getTensions()`                                                                                                 | Contradicciones vivas (para la curiosidad del motor proactivo) |
| `createRelation({source, target, type})`                                                                        | Relación semántica idempotente                                 |
| `startSession()` / `endSession(id, opts)` / `updateSessionHistory(id, history)` / `findResumableSession(hours)` | Ciclo de vida de sesiones (con `history_json`)                 |
| `saveAppHistory(...)` / `getTodayAppHistory()` / `getAppUsageSummary(days)` / `pruneAppHistory(days)`           | Historial de apps (poda 30 días)                               |
| `applyDecay()`                                                                                                  | Decay + purga de vectores + consolidación                      |
| `createIntention(...)` / `listActiveIntentions()` / `completeIntention()` / `dropIntention()`                   | Pila de intenciones persistentes                               |
| `getStats()` / `close()`                                                                                        | Estado (incluye `usingFallback`) y cierre                      |

## `SessionManager.js` — ciclo de vida de sesión

- `start()` — reanuda una sesión interrumpida (< **48 h**) reusando `sessionId`/historia, o crea una
  nueva; en ambos caminos corre `deduplicateNodes()`, `cleanupMemoryArtifacts()` y el decay si toca.
- `addTurn(role, content)` — agrega turno y persiste incrementalmente (sobrevive a cortes).
- `close()` — procesa la sesión con `StateUpdater` y la cierra; si el procesamiento falla, cierra con
  `summary: null`.
- `restore(history, sessionId)` — soporte de checkpoints (CLI).
- `getActiveIntentions()` — pila de intenciones para re-planeación al reanudar.

## `StateUpdater.js` — extracción de memoria

- `detectAndSaveInstant(userMessage)` — hechos inmediatos **sin LLM** (regex por label: nombre, edad,
  cumpleaños, color, trabajo, proyecto, ubicación, `recordar_…`, `estado_usuario`).
- `processSession(sessionId, history, turnCount)` — extracción con el LLM al cerrar la sesión
  (modo `smart` si > 20 turnos), validación de labels, relaciones `RELATED_TO | IMPLIES | PART_OF |
CONTRADICES | USES` y creación del nodo `Episode` con el resumen.
- Valida labels contra `FIXED_LABELS` + prefijos dinámicos `proyecto_* / preferencia_* / recordar_*`;
  descarta plantillas con `[`/`]`. Exporta `isValidLabel`/`migrateLabel`.
- `cleanupMemoryArtifacts()` — archiva nodos contaminados con salida de comandos.
- `runDecay()` — envuelve `graph.applyDecay()`.

## `ContradictionResolver.js` — reconciliación

| Política              | Comportamiento                                           | Labels típicos                                                 |
| --------------------- | -------------------------------------------------------- | -------------------------------------------------------------- |
| `overwrite`           | Reemplaza el valor anterior                              | nombre, edad, cumpleaños, ubicación, trabajo, proyecto, estado |
| `archive_and_replace` | El viejo se archiva, el nuevo es activo                  | color, música, comida favorita                                 |
| `append`              | Acumula (máx. 3 segmentos, `                             | Actualizado: `)                                                | no reconocidos |
| `tension`             | Contradicción sin resolver → ambas viven + `CONTRADICES` | `observaciones_usuario`                                        |

También: `deduplicateNodes()` (conserva el más reciente por label, respetando tensiones) y
`getTensions()`. Contenido tipo comando se descarta (nunca se guarda).

---

## Ciclo de vida de la memoria

```mermaid
flowchart LR
    subgraph SES["SessionManager"]
        START["start()<br/>reanuda o crea"]
        TURN["addTurn()<br/>persistencia incremental history_json"]
        CLOSE["close()"]
    end
    subgraph UPD["StateUpdater"]
        INSTANT["detectAndSaveInstant<br/>regex, sin LLM"]
        PROCESS["processSession<br/>LLM + relaciones + Episode"]
    end
    GRAPH["StateGraph<br/>nodes + relations + vectors"]
    DECAY["applyDecay()<br/>DecayStore + ConsolidatorStore"]
    Q["queryNodesSemantic()<br/>EmbedService (worker) + recencia"]

    START --> TURN --> CLOSE
    CLOSE --> PROCESS
    TURN --> INSTANT
    INSTANT --> GRAPH
    PROCESS --> GRAPH
    GRAPH --> DECAY
    GRAPH --> Q
```

---

## Verificación

`test_state_graph` (schema, CRUD, reconciliación, decay, sesiones con resume tras crash, guardado
inmediato, recall semántico, limpieza y modo memoria/fallback), `test_persistent`,
`test_memory_f2`, `test_intentions`, `test_sessions_ui` y `test_cli_checkpoint`. Ver
[`tests/README.md`](../../tests/README.md).

Enlaces: [`stores/`](./stores/README.md) (fachadas de BD repartidas por tabla) ·
[`core/core/misc.js`](../core/misc.js) (`getMemoryGaps`, `storeFact`, `isRealIdentityNode`) ·
[`core/grounding/EmbedService.js`](../grounding/EmbedService.js) (embeddings en worker).
