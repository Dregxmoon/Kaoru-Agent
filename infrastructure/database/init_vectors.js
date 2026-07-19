/**
 * init_vectors.js — Fase 3 (Semántica de Herramientas) — v2
 *
 * Inicializa las tablas de intenciones en march.db y las puebla con
 * embeddings generados localmente via @xenova/transformers
 * (all-MiniLM-L6-v2, 384 dims, ~23MB, corre en CPU sin GPU).
 *
 * Tablas creadas:
 *   intent_catalog   — metadatos de cada intención (action, description, tool)
 *   intent_vectors   — tabla virtual vec0 de sqlite-vec con los embeddings
 *
 * ════════════════════════════════════════════════════════════════════════
 * CAMBIOS v2 — más completo, versátil y evolutivo
 * ════════════════════════════════════════════════════════════════════════
 *
 * 1. FIX DE CORRECCIÓN — desalineación de rowid (bug latente, no reportado
 *    pero real): `intent_catalog.id` es INTEGER PRIMARY KEY AUTOINCREMENT,
 *    así que sus IDs NUNCA se reutilizan aunque se borren filas. Pero
 *    `intent_vectors` es una tabla virtual vec0 SIN AUTOINCREMENT — tras un
 *    `DELETE FROM intent_vectors` + repoblado (lo que hace `--force`), su
 *    rowid implícito vuelve a empezar desde 1. Resultado: después de un
 *    `--force`, `intent_catalog.id` y `intent_vectors.rowid` se desalinean
 *    silenciosamente, y cualquier JOIN `ON ic.id = iv.rowid` (lo que hace
 *    IntentDetector para traducir un vecino encontrado de vuelta a su
 *    action/tool/phrase) puede devolver metadata de la frase EQUIVOCADA sin
 *    lanzar ningún error. v2 ya no depende del rowid implícito: inserta
 *    explícitamente `intent_vectors.rowid = intent_catalog.id` en cada
 *    inserción (population masiva y `addPhrase` incremental), garantizando
 *    alineación sin importar cuántas veces se repueble.
 *
 * 2. CATÁLOGO PERSONALIZABLE SIN TOCAR CÓDIGO — se puede crear un archivo
 *    `infrastructure/database/intents.custom.json` (o pasar
 *    --custom=ruta/al/archivo.json) con intenciones propias del proyecto.
 *    Se fusiona con el catálogo incorporado: si la `action` ya existe, se
 *    le agregan las frases nuevas (sin duplicar); si es nueva, se agrega
 *    completa. Formato esperado — un array de objetos:
 *      [{ "action": "mi_accion", "tool": "mi_tool", "description": "...",
 *         "phrases": ["frase 1", "frase 2"] }]
 *
 * 3. DOS INTENCIONES QUE FALTABAN — `code_execution` y `apply_patch` ya
 *    existen como ACTION_PATTERNS reales en Planner.js (ActionParser) pero
 *    no tenían ninguna entrada en el catálogo de intenciones — es decir,
 *    el detector semántico nunca podía anticiparlas. Se agregaron.
 *
 * 4. ADICIÓN INCREMENTAL — `addPhrase(db, action, phrase, opts)` agrega
 *    UNA frase nueva (con su embedding) sin repoblar todo el catálogo.
 *    Pensado para un flujo evolutivo: cuando el IntentDetector falla en
 *    producción con una frase real del usuario, se puede agregar esa frase
 *    exacta al catálogo con `node init_vectors.js --add-phrase="read_file:enséñame qué trae el archivo"`
 *    sin perder ni re-vectorizar nada existente.
 *
 * 5. DIAGNÓSTICO — `verifyIntegrity(db)` detecta si las tablas quedaron
 *    desincronizadas (por ejemplo, por una versión anterior de este mismo
 *    archivo). `getStats(db)` da un resumen de cobertura por acción.
 *    `testDetect(db, frase)` corre una búsqueda KNN real contra
 *    intent_vectors desde la CLI, sin levantar toda la app — útil para
 *    probar si una frase nueva se reconoce bien antes de agregarla.
 *
 * 6. LÓGICA COMPARTIDA — `populateDatabase(db, opts)` encapsula el flujo
 *    completo (crear tablas → revisar si hay datos → poblar) en una sola
 *    función reutilizable. El handler `init-vectors` en main.js puede
 *    llamar a esto directamente en vez de duplicar ~30 líneas de SQL
 *    (que además no tenían el fix de rowid de arriba).
 *
 * Uso desde CLI:
 *   node init_vectors.js                                   ← primera vez
 *   node init_vectors.js --force                            ← repoblar todo
 *   node init_vectors.js --custom=./mis-intenciones.json     ← + catálogo propio
 *   node init_vectors.js --stats                            ← resumen de cobertura
 *   node init_vectors.js --verify                           ← chequeo de integridad
 *   node init_vectors.js --test="que hay en mi escritorio"   ← prueba de detección
 *   node init_vectors.js --add-phrase="read_file:enséñame el archivo"
 *
 * El script sigue siendo IDEMPOTENTE: si las tablas ya existen y tienen
 * datos, `main()` no hace nada (a menos que se pase --force).
 *
 * NOTA: `embed()` puede llamarse de forma independiente (p.ej. desde un
 * handler de Electron que importa solo { embed, float32ToBuffer } y nunca
 * llama a main() ni a loadDeps()). Por eso `embed()` carga
 * @xenova/transformers de forma "lazy" la primera vez que se usa.
 */

'use strict';

// ── Dependencias ──────────────────────────────────────────────────────────────
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

// ── Rutas ─────────────────────────────────────────────────────────────────────
const path = require('path');
const fs   = require('fs');

const DB_PATH = process.argv.find(a => a.startsWith('--db='))?.slice(5)
  ?? path.join(__dirname, '../../data/march.db');

const CUSTOM_CATALOG_PATH = process.argv.find(a => a.startsWith('--custom='))?.slice('--custom='.length)
  ?? path.join(__dirname, 'intents.custom.json');

// ── Catálogo incorporado de intenciones ───────────────────────────────────────
//
// Cada intención tiene:
//   action      — identificador interno (lo que devuelve el planner)
//   tool        — herramienta de OpenClaw que se usará (o null si es
//                 puramente conversacional, sin acción real)
//   description — descripción humana (se vectoriza también)
//   phrases     — ejemplos de frases del usuario que expresan esta intención
//                 (cada frase genera un vector independiente apuntando al
//                 mismo action)
//
// IMPORTANTE: más frases = mejor cobertura semántica. Se pueden agregar
// más frases en cualquier momento y re-correr con --force, o agregar una
// frase suelta en caliente con --add-phrase (ver cabecera del archivo).

const BUILTIN_INTENT_CATALOG = [
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
      'crea un archivo de texto con',
      'arma un archivo nuevo llamado',
      'genera un archivo .json con',
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
      'modifícame el script',
      'modifícame el archivo',
      'modifícame el código',
      'modifícame el proyecto',
      'hazme cambios en el script',
      'hazme cambios en el archivo',
      'corrige este archivo',
      'arregla el bug en',
      'cambia esta función para que',
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
      'enséñame qué trae el archivo',
      'puedes mostrarme lo que tiene',
      'qué hay dentro de',
      'pásame el contenido de',
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
      'deshazte del archivo',
      'tira ese archivo a la basura',
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
      'qué carpetas tengo aquí',
      'enséñame el árbol de archivos',
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
      'arma una carpeta para',
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
      'corre esto en consola',
      'ejecuta en bash',
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
      'corre el archivo .py',
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
      'sube esto a github',
      'revisa el estado del repo',
      'haz un pull request',
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
      'agrega esta librería al proyecto',
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
      'fíjate en internet qué dice sobre',
      'busca noticias sobre',
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
      'ábreme esa web',
    ],
  },
  // ── NUEVO v2: faltaban en el catálogo aunque ya existían como
  // ACTION_PATTERNS reales en Planner.js — el detector nunca podía
  // anticiparlas porque no tenían ninguna frase de ejemplo asociada.
  {
    action: 'code_execution',
    tool: 'code_execution',
    description: 'Ejecutar un fragmento de código suelto (no un archivo)',
    phrases: [
      'ejecuta este código',
      'corre este código python',
      'ejecuta este snippet',
      'corre este pedazo de código',
      'qué resultado da este código',
      'run this code',
      'execute this python snippet',
      'prueba este código a ver qué hace',
    ],
  },
  {
    action: 'apply_patch',
    tool: 'apply_patch',
    description: 'Aplicar un parche (diff) a un archivo existente',
    phrases: [
      'aplica este patch',
      'aplica este diff al archivo',
      'aplica este parche a',
      'apply this patch to',
      'aplica estos cambios al archivo',
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
      'descríbeme qué hace este archivo',
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

// ── Catálogo personalizado (opcional, externo) ────────────────────────────────

function _loadCustomCatalog(customPath = CUSTOM_CATALOG_PATH) {
  try {
    if (!fs.existsSync(customPath)) return [];
    const raw    = fs.readFileSync(customPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.warn(`[init-vectors] ${customPath} no es un array — se ignora.`);
      return [];
    }
    console.log(`[init-vectors] catálogo personalizado cargado: ${customPath} (${parsed.length} entradas)`);
    return parsed;
  } catch (e) {
    console.warn(`[init-vectors] error leyendo catálogo personalizado (${customPath}): ${e.message}`);
    return [];
  }
}

/**
 * Fusiona el catálogo incorporado con uno externo. Si una `action` del
 * catálogo externo ya existe en el incorporado, sus frases se AGREGAN
 * (no se reemplaza la entrada completa) y `tool`/`description` del
 * externo tienen prioridad si vienen definidos. Si la `action` es nueva,
 * se agrega completa. Se trimea y deduplica cada lista de frases
 * (case-insensitive) al final, así que entradas con espacios sueltos o
 * repetidas accidentalmente (typos de copy-paste) no generan basura ni
 * embeddings duplicados.
 */
function _mergeCatalogs(base, extra) {
  const byAction = new Map();
  for (const intent of base) {
    byAction.set(intent.action, { ...intent, phrases: [...intent.phrases] });
  }
  for (const intent of extra) {
    if (!intent || typeof intent.action !== 'string' || !Array.isArray(intent.phrases)) {
      console.warn('[init-vectors] entrada inválida en catálogo personalizado, se ignora:', intent);
      continue;
    }
    if (byAction.has(intent.action)) {
      const existing = byAction.get(intent.action);
      existing.phrases.push(...intent.phrases);
      if (intent.tool !== undefined) existing.tool = intent.tool;
      if (intent.description) existing.description = intent.description;
    } else {
      byAction.set(intent.action, {
        action:      intent.action,
        tool:        intent.tool ?? null,
        description: intent.description || intent.action,
        phrases:     [...intent.phrases],
      });
    }
  }
  for (const intent of byAction.values()) {
    const seen = new Set();
    intent.phrases = intent.phrases
      .map(p => (p || '').trim())
      .filter(p => p.length > 0)
      .filter(p => {
        const key = p.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }
  return [...byAction.values()];
}

/**
 * Devuelve el catálogo efectivo: incorporado + personalizado (si existe).
 * Se puede llamar con una ruta distinta a CUSTOM_CATALOG_PATH para testear
 * un catálogo externo sin tocar el archivo por defecto.
 */
function getIntentCatalog(customPath = CUSTOM_CATALOG_PATH) {
  const custom = _loadCustomCatalog(customPath);
  return _mergeCatalogs(BUILTIN_INTENT_CATALOG, custom);
}

// Catálogo efectivo cargado al importar el módulo — mantiene compatibilidad
// con código existente que hace `const { INTENT_CATALOG } = require(...)`.
const INTENT_CATALOG = getIntentCatalog();

// ── Embedder singleton ────────────────────────────────────────────────────────
let _embedder = null;

async function getEmbedder() {
  if (_embedder) return _embedder;

  await loadPipeline();

  console.log('[init-vectors] Cargando modelo all-MiniLM-L6-v2...');
  console.log('[init-vectors] Primera carga: ~5-10s. Las siguientes serán instantáneas.');

  _embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
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
 * Genera un embedding para un texto. Retorna Float32Array de 384
 * dimensiones. Usa mean pooling + normalización L2 (estándar para
 * sentence-transformers). Puede llamarse de forma totalmente independiente
 * (sin haber llamado a main() ni a loadDeps() antes).
 */
/**
 * FIX — antes esto SIEMPRE cargaba su propio pipeline de
 * @xenova/transformers, independiente del que ya carga IntentDetector.js
 * (_getEmbedder(), ver ese archivo). Como main.js SÍ importa este módulo
 * en caliente (el handler IPC 'init-vectors' — el mismo que usas para
 * repoblar el catálogo con `ipcRenderer.invoke('init-vectors')` sin
 * reiniciar la app), terminaban conviviendo DOS copias del modelo
 * (~23MB + el overhead del runtime de ONNX) en el mismo proceso — en un
 * equipo de 8GB de RAM, memoria que no hace falta gastar dos veces.
 *
 * Ahora intenta reusar IntentDetector.embedText() primero (mismo
 * singleton, se comparte sin importar quién lo haya cargado primero) y
 * solo si eso falla —p.ej. corriendo standalone y ese archivo no está
 * disponible por alguna razón— cae a cargar su propio pipeline, igual
 * que antes.
 */
let _useSharedEmbedder = null; // null = sin determinar, true/false tras el primer intento

async function embed(text) {
  if (_useSharedEmbedder !== false) {
    try {
      const IntentDetector = require('../../core/grounding/IntentDetector.js');
      if (typeof IntentDetector.embedText === 'function') {
        _useSharedEmbedder = true;
        return await IntentDetector.embedText(text);
      }
    } catch (e) {
      console.warn('[init-vectors] no se pudo reusar el embedder de IntentDetector.js, usando pipeline propio:', e.message);
    }
    _useSharedEmbedder = false;
  }

  const embedder = await getEmbedder();
  const output   = await embedder(text, { pooling: 'mean', normalize: true });
  return output.data;
}

/**
 * Serializa un Float32Array a Buffer para almacenar en sqlite-vec.
 */
function float32ToBuffer(float32Array) {
  return Buffer.from(float32Array.buffer);
}

// ── Tablas ────────────────────────────────────────────────────────────────────

function createTables(db) {
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

    -- FIX v2: evita duplicados exactos a nivel de base de datos, además
    -- del dedup en memoria que ya hace _mergeCatalogs(). Esto protege
    -- específicamente contra llamadas repetidas a addPhrase() con la
    -- misma frase para la misma acción.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_intent_catalog_unique
      ON intent_catalog(action, phrase);
  `);

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

/**
 * Puebla intent_catalog + intent_vectors a partir de un catálogo dado.
 *
 * FIX v2 — rowid explícito: cada fila de intent_vectors se inserta con
 * `rowid = id` de la fila de intent_catalog que se acaba de insertar
 * (capturado vía `lastInsertRowid`), en vez de dejar que sqlite-vec asigne
 * su propio rowid implícito. Esto es lo que garantiza que
 * `JOIN intent_vectors iv ON iv.rowid = intent_catalog.id` siempre
 * apunte a la fila correcta, incluso después de varios --force.
 *
 * `INSERT OR IGNORE` + revisar `changes` evita re-vectorizar (llamada
 * cara al modelo) una frase que ya existe exactamente igual para la misma
 * acción — relevante sobre todo cuando se mezcla un catálogo personalizado
 * que repite frases del incorporado.
 */
async function populateCatalog(db, catalog = INTENT_CATALOG) {
  const insertMeta = db.prepare(`
    INSERT OR IGNORE INTO intent_catalog (action, tool, description, phrase)
    VALUES (@action, @tool, @description, @phrase)
  `);
  const insertVector = db.prepare(`
    INSERT INTO intent_vectors (rowid, embedding)
    VALUES (?, ?)
  `);

  let totalPhrases = 0;
  let totalSkipped = 0;

  for (const intent of catalog) {
    const allPhrases = [intent.description, ...intent.phrases]
      .map(p => (p || '').trim())
      .filter(Boolean);

    for (const phrase of allPhrases) {
      process.stdout.write(`\r[init-vectors] Vectorizando: "${phrase.slice(0, 50)}..."    `);

      const info = insertMeta.run({
        action:      intent.action,
        tool:        intent.tool ?? null,
        description: intent.description,
        phrase,
      });

      if (info.changes === 0) {
        // Ya existía esta (action, phrase) exacta — no se re-vectoriza.
        totalSkipped++;
        continue;
      }

      const vector = await embed(phrase);
      insertVector.run(info.lastInsertRowid, float32ToBuffer(vector));
      totalPhrases++;
    }
  }

  process.stdout.write('\n');
  console.log(`[init-vectors] ${totalPhrases} frases vectorizadas (${totalSkipped} ya existían) para ${catalog.length} intenciones.`);
  return { inserted: totalPhrases, skipped: totalSkipped, actions: catalog.length };
}

/**
 * Flujo completo reutilizable: crear tablas → decidir si hay que poblar →
 * poblar. Pensado para que tanto la CLI (`main()`) como un handler de
 * Electron (`ipcMain.handle('init-vectors', ...)`) llamen a UNA sola
 * implementación, en vez de mantener dos copias de la lógica SQL que
 * puedan divergir (como pasaba antes de v2, donde main.js tenía su propia
 * copia sin el fix de rowid de arriba).
 *
 * @param {Database} db
 * @param {object} opts
 * @param {Array}   opts.catalog — catálogo a usar (default: INTENT_CATALOG)
 * @param {boolean} opts.force   — si true, limpia y repuebla aunque ya haya datos
 */
async function populateDatabase(db, { catalog = INTENT_CATALOG, force = false } = {}) {
  const sqliteVecLib = sqliteVec || require('sqlite-vec');
  sqliteVecLib.load(db);

  createTables(db);

  if (hasData(db) && !force) {
    const count = db.prepare('SELECT COUNT(*) as n FROM intent_catalog').get().n;
    console.log(`[init-vectors] Ya existen ${count} frases en el catálogo. Usa force:true para repoblar.`);
    return { populated: false, existing: count };
  }

  if (force) clearTables(db);

  const result = await populateCatalog(db, catalog);
  return { populated: true, ...result };
}

// ── NUEVO v2: adición incremental sin repoblar todo ───────────────────────────

/**
 * Agrega UNA frase nueva a una acción (existente o nueva) sin tocar el
 * resto del catálogo ni recalcular ningún embedding existente. Pensado
 * para un flujo evolutivo: cuando en producción el IntentDetector falla
 * en reconocer una frase real de un usuario, se agrega esa frase exacta
 * aquí y queda disponible de inmediato para la próxima detección.
 *
 * Si la acción ya existe en la base, hereda su `tool`/`description`
 * salvo que se pasen explícitamente en `opts`. Si la acción es
 * completamente nueva, `opts.description` es recomendable (si no se da,
 * se usa el propio nombre de la acción como fallback).
 *
 * @returns {{ added: boolean, reason?: string }}
 */
async function addPhrase(db, action, phrase, opts = {}) {
  const clean = (phrase || '').trim();
  if (!action || typeof action !== 'string') throw new Error('addPhrase: "action" es requerido');
  if (!clean) throw new Error('addPhrase: la frase no puede estar vacía');

  const existingForAction = db
    .prepare('SELECT description, tool FROM intent_catalog WHERE action = ? LIMIT 1')
    .get(action);

  const tool        = opts.tool !== undefined ? opts.tool : (existingForAction?.tool ?? null);
  const description  = opts.description || existingForAction?.description || action;

  const info = db.prepare(`
    INSERT OR IGNORE INTO intent_catalog (action, tool, description, phrase)
    VALUES (?, ?, ?, ?)
  `).run(action, tool, description, clean);

  if (info.changes === 0) {
    console.log(`[init-vectors] la frase ya existía para "${action}" — no se agregó de nuevo.`);
    return { added: false, reason: 'duplicate' };
  }

  const vector = await embed(clean);
  db.prepare(`INSERT INTO intent_vectors (rowid, embedding) VALUES (?, ?)`)
    .run(info.lastInsertRowid, float32ToBuffer(vector));

  console.log(`[init-vectors] + frase agregada a "${action}": "${clean}"`);
  return { added: true };
}

// ── NUEVO v2: diagnóstico ──────────────────────────────────────────────────────

/**
 * Verifica que intent_catalog e intent_vectors tengan la misma cantidad
 * de filas. No es una garantía matemática de que CADA rowid esté
 * perfectamente alineado (eso requeriría comparar uno por uno), pero un
 * desfase de conteo es la señal más común de una desincronización real
 * (p. ej. una versión anterior de este archivo, sin el fix de rowid,
 * corrida sobre esta misma base de datos).
 */
function verifyIntegrity(db) {
  const catalogCount = db.prepare('SELECT COUNT(*) AS n FROM intent_catalog').get().n;
  const vectorsCount = db.prepare('SELECT COUNT(*) AS n FROM intent_vectors').get().n;
  const ok = catalogCount === vectorsCount;

  if (!ok) {
    console.warn(
      `[init-vectors] ⚠ DESINCRONIZADO: intent_catalog tiene ${catalogCount} filas, ` +
      `intent_vectors tiene ${vectorsCount}. Corre con --force para repoblar desde cero.`
    );
  } else {
    console.log(`[init-vectors] ✓ Integridad OK (${catalogCount} filas en ambas tablas).`);
  }
  return { ok, catalogCount, vectorsCount };
}

/**
 * Resumen de cobertura: cuántas frases hay por acción/tool. Útil para
 * notar a simple vista qué intenciones están sub-representadas.
 */
function getStats(db) {
  const rows = db.prepare(`
    SELECT action, tool, COUNT(*) AS phrases
    FROM intent_catalog
    GROUP BY action, tool
    ORDER BY action
  `).all();
  const total = rows.reduce((sum, r) => sum + r.phrases, 0);
  return { totalPhrases: total, totalActions: rows.length, byAction: rows };
}

/**
 * Prueba de detección real: vectoriza `query` y busca sus vecinos más
 * cercanos en intent_vectors (igual que haría el IntentDetector en
 * producción), devolviendo action/tool/phrase/distancia. Pensado para
 * probar frases nuevas desde la CLI sin levantar toda la app de Electron.
 */
async function testDetect(db, query, topK = 5) {
  const vector = await embed(query);
  const buf     = float32ToBuffer(vector);

  const rows = db.prepare(`
    SELECT ic.action, ic.tool, ic.phrase, iv.distance
    FROM intent_vectors iv
    JOIN intent_catalog ic ON ic.id = iv.rowid
    WHERE iv.embedding MATCH ?
      AND k = ?
    ORDER BY iv.distance
  `).all(buf, topK);

  return rows;
}

// ── Entry point (CLI) ──────────────────────────────────────────────────────────

async function main() {
  const force    = process.argv.includes('--force');
  const doVerify = process.argv.includes('--verify');
  const doStats  = process.argv.includes('--stats');
  const testArg  = process.argv.find(a => a.startsWith('--test='));
  const addArg   = process.argv.find(a => a.startsWith('--add-phrase='));

  console.log('[init-vectors] Iniciando...');
  console.log(`[init-vectors] Base de datos: ${DB_PATH}`);

  await loadDeps();

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);

  await populateDatabase(db, { catalog: INTENT_CATALOG, force });

  if (doVerify) verifyIntegrity(db);

  if (doStats) {
    const stats = getStats(db);
    console.log(`\n[init-vectors] === Cobertura (${stats.totalActions} acciones, ${stats.totalPhrases} frases) ===`);
    for (const row of stats.byAction) {
      console.log(`  ${row.action.padEnd(20)} tool=${String(row.tool).padEnd(16)} ${row.phrases} frases`);
    }
  }

  if (testArg) {
    const query   = testArg.slice('--test='.length);
    const results = await testDetect(db, query);
    console.log(`\n[init-vectors] === Resultados para "${query}" ===`);
    results.forEach((r, i) => {
      console.log(`  ${i + 1}. [${r.action}] "${r.phrase}"  (distancia: ${r.distance.toFixed(4)})`);
    });
  }

  if (addArg) {
    const raw = addArg.slice('--add-phrase='.length);
    const sep = raw.indexOf(':');
    if (sep === -1) {
      console.error('[init-vectors] Formato esperado: --add-phrase="accion:frase nueva"');
    } else {
      const action = raw.slice(0, sep).trim();
      const phrase = raw.slice(sep + 1).trim();
      await addPhrase(db, action, phrase);
    }
  }

  db.close();
  console.log('[init-vectors] ✓ Listo.');
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[init-vectors] ERROR FATAL:', e.message);
    process.exit(1);
  });
}

module.exports = {
  // API original (compatibilidad hacia atrás)
  main,
  embed,
  float32ToBuffer,
  INTENT_CATALOG,
  DB_PATH,
  loadDeps,
  loadPipeline,
  // API nueva v2
  getIntentCatalog,
  populateDatabase,
  createTables,
  clearTables,
  hasData,
  populateCatalog,
  addPhrase,
  verifyIntegrity,
  getStats,
  testDetect,
};
