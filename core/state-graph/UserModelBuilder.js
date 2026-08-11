// @ts-check
'use strict';

/**
 * UserModelBuilder.js — F3.3: nodos inferidos separados de los hechos.
 *
 * A diferencia de ConsolidatorStore (determinista, sin LLM), este módulo usa
 * una pasada LLM (modo smart) sobre EPISODIOS QUE YA PASARON el consolidator
 * para inferir rasgos ESTABLES del usuario que el propio usuario nunca
 * verbalizó como hecho: PATRONES de comportamiento habitual, VALORES que
 * prioriza y OBJETIVOS activos.
 *
 * Los nodos inferidos comparten `type:'Belief'` con los hechos, pero se
 * distinguen con `inferred=1` y tags `['inferred', kind]`, y llevan un
 * `decay_rate` alto (INFERRED_DECAY_RATE) para que desaparezcan por sí solos
 * si el patrón deja de ser relevante. Cada inferencia queda trazable con
 * relaciones `EVIDENCIA_DE` hacia los episodios que la sustentan.
 *
 * Reconciliación:
 *   - `reconcileInferred()` es PROPIA (nunca llama a ContradictionResolver).
 *     Si ya existe un nodo inferido semánticamente similar (>= 0.75), se
 *     refuerza su confidence en vez de duplicar; si no, crea el nodo nuevo.
 *   - `confirmInferred()` es el gancho de la Fase 5: `accepted` lleva la
 *     confidence a 0.9+, `rejected` archiva el nodo directamente.
 *
 * Disparo: piggyback en StateGraph.applyDecay(), después de la consolidación,
 * mismo patrón no-bloqueante. También es invocable a mano para pruebas.
 */

const logger = require('../observability/Logger.js');
const LLMProvider = require('../llm/LLMProvider.js');
const EmbedService = require('../grounding/EmbedService.js');
const { queryEpisodeCandidates } = require('./stores/ConsolidatorStore.js');
const { COMMAND_PATTERNS } = require('./ContradictionResolver.js');
const { FIXED_LABELS, DYNAMIC_PREFIXES } = require('./StateUpdater.js');

/** @param {unknown} e @returns {string} */
function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}

const INFERRED_DECAY_RATE = 0.06;
const INFERRED_TAG = 'inferred';
const EVIDENCIA_DE = 'EVIDENCIA_DE';
const DEFAULT_MIN_OCCURRENCES = 4;
const MAX_INFERENCES_PER_RUN = 6;
// Umbral de agrupación temática (clusters). Distinto y más bajo que el de
// fusión: dos episodios entran al mismo cluster si son "mismo tema", pero
// dos nodos inferidos solo se fusionan si son "casi el mismo rasgo".
const CLUSTER_COSINE_THRESHOLD = 0.5;
const MERGE_SIMILARITY_THRESHOLD = 0.75;

/** @type {Record<string, string>} */
const KIND_TO_PREFIX = {
  pattern: 'patron_',
  value: 'valor_',
  goal: 'objetivo_',
};

const INFERENCE_SYSTEM = `Eres el modelador del usuario del asistente de escritorio.

Recibes episodios de conversación pasados (ya almacenados en memoria) que comparten un mismo tema. Tu tarea es inferir UN rasgo estable del usuario — un PATRÓN de comportamiento habitual, un VALOR que prioriza, o un OBJETIVO activo — SOLO si esos episodios lo respaldan con evidencia repetida.

REGLA CRÍTICA (anti-fabricación):
- Trabaja SOLO con el contenido de los episodios que se te pasan. NUNCA inventes datos, hechos, nombres, preferencias ni proyectos que no estén explícitos en ellos.
- Si los episodios NO muestran un patrón claro y recurrente, responde exactamente con la palabra null. Es preferible no inferir nada a fabricar un rasgo del usuario.
- Un solo episodio NO es suficiente: la inferencia debe repetirse o complementarse entre varios episodios.
- NO uses valores de ejemplo, texto de relleno ni comandos técnicos como inferencia.

Responde ÚNICAMENTE con JSON válido, sin texto extra ni marcas de código:
{ "label": "patron_<slug>", "content": "1-2 oraciones en español", "kind": "pattern", "confidence": 0.0, "episodiosUsados": [1, 2] }

Reglas del JSON:
- label SIEMPRE con prefijo según el kind: "pattern" → "patron_", "value" → "valor_", "goal" → "objetivo_". El resto en minúsculas y snake_case (total ≤ 60 chars).
- content: descripción concreta, derivada 100% de los episodios.
- kind: "pattern" (hábito/comportamiento recurrente), "value" (algo que el usuario valora), "goal" (objetivo activo).
- confidence: número entre 0 y 1 — qué tan fuerte es la evidencia en estos episodios.
- episodiosUsados: subconjunto de los ids de episodios dados que sustentan la inferencia.

Episodios:`;

/** @param {ArrayLike<number>} a @param {ArrayLike<number>} b @returns {number} */
function cosine(a, b) {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Promedio incremental de un vector de cluster: `a` es el promedio de
 * `newCount - 1` elementos y se le agrega `b` como el elemento `newCount`.
 * @param {Float32Array | null} a
 * @param {Float32Array | null} b
 * @param {number} newCount
 * @returns {Float32Array | null}
 */
function avgVector(a, b, newCount) {
  if (!a) return b;
  if (!b) return a;
  const out = new Float32Array(Math.max(a.length, b.length));
  for (let i = 0; i < out.length; i++) {
    const av = i < a.length ? a[i] : 0;
    const bv = i < b.length ? b[i] : 0;
    out[i] = (av * (newCount - 1) + bv) / newCount;
  }
  return out;
}

class UserModelBuilder {
  /**
   * @param {any} db  Base de datos (better-sqlite3 o emulador de memoria).
   * @param {any} graph  Estado compartido (StateGraph): acceso a NodeStore/VectorIndex.
   */
  constructor(db, graph) {
    this._db = db;
    this._g = graph;
  }

  /**
   * Episodios candidatos: MISMO criterio que el consolidator (viejo, activo,
   * sin tag `consolidated`), vía el helper compartido `queryEpisodeCandidates`.
   * @param {{minAgeMs: number, limit: number}} opts
   * @returns {Array<{id:number,label:string,content:string,created_at:number,tags:string}>}
   */
  _findClusterCandidates(opts) {
    return queryEpisodeCandidates(this._db, this._g, opts);
  }

  /**
   * Agrupa los episodios candidatos en clusters temáticos por similitud
   * coseno de sus embeddings. Devuelve clusters con `ids` y `episodes` y su
   * vector promedio. Nunca lanza: un embedding fallido aísla al episodio en
   * un cluster singleton (que no alcanza el mínimo de ocurrencias).
   * @param {Array<{id:number,label:string,content:string,created_at:number,tags:string}>} episodes
   * @returns {Promise<Array<{ids:number[], episodes:Array<{id:number,label:string,content:string,created_at:number,tags:string}>, vec: Float32Array | null}>>}
   */
  async _clusterByTopic(episodes) {
    /** @type {Array<{ep: {id:number,label:string,content:string,created_at:number,tags:string}, vec: Float32Array | null}>} */
    const items = [];
    for (const ep of episodes) {
      let vec = null;
      try {
        vec = await EmbedService.embedText(String(ep.content || '').slice(0, 500));
      } catch (e) {
        logger.warn('UserModel', '[user-model] embedding de episodio fallido:', errMsg(e));
      }
      items.push({ ep, vec });
    }

    /** @type {Array<{ids:number[], episodes:Array<{id:number,label:string,content:string,created_at:number,tags:string}>, vec: Float32Array | null}>} */
    const clusters = [];
    for (const item of items) {
      let bestIdx = -1;
      let bestSim = CLUSTER_COSINE_THRESHOLD;
      for (let i = 0; i < clusters.length; i++) {
        const iv = item.vec;
        const cv = clusters[i].vec;
        const sim = iv && cv ? cosine(iv, cv) : 0;
        if (sim >= bestSim) {
          bestSim = sim;
          bestIdx = i;
        }
      }
      if (bestIdx >= 0) {
        const c = clusters[bestIdx];
        c.ids.push(item.ep.id);
        c.episodes.push(item.ep);
        c.vec = avgVector(c.vec, item.vec, c.ids.length);
      } else {
        clusters.push({ ids: [item.ep.id], episodes: [item.ep], vec: item.vec });
      }
    }
    return clusters;
  }

  /**
   * ¿Queda algún episodio del cluster SIN relación EVIDENCIA_DE? Evita
   * re-inferir (y re-pagar una llamada LLM) por evidencia ya modelada.
   * @param {number[]} epIds
   * @returns {boolean}
   */
  _hasUnmodeledEpisodes(epIds) {
    if (!epIds.length || this._g.usingFallback) return true;
    try {
      const placeholders = epIds.map(() => '?').join(',');
      const row = this._db
        .prepare(
          `SELECT COUNT(*) as c FROM node_relations WHERE type=? AND target_id IN (${placeholders})`
        )
        .get(EVIDENCIA_DE, ...epIds);
      return (row?.c ?? 0) < epIds.length;
    } catch (e) {
      logger.warn('UserModel', '[user-model] no se pudo chequear evidencia:', errMsg(e));
      return true;
    }
  }

  /**
   * Ejecuta una pasada completa de inferencia del modelo de usuario.
   * @param {{minAgeDays?: number, minOccurrences?: number, limit?: number}} [opts]
   * @returns {Promise<{clusters:number, inferred:number, merged:number, rejected:number, skipped:number}>}
   */
  async run(opts = {}) {
    const minOccurrences = opts.minOccurrences ?? DEFAULT_MIN_OCCURRENCES;
    const minAgeMs = Date.now() - (opts.minAgeDays ?? 7) * 86400e3;
    const limit = opts.limit ?? 100;

    const candidates = this._findClusterCandidates({ minAgeMs, limit });
    if (candidates.length < minOccurrences) {
      return { clusters: 0, inferred: 0, merged: 0, rejected: 0, skipped: 0 };
    }

    const clusters = await this._clusterByTopic(candidates);
    const qualifying = clusters
      .filter((c) => c.ids.length >= minOccurrences)
      .slice(0, MAX_INFERENCES_PER_RUN);

    let inferred = 0;
    let merged = 0;
    let rejected = 0;
    let skipped = 0;
    for (const cluster of qualifying) {
      if (!this._hasUnmodeledEpisodes(cluster.ids)) {
        skipped++;
        continue;
      }
      const result = await this._inferFromCluster(cluster);
      if (result.rejected) rejected++;
      else if (result.merged) merged++;
      else inferred++;
    }
    return { clusters: qualifying.length, inferred, merged, rejected, skipped };
  }

  /**
   * Inferencia LLM (modo smart) + validación estricta + reconciliación para
   * un cluster temático.
   * @param {{ids:number[], episodes:Array<{id:number,content:string}>}} cluster
   * @returns {Promise<{rejected:boolean, merged?:boolean, id?:number, reason?:string}>}
   */
  async _inferFromCluster(cluster) {
    const content = cluster.episodes
      .map((ep) => `[episodio ${ep.id}] ${String(ep.content || '').trim()}`)
      .join('\n');

    let raw;
    try {
      raw = await LLMProvider.completeTask([{ role: 'user', content }], INFERENCE_SYSTEM);
    } catch (e) {
      logger.warn('UserModel', '[user-model] llamada LLM fallida:', errMsg(e));
      return { rejected: true, reason: 'llm_error' };
    }

    const candidate = this._parseInference(raw);
    if (!candidate) return { rejected: true, reason: 'no_inference' };

    const validation = this._validateCandidate(candidate, new Set(cluster.ids));
    if (!validation.ok) {
      logger.warn(
        'UserModel',
        `[user-model] inferencia descartada (${validation.reason}): ${candidate.label || '?'}`
      );
      return { rejected: true, reason: validation.reason };
    }

    const res = await this.reconcileInferred(candidate);
    return { rejected: false, merged: res.merged, id: res.id };
  }

  /**
   * Convierte la respuesta cruda del LLM en un candidato estructurado.
   * Devuelve null si no hay inferencia (respuesta `null`/vacía) o si no se
   * puede parsear el JSON.
   * @param {unknown} raw
   * @returns {{label:string, content:string, kind:string, confidence:number, episodiosUsados:number[]} | null}
   */
  _parseInference(raw) {
    const text = String(raw || '').trim();
    if (!text || text === 'null' || /^none$/i.test(text)) return null;
    let parsed;
    try {
      const json = text
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/```\s*$/i, '')
        .trim();
      parsed = JSON.parse(json);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      label: typeof parsed.label === 'string' ? parsed.label.trim() : '',
      content: typeof parsed.content === 'string' ? parsed.content.trim() : '',
      kind: typeof parsed.kind === 'string' ? parsed.kind : '',
      confidence: Number(parsed.confidence),
      episodiosUsados: Array.isArray(parsed.episodiosUsados)
        ? parsed.episodiosUsados.map(Number)
        : [],
    };
  }

  /**
   * Validación ANTES de escribir: nunca se confía en el LLM.
   * @param {{label:string, content:string, kind:string, confidence:number, episodiosUsados:number[]}} candidate
   * @param {Set<number>} allowedEpisodeIds
   * @returns {{ok:true} | {ok:false, reason:string}}
   */
  _validateCandidate(candidate, allowedEpisodeIds) {
    const { label, content, kind, confidence, episodiosUsados } = candidate;

    if (!label) return { ok: false, reason: 'sin label' };
    if (!content || content.length < 8) return { ok: false, reason: 'contenido vacío' };
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      return { ok: false, reason: `confidence fuera de rango (${confidence})` };
    }
    const requiredPrefix = KIND_TO_PREFIX[kind];
    if (!requiredPrefix) return { ok: false, reason: `kind inválido (${kind})` };
    if (!label.startsWith(requiredPrefix)) {
      return { ok: false, reason: `label sin prefijo ${requiredPrefix}` };
    }
    if (/[[\]]/.test(label)) return { ok: false, reason: 'label con leaks de plantilla' };
    // Colisión con hechos (defensa en profundidad; los prefijos patron_/valor_/
    // objetivo_ lo hacen estructuralmente imposible, pero se valida igual).
    if (FIXED_LABELS.has(label)) return { ok: false, reason: 'colisiona con label fijo' };
    if (DYNAMIC_PREFIXES.some((p) => label.startsWith(p))) {
      return { ok: false, reason: 'colisiona con prefijo dinámico' };
    }
    if (label.length > 60) return { ok: false, reason: 'label muy largo' };
    if (!episodiosUsados.length) return { ok: false, reason: 'sin episodios fuente' };
    if (episodiosUsados.some((id) => !allowedEpisodeIds.has(id))) {
      return { ok: false, reason: 'episodio fuera de los enviados' };
    }
    if (COMMAND_PATTERNS.some((p) => p.test(content.trim()))) {
      return { ok: false, reason: 'contenido técnico/comando' };
    }
    return { ok: true };
  }

  /**
   * Reconcilia una inferencia validada contra los nodos inferidos existentes.
   * Esta reconciliación es PROPIA: nunca llega a ContradictionResolver.
   *   - match semántico (inferred=1, _similarity >= 0.75): refuerza confidence
   *     con refuerzo decreciente (conf + 0.15*(1-conf)), registra la nueva
   *     evidencia con EVIDENCIA_DE y refresca verified_at. NO duplica.
   *   - sin match: crea el nodo inferido (Belief, inferred=1, decay alto) y
   *     enlaza EVIDENCIA_DE con cada episodio usado.
   * @param {{label:string, content:string, kind:string, confidence:number, episodiosUsados:number[]}} candidate
   * @returns {Promise<{merged:boolean, id:number, confidence:number}>}
   */
  async reconcileInferred(candidate) {
    /** @type {any[]} */
    let similar = [];
    try {
      similar =
        (await this._g.queryNodesSemantic(candidate.content, {
          type: 'Belief',
          limit: 8,
        })) || [];
    } catch (e) {
      logger.warn('UserModel', '[user-model] búsqueda semántica fallida:', errMsg(e));
    }

    const match = similar.find(
      (n) =>
        n.inferred === 1 &&
        n.archived === 0 &&
        typeof n._similarity === 'number' &&
        n._similarity >= MERGE_SIMILARITY_THRESHOLD
    );

    if (match) {
      const current =
        typeof match.confidence === 'number' ? match.confidence : candidate.confidence;
      const boosted = Math.min(1, current + 0.15 * (1 - current));
      this._g.updateNode(match.id, { confidence: boosted, verified_at: Date.now() });
      for (const epId of candidate.episodiosUsados) {
        this._g.createRelation({ source: match.id, target: epId, type: EVIDENCIA_DE });
      }
      return { merged: true, id: match.id, confidence: boosted };
    }

    const id = this._g.createNode({
      type: 'Belief',
      label: candidate.label,
      content: candidate.content,
      importance: 0.4 + candidate.confidence * 0.4,
      tags: [INFERRED_TAG, candidate.kind],
      inferred: 1,
      confidence: candidate.confidence,
      decay_rate: INFERRED_DECAY_RATE,
    });
    for (const epId of candidate.episodiosUsados) {
      this._g.createRelation({ source: id, target: epId, type: EVIDENCIA_DE });
    }
    return { merged: false, id, confidence: candidate.confidence };
  }

  /**
   * Gancho de la Fase 5: el usuario (o el sistema) confirma o rechaza un nodo
   * inferido.
   *   - 'accepted' → confidence se lleva a 0.9+ (de una).
   *   - 'rejected' → el nodo se archiva directamente.
   * @param {number} nodeId
   * @param {'accepted' | 'rejected'} outcome
   * @returns {{ok:boolean, action?:string, confidence?:number, reason?:string}}
   */
  confirmInferred(nodeId, outcome) {
    if (outcome !== 'accepted' && outcome !== 'rejected') {
      return { ok: false, reason: 'invalid_outcome' };
    }
    const node = this._g.getNode(nodeId);
    if (!node || node.inferred !== 1) {
      return { ok: false, reason: 'not_inferred' };
    }
    if (outcome === 'rejected') {
      this._g._archiveNode(nodeId);
      return { ok: true, action: 'rejected' };
    }
    const current = typeof node.confidence === 'number' ? node.confidence : 0.5;
    const boosted = Math.min(1, Math.max(0.9, current + 0.3 * (1 - current)));
    this._g.updateNode(nodeId, { confidence: boosted, verified_at: Date.now() });
    return { ok: true, action: 'accepted', confidence: boosted };
  }
}

module.exports = {
  UserModelBuilder,
  INFERRED_DECAY_RATE,
  INFERRED_TAG,
  EVIDENCIA_DE,
  DEFAULT_MIN_OCCURRENCES,
  MERGE_SIMILARITY_THRESHOLD,
  KIND_TO_PREFIX,
};
