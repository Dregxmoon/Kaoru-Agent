# Inicialización de base de datos vectorial

Prepara las tablas de índices vectoriales en march.db para la detección semántica de intenciones.

## Archivos

### init_vectors.js 
Inicializa y puebla las tablas vectoriales `intent_catalog` e `intent_vectors` en la base de datos SQLite.

**Tablas:**
- `intent_catalog` — catálogo de frases de referencia para detección de intenciones
- `intent_vectors` — embeddings 384d (all-MiniLM-L6-v2) de cada frase

**Intenciones soportadas (60+ frases):**
| Acción | Ejemplo de frase |
|---|---|
| `read_file` | "muéstrame el contenido de main.js" |
| `edit_file` | "cambia la línea 10 por return true" |
| `run_command` | "ejecuta git status" |
| `web_search` | "busca el clima en Google" |
| `browser` | "abre github.com" |
| `create_file` | "crea un archivo nuevo" |
| `apply_patch` | "aplica este diff" |
| `list_directory` | "qué hay en esta carpeta" |
| `code_execution` | "ejecuta este script de Python" |

**Uso:**
```bash
# Inicialización normal
node infrastructure/database/init_vectors.js

# Reindexar forzado
node infrastructure/database/init_vectors.js --force
```

**Dependencias:** `@xenova/transformers` para embeddings, misma BD de March.
