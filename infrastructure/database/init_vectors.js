/**
 * init_vectors.js — Fase 3 (Semántica de Herramientas)
 *
 * Inicializa las tablas de intenciones en march.db y las puebla con
 * embeddings generados localmente via @xenova/transformers
 * (all-MiniLM-L6-v2, 384 dims, ~23MB, corre en CPU sin GPU).
 *
 * Tablas creadas:
 *   intent_catalog   — metadatos de cada intención (action, description, tool)
 *   intent_vectors   — tabla virtual vec0 de sqlite-vec con los embeddings
 *
 * Uso:
 *   node infrastructure/database/init_vectors.js           ← primera vez
 *   node infrastructure/database/init_vectors.js --force   ← repoblar todo
 *
 * El script es IDEMPOTENTE: si las tablas ya existen y tienen datos,
 * no hace nada (a menos que se pase --force).
 *
 * NOTA IMPORTANTE: `embed()` puede llamarse de forma independiente
 * (p.ej. desde el handler `init-vectors` en main.js, que importa solo
 * { INTENT_CATALOG, embed, float32ToBuffer } y nunca llama a main() ni
 * a loadDeps()). Por eso `embed()` carga @xenova/transformers de forma
 * "lazy" la primera vez que se usa, en vez de depender de loadDeps().
 */

'use strict';

// ── Dependencias ──────────────────────────────────────────────────────────────
// Se validan antes de arrancar para dar errores claros al usuario.
let Database, sqliteVec, pipeline;

async function loadDeps() {
  try {
    Database = require('better-sqlite3');
  } catch {
    throw new Error(
      'better-sqlite3 no encontrado. Instálalo con:\n  npm install better-sqlite3'
    );
  }

  try {
    sqliteVec = require('sqlite-vec');
  } catch {
    throw new Error(
      'sqlite-vec no encontrado. Instálalo con:\n  npm install sqlite-vec'
    );
  }

  await loadPipeline();
}

// Carga únicamente @xenova/transformers (lo único que necesita embed()).
// Idempotente: si ya está cargado, no hace nada.
async function loadPipeline() {
  if (pipeline) return pipeline;
  try {
    const transformers = await import('@xenova/transformers');
    pipeline = transformers.pipeline;
  } catch (e) {
    throw new Error(
      '@xenova/transformers no encontrado o falló al cargar. Instálalo con:\n  npm install @xenova/transformers\n  (' + e.message + ')'
    );
  }
  if (typeof pipeline !== 'function') {
    throw new Error('@xenova/transformers se cargó pero "pipeline" no es una función. Revisa la versión instalada del paquete.');
  }
  return pipeline;
}

// ── Ruta de la base de datos ──────────────────────────────────────────────────
const path = require('path');
const DB_PATH = process.argv.find(a => a.startsWith('--db='))?.slice(5)
  ?? path.join(__dirname, '../../data/march.db');

// ── Catálogo de intenciones ───────────────────────────────────────────────────
//
// Cada intención tiene:
//   action      — identificador interno (lo que devuelve el planner)
//   tool        — herramienta de OpenClaw que se usará
//   description — descripción humana (se vectoriza también)
//   phrases     — ejemplos de frases del usuario que expresan esta intención
//                 (cada frase genera un vector independiente apuntando al mismo action)
//
// IMPORTANTE: más frases = mejor cobertura semántica. Se pueden agregar
// más frases en cualquier momento y re-correr con --force.

const INTENT_CATALOG = [
  {
    action: 'create_file',
    tool: 'write',
    description: 'Crear un archivo nuevo en el sistema',
    phrases: [
      'crea un archivo',
      'genera un nuevo archivo',
      'crea el archivo index.js',
      'crea un fichero llamado',
      'haz un archivo nuevo',
      'necesito un archivo nuevo',
      'crea el script principal',
      'genera index.html',
      'create a new file',
      'make a new file called',
      'crea un documento nuevo',
      'escribe el contenido en un archivo nuevo',
    ],
  },
  {
    action: 'edit_file',
    tool: 'edit',
    description: 'Modificar o editar un archivo existente',
    phrases: [
      'modifica el archivo',
      'edita el script',
      'cambia el contenido de',
      'agrega esto al archivo',
      'añade una función al código',
      'reemplaza el texto en',
      'actualiza el archivo',
      'borra esa línea del archivo',
      'inserta esto en el código',
      'modifícame el script principal',
      'cambia la variable en el archivo',
      'refactoriza esta función',
      'edit this file',
      'modify the script',
      'update the code in',
      'añade el import al principio',
      'agrega un comentario al código',
    ],
  },
  {
    action: 'read_file',
    tool: 'read',
    description: 'Leer o mostrar el contenido de un archivo',
    phrases: [
      'lee el archivo',
      'muéstrame el contenido de',
      'abre el archivo',
      'qué dice el archivo',
      'muestra el código de',
      'lee el script',
      'quiero ver el contenido de',
      'imprime el archivo',
      'read the file',
      'show me the contents of',
      'open the file',
      'cuál es el contenido de',
    ],
  },
  {
    action: 'delete_file',
    tool: 'delete_file',
    description: 'Eliminar un archivo del sistema',
    phrases: [
      'borra el archivo',
      'elimina el fichero',
      'quita el archivo',
      'borra ese script',
      'elimina el archivo temporal',
      'delete the file',
      'remove this file',
      'borra el log',
    ],
  },
  {
    action: 'list_directory',
    tool: 'ls',
    description: 'Listar archivos y carpetas de un directorio',
    phrases: [
      'lista los archivos',
      'qué hay en esta carpeta',
      'muéstrame los archivos del proyecto',
      'lista el directorio',
      'qué archivos tengo',
      'muestra la estructura de carpetas',
      'list files',
      'show directory contents',
      'ls de la carpeta',
      'qué hay en src',
    ],
  },
  {
    action: 'create_directory',
    tool: 'mkdir',
    description: 'Crear una nueva carpeta o directorio',
    phrases: [
      'crea la carpeta',
      'crea el directorio',
      'haz una carpeta nueva',
      'crea un directorio llamado',
      'create a folder',
      'make a directory called',
      'necesito una carpeta src',
    ],
  },
  {
    action: 'run_command',
    tool: 'exec',
    description: 'Ejecutar un comando en la terminal',
    phrases: [
      'ejecuta el comando',
      'corre este comando',
      'lanza el script',
      'ejecuta npm test',
      'corre el linter',
      'run this command',
      'execute in terminal',
      'ejecuta en la terminal',
      'corre npm install',
      'ejecuta el servidor',
    ],
  },
  {
    action: 'run_script',
    tool: 'exec',
    description: 'Ejecutar un script de Python, Node u otro lenguaje',
    phrases: [
      'ejecuta el script de python',
      'corre main.py',
      'ejecuta python',
      'lanza el script',
      'run python main.py',
      'ejecuta node index.js',
      'corre el script',
      'ejecuta el programa',
    ],
  },
  {
    action: 'git_action',
    tool: 'exec',
    description: 'Realizar una operación de git',
    phrases: [
      'haz un commit',
      'sube los cambios',
      'push al repositorio',
      'git push',
      'git commit',
      'git pull',
      'haz checkout',
      'crea una rama',
      'merge la rama',
      'git status',
      'git add',
      'commit the changes',
    ],
  },
  {
    action: 'install_package',
    tool: 'exec',
    description: 'Instalar una dependencia o paquete',
    phrases: [
      'instala el paquete',
      'agrega la dependencia',
      'npm install express',
      'instala express',
      'pip install',
      'yarn add',
      'instala la librería',
      'install the package',
      'add dependency',
      'instala axios',
    ],
  },
  {
    action: 'web_search',
    tool: 'web_search',
    description: 'Buscar información en internet',
    phrases: [
      'busca en internet',
      'busca en la web',
      'googlea esto',
      'busca información sobre',
      'qué dice la web sobre',
      'search the web for',
      'look it up online',
      'busca en google',
      'encuentra información de',
      'investiga en internet',
    ],
  },
  {
    action: 'navigate_browser',
    tool: 'browser',
    description: 'Abrir una URL o navegar en el navegador',
    phrases: [
      'abre la página',
      'navega a la URL',
      'abre el navegador',
      've a la página',
      'abre este sitio',
      'open the browser',
      'navigate to',
      'go to the website',
      'abre github.com',
      'visita la página de',
    ],
  },
  {
    action: 'explain_code',
    tool: null,
    description: 'Explicar qué hace un archivo o fragmento de código',
    phrases: [
      'explícame este código',
      'qué hace esta función',
      'cómo funciona este script',
      'explica el archivo',
      'qué significa esta parte',
      'explain this code',
      'what does this function do',
      'analiza el código',
      'revisa el script y explícalo',
    ],
  },
  {
    action: 'answer_question',
    tool: null,
    description: 'Responder una pregunta general o conversar',
    phrases: [
      'cuéntame sobre',
      'qué es esto',
      'cómo funciona',
      'explícame',
      'tengo una pregunta',
      'qué piensas sobre',
      'ayúdame a entender',
      'dime qué es',
      'tell me about',
      'how does this work',
      'what is',
      'hola',
      'buenos días',
      'cómo estás',
    ],
  },
];

// ── Embedder singleton ────────────────────────────────────────────────────────
let _embedder = null;

async function getEmbedder() {
  if (_embedder) return _embedder;

  // Asegura que `pipeline` esté cargado, sin importar quién llame a embed().
  await loadPipeline();

  console.log('[init-vectors] Cargando modelo all-MiniLM-L6-v2...');
  console.log('[init-vectors] Primera carga: ~5-10s. Las siguientes serán instantáneas.');

  _embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
    // Silencia los logs internos del modelo
    progress_callback: (info) => {
      if (info.status === 'downloading') {
        process.stdout.write(`\r[init-vectors] Descargando modelo: ${Math.round(info.progress ?? 0)}%`);
      }
      if (info.status === 'done') {
        process.stdout.write('\n');
      }
    },
  });

  console.log('[init-vectors] Modelo listo.');
  return _embedder;
}

/**
 * Genera un embedding para un texto.
 * Retorna Float32Array de 384 dimensiones.
 * Usa mean pooling + normalización L2 (estándar para sentence-transformers).
 *
 * Puede llamarse de forma totalmente independiente (sin haber llamado a
 * main() ni a loadDeps() antes) — carga lo que necesita por sí misma.
 */
async function embed(text) {
  const embedder = await getEmbedder();
  const output   = await embedder(text, { pooling: 'mean', normalize: true });
  // output.data es Float32Array — sqlite-vec lo acepta directamente
  return output.data;
}

/**
 * Serializa un Float32Array a Buffer para almacenar en sqlite-vec.
 * sqlite-vec espera los vectores como BLOB en formato little-endian float32.
 */
function float32ToBuffer(float32Array) {
  return Buffer.from(float32Array.buffer);
}

// ── Inicialización de tablas ──────────────────────────────────────────────────

function createTables(db) {
  // Tabla de metadatos (SQL normal)
  db.exec(`
    CREATE TABLE IF NOT EXISTS intent_catalog (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      action      TEXT NOT NULL,
      tool        TEXT,
      description TEXT NOT NULL,
      phrase      TEXT NOT NULL,
      created_at  INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_intent_catalog_action
      ON intent_catalog(action);
  `);

  // Tabla virtual de vectores (sqlite-vec)
  // vec0 requiere que el número de dimensiones sea fijo (384 para MiniLM-L6)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS intent_vectors USING vec0(
      embedding float[384]
    );
  `);

  console.log('[init-vectors] Tablas creadas (o ya existían).');
}

function clearTables(db) {
  db.exec(`DELETE FROM intent_catalog;`);
  db.exec(`DELETE FROM intent_vectors;`);
  console.log('[init-vectors] Tablas limpiadas para repoblar.');
}

function hasData(db) {
  try {
    const row = db.prepare('SELECT COUNT(*) as n FROM intent_catalog').get();
    return row.n > 0;
  } catch {
    return false;
  }
}

// ── Población del catálogo ────────────────────────────────────────────────────

async function populateCatalog(db) {
  const insertMeta = db.prepare(`
    INSERT INTO intent_catalog (action, tool, description, phrase)
    VALUES (@action, @tool, @description, @phrase)
  `);
  const insertVector = db.prepare(`
    INSERT INTO intent_vectors (embedding)
    VALUES (?)
  `);

  let totalPhrases = 0;

  for (const intent of INTENT_CATALOG) {
    const allPhrases = [
      intent.description,
      ...intent.phrases,
    ];

    for (const phrase of allPhrases) {
      process.stdout.write(`\r[init-vectors] Vectorizando: "${phrase.slice(0, 50)}..."    `);

      insertMeta.run({
        action:      intent.action,
        tool:        intent.tool ?? null,
        description: intent.description,
        phrase,
      });

      const vector = await embed(phrase);
      insertVector.run(float32ToBuffer(vector));

      totalPhrases++;
    }
  }

  process.stdout.write('\n');
  console.log(`[init-vectors] ${totalPhrases} frases vectorizadas para ${INTENT_CATALOG.length} intenciones.`);
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  const force = process.argv.includes('--force');

  console.log('[init-vectors] Iniciando...');
  console.log(`[init-vectors] Base de datos: ${DB_PATH}`);

  await loadDeps();

  // Asegurar que existe el directorio data/
  const fs = require('fs');
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  const db = new Database(DB_PATH);

  // Cargar extensión sqlite-vec
  sqliteVec.load(db);
  console.log('[init-vectors] sqlite-vec cargado.');

  // Crear tablas si no existen
  createTables(db);

  // Verificar si ya hay datos
  if (hasData(db) && !force) {
    const count = db.prepare('SELECT COUNT(*) as n FROM intent_catalog').get().n;
    console.log(`[init-vectors] Ya existen ${count} frases en el catálogo.`);
    console.log('[init-vectors] Usa --force para repoblar desde cero.');
    db.close();
    return;
  }

  if (force) clearTables(db);

  // Poblar con embeddings
  await populateCatalog(db);

  db.close();
  console.log('[init-vectors] ✓ Catálogo listo.');
}

// Ejecutar si se llama directamente
if (require.main === module) {
  main().catch((e) => {
    console.error('[init-vectors] ERROR FATAL:', e.message);
    process.exit(1);
  });
}

module.exports = { main, embed, float32ToBuffer, INTENT_CATALOG, DB_PATH, loadDeps, loadPipeline };