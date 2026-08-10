// @ts-nocheck
const logger = require('../observability/Logger.js');
/**
 * StateGraph.js — Fase 2 + Quick Fixes + Fase 3b (separación en stores)
 *
 * Esta clase es ahora una fachada: mantiene el ciclo de vida (init/schema/
 * migración/fallback), la cola de embeddings y delega el resto a los stores
 * en core/state-graph/stores/:
 *   - NodeStore          → CRUD + consulta de nodos, forget
 *   - VectorIndex        → recall semántico (sqlite-vec) + backfill
 *   - SessionStore       → sesiones y su historial
 *   - AppHistoryStore    → uso de aplicaciones (Fase 2)
 *   - DecayStore         → decay de importancia y archivado
 *   - ConsolidatorStore  → consolidación episodio→semántica (Fase 2, ítem 2)
 *   - IntentionsStore    → metas persistentes: stack de intenciones activas (Fase 3, ítem 1)
 */

const path = require('path');
const fs = require('fs');

const { NodeStore } = require('./stores/NodeStore.js');
const { VectorIndex } = require('./stores/VectorIndex.js');
const { SessionStore } = require('./stores/SessionStore.js');
const { AppHistoryStore } = require('./stores/AppHistoryStore.js');
const { DecayStore } = require('./stores/DecayStore.js');
const { ConsolidatorStore } = require('./stores/ConsolidatorStore.js');
const { IntentionsStore } = require('./stores/IntentionsStore.js');
const { NODE_TYPES, DECAY_RATES } = require('./stores/constants.js');

let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  logger.warn('StateGraph', '[state-graph] better-sqlite3 no disponible, usando modo memoria');
  logger.warn(
    'StateGraph',
    '[state-graph]   Solución: npm install (reconstruye módulos nativos para Electron)'
  );
  Database = null;
}

let _memoryDBSilentWarningShown = false;

class MemoryStatement {
  constructor(db, sql) {
    this._db = db;
    this._sql = sql.trim().replace(/\s+/g, ' ');
    this._classify();
  }

  _classify() {
    const s = this._sql;
    if (/^(CREATE|PRAGMA|BEGIN|COMMIT)/i.test(s)) {
      this._kind = 'noop';
      return;
    }
    if (/^INSERT INTO (node_vectors|app_history)/i.test(s)) {
      this._kind = 'noop';
      return;
    }
    if (/^DELETE FROM (node_vectors|app_history)/i.test(s)) {
      this._kind = 'noop';
      return;
    }
    if (/^SELECT name FROM sqlite_master/i.test(s)) {
      this._kind = 'meta';
      return;
    }
    if (/^INSERT INTO nodes/i.test(s)) {
      this._kind = 'insertNode';
      return;
    }
    if (/^INSERT INTO sessions/i.test(s)) {
      this._kind = 'insertSession';
      return;
    }
    if (/^UPDATE nodes/i.test(s)) {
      this._kind = 'updateNodes';
      return;
    }
    if (/^UPDATE sessions/i.test(s)) {
      this._kind = 'updateSessions';
      return;
    }
    if (/^SELECT \* FROM sessions/i.test(s)) {
      this._kind = 'selectSessions';
      return;
    }
    if (/^SELECT \* FROM nodes/i.test(s)) {
      this._kind = 'selectNodes';
      return;
    }
    if (/^SELECT id, importance, decay_rate, last_accessed_at FROM nodes/i.test(s)) {
      this._kind = 'selectDecay';
      return;
    }
    if (/^SELECT id FROM nodes/i.test(s)) {
      this._kind = 'selectNodeIds';
      return;
    }
    if (/^SELECT label, COUNT\(\*\) as cnt FROM nodes/i.test(s)) {
      this._kind = 'selectDupLabels';
      return;
    }
    if (/^SELECT type, COUNT\(\*\) as c FROM nodes/i.test(s)) {
      this._kind = 'selectTypeCount';
      return;
    }
    if (/^SELECT COUNT\(\*\) as c FROM nodes/i.test(s)) {
      this._kind = 'selectCount';
      return;
    }
    this._kind = 'noop';
  }

  _descs() {
    const out = [];
    const re = /\?/g;
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
        case 'id':
          list = list.filter((n) => n.id === v);
          break;
        case 'ids':
          ids.push(v);
          break;
        case 'like':
          list = list.filter((n) => (n.label || '').includes(v) || (n.content || '').includes(v));
          break;
        case 'type':
          list = list.filter((n) => n.type === v);
          break;
        case 'label':
          list = list.filter((n) => n.label === v);
          break;
        case 'archived':
          list = list.filter((n) => n.archived === v);
          break;
        case 'limit':
          list = list.slice(0, v);
          break;
        default:
          break;
      }
    }
    if (ids.length) list = list.filter((n) => ids.includes(n.id));

    if (this._sql.includes('archived=0')) list = list.filter((n) => n.archived === 0);
    else if (this._sql.includes('archived=1')) list = list.filter((n) => n.archived === 1);
    const typeIn = this._sql.match(/type IN \(([^)]+)\)/);
    if (typeIn) {
      const types = typeIn[1].split(',').map((x) => x.trim().replace(/'/g, ''));
      list = list.filter((n) => types.includes(n.type));
    }
    const eq = this._sql.match(/type='([^']+)'/);
    if (eq) list = list.filter((n) => n.type === eq[1]);
    if (this._sql.includes('history_json IS NOT NULL'))
      list = list.filter((n) => n.history_json != null);

    const orderBy = this._sql.match(/ORDER BY ([^L]+?)(?:LIMIT|$)/);
    if (orderBy) {
      const parts = orderBy[1]
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        const desc = p.endsWith(' DESC');
        const col = p.replace(/ DESC$/, '').trim();
        list.sort((a, b) => {
          const av = a[col],
            bv = b[col];
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
    const setParamCount = (setClause.match(/\?/g) || []).length;
    const setArgs = args.slice(0, setParamCount);
    let si = 0;
    const assigns = [];
    for (const piece of setClause
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)) {
      const m = piece.match(/^([\w_]+)\s*=\s*(.+)$/);
      if (!m) continue;
      const col = m[1],
        rhs = m[2];
      if (rhs === '?') assigns.push({ col, value: setArgs[si++] });
      else if (/^[\w_]+\s*\+\s*\d+$/.test(rhs)) {
        const [c, add] = rhs.split('+').map((x) => x.trim());
        assigns.push({ col, value: undefined, inc: { c, add: Number(add) } });
      } else if (/^\d+$/.test(rhs)) assigns.push({ col, value: Number(rhs) });
      else assigns.push({ col, value: rhs.replace(/^['"]|['"]$/g, '') });
    }
    return assigns;
  }

  run(...args) {
    if (this._kind === 'insertNode') {
      const cols =
        (this._sql.match(/\(([^)]+)\)\s*VALUES/) || [])[1]
          ?.split(',')
          .map((c) => c.trim().replace(/['"`]/g, '')) || [];
      const id = this._db._nextId++;
      const node = { id, archived: 0, access_count: 0 };
      cols.forEach((c, i) => {
        node[c] = args[i];
      });
      if (typeof node.tags !== 'string') node.tags = JSON.stringify(node.tags || []);
      this._db._nodes.set(id, node);
      return { lastInsertRowid: id, changes: 1 };
    }
    if (this._kind === 'insertSession') {
      const id = this._db._nextSessionId++;
      this._db._sessions.set(id, {
        id,
        started_at: args[0],
        ended_at: null,
        summary: null,
        turn_count: 0,
        episode_id: null,
        history_json: null,
      });
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
    if (this._kind === 'selectNodeIds') return this._nodes(args).map((n) => ({ id: n.id }));
    if (this._kind === 'selectDecay') {
      return this._nodes(args).map((n) => ({
        id: n.id,
        importance: n.importance,
        decay_rate: n.decay_rate,
        last_accessed_at: n.last_accessed_at,
      }));
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
      if (d === 'since') list = list.filter((x) => x.started_at > v);
      else if (d === 'id') list = list.filter((x) => x.id === v);
      else if (d === 'limit') list = list.slice(0, v);
    }
    if (this._sql.includes('ended_at IS NULL')) list = list.filter((x) => x.ended_at == null);
    else if (this._sql.includes('ended_at IS NOT NULL'))
      list = list.filter((x) => x.ended_at != null);
    if (this._sql.includes('history_json IS NOT NULL'))
      list = list.filter((x) => x.history_json != null);
    list.sort((a, b) => (b.started_at || 0) - (a.started_at || 0));
    const lm = this._sql.match(/LIMIT (\d+)/);
    if (lm) list = list.slice(0, Number(lm[1]));
    return list;
  }
}

class MemoryDB {
  constructor() {
    this._nodes = new Map();
    this._sessions = new Map();
    this._nextId = 1;
    this._nextSessionId = 1;
    if (!_memoryDBSilentWarningShown) {
      _memoryDBSilentWarningShown = true;
      setInterval(
        () => {
          logger.warn(
            'StateGraph',
            '[state-graph] MemoryDB activo — los datos NO persisten en disco. better-sqlite3 no está disponible.'
          );
        },
        5 * 60 * 1000
      );
    }
  }
  prepare(sql) {
    return new MemoryStatement(this, sql);
  }
  exec() {}
  transaction(fn) {
    return fn;
  }
  pragma() {}
  close() {}
}

class StateGraph {
  constructor(dbPath) {
    this._dbPath = dbPath;
    this._db = null;
    this._ready = false;
    this.usingFallback = false;
    this._vectorReady = false;
    this._vectorReadyPromise = Promise.resolve();
    this._embeddingQueue = [];
    this._embeddingInFlight = 0;
    this._embeddingMaxConcurrent = 2;
  }

  get isReady() {
    return this._ready;
  }

  init() {
    if (this._ready) return this;

    try {
      if (Database) {
        const dir = path.dirname(this._dbPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        this._db = new Database(this._dbPath);
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
      logger.info('StateGraph', '[state-graph] inicializado (Fase 2):', this._dbPath);
    } catch (e) {
      logger.error('StateGraph', '[state-graph] ERROR CRÍTICO — cayendo a MemoryDB:', e.message);
      logger.error(
        'StateGraph',
        '[state-graph] La memoria del asistente NO se esta guardando en disco.'
      );
      this._db = new MemoryDB();
      this.usingFallback = true;
      this._createSchema();
      this._ready = true;
    }

    this._initStores();
    return this;
  }

  _initStores() {
    this._nodes = new NodeStore(this._db, this);
    this._vectors = new VectorIndex(this._db, this);
    this._sessions = new SessionStore(this._db);
    this._appHistory = new AppHistoryStore(this._db);
    this._decay = new DecayStore(this._db);
    this._consolidator = new ConsolidatorStore(this._db, this);
    this._intentions = new IntentionsStore(this._db, this);
  }

  // Schema

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

      CREATE TABLE IF NOT EXISTS node_relations (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        target_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        type      TEXT    NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
      );

      CREATE INDEX IF NOT EXISTS idx_node_relations_source ON node_relations(source_id);
      CREATE INDEX IF NOT EXISTS idx_node_relations_target ON node_relations(target_id);

      CREATE TABLE IF NOT EXISTS intentions (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id    TEXT    NOT NULL,
        goal          TEXT    NOT NULL,
        status        TEXT    NOT NULL DEFAULT 'active',
        steps         TEXT    NOT NULL DEFAULT '[]',
        last_progress TEXT,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_intentions_active ON intentions(status, updated_at DESC);
    `);
  }

  _migrateSchema() {
    try {
      const tableExists = this._db
        .prepare(
          `
        SELECT name FROM sqlite_master
        WHERE type='table' AND name='app_history'
      `
        )
        .get();

      if (!tableExists) {
        logger.info('StateGraph', '[state-graph] migrando schema a Fase 2...');
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
        logger.info('StateGraph', '[state-graph] migración Fase 2 completada');
      }

      const sessionCols = this._db.prepare(`PRAGMA table_info(sessions)`).all();
      if (!sessionCols.some((c) => c.name === 'history_json')) {
        logger.info('StateGraph', '[state-graph] migrando schema: sessions.history_json...');
        this._db.exec(`ALTER TABLE sessions ADD COLUMN history_json TEXT;`);
      }

      const relationsTable = this._db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='node_relations'`)
        .get();
      if (!relationsTable) {
        logger.info('StateGraph', '[state-graph] migrando schema: node_relations...');
        this._db.exec(`
          CREATE TABLE IF NOT EXISTS node_relations (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            source_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
            target_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
            type      TEXT    NOT NULL,
            created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
          );

          CREATE INDEX IF NOT EXISTS idx_node_relations_source ON node_relations(source_id);
          CREATE INDEX IF NOT EXISTS idx_node_relations_target ON node_relations(target_id);
        `);
        logger.info('StateGraph', '[state-graph] migración node_relations completada');
      }

      const intentionsTable = this._db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='intentions'`)
        .get();
      if (!intentionsTable) {
        logger.info('StateGraph', '[state-graph] migrando schema: intentions...');
        this._db.exec(`
          CREATE TABLE IF NOT EXISTS intentions (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id    TEXT    NOT NULL,
            goal          TEXT    NOT NULL,
            status        TEXT    NOT NULL DEFAULT 'active',
            steps         TEXT    NOT NULL DEFAULT '[]',
            last_progress TEXT,
            created_at    INTEGER NOT NULL,
            updated_at    INTEGER NOT NULL
          );

          CREATE INDEX IF NOT EXISTS idx_intentions_active ON intentions(status, updated_at DESC);
        `);
        logger.info('StateGraph', '[state-graph] migración intentions completada');
      }
    } catch (e) {
      logger.warn('StateGraph', '[state-graph] error en migración (no crítico):', e.message);
    }
  }

  // Cola de embeddings

  _processEmbeddingQueue() {
    while (
      this._embeddingInFlight < this._embeddingMaxConcurrent &&
      this._embeddingQueue.length > 0
    ) {
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
      // F2.1-D: embeddings fuera del main thread (worker_threads vía EmbedService).
      const EmbedService = require('../grounding/EmbedService.js');
      const vec = await EmbedService.embedText(content.slice(0, 2000));
      this._vectors._upsertNodeVector(id, EmbedService.float32ToBuffer(vec));
    } catch (e) {
      logger.warn('StateGraph', `[state-graph] no se pudo embedear nodo ${id}:`, e.message);
    }
  }

  _scheduleNodeEmbedding(id, content) {
    if (!this._vectorReady || !id || !content) return;
    this._embeddingQueue.push({ id, content });
    this._processEmbeddingQueue();
  }

  // Delegación a stores

  enableVectorSearch() {
    return this._vectors.enableVectorSearch();
  }
  queryNodesSemantic(searchText, opts) {
    return this._vectors.queryNodesSemantic(searchText, opts);
  }
  backfillEmbeddings(batchSize) {
    return this._vectors.backfillEmbeddings(batchSize);
  }

  createNode(opts) {
    return this._nodes.createNode(opts);
  }
  updateNode(id, opts) {
    return this._nodes.updateNode(id, opts);
  }
  getNode(id) {
    return this._nodes.getNode(id);
  }
  queryNodes(opts) {
    return this._nodes.queryNodes(opts);
  }
  getRecentEpisodes(limit) {
    return this._nodes.getRecentEpisodes(limit);
  }
  getWorldModel() {
    return this._nodes.getWorldModel();
  }
  upsertNode(opts) {
    return this._nodes.upsertNode(opts);
  }
  forget(text) {
    return this._nodes.forget(text);
  }
  _touchNodes(ids, label) {
    return this._nodes._touchNodes(ids, label);
  }
  _findActiveNodeByLabel(label) {
    return this._nodes._findActiveNodeByLabel(label);
  }
  _archiveNode(id) {
    return this._nodes._archiveNode(id);
  }
  _findDuplicateLabels() {
    return this._nodes._findDuplicateLabels();
  }
  _findNodesByLabel(label) {
    return this._nodes._findNodesByLabel(label);
  }

  startSession() {
    return this._sessions.startSession();
  }
  endSession(id, opts) {
    return this._sessions.endSession(id, opts);
  }
  getLastSessions(limit) {
    return this._sessions.getLastSessions(limit);
  }
  updateSessionHistory(id, history) {
    return this._sessions.updateSessionHistory(id, history);
  }
  findResumableSession(maxAgeHours) {
    return this._sessions.findResumableSession(maxAgeHours);
  }

  saveAppHistory(opts) {
    return this._appHistory.saveAppHistory(opts);
  }
  getTodayAppHistory() {
    return this._appHistory.getTodayAppHistory();
  }
  getAppUsageSummary(days) {
    return this._appHistory.getAppUsageSummary(days);
  }
  getTodayAppSummaryString() {
    return this._appHistory.getTodayAppSummaryString();
  }
  pruneAppHistory(days) {
    return this._appHistory.pruneAppHistory(days);
  }

  applyDecay() {
    const result = this._decay.applyDecay();
    // F2.1: al archivar nodos, purga sus vectores semánticos para que no
    // queden stale en node_vectors.
    if (result?.archived > 0) {
      this._vectors.purgeArchivedVectors();
    }
    // F2 ítem 2: la consolidación episodio→semántica se ejecuta como job
    // piggyback del ciclo de mantenimiento (determinista, sin bloquear).
    try {
      this._consolidator.runConsolidation();
    } catch (e) {
      logger.warn('StateGraph', '[state-graph] consolidación fallida:', e.message);
    }
    return result;
  }

  runConsolidation(opts) {
    return this._consolidator.runConsolidation(opts);
  }
  getNodeRelations(nodeId) {
    return this._consolidator.getRelations(nodeId);
  }

  createIntention(opts) {
    return this._intentions.create(opts);
  }
  listActiveIntentions(opts) {
    return this._intentions.listActive(opts);
  }
  updateIntention(id, opts) {
    return this._intentions.update(id, opts);
  }
  completeIntention(id) {
    return this._intentions.complete(id);
  }
  dropIntention(id) {
    return this._intentions.drop(id);
  }
  getIntention(id) {
    return this._intentions.get(id);
  }
  intentionStats() {
    return this._intentions.getStats();
  }

  getStats() {
    try {
      const total = this._db.prepare('SELECT COUNT(*) as c FROM nodes').get()?.c ?? 0;
      const active =
        this._db.prepare('SELECT COUNT(*) as c FROM nodes WHERE archived=0').get()?.c ?? 0;
      const byType = this._db
        .prepare('SELECT type, COUNT(*) as c FROM nodes WHERE archived=0 GROUP BY type')
        .all();

      const appHistoryToday = this.getTodayAppHistory().length;
      const appHistoryTotal =
        this._db.prepare('SELECT COUNT(*) as c FROM app_history').get()?.c ?? 0;

      return {
        total,
        active,
        byType,
        appHistoryToday,
        appHistoryTotal,
        usingFallback: this.usingFallback,
      };
    } catch {
      return {
        total: 0,
        active: 0,
        byType: [],
        appHistoryToday: 0,
        appHistoryTotal: 0,
        usingFallback: this.usingFallback,
      };
    }
  }

  close() {
    if (this.usingFallback) return;
    try {
      this._db?.close();
    } catch (e) {
      logger.warn('StateGraph', '[state-graph] error al cerrar db:', e.message);
    }
  }
}

let _instance = null;

function getStateGraph(dbPath) {
  if (!_instance) {
    _instance = new StateGraph(dbPath).init();
  }
  return _instance;
}

module.exports = { StateGraph, getStateGraph, NODE_TYPES, DECAY_RATES };
