// @ts-nocheck
const logger = require('../../../observability/Logger.js');
// curiosity.js — curiosidad sobre la MEMORIA del usuario: candidatos que
// preguntan sobre hechos sospechosos (F3.1 'stale'), contradicciones vivas
// (getTensions) e inferencias de confianza media (F3.3/Fase 4, getUserModel).
// Estos candidatos tienen un PRESUPUESTO PROPIO (CURIOSITY_DAILY_CAP),
// separado del presupuesto general, y un boost de saliencia en generación
// cuando el contexto de SO actual se relaciona con el tema.

// ── Perfiles de señal (F-2) ──────────────────────────────────────────────────
// Estos tres tipos no vienen de un evento del bus: los genera ESTE mixin
// desde la memoria. Con registerProfile() quedan registrados en el
// SignalNormalizer en el init del módulo — se ve de dónde salen. La
// saliencia base es baja a propósito (una pregunta de curiosidad no es una
// señal peligrosa); el boost contextual la sube en el momento justo.
const { registerProfile } = require('../../../decision/SignalNormalizer.js');

registerProfile('memory_stale', 'default', {
  severity: 0.15,
  actionability: 0.4,
  salience: 0.3,
  costOfIgnore: 0.1,
  urgencia: 0.2,
  confianza: 0.6,
});
registerProfile('pattern_uncertain', 'default', {
  severity: 0.1,
  actionability: 0.35,
  salience: 0.25,
  costOfIgnore: 0.05,
  urgencia: 0.15,
  confianza: 0.5,
});
registerProfile('memory_tension', 'default', {
  severity: 0.2,
  actionability: 0.45,
  salience: 0.3,
  costOfIgnore: 0.1,
  urgencia: 0.25,
  confianza: 0.65,
});
// Intención abandonada (status='active' sin actividad en N días): una meta que
// el usuario pidió hace tiempo y quedó a medias es MÁS accionable que un hecho
// viejo (la tarea es recuperable con continuidad real de conversación), así que
// pesa un poco más que memory_stale en todos los ejes.
registerProfile('intention_stale', 'default', {
  severity: 0.2,
  actionability: 0.55,
  salience: 0.35,
  costOfIgnore: 0.15,
  urgencia: 0.3,
  confianza: 0.7,
});

const { extractThemeTerms } = require('../../../core/misc.js');
const { _localDayString } = require('../helpers.js');
const { INTENTION_STALE_DAYS } = require('../config.js');

const DAY_MS = 24 * 60 * 60 * 1000;

// Confianza media: ni tan baja que no valga preguntar, ni tan alta que ya se
// pueda asumir como hecho. Fuera de este rango el nodo inferido no da lugar a
// una pregunta de curiosidad.
const MIN_MID_CONFIDENCE = 0.4;
const MAX_MID_CONFIDENCE = 0.75;

// Boost de saliencia para un match semántico fuerte con el contexto de SO.
const BOOST_BASE = 0.15;
const BOOST_PER_HIT = 0.05;
const BOOST_MAX = 0.3;

/** Rango medio de confianza para inferencias que vale la pena revalidar. */
function isMidConfidence(conf) {
  return typeof conf === 'number' && conf >= MIN_MID_CONFIDENCE && conf <= MAX_MID_CONFIDENCE;
}

/** Parsea la columna tags (JSON string) o un array ya listo. */
function _tagsOf(node) {
  const t = node && node.tags;
  if (Array.isArray(t)) return t;
  try {
    const parsed = JSON.parse(t || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

module.exports = {
  // ── Origen de candidatos ────────────────────────────────────────────────────
  // Al ser presupuesto propio y bajo (CURIOSITY_DAILY_CAP), la barrera real la
  // pone el CONTEXTO: el gate rechaza si el cupo diario se agotó, y el boost
  // de saliencia decide cuáles valen la pena cuando el usuario está justo en
  // el tema.

  /**
   * Hechos fijos marcados 'stale' (F3.1, FactReasonerStore): datos que el
   * usuario contó antes y que llevan demasiado tiempo sin revalidarse. Sin
   * acceso a recencia (a diferencia de queryNodes, que refresca el acceso).
   */
  _staleFacts() {
    const g = this._graph;
    if (!g) return [];
    try {
      let nodes;
      if (typeof g._db?.prepare === 'function' && !g.usingFallback) {
        nodes = g._db
          .prepare(
            `SELECT id, label, content, tags FROM nodes
             WHERE archived=0 AND tags LIKE '%"stale"%'
             ORDER BY importance DESC LIMIT 5`
          )
          .all();
      } else if (typeof g.queryNodes === 'function') {
        nodes = g.queryNodes({ limit: 50 }) || [];
      } else {
        return [];
      }
      return nodes.filter((n) => _tagsOf(n).includes('stale'));
    } catch (e) {
      logger.warn('curiosity', '[proactive] error leyendo hechos stale:', e.message);
      return [];
    }
  },

  /**
   * Intenciones ABANDONADAS (IntentionsStore): metas con status='active' y sin
   * actividad (`last_progress_at`) en más de INTENTION_STALE_DAYS días. El
   * texto REAL de la meta (`goal`) viaja en el candidato — es lo que hace que
   * el mensaje se sienta como continuidad real de conversación, no un template
   * genérico ("dijiste que ibas a X, ¿cómo va?").
   */
  _staleIntentions() {
    const g = this._graph;
    if (!g) return [];
    try {
      const rows =
        (typeof g.listStaleIntentions === 'function' &&
          g.listStaleIntentions({ olderThanMs: INTENTION_STALE_DAYS * DAY_MS, limit: 20 })) ||
        [];
      return rows.filter((i) => i.goal);
    } catch (e) {
      logger.warn('curiosity', '[proactive] error leyendo intenciones stale:', e.message);
      return [];
    }
  },

  /**
   * Boost de saliencia en TIEMPO DE GENERACIÓN (no en el perfil estático): si
   * el contexto de SO actual (app activa, título de ventana) comparte términos
   * significativos con el label/contenido del hecho sospechoso o con la
   * inferencia, la pregunta deja de ser random y pasa a ser sobre lo que el
   * usuario está haciendo AHORA. p. ej. "justo estás en un proyecto de trabajo"
   * sube la prioridad de preguntar sobre `trabajo_usuario` stale.
   */
  _contextBoostFor(label, content) {
    const osCtx = this._osSensor?.getCurrentContext?.() ?? {};
    const ctxText = [osCtx.friendlyName, osCtx.app, osCtx.title].filter(Boolean).join(' ').trim();
    if (!ctxText) return 0;
    const terms = extractThemeTerms(ctxText);
    if (!terms.length) return 0;
    const target = `${label || ''} ${content || ''}`
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    const hits = terms.filter((t) => target.includes(t)).length;
    if (!hits) return 0;
    return Math.max(0, Math.min(BOOST_MAX, BOOST_BASE + (hits - 1) * BOOST_PER_HIT));
  },

  /**
   * Recolecta los candidatos de curiosidad del momento: hechos stale,
   * contradicciones vivas e inferencias de confianza media. Cada candidato es
   * un `trigger` del pipeline normal (gate → score → LLM) con su payload y el
   * `salienceBoost` contextual ya calculado.
   */
  _collectCuriosityCandidates() {
    const g = this._graph;
    if (!g || !g._ready) return [];

    const candidates = [];

    // 1) Hechos sospechosos (stale).
    for (const f of this._staleFacts()) {
      if (!f.label || !f.content) continue;
      candidates.push({
        type: 'memory_stale',
        kind: f.label,
        nodeId: f.id,
        label: f.label,
        content: f.content,
        salienceBoost: this._contextBoostFor(f.label, f.content),
        context: `El dato "${f.content}" (${f.label}) lo contó el usuario hace tiempo y quedó marcado como posiblemente caducado (sin revalidar).`,
      });
    }

    // 2) Contradicciones vivas (getTensions — hoy subutilizado).
    try {
      for (const t of g.getTensions?.() ?? []) {
        if (!t.label) continue;
        candidates.push({
          type: 'memory_tension',
          kind: 'default',
          label: t.label,
          nodeA: t.a,
          nodeB: t.b,
          contentA: t.contentA,
          contentB: t.contentB,
          salienceBoost: this._contextBoostFor(t.label, `${t.contentA || ''} ${t.contentB || ''}`),
          context: `En la memoria hay una contradicción sin resolver sobre "${t.label}": "${t.contentA}" vs "${t.contentB}".`,
        });
      }
    } catch (e) {
      logger.warn('curiosity', '[proactive] error leyendo tensiones:', e.message);
    }

    // 3) Inferencias de confianza media (Fase 4, getUserModel).
    try {
      for (const n of g.getUserModel?.({ limit: 20 }) ?? []) {
        if (!isMidConfidence(n.confidence)) continue;
        if (!n.content) continue;
        candidates.push({
          type: 'pattern_uncertain',
          kind: 'default',
          nodeId: n.id,
          label: n.label,
          content: n.content,
          confidence: n.confidence,
          salienceBoost: this._contextBoostFor(n.label, n.content),
          context: `Kaoru infirió algo sobre el usuario con confianza media (${Math.round(n.confidence * 100)}%): "${n.content}".`,
        });
      }
    } catch (e) {
      logger.warn('curiosity', '[proactive] error leyendo modelo del usuario:', e.message);
    }

    // 4) Intenciones abandonadas (IntentionsStore): metas activas sin actividad
    //    en INTENTION_STALE_DAYS días. El candidato lleva el TEXTO REAL de la
    //    meta para que el mensaje sea continuidad real de conversación.
    for (const i of this._staleIntentions()) {
      candidates.push({
        type: 'intention_stale',
        kind: 'default',
        nodeId: i.id,
        label: i.goal,
        goal: i.goal,
        lastProgress: i.last_progress || '',
        lastProgressAt: i.last_progress_at,
        salienceBoost: this._contextBoostFor(i.goal, i.last_progress || ''),
        context: `El usuario me pidió hace tiempo que haga "${i.goal}" y quedó activa sin actividad (status='active'). Pregúntale cómo va usando su texto real.${i.last_progress ? ` Último progreso que dejó: "${i.last_progress}".` : ''}`,
      });
    }

    return candidates;
  },

  // ── Arranque desde el heartbeat ─────────────────────────────────────────────
  // Evaluación temporal (una vez por heartbeat, ver time-based). Los candidatos
  // pasan por el pipeline normal: el gate impone el cupo de curiosidad, el
  // boost de contexto y el cooldown; el LLM produce el mensaje.

  async _maybeCuriosity() {
    try {
      const candidates = this._collectCuriosityCandidates();
      if (!candidates.length) return;
      // Máximo UNA pregunta de curiosidad por ciclo: se prefiere el candidato
      // con mayor boost contextual ("justo estás en el tema"), y si el LLM no
      // decide escribir, el resto espera al próximo heartbeat (el cooldown de
      // 6h por tipo pone el techo de acoso, no estos intentos).
      const [trigger] = candidates.sort((a, b) => (b.salienceBoost ?? 0) - (a.salienceBoost ?? 0));
      if (!this._running || this._deciding) return;
      const result = await this._tryTrigger(trigger);
      return typeof result === 'string';
    } catch (e) {
      logger.warn('curiosity', '[proactive] error evaluando curiosidad:', e.message);
    }
  },

  // ── Cupo propio (separado del presupuesto general) ──────────────────────────

  /** Devuelve cuántas preguntas de curiosidad ya se enviaron HOY. */
  _curiosityUsedToday() {
    const day = _localDayString(Date.now());
    if (this._curiosityDay !== day) return 0;
    return this._curiosityFired;
  },

  /** Registra un envío de curiosidad (resetea el contador si cambió el día). */
  _envelopeCuriosityFired() {
    const day = _localDayString(Date.now());
    if (this._curiosityDay !== day) {
      this._curiosityDay = day;
      this._curiosityFired = 0;
    }
    this._curiosityFired += 1;
  },

  // ── Outcome → confirmInferred (Fase 3) ──────────────────────────────────────
  // La respuesta del usuario a una propuesta de pattern_uncertain NO solo
  // alimenta el feedback general (ProposalStore/receptividad, ya cubierto por
  // handleDecision): además confirma o rechaza el nodo inferido en el modelo
  // del usuario. `accepted` sube su confidence a 0.9+, `rejected` lo archiva.

  _connectCuriosityOutcome(proposalId, type, decision) {
    if (type !== 'pattern_uncertain') {
      this._proposalRefs?.delete(proposalId);
      return;
    }
    const ref = this._proposalRefs?.get(proposalId) || null;
    this._proposalRefs?.delete(proposalId);
    if (!ref?.nodeId) return;
    if (decision !== 'accepted' && decision !== 'rejected') return;
    if (!this._graph?.confirmInferred) return;
    try {
      this._graph.confirmInferred(ref.nodeId, decision);
    } catch (e) {
      logger.warn('curiosity', '[proactive] error confirmando inferencia:', e.message);
    }
  },
};
