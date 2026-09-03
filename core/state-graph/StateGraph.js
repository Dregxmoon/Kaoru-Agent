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
 *   - FactReasonerStore  → vigencia de hechos fijos y cascada de invalidación (F3.1)
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
const { FactReasonerStore } = require('./stores/FactReasonerStore.js');
const { IntentionsStore } = require('./stores/IntentionsStore.js');
const { ObservationStore } = require('./stores/ObservationStore.js');
const { WorkingMemoryStore } = require('./stores/WorkingMemoryStore.js');
const { GoalPlanStore } = require('./stores/GoalPlanStore.js');
const { CausalMemoryStore } = require('./stores/CausalMemoryStore.js');
const { AutobiographicalMemoryStore } = require('./stores/AutobiographicalMemoryStore.js');
const { MetamemoryStore } = require('./stores/MetamemoryStore.js');
const { MemoryRevisionStore } = require('./stores/MemoryRevisionStore.js');
const { MemoryPrivacyStore } = require('./stores/MemoryPrivacyStore.js');
const { EvolutionStore } = require('./evolution/EvolutionStore.js');
const { FeedbackScorer } = require('./evolution/FeedbackScorer.js');
const { LLMEotionDetector } = require('./evolution/LLMEotionDetector.js');
const { TraitLearner } = require('./evolution/TraitLearner.js');
const { CommunicationStyleProfiler } = require('./evolution/CommunicationStyleProfiler.js');
const { TopicMomentumTracker } = require('./evolution/TopicMomentumTracker.js');
const { AdaptiveResponseEngine } = require('./evolution/AdaptiveResponseEngine.js');
const { EmotionalTrendTracker } = require('./evolution/EmotionalTrendTracker.js');
const { PromptEnforcer } = require('../behavior/proactive/PromptEnforcer.js');
const { ResponseEvaluator } = require('../behavior/proactive/ResponseEvaluator.js');
const { UserModelBuilder } = require('./UserModelBuilder.js');
const { ContradictionResolver } = require('./ContradictionResolver.js');
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
    // F3.3: separación hechos/inferencias también en modo memoria (RAM).
    if (this._sql.includes('inferred=1')) list = list.filter((n) => n.inferred === 1);
    else if (this._sql.includes('inferred=0')) list = list.filter((n) => n.inferred !== 1);
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
        const byConfidenceTimesImportance = col.includes('COALESCE(confidence');
        list.sort((a, b) => {
          const av = byConfidenceTimesImportance
            ? (a.confidence ?? 0) * (a.importance ?? 0)
            : a[col];
          const bv = byConfidenceTimesImportance
            ? (b.confidence ?? 0) * (b.importance ?? 0)
            : b[col];
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
        memory_cursor: 0,
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
    this.fallbackReason = null;
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
        this.fallbackReason = null;
      } else {
        const err = new Error('better-sqlite3 no disponible');
        err.code = 'BETTER_SQLITE3_MISSING';
        throw err;
      }

      this._migrateLegacyRelations();
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
      this.fallbackReason = (e && e.message) || String(e);
      this._createSchema();
      this._ready = true;
    }

    this._initStores();
    return this;
  }

  _initStores() {
    this._nodes = new NodeStore(this._db, this);
    this._vectors = new VectorIndex(this._db, this);
    this._sessions = new SessionStore(this._db, this);
    this._appHistory = new AppHistoryStore(this._db);
    this._decay = new DecayStore(this._db);
    this._consolidator = new ConsolidatorStore(this._db, this);
    this._factReasoner = new FactReasonerStore(this._db, this);
    this._intentions = new IntentionsStore(this._db, this);
    this._observations = new ObservationStore(this._db, this);
    this._workingMemory = new WorkingMemoryStore(this._db, this);
    this._goalPlans = new GoalPlanStore(this._db, this);
    this._causalMemory = new CausalMemoryStore(this._db, this);
    this._autobiographical = new AutobiographicalMemoryStore(this._db, this);
    this._autobiographical.backfillLegacy(200);
    this._memoryRevisions = new MemoryRevisionStore(this._db, this);
    this._metamemory = new MetamemoryStore(this._db, this);
    this._memoryPrivacy = new MemoryPrivacyStore(this._db, this);
    this._resolver = new ContradictionResolver(this);
    this._userModel = new UserModelBuilder(this._db, this);
    this._evolution = new EvolutionStore(this._db);
    // Las tablas evolutivas (communication_profiles/topic_momentum/emotional_
    // history) se crean AQUÍ: _createSchema() corre antes de que exista
    // this._evolution y el guard interno nunca se ejecutaba en DBs preexistentes.
    this._evolution.createSchema();
    this._traitLearner = new TraitLearner(this._evolution);
    this._commStyleProfiler = new CommunicationStyleProfiler(this._evolution);
    this._topicTracker = new TopicMomentumTracker(this._evolution);
    this._feedbackScorer = new FeedbackScorer(this._evolution);
    this._adaptiveEngine = new AdaptiveResponseEngine(
      this._traitLearner,
      this._commStyleProfiler,
      this._topicTracker,
      this._feedbackScorer
    );
    this._emotionalTrendTracker = new EmotionalTrendTracker(this._evolution);
    this._llmEmotionDetector = null; // se inicializa cuando el LLM esté disponible
    this._promptEnforcer = null; // se inicializa después
    this._responseEvaluator = null; // se inicializa después
  }

  // Schema

  /**
   * Pre-migración de schemas heredados ANTES de `_createSchema()`.
   *
   * `_createSchema()` crea índices sobre columnas nuevas (`node_relations(
   * source_id)`); si la DB en disco viene de una versión anterior, la tabla
   * `node_relations` existe con el esquema viejo (`from_id/to_id/rel_type/
   * weight`) y el `CREATE INDEX` fallaría, provocando el fallback a MemoryDB.
   * Esta pasada detecta ese caso y reconstruye la tabla con el esquema nuevo,
   * migrando los datos.
   * @private
   */
  _migrateLegacyRelations() {
    const cols = this._db.prepare(`PRAGMA table_info(node_relations)`).all();
    if (!cols.length) return; // no existe todavía: _createSchema() la crea
    if (cols.some((c) => c.name === 'source_id')) return; // ya es el esquema nuevo

    logger.info('StateGraph', '[state-graph] migrando node_relations (schema legacy)...');
    this._db.exec(`
      ALTER TABLE node_relations RENAME TO node_relations_legacy;
      CREATE TABLE node_relations (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        target_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        type      TEXT    NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
      );
      INSERT INTO node_relations (source_id, target_id, type, created_at)
        SELECT from_id, to_id, rel_type, COALESCE(created_at, strftime('%s','now') * 1000)
        FROM node_relations_legacy;
      DROP TABLE node_relations_legacy;
    `);
    logger.info('StateGraph', '[state-graph] migración node_relations completada');
  }

  _createSchema() {
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        type             TEXT    NOT NULL CHECK(type IN ('User','Episode','Belief','Preference','Project','Emotion','Interaction','Pattern','Relation')),
        label            TEXT    NOT NULL,
        content          TEXT    NOT NULL,
        importance       REAL    NOT NULL DEFAULT 1.0,
        decay_rate       REAL    NOT NULL DEFAULT 0.05,
        access_count     INTEGER NOT NULL DEFAULT 0,
        tags             TEXT    DEFAULT '[]',
        archived         INTEGER NOT NULL DEFAULT 0,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL,
        last_accessed_at INTEGER NOT NULL,
        verified_at      INTEGER,
        inferred         INTEGER NOT NULL DEFAULT 0,
        confidence       REAL
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
        episode_id INTEGER REFERENCES nodes(id),
        memory_cursor INTEGER NOT NULL DEFAULT 0
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
        last_progress_at INTEGER,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_intentions_active ON intentions(status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS goal_steps (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        intention_id     INTEGER NOT NULL REFERENCES intentions(id) ON DELETE CASCADE,
        ordinal          INTEGER NOT NULL,
        parent_ordinal   INTEGER,
        description      TEXT NOT NULL,
        status           TEXT NOT NULL DEFAULT 'pending',
        depends_on       TEXT NOT NULL DEFAULT '[]',
        success_criteria TEXT NOT NULL DEFAULT '[]',
        verification     TEXT,
        trigger_context  TEXT,
        due_at           INTEGER,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL,
        UNIQUE(intention_id, ordinal)
      );

      CREATE INDEX IF NOT EXISTS idx_goal_steps_intention ON goal_steps(intention_id, ordinal);
      CREATE INDEX IF NOT EXISTS idx_goal_steps_status ON goal_steps(status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS goal_events (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        intention_id  INTEGER NOT NULL REFERENCES intentions(id) ON DELETE CASCADE,
        step_ordinal   INTEGER,
        event_type     TEXT NOT NULL,
        metadata       TEXT NOT NULL DEFAULT '{}',
        created_at     INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_goal_events_intention ON goal_events(intention_id, id DESC);

      CREATE TABLE IF NOT EXISTS task_outcome_evidence (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id          TEXT NOT NULL,
        mode                TEXT NOT NULL,
        difficulty          TEXT NOT NULL DEFAULT 'unknown',
        strategy            TEXT NOT NULL,
        outcome             TEXT NOT NULL,
        verification_status TEXT NOT NULL,
        verification_reason TEXT,
        tools               TEXT NOT NULL DEFAULT '[]',
        elapsed_ms          INTEGER NOT NULL DEFAULT 0,
        created_at          INTEGER NOT NULL,
        consolidated_at     INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_task_evidence_pending
        ON task_outcome_evidence(consolidated_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_task_evidence_strategy
        ON task_outcome_evidence(strategy, created_at);

      CREATE TABLE IF NOT EXISTS causal_hypotheses (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        signature        TEXT NOT NULL UNIQUE,
        cause            TEXT NOT NULL,
        effect           TEXT NOT NULL,
        support_count    INTEGER NOT NULL,
        contradict_count INTEGER NOT NULL,
        confidence       REAL NOT NULL,
        status           TEXT NOT NULL DEFAULT 'inferred',
        evidence_ids     TEXT NOT NULL DEFAULT '[]',
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_causal_hypotheses_status
        ON causal_hypotheses(status, confidence DESC);

      CREATE TABLE IF NOT EXISTS autobiographical_events (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id        INTEGER NOT NULL UNIQUE REFERENCES nodes(id) ON DELETE CASCADE,
        session_id     TEXT,
        occurred_at    INTEGER NOT NULL,
        ended_at       INTEGER,
        salience       REAL NOT NULL DEFAULT 0.5,
        evidence_count INTEGER NOT NULL DEFAULT 0,
        source         TEXT NOT NULL DEFAULT 'session_summary',
        created_at     INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_autobiographical_time
        ON autobiographical_events(occurred_at DESC);
      CREATE INDEX IF NOT EXISTS idx_autobiographical_session
        ON autobiographical_events(session_id, occurred_at);

      CREATE TABLE IF NOT EXISTS memory_revisions (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        label            TEXT NOT NULL,
        node_type        TEXT NOT NULL,
        policy           TEXT NOT NULL,
        previous_node_id INTEGER NOT NULL,
        current_node_id  INTEGER NOT NULL,
        previous_content TEXT NOT NULL,
        current_content  TEXT NOT NULL,
        reason           TEXT,
        source           TEXT NOT NULL DEFAULT 'memory_pipeline',
        evidence_ids     TEXT NOT NULL DEFAULT '[]',
        created_at       INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memory_revisions_label
        ON memory_revisions(label, id ASC);
      CREATE INDEX IF NOT EXISTS idx_memory_revisions_current
        ON memory_revisions(current_node_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS interaction_log (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id    TEXT,
        interaction_type TEXT NOT NULL,
        content       TEXT,
        metadata      TEXT DEFAULT '{}',
        created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
      );

      CREATE INDEX IF NOT EXISTS idx_interaction_log_type ON interaction_log(interaction_type);
      CREATE INDEX IF NOT EXISTS idx_interaction_log_session ON interaction_log(session_id);

      CREATE TABLE IF NOT EXISTS observations (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        source        TEXT NOT NULL,
        kind          TEXT NOT NULL,
        content       TEXT NOT NULL DEFAULT '',
        metadata      TEXT NOT NULL DEFAULT '{}',
        session_id    TEXT,
        sensitivity   TEXT NOT NULL DEFAULT 'private',
        occurred_at   INTEGER NOT NULL,
        expires_at    INTEGER,
        processed_at  INTEGER,
        dedupe_key    TEXT UNIQUE
      );

      CREATE INDEX IF NOT EXISTS idx_observations_session ON observations(session_id, occurred_at);
      CREATE INDEX IF NOT EXISTS idx_observations_pending ON observations(processed_at, occurred_at);

      CREATE TABLE IF NOT EXISTS memory_evidence (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id        INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        observation_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
        relation       TEXT NOT NULL DEFAULT 'SUPPORTS',
        confidence     REAL NOT NULL DEFAULT 1.0,
        created_at     INTEGER NOT NULL,
        UNIQUE(node_id, observation_id, relation)
      );

      CREATE INDEX IF NOT EXISTS idx_memory_evidence_node ON memory_evidence(node_id);
      CREATE INDEX IF NOT EXISTS idx_memory_evidence_observation ON memory_evidence(observation_id);

      CREATE TABLE IF NOT EXISTS working_memory (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        scope                 TEXT NOT NULL,
        key                   TEXT NOT NULL,
        value                 TEXT NOT NULL,
        confidence            REAL NOT NULL DEFAULT 1.0,
        source_observation_id INTEGER REFERENCES observations(id) ON DELETE SET NULL,
        expires_at            INTEGER,
        updated_at            INTEGER NOT NULL,
        UNIQUE(scope, key)
      );

      CREATE INDEX IF NOT EXISTS idx_working_memory_scope ON working_memory(scope, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_working_memory_expiry ON working_memory(expires_at);
    `);

    // Evolutionary memory tables
    if (this._evolution) {
      this._evolution.createSchema();
    }
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
      if (!sessionCols.some((c) => c.name === 'memory_cursor')) {
        logger.info('StateGraph', '[state-graph] migrando schema: sessions.memory_cursor...');
        this._db.exec(`ALTER TABLE sessions ADD COLUMN memory_cursor INTEGER NOT NULL DEFAULT 0;`);
      }

      const nodeCols = this._db.prepare(`PRAGMA table_info(nodes)`).all();
      const nodeNames = new Set(nodeCols.map((c) => c.name));
      const nodeAlters = [];
      // F3.1-standards: los FIXED_LABELS dejan de ser "se escribe una vez y se
      // confía para siempre" — ganan una noción de vigencia (verified_at),
      // origen (inferred) y certeza (confidence). Ver FactReasonerStore.js.
      if (!nodeNames.has('verified_at')) {
        nodeAlters.push('ALTER TABLE nodes ADD COLUMN verified_at INTEGER');
      }
      if (!nodeNames.has('inferred')) {
        nodeAlters.push('ALTER TABLE nodes ADD COLUMN inferred INTEGER NOT NULL DEFAULT 0');
      }
      if (!nodeNames.has('confidence')) {
        nodeAlters.push('ALTER TABLE nodes ADD COLUMN confidence REAL');
      }
      if (nodeAlters.length > 0) {
        logger.info('StateGraph', '[state-graph] migrando schema: nodes verificación de hechos...');
        this._db.exec(nodeAlters.join('; '));
        // Backfill conservador: para filas existentes no sabemos cuándo se
        // confirmó por última vez el hecho — se usa el dato más conservador
        // disponible (created_at), no una fecha inventada.
        this._db.exec(`UPDATE nodes SET verified_at = created_at WHERE verified_at IS NULL;`);
        logger.info('StateGraph', '[state-graph] migración nodes verificación completada');
      }
      // Las consolidaciones históricas eran recurrencias léxicas guardadas
      // como hechos. Se reclasifican como inferencias para no contaminar el
      // world model factual.
      this._db.exec(
        `UPDATE nodes
         SET inferred=1, confidence=COALESCE(confidence, 0.55), decay_rate=0.06
         WHERE label LIKE 'consolidacion_%' AND archived=0;`
      );

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

      // Proactividad con intenciones: `last_progress_at` (cuándo hubo actividad
      // por última vez) no existía en el schema heredado — solo estaba
      // `last_progress` (TEXT, la descripción del progreso, no un timestamp).
      // Misma estrategia guardada que nodes.verified_at: PRAGMA table_info +
      // ALTER TABLE ADD COLUMN + backfill con created_at (el dato más
      // conservador disponible, no una fecha inventada).
      const intentionCols = this._db.prepare(`PRAGMA table_info(intentions)`).all();
      if (!intentionCols.some((c) => c.name === 'last_progress_at')) {
        logger.info('StateGraph', '[state-graph] migrando schema: intentions.last_progress_at...');
        this._db.exec(`ALTER TABLE intentions ADD COLUMN last_progress_at INTEGER;`);
        this._db.exec(
          `UPDATE intentions SET last_progress_at = created_at WHERE last_progress_at IS NULL;`
        );
        logger.info('StateGraph', '[state-graph] migración intentions.last_progress_at completada');
      }

      // Compatibilidad con builds intermedios del grafo prospectivo.
      const goalStepCols = this._db.prepare(`PRAGMA table_info(goal_steps)`).all();
      if (!goalStepCols.some((c) => c.name === 'trigger_context')) {
        this._db.exec(`ALTER TABLE goal_steps ADD COLUMN trigger_context TEXT;`);
      }
      if (!goalStepCols.some((c) => c.name === 'due_at')) {
        this._db.exec(`ALTER TABLE goal_steps ADD COLUMN due_at INTEGER;`);
      }

      // Compatibilidad con builds intermedios de la memoria causal. La tabla
      // final se crea antes de esta migración; este ALTER sólo aplica si el
      // usuario alcanzó a iniciar una versión que aún no separaba dificultad.
      const outcomeCols = this._db.prepare(`PRAGMA table_info(task_outcome_evidence)`).all();
      if (outcomeCols.length && !outcomeCols.some((c) => c.name === 'difficulty')) {
        this._db.exec(
          `ALTER TABLE task_outcome_evidence ADD COLUMN difficulty TEXT NOT NULL DEFAULT 'unknown';`
        );
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
  updateNode(id, opts = {}) {
    const existing = this._nodes.getNode(id);
    const revision = opts.revision;
    const { revision: _revision, ...nodeUpdate } = opts;
    const changesContent =
      existing && nodeUpdate.content !== undefined && nodeUpdate.content !== existing.content;
    if (!changesContent || revision === false || !this._memoryRevisions) {
      return this._nodes.updateNode(id, nodeUpdate);
    }

    let updated = false;
    const apply = this._db.transaction(() => {
      updated = this._nodes.updateNode(id, nodeUpdate);
      if (!updated) throw new Error(`No se pudo actualizar el nodo ${id}`);
      this._memoryRevisions.record({
        label: nodeUpdate.label || existing.label,
        type: existing.type,
        policy: revision?.policy || 'direct_update',
        previousNodeId: Number(existing.id),
        currentNodeId: Number(existing.id),
        previousContent: existing.content,
        currentContent: nodeUpdate.content,
        reason: revision?.reason || 'actualización directa del nodo',
        source: revision?.source || 'state_graph',
        evidenceIds: revision?.evidenceIds || [],
      });
    });
    apply();
    return updated;
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
  getWorldModel(context = null) {
    return this._nodes.getWorldModel(context);
  }

  /**
   * Modelo inferido del usuario (F3.3): nodos `inferred=1` activos, ordenados
   * por `confidence × importance`. SEPARADO de `getWorldModel()` (hechos).
   * @param {{limit?: number}} [opts]
   * @returns {Array<object>}
   */
  getUserModel({ limit = 8 } = {}) {
    return this._nodes.queryInferredModels({ limit });
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

  /**
   * Ejecuta una pasada de vigencia de hechos fijos (FactReasonerStore).
   * @returns {{ checked: number, stale: number }}
   */
  runFactReasoner() {
    return this._factReasoner ? this._factReasoner.run() : { checked: 0, stale: 0 };
  }

  /**
   * Cascada de invalidación tras un overwrite de un label en CASCADE_STALENESS.
   * Lo invoca ContradictionResolver._applyPolicy.
   * @param {string} label
   * @returns {number}
   */
  _invalidateCascade(label) {
    return this._factReasoner ? this._factReasoner.invalidateCascade(label) : 0;
  }

  /**
   * Registra una relación semántica entre dos nodos (node_relations).
   * Idempotente: no duplica el mismo par+type.
   * @param {{ source: number, target: number, type: string }} rel
   * @returns {boolean} true si se insertó
   */
  createRelation({ source, target, type }) {
    if (!this.isReady) return false;
    if (!source || !target || source === target) return false;
    try {
      const exists = this._db
        .prepare('SELECT id FROM node_relations WHERE source_id=? AND target_id=? AND type=?')
        .get(source, target, String(type).toUpperCase());
      if (exists) return false;
      this._db
        .prepare('INSERT INTO node_relations (source_id, target_id, type) VALUES (?,?,?)')
        .run(source, target, String(type).toUpperCase());
      return true;
    } catch (e) {
      logger.warn('StateGraph', '[state-graph] error en createRelation:', e.message);
      return false;
    }
  }

  /**
   * Contradicciones sin resolver (relación CONTRADICES entre nodos activos).
   * @returns {Array<{label:string,a:number,b:number,contentA:string,contentB:string}>}
   */
  getTensions() {
    return this._resolver ? this._resolver.getTensions() : [];
  }

  // ── Dynamic Node Creation ──────────────────────────────────────────────────

  /**
   * Crea un nodo dinámicamente si no existe uno similar.
   * @param {{ type: string, label: string, content: string, importance?: number, tags?: string[] }} opts
   * @returns {number|null} ID del nodo creado o existente
   */
  createDynamicNode({ type, label, content, importance = 1.0, tags = [] }) {
    if (!this.isReady) return null;
    try {
      // Buscar nodo existente por label y tipo
      const existing = this._db
        .prepare('SELECT id FROM nodes WHERE type=? AND label=? AND archived=0')
        .get(type, label);
      if (existing) {
        // Actualizar contenido si es diferente
        const node = this._db.prepare('SELECT content FROM nodes WHERE id=?').get(existing.id);
        if (node && node.content !== content) {
          this._nodes.updateNode(existing.id, { content, importance });
        }
        return existing.id;
      }
      // Crear nuevo nodo
      return this._nodes.createNode({ type, label, content, importance, tags });
    } catch (e) {
      logger.warn('StateGraph', '[state-graph] error en createDynamicNode:', e.message);
      return null;
    }
  }

  /**
   * Registra una interacción del usuario.
   * @param {{ type: string, content: string, metadata?: object, sessionId?: string }} opts
   * @returns {number|null}
   */
  logInteraction({ type, content, metadata = {}, sessionId = null }) {
    if (!this.isReady) return null;
    try {
      const result = this._db
        .prepare(
          'INSERT INTO interaction_log (session_id, interaction_type, content, metadata) VALUES (?, ?, ?, ?)'
        )
        .run(sessionId, type, content, JSON.stringify(metadata));
      return result.lastInsertRowid;
    } catch (e) {
      logger.warn('StateGraph', '[state-graph] error en logInteraction:', e.message);
      return null;
    }
  }

  /**
   * Obtiene interacciones recientes por tipo.
   * @param {{ type?: string, limit?: number }} opts
   * @returns {Array<object>}
   */
  getInteractions({ type = null, limit = 20 } = {}) {
    if (!this.isReady) return [];
    try {
      let sql = 'SELECT * FROM interaction_log WHERE 1=1';
      const args = [];
      if (type) {
        sql += ' AND interaction_type=?';
        args.push(type);
      }
      sql += ' ORDER BY created_at DESC LIMIT ?';
      args.push(limit);
      return this._db.prepare(sql).all(...args);
    } catch (e) {
      logger.warn('StateGraph', '[state-graph] error en getInteractions:', e.message);
      return [];
    }
  }

  /**
   * Obtiene nodos por tipo con opciones de filtrado.
   * @param {{ type: string, limit?: number, minImportance?: number }} opts
   * @returns {Array<object>}
   */
  getNodesByType({ type, limit = 20, minImportance = 0 } = {}) {
    if (!this.isReady) return [];
    try {
      return this._db
        .prepare(
          'SELECT * FROM nodes WHERE type=? AND archived=0 AND importance>=? ORDER BY importance DESC LIMIT ?'
        )
        .all(type, minImportance, limit);
    } catch (e) {
      logger.warn('StateGraph', '[state-graph] error en getNodesByType:', e.message);
      return [];
    }
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
  updateSessionHistory(id, history, turnCount) {
    return this._sessions.updateSessionHistory(id, history, turnCount);
  }
  updateSessionMemoryCursor(id, cursor, opts) {
    return this._sessions.updateMemoryCursor(id, cursor, opts);
  }
  findResumableSession(maxAgeHours) {
    return this._sessions.findResumableSession(maxAgeHours);
  }

  recordObservation(opts) {
    return this._observations.record(opts);
  }
  listObservations(opts) {
    return this._observations.list(opts);
  }
  markObservationsProcessed(ids) {
    return this._observations.markProcessed(ids);
  }
  linkMemoryEvidence(nodeId, observationIds, confidence) {
    return this._observations.linkEvidence(nodeId, observationIds, confidence);
  }
  getMemoryEvidence(nodeId) {
    return this._observations.getEvidence(nodeId);
  }
  pruneExpiredObservations() {
    return this._observations.pruneExpired();
  }
  getObservationStats() {
    return this._observations.getStats();
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
    this._observations.pruneExpired();
    this._workingMemory.pruneExpired();
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
    // F3.1: la vigencia de los hechos fijos también es un job piggyback del
    // ciclo de mantenimiento — mismo patrón no-bloqueante que la consolidación.
    try {
      this._factReasoner.run();
    } catch (e) {
      logger.warn('StateGraph', '[state-graph] fact-reasoner fallido:', e.message);
    }
    // F3.3: el modelo del usuario inferido corre DESPUÉS de la consolidación
    // (necesita la señal de qué episodios quedaron sin modelar). Es async
    // (usa LLM), así que se dispara sin esperar — mismo patrón no-bloqueante.
    try {
      this._userModel.run().catch((e) => {
        logger.warn('StateGraph', '[state-graph] user-model fallido:', e.message);
      });
    } catch (e) {
      logger.warn('StateGraph', '[state-graph] user-model fallido:', e.message);
    }
    return result;
  }

  /**
   * Ejecuta una pasada de inferencia del modelo de usuario (UserModelBuilder).
   * @param {object} [opts]
   * @returns {Promise<{clusters:number, inferred:number, merged:number, rejected:number, skipped:number}>}
   */
  runUserModel(opts) {
    return this._userModel
      ? this._userModel.run(opts)
      : Promise.resolve({ clusters: 0, inferred: 0, merged: 0, rejected: 0, skipped: 0 });
  }

  /**
   * Gancho de la Fase 5: confirma o rechaza un nodo inferido.
   * @param {number} nodeId
   * @param {'accepted' | 'rejected'} outcome
   */
  confirmInferred(nodeId, outcome) {
    return this._userModel
      ? this._userModel.confirmInferred(nodeId, outcome)
      : { ok: false, reason: 'no_user_model' };
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
  listStaleIntentions(opts) {
    return this._intentions.listStale(opts);
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

  createGoalPlan(intentionId, steps) {
    return this._goalPlans.createPlan(intentionId, steps);
  }
  getGoalPlan(intentionId) {
    return this._goalPlans.listSteps(intentionId);
  }
  updateGoalStep(intentionId, ordinal, update) {
    return this._goalPlans.updateStep(intentionId, ordinal, update);
  }
  getGoalResumePoint(intentionId) {
    return this._goalPlans.getResumePoint(intentionId);
  }
  recordGoalRunProgress(intentionId, plan) {
    return this._goalPlans.recordRunProgress(intentionId, plan);
  }
  completeGoalPlan(intentionId, verification) {
    return this._goalPlans.completePlan(intentionId, verification);
  }
  recordGoalEvent(intentionId, ordinal, type, metadata) {
    return this._goalPlans.recordEvent(intentionId, ordinal, type, metadata);
  }
  listGoalEvents(intentionId, opts) {
    return this._goalPlans.listEvents(intentionId, opts);
  }
  matchProspectiveGoals(event, payload, now) {
    return this._goalPlans.findCues(event, payload, now);
  }

  recordTaskOutcomeEvidence(outcome) {
    return this._causalMemory.recordOutcome(outcome);
  }
  runCausalConsolidation(opts) {
    return this._causalMemory.consolidate(opts);
  }
  listCausalHypotheses(opts) {
    return this._causalMemory.listHypotheses(opts);
  }
  decideCausalHypothesis(signature, decision) {
    return this._causalMemory.decide(signature, decision);
  }
  buildCausalMemorySection() {
    return this._causalMemory.buildPromptSection();
  }

  registerAutobiographicalEpisode(nodeId, opts) {
    return this._autobiographical.registerEpisode(nodeId, opts);
  }
  closeAutobiographicalSession(sessionId, endedAt) {
    return this._autobiographical.closeSession(sessionId, endedAt);
  }
  recallAutobiographical(opts) {
    return this._autobiographical.recall(opts);
  }
  runAutobiographicalMaintenance(limit) {
    return this._autobiographical.backfillLegacy(limit);
  }
  assessMemoryRecall(input) {
    return this._metamemory.assessRecall(input);
  }
  assessMemoryNode(node, metadata, now) {
    if (metadata) return this._metamemory.assessNode(node, metadata, now);
    const assessment = this._metamemory.assessRecall({ nodes: [node], now });
    return assessment.nodes[0]?._metamemory || this._metamemory.assessNode(node, {}, now);
  }
  _recordMemoryRevision(input) {
    return this._memoryRevisions.record(input);
  }
  _getMemoryRevisionMetadata(ids) {
    return this._memoryRevisions.getMetadata(ids);
  }
  _deleteMemoryRevisions(labels) {
    return this._memoryRevisions.deleteForLabels(labels);
  }
  getMemoryRevisionHistory(opts) {
    return this._memoryRevisions.getHistory(opts);
  }
  resolveMemoryTension(opts) {
    return this._resolver.resolveTension(opts);
  }
  inspectMemory(nodeId, opts) {
    return this._memoryPrivacy.inspect(nodeId, opts);
  }
  exportMemorySnapshot(opts) {
    return this._memoryPrivacy.exportSnapshot(opts);
  }
  correctMemory(opts) {
    return this._memoryPrivacy.correct(opts);
  }
  deleteMemoryLineage(opts) {
    return this._memoryPrivacy.deleteLineage(opts);
  }

  setWorkingMemory(opts) {
    return this._workingMemory.set(opts);
  }
  getWorkingMemory(scope, key) {
    return this._workingMemory.get(scope, key);
  }
  listWorkingMemory(scope) {
    return this._workingMemory.list(scope);
  }
  clearWorkingMemory(scope, key) {
    return this._workingMemory.clear(scope, key);
  }
  buildWorkingMemorySection(scope) {
    return this._workingMemory.buildPromptSection(scope);
  }

  // Evolutionary memory accessors
  getTraitLearner() {
    return this._traitLearner;
  }

  getCommStyleProfiler() {
    return this._commStyleProfiler;
  }

  getTopicTracker() {
    return this._topicTracker;
  }

  getAdaptiveEngine() {
    return this._adaptiveEngine;
  }

  getEvolutionStore() {
    return this._evolution;
  }

  getFeedbackScorer() {
    return this._feedbackScorer;
  }

  getLLMEotionDetector() {
    return this._llmEmotionDetector;
  }

  getEmotionalTrendTracker() {
    return this._emotionalTrendTracker;
  }

  getPromptEnforcer() {
    return this._promptEnforcer;
  }

  getResponseEvaluator() {
    return this._responseEvaluator;
  }

  /**
   * Inicializa el detector de emociones con el LLM provider.
   * Llamado después de que el LLM está listo.
   * @param {Object} llmProvider
   */
  initEmotionDetector(llmProvider) {
    if (llmProvider && !this._llmEmotionDetector) {
      this._llmEmotionDetector = new LLMEotionDetector(llmProvider, { timeoutMs: 2000 });
      logger.info('StateGraph', 'LLM emotion detector inicializado');
    }
    // Inicializar PromptEnforcer y ResponseEvaluator cuando el LLM esté disponible
    if (!this._promptEnforcer) {
      this._promptEnforcer = new PromptEnforcer(this._feedbackScorer, this._emotionalTrendTracker);
      logger.info('StateGraph', 'PromptEnforcer inicializado');
    }
    if (!this._responseEvaluator) {
      this._responseEvaluator = new ResponseEvaluator(this._feedbackScorer);
      logger.info('StateGraph', 'ResponseEvaluator inicializado');
    }
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
        observations: this._observations.getStats(),
        evolution: this._evolution ? this._evolution.getStats() : null,
        usingFallback: this.usingFallback,
      };
    } catch {
      return {
        total: 0,
        active: 0,
        byType: [],
        appHistoryToday: 0,
        appHistoryTotal: 0,
        observations: { total: 0, pending: 0, evidenceLinks: 0 },
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
