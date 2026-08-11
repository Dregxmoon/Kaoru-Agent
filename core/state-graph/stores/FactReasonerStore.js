// @ts-check
'use strict';

const logger = require('../../observability/Logger.js');

/**
 * FactReasonerStore.js — F3.1: vigencia de hechos fijos (FIXED_LABELS).
 *
 * Hasta ahora un FIXED_LABEL (trabajo_usuario, proyecto_principal, etc.) se
 * escribía una vez y se confiaba para siempre: no había forma de detectar que
 * "trabajo en X" lleva meses sin revalidarse. Esta store da a esos hechos una
 * noción de VIGENCIA (columna `verified_at`) y de COHERENCIA entre ellos
 * (CASCADE_STALENESS).
 *
 * STALENESS_DAYS — umbral de días por label. Solo entran labels donde tiene
 * sentido que el dato "caduque" (hechos sujetos a cambio con el tiempo).
 * Labels permanentes por naturaleza (nombre_usuario, cumpleanos_usuario,
 * gustos) NO están en el mapa: nunca se marcan como stale.
 *
 * CASCADE_STALENESS — cuando un label del recorrido se overwritea, los labels
 * relacionados se marcan para revalidar (verified_at = null). Se dispara desde
 * ContradictionResolver._applyPolicy en la rama 'overwrite' (la información
 * nueva llega vía el flujo de reconciliación, no aquí).
 *
 * run() recorre los nodos activos con label en STALENESS_DAYS y, si
 * (now - (verified_at || created_at)) supera el umbral, agrega el tag 'stale'
 * al nodo (mecanismo de tags existente — menos invasivo que una relación
 * REVISAR). Se ejecuta desde StateGraph.applyDecay() como job piggyback
 * no-bloqueante (mismo patrón que ConsolidatorStore.runConsolidation).
 */

const DAY_MS = 86400000;

/**
 * @typedef {object} StalenessRow
 * @property {number} id
 * @property {string} label
 * @property {number} created_at
 * @property {number | null} verified_at
 * @property {string} tags
 */

/** @type {Record<string, number>} */
const STALENESS_DAYS = {
  trabajo_usuario: 150,
  proyecto_principal: 90,
  ubicacion_usuario: 180,
};

/** @type {Record<string, string[]>} */
const CASCADE_STALENESS = {
  trabajo_usuario: ['proyecto_principal'],
};

const STALE_TAG = 'stale';

/** @param {unknown} e @returns {string} */
function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}

class FactReasonerStore {
  /**
   * @param {any} db  Base de datos (better-sqlite3 o emulador de memoria).
   * @param {any} graph  Estado compartido (StateGraph): acceso a NodeStore.
   */
  constructor(db, graph) {
    this._db = db;
    this._g = graph;
  }

  /**
   * Nodos activos candidatos a staleness: label en STALENESS_DAYS.
   * @returns {StalenessRow[]}
   */
  _candidates() {
    if (this._g.usingFallback) return [];
    const labels = Object.keys(STALENESS_DAYS);
    const placeholders = labels.map(() => '?').join(',');
    try {
      const rows = this._db
        .prepare(
          `SELECT id, label, content, created_at, verified_at, tags FROM nodes
           WHERE archived=0 AND label IN (${placeholders})`
        )
        .all(...labels);
      return /** @type {StalenessRow[]} */ (rows);
    } catch (e) {
      logger.warn('FactReasoner', '[fact-reasoner] error al leer candidatos:', errMsg(e));
      return [];
    }
  }

  /**
   * Agrega el tag `stale` a un nodo si aún no lo tiene (idempotente).
   * @param {number} id
   * @returns {boolean} true si el tag se agregó.
   */
  _tagStale(id) {
    try {
      const row = this._db.prepare('SELECT tags FROM nodes WHERE id=?').get(id);
      if (!row) return false;
      let tags = [];
      try {
        tags = JSON.parse(row.tags || '[]');
      } catch {
        /* tags corruptas: se tratan como vacías */
      }
      if (tags.includes(STALE_TAG)) return false;
      tags.push(STALE_TAG);
      this._db.prepare('UPDATE nodes SET tags=? WHERE id=?').run(JSON.stringify(tags), id);
      return true;
    } catch (e) {
      logger.warn('FactReasoner', `[fact-reasoner] no se pudo marcar nodo ${id}:`, errMsg(e));
      return false;
    }
  }

  /**
   * Pasada de staleness sobre los hechos fijos con vigencia. Idempotente:
   * un nodo ya taggeado 'stale' no se vuelve a marcar (aunque siga stale).
   * @returns {{ checked: number, stale: number }}
   */
  run() {
    if (this._g.usingFallback) return { checked: 0, stale: 0 };

    const now = Date.now();
    const candidates = this._candidates();
    let stale = 0;

    for (const node of candidates) {
      const thresholdDays = STALENESS_DAYS[node.label];
      if (!thresholdDays) continue;
      // Vigencia = última confirmación; si nunca se confirmó (verified_at NULL,
      // p. ej. tras una cascada de invalidación), cae a created_at.
      const verified = node.verified_at || node.created_at;
      const ageDays = (now - verified) / DAY_MS;
      if (ageDays > thresholdDays) {
        if (this._tagStale(node.id)) stale++;
      }
    }

    if (stale > 0) {
      logger.info(
        'FactReasoner',
        `[fact-reasoner] ${stale} hecho(s) fijo(s) marcados como 'stale'` +
          ` (${candidates.length} revisados)`
      );
    }
    return { checked: candidates.length, stale };
  }

  /**
   * Cascada de invalidación: cuando un label en CASCADE_STALENESS se overwritea
   * (se confirmó de nuevo), los labels relacionados quedan sin vigencia
   * (verified_at = null) para que la próxima pasada los detecte como stale y
   * se revaliden. Lo llama ContradictionResolver._applyPolicy.
   * @param {string} label Label overwriteado.
   * @returns {number} cantidad de nodos relacionados invalidados.
   */
  invalidateCascade(label) {
    const related = CASCADE_STALENESS[label] || [];
    if (!related.length) return 0;
    let touched = 0;
    for (const relLabel of related) {
      const node = this._g._findActiveNodeByLabel(relLabel);
      if (!node) continue;
      try {
        this._db.prepare('UPDATE nodes SET verified_at=NULL WHERE id=?').run(node.id);
        touched++;
        logger.info(
          'FactReasoner',
          `[fact-reasoner] cascada: ${label} overwriteado → ${relLabel} marcado para revalidar`
        );
      } catch (e) {
        logger.warn('FactReasoner', `[fact-reasoner] no se pudo invalidar ${relLabel}:`, errMsg(e));
      }
    }
    return touched;
  }
}

module.exports = {
  FactReasonerStore,
  STALENESS_DAYS,
  CASCADE_STALENESS,
  STALE_TAG,
};
