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
// Topic en declive: momentum bajo, menciones pasadas pero Declining interest.
registerProfile('topic_cold', 'default', {
  severity: 0.15,
  actionability: 0.4,
  salience: 0.3,
  costOfIgnore: 0.1,
  urgencia: 0.2,
  confianza: 0.6,
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

    // 5) Topic momentum: cold topics (declining interest)
    try {
      const topicTracker = g.getTopicTracker?.();
      if (topicTracker) {
        const coldTopics = topicTracker.getColdTopics({ limit: 3, maxMomentum: 0.2 });
        for (const t of coldTopics) {
          candidates.push({
            type: 'topic_cold',
            kind: 'default',
            label: t.topic,
            content: `El topic "${t.topic.replace(/_/g, ' ')}" tenía actividad pero está decayendo (momentum: ${t.momentum.toFixed(2)}).`,
            salienceBoost: this._contextBoostFor(t.topic, t.topic.replace(/_/g, ' ')),
            context: `El usuario hablaba de "${t.topic.replace(/_/g, ' ')}" pero ya no tanto. Pregúntale si sigue interesado.`,
          });
        }
      }
    } catch (e) {
      logger.warn('curiosity', '[proactive] error leyendo topic momentum:', e.message);
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

  // ── Outcome → cierre del lazo de revalidación (Fase 3/5) ─────────────────────
  // La respuesta del usuario a una propuesta de curiosidad NO solo alimenta el
  // feedback general (ProposalStore/receptividad, ya cubierto por
  // handleDecision): además cierra el lazo sobre la MEMORIA según el tipo:
  //   pattern_uncertain → confirmInferred (sube confidence o archiva)
  //   memory_stale      → accepted: verified_at=now + quita 'stale'; rejected: archiva
  //   memory_tension    → accepted: se queda nodeA, archiva nodeB; rejected: al revés
  //   intention_stale   → accepted: refresca last_progress_at (deja de ser stale);
  //                       rejected: dropIntention

  _connectCuriosityOutcome(proposalId, type, decision) {
    const ref = this._proposalRefs?.get(proposalId) || null;
    this._proposalRefs?.delete(proposalId);
    if (decision !== 'accepted' && decision !== 'rejected') return;
    if (!this._graph || !ref) return;
    try {
      switch (type) {
        case 'pattern_uncertain':
          if (ref.nodeId && typeof this._graph.confirmInferred === 'function') {
            this._graph.confirmInferred(ref.nodeId, decision);
          }
          break;
        case 'memory_stale':
          this._resolveStaleRef(ref, decision);
          break;
        case 'memory_tension':
          this._resolveTensionRef(ref, decision);
          break;
        case 'intention_stale':
          this._resolveIntentionRef(ref, decision);
          break;
        default:
          break;
      }
    } catch (e) {
      logger.warn('curiosity', '[proactive] error cerrando outcome de curiosidad:', e.message);
    }
  },

  /**
   * Hecho 'stale' revalidado. Aceptado: el dato sigue vigente → se refresca
   * verified_at (el FactReasoner usa esa fecha para volver a marcarlo caduco)
   * y se quita el tag 'stale' para que no reaparezca en el barrido; la
   * importancia se ancla a 0.7 mínimo (una reconfirmación refuerza el dato).
   * Rechazado: el dato ya no vale → se archiva.
   */
  _resolveStaleRef(ref, decision) {
    const node = this._graph.getNode ? this._graph.getNode(ref.nodeId) : null;
    if (!node) return;
    if (decision === 'rejected') {
      if (typeof this._graph._archiveNode === 'function') {
        this._graph._archiveNode(node.id);
      }
      return;
    }
    const tags = _tagsOf(node).filter((t) => t !== 'stale');
    if (typeof this._graph.updateNode !== 'function') return;
    this._graph.updateNode(ref.nodeId, {
      verified_at: Date.now(),
      importance: Math.max(node.importance ?? 0.5, 0.7),
      tags,
    });
  },

  /**
   * Contradicción viva resuelta: el usuario elige qué versión se queda
   * (nodeA al aceptar, nodeB al rechazar). Se archiva la descartada; con un
   * lado archivado el par CONTRADICES deja de aparecer (getTensions filtra
   * por archived=0) sin necesidad de borrar la relación.
   */
  _resolveTensionRef(ref, decision) {
    if (typeof this._graph._archiveNode !== 'function') return;
    const toArchive = decision === 'accepted' ? ref.nodeB : ref.nodeA;
    if (toArchive != null) this._graph._archiveNode(toArchive);
  },

  /**
   * Meta abandonada: aceptar = sigue vigente → se refresca last_progress_at
   * (IntentionsStore.update lo actualiza a ahora, así deja de salir como
   * 'stale'); rechazar = ya no interesa → dropIntention.
   */
  _resolveIntentionRef(ref, decision) {
    if (!ref.nodeId) return;
    if (decision === 'rejected') {
      if (typeof this._graph.dropIntention === 'function') {
        this._graph.dropIntention(ref.nodeId);
      }
      return;
    }
    if (typeof this._graph.updateIntention === 'function') {
      this._graph.updateIntention(ref.nodeId, { lastProgress: 'Retomada por el usuario' });
    }
  },
};
