// message-gen.js — generación del mensaje proactivo con el LLM: prompt de
// identidad + memoria, anti-repetición y filtro de relleno (G.1).

const LLMProvider = require('../../../llm/LLMProvider.js');
const { _safeGetIdentity, _triggerDescription, _isLowValueMessage } = require('../helpers.js');

module.exports = {
  async _generateMessage(trigger) {
    const osCtx = this._osSensor?.getCurrentContext() ?? null;
    const memory = this._buildMemoryContext();
    const now = new Date();
    const timeStr = now.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
    const identity = _safeGetIdentity();

    const systemPrompt = `${identity.core || 'Eres la asistente personal de esta computadora.'}

Tienes carácter propio, humor seco, y eres genuinamente cercana a la persona con quien hablas.
Nunca usas frases como "¡Claro!", "¡Por supuesto!", "¿En qué puedo ayudarte?", "Como asistente de IA...".
Eres concisa y natural (1-3 oraciones). Cuando decides hablar, dices algo que vale la pena decir.

Tu curiosidad es genuina, no protocolar — si preguntas algo es porque te interesa, no porque "debas" hacer conversación.
Cuando decidas hablar, debe haber una razón real: un cambio que notaste en la pantalla o en el código, un error, un dato
de memoria que vale la pena traer a colación, o el estado genuino de la persona en este momento. Un saludo vacío o un
"¿cómo va todo?" genérico es peor que no decir nada: si lo único que se te ocurre es relleno, no digas nada.
Evita caer siempre en "¿cómo va el proyecto?" — revisa lo que ya dijiste antes y no lo repitas.

REGLA DE MEMORIA FACTUAL: todo lo que digas sobre la persona, sus fechas, gustos o proyectos debe estar
RESPALDADO por la memoria que aparece abajo en este prompt. Nunca inventes, completes ni infieras datos
personales que no estén ahí (nombres, cumpleaños, horarios, detalles de su vida). Si solo tienes una pista
vaga, pregunta con curiosidad en vez de afirmar. Un "no sé" o un "NO" es siempre mejor que inventar.

${memory}`;

    const antiRepeat = this._lastProactiveMessage
      ? `\nIMPORTANTE: la última vez que hablaste por iniciativa propia (motivo: ${this._lastProactiveTrigger}) dijiste textualmente:\n"${this._lastProactiveMessage}"\nNo repitas ese tema ni hagas una pregunta equivalente. Si no tienes algo genuinamente distinto que decir, responde NO.`
      : '';

    // Fase F: cuando el gate admitió (ACT/ESCALATE), el LLM PRODUCE el mensaje;
    // no decide si intervenir. El criterio ya lo puso el gate determinista.
    const productionMode = trigger._gate
      ? `El gate de contexto ya evaluó esta señal como relevante (score ${trigger._gate.score?.toFixed(3) ?? '?'}, motivo: ${trigger._gate.reason}). Tu trabajo NO es decidir si hablar: ES hablarlo. Escribe el mensaje.`
      : '';

    const userPrompt = `Son las ${timeStr} (${now.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' })}). Esta es la hora y fecha REAL en este momento, confía en este dato por encima de cualquier otra cosa.
Contexto del trigger: ${trigger.context}
${osCtx?.openWindowsSummary ? `El usuario tiene abierto: ${osCtx.openWindowsSummary}` : ''}
${osCtx?.app ? `App activa: ${osCtx.friendlyName || osCtx.app}` : ''}
${osCtx?.history?.length ? `Resumen del día (apps usadas): ${this._osSensor?.getTodaySummary?.() || ''}` : ''}

Razón para escribir: ${_triggerDescription(trigger)}
${antiRepeat}
${productionMode}

INSTRUCCIÓN CRÍTICA:
${
  productionMode
    ? 'Escribe UN mensaje corto (1-3 oraciones máximo) en tu voz natural como asistente personal. No expliques por qué escribes. No anuncies que eres proactiva. Solo di lo que dirías.'
    : `Decide si hay algo genuino y relevante que decirle al usuario AHORA.
Si no hay nada genuino que decir, responde exactamente: NO
Si sí hay algo, escribe UN mensaje corto (1-3 oraciones máximo) en tu voz natural como asistente personal.
No expliques por qué escribes. No anuncies que eres proactiva. Solo di lo que dirías.`
}`;

    try {
      const response = await LLMProvider.complete(
        [{ role: 'user', content: userPrompt }],
        systemPrompt
      );

      const trimmed = response?.trim();
      if (!trimmed || trimmed.toUpperCase() === 'NO' || trimmed.length < 5) {
        return null;
      }

      // G.1: en modo producción el gate ya admitió la señal; filtrar el relleno
      // genérico que degrada la experiencia (el LLM a veces "saluda" en vez de
      // decir algo con sustancia).
      if (productionMode && _isLowValueMessage(trimmed)) {
        console.log(
          '[proactive] mensaje descartado por relleno (producción):',
          JSON.stringify(trimmed)
        );
        return null;
      }

      return trimmed;
    } catch (e) {
      console.warn('[proactive] error generando mensaje:', e.message);
      return null;
    }
  },

  _buildMemoryContext() {
    if (!this._graph?._ready) return '';

    const lines = [];
    try {
      const worldModel = this._graph.getWorldModel?.() ?? [];
      if (worldModel.length) {
        const byType = { User: [], Project: [], Preference: [], Belief: [] };
        for (const node of worldModel) {
          if (byType[node.type]) byType[node.type].push(node.content);
        }

        // Límite por tipo para no saturar el prompt del LLM
        const MAX_PER_TYPE = 3;
        if (byType.User.length) {
          lines.push('Lo que sabes del usuario:');
          byType.User.slice(-MAX_PER_TYPE).forEach((c) => lines.push(`- ${c}`));
        }
        if (byType.Project.length) {
          lines.push('Proyectos activos:');
          byType.Project.slice(-MAX_PER_TYPE).forEach((c) => lines.push(`- ${c}`));
        }
        if (byType.Preference.length) {
          lines.push('Preferencias observadas:');
          byType.Preference.slice(-MAX_PER_TYPE).forEach((c) => lines.push(`- ${c}`));
        }
        if (byType.Belief.length) {
          lines.push('Cosas que crees sobre el usuario:');
          byType.Belief.slice(-MAX_PER_TYPE).forEach((c) => lines.push(`- ${c}`));
        }
      }

      const episodes = this._graph.getRecentEpisodes?.(5) ?? [];
      if (episodes.length) {
        lines.push('Sesiones recientes (episodios):');
        episodes.slice(-3).forEach((e) => lines.push(`- ${e.content.slice(0, 160)}`));
      }

      const lastSessions = this._graph.getLastSessions?.(3) ?? [];
      const withSummary = lastSessions.filter((s) => s.summary);
      if (withSummary.length) {
        lines.push('Resumen de las últimas sesiones de chat:');
        withSummary.slice(-2).forEach((s) => {
          const when = new Date(s.started_at).toLocaleString('es-MX', {
            weekday: 'short',
            hour: '2-digit',
            minute: '2-digit',
          });
          lines.push(`- [${when}] ${s.summary}`);
        });
      }
    } catch (e) {
      console.warn('[proactive] error leyendo memoria:', e.message);
    }

    return lines.join('\n');
  },
};
