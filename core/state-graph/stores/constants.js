'use strict';

const NODE_TYPES = ['User', 'Episode', 'Belief', 'Preference', 'Project'];

const DECAY_RATES = {
  User: 0.005,
  Episode: 0.08,
  Belief: 0.02,
  Preference: 0.01,
  Project: 0.03,
};

const ARCHIVE_THRESHOLD = 0.05;
const RECENCY_HALFLIFE_DAYS = 21;
const SEMANTIC_CANDIDATES = 24;

function _formatSec(seconds) {
  if (!seconds || seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `${hrs}h ${rem}m` : `${hrs}h`;
}

function _touchNodes(db, ids, label) {
  if (!ids || !ids.length) return;
  const now = Date.now();
  const stmt = db.prepare(`
    UPDATE nodes
    SET last_accessed_at = ?, access_count = access_count + 1
    WHERE id = ?
  `);
  const tx = db.transaction((ids) => {
    for (const id of ids) stmt.run(now, id);
  });
  tx(ids);
}

module.exports = {
  NODE_TYPES,
  DECAY_RATES,
  ARCHIVE_THRESHOLD,
  RECENCY_HALFLIFE_DAYS,
  SEMANTIC_CANDIDATES,
  _formatSec,
  _touchNodes,
};