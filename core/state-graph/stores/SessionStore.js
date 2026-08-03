'use strict';

class SessionStore {
  constructor(db) {
    this._db = db;
  }

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

  updateSessionHistory(sessionId, history) {
    if (!sessionId) return;
    try {
      this._db.prepare('UPDATE sessions SET history_json=? WHERE id=?')
        .run(JSON.stringify(history || []), sessionId);
    } catch(e) {
      console.warn('[state-graph] error guardando history_json:', e.message);
    }
  }

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
}

module.exports = { SessionStore };