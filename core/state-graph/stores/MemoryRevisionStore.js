// @ts-check
'use strict';

/**
 * Journal inmutable de transiciones de memoria. Los snapshots sobreviven aunque
 * el nodo canónico cambie o sea archivado; nunca contienen autorización ni
 * decisiones de ejecución.
 */
class MemoryRevisionStore {
  /** @param {any} db @param {{usingFallback?:boolean,getNode?:(id:number)=>any}} graph */
  constructor(db, graph) {
    this._db = db;
    this._graph = graph;
    /** @type {any[]} */
    this._fallback = [];
    this._nextFallbackId = 1;
  }

  /**
   * @param {{
   *   label:string,type:string,policy:string,previousNodeId:number,currentNodeId:number,
   *   previousContent:string,currentContent:string,reason?:string|null,source?:string|null,
   *   evidenceIds?:number[],createdAt?:number
   * }} input
   * @returns {number}
   */
  record(input) {
    const evidenceIds = [...new Set(input.evidenceIds || [])]
      .map(Number)
      .filter((id) => Number.isInteger(id) && id > 0)
      .slice(0, 50);
    const row = {
      label: String(input.label || '').slice(0, 80),
      type: String(input.type || 'Belief').slice(0, 40),
      policy: String(input.policy || 'overwrite').slice(0, 40),
      previousNodeId: Number(input.previousNodeId),
      currentNodeId: Number(input.currentNodeId),
      previousContent: String(input.previousContent || '').slice(0, 12000),
      currentContent: String(input.currentContent || '').slice(0, 12000),
      reason: input.reason ? String(input.reason).slice(0, 1000) : null,
      source: String(input.source || 'memory_pipeline').slice(0, 80),
      evidenceIds,
      createdAt: Number(input.createdAt) || Date.now(),
    };
    if (!row.label || !row.previousContent || !row.currentContent) {
      throw new Error('Transición de memoria incompleta');
    }

    if (this._graph.usingFallback) {
      const id = this._nextFallbackId++;
      this._fallback.push({ id, ...row });
      return id;
    }

    const result = this._db
      .prepare(
        `INSERT INTO memory_revisions
          (label, node_type, policy, previous_node_id, current_node_id,
           previous_content, current_content, reason, source, evidence_ids, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.label,
        row.type,
        row.policy,
        row.previousNodeId,
        row.currentNodeId,
        row.previousContent,
        row.currentContent,
        row.reason,
        row.source,
        JSON.stringify(row.evidenceIds),
        row.createdAt
      );
    return Number(result.lastInsertRowid);
  }

  /**
   * @param {{label?:string,nodeId?:number,limit?:number}} [opts]
   * @returns {{label:string|null,current:any|null,versions:any[],transitions:any[]}}
   */
  getHistory({ label = '', nodeId, limit = 50 } = {}) {
    let resolvedLabel = String(label || '').slice(0, 80);
    if (!resolvedLabel && Number.isInteger(nodeId) && this._graph.getNode) {
      resolvedLabel = String(this._graph.getNode(Number(nodeId))?.label || '').slice(0, 80);
    }
    if (!resolvedLabel) return { label: null, current: null, versions: [], transitions: [] };

    const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
    let rows;
    if (this._graph.usingFallback) {
      rows = this._fallback.filter((row) => row.label === resolvedLabel).slice(-safeLimit);
    } else {
      rows = this._db
        .prepare(
          `SELECT * FROM (
             SELECT id, label, node_type, policy, previous_node_id, current_node_id,
                    previous_content, current_content, reason, source, evidence_ids, created_at
             FROM memory_revisions WHERE label=? ORDER BY id DESC LIMIT ?
           ) ORDER BY id ASC`
        )
        .all(resolvedLabel, safeLimit);
    }

    const transitions = rows.map((/** @type {any} */ row) => ({
      id: Number(row.id),
      label: row.label,
      type: row.node_type ?? row.type,
      policy: row.policy,
      previousNodeId: Number(row.previous_node_id ?? row.previousNodeId),
      currentNodeId: Number(row.current_node_id ?? row.currentNodeId),
      previousContent: row.previous_content ?? row.previousContent,
      currentContent: row.current_content ?? row.currentContent,
      reason: row.reason || null,
      source: row.source,
      evidenceIds: this._parseEvidence(row.evidence_ids ?? row.evidenceIds),
      createdAt: Number(row.created_at ?? row.createdAt),
    }));

    const versions = [];
    if (transitions.length) {
      const first = transitions[0];
      versions.push({
        version: 1,
        nodeId: first.previousNodeId,
        content: first.previousContent,
        status: 'superseded',
        validUntil: first.createdAt,
      });
      for (let index = 0; index < transitions.length; index++) {
        const transition = transitions[index];
        versions.push({
          version: index + 2,
          nodeId: transition.currentNodeId,
          content: transition.currentContent,
          status: index === transitions.length - 1 ? 'current' : 'superseded',
          validFrom: transition.createdAt,
          validUntil: transitions[index + 1]?.createdAt ?? null,
          reason: transition.reason,
          source: transition.source,
          evidenceIds: transition.evidenceIds,
        });
      }
    }

    const currentNodeId = transitions.at(-1)?.currentNodeId;
    return {
      label: resolvedLabel,
      current: currentNodeId && this._graph.getNode ? this._graph.getNode(currentNodeId) : null,
      versions,
      transitions,
    };
  }

  /** @param {number[]} ids @returns {Map<number,{revisionCount:number,lastCorrectedAt:number|null}>} */
  getMetadata(ids) {
    const result = new Map();
    for (const id of ids) result.set(id, { revisionCount: 0, lastCorrectedAt: null });
    if (this._graph.usingFallback || !ids.length) return result;
    const placeholders = ids.map(() => '?').join(',');
    const rows = /** @type {any[]} */ (
      this._db
        .prepare(
          `SELECT n.id AS node_id, COUNT(r.id) AS revision_count,
                  MAX(r.created_at) AS last_corrected_at
           FROM nodes n
           LEFT JOIN memory_revisions r ON r.label=n.label
           WHERE n.id IN (${placeholders}) GROUP BY n.id`
        )
        .all(...ids)
    );
    for (const row of rows) {
      result.set(Number(row.node_id), {
        revisionCount: Number(row.revision_count) || 0,
        lastCorrectedAt: row.last_corrected_at == null ? null : Number(row.last_corrected_at),
      });
    }
    return result;
  }

  /** @param {string[]} labels @returns {number} */
  deleteForLabels(labels) {
    const safeLabels = [...new Set(labels.map((label) => String(label || '').slice(0, 80)))].filter(
      Boolean
    );
    if (!safeLabels.length) return 0;
    if (this._graph.usingFallback) {
      const before = this._fallback.length;
      this._fallback = this._fallback.filter((row) => !safeLabels.includes(row.label));
      return before - this._fallback.length;
    }
    const placeholders = safeLabels.map(() => '?').join(',');
    return this._db
      .prepare(`DELETE FROM memory_revisions WHERE label IN (${placeholders})`)
      .run(...safeLabels).changes;
  }

  /** @param {unknown} value @returns {number[]} */
  _parseEvidence(value) {
    try {
      const parsed = Array.isArray(value) ? value : JSON.parse(String(value || '[]'));
      return parsed
        .map(Number)
        .filter((/** @type {number} */ id) => Number.isInteger(id) && id > 0);
    } catch (_) {
      return [];
    }
  }
}

module.exports = { MemoryRevisionStore };
