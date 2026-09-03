// @ts-check
'use strict';

class MemoryPrivacyStore {
  /** @param {any} db @param {any} graph */
  constructor(db, graph) {
    this._db = db;
    this._graph = graph;
  }

  /** @param {number} nodeId @param {{includeSensitive?:boolean}} [opts] */
  inspect(nodeId, { includeSensitive = false } = {}) {
    const id = Number(nodeId);
    if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'node_id_invalid' };
    const node = this._graph.getNode(id);
    if (!node) return { ok: false, error: 'memory_not_found' };
    if (this._graph.usingFallback) {
      return { ok: true, node: this._viewNode(node), evidence: [], episode: null, history: null };
    }
    const lineage = /** @type {any[]} */ (
      this._db.prepare('SELECT id FROM nodes WHERE label=? AND type=?').all(node.label, node.type)
    ).map((row) => Number(row.id));
    const placeholders = lineage.map(() => '?').join(',');
    const evidence = lineage.length
      ? /** @type {any[]} */ (
          this._db
            .prepare(
              `SELECT DISTINCT o.id, o.source, o.kind, o.content, o.metadata, o.sensitivity,
                      o.occurred_at, me.confidence, me.relation
               FROM memory_evidence me JOIN observations o ON o.id=me.observation_id
               WHERE me.node_id IN (${placeholders}) ORDER BY o.occurred_at DESC LIMIT 100`
            )
            .all(...lineage)
        ).map((row) => ({
          id: Number(row.id),
          source: row.source,
          kind: row.kind,
          content:
            row.sensitivity === 'sensitive' && !includeSensitive
              ? '[contenido sensible oculto]'
              : row.content,
          metadata:
            row.sensitivity === 'sensitive' && !includeSensitive
              ? null
              : this._parseJson(row.metadata, {}),
          sensitivity: row.sensitivity,
          occurredAt: Number(row.occurred_at),
          confidence: Number(row.confidence),
          relation: row.relation,
        }))
      : [];
    const episode =
      node.type === 'Episode'
        ? this._db.prepare('SELECT * FROM autobiographical_events WHERE node_id=?').get(id) || null
        : null;
    return {
      ok: true,
      node: { ...this._viewNode(node), metamemory: this._graph.assessMemoryNode(node) },
      evidence,
      episode,
      history: this._graph.getMemoryRevisionHistory({ label: node.label }),
    };
  }

  /** @param {{includeSensitive?:boolean}} [opts] */
  exportSnapshot({ includeSensitive = true } = {}) {
    if (this._graph.usingFallback) {
      return { schemaVersion: 1, exportedAt: Date.now(), usingFallback: true, nodes: [] };
    }
    const nodes = /** @type {any[]} */ (
      this._db.prepare('SELECT * FROM nodes ORDER BY id').all()
    ).map((node) => this._viewNode(node));
    const observations = /** @type {any[]} */ (
      this._db.prepare('SELECT * FROM observations ORDER BY id').all()
    ).map((row) => ({
      ...row,
      content:
        row.sensitivity === 'sensitive' && !includeSensitive
          ? '[contenido sensible oculto]'
          : row.content,
      metadata:
        row.sensitivity === 'sensitive' && !includeSensitive
          ? null
          : this._parseJson(row.metadata, {}),
    }));
    return {
      schemaVersion: 1,
      exportedAt: Date.now(),
      usingFallback: false,
      nodes,
      observations,
      evidence: this._db.prepare('SELECT * FROM memory_evidence ORDER BY id').all(),
      autobiographicalEvents: this._db
        .prepare('SELECT * FROM autobiographical_events ORDER BY id')
        .all(),
      revisions: this._db.prepare('SELECT * FROM memory_revisions ORDER BY id').all(),
    };
  }

  /** @param {{nodeId:number,content:string,reason?:string,expectedUpdatedAt?:number}} input */
  correct(input) {
    const node = this._validatedNode(input.nodeId, input.expectedUpdatedAt);
    if (!node.ok) return node;
    const content = String(input.content || '').trim();
    if (content.length < 2 || content.length > 12000) {
      return { ok: false, error: 'content_invalid' };
    }
    if (content === node.node.content)
      return { ok: true, changed: false, node: this._viewNode(node.node) };
    this._graph.updateNode(node.node.id, {
      content,
      inferred: 0,
      confidence: null,
      verified_at: Date.now(),
      revision: {
        policy: 'user_correction',
        source: 'memory_control_ui',
        reason: String(input.reason || 'corrección explícita del usuario').slice(0, 1000),
      },
    });
    return { ok: true, changed: true, node: this._viewNode(this._graph.getNode(node.node.id)) };
  }

  /** @param {{nodeId:number,expectedUpdatedAt?:number,includeEvidence?:boolean}} input */
  deleteLineage(input) {
    const checked = this._validatedNode(input.nodeId, input.expectedUpdatedAt);
    if (!checked.ok) return checked;
    const label = checked.node.label;
    if (this._graph.usingFallback) return { ok: false, error: 'persistent_memory_unavailable' };
    const rows = /** @type {any[]} */ (
      this._db
        .prepare('SELECT id FROM nodes WHERE label=? AND type=?')
        .all(label, checked.node.type)
    );
    const nodeIds = rows.map((row) => Number(row.id));
    const placeholders = nodeIds.map(() => '?').join(',');
    const evidenceIds = placeholders
      ? /** @type {any[]} */ (
          this._db
            .prepare(
              `SELECT DISTINCT observation_id FROM memory_evidence WHERE node_id IN (${placeholders})`
            )
            .all(...nodeIds)
        ).map((row) => Number(row.observation_id))
      : [];
    const hasVectorTable = Boolean(
      this._db
        .prepare(
          "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='node_vectors'"
        )
        .get()
    );
    let deletedEvidence = 0;
    const transaction = this._db.transaction(() => {
      this._db
        .prepare(`UPDATE sessions SET episode_id=NULL WHERE episode_id IN (${placeholders})`)
        .run(...nodeIds);
      this._db
        .prepare('DELETE FROM memory_revisions WHERE label=? AND node_type=?')
        .run(label, checked.node.type);
      if (hasVectorTable) {
        const deleteVector = this._db.prepare('DELETE FROM node_vectors WHERE rowid=?');
        for (const id of nodeIds) deleteVector.run(BigInt(id));
      }
      this._db.prepare(`DELETE FROM nodes WHERE id IN (${placeholders})`).run(...nodeIds);
      if (input.includeEvidence !== false && evidenceIds.length) {
        const evidencePlaceholders = evidenceIds.map(() => '?').join(',');
        deletedEvidence = this._db
          .prepare(
            `DELETE FROM observations WHERE id IN (${evidencePlaceholders})
             AND NOT EXISTS (SELECT 1 FROM memory_evidence me WHERE me.observation_id=observations.id)`
          )
          .run(...evidenceIds).changes;
      }
    });
    transaction();
    const remaining = Number(
      this._db
        .prepare('SELECT COUNT(*) AS count FROM nodes WHERE label=? AND type=?')
        .get(label, checked.node.type)?.count || 0
    );
    return {
      ok: remaining === 0,
      deletedNodes: nodeIds.length - remaining,
      deletedEvidence,
      label,
    };
  }

  /** @param {number} nodeId @param {number|undefined} expectedUpdatedAt */
  _validatedNode(nodeId, expectedUpdatedAt) {
    const id = Number(nodeId);
    if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'node_id_invalid' };
    const node = this._graph.getNode(id);
    if (!node) return { ok: false, error: 'memory_not_found' };
    if (expectedUpdatedAt != null && Number(expectedUpdatedAt) !== Number(node.updated_at)) {
      return { ok: false, error: 'memory_changed', currentUpdatedAt: Number(node.updated_at) };
    }
    return { ok: true, node };
  }

  /** @param {any} node */
  _viewNode(node) {
    return {
      id: Number(node.id),
      type: node.type,
      label: node.label,
      content: node.content,
      importance: Number(node.importance),
      tags: this._parseJson(node.tags, []),
      archived: Number(node.archived) === 1,
      inferred: Number(node.inferred) === 1,
      confidence: node.confidence == null ? null : Number(node.confidence),
      createdAt: Number(node.created_at),
      updatedAt: Number(node.updated_at),
      verifiedAt: node.verified_at == null ? null : Number(node.verified_at),
    };
  }

  /** @param {unknown} value @param {any} fallback */
  _parseJson(value, fallback) {
    try {
      return JSON.parse(String(value || ''));
    } catch (_) {
      return fallback;
    }
  }
}

module.exports = { MemoryPrivacyStore };
