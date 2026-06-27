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

// ── DB en memoria como fallback ───────────────────────────────────────────────
class MemoryDB {
  constructor() {
    this._nodes  = new Map();
    this._nextId = 1;
  }
  prepare(sql) {
    const db = this;
    return {
      run:  (...args) => ({ lastInsertRowid: db._nextId++ }),
      get:  (...args) => undefined,
      all:  (...args) => [],
    };
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
    // FIX QW-1: flag público — true si no pudo iniciar SQLite real
    this.usingFallback = false;
  }

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
      console.error('[state-graph] ⚠ La memoria de March NO se está guardando en disco.');
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
    } catch(e) {
      console.warn('[state-graph] error en migración (no crítico):', e.message);
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
    return result.lastInsertRowid;
  }

  updateNode(id, { content, label, importance, tags } = {}) {
    const now  = Date.now();
    const node = this.getNode(id);
    if (!node) return false;

    const newImportance = importance ?? Math.min(1.0, node.importance + 0.2);
    const newContent    = content    ?? node.content;
    const newLabel      = label      ?? node.label;
    const newTags       = tags       ?? JSON.parse(node.tags || '[]');

    this._db.prepare(`
      UPDATE nodes
      SET content=?, label=?, importance=?, tags=?, updated_at=?, last_accessed_at=?, access_count=access_count+1
      WHERE id=?
    `).run(newContent, newLabel, newImportance, JSON.stringify(newTags), now, now, id);

    return true;
  }

  getNode(id) {
    return this._db.prepare('SELECT * FROM nodes WHERE id=?').get(id) || null;
  }

  /**
   * FIX QW-2c: helper centralizado de "touch" — actualiza last_accessed_at
   * y access_count de forma lazy/fire-and-forget para una lista de ids.
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
    const now = Date.now();
    setImmediate(() => {
      try {
        const placeholders = ids.map(() => '?').join(',');
        this._db.prepare(
          `UPDATE nodes SET last_accessed_at=?, access_count=access_count+1 WHERE id IN (${placeholders}) AND archived=0`
        ).run(now, ...ids);
      } catch(e) {
        // No crítico — el decay simplemente no ve este acceso
        console.warn(`[state-graph] error actualizando last_accessed_at (${label || 'touch'}):`, e.message);
      }
    });
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

    const update  = this._db.prepare('UPDATE nodes SET importance=?, updated_at=? WHERE id=?');
    const archive = this._db.prepare('UPDATE nodes SET archived=1, updated_at=? WHERE id=?');

    const runDecay = this._db.transaction(() => {
      let decayed = 0, archived = 0;

      for (const node of nodes) {
        // FIX QW-2: daysSince usa last_accessed_at (que ahora se actualiza
        // también en queryNodes/getRecentEpisodes/getWorldModel), no solo
        // updated_at. Un nodo leído frecuentemente no decae como si fuera
        // abandonado.
        const daysSince = (now - node.last_accessed_at) / (1000 * 60 * 60 * 24);
        if (daysSince < 1) continue;

        const newImportance = node.importance * Math.pow(1 - node.decay_rate, daysSince);

        if (newImportance < ARCHIVE_THRESHOLD) {
          archive.run(now, node.id);
          archived++;
        } else {
          update.run(Math.round(newImportance * 10000) / 10000, now, node.id);
          decayed++;
        }
      }

      console.log(`[state-graph] decay: ${decayed} actualizados, ${archived} archivados`);
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

  close() {
    try { this._db?.close(); } catch(_) {}
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