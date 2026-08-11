# Stores del grafo (`core/state-graph/stores/`)

Fachadas de BD repartidas por tabla. `StateGraph` (ver
[`core/state-graph/README.md`](../README.md)) les delega el acceso a `data/core.db`; `constants.js`
centraliza tipos, tasas y umbrales.

## Piezas

| Store               | Tabla                      | Responsabilidad                                                                                                              |
| ------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `NodeStore`         | `nodes`                    | CRUD de nodos (User/Episode/Belief/Preference/Project), `importance`, `decay_rate` por tipo, tags y **agenda de embeddings** |
| `SessionStore`      | `sessions`                 | CRUD de sesiones: inicio/fin, resumen, turnos, enlace a episodio, `history_json`, últimas N                                  |
| `AppHistoryStore`   | `app_history`              | Persistencia/consulta del uso de apps (app, title, category, duration, day)                                                  |
| `IntentionsStore`   | `intentions`               | Pila de objetivos persistentes (active/done/dropped); las tareas retomadas se re-inyectan al prompt                          |
| `VectorIndex`       | `node_vectors`             | Recall semántico vía `sqlite-vec` (384-d); cae a búsqueda LIKE si el vector no está disponible                               |
| `DecayStore`        | `nodes` + `vec`            | Aplica el decaimiento exponencial por tipo y archiva nodos bajo el umbral                                                    |
| `ConsolidatorStore` | `nodes` + `node_relations` | Consolidación determinista: episodios viejos → `Belief` `consolidacion_<término>` con enlaces `CONSOLIDA`                    |
| `FactReasonerStore` | `nodes`                    | Vigencia de hechos fijos (F3.1): taggea `stale` los `FIXED_LABELS` pasados de `STALENESS_DAYS` y propaga `CASCADE_STALENESS` |

## `constants.js`

`NODE_TYPES`, `DECAY_RATES`, `ARCHIVE_THRESHOLD`, `RECENCY_HALFLIFE_DAYS`, `SEMANTIC_CANDIDATES`,
`_formatSec`.

Verificación: parte de `test_state_graph`, `test_persistent`, `test_intentions`, `test_memory_f2` y
`test_fact_reasoner`.
