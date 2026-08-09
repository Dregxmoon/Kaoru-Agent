// @ts-nocheck
'use strict';
const logger = require('../../observability/Logger.js');

const { DECAY_RATES, NODE_TYPES } = require('./constants');

class NodeStore {
  constructor(db, graph) {
    this._db = db;
    this._g = graph;
  }

  createNode({ type, label, content, importance = 1.0, tags = [] }) {
    if (!NODE_TYPES.includes(type)) throw new Error(`Tipo inválido: ${type}`);
    const now = Date.now();
    const result = this._db
      .prepare(
        `
      INSERT INTO nodes (type, label, content, importance, decay_rate, tags, created_at, updated_at, last_accessed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        type,
        label,
        content,
        importance,
        DECAY_RATES[type],
        JSON.stringify(tags),
        now,
        now,
        now
      );
    this._g._scheduleNodeEmbedding(result.lastInsertRowid, content);
    return result.lastInsertRowid;
  }

  updateNode(id, { content, label, importance, tags } = {}) {
    const now = Date.now();
    const node = this.getNode(id);
    if (!node) return false;

    const newImportance = importance ?? node.importance;
    const newContent = content ?? node.content;
    const newLabel = label ?? node.label;
    const newTags = tags ?? JSON.parse(node.tags || '[]');

    this._db
      .prepare(
        `
      UPDATE nodes
      SET content=?, label=?, importance=?, tags=?, updated_at=?, last_accessed_at=?, access_count=access_count+1
      WHERE id=?
    `
      )
      .run(newContent, newLabel, newImportance, JSON.stringify(newTags), now, now, id);

    if (content && content !== node.content) {
      this._g._scheduleNodeEmbedding(id, newContent);
    }

    return true;
  }

  getNode(id) {
    return this._db.prepare('SELECT * FROM nodes WHERE id=?').get(id) || null;
  }

  queryNodes({ type, search, limit = 20, includeArchived = false } = {}) {
    let sql = 'SELECT * FROM nodes WHERE 1=1';
    const args = [];

    if (!includeArchived) {
      sql += ' AND archived=0';
    }
    if (type) {
      sql += ' AND type=?';
      args.push(type);
    }
    if (search) {
      sql += ' AND (label LIKE ? OR content LIKE ?)';
      args.push(`%${search}%`, `%${search}%`);
    }

    sql += ' ORDER BY importance DESC LIMIT ?';
    args.push(limit);

    const results = this._db.prepare(sql).all(...args);

    if (!includeArchived) {
      this._touchNodes(results.map((n) => n.id).filter(Boolean), 'queryNodes');
    }

    return results;
  }

  getRecentEpisodes(limit = 20) {
    const results = this._db
      .prepare(
        `
      SELECT * FROM nodes
      WHERE type='Episode' AND archived=0
      ORDER BY importance DESC, created_at DESC
      LIMIT ?
    `
      )
      .all(limit);

    this._touchNodes(results.map((n) => n.id).filter(Boolean), 'getRecentEpisodes');

    return results;
  }

  getWorldModel() {
    const results = this._db
      .prepare(
        `
      SELECT * FROM nodes
      WHERE type IN ('User','Project','Preference','Belief')
        AND archived=0
      ORDER BY importance DESC
      LIMIT 30
    `
      )
      .all();

    // NO se toca last_accessed_at aquí (F2.1): el world model se lee en CADA
    // turno por ser contexto estable, así que contar esas lecturas como
    // "acceso del usuario" refrescaría recencia siempre y el decay jamás
    // llegaría al umbral de archivo. Solo los recalls intencionales
    // (queryNodes/getRecentEpisodes/queryNodesSemantic) alimentan la recencia.

    return results;
  }

  upsertNode({ type, label, content, importance, tags = [] }) {
    const existing = this._db
      .prepare('SELECT id FROM nodes WHERE type=? AND label=? AND archived=0 LIMIT 1')
      .get(type, label);

    if (existing) {
      this.updateNode(existing.id, { content, importance, tags });
      return existing.id;
    }
    return this.createNode({ type, label, content, importance, tags });
  }

  _touchNodes(ids, label = '') {
    if (!ids?.length || this._g.usingFallback) return;
    try {
      const now = Date.now();
      const placeholders = ids.map(() => '?').join(',');
      this._db
        .prepare(
          `UPDATE nodes SET last_accessed_at=?, access_count=access_count+1 WHERE id IN (${placeholders}) AND archived=0`
        )
        .run(now, ...ids);
    } catch (e) {
      logger.warn(
        'NodeStore',
        `[state-graph] error actualizando last_accessed_at (${label || 'touch'}):`,
        e.message
      );
    }
  }

  _findActiveNodeByLabel(label) {
    if (this._g.usingFallback) return null;
    return this._db
      .prepare('SELECT * FROM nodes WHERE label=? AND archived=0 ORDER BY importance DESC LIMIT 1')
      .get(label);
  }

  _archiveNode(id) {
    if (this._g.usingFallback) return;
    this._db.prepare('UPDATE nodes SET archived=1, updated_at=? WHERE id=?').run(Date.now(), id);
    // F2.1: al archivar se elimina también el vector semántico del nodo para
    // que no quede stale en node_vectors (ocupa espacio y poluciona el KNN).
    this._g._vectors?._deleteVector(id);
  }

  _findDuplicateLabels() {
    if (this._g.usingFallback) return [];
    return this._db
      .prepare(
        `
      SELECT label, COUNT(*) as cnt
      FROM nodes WHERE archived=0 GROUP BY label HAVING cnt > 1
    `
      )
      .all();
  }

  _findNodesByLabel(label) {
    if (this._g.usingFallback) return [];
    return this._db
      .prepare(
        `
      SELECT id FROM nodes WHERE label=? AND archived=0 ORDER BY last_accessed_at DESC, importance DESC
    `
      )
      .all(label);
  }

  forget(text) {
    const q = String(text || '')
      .trim()
      .toLowerCase();
    if (!q) return { found: 0, archived: 0, nodes: [], error: 'texto vacío' };

    const rows = this._db
      .prepare(
        `
      SELECT id, label, content, type FROM nodes
      WHERE archived=0 AND (label LIKE ? OR content LIKE ?)
      ORDER BY importance DESC
      LIMIT 20
    `
      )
      .all(`%${q}%`, `%${q}%`);

    if (!rows.length) return { found: 0, archived: 0, nodes: [] };

    const byLabel = rows.filter((r) => (r.label || '').toLowerCase().includes(q));
    const targets = byLabel.length ? byLabel : rows.slice(0, 5);

    const nodes = [];
    for (const t of targets) {
      if (this._g.usingFallback) break;
      this._archiveNode(t.id);
      nodes.push({
        id: t.id,
        type: t.type,
        label: t.label,
        content: String(t.content || '').slice(0, 80),
      });
    }

    return {
      found: rows.length,
      archived: nodes.length,
      nodes,
      warning: this._g.usingFallback
        ? 'memoria en RAM (no persistente): el archivo no sobrevive al reinicio'
        : null,
    };
  }
}

module.exports = { NodeStore };
