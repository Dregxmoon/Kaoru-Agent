// @ts-check
'use strict';

/**
 * ConsolidatorStore.js — Fase 2, ítem 2: consolidación episodio→semántica.
 *
 * Convierte episodios VIEJOS y no consolidados en hechos persistentes
 * (nodos `Belief`). Es 100% determinista (sin LLM): tokeniza el contenido de
 * los episodios, agrupa por términos recurrentes entre sesiones y por cada
 * término con >= minOccurrences menciones crea (o actualiza, es idempotente)
 * un nodo `consolidacion_<término>` con importancia proporcional a la
 * recurrencia. Los episodios fuente se marcan con el tag `consolidated` y se
 * registran enlaces `node_relations` (tipo CONSOLIDA) entre el hecho y sus
 * episodios fuente.
 *
 * Se dispara desde StateGraph.applyDecay() (job piggyback del ciclo de
 * mantenimiento) y también es invocable a mano para pruebas.
 */

const logger = require('../../observability/Logger.js');

/** @param {unknown} e @returns {string} */
function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}

const CONSOLIDATED_TAG = 'consolidated';
const RELATION_TYPE = 'CONSOLIDA';
const MAX_TERMS_PER_DOC = 40;
const MAX_FACTS = 10;

// Términos poco informativos (español técnico + inglés). Se filtran porque
// no aportan señal de tema recurrente entre sesiones.
const STOPWORDS = new Set(
  (
    'usuario asesor recuerdo recuerda recuerdos sesion sesiones conversacion ' +
    'conversaciones mensaje mensajes pregunta preguntas respuesta respuestas ' +
    'dijo dice hablo hablo hablamos conto comento menciono explico pregunta ' +
    'cliente notario contrato quieres quiere puedo puedes poder tambien ademas ' +
    'entonces bueno claro vale genial perfecto ok okey okay and the that this ' +
    'with your from have been were where what when which there their them they '
  ).split(/\s+/)
);

class ConsolidatorStore {
  /**
   * @param {any} db  Base de datos (better-sqlite3 o emulador de memoria).
   * @param {any} graph  Estado compartido (StateGraph): acceso a NodeStore.
   */
  constructor(db, graph) {
    this._db = db;
    this._g = graph;
  }

  /**
   * Términos significativos de un texto.
   * @param {string} text
   * @returns {string[]}
   */
  _tokenize(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !/^\d+$/.test(w) && !STOPWORDS.has(w))
      .slice(0, MAX_TERMS_PER_DOC);
  }

  /**
   * Episodios candidatos: viejos, activos, sin tag `consolidated`.
   * @param {{minAgeMs: number, limit: number}} opts
   * @returns {Array<{id:number,label:string,content:string,created_at:number,tags:string}>}
   */
  _candidates({ minAgeMs, limit }) {
    if (this._g.usingFallback) return [];
    try {
      const rows = this._db
        .prepare(
          `SELECT id, label, content, created_at, tags FROM nodes
           WHERE type='Episode' AND archived=0 AND created_at < ?
           ORDER BY created_at ASC LIMIT ?`
        )
        .all(minAgeMs, limit);
      const typed =
        /** @type {Array<{id:number,label:string,content:string,created_at:number,tags:string}>} */ (
          rows
        );
      return typed.filter((r) => {
        try {
          const t = JSON.parse(r.tags || '[]');
          return !t.includes(CONSOLIDATED_TAG);
        } catch {
          return true;
        }
      });
    } catch (e) {
      logger.warn('Consolidator', '[consolidator] error al leer candidatos:', errMsg(e));
      return [];
    }
  }

  /** @param {number[]} ids */
  _markConsolidated(ids) {
    for (const id of ids) {
      try {
        const row = this._db.prepare('SELECT tags FROM nodes WHERE id=?').get(id);
        if (!row) continue;
        let tags = [];
        try {
          tags = JSON.parse(row.tags || '[]');
        } catch {
          /* tags corruptas: se tratan como vacías */
        }
        if (!tags.includes(CONSOLIDATED_TAG)) tags.push(CONSOLIDATED_TAG);
        this._db.prepare('UPDATE nodes SET tags=? WHERE id=?').run(JSON.stringify(tags), id);
      } catch (e) {
        logger.warn('Consolidator', `[consolidator] no se pudo marcar episodio ${id}:`, errMsg(e));
      }
    }
  }

  /** @param {number} sourceId @param {number} targetId @param {string} type */
  _insertRelation(sourceId, targetId, type) {
    try {
      this._db
        .prepare('INSERT INTO node_relations (source_id, target_id, type) VALUES (?,?,?)')
        .run(sourceId, targetId, type);
    } catch (e) {
      logger.warn(
        'Consolidator',
        `[consolidator] no se pudo registrar relación ${sourceId}→${targetId}:`,
        errMsg(e)
      );
    }
  }

  /** @param {string} term @returns {string} */
  _slug(term) {
    return term.replace(/[^a-z0-9_]+/g, '_').slice(0, 60);
  }

  /**
   * Ejecuta una pasada de consolidación. Determinista e idempotente.
   * @param {{minAgeDays?: number, minOccurrences?: number, limit?: number}} [opts]
   * @returns {{episodes: number, facts: Array<{id:number,label:string,term:string,occurrences:number}>}}
   */
  runConsolidation(opts = {}) {
    const minAgeDays = opts.minAgeDays ?? 7;
    const minOccurrences = opts.minOccurrences ?? 2;
    const limit = opts.limit ?? 50;

    const candidates = this._candidates({
      minAgeMs: Date.now() - minAgeDays * 86400e3,
      limit,
    });
    if (candidates.length < minOccurrences) {
      return { episodes: 0, facts: [] };
    }

    /** @type {Map<string, {episodes:Set<number>, dates:number[]}>} */
    const termIndex = new Map();
    for (const ep of candidates) {
      const terms = new Set(this._tokenize(ep.content));
      for (const term of terms) {
        if (!termIndex.has(term)) {
          termIndex.set(term, { episodes: new Set(), dates: [] });
        }
        const entry = termIndex.get(term);
        if (entry) {
          entry.episodes.add(ep.id);
          entry.dates.push(ep.created_at);
        }
      }
    }

    /** @type {Array<{term:string, count:number, dates:number[]}>} */
    const recurring = [];
    for (const [term, entry] of termIndex) {
      if (entry.episodes.size >= minOccurrences) {
        recurring.push({ term, count: entry.episodes.size, dates: entry.dates });
      }
    }
    recurring.sort((a, b) => b.count - a.count || a.term.localeCompare(b.term));
    const top = recurring.slice(0, MAX_FACTS);

    /** @type {Array<{id:number,label:string,term:string,occurrences:number}>} */
    const facts = [];
    /** @type {Set<number>} */
    const factEpisodes = new Set();
    for (const r of top) {
      const slug = `consolidacion_${this._slug(r.term)}`;
      const dates = r.dates.slice().sort((a, b) => a - b);
      /** @param {number} t @returns {string} */
      const fmt = (t) => new Date(t).toLocaleDateString('es-MX');
      const range =
        dates.length === 1 ? fmt(dates[0]) : `${fmt(dates[0])} — ${fmt(dates[dates.length - 1])}`;
      const content = `El usuario mencionó "${r.term}" en ${r.count} sesiones distintas (${range}).`;
      const id = this._g.upsertNode({
        type: 'Belief',
        label: slug,
        content,
        importance: Math.min(0.9, 0.5 + r.count * 0.05),
        tags: ['consolidacion', r.term],
      });
      facts.push({ id, label: slug, term: r.term, occurrences: r.count });
      for (const epId of termIndex.get(r.term)?.episodes ?? []) {
        factEpisodes.add(epId);
        this._insertRelation(id, epId, RELATION_TYPE);
      }
    }

    if (facts.length > 0) {
      this._markConsolidated([...factEpisodes]);
      logger.info(
        'Consolidator',
        `[consolidator] ${factEpisodes.size} episodios → ${facts.length} hechos consolidados`
      );
    }
    return { episodes: facts.length ? factEpisodes.size : 0, facts };
  }

  /**
   * Enlaces registrados para un nodo (relaciones salientes y entrantes).
   * @param {number} nodeId
   * @returns {Array<{id:number,source_id:number,target_id:number,type:string}>}
   */
  getRelations(nodeId) {
    if (this._g.usingFallback) return [];
    try {
      return this._db
        .prepare(
          'SELECT id, source_id, target_id, type FROM node_relations WHERE source_id=? OR target_id=?'
        )
        .all(nodeId, nodeId);
    } catch (e) {
      logger.warn('Consolidator', '[consolidator] error al leer relaciones:', errMsg(e));
      return [];
    }
  }
}

module.exports = { ConsolidatorStore, CONSOLIDATED_TAG, RELATION_TYPE };
