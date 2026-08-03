'use strict';

class RelationsStore {
  constructor(db) {
    this._db = db;
  }

  createRelation(fromId, toId, relType, weight = 1.0) {
    try {
      this._db.prepare(`
        INSERT OR REPLACE INTO node_relations (from_id, to_id, rel_type, weight, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(fromId, toId, relType, weight, Date.now());
    } catch(_) {}
  }
}

module.exports = { RelationsStore };