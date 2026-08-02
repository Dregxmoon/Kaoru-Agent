/**
 * StateGraph.js — Fase 2 + Quick Fixes
 *
 * Fix QW-1: _usingFallback — flag público que indica si la persistencia
 *   real falló y el sistema cayó a MemoryDB. Permite que main.js / chat.html
 *   muestren un banner de advertencia visible en lugar de fallar en silencio.
 *
 * Fix QW-1b: pragma('busy_timeout', 3000) — evita SQLITE_BUSY no manejado
 *   cuando decay + cierre de sesión coinciden (ej. durante before-quit).
 *
 * Fix QW-2 (decay por lectura): queryNodes() ahora actualiza last_accessed_at
 *   cuando recupera nodos, para que el decay no archive hechos activamente
 *   usados solo porque no se reescriben frecuentemente.
 *   Se hace de forma lazy y asíncrona (fire-and-forget) para no añadir
 *   latencia al camino caliente de retrieval.
 *
 * Fix QW-2c (este parche): el touch de QW-2 estaba duplicado en
 *   queryNodes() y getRecentEpisodes(), y faltaba por completo en
 *   getWorldModel() — que es justo el método que trae los nodos
 *   User/Project/Preference/Belief al contexto en cada turno (el caso
 *   exacto que motivó el bug original: hechos de baja decay_rate que se
 *   leen todos los días pero nunca se reescriben). Se extrajo la lógica
 *   a _touchNodes(ids) y se aplicó también en getWorldModel().
 */

const path = require('path');
const fs   = require('fs');

// ── SQLite con better-sqlite3 ─────────────────────────────────────────────────
let Database;
try {
  Database = require('better-sqlite3');
} catch(e) {
  console.warn('[state-graph] better-sqlite3 no disponible, usando modo memoria');
  console.warn('[state-graph]   Solución: npm install (reconstruye módulos nativos para Electron)');
  Database = null;
}

// ── Constantes ────────────────────────────────────────────────────────────────
const NODE_TYPES = ['User', 'Episode', 'Belief', 'Preference', 'Project'];

const DECAY_RATES = {
  User:       0.005,
  Episode:    0.08,
  Belief:     0.02,
  Preference: 0.01,
  Project:    0.03,
};

const ARCHIVE_THRESHOLD = 0.05;

// ── Recall semántico ──────────────────────────────────────────────────────────
// Cuánto pesa la recencia frente a la similitud vectorial pura. No es un
// corte duro — un recuerdo viejo pero muy relevante sigue pudiendo aparecer,
// solo que con menos empuje. RECENCY_HALFLIFE_DAYS=21 significa: algo visto
// hace 21 días tiene la mitad del "boost" de recencia que algo de hoy.
const RECENCY_HALFLIFE_DAYS = 21;
const SEMANTIC_CANDIDATES   = 24; // cuántos candidatos trae sqlite-vec antes de re-rankear

// ── DB en memoria como fallback ───────────────────────────────────────────────
// ANTES esto era solo-escritura: prepare().get() devolvía siempre undefined y
// all() siempre [] → la memoria en RAM creaba nodos pero jamás los podía leer,
// y TODO el recall (queryNodes, getWorldModel, resume de sesión) devolvía vacío
// en silencio si better-sqlite3 no cargaba. Ahora es un mini-store en Map que
// interpreta SOLO las consultas exactas que emite StateGraph (conjunto cerrado,
// ver abajo); SQL no reconocido se degrada a noop/undefined sin truar.
let _memoryDBSilentWarningShown = false;

class MemoryStatement {
  constructor(db, sql) {
    this._db  = db;
    this._sql = sql.trim().replace(/\s+/g, ' ');
    this._classify();
  }

  _classify() {
    const s = this._sql;
    if (/^(CREATE|PRAGMA|BEGIN|COMMIT)/i.test(s)) { this._kind = 'noop'; return; }
    if (/^INSERT INTO (node_vectors|app_history)/i.test(s)) { this._kind = 'noop'; return; }
    if (/^DELETE FROM (node_vectors|app_history)/i.test(s)) { this._kind = 'noop'; return; }
    if (/^SELECT name FROM sqlite_master/i.test(s)) { this._kind = 'meta'; return; }
    if (/^INSERT INTO nodes/i.test(s)) { this._kind = 'insertNode'; return; }
    if (/^INSERT INTO sessions/i.test(s)) { this._kind = 'insertSession'; return; }
    if (/^UPDATE nodes/i.test(s)) { this._kind = 'updateNodes'; return; }
    if (/^UPDATE sessions/i.test(s)) { this._kind = 'updateSessions'; return; }
    if (/^SELECT \* FROM sessions/i.test(s)) { this._kind = 'selectSessions'; return; }
    if (/^SELECT \* FROM nodes/i.test(s)) { this._kind = 'selectNodes'; return; }
    if (/^SELECT id, importance, decay_rate, last_accessed_at FROM nodes/i.test(s)) { this._kind = 'selectDecay'; return; }
    if (/^SELECT id FROM nodes/i.test(s)) { this._kind = 'selectNodeIds'; return; }
    if (/^SELECT label, COUNT\(\*\) as cnt FROM nodes/i.test(s)) { this._kind = 'selectDupLabels'; return; }
    if (/^SELECT type, COUNT\(\*\) as c FROM nodes/i.test(s)) { this._kind = 'selectTypeCount'; return; }
    if (/^SELECT COUNT\(\*\) as c FROM nodes/i.test(s)) { this._kind = 'selectCount'; return; }
    this._kind = 'noop';
  }

  /** Lista de descriptores de parámetros en orden de aparición en el SQL. */
  _descs() {
    const out = [];
    const re  = /\?/g;
    let m;
    while ((m = re.exec(this._sql)) !== null) {
      const pre = this._sql.slice(Math.max(0, m.index - 30), m.index);
      let d;
      if (/LIKE \?$/.test(pre)) d = 'like';
      else if (/LIMIT \?$/.test(pre)) d = 'limit';
      else if (/id IN/.test(pre)) d = 'ids';
      else if (/type=\?$/.test(pre)) d = 'type';
      else if (/label=\?$/.test(pre)) d = 'label';
      else if (/archived=\?$/.test(pre)) d = 'archived';
      else if (/started_at > \?$/.test(pre)) d = 'since';
      else if (/history_json=\?$/.test(pre)) d = 'historyJson';
      else if (/ended_at=\?$/.test(pre)) d = 'endedAt';
      else if (/summary=\?$/.test(pre)) d = 'summary';
      else if (/turn_count=\?$/.test(pre)) d = 'turnCount';
      else if (/episode_id=\?$/.test(pre)) d = 'episodeId';
      else if (/last_accessed_at=\?$/.test(pre)) d = 'lastAccessedAt';
      else if (/importance=\?$/.test(pre)) d = 'importance';
      else if (/updated_at=\?$/.test(pre)) d = 'updatedAt';
      else if (/id=\?$/.test(pre)) d = 'id';
      else d = 'arg';
      out.push(d);
    }
    return out;
  }

  /**
   * Filtra y ordena nodos consumiendo los parámetros ESTRICTAMENTE en orden
   * de aparición en el SQL (todos los queries de StateGraph pasan los args en
   * ese orden). Los descriptores de tipo SET (updatedAt, importance, ...) se
   * consumen y se ignoran — solo afectan a updateNodes/updateSessions.
   */
  _nodes(args) {
    const descs = this._descs();
    let list = [...this._db._nodes.values()];
    let ai = 0;
    const ids = [];
    while (ai < descs.length) {
      const d = descs[ai];
      const v = args[ai];
      ai++;
      switch (d) {
        case 'id':   list = list.filter(n => n.id === v); break;
        case 'ids':  ids.push(v); break;
        case 'like': list = list.filter(n => (n.label || '').includes(v) || (n.content || '').includes(v)); break;
        case 'type': list = list.filter(n => n.type === v); break;
        case 'label': list = list.filter(n => n.label === v); break;
        case 'archived': list = list.filter(n => n.archived === v); break;
        case 'limit': list = list.slice(0, v); break;
        default: break; // SET values: updatedAt, importance, lastAccessedAt, summary, etc.
      }
    }
    if (ids.length) list = list.filter(n => ids.includes(n.id));

    // Condiciones literales (sin parámetro) presentes en el SQL
    if (this._sql.includes('archived=0')) list = list.filter(n => n.archived === 0);
    else if (this._sql.includes('archived=1')) list = list.filter(n => n.archived === 1);
    const typeIn = this._sql.match(/type IN \(([^)]+)\)/);
    if (typeIn) {
      const types = typeIn[1].split(',').map(x => x.trim().replace(/'/g, ''));
      list = list.filter(n => types.includes(n.type));
    }
    const eq = this._sql.match(/type='([^']+)'/);
    if (eq) list = list.filter(n => n.type === eq[1]);
    if (this._sql.includes('history_json IS NOT NULL')) list = list.filter(n => n.history_json != null);

    const orderBy = this._sql.match(/ORDER BY ([^L]+?)(?:LIMIT|$)/);
    if (orderBy) {
      const parts = orderBy[1].split(',').map(x => x.trim()).filter(Boolean);
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        const desc = p.endsWith(' DESC');
        const col = p.replace(/ DESC$/, '').trim();
        list.sort((a, b) => {
          const av = a[col], bv = b[col];
          if (av === bv) return 0;
          return (av < bv ? -1 : 1) * (desc ? -1 : 1);
        });
      }
    }
    const lm = this._sql.match(/LIMIT (\d+)/);
    if (lm) list = list.slice(0, Number(lm[1]));
    return list;
  }

  _setAssignments(args) {
    const setClause = (this._sql.match(/SET (.*?)(?:WHERE|$)/s) || [])[1] || '';
    const setParamsBefore = [];
    const setParamCount = (setClause.match(/\?/g) || []).length;
    const setArgs = args.slice(0, setParamCount);
    let si = 0;
    const assigns = [];
    for (const piece of setClause.split(',').map(x => x.trim()).filter(Boolean)) {
      const m = piece.match(/^([\w_]+)\s*=\s*(.+)$/);
      if (!m) continue;
      const col = m[1], rhs = m[2];
      if (rhs === '?') assigns.push({ col, value: setArgs[si++] });
      else if (/^[\w_]+\s*\+\s*\d+$/.test(rhs)) { const [c, add] = rhs.split('+').map(x => x.trim()); assigns.push({ col, value: undefined, inc: { c, add: Number(add) } }); }
      else if (/^\d+$/.test(rhs)) assigns.push({ col, value: Number(rhs) });
      else assigns.push({ col, value: rhs.replace(/^['"]|['"]$/g, '') });
    }
    return assigns;
  }

  run(...args) {
    if (this._kind === 'insertNode') {
      const cols = (this._sql.match(/\(([^)]+)\)\s*VALUES/) || [])[1]?.split(',').map(c => c.trim().replace(/['"`]/g, '')) || [];
      const id = this._db._nextId++;
      const node = { id, archived: 0, access_count: 0 }; // defaults de la tabla real
      cols.forEach((c, i) => { node[c] = args[i]; });
      if (typeof node.tags !== 'string') node.tags = JSON.stringify(node.tags || []);
      this._db._nodes.set(id, node);
      return { lastInsertRowid: id, changes: 1 };
    }
    if (this._kind === 'insertSession') {
      const id = this._db._nextSessionId++;
      this._db._sessions.set(id, { id, started_at: args[0], ended_at: null, summary: null, turn_count: 0, episode_id: null, history_json: null });
      return { lastInsertRowid: id, changes: 1 };
    }
    if (this._kind === 'updateNodes') {
      const targets = this._nodes(args);
      for (const n of targets) {
        for (const a of this._setAssignments(args)) {
          if (a.inc) n[a.inc.c] = (n[a.inc.c] || 0) + a.inc.add;
          else n[a.col] = a.value;
        }
      }
      return { changes: targets.length };
    }
    if (this._kind === 'updateSessions') {
      const targets = this._selectSessions(args);
      for (const s of targets) {
        for (const a of this._setAssignments(args)) s[a.col] = a.value;
      }
      return { changes: targets.length };
    }
    return { changes: 0 };
  }

  get(...args) {
    if (this._kind === 'meta') return undefined;
    if (this._kind === 'selectNodes') return this._nodes(args)[0];
    if (this._kind === 'selectNodeIds') return { id: this._nodes(args)[0]?.id };
    if (this._kind === 'selectSessions') return this._selectSessions(args)[0];
    if (this._kind === 'selectCount') return { c: this._nodes(args).length };
    return undefined;
  }

  all(...args) {
    if (this._kind === 'selectNodes') return this._nodes(args);
    if (this._kind === 'selectNodeIds') return this._nodes(args).map(n => ({ id: n.id }));
    if (this._kind === 'selectDecay') {
      return this._nodes(args).map(n => ({ id: n.id, importance: n.importance, decay_rate: n.decay_rate, last_accessed_at: n.last_accessed_at }));
    }
    if (this._kind === 'selectSessions') return this._selectSessions(args);
    if (this._kind === 'selectDupLabels') {
      const by = new Map();
      for (const n of this._nodes(args)) by.set(n.label, (by.get(n.label) || 0) + 1);
      return [...by].filter(([, c]) => c > 1).map(([label, cnt]) => ({ label, cnt }));
    }
    if (this._kind === 'selectTypeCount') {
      const by = new Map();
      for (const n of this._nodes(args)) by.set(n.type, (by.get(n.type) || 0) + 1);
      return [...by].map(([type, c]) => ({ type, c }));
    }
    return [];
  }

  _selectSessions(args) {
    const descs = this._descs();
    let list = [...this._db._sessions.values()];
    let ai = 0;
    while (ai < descs.length) {
      const d = descs[ai];
      const v = args[ai];
      ai++;
      if (d === 'since') list = list.filter(x => x.started_at > v);
      else if (d === 'id') list = list.filter(x => x.id === v);
      else if (d === 'limit') list = list.slice(0, v);
      // historyJson/endedAt/summary/turnCount/episodeId son SET → se ignoran al filtrar
    }
    if (this._sql.includes('ended_at IS NULL')) list = list.filter(x => x.ended_at == null);
    else if (this._sql.includes('ended_at IS NOT NULL')) list = list.filter(x => x.ended_at != null);
    if (this._sql.includes('history_json IS NOT NULL')) list = list.filter(x => x.history_json != null);
    list.sort((a, b) => (b.started_at || 0) - (a.started_at || 0));
    const lm = this._sql.match(/LIMIT (\d+)/);
    if (lm) list = list.slice(0, Number(lm[1]));
    return list;
  }
}

class MemoryDB {
  constructor() {
    this._nodes    = new Map();
    this._sessions = new Map();
    this._nextId   = 1;
    this._nextSessionId = 1;
    if (!_memoryDBSilentWarningShown) {
      _memoryDBSilentWarningShown = true;
      setInterval(() => {
        console.warn('[state-graph] MemoryDB activo — los datos NO persisten en disco. better-sqlite3 no está disponible.');
      }, 5 * 60 * 1000);
    }
  }
  prepare(sql) {
    return new MemoryStatement(this, sql);
  }
  exec() {}
  transaction(fn) { return fn; }
  pragma() {}
  close() {}
}

// ── StateGraph ────────────────────────────────────────────────────────────────
class StateGraph {
  constructor(dbPath) {
    this._dbPath       = dbPath;
    this._db           = null;
    this._ready        = false;
    this.usingFallback = false;
    this._vectorReady = false;
    this._vectorReadyPromise = Promise.resolve();
    this._embeddingQueue = [];
    this._embeddingInFlight = 0;
    this._embeddingMaxConcurrent = 2;
  }

  get isReady() { return this._ready; }

  init() {
    if (this._ready) return this;

    try {
      if (Database) {
        const dir = path.dirname(this._dbPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        this._db = new Database(this._dbPath);
        // FIX QW-1b: evita SQLITE_BUSY no manejado en escrituras concurrentes
        this._db.pragma('busy_timeout = 3000');
        this._db.pragma('journal_mode = WAL');
        this._db.pragma('foreign_keys = ON');
        this.usingFallback = false;
      } else {
        throw new Error('better-sqlite3 no disponible');
      }

      this._createSchema();
      this._migrateSchema();
      this._ready = true;
      console.log('[state-graph] inicializado (Fase 2):', this._dbPath);
    } catch(e) {
      console.error('[state-graph] ERROR CRÍTICO — cayendo a MemoryDB:', e.message);
      console.error('[state-graph] La memoria del asistente NO se esta guardando en disco.');
      this._db           = new MemoryDB();
      this.usingFallback = true;
      this._createSchema();
      this._ready = true;
    }

    return this;
  }

  // ── Schema ──────────────────────────────────────────────────────────────────

  _createSchema() {
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        type             TEXT    NOT NULL CHECK(type IN ('User','Episode','Belief','Preference','Project')),
        label            TEXT    NOT NULL,
        content          TEXT    NOT NULL,
        importance       REAL    NOT NULL DEFAULT 1.0,
        decay_rate       REAL    NOT NULL DEFAULT 0.05,
        access_count     INTEGER NOT NULL DEFAULT 0,
        tags             TEXT    DEFAULT '[]',
        archived         INTEGER NOT NULL DEFAULT 0,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL,
        last_accessed_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_nodes_type       ON nodes(type);
      CREATE INDEX IF NOT EXISTS idx_nodes_importance ON nodes(importance DESC);
      CREATE INDEX IF NOT EXISTS idx_nodes_archived   ON nodes(archived);
      CREATE INDEX IF NOT EXISTS idx_nodes_created    ON nodes(created_at DESC);

      CREATE TABLE IF NOT EXISTS node_relations (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        from_id    INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        to_id      INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        rel_type   TEXT    NOT NULL,
        weight     REAL    NOT NULL DEFAULT 1.0,
        created_at INTEGER NOT NULL,
        UNIQUE(from_id, to_id, rel_type)
      );

      CREATE INDEX IF NOT EXISTS idx_relations_from ON node_relations(from_id);
      CREATE INDEX IF NOT EXISTS idx_relations_to   ON node_relations(to_id);

      CREATE TABLE IF NOT EXISTS sessions (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at INTEGER NOT NULL,
        ended_at   INTEGER,
        summary    TEXT,
        turn_count INTEGER NOT NULL DEFAULT 0,
        episode_id INTEGER REFERENCES nodes(id)
      );

      CREATE TABLE IF NOT EXISTS app_history (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        app           TEXT    NOT NULL,
        friendly_name TEXT,
        title         TEXT,
        category      TEXT,
        start_ts      INTEGER NOT NULL,
        end_ts        INTEGER NOT NULL,
        duration_sec  INTEGER NOT NULL,
        day_key       TEXT    NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_app_history_day ON app_history(day_key);
      CREATE INDEX IF NOT EXISTS idx_app_history_app ON app_history(app);
      CREATE INDEX IF NOT EXISTS idx_app_history_ts  ON app_history(start_ts DESC);
    `);
  }

  _migrateSchema() {
    try {
      const tableExists = this._db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type='table' AND name='app_history'
      `).get();

      if (!tableExists) {
        console.log('[state-graph] migrando schema a Fase 2...');
        this._db.exec(`
          CREATE TABLE IF NOT EXISTS app_history (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            app           TEXT    NOT NULL,
            friendly_name TEXT,
            title         TEXT,
            category      TEXT,
            start_ts      INTEGER NOT NULL,
            end_ts        INTEGER NOT NULL,
            duration_sec  INTEGER NOT NULL,
            day_key       TEXT    NOT NULL
          );

          CREATE INDEX IF NOT EXISTS idx_app_history_day ON app_history(day_key);
          CREATE INDEX IF NOT EXISTS idx_app_history_app ON app_history(app);
          CREATE INDEX IF NOT EXISTS idx_app_history_ts  ON app_history(start_ts DESC);
        `);
        console.log('[state-graph] migración Fase 2 completada');
      }

      // Mejora #6 — persistencia de sesión resumible: antes, si la ventana
      // de chat se cerraba sin pasar por el flujo normal (crash, apagón,
      // Windows forzando un reinstall de una vez), _history vivía SOLO en
      // memoria de SessionManager y se perdía por completo — la próxima
      // sesión arrancaba en blanco, sin la conversación en curso.
      // history_json guarda el array de turnos tal cual, actualizado en
      // cada addTurn(), para poder restaurarlo si la sesión anterior quedó
      // con ended_at NULL (ver SessionManager.start() / findResumableSession).
      const sessionCols = this._db.prepare(`PRAGMA table_info(sessions)`).all();
      if (!sessionCols.some(c => c.name === 'history_json')) {
        console.log('[state-graph] migrando schema: sessions.history_json...');
        this._db.exec(`ALTER TABLE sessions ADD COLUMN history_json TEXT;`);
      }
    } catch(e) {
      console.warn('[state-graph] error en migración (no crítico):', e.message);
    }
  }

  // ── Recall semántico (vector + decay temporal) ──────────────────────────────
  //
  // queryNodes({search}) hace un LIKE plano sobre label/content, ordenado
  // SOLO por importance — no distingue "coincide de casualidad" de
  // "es justo lo que se preguntó", y no le da ningún peso extra a que un
  // recuerdo sea reciente. queryNodesSemantic() es la mejora: usa el mismo
  // embedder que ya carga IntentDetector (no se duplica el modelo) para
  // rankear por similitud coseno real, combinado con un boost de recencia.
  //
  // Requiere que sqlite-vec ya esté cargado en esta conexión — eso lo hace
  // Core.init() (ver "sqlite-vec cargado en StateGraph DB"), y luego
  // llama a enableVectorSearch() para crear la tabla. Si algo de esto falla
  // o no se llamó, _vectorReady queda false y todo cae a queryNodes() normal
  // — nunca es un requisito duro, es una mejora quePuede no estar.

  /**
   * Crea la tabla virtual node_vectors (sqlite-vec) si no existe. Debe
   * llamarse DESPUÉS de que sqlite-vec.load(db) ya corrió sobre esta misma
   * conexión — no lo hace esta función, porque StateGraph no depende de
   * sqlite-vec directamente (evita acoplar un módulo de más bajo nivel a
   * una extensión que hoy vive en Core.init()).
   */
  enableVectorSearch() {
    if (this.usingFallback) return false;
    try {
      const exists = this._db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='node_vectors'"
      ).get();

      if (!exists) {
        this._db.exec(`
          CREATE VIRTUAL TABLE node_vectors USING vec0(
            embedding FLOAT[384]
          );
        `);
        console.log('[state-graph] node_vectors creada — recall semántico habilitado');
      }

      this._vectorReady = true;
      return true;
    } catch(e) {
      console.warn('[state-graph] no se pudo habilitar recall semántico (se sigue usando LIKE):', e.message);
      this._vectorReady = false;
      return false;
    }
  }

  // ── Cola de embeddings con control de concurrencia ──────────────────────
  // Evita saturar el modelo (23MB + ONNX runtime) en hardware limitado.
  // Máximo 2 embeddings simultáneos; los demás encolan.

  _processEmbeddingQueue() {
    while (this._embeddingInFlight < this._embeddingMaxConcurrent && this._embeddingQueue.length > 0) {
      const job = this._embeddingQueue.shift();
      this._embeddingInFlight++;
      this._runEmbedding(job.id, job.content).finally(() => {
        this._embeddingInFlight--;
        this._processEmbeddingQueue();
      });
    }
  }

  async _runEmbedding(id, content) {
    try {
      const { embedText, float32ToBuffer } = require('../grounding/IntentDetector.js');
      const vec = await embedText(content.slice(0, 2000));
      this._upsertNodeVector(id, float32ToBuffer(vec));
    } catch(e) {
      console.warn(`[state-graph] no se pudo embedear nodo ${id}:`, e.message);
    }
  }

  /**
   * Fire-and-forget: embedea el contenido de un nodo y lo guarda en
   * node_vectors con rowid = id del nodo. No bloquea al llamador —
   * los embeddings se procesan con concurrencia limitada (max 2).
   * El nodo queda buscable por LIKE de inmediato y por semántica
   * un momento después.
   *
   * DOS quirks de sqlite-vec (vec0) que costó encontrar, documentados para
   * no volver a pisarlos:
   *   1. El rowid debe pasarse como BigInt, no Number — un placeholder con
   *      Number de JS falla con "Only integers are allowed for primary
   *      key values" aunque sea un entero legítimo. El SELECT de vuelta sí
   *      da Number normal, no hace falta convertir en el otro sentido.
   *   2. vec0 NO soporta "INSERT OR REPLACE" — falla con "UNIQUE constraint
   *      failed" aunque en una tabla normal funcionaría. Hay que borrar
   *      primero y luego insertar (ver _upsertNodeVector abajo).
   */
  _scheduleNodeEmbedding(id, content) {
    if (!this._vectorReady || !id || !content) return;
    this._embeddingQueue.push({ id, content });
    this._processEmbeddingQueue();
  }

  /** Ver nota de quirks en _scheduleNodeEmbedding — vec0 no soporta OR REPLACE. */
  _upsertNodeVector(id, embeddingBuffer) {
    const bigId = BigInt(id);
    this._db.prepare('DELETE FROM node_vectors WHERE rowid=?').run(bigId);
    this._db.prepare('INSERT INTO node_vectors (rowid, embedding) VALUES (?, ?)').run(bigId, embeddingBuffer);
  }

  /**
   * Recall semántico: similitud vectorial + boost de recencia, no solo
   * importance. Cae a queryNodes({search}) si el recall vectorial no está
   * listo o falla — nunca deja al llamador sin resultados por esto.
   *
   * @param {string} searchText — texto en lenguaje natural (no keywords sueltas)
   * @param {object} opts — { type, limit, includeArchived }
   */
  async queryNodesSemantic(searchText, { type, limit = 8, includeArchived = false } = {}) {
    if (!this._vectorReady || !searchText || !searchText.trim()) {
      return this.queryNodes({ type, search: searchText, limit, includeArchived });
    }

    try {
      const { embedText, float32ToBuffer, distanceToSimilarity } = require('../grounding/IntentDetector.js');
      const queryVec = await embedText(searchText.slice(0, 500));

      const candidates = this._db.prepare(`
        SELECT nv.rowid as id, distance
        FROM node_vectors nv
        WHERE embedding MATCH ? AND k = ?
        ORDER BY distance
      `).all(float32ToBuffer(queryVec), SEMANTIC_CANDIDATES);

      if (!candidates.length) {
        return this.queryNodes({ type, search: searchText, limit, includeArchived });
      }

      const now = Date.now();
      const ids = candidates.map(c => c.id);
      const placeholders = ids.map(() => '?').join(',');
      const archivedClause = includeArchived ? '' : 'AND archived=0';
      const typeClause = type ? 'AND type=?' : '';

      const rows = this._db.prepare(`
        SELECT * FROM nodes WHERE id IN (${placeholders}) ${archivedClause} ${typeClause}
      `).all(...ids, ...(type ? [type] : []));

      const distanceById = new Map(candidates.map(c => [c.id, c.distance]));

      const scored = rows.map(node => {
        const distance   = distanceById.get(node.id) ?? 1;
        const similarity = distanceToSimilarity(distance);
        const daysSince   = Math.max(0, (now - node.last_accessed_at) / (1000 * 60 * 60 * 24));
        // recencyBoost va de 1.0 (justo ahora) a 0.5 (muy viejo) — nunca
        // llega a 0, para que un recuerdo viejo pero muy relevante todavía
        // pueda salir si su similitud/importance son altas.
        const recencyBoost = 0.5 + 0.5 * Math.exp(-daysSince / RECENCY_HALFLIFE_DAYS);
        const score = similarity * node.importance * recencyBoost;
        return { ...node, _semanticScore: score, _similarity: similarity };
      });

      scored.sort((a, b) => b._semanticScore - a._semanticScore);
      const top = scored.slice(0, limit);

      if (!includeArchived) {
        this._touchNodes(top.map(n => n.id).filter(Boolean), 'queryNodesSemantic');
      }

      return top;

    } catch(e) {
      console.warn('[state-graph] error en recall semántico, cayendo a LIKE:', e.message);
      return this.queryNodes({ type, search: searchText, limit, includeArchived });
    }
  }

  /**
   * Embedea en lote los nodos que no tienen vector todavía (nodos creados
   * antes de que existiera esta mejora, o si enableVectorSearch() se activó
   * después de tener memoria acumulada). Fire-and-forget desde
   * Core.init() — no bloquea el arranque. Se hace en lotes chicos con
   * una pausa entre cada uno para no acaparar CPU de un jalón en hardware
   * limitado (Athlon Silver).
   */
  async backfillEmbeddings(batchSize = 10) {
    if (!this._vectorReady) return { embedded: 0 };

    // M2: doble verificación — que la tabla node_vectors realmente exista
    try {
      this._db.prepare("SELECT rowid FROM node_vectors LIMIT 1").get();
    } catch(e) {
      console.warn('[state-graph] backfill abortado — node_vectors no existe:', e.message);
      return { embedded: 0, error: 'node_vectors table not found' };
    }

    // Limpiar vectores huérfanos (nodos que fueron archivados/eliminados
    // pero su vector quedó en node_vectors)
    try {
      const orphaned = this._db.prepare(`
        SELECT nv.rowid FROM node_vectors nv
        LEFT JOIN nodes n ON n.id = nv.rowid
        WHERE n.id IS NULL
      `).all();
      for (const row of orphaned) {
        this._db.prepare('DELETE FROM node_vectors WHERE rowid=?').run(BigInt(row.rowid));
      }
      if (orphaned.length > 0) {
        console.log(`[state-graph] backfill: ${orphaned.length} vectores huérfanos eliminados`);
      }
    } catch(e) {
      console.warn('[state-graph] error limpiando vectores huérfanos:', e.message);
    }

    try {
      const pending = this._db.prepare(`
        SELECT n.id, n.content FROM nodes n
        LEFT JOIN node_vectors nv ON nv.rowid = n.id
        WHERE nv.rowid IS NULL AND n.archived = 0
      `).all();

      if (!pending.length) return { embedded: 0 };

      console.log(`[state-graph] backfill de embeddings: ${pending.length} nodos pendientes...`);
      const { embedText, float32ToBuffer } = require('../grounding/IntentDetector.js');

      let done = 0;
      for (let i = 0; i < pending.length; i += batchSize) {
        const batch = pending.slice(i, i + batchSize);
        for (const node of batch) {
          try {
            const vec = await embedText((node.content || '').slice(0, 2000));
            this._upsertNodeVector(node.id, float32ToBuffer(vec));
            done++;
          } catch(e) {
            console.warn(`[state-graph] backfill: error embedeando nodo ${node.id}:`, e.message);
          }
        }
        // Pausa breve entre lotes — no monopolizar el hilo principal
        if (i + batchSize < pending.length) await new Promise(r => setTimeout(r, 50));
      }

      console.log(`[state-graph] backfill completado: ${done}/${pending.length} nodos embedeados`);
      return { embedded: done, total: pending.length };
    } catch(e) {
      console.error('[state-graph] error en backfillEmbeddings:', e.message);
      return { embedded: 0, error: e.message };
    }
  }

  // ── CRUD de nodos ───────────────────────────────────────────────────────────

  createNode({ type, label, content, importance = 1.0, tags = [] }) {
    if (!NODE_TYPES.includes(type)) throw new Error(`Tipo inválido: ${type}`);
    const now    = Date.now();
    const result = this._db.prepare(`
      INSERT INTO nodes (type, label, content, importance, decay_rate, tags, created_at, updated_at, last_accessed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      type, label, content, importance,
      DECAY_RATES[type],
      JSON.stringify(tags),
      now, now, now
    );
    this._scheduleNodeEmbedding(result.lastInsertRowid, content);
    return result.lastInsertRowid;
  }

  updateNode(id, { content, label, importance, tags } = {}) {
    const now  = Date.now();
    const node = this.getNode(id);
    if (!node) return false;

    const newImportance = importance ?? node.importance;
    const newContent    = content    ?? node.content;
    const newLabel      = label      ?? node.label;
    const newTags       = tags       ?? JSON.parse(node.tags || '[]');

    this._db.prepare(`
      UPDATE nodes
      SET content=?, label=?, importance=?, tags=?, updated_at=?, last_accessed_at=?, access_count=access_count+1
      WHERE id=?
    `).run(newContent, newLabel, newImportance, JSON.stringify(newTags), now, now, id);

    // Solo re-embedear si el contenido realmente cambió — evita trabajo
    // innecesario en updates que solo tocan importance/tags.
    if (content && content !== node.content) {
      this._scheduleNodeEmbedding(id, newContent);
    }

    return true;
  }

  getNode(id) {
    return this._db.prepare('SELECT * FROM nodes WHERE id=?').get(id) || null;
  }

  /**
   * Helper centralizado de "touch" — actualiza last_accessed_at y
   * access_count de forma SÍNCRONA para una lista de ids. Better-sqlite3
   * es síncrono, así que la escritura es inmediata y no se pierde en
   * shutdown. Antes era fire-and-forget con setImmediate, lo que causaba
   * que los touches se perdieran si la app se cerraba antes de ejecutar
   * la callback.
   *
   * Extraído de queryNodes()/getRecentEpisodes() (donde estaba duplicado
   * literalmente) y aplicado también en getWorldModel(), que antes no
   * lo tenía. getWorldModel() es el método que trae los nodos
   * User/Project/Preference/Belief al contexto en cada turno — exactamente
   * el camino de lectura cuya falta de "touch" causaba que hechos de baja
   * decay_rate (ej. tipo User) decayeran y se archivaran aunque se
   * estuvieran usando activamente en cada conversación.
   *
   * No se aplica a getNode() a propósito: getNode() se usa internamente
   * (ej. dentro de updateNode() para leer el estado actual antes de
   * escribir), y tocar ahí causaría una escritura redundante que
   * inmediatamente se sobreescribe — no aporta nada y duplica I/O.
   */
  _touchNodes(ids, label = '') {
    if (!ids?.length || this.usingFallback) return;
    try {
      const now = Date.now();
      const placeholders = ids.map(() => '?').join(',');
      this._db.prepare(
        `UPDATE nodes SET last_accessed_at=?, access_count=access_count+1 WHERE id IN (${placeholders}) AND archived=0`
      ).run(now, ...ids);
    } catch(e) {
      console.warn(`[state-graph] error actualizando last_accessed_at (${label || 'touch'}):`, e.message);
    }
  }

  /**
   * FIX QW-2: queryNodes ahora actualiza last_accessed_at en los nodos
   * recuperados (vía _touchNodes), de forma fire-and-forget (no bloquea
   * el camino caliente). Esto previene que el decay archive nodos que se
   * usan frecuentemente en retrieval pero que no se reescriben, ya que la
   * fórmula de decay usa last_accessed_at para calcular daysSince.
   *
   * Se limita a nodos con archived=0 para no actualizar memoria archivada
   * accidentalmente si alguien llama queryNodes({includeArchived: true}).
   */
  queryNodes({ type, search, limit = 20, includeArchived = false } = {}) {
    let sql    = 'SELECT * FROM nodes WHERE 1=1';
    const args = [];

    if (!includeArchived) { sql += ' AND archived=0'; }
    if (type)   { sql += ' AND type=?';                            args.push(type); }
    if (search) { sql += ' AND (label LIKE ? OR content LIKE ?)'; args.push(`%${search}%`, `%${search}%`); }

    sql += ' ORDER BY importance DESC LIMIT ?';
    args.push(limit);

    const results = this._db.prepare(sql).all(...args);

    if (!includeArchived) {
      this._touchNodes(results.map(n => n.id).filter(Boolean), 'queryNodes');
    }

    return results;
  }

  getRecentEpisodes(limit = 20) {
    const results = this._db.prepare(`
      SELECT * FROM nodes
      WHERE type='Episode' AND archived=0
      ORDER BY importance DESC, created_at DESC
      LIMIT ?
    `).all(limit);

    this._touchNodes(results.map(n => n.id).filter(Boolean), 'getRecentEpisodes');

    return results;
  }

  /**
   * FIX QW-2c: getWorldModel() ahora también hace touch de los nodos que
   * devuelve. Antes era la única vía de lectura "de contexto" del grafo
   * que no actualizaba last_accessed_at — ver comentario de _touchNodes().
   */
  getWorldModel() {
    const results = this._db.prepare(`
      SELECT * FROM nodes
      WHERE type IN ('User','Project','Preference','Belief')
        AND archived=0
      ORDER BY importance DESC
      LIMIT 30
    `).all();

    this._touchNodes(results.map(n => n.id).filter(Boolean), 'getWorldModel');

    return results;
  }

  upsertNode({ type, label, content, importance, tags = [] }) {
    const existing = this._db.prepare(
      'SELECT id FROM nodes WHERE type=? AND label=? AND archived=0 LIMIT 1'
    ).get(type, label);

    if (existing) {
      this.updateNode(existing.id, { content, importance, tags });
      return existing.id;
    }
    return this.createNode({ type, label, content, importance, tags });
  }

  // ── Relaciones ──────────────────────────────────────────────────────────────

  createRelation(fromId, toId, relType, weight = 1.0) {
    try {
      this._db.prepare(`
        INSERT OR REPLACE INTO node_relations (from_id, to_id, rel_type, weight, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(fromId, toId, relType, weight, Date.now());
    } catch(_) {}
  }

  // ── Sesiones ────────────────────────────────────────────────────────────────

  startSession() {
    const result = this._db.prepare(
      'INSERT INTO sessions (started_at) VALUES (?)'
    ).run(Date.now());
    return result.lastInsertRowid;
  }

  endSession(sessionId, { summary, turnCount, episodeId } = {}) {
    this._db.prepare(`
      UPDATE sessions SET ended_at=?, summary=?, turn_count=?, episode_id=?
      WHERE id=?
    `).run(Date.now(), summary || null, turnCount || 0, episodeId || null, sessionId);
  }

  getLastSessions(limit = 5) {
    return this._db.prepare(`
      SELECT * FROM sessions WHERE ended_at IS NOT NULL
      ORDER BY started_at DESC LIMIT ?
    `).all(limit);
  }

  /**
   * Guarda el transcript en curso — se llama en cada addTurn() de
   * SessionManager, no solo al cerrar. Es una escritura barata (better-
   * sqlite3 es síncrono) así que no hace falta batchear ni debounce; el
   * costo real es que si la app truena a media sesión, se pierde como
   * mucho el turno que estaba en vuelo, no la conversación completa.
   */
  updateSessionHistory(sessionId, history) {
    if (!sessionId) return;
    try {
      this._db.prepare('UPDATE sessions SET history_json=? WHERE id=?')
        .run(JSON.stringify(history || []), sessionId);
    } catch(e) {
      console.warn('[state-graph] error guardando history_json:', e.message);
    }
  }

  /**
   * Busca una sesión que se haya quedado a medias — ended_at IS NULL,
   * dentro de una ventana razonable (por defecto 12h: lo bastante para
   * cubrir "se fue la luz"/"crasheó"/"Windows forzó un reinicio", sin
   * "resumir" algo que quedó abierto por accidente hace tres semanas).
   * Devuelve null si no hay nada que valga la pena resumir.
   */
  findResumableSession(maxAgeHours = 12) {
    try {
      const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;
      const row = this._db.prepare(`
        SELECT * FROM sessions
        WHERE ended_at IS NULL AND started_at > ? AND history_json IS NOT NULL
        ORDER BY started_at DESC LIMIT 1
      `).get(cutoff);

      if (!row) return null;

      let history = [];
      try { history = JSON.parse(row.history_json) || []; } catch(_) { history = []; }
      if (!history.length) return null;

      return { id: row.id, history, turnCount: row.turn_count || history.length, startedAt: row.started_at };
    } catch(e) {
      console.warn('[state-graph] error buscando sesión resumible:', e.message);
      return null;
    }
  }

  // ── App History (Fase 2) ────────────────────────────────────────────────────

  saveAppHistory({ app, friendlyName, title, category, start, end, duration }) {
    if (!app || !start || !end || !duration) return;
    const dayKey = new Date(start).toISOString().slice(0, 10);
    try {
      this._db.prepare(`
        INSERT INTO app_history (app, friendly_name, title, category, start_ts, end_ts, duration_sec, day_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        app,
        friendlyName || app,
        (title || '').slice(0, 200),
        category || 'other',
        start, end, duration,
        dayKey
      );
    } catch(e) {
      console.warn('[state-graph] error guardando app_history:', e.message);
    }
  }

  getTodayAppHistory() {
    const dayKey = new Date().toISOString().slice(0, 10);
    try {
      return this._db.prepare(`
        SELECT * FROM app_history
        WHERE day_key = ?
        ORDER BY start_ts ASC
      `).all(dayKey);
    } catch(e) {
      console.warn('[state-graph] error leyendo app_history:', e.message);
      return [];
    }
  }

  getAppUsageSummary(days = 1) {
    const since = Date.now() - (days * 24 * 60 * 60 * 1000);
    try {
      return this._db.prepare(`
        SELECT friendly_name, category, SUM(duration_sec) as total_sec
        FROM app_history
        WHERE start_ts >= ?
        GROUP BY app
        ORDER BY total_sec DESC
        LIMIT 15
      `).all(since);
    } catch(e) {
      console.warn('[state-graph] error en app usage summary:', e.message);
      return [];
    }
  }

  getTodayAppSummaryString() {
    const summary = this.getAppUsageSummary(1);
    if (!summary.length) return null;

    return summary
      .slice(0, 6)
      .map(({ friendly_name, total_sec }) => `${friendly_name} (${this._formatSec(total_sec)})`)
      .join(', ');
  }

  _formatSec(seconds) {
    if (!seconds || seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    const rem = mins % 60;
    return rem > 0 ? `${hrs}h ${rem}m` : `${hrs}h`;
  }

  // ── Decay ───────────────────────────────────────────────────────────────────

  applyDecay() {
    const now   = Date.now();
    const nodes = this._db.prepare(
      'SELECT id, importance, decay_rate, last_accessed_at FROM nodes WHERE archived=0'
    ).all();

    // SOLO se actualiza importance — updated_at queda intacto para no
    // corromper la métrica de "última modificación real". El orden de
    // deduplicación usa last_accessed_at (ver deduplicateNodes).
    const update  = this._db.prepare('UPDATE nodes SET importance=? WHERE id=?');
    const archive = this._db.prepare('UPDATE nodes SET archived=1 WHERE id=?');

    const runDecay = this._db.transaction(() => {
      let decayed = 0, archived = 0;

      for (const node of nodes) {
        const daysSince = (now - node.last_accessed_at) / (1000 * 60 * 60 * 24);
        if (daysSince < 1) continue;

        const newImportance = node.importance * Math.pow(1 - node.decay_rate, daysSince);

        if (newImportance < ARCHIVE_THRESHOLD) {
          archive.run(node.id);
          archived++;
        } else {
          update.run(Math.round(newImportance * 10000) / 10000, node.id);
          decayed++;
        }
      }

      if (decayed + archived > 0) {
        console.log(`[state-graph] decay: ${decayed} actualizados, ${archived} archivados`);
      }
    });

    runDecay();
  }

  pruneAppHistory(days = 30) {
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    try {
      const result = this._db.prepare(
        'DELETE FROM app_history WHERE start_ts < ?'
      ).run(cutoff);
      if (result.changes > 0) {
        console.log(`[state-graph] app_history pruned: ${result.changes} entradas eliminadas`);
      }
    } catch(e) {
      console.warn('[state-graph] error en pruneAppHistory:', e.message);
    }
  }

  // ── Stats ───────────────────────────────────────────────────────────────────

  getStats() {
    try {
      const total  = this._db.prepare('SELECT COUNT(*) as c FROM nodes').get()?.c ?? 0;
      const active = this._db.prepare('SELECT COUNT(*) as c FROM nodes WHERE archived=0').get()?.c ?? 0;
      const byType = this._db.prepare(
        'SELECT type, COUNT(*) as c FROM nodes WHERE archived=0 GROUP BY type'
      ).all();

      const appHistoryToday = this.getTodayAppHistory().length;
      const appHistoryTotal = this._db.prepare(
        'SELECT COUNT(*) as c FROM app_history'
      ).get()?.c ?? 0;

      return {
        total, active, byType,
        appHistoryToday, appHistoryTotal,
        // FIX QW-1: exponer el estado del fallback en los stats
        usingFallback: this.usingFallback,
      };
    } catch {
      return { total: 0, active: 0, byType: [], appHistoryToday: 0, appHistoryTotal: 0, usingFallback: this.usingFallback };
    }
  }

  _findActiveNodeByLabel(label) {
    if (this.usingFallback) return null;
    return this._db.prepare(
      'SELECT * FROM nodes WHERE label=? AND archived=0 ORDER BY importance DESC LIMIT 1'
    ).get(label);
  }

  _archiveNode(id) {
    if (this.usingFallback) return;
    this._db.prepare(
      'UPDATE nodes SET archived=1, updated_at=? WHERE id=?'
    ).run(Date.now(), id);
  }

  _findDuplicateLabels() {
    if (this.usingFallback) return [];
    return this._db.prepare(`
      SELECT label, COUNT(*) as cnt
      FROM nodes WHERE archived=0 GROUP BY label HAVING cnt > 1
    `).all();
  }

  _findNodesByLabel(label) {
    if (this.usingFallback) return [];
    return this._db.prepare(`
      SELECT id FROM nodes WHERE label=? AND archived=0 ORDER BY last_accessed_at DESC, importance DESC
    `).all(label);
  }

  /**
   * Fase C: /olvida X. Archiva (soft-delete) los nodos activos que matcheen
   * `text` en label o content. Prioriza matches de label; si no hay ninguno,
   * archiva los primeros matches de contenido (hasta MAX=5) para no arrasar
   * memoria. Devuelve qué se encontró y qué se archivó.
   */
  forget(text) {
    const q = String(text || '').trim().toLowerCase();
    if (!q) return { found: 0, archived: 0, nodes: [], error: 'texto vacío' };

    const rows = this._db.prepare(`
      SELECT id, label, content, type FROM nodes
      WHERE archived=0 AND (label LIKE ? OR content LIKE ?)
      ORDER BY importance DESC
      LIMIT 20
    `).all(`%${q}%`, `%${q}%`);

    if (!rows.length) return { found: 0, archived: 0, nodes: [] };

    const byLabel = rows.filter(r => (r.label || '').toLowerCase().includes(q));
    const targets = (byLabel.length ? byLabel : rows.slice(0, 5));

    const nodes = [];
    for (const t of targets) {
      if (this.usingFallback) break;
      this._archiveNode(t.id);
      nodes.push({ id: t.id, type: t.type, label: t.label, content: String(t.content || '').slice(0, 80) });
    }

    return {
      found: rows.length,
      archived: nodes.length,
      nodes,
      warning: this.usingFallback ? 'memoria en RAM (no persistente): el archivo no sobrevive al reinicio' : null,
    };
  }

  close() {
    if (this.usingFallback) return;
    try { this._db?.close(); } catch(e) { console.warn('[state-graph] error al cerrar db:', e.message); }
  }
}

// ── Singleton por proceso ─────────────────────────────────────────────────────
let _instance = null;

function getStateGraph(dbPath) {
  if (!_instance) {
    _instance = new StateGraph(dbPath).init();
  }
  return _instance;
}

module.exports = { StateGraph, getStateGraph, NODE_TYPES, DECAY_RATES };
