// @ts-check
'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const REOPEN_GRACE_MS = 7 * DAY_MS;
const MAX_BACKOFF_MS = 30 * DAY_MS;

class ActiveLearningStore {
  /** @param {any} db @param {{usingFallback?:boolean}} graph */
  constructor(db, graph) {
    this._db = db;
    this._graph = graph;
    /** @type {Map<string, any>} */
    this._fallback = new Map();
  }

  /**
   * Sincroniza el inventario actual y devuelve únicamente huecos elegibles.
   * Que un hueco desaparezca significa que la memoria ya contiene una
   * respuesta; si reaparece más adelante, se aplica una gracia antes de volver
   * a preguntar.
   * @param {Array<{key:string,trait:string,priority?:number}>} gaps
   * @param {number} [now]
   * @returns {Array<{key:string,trait:string,priority:number,askCount:number}>}
   */
  syncAndListEligible(gaps, now = Date.now()) {
    const normalized = this._normalizeGaps(gaps);
    if (this._graph.usingFallback) return this._syncFallback(normalized, now);

    const currentKeys = new Set(normalized.map((gap) => gap.key));
    const transaction = this._db.transaction(() => {
      const previous = /** @type {any[]} */ (
        this._db.prepare('SELECT gap_key, status FROM active_learning_questions').all()
      );
      const markAnswered = this._db.prepare(
        `UPDATE active_learning_questions
         SET status='answered', answered_at=?, updated_at=? WHERE gap_key=?`
      );
      for (const row of previous) {
        if (!currentKeys.has(String(row.gap_key)) && row.status !== 'answered') {
          markAnswered.run(now, now, row.gap_key);
        }
      }

      const get = this._db.prepare('SELECT * FROM active_learning_questions WHERE gap_key=?');
      const insert = this._db.prepare(
        `INSERT INTO active_learning_questions
          (gap_key, trait, priority, status, ask_count, next_eligible_at, created_at, updated_at)
         VALUES (?, ?, ?, 'open', 0, ?, ?, ?)`
      );
      const refresh = this._db.prepare(
        `UPDATE active_learning_questions
         SET trait=?, priority=?, status='open', answered_at=NULL,
             next_eligible_at=?, updated_at=? WHERE gap_key=?`
      );
      const update = this._db.prepare(
        'UPDATE active_learning_questions SET trait=?, priority=?, updated_at=? WHERE gap_key=?'
      );
      for (const gap of normalized) {
        const row = get.get(gap.key);
        if (!row) insert.run(gap.key, gap.trait, gap.priority, now, now, now);
        else if (row.status === 'answered') {
          refresh.run(gap.trait, gap.priority, now + REOPEN_GRACE_MS, now, gap.key);
        } else update.run(gap.trait, gap.priority, now, gap.key);
      }
    });
    transaction();

    return /** @type {any[]} */ (
      this._db
        .prepare(
          `SELECT gap_key, trait, priority, ask_count FROM active_learning_questions
           WHERE status!='answered' AND next_eligible_at<=?
           ORDER BY priority DESC, ask_count ASC, updated_at ASC`
        )
        .all(now)
    ).map((row) => ({
      key: String(row.gap_key),
      trait: String(row.trait),
      priority: Number(row.priority),
      askCount: Number(row.ask_count),
    }));
  }

  /** @param {{key:string,trait:string,proposalId?:string|null,now?:number}} input */
  recordAsked(input) {
    const key = this._safeKey(input?.key);
    if (!key) return false;
    const now = Number(input.now) || Date.now();
    const proposalId = input.proposalId ? String(input.proposalId).slice(0, 100) : null;
    if (this._graph.usingFallback) {
      const row = this._fallback.get(key) || this._newRow(key, input.trait, 0.5, now);
      row.askCount += 1;
      row.status = 'asked';
      row.askedAt = now;
      row.nextEligibleAt = now + this._backoff(row.askCount);
      row.lastProposalId = proposalId;
      row.updatedAt = now;
      this._fallback.set(key, row);
      return true;
    }
    const row = this._db
      .prepare('SELECT ask_count FROM active_learning_questions WHERE gap_key=?')
      .get(key);
    const askCount = Number(row?.ask_count || 0) + 1;
    const result = this._db
      .prepare(
        `UPDATE active_learning_questions
         SET status='asked', ask_count=?, asked_at=?, next_eligible_at=?,
             last_proposal_id=?, updated_at=? WHERE gap_key=?`
      )
      .run(askCount, now, now + this._backoff(askCount), proposalId, now, key);
    return result.changes === 1;
  }

  /** @param {{key:string,outcome:'accepted'|'rejected'|'ignored',now?:number}} input */
  recordOutcome(input) {
    const key = this._safeKey(input?.key);
    if (!key || !['accepted', 'rejected', 'ignored'].includes(input.outcome)) return false;
    const now = Number(input.now) || Date.now();
    const extraDelay = input.outcome === 'rejected' ? 30 * DAY_MS : 14 * DAY_MS;
    if (this._graph.usingFallback) {
      const row = this._fallback.get(key);
      if (!row) return false;
      row.lastOutcome = input.outcome;
      row.nextEligibleAt = Math.max(row.nextEligibleAt, now + extraDelay);
      row.updatedAt = now;
      return true;
    }
    const result = this._db
      .prepare(
        `UPDATE active_learning_questions
         SET last_outcome=?, next_eligible_at=MAX(next_eligible_at, ?), updated_at=?
         WHERE gap_key=?`
      )
      .run(input.outcome, now + extraDelay, now, key);
    return result.changes === 1;
  }

  /** @param {Array<{key:string,trait:string,priority?:number}>} gaps @param {number} now */
  _syncFallback(gaps, now) {
    const currentKeys = new Set(gaps.map((gap) => gap.key));
    for (const row of this._fallback.values()) {
      if (!currentKeys.has(row.key)) {
        row.status = 'answered';
        row.answeredAt = now;
      }
    }
    for (const gap of gaps) {
      let row = this._fallback.get(gap.key);
      if (!row) {
        row = this._newRow(gap.key, gap.trait, Number(gap.priority) || 0.5, now);
        this._fallback.set(gap.key, row);
      } else if (row.status === 'answered') {
        row.status = 'open';
        row.answeredAt = null;
        row.nextEligibleAt = now + REOPEN_GRACE_MS;
      }
      row.trait = gap.trait;
      row.priority = gap.priority;
      row.updatedAt = now;
    }
    return [...this._fallback.values()]
      .filter((row) => row.status !== 'answered' && row.nextEligibleAt <= now)
      .sort((a, b) => b.priority - a.priority || a.askCount - b.askCount)
      .map((row) => ({
        key: row.key,
        trait: row.trait,
        priority: row.priority,
        askCount: row.askCount,
      }));
  }

  /** @param {Array<{key:string,trait:string,priority?:number}>} gaps */
  _normalizeGaps(gaps) {
    const found = new Map();
    for (const gap of gaps || []) {
      const key = this._safeKey(gap?.key);
      const trait = String(gap?.trait || '')
        .trim()
        .slice(0, 200);
      if (!key || !trait) continue;
      found.set(key, {
        key,
        trait,
        priority: Math.max(0, Math.min(1, Number(gap.priority) || 0.5)),
      });
    }
    return [...found.values()];
  }

  /** @param {number} askCount */
  _backoff(askCount) {
    return Math.min(MAX_BACKOFF_MS, REOPEN_GRACE_MS * Math.max(1, 2 ** (askCount - 1)));
  }

  /** @param {unknown} value */
  _safeKey(value) {
    const key = String(value || '')
      .trim()
      .slice(0, 80);
    return /^[a-z0-9_-]+$/i.test(key) ? key : '';
  }

  /** @param {string} key @param {string} trait @param {number} priority @param {number} now */
  _newRow(key, trait, priority, now) {
    return {
      key,
      trait: String(trait || '').slice(0, 200),
      priority,
      status: 'open',
      askCount: 0,
      askedAt: null,
      answeredAt: null,
      nextEligibleAt: now,
      lastProposalId: null,
      lastOutcome: null,
      createdAt: now,
      updatedAt: now,
    };
  }
}

module.exports = { ActiveLearningStore };
