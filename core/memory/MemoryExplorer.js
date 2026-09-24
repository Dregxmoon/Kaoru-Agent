// @ts-check
'use strict';

/** @type {WeakSet<object>} */
const initialized = new WeakSet();
/** @param {any} graph */
function database(graph) {
  if (!graph || graph.usingFallback || !graph._db) return null;
  const db = graph._db;
  if (!initialized.has(db)) {
    db.exec(`CREATE TABLE IF NOT EXISTS memory_gap_preferences (
      gap_key TEXT PRIMARY KEY, mode TEXT NOT NULL, until_at INTEGER NOT NULL DEFAULT 0
    )`);
    initialized.add(db);
  }
  return db;
}
/** @param {any} value @returns {string[]} */
function tags(value) {
  try {
    const parsed = Array.isArray(value) ? value : JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.filter((t) => typeof t === 'string') : [];
  } catch {
    return [];
  }
}
/** @param {any} graph @returns {Array<{key:string,mode:string,untilAt:number}>} */
function gapPreferences(graph) {
  const db = database(graph);
  return db
    ? db
        .prepare('SELECT gap_key AS key, mode, until_at AS untilAt FROM memory_gap_preferences')
        .all()
    : [];
}
/** @param {any} graph @param {any[]} gaps */
function eligibleGaps(graph, gaps) {
  const excluded = new Set(
    gapPreferences(graph)
      .filter((p) => p.mode === 'never' || p.untilAt > Date.now())
      .map((p) => p.key)
  );
  return gaps.filter((g) => !excluded.has(g.key));
}
/** @param {any} graph @param {{key:string,mode:string}} input */
function setGapPreference(graph, input) {
  const db = database(graph);
  if (!db) return { ok: false, error: 'memory_unavailable' };
  if (
    !input ||
    typeof input.key !== 'string' ||
    !/^[a-z_]{1,80}$/.test(input.key) ||
    !['never', 'later', 'ask'].includes(input.mode)
  )
    return { ok: false, error: 'invalid_input' };
  db.prepare(
    `INSERT INTO memory_gap_preferences(gap_key,mode,until_at) VALUES(?,?,?)
    ON CONFLICT(gap_key) DO UPDATE SET mode=excluded.mode,until_at=excluded.until_at`
  ).run(input.key, input.mode, input.mode === 'later' ? Date.now() + 7 * 86400000 : 0);
  return { ok: true };
}
/** @param {any} graph @param {{nodeId:number,pinned:boolean,expectedUpdatedAt?:number}} input */
function pin(graph, input) {
  const db = database(graph);
  if (
    !db ||
    !input ||
    !Number.isSafeInteger(input.nodeId) ||
    input.nodeId <= 0 ||
    typeof input.pinned !== 'boolean'
  )
    return { ok: false, error: 'invalid_input' };
  return db.transaction(() => {
    const node = db.prepare('SELECT * FROM nodes WHERE id=? AND archived=0').get(input.nodeId);
    if (!node) return { ok: false, error: 'memory_not_found' };
    if (input.expectedUpdatedAt !== node.updated_at) return { ok: false, error: 'memory_changed' };
    const next = tags(node.tags).filter((t) => t !== 'memory:pinned');
    if (input.pinned) next.push('memory:pinned');
    db.prepare('UPDATE nodes SET tags=?,updated_at=? WHERE id=?').run(
      JSON.stringify(next),
      Math.max(Date.now(), node.updated_at + 1),
      node.id
    );
    return { ok: true };
  })();
}
/** @param {any} n */
function topic(n) {
  const text = `${n.label} ${n.content} ${tags(n.tags).join(' ')}`.toLowerCase();
  if (/kaoru|live2d|mcp|agentloop/.test(text)) return 'Kaoru';
  if (/linux|hyprland|omarchy|warp|pacman|terminal/.test(text)) return 'Linux y herramientas';
  if (/universidad|estudia|ingenier|asignatura|examen/.test(text)) return 'Estudios';
  const label = tags(n.tags).find(
    (t) => !/^(visto:|memory:|workspace|auto-init|context-|source:)/.test(t)
  );
  const labels = /** @type {Record<string,string>} */ ({
    Preference: 'Preferencias',
    Project: 'Proyectos',
    User: 'Personas',
    Episode: 'Experiencias',
    Belief: 'Conocimientos',
  });
  return label?.slice(0, 60) || labels[n.type] || 'Otros';
}
/** Read-only inventory: browsing must never increment recall/access counters.
 * @param {any} graph @param {(n:any)=>boolean} isIdentity
 */
function inventory(graph, isIdentity) {
  const db = database(graph);
  if (!db) return { nodes: [], edges: [], total: 0, truncated: false, usingFallback: true };
  const total = Number(
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM nodes WHERE archived=0 AND type IN ('User','Preference','Project','Belief','Episode')"
      )
      .get().n
  );
  const raw = /** @type {any[]} */ (
    db
      .prepare(
        "SELECT * FROM nodes WHERE archived=0 AND type IN ('User','Preference','Project','Belief','Episode') ORDER BY importance DESC,id DESC LIMIT 10000"
      )
      .all()
  );
  const nodes = raw
    .filter((n) => (n.type === 'Episode' ? Boolean(n.content?.trim()) : isIdentity(n)))
    .map((n) => ({
      id: n.id,
      type: n.type,
      label: n.label,
      content: String(n.content || ''),
      tags: tags(n.tags),
      importance: n.importance,
      createdAt: n.created_at,
      updatedAt: n.updated_at,
      lastAccessedAt: n.last_accessed_at,
      inferred: Boolean(n.inferred),
      confidence: n.confidence,
      pinned: tags(n.tags).includes('memory:pinned'),
      topic: topic(n),
    }));
  const ids = new Set(nodes.map((n) => n.id));
  const edges = /** @type {any[]} */ (
    db
      .prepare(
        'SELECT source_id AS source,target_id AS target,type FROM node_relations ORDER BY source_id,target_id LIMIT 60000'
      )
      .all()
  )
    .filter((e) => ids.has(e.source) && ids.has(e.target))
    .map((e) => ({ ...e, type: String(e.type).toLowerCase(), category: 'explicit' }));
  // Sparse topic backbones avoid quadratic edge growth.
  const anchors = new Map();
  for (const n of nodes) {
    const previous = anchors.get(n.topic);
    if (previous)
      edges.push({ source: previous, target: n.id, type: 'tema', category: 'semantic' });
    else anchors.set(n.topic, n.id);
  }
  const sorted = [...nodes].sort((a, b) => a.createdAt - b.createdAt);
  const sessions = /** @type {any[]} */ (
    db
      .prepare(
        `SELECT DISTINCT me.node_id, o.session_id
    FROM memory_evidence me JOIN observations o ON me.observation_id=o.id
    WHERE o.session_id IS NOT NULL ORDER BY o.session_id,me.node_id LIMIT 60000`
      )
      .all()
  );
  const sessionAnchors = new Map();
  for (const row of sessions) {
    if (!ids.has(row.node_id)) continue;
    const anchor = sessionAnchors.get(row.session_id);
    if (anchor && anchor !== row.node_id)
      edges.push({
        source: anchor,
        target: row.node_id,
        type: 'misma conversación',
        category: 'conversation',
      });
    else sessionAnchors.set(row.session_id, row.node_id);
  }
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].createdAt - sorted[i - 1].createdAt < 5 * 60000)
      edges.push({
        source: sorted[i - 1].id,
        target: sorted[i].id,
        type: 'proximidad temporal',
        category: 'temporal',
      });
  }
  return { nodes, edges, total, truncated: total > 10000, usingFallback: false };
}
module.exports = { inventory, pin, eligibleGaps, gapPreferences, setGapPreference };
