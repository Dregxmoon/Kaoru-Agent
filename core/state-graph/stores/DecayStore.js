'use strict';

const { ARCHIVE_THRESHOLD } = require('./constants');

class DecayStore {
  constructor(db) {
    this._db = db;
  }

  applyDecay() {
    const now = Date.now();
    const nodes = this._db
      .prepare('SELECT id, importance, decay_rate, last_accessed_at FROM nodes WHERE archived=0')
      .all();

    const update = this._db.prepare('UPDATE nodes SET importance=? WHERE id=?');
    const archive = this._db.prepare('UPDATE nodes SET archived=1 WHERE id=?');

    const runDecay = this._db.transaction(() => {
      let decayed = 0,
        archived = 0;

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
}

module.exports = { DecayStore };
