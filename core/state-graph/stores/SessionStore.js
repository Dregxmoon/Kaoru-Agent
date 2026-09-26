// @ts-nocheck
'use strict';
const logger = require('../../observability/Logger.js');

class SessionStore {
  constructor(db, graph = null) {
    this._db = db;
    this._graph = graph;
  }

  startSession(workspace = null) {
    const now = Date.now();
    const result = this._db
      .prepare('INSERT INTO sessions (started_at, workspace, last_active_at) VALUES (?, ?, ?)')
      .run(now, workspace, now);
    return result.lastInsertRowid;
  }

  getSession(id) {
    if (this._graph?.usingFallback) return this._db._sessions.get(id) || null;
    return this._db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) || null;
  }

  deleteEmptyConversation(id) {
    const row = this.getSession(id);
    if (
      !row ||
      Number(row.turn_count || 0) !== 0 ||
      (row.history_json && row.history_json !== '[]') ||
      row.summary ||
      row.episode_id
    )
      return false;
    if (this._graph?.usingFallback) return this._db._sessions.delete(id);
    return (
      this._db
        .prepare(
          `DELETE FROM sessions WHERE id = ? AND COALESCE(turn_count, 0) = 0
           AND (history_json IS NULL OR history_json = '[]')
           AND (summary IS NULL OR summary = '') AND episode_id IS NULL`
        )
        .run(id).changes > 0
    );
  }

  pruneEmptyConversations(exceptId = null) {
    if (this._graph?.usingFallback) {
      for (const id of [...this._db._sessions.keys()]) {
        if (id !== exceptId) this.deleteEmptyConversation(id);
      }
      return;
    }
    this._db
      .prepare(
        `DELETE FROM sessions WHERE (? IS NULL OR id != ?) AND COALESCE(turn_count, 0) = 0
         AND (history_json IS NULL OR history_json = '[]')
         AND (summary IS NULL OR summary = '') AND episode_id IS NULL`
      )
      .run(exceptId, exceptId);
  }

  listConversations(limit = 100) {
    if (this._graph?.usingFallback)
      return [...this._db._sessions.values()]
        .sort((a, b) => (b.last_active_at || b.started_at) - (a.last_active_at || a.started_at))
        .slice(0, limit);
    return this._db
      .prepare('SELECT * FROM sessions ORDER BY COALESCE(last_active_at, started_at) DESC LIMIT ?')
      .all(limit);
  }

  touchConversation(id, workspace = null) {
    if (this._graph?.usingFallback) {
      const row = this.getSession(id);
      if (row) {
        row.workspace = workspace || row.workspace;
        row.last_active_at = Date.now();
      }
      return;
    }
    this._db
      .prepare('UPDATE sessions SET workspace=COALESCE(?, workspace), last_active_at=? WHERE id=?')
      .run(workspace, Date.now(), id);
  }

  reopenConversation(id) {
    if (this._graph?.usingFallback) {
      const row = this.getSession(id);
      if (row) {
        row.ended_at = null;
        row.last_active_at = Date.now();
      }
      return;
    }
    this._db
      .prepare('UPDATE sessions SET ended_at=NULL, last_active_at=? WHERE id=?')
      .run(Date.now(), id);
  }

  endSession(sessionId, { summary, turnCount, episodeId } = {}) {
    const endedAt = Date.now();
    if (this._graph?.usingFallback && this._db._sessions) {
      const row = this._db._sessions.get(sessionId);
      if (row) {
        row.ended_at = endedAt;
        if (summary) row.summary = summary;
        row.turn_count = turnCount || 0;
        if (episodeId) row.episode_id = episodeId;
      }
      this._graph?.closeAutobiographicalSession?.(sessionId, endedAt);
      return;
    }
    this._db
      .prepare(
        `
      UPDATE sessions
      SET ended_at=?, summary=COALESCE(?, summary), turn_count=?, episode_id=COALESCE(?, episode_id)
      WHERE id=?
    `
      )
      .run(endedAt, summary || null, turnCount || 0, episodeId || null, sessionId);
    this._graph?.closeAutobiographicalSession?.(sessionId, endedAt);
  }

  getLastSessions(limit = 5) {
    return this._db
      .prepare(
        `
      SELECT * FROM sessions WHERE ended_at IS NOT NULL
      ORDER BY started_at DESC LIMIT ?
    `
      )
      .all(limit);
  }

  updateSessionHistory(sessionId, history, turnCount = null) {
    if (!sessionId) return;
    if (this._graph?.usingFallback && this._db._sessions) {
      const row = this._db._sessions.get(sessionId);
      if (row) {
        row.history_json = JSON.stringify(history || []);
        if (turnCount != null) row.turn_count = turnCount;
        row.last_active_at = Date.now();
      }
      return;
    }
    try {
      this._db
        .prepare(
          'UPDATE sessions SET history_json=?, turn_count=COALESCE(?, turn_count), last_active_at=? WHERE id=?'
        )
        .run(JSON.stringify(history || []), turnCount, Date.now(), sessionId);
    } catch (e) {
      logger.warn('SessionStore', '[state-graph] error guardando history_json:', e.message);
    }
  }

  updateMemoryCursor(sessionId, cursor, { summary = null, episodeId = null } = {}) {
    if (!sessionId || !Number.isFinite(cursor)) return false;
    if (this._graph?.usingFallback && this._db._sessions) {
      const row = this._db._sessions.get(sessionId);
      if (!row) return false;
      row.memory_cursor = Math.max(row.memory_cursor || 0, cursor);
      if (summary) row.summary = row.summary ? `${row.summary} | ${summary}` : summary;
      if (!row.episode_id && episodeId) row.episode_id = episodeId;
      return true;
    }
    try {
      this._db
        .prepare(
          `UPDATE sessions
           SET memory_cursor=MAX(memory_cursor, ?),
               summary=CASE
                 WHEN ? IS NULL OR ? = '' THEN summary
                 WHEN summary IS NULL OR summary = '' THEN ?
                 ELSE summary || ' | ' || ?
               END,
               episode_id=COALESCE(episode_id, ?)
           WHERE id=?`
        )
        .run(cursor, summary, summary, summary, summary, episodeId, sessionId);
      return true;
    } catch (e) {
      logger.warn('SessionStore', '[state-graph] error guardando memory_cursor:', e.message);
      return false;
    }
  }

  findResumableSession(maxAgeHours = 12) {
    try {
      const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;
      const row = this._db
        .prepare(
          `
        SELECT * FROM sessions
        WHERE ended_at IS NULL AND started_at > ? AND history_json IS NOT NULL
        ORDER BY started_at DESC LIMIT 1
      `
        )
        .get(cutoff);

      if (!row) return null;

      let history = [];
      try {
        history = JSON.parse(row.history_json) || [];
      } catch (_) {
        history = [];
      }
      if (!history.length) return null;

      return {
        id: row.id,
        history,
        turnCount: row.turn_count || history.length,
        memoryCursor: row.memory_cursor || 0,
        startedAt: row.started_at,
      };
    } catch (e) {
      logger.warn('SessionStore', '[state-graph] error buscando sesión resumible:', e.message);
      return null;
    }
  }
}

module.exports = { SessionStore };
