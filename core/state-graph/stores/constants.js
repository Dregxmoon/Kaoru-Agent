'use strict';

const { formatElapsed } = require('../../utils/format.js');

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
  return formatElapsed(seconds);
}

module.exports = {
  NODE_TYPES,
  DECAY_RATES,
  ARCHIVE_THRESHOLD,
  RECENCY_HALFLIFE_DAYS,
  SEMANTIC_CANDIDATES,
  _formatSec,
};
