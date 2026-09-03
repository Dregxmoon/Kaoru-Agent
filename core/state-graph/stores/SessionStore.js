// @ts-nocheck
'use strict';
const logger = require('../../observability/Logger.js');

class SessionStore {
  constructor(db, graph = null) {
    this._db = db;
    this._graph = graph;
  }

  startSession() {
    const result = this._db.prepare('INSERT INTO sessions (started_at) VALUES (?)').run(Date.now());
    return result.lastInsertRowid;
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
      }
      return;
    }
    try {
      this._db
        .prepare(
          'UPDATE sessions SET history_json=?, turn_count=COALESCE(?, turn_count) WHERE id=?'
        )
        .run(JSON.stringify(history || []), turnCount, sessionId);
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
