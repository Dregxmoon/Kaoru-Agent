// @ts-check
'use strict';

const crypto = require('crypto');
const logger = require('../../observability/Logger.js');

const VALID_DECISIONS = new Set(['accepted', 'rejected']);
const SUCCESS_STATUSES = new Set(['verified', 'not_applicable']);
const EVIDENCE_STATUSES = new Set(['verified', 'not_applicable', 'failed']);

/** @param {unknown} e */
function _errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}

/** @param {unknown} raw @param {any} fallback @returns {any} */
function _json(raw, fallback) {
  try {
    return JSON.parse(String(raw));
  } catch (_) {
    return fallback;
  }
}

/** @param {string[]} tools */
function _strategy(tools) {
  const stable = [...new Set(tools.map(String).filter(Boolean))].sort().slice(0, 12);
  return stable.length ? stable.join('+') : 'text_only';
}

class CausalMemoryStore {
  /** @param {any} db @param {{usingFallback?:boolean}} graph */
  constructor(db, graph) {
    this._db = db;
    this._graph = graph;
    /** @type {any[]} */
    this._fallbackEvidence = [];
    /** @type {Map<string, any>} */
    this._fallbackHypotheses = new Map();
  }

  /**
   * @param {{sessionId?:string|null, mode?:string, difficulty?:string, success?:boolean, terminalSuccess?:boolean, verificationStatus?:string, verificationReason?:string|null, successfulTools?:string[], elapsedMs?:number|null, ts?:number}} outcome
   */
  recordOutcome(outcome = {}) {
    const verificationStatus = String(outcome.verificationStatus || 'unknown');
    const verificationAcceptable = SUCCESS_STATUSES.has(verificationStatus);
    const observedOutcome =
      outcome.success && verificationAcceptable
        ? 'success'
        : verificationStatus === 'failed'
          ? 'failure'
          : 'unverified';
    const tools = Array.isArray(outcome.successfulTools) ? outcome.successfulTools : [];
    const row = {
      sessionId: String(outcome.sessionId || 'unknown').slice(0, 160),
      mode: String(outcome.mode || 'unknown').slice(0, 40),
      difficulty: String(outcome.difficulty || 'unknown').slice(0, 40),
      strategy:
        `${String(outcome.mode || 'unknown')}:` +
        `${String(outcome.difficulty || 'unknown')}:${_strategy(tools)}`,
      outcome: observedOutcome,
      verificationStatus,
      verificationReason: String(outcome.verificationReason || '').slice(0, 120),
      tools: tools.map(String).slice(0, 20),
      elapsedMs: Math.max(0, Number(outcome.elapsedMs) || 0),
      createdAt: Number(outcome.ts) || Date.now(),
    };
    if (this._graph.usingFallback) {
      this._fallbackEvidence.push({
        id: this._fallbackEvidence.length + 1,
        ...row,
        consolidatedAt: null,
      });
      return this._fallbackEvidence.length;
    }
    try {
      const info = this._db
        .prepare(
          `INSERT INTO task_outcome_evidence
            (session_id, mode, difficulty, strategy, outcome, verification_status,
             verification_reason, tools, elapsed_ms, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          row.sessionId,
          row.mode,
          row.difficulty,
          row.strategy,
          row.outcome,
          row.verificationStatus,
          row.verificationReason,
          JSON.stringify(row.tools),
          row.elapsedMs,
          row.createdAt
        );
      return Number(info.lastInsertRowid);
    } catch (e) {
      logger.warn('CausalMemoryStore', `[causal] no se pudo guardar outcome: ${_errMsg(e)}`);
      return null;
    }
  }

  /**
   * Consolida evidencia vieja en hipótesis direccionales. Una corrida sin
   * verificación nunca cuenta como soporte ni contradicción causal.
   * @param {{minAgeMs?:number, minSamples?:number, minSessions?:number, limit?:number}} [opts]
   */
  consolidate(opts = {}) {
    const minAgeMs = Math.max(0, Number(opts.minAgeMs) || 0);
    const minSamples = Math.max(3, Number(opts.minSamples) || 3);
    const minSessions = Math.max(2, Number(opts.minSessions) || 2);
    const limit = Math.min(1000, Math.max(1, Number(opts.limit) || 500));
    const cutoff = Date.now() - minAgeMs;
    const rows = this._pendingEvidence(cutoff, limit);
    /** @type {Map<string, any[]>} */
    const groups = new Map();
    const processedIds = [];
    for (const row of rows) {
      if (!EVIDENCE_STATUSES.has(String(row.verificationStatus))) {
        // La evidencia no verificable se conserva en el ledger, pero se sella
        // como examinada para que no bloquee indefinidamente el lote acotado.
        processedIds.push(row.id);
        continue;
      }
      const list = groups.get(row.strategy) || [];
      list.push(row);
      groups.set(row.strategy, list);
    }

    const hypotheses = [];
    for (const [strategy, pending] of groups) {
      const evidence = this._verifiedSummaryForStrategy(strategy);
      if (evidence.total < minSamples || evidence.sessions < minSessions) continue;
      const { successes, failures } = evidence;
      if (successes + failures < minSamples) continue;
      const rate = (successes + 1) / (successes + failures + 2);
      let effect = 'uncertain';
      let support = Math.max(successes, failures);
      let contradict = Math.min(successes, failures);
      if (rate >= 0.7) {
        effect = 'completion_likely';
        support = successes;
        contradict = failures;
      } else if (rate <= 0.3) {
        effect = 'failure_risk';
        support = failures;
        contradict = successes;
      }
      const strength = Math.min(1, (successes + failures) / 10);
      const confidence =
        effect === 'uncertain'
          ? 0.1
          : Math.min(0.85, Math.max(0.1, Math.abs(rate - 0.5) * 2 * strength));
      // Una relación causal por estrategia. Al llegar nueva evidencia se
      // recalcula sobre TODO el historial verificado, así el resultado es
      // idempotente y una contradicción puede debilitar o invertir la tesis.
      const signature = crypto.createHash('sha256').update(strategy).digest('hex').slice(0, 20);
      const hypothesis = this._upsertHypothesis({
        signature,
        cause: strategy,
        effect,
        support,
        contradict,
        confidence,
        evidenceIds: evidence.evidenceIds,
      });
      if (hypothesis) hypotheses.push(hypothesis);
      processedIds.push(...pending.map((row) => row.id));
    }
    this._markConsolidated(processedIds);
    return { examined: rows.length, consolidated: processedIds.length, hypotheses };
  }

  /** @param {string} strategy */
  _verifiedSummaryForStrategy(strategy) {
    if (this._graph.usingFallback) {
      const rows = this._fallbackEvidence.filter(
        (row) =>
          row.strategy === strategy &&
          EVIDENCE_STATUSES.has(String(row.verificationStatus)) &&
          ['success', 'failure'].includes(String(row.outcome))
      );
      return {
        total: rows.length,
        sessions: new Set(rows.map((row) => row.sessionId)).size,
        successes: rows.filter((row) => row.outcome === 'success').length,
        failures: rows.filter((row) => row.outcome === 'failure').length,
        evidenceIds: rows.slice(-100).map((row) => row.id),
      };
    }
    try {
      const summary = this._db
        .prepare(
          `SELECT COUNT(*) AS total,
                  COUNT(DISTINCT session_id) AS sessions,
                  SUM(CASE WHEN outcome='success' THEN 1 ELSE 0 END) AS successes,
                  SUM(CASE WHEN outcome='failure' THEN 1 ELSE 0 END) AS failures
           FROM task_outcome_evidence
           WHERE strategy=?
             AND verification_status IN ('verified', 'not_applicable', 'failed')
             AND outcome IN ('success', 'failure')`
        )
        .get(strategy);
      const ids = /** @type {any[]} */ (
        this._db
          .prepare(
            `SELECT id FROM task_outcome_evidence
             WHERE strategy=?
               AND verification_status IN ('verified', 'not_applicable', 'failed')
               AND outcome IN ('success', 'failure')
             ORDER BY created_at DESC LIMIT 100`
          )
          .all(strategy)
      );
      return {
        total: Number(summary?.total) || 0,
        sessions: Number(summary?.sessions) || 0,
        successes: Number(summary?.successes) || 0,
        failures: Number(summary?.failures) || 0,
        evidenceIds: ids.map((row) => Number(row.id)).reverse(),
      };
    } catch (_) {
      return { total: 0, sessions: 0, successes: 0, failures: 0, evidenceIds: [] };
    }
  }

  /** @param {number} cutoff @param {number} limit */
  _pendingEvidence(cutoff, limit) {
    if (this._graph.usingFallback) {
      return this._fallbackEvidence
        .filter((row) => !row.consolidatedAt && row.createdAt <= cutoff)
        .slice(0, limit);
    }
    try {
      return /** @type {any[]} */ (
        this._db
          .prepare(
            `SELECT id, session_id AS sessionId, strategy, outcome,
                    verification_status AS verificationStatus, created_at AS createdAt
             FROM task_outcome_evidence
             WHERE consolidated_at IS NULL AND created_at <= ?
             ORDER BY created_at ASC LIMIT ?`
          )
          .all(cutoff, limit)
      );
    } catch (_) {
      return [];
    }
  }

  /** @param {number[]} ids */
  _markConsolidated(ids) {
    if (!ids.length) return;
    const now = Date.now();
    if (this._graph.usingFallback) {
      for (const row of this._fallbackEvidence) if (ids.includes(row.id)) row.consolidatedAt = now;
      return;
    }
    try {
      const update = this._db.prepare(
        'UPDATE task_outcome_evidence SET consolidated_at=? WHERE id=? AND consolidated_at IS NULL'
      );
      const run = this._db.transaction(() => {
        for (const id of new Set(ids)) update.run(now, id);
      });
      run();
    } catch (e) {
      logger.warn('CausalMemoryStore', `[causal] no se pudo sellar evidencia: ${_errMsg(e)}`);
    }
  }

  /** @param {{signature:string,cause:string,effect:string,support:number,contradict:number,confidence:number,evidenceIds:number[]}} input */
  _upsertHypothesis(input) {
    const now = Date.now();
    if (this._graph.usingFallback) {
      const prior = this._fallbackHypotheses.get(input.signature);
      const preservesDecision = prior?.effect === input.effect;
      const status = preservesDecision ? prior?.status || 'inferred' : 'inferred';
      const row = {
        ...prior,
        ...input,
        status,
        createdAt: prior?.createdAt || now,
        updatedAt: now,
      };
      this._fallbackHypotheses.set(input.signature, row);
      return row;
    }
    try {
      this._db
        .prepare(
          `INSERT INTO causal_hypotheses
            (signature, cause, effect, support_count, contradict_count, confidence,
             status, evidence_ids, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'inferred', ?, ?, ?)
           ON CONFLICT(signature) DO UPDATE SET
             cause=excluded.cause,
             effect=excluded.effect,
             support_count=excluded.support_count,
             contradict_count=excluded.contradict_count,
             confidence=excluded.confidence,
             status=CASE
               WHEN causal_hypotheses.effect=excluded.effect THEN causal_hypotheses.status
               ELSE 'inferred'
             END,
             evidence_ids=excluded.evidence_ids,
             updated_at=excluded.updated_at`
        )
        .run(
          input.signature,
          input.cause,
          input.effect,
          input.support,
          input.contradict,
          input.confidence,
          JSON.stringify(input.evidenceIds.slice(-100)),
          now,
          now
        );
      return this.getHypothesis(input.signature);
    } catch (e) {
      logger.warn('CausalMemoryStore', `[causal] no se pudo guardar hipótesis: ${_errMsg(e)}`);
      return null;
    }
  }

  /** @param {string} signature */
  getHypothesis(signature) {
    if (this._graph.usingFallback) return this._fallbackHypotheses.get(signature) || null;
    try {
      const row = this._db
        .prepare('SELECT * FROM causal_hypotheses WHERE signature=?')
        .get(signature);
      return row ? this._hydrateHypothesis(row) : null;
    } catch (_) {
      return null;
    }
  }

  /** @param {{status?:string|null,limit?:number}} [opts] */
  listHypotheses({ status = null, limit = 50 } = {}) {
    if (this._graph.usingFallback) {
      let rows = [...this._fallbackHypotheses.values()];
      if (status) rows = rows.filter((row) => row.status === status);
      return rows.slice(0, limit);
    }
    try {
      const rows = status
        ? this._db
            .prepare(
              'SELECT * FROM causal_hypotheses WHERE status=? ORDER BY confidence DESC LIMIT ?'
            )
            .all(status, limit)
        : this._db
            .prepare('SELECT * FROM causal_hypotheses ORDER BY confidence DESC LIMIT ?')
            .all(limit);
      return /** @type {any[]} */ (rows).map((row) => this._hydrateHypothesis(row));
    } catch (_) {
      return [];
    }
  }

  /** @param {any} row */
  _hydrateHypothesis(row) {
    return {
      id: Number(row.id),
      signature: String(row.signature),
      cause: String(row.cause),
      effect: String(row.effect),
      supportCount: Number(row.support_count),
      contradictCount: Number(row.contradict_count),
      confidence: Number(row.confidence),
      status: String(row.status),
      evidenceIds: _json(row.evidence_ids, []),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  /** @param {string} signature @param {'accepted'|'rejected'} decision */
  decide(signature, decision) {
    if (!VALID_DECISIONS.has(decision)) return false;
    if (this._graph.usingFallback) {
      const row = this._fallbackHypotheses.get(signature);
      if (!row) return false;
      row.status = decision;
      row.updatedAt = Date.now();
      return true;
    }
    try {
      return Boolean(
        this._db
          .prepare('UPDATE causal_hypotheses SET status=?, updated_at=? WHERE signature=?')
          .run(decision, Date.now(), signature).changes
      );
    } catch (_) {
      return false;
    }
  }

  buildPromptSection() {
    const rows = this.listHypotheses({ limit: 8 }).filter(
      (row) => row.status === 'accepted' || (row.status === 'inferred' && row.confidence >= 0.65)
    );
    if (!rows.length) return null;
    const lines = rows.map(
      (row) =>
        `- [${row.status === 'accepted' ? 'confirmada' : 'hipótesis'} ${(row.confidence * 100).toFixed(0)}%] ` +
        `${row.cause} → ${row.effect} (${row.supportCount} apoyos, ${row.contradictCount} contradicciones)`
    );
    return '# MEMORIA CAUSAL (NO OTORGA PERMISOS)\n' + lines.join('\n');
  }
}

module.exports = { CausalMemoryStore };
