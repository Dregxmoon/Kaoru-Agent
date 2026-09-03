// @ts-nocheck
'use strict';
const logger = require('../../observability/Logger.js');

const { DECAY_RATES, NODE_TYPES } = require('./constants');

// MEM-6: tipos cuya memoria vale la pena citar con procedencia.
const IDENTITY_TYPES = new Set(['User', 'Preference', 'Project', 'Belief']);

/**
 * Tag `visto:<YYYY-MM-DD>` — cuándo se supo/confirmó el dato por última vez.
 * Los mensajes proactivos lo usan para citar procedencia ("te lo contó el
 * 12 de agosto") en vez de soltar el dato sin contexto.
 * @param {string[]} tags
 * @param {boolean} replaceExisting - true en updates (deja solo la fecha nueva)
 * @returns {string[]}
 */
function _withProvenanceTag(tags, { replaceExisting = false } = {}) {
  const day = new Date().toISOString().slice(0, 10);
  const tag = `visto:${day}`;
  const clean = Array.isArray(tags) ? tags.filter((t) => !/^visto:\d{4}-\d{2}-\d{2}$/.test(t)) : [];
  if (!replaceExisting && clean.includes(tag)) return clean;
  clean.push(tag);
  return clean;
}

class NodeStore {
  constructor(db, graph) {
    this._db = db;
    this._g = graph;
  }

  createNode({
    type,
    label,
    content,
    importance = 1.0,
    tags = [],
    verified_at,
    inferred = 0,
    confidence = null,
    decay_rate,
  }) {
    if (!NODE_TYPES.includes(type)) throw new Error(`Tipo inválido: ${type}`);
    const now = Date.now();
    const result = this._db
      .prepare(
        `
      INSERT INTO nodes (type, label, content, importance, decay_rate, tags, created_at, updated_at, last_accessed_at, verified_at, inferred, confidence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        type,
        label,
        content,
        importance,
        decay_rate ?? DECAY_RATES[type],
        JSON.stringify(IDENTITY_TYPES.has(type) ? _withProvenanceTag(tags) : tags),
        now,
        now,
        now,
        verified_at ?? now,
        inferred ? 1 : 0,
        confidence
      );
    this._g._scheduleNodeEmbedding(result.lastInsertRowid, content);
    return result.lastInsertRowid;
  }

  updateNode(id, { content, label, importance, tags, verified_at, inferred, confidence } = {}) {
    const now = Date.now();
    const node = this.getNode(id);
    if (!node) return false;

    const newImportance = importance ?? node.importance;
    const newContent = content ?? node.content;
    const newLabel = label ?? node.label;
    let newTags = tags ?? JSON.parse(node.tags || '[]');
    // MEM-6: al confirmar/actualizar un dato de identidad, refrescar la
    // procedencia (reemplaza visto:<vieja> por la fecha de hoy).
    if (!tags && IDENTITY_TYPES.has(node.type)) {
      try {
        newTags = _withProvenanceTag(JSON.parse(node.tags || '[]'), {
          replaceExisting: true,
        });
      } catch {}
    }
    const newVerifiedAt = verified_at ?? node.verified_at;
    const newInferred = inferred !== undefined ? (inferred ? 1 : 0) : node.inferred;
    const newConfidence = confidence !== undefined ? confidence : node.confidence;

    this._db
      .prepare(
        `
      UPDATE nodes
      SET content=?, label=?, importance=?, tags=?, verified_at=?, inferred=?, confidence=?, updated_at=?, last_accessed_at=?, access_count=access_count+1
      WHERE id=?
    `
      )
      .run(
        newContent,
        newLabel,
        newImportance,
        JSON.stringify(newTags),
        newVerifiedAt,
        newInferred,
        newConfidence,
        now,
        now,
        id
      );

    if (content && content !== node.content) {
      this._g._scheduleNodeEmbedding(id, newContent);
    }

    return true;
  }

  getNode(id) {
    return this._db.prepare('SELECT * FROM nodes WHERE id=?').get(id) || null;
  }

  queryNodes({ type, search, limit = 20, includeArchived = false } = {}) {
    let sql = 'SELECT * FROM nodes WHERE 1=1';
    const args = [];

    if (!includeArchived) {
      sql += ' AND archived=0';
    }
    if (type) {
      sql += ' AND type=?';
      args.push(type);
    }
    if (search) {
      sql += ' AND (label LIKE ? OR content LIKE ?)';
      args.push(`%${search}%`, `%${search}%`);
    }

    sql += ' ORDER BY importance DESC LIMIT ?';
    args.push(limit);

    const results = this._db.prepare(sql).all(...args);

    if (!includeArchived) {
      this._touchNodes(results.map((n) => n.id).filter(Boolean), 'queryNodes');
    }

    return results;
  }

  /**
   * Nodos inferidos (modelo del usuario, F3.3): `inferred=1` y activos,
   * ordenados por certeza (confidence) × importancia. Es el origen EXCLUSIVO
   * de la sección "Impresiones" del prompt — separado de `getWorldModel()`,
   * que solo devuelve hechos (`inferred=0`).
   * @param {{limit?: number}} [opts]
   * @returns {Array<object>}
   */
  queryInferredModels({ limit = 8 } = {}) {
    return this._db
      .prepare(
        `
      SELECT * FROM nodes
      WHERE inferred=1 AND archived=0
      ORDER BY COALESCE(confidence, 0) * importance DESC
      LIMIT ?
    `
      )
      .all(limit);
  }

  getRecentEpisodes(limit = 20) {
    const results = this._db
      .prepare(
        `
      SELECT * FROM nodes
      WHERE type='Episode' AND archived=0
      ORDER BY created_at DESC, importance DESC
      LIMIT ?
    `
      )
      .all(limit);

    this._touchNodes(results.map((n) => n.id).filter(Boolean), 'getRecentEpisodes');

    return results;
  }

  getWorldModel(context = null) {
    let results = this._db
      .prepare(
        `
      SELECT * FROM nodes
      WHERE type IN ('User','Project','Preference','Belief')
        AND archived=0
        AND inferred=0
      ORDER BY importance DESC
      LIMIT 50
    `
      )
      .all();

    // NO se toca last_accessed_at aquí (F2.1): el world model se lee en CADA
    // turno por ser contexto estable, así que contar esas lecturas como
    // "acceso del usuario" refrescaría recencia siempre y el decay jamás
    // llegaría al umbral de archivo. Solo los recalls intencionales
    // (queryNodes/getRecentEpisodes/queryNodesSemantic) alimentan la recencia.

    // F3.1: si hay un cumpleaños con año, la edad CALCULADA gana sobre
    // `edad_usuario` guardado a mano (que puede estar desactualizado). Se
    // expone aquí, en el world model, porque es el punto único por el que
    // pasa el contexto estable hacia el LLM — sin duplicar la lógica en el
    // chat y en la proactividad. Solo se inyecta si no hay un nodo
    // edad_usuario real activo (ahí el guardado gana como fallback).
    try {
      const computed = require('../../core/misc.js').getComputedAge(this._g);
      if (typeof computed === 'number') {
        const hasStoredAge = results.some((n) => n.label === 'edad_usuario' && n.archived === 0);
        if (!hasStoredAge) {
          results.push({
            id: -1,
            type: 'User',
            label: 'edad_usuario',
            content: `El usuario tiene ${computed} años (calculados a partir de su cumpleaños)`,
            importance: 0.95,
            tags: '[]',
            archived: 0,
          });
        }
      }
    } catch (e) {
      logger.warn('NodeStore', '[state-graph] no se pudo computar edad en world model:', e.message);
    }

    // Contextual boosting: si hay contexto actual, boostear nodos relevantes
    if (context && typeof context === 'object') {
      const boostTerms = this._extractContextTerms(context);
      if (boostTerms.length > 0) {
        results = results.map((node) => {
          const nodeText = `${node.label} ${node.content}`.toLowerCase();
          let boost = 0;
          for (const term of boostTerms) {
            if (nodeText.includes(term.toLowerCase())) {
              boost += 0.2; // 20% boost por término relevante
            }
          }
          return { ...node, importance: Math.min(1, node.importance + boost) };
        });
        // Re-ordenar por importancia ajustada
        results.sort((a, b) => b.importance - a.importance);
      }
    }

    // Retornar solo los 30 más importantes después del boosting
    return results.slice(0, 30);
  }

  /**
   * Extrae términos relevantes del contexto actual para boosting.
   * @param {object} context
   * @returns {string[]}
   */
  _extractContextTerms(context) {
    const terms = [];
    // App activa
    if (context.activeApp) {
      terms.push(context.activeApp);
    }
    // Título de ventana
    if (context.windowTitle) {
      // Extraer palabras significativas (>3 caracteres)
      const words = context.windowTitle.split(/\s+/).filter((w) => w.length > 3);
      terms.push(...words.slice(0, 5));
    }
    // Topic actual
    if (context.currentTopic) {
      terms.push(context.currentTopic);
    }
    // Emoción dominante
    if (context.dominantEmotion) {
      terms.push(context.dominantEmotion);
    }
    return [...new Set(terms)]; // Deduplicar
  }

  upsertNode({
    type,
    label,
    content,
    importance,
    tags = [],
    verified_at,
    inferred,
    confidence,
    decay_rate,
  }) {
    const existing = this._db
      .prepare('SELECT id FROM nodes WHERE type=? AND label=? AND archived=0 LIMIT 1')
      .get(type, label);

    if (existing) {
      this.updateNode(existing.id, {
        content,
        importance,
        tags,
        verified_at,
        inferred,
        confidence,
      });
      return existing.id;
    }
    return this.createNode({
      type,
      label,
      content,
      importance,
      tags,
      verified_at,
      inferred,
      confidence,
      decay_rate,
    });
  }

  _touchNodes(ids, label = '') {
    if (!ids?.length || this._g.usingFallback) return;
    try {
      const now = Date.now();
      const placeholders = ids.map(() => '?').join(',');
      this._db
        .prepare(
          `UPDATE nodes SET last_accessed_at=?, access_count=access_count+1 WHERE id IN (${placeholders}) AND archived=0`
        )
        .run(now, ...ids);
    } catch (e) {
      logger.warn(
        'NodeStore',
        `[state-graph] error actualizando last_accessed_at (${label || 'touch'}):`,
        e.message
      );
    }
  }

  _findActiveNodeByLabel(label) {
    if (this._g.usingFallback) return null;
    return this._db
      .prepare('SELECT * FROM nodes WHERE label=? AND archived=0 ORDER BY importance DESC LIMIT 1')
      .get(label);
  }

  _archiveNode(id) {
    if (this._g.usingFallback) return;
    this._db.prepare('UPDATE nodes SET archived=1, updated_at=? WHERE id=?').run(Date.now(), id);
    // F2.1: al archivar se elimina también el vector semántico del nodo para
    // que no quede stale en node_vectors (ocupa espacio y poluciona el KNN).
    this._g._vectors?._deleteVector(id);
  }

  _findDuplicateLabels() {
    if (this._g.usingFallback) return [];
    return this._db
      .prepare(
        `
      SELECT label, COUNT(*) as cnt
      FROM nodes WHERE archived=0 GROUP BY label HAVING cnt > 1
    `
      )
      .all();
  }

  _findNodesByLabel(label) {
    if (this._g.usingFallback) return [];
    return this._db
      .prepare(
        `
      SELECT id FROM nodes WHERE label=? AND archived=0 ORDER BY last_accessed_at DESC, importance DESC
    `
      )
      .all(label);
  }

  forget(text) {
    const q = String(text || '')
      .trim()
      .toLowerCase();
    if (!q) return { found: 0, archived: 0, nodes: [], error: 'texto vacío' };

    const rows = this._db
      .prepare(
        `
      SELECT id, label, content, type FROM nodes
      WHERE archived=0 AND (label LIKE ? OR content LIKE ?)
      ORDER BY importance DESC
      LIMIT 20
    `
      )
      .all(`%${q}%`, `%${q}%`);

    if (!rows.length) return { found: 0, archived: 0, nodes: [] };

    const byLabel = rows.filter((r) => (r.label || '').toLowerCase().includes(q));
    const targets = byLabel.length ? byLabel : rows.slice(0, 5);

    const nodes = [];
    for (const t of targets) {
      if (this._g.usingFallback) break;
      this._archiveNode(t.id);
      nodes.push({
        id: t.id,
        type: t.type,
        label: t.label,
        content: String(t.content || '').slice(0, 80),
      });
    }

    return {
      found: rows.length,
      archived: nodes.length,
      nodes,
      warning: this._g.usingFallback
        ? 'memoria en RAM (no persistente): el archivo no sobrevive al reinicio'
        : null,
    };
  }
}

module.exports = { NodeStore };
