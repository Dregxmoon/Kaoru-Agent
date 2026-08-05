'use strict';

const { _formatSec } = require('./constants');

class AppHistoryStore {
  constructor(db) {
    this._db = db;
  }

  saveAppHistory({ app, friendlyName, title, category, start, end, duration }) {
    if (!app || !start || !end || !duration) return;
    const dayKey = new Date(start).toISOString().slice(0, 10);
    try {
      this._db
        .prepare(
          `
        INSERT INTO app_history (app, friendly_name, title, category, start_ts, end_ts, duration_sec, day_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
        )
        .run(
          app,
          friendlyName || app,
          (title || '').slice(0, 200),
          category || 'other',
          start,
          end,
          duration,
          dayKey
        );
    } catch (e) {
      console.warn('[state-graph] error guardando app_history:', e.message);
    }
  }

  getTodayAppHistory() {
    const dayKey = new Date().toISOString().slice(0, 10);
    try {
      return this._db
        .prepare(
          `
        SELECT * FROM app_history
        WHERE day_key = ?
        ORDER BY start_ts ASC
      `
        )
        .all(dayKey);
    } catch (e) {
      console.warn('[state-graph] error leyendo app_history:', e.message);
      return [];
    }
  }

  getAppUsageSummary(days = 1) {
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    try {
      return this._db
        .prepare(
          `
        SELECT friendly_name, category, SUM(duration_sec) as total_sec
        FROM app_history
        WHERE start_ts >= ?
        GROUP BY app
        ORDER BY total_sec DESC
        LIMIT 15
      `
        )
        .all(since);
    } catch (e) {
      console.warn('[state-graph] error en app usage summary:', e.message);
      return [];
    }
  }

  getTodayAppSummaryString() {
    const summary = this.getAppUsageSummary(1);
    if (!summary.length) return null;

    return summary
      .slice(0, 6)
      .map(({ friendly_name, total_sec }) => `${friendly_name} (${_formatSec(total_sec)})`)
      .join(', ');
  }

  pruneAppHistory(days = 30) {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    try {
      const result = this._db.prepare('DELETE FROM app_history WHERE start_ts < ?').run(cutoff);
      if (result.changes > 0) {
        console.log(`[state-graph] app_history pruned: ${result.changes} entradas eliminadas`);
      }
    } catch (e) {
      console.warn('[state-graph] error en pruneAppHistory:', e.message);
    }
  }
}

module.exports = { AppHistoryStore };
