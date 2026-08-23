// @ts-nocheck
const logger = require('../../../observability/Logger.js');
// proposals.js — propuestas con consentimiento (Fase A/B): ensamblado del
// payload de iniciativa, generación del bloque `proposal` determinista y el
// manejo de la decisión del usuario (aceptar/descartar → ejecutar).

const crypto = require('crypto');

const { receptividad } = require('../../../decision/DecisionCore.js');
const { PROPOSAL_HINTS, CURIOSITY_TYPES } = require('../config.js');

module.exports = {
  // ── Fase A: propuestas con consentimiento ────────────────────────────────────

  /**
   * Ensambla el payload de iniciativa. `proposal` es un bloque DETERMINISTA
   * (nunca lo inventa el LLM): título, preview y acción declarada vienen del
   * mapa PROPOSAL_HINTS según tipo/kind del sensor. Si hay executor (Fase B),
   * la preview se enriquece con el diff real (solo lectura) de la acción; la
   * MUTACIÓN solo ocurre tras el clic del usuario (handleDecision). Si no hay
   * hint, la iniciativa es solo informativa (proposal: null).
   */
  async _buildPayload(trigger, message) {
    const proposal = await this._buildProposal(trigger);
    return {
      reason: trigger.type,
      suggestion: message,
      actionType: 'proactive',
      canHelp: true,
      utility: 1.0,
      openChat: true,
      proposalId: proposal ? proposal.id : null,
      proposal,
    };
  },

  async _buildProposal(trigger) {
    const byKind = PROPOSAL_HINTS[trigger.type];
    if (!byKind) return null;
    let hint = (trigger.kind && byKind[trigger.kind]) || byKind.default || null;
    if (!hint) return null;

    // Fase D: para apply_patch el parche lo genera el LLM y lo VALIDA el
    // executor (fragmentos exactos y únicos). Si no se logra un parche
    // válido, la propuesta cae a informativa (no_patch): nunca se promete
    // un parche que no se pueda aplicar.
    let action = null;
    if (hint.action?.tool === 'apply_patch') {
      const patch = await this._generatePatch(trigger);
      if (patch && patch.changes && patch.changes.length) {
        action = {
          tool: 'apply_patch',
          params: {
            file: trigger.file,
            changes: patch.changes,
            targetErrors: trigger.errors || [],
          },
        };
      } else {
        // Sin parche válido → cae a informativa (no_patch). REGRESIÓN fix:
        // feffdd7 borró sin querer este switch y la propuesta quedaba con
        // kind='action' + action=null → aceptar no hacía nada.
        if (trigger.type === 'lsp_error') {
          logger.info(
            'proposals',
            `[proactive] lsp_error sin parche válido → propuesta informativa (aceptar no ejecutará nada)`
          );
        }
        hint = byKind.no_patch || null;
        if (!hint) return null;
      }
    } else if (hint.action) {
      // Fase B: la acción se resuelve en el backend (whitelist), nunca confía
      // en lo que devuelva el renderer. Los params se derivan del trigger.
      action = {
        tool: hint.action.tool,
        params: this._resolveActionParams(hint.action.tool, trigger),
      };
    }

    let preview = hint.preview;
    let diff = null;
    if (action && this._executor) {
      try {
        const p = await this._executor.preview(action);
        if (p && p.ok) {
          if (p.preview) preview = p.preview;
          if (p.diff) diff = p.diff;
        }
      } catch (e) {
        logger.warn('proposals', '[proactive] error generando preview de acción:', e.message);
      }
    }

    const proposal = {
      id: crypto.randomUUID(),
      type: trigger.type,
      kind: hint.kind || 'info',
      title: hint.title,
      preview,
      diff,
      action,
      requiresConsent: action ? 'confirm' : null,
      createdAt: Date.now(),
    };

    // Fase nueva (curiosidad): la propuesta recuerda a qué nodo de memoria
    // apunta para que el outcome del usuario cierre el lazo de revalidación
    // (confirmInferred para pattern_uncertain; stale/tensión/intención en
    // _connectCuriosityOutcome) además del feedback general.
    if (CURIOSITY_TYPES.has(trigger.type) && trigger.nodeId != null) {
      proposal.nodeId = trigger.nodeId;
      this._proposalRefs.set(proposal.id, { nodeId: trigger.nodeId });
    }
    if (trigger.type === 'memory_tension' && trigger.nodeA != null) {
      this._proposalRefs.set(proposal.id, {
        nodeA: trigger.nodeA,
        nodeB: trigger.nodeB,
      });
    }

    if (action) {
      // Memoria efímera de acciones pendientes (la ejecución llega en
      // handleDecision). Guarda el trigger para el reintento informado (P2).
      // Se acota para no crecer sin límite.
      this._pendingActions.set(proposal.id, {
        action,
        type: trigger.type,
        trigger,
        at: Date.now(),
      });
      if (this._pendingActions.size > 50) {
        const oldest = this._pendingActions.keys().next().value;
        this._pendingActions.delete(oldest);
      }
    }

    // P6 telemetría del circuito lsp_error.
    if (trigger.type === 'lsp_error') {
      logger.info(
        'proposals',
        `[lsp-ciclo] ofrecida id=${proposal.id} acción=${action ? 'parche' : 'informativa'}`
      );
    }

    return proposal;
  },

  /** Los params de la acción son deterministas y acotados al tipo de señal. */
  _resolveActionParams(tool, trigger) {
    if (tool === 'gitignore_add') return { file: trigger.file || '.env' };
    return {};
  },

  /**
   * El usuario respondió a una propuesta (botón del chat). Se persiste el
   * feedback por tipo; el próximo cálculo de cooldown lo tiene en cuenta.
   * Si aceptó y la propuesta tiene una acción pendiente, se ejecuta con el
   * executor whitelisted (Fase B) — pero SIN sostener el lock `_deciding`,
   * que ya se liberó al terminar `_tryTrigger`.
   * Fire-and-forget: nunca debe romper ni bloquear el flujo del chat.
   */
  handleDecision({ proposalId, type, decision, reason } = {}) {
    if (!proposalId || !type || !decision) return false;
    if (decision !== 'accepted' && decision !== 'rejected') return false;

    // F-5: la propuesta recibió respuesta → deja de estar "pendiente".
    if (this._sentFeedback.has(proposalId)) this._sentFeedback.delete(proposalId);

    // Fase F: el outcome real del usuario alimenta la receptividad (EMA).
    this._receptivity = receptividad(this._receptivity, {
      accepted: decision === 'accepted',
      rejected: decision === 'rejected',
    });
    this._audit.push({ type, proposalId, outcome: decision, reason, at: Date.now() });

    // Evaluar la calidad de la respuesta de Kaoru (feedback loop)
    const engagementScore = decision === 'accepted' ? 0.8 : 0.3;
    this._evaluateKaoruResponse(engagementScore);

    // Hilo relacional: marca el desenlace en el registro de mensajes previos
    // (el bookend y el registro adaptativo leen estos outcomes).
    for (const e of this._relationLog) {
      if (e.proposalId === proposalId) e.outcome = decision;
    }

    let state = false;
    if (this._store) {
      try {
        state = this._store.record({ proposalId, type, decision, reason });
        logger.info(
          'proposals',
          `[proactive] feedback ${decision} para "${type}" (factor cooldown ahora ×${this._store.cooldownMultiplier(type)})`
        );
      } catch (e) {
        logger.warn('proposals', '[proactive] error registrando decisión:', e.message);
      }
    }

    if (decision === 'accepted') {
      const pending = this._pendingActions.get(proposalId);
      if (pending && this._executor) {
        this._pendingActions.delete(proposalId);
        this._executeProposal(pending, proposalId, type).catch((e) =>
          logger.warn('proposals', '[proactive] error ejecutando propuesta:', e.message)
        );
      }
    } else {
      // Descartada — la acción pendiente deja de existir.
      this._pendingActions.delete(proposalId);
    }

    // Fase nueva (curiosidad): ADEMÁS del feedback general (receptividad +
    // ProposalStore + audiencia ya cubiertos arriba), el outcome de una
    // pattern_uncertain confirma o archiva el nodo inferido. No duplica el
    // mecanismo general: solo enchufa la llamada extra específica del tipo.
    this._connectCuriosityOutcome(proposalId, type, decision);

    return state;
  },

  /**
   * Ejecuta la acción de una propuesta aceptada y anuncia el resultado real
   * al bus ('proposal:executed' → Core → chat). Idempotente por
   * proposalId y serializado por el lock propio del executor.
   */
  async _executeProposal(pending, proposalId, type) {
    if (this._executor.isDone(proposalId)) {
      this._bus.emit('proposal:executed', {
        proposalId,
        type,
        ok: true,
        skipped: true,
        detail: 'Ya estaba ejecutada.',
      });
      return;
    }
    try {
      const result = await this._executor.execute(pending.action, { proposalId });
      // P2: reintento informado — el parche aplicó pero el LSP sigue viendo
      // el error. UN solo reintento alimentado con los diagnósticos frescos;
      // después, resultado honesto sin prometer más.
      if (
        type === 'lsp_error' &&
        result.ok &&
        result.fixed === false &&
        pending.trigger?.absPath
      ) {
        logger.info(
          'proposals',
          `[lsp-ciclo] parche no bastó — un reintento informado con diagnósticos post-parche (${proposalId})`
        );
        const freshErrors = await this._executor.getCurrentDiagnostics(pending.trigger.absPath);
        if (Array.isArray(freshErrors) && freshErrors.length) {
          const retryTrigger = { ...pending.trigger, errors: freshErrors };
          const patch2 = await this._generatePatch(retryTrigger);
          if (patch2?.changes?.length) {
            const res2 = await this._executor.execute(
              {
                tool: 'apply_patch',
                params: {
                  file: pending.trigger.file,
                  changes: patch2.changes,
                  targetErrors: freshErrors,
                },
              },
              { proposalId: `${proposalId}#retry` }
            );
            this._bus.emit('proposal:executed', {
              proposalId,
              type,
              ok: !!res2.ok,
              skipped: !!res2.skipped,
              attempt: 2,
              appliedWhileOpen: !!res2.appliedWhileOpen,
              wasFocused: !!res2.wasFocused,
              fixed: res2.fixed !== false,
              diff: res2.diff || null,
              detail:
                res2.detail ||
                (res2.ok ? 'Reintento aplicado.' : 'El reintento no pudo aplicar el parche.'),
            });
            return;
          }
        }
        // Sin reintento posible → informar tal cual.
        this._bus.emit('proposal:executed', {
          proposalId,
          type,
          ok: false,
          fixed: false,
          detail: 'Apliqué el parche pero el error persiste y no encontré un segundo fix mejor. Mirá los diagnósticos actuales del archivo.',
        });
        return;
      }

      this._bus.emit('proposal:executed', {
        proposalId,
        type,
        ok: !!result.ok,
        skipped: !!result.skipped,
        appliedWhileOpen: !!result.appliedWhileOpen,
        wasFocused: !!result.wasFocused,
        fixed: result.fixed,
        diff: result.diff || null,
        detail: result.detail || result.reason || null,
      });
    } catch (e) {
      this._bus.emit('proposal:executed', { proposalId, type, ok: false, detail: e.message });
    }
  },
};
