// @ts-check
'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
/** @type {Readonly<Record<string, number>>} */
const FRESHNESS_DAYS = Object.freeze({
  User: 365,
  Preference: 180,
  Project: 90,
  Belief: 90,
  Emotion: 7,
  Interaction: 30,
  Pattern: 120,
  Relation: 120,
  Episode: Infinity,
});

/** @param {number} value */
function _band(value) {
  if (value >= 0.75) return 'high';
  if (value >= 0.45) return 'medium';
  return 'low';
}

class MetamemoryStore {
  /** @param {any} db @param {{usingFallback?:boolean}} graph */
  constructor(db, graph) {
    this._db = db;
    this._graph = graph;
  }

  /** @param {number[]} ids @returns {Map<number,{evidenceCount:number,contested:boolean}>} */
  _metadata(ids) {
    const result = new Map();
    for (const id of ids) result.set(id, { evidenceCount: 0, contested: false });
    if (this._graph.usingFallback || !ids.length) return result;
    const placeholders = ids.map(() => '?').join(',');
    try {
      const evidence = /** @type {any[]} */ (
        this._db
          .prepare(
            `SELECT node_id, COUNT(*) AS count FROM memory_evidence
             WHERE node_id IN (${placeholders}) GROUP BY node_id`
          )
          .all(...ids)
      );
      for (const row of evidence) {
        const meta = result.get(Number(row.node_id));
        if (meta) meta.evidenceCount = Number(row.count) || 0;
      }
      const tensions = /** @type {any[]} */ (
        this._db
          .prepare(
            `SELECT r.source_id, r.target_id FROM node_relations r
             JOIN nodes a ON a.id=r.source_id AND a.archived=0
             JOIN nodes b ON b.id=r.target_id AND b.archived=0
             WHERE r.type='CONTRADICES'
               AND (r.source_id IN (${placeholders}) OR r.target_id IN (${placeholders}))`
          )
          .all(...ids, ...ids)
      );
      for (const row of tensions) {
        for (const id of [Number(row.source_id), Number(row.target_id)]) {
          const meta = result.get(id);
          if (meta) meta.contested = true;
        }
      }
    } catch (_) {
      // Sin metadata auxiliar, el recuerdo sigue disponible pero se etiqueta
      // de manera conservadora como no trazado.
    }
    return result;
  }

  /**
   * @param {any} node
   * @param {{evidenceCount?:number,contested?:boolean}} [metadata]
   * @param {number} [now]
   */
  assessNode(node, metadata = {}, now = Date.now()) {
    const type = String(node?.type || 'Belief');
    const evidenceCount = Math.max(
      0,
      Number(metadata.evidenceCount ?? node?.memory_context?.evidenceCount) || 0
    );
    const contested = Boolean(metadata.contested);
    // `updated_at` puede cambiar por mantenimiento o acceso y no equivale a
    // confirmación. Si `verified_at` fue invalidado explícitamente, se conserva
    // como null; `created_at` sólo sirve como base conservadora de antigüedad.
    const verifiedAt = node?.verified_at == null ? 0 : Number(node.verified_at) || 0;
    const freshnessAt = verifiedAt || Number(node?.created_at) || 0;
    const ageDays = freshnessAt ? Math.max(0, (now - freshnessAt) / DAY_MS) : Infinity;
    const freshnessDays = FRESHNESS_DAYS[type] ?? 90;
    const stale = Number.isFinite(freshnessDays) && ageDays > freshnessDays;
    const inferred = Number(node?.inferred) === 1;
    const episode = type === 'Episode';

    let status = 'recorded_without_trace';
    let confidence = 0.55;
    const reasons = [];
    if (contested) {
      status = 'contested';
      confidence = 0.25;
      reasons.push('active_contradiction');
    } else if (episode) {
      status = evidenceCount > 0 ? 'recollection_supported' : 'recollection_untraced';
      confidence = evidenceCount > 0 ? 0.72 : 0.48;
      reasons.push('episode_summary');
    } else if (inferred) {
      status = 'inferred';
      confidence = Math.max(0.1, Math.min(0.85, Number(node?.confidence) || 0.4));
      reasons.push('model_inference');
    } else if (stale) {
      status = 'stale';
      confidence = evidenceCount > 0 ? 0.42 : 0.28;
      reasons.push('freshness_expired');
    } else if (evidenceCount > 0) {
      status = 'supported';
      confidence = Math.min(0.92, 0.72 + Math.min(0.2, evidenceCount * 0.04));
      reasons.push('linked_observation');
    } else {
      reasons.push('no_linked_evidence');
    }

    return {
      status,
      confidenceBand: _band(confidence),
      evidenceCount,
      contested,
      stale,
      verifiedAt: verifiedAt || null,
      reasons,
      mayStateAsFact: !episode && !inferred && !contested && !stale && evidenceCount > 0,
    };
  }

  /**
   * @param {{query?:string,nodes?:any[],episodes?:any[],memoryQuery?:boolean,matchCount?:number,relevantIds?:number[],now?:number}} [input]
   */
  assessRecall(input = {}) {
    const nodes = Array.isArray(input.nodes) ? input.nodes : [];
    const episodes = Array.isArray(input.episodes) ? input.episodes : [];
    const all = [...nodes, ...episodes];
    const ids = all.map((node) => Number(node?.id)).filter((id) => Number.isInteger(id) && id > 0);
    const metadata = this._metadata(ids);
    const now = Number(input.now) || Date.now();
    const annotate = (/** @type {any} */ node) => {
      const existingEvidence = Number(node?.memory_context?.evidenceCount) || 0;
      const meta = metadata.get(Number(node?.id)) || { evidenceCount: 0, contested: false };
      return {
        ...node,
        _metamemory: this.assessNode(
          node,
          {
            evidenceCount: Math.max(existingEvidence, meta.evidenceCount),
            contested: meta.contested,
          },
          now
        ),
      };
    };
    const annotatedNodes = nodes.map(annotate);
    const annotatedEpisodes = episodes.map(annotate);
    const relevant = new Set((input.relevantIds || []).map(Number));
    const relevantAssessments = [...annotatedNodes, ...annotatedEpisodes]
      .filter((node) => relevant.has(Number(node.id)))
      .map((node) => node._metamemory);

    let knowledgeState = 'not_queried';
    let reason = 'no_memory_question';
    if (input.memoryQuery) {
      if (!Number(input.matchCount) || !relevantAssessments.length) {
        knowledgeState = 'unknown';
        reason = 'no_relevant_memory';
      } else if (relevantAssessments.some((item) => item.mayStateAsFact)) {
        knowledgeState = 'known';
        reason = 'supported_memory';
      } else {
        knowledgeState = 'partial';
        reason = 'memory_requires_qualification';
      }
    }

    return {
      query: String(input.query || '').slice(0, 300),
      knowledgeState,
      reason,
      nodes: annotatedNodes,
      episodes: annotatedEpisodes,
    };
  }
}

module.exports = { MetamemoryStore, FRESHNESS_DAYS };
