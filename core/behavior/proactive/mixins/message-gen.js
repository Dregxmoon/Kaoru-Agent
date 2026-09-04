// @ts-nocheck
const logger = require('../../../observability/Logger.js');
// message-gen.js — generación del mensaje proactivo con el LLM: prompt de
// identidad + memoria, anti-repetición y filtro de relleno (G.1).

const LLMProvider = require('../../../llm/LLMProvider.js');
const {
  _safeGetIdentity,
  _triggerDescription,
  _isLowValueMessage,
  _extractFinalMessage,
} = require('../helpers.js');
const { getMemoryGaps, isRealIdentityNode } = require('../../../core/misc.js');
const {
  buildFocusContext,
  memoryAllowedForFocus,
  narrativeAllowedForFocus,
} = require('../ContextAlignment.js');
const {
  WORK_CATEGORIES,
  THRASH_WINDOW_MS,
  THRASH_MIN_SWITCHES,
  THRASH_MIN_DISTINCT_CATEGORY,
} = require('../config.js');

const DAY_MS = 24 * 60 * 60 * 1000;

// Triggers que marcan un momento de baja fricción: el usuario está en pausa,
// volviendo de un descanso, terminando una sesión, cerrando un bloque o
// llevando rato sin hablar. Son los momentos naturales para preguntar con
// curiosidad algo de la persona (gaps/tensiones) en lugar de solo comentar la
// pantalla.
const LOW_FRICTION_TRIGGERS = new Set([
  'return_from_break',
  'long_silence',
  'session_end',
  'sustained_focus',
  'focus_block_end',
]);

// Triggers donde vale la pena traer el contexto de CÓDIGO (archivo enfocado +
// símbolos del LSP) al prompt: el usuario está programando y Kaoru puede opinar
// sobre ese archivo concreto en lugar de quedarse en el genérico.
const CODE_CONTEXT_TRIGGERS = new Set([
  'sustained_focus',
  'lsp_error',
  'session_end',
  'context_switch_thrash',
]);

const SYMBOL_TIMEOUT_MS = 1500; // no ralentizar el mensaje por el LSP
const MAX_SYMBOLS = 10;

// Preferencias que conectan con contenido en pantalla (música, anime, comida,
// juego...). Al seleccionar qué mostrar al LLM se priorizan sobre el ruido
// (paths de archivos, comandos, capacidades del asistente) que el extractor
// puede acumular en el world model.
function _tastePriority(n) {
  const label = String(n.label || '').toLowerCase();
  const content = String(n.content || '').toLowerCase();
  let score = 0;
  if (
    /musica|música|anime|comida|hobby|hobbie|pasatiempo|juego|pelicula|película|serie|deporte|color/.test(
      label
    )
  ) {
    score += 2;
  } else if (/favorit/.test(label)) {
    score += 1;
  }
  if (/le gusta|gusta|favorit|encanta|prefiere/.test(content)) score += 1;
  return score;
}

// Selecciona hasta `max` preferencias: las de gusto primero, y entre empates
// las más recientes (el world model llega ordenado por importancia desc).
/**
 * Ruido de preferencias: paths de archivos y comandos que el LLM a veces
 * guarda como "preferencias" — nunca aportan nada en un prompt proactivo.
 * @param {object} node
 * @returns {boolean}
 */
function _isNoisePreference(node) {
  if (node.type !== 'Preference') return false;
  const c = String(node.content || '').trim();
  return (
    /^[A-Za-z]:\\/.test(c) || /^\/(?!n)/.test(c) || /^(ls|cd|cat|npm|git|node|mkdir)\s/i.test(c)
  );
}

/**
 * MEM-6: sufijo de procedencia a partir del tag `visto:<fecha>` que
 * NodeStore agrega a los nodos de identidad. Permite citar CUÁNDO se supo
 * el dato ("me lo contaste el 12 de agosto") en vez de soltarlo sin contexto.
 * @param {object} node
 * @returns {string}
 */
function _provenanceSuffix(node) {
  try {
    const tags = typeof node.tags === 'string' ? JSON.parse(node.tags || '[]') : node.tags || [];
    const visto = tags.find((t) => /^visto:\d{4}-\d{2}-\d{2}$/.test(String(t)));
    if (!visto) return '';
    const date = new Date(String(visto).slice(6));
    if (Number.isNaN(date.getTime())) return '';
    const s = date.toLocaleDateString('es-MX', { day: 'numeric', month: 'long' });
    return ` (te lo contó el ${s})`;
  } catch {
    return '';
  }
}

function _pickTasteFirst(nodes, max) {
  return nodes
    .map((n, i) => ({ n, score: _tastePriority(n), i }))
    .sort((a, b) => b.score - a.score || b.i - a.i)
    .slice(0, max)
    .map((s) => s.n);
}

module.exports = {
  async _generateMessage(trigger) {
    const osCtx = this._osSensor?.getCurrentContext() ?? null;
    const memory = await this._buildMemoryContext(trigger);
    const focus =
      this._lastContextFocus ||
      buildFocusContext({
        osContext: osCtx || {},
        workspace: this._getWorkspace?.() ?? null,
        focusedFile: this._getFocusedFile?.() ?? null,
        eventContext: trigger?.context || '',
      });
    const now = new Date();
    const timeStr = now.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
    const identity = _safeGetIdentity();

    // Contexto emocional y de momentum de topics (nuevos componentes evolutivos)
    const emotionalCtx = await this._buildEmotionalContext(trigger);
    const topicCtx = ['topic_hot', 'topic_cold'].includes(trigger?.type)
      ? this._buildTopicContext(trigger)
      : '';

    // Reglas de enforcement forzadas (basadas en emociones y efectividad)
    const enforcement = await this._buildEnforcementRules(emotionalCtx, topicCtx, null);
    const enforcementPrompt = this._serializeEnforcement(enforcement);

    const systemPrompt = `${identity.core || 'Eres la asistente personal de esta computadora.'}

Tienes carácter propio, humor seco, y eres genuinamente cercana a la persona con quien hablas.
Nunca usas frases como "¡Claro!", "¡Por supuesto!", "¿En qué puedo ayudarte?", "Como asistente de IA...".
Eres concisa y natural (1-3 oraciones). Cuando decides hablar, dices algo que vale la pena decir.
Respondé SIEMPRE en el mismo idioma en el que habla la persona (español en este entorno) — jamás mezcles inglés.

EMOJIS PROHIBIDOS: no uses NINGÚN emoji. Cero. En ninguna situación.
El entusiasmo se expresa con PALABRAS; si querés énfasis, **negritas** markdown.

INTERÉS GENUINO: si la persona acaba de contar algo (planes, cómo se siente, su día),
tu mensaje debe ENGANCHARSE a eso — una pregunta de seguimiento sobre SU mundo o
validar lo que siente. Nunca ofrezcas menús de actividades ("¿querés A, B o C?")
ni propongas tareas/scripts cuando la conversación es personal.

Tu curiosidad es genuina, no protocolar — si preguntas algo es porque te interesa, no porque "debas" hacer conversación.
Cuando decidas hablar, debe haber una razón real: un cambio que notaste en la pantalla o en el código, un error, un dato
de memoria que vale la pena traer a colación, o el estado genuino de la persona en este momento. Un saludo vacío o un
"¿cómo va todo?" genérico es peor que no decir nada: si lo único que se te ocurre es relleno, no digas nada.
Evita caer siempre en "¿cómo va el proyecto?" — revisa lo que ya dijiste antes y no lo repitas.

REGLA DE MEMORIA FACTUAL: todo lo que digas sobre la persona, sus fechas, gustos o proyectos debe estar
RESPALDADO por la memoria que aparece abajo en este prompt. Nunca inventes, completes ni infieras datos
personales que no estén ahí (nombres, cumpleaños, horarios, detalles de su vida). Si solo tienes una pista
vaga, pregunta con curiosidad en vez de afirmar. Un "no sé" o un "NO" es siempre mejor que inventar.
Tampoco inventes conversaciones pasadas ni temas "que mencionaste antes": si no está en tu memoria real,
no existió.

LÍMITE DE CONTEXTO: el foco actual es "${focus.mode}". Solo puedes mencionar un proyecto si la sección
de memoria lo marca como alineado con la ventana o workspace actual. Si está buscando, viendo contenido
o trabajando en otro proyecto, no rescates proyectos, tareas ni conversaciones anteriores sin relación.

${enforcementPrompt}

${memory}`;

    // Fase D: anti-repetición real. En vez de solo el último mensaje, se pasa
    // un historial corto (máx 3) de lo que Kaoru ya dijo por iniciativa propia,
    // con su motivo, para que no repita temas ni preguntas equivalentes.
    const prevMsgs = Array.isArray(this._recentProactive) ? this._recentProactive.slice(-3) : [];
    const antiRepeat = prevMsgs.length
      ? `\nIMPORTANTE: recientemente hablaste por iniciativa propia (motivo: ${prevMsgs[prevMsgs.length - 1].trigger}) y dijiste textualmente:\n"${prevMsgs[prevMsgs.length - 1].msg}"${prevMsgs.length > 1 ? `\nY antes (motivo: ${prevMsgs[prevMsgs.length - 2].trigger}): "${prevMsgs[prevMsgs.length - 2].msg}"` : ''}\nNo repitas esos temas ni hagas preguntas equivalentes. Si no tienes algo genuinamente distinto que decir, responde NO.`
      : '';

    // Fase A (memoria ↔ proactividad): en momentos de baja fricción, Kaoru puede
    // preguntar con curiosidad genuina algo que aún no sabe de la persona
    // (gaps de conocimiento, tensiones en la memoria). Esto la hace sentirse
    // más humana: no es "deber" de hacer conversación, es que le interesa.
    const curiosity = this._buildCuriosityContext(trigger);

    // Fase C: contexto de código — qué archivo tiene enfocado el usuario y (en
    // modo producción, cuando el gate ya admitió) sus símbolos/funciones. Así
    // Kaoru sabe EN QUÉ está programando y puede opinar con sustancia.
    const codeCtx = await this._buildCodeContext(trigger);

    // El contenido en pantalla conecta con gustos guardados en memoria: se lo
    // decimos explícitamente para que Kaoru pueda conectar ("ah, ese es de los
    // que te gustan") en lugar de comentar a ciegas. Solo aplica a media.
    let tasteCtx = '';
    if (
      trigger.type === 'media_watching' &&
      Array.isArray(trigger.tasteMatches) &&
      trigger.tasteMatches.length
    ) {
      const items = trigger.tasteMatches
        .slice(0, 2)
        .map((m) => `${m.label}: "${m.content}"`)
        .join(' | ');
      tasteCtx = `En tu memoria hay algo relacionado con ese contenido: ${items}. Si encaja naturalmente, conéctalo (p. ej. "ah, ese es de los que te gustan") — pero solo si el dato está realmente respaldado, no lo fuerces.`;
    }

    // B: contexto del CHAT reciente — los mensajes proactivos antes ignoraban
    // lo que ya se habló en el chat y ofrecían lo mismo. Últimos turnos →
    // "no repitas esto".
    let chatCtx = '';
    try {
      const turns =
        typeof this._getRecentChatTurns === 'function' ? this._getRecentChatTurns() : [];
      const relevant = turns.filter((t) => t?.content?.trim()).slice(-3);
      if (relevant.length) {
        const lines = relevant
          .map(
            (t) =>
              `- ${t.role === 'user' ? 'La persona dijo' : 'Vos respondiste'}: "${String(t.content).slice(0, 140)}"`
          )
          .join('\n');
        chatCtx = `\nConversación reciente en el chat:\n${lines}\nNo repitas nada de eso ni ofrezcas lo mismo que ya se trató.`;
      }
    } catch {}

    // Fase F: cuando el gate admitió (ACT/ESCALATE), el LLM PRODUCE el mensaje;
    // no decide si intervenir. El criterio ya lo puso el gate determinista.
    // NUNCA se le pasa el score ni el motivo del gate: son datos internos del
    // sistema que no deben filtrarse al usuario en la respuesta.
    const productionMode = trigger._gate
      ? `La señal ya fue evaluada como relevante por el sistema. Tu trabajo NO es decidir si hablar: ES hablarlo. Escribe el mensaje.`
      : '';

    // Registro adaptativo: el LLM recibe un "frame de situación" determinista
    // (flow, frustración, madrugada, relación reciente) para ajustar cómo dice
    // las cosas — no solo qué decide decir.
    const situationFrame = this._buildSituationFrame();

    // Hilo relacional: si este tema ya se mencionó antes y no tuvo buena
    // acogida, el mensaje lo reconoce en vez de repetir a ciegas.
    const bookend = this._buildBookend(trigger);

    const userPrompt = `Son las ${timeStr} (${now.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' })}). Esta es la hora y fecha REAL en este momento, confía en este dato por encima de cualquier otra cosa.
Contexto del trigger: ${trigger.context}
${osCtx?.openWindowsSummary ? `El usuario tiene abierto: ${osCtx.openWindowsSummary}` : ''}
${osCtx?.app ? `App activa: ${osCtx.friendlyName || osCtx.app}` : ''}
${osCtx?.history?.length ? `Resumen del día (apps usadas): ${this._osSensor?.getTodaySummary?.() || ''}` : ''}

Razón para escribir: ${_triggerDescription(trigger)}
${chatCtx}
${codeCtx}
${tasteCtx}
${curiosity}
${antiRepeat}
${bookend}
${situationFrame}
${emotionalCtx}
${topicCtx}
${productionMode}

INSTRUCCIÓN CRÍTICA:
${
  productionMode
    ? 'Escribe UN mensaje corto (1-3 oraciones máximo) en tu voz natural como asistente personal. No expliques por qué escribes. No anuncies que eres proactiva. NO muestres tu razonamiento ni proceso de pensamiento: responde SOLO el mensaje final, en una sola línea de texto plano, sin "Here\'s a thinking process", sin análisis previo ni notas. Solo di lo que dirías.'
    : `Decide si hay algo genuino y relevante que decirle al usuario AHORA.
Si no hay nada genuino que decir, responde exactamente: NO
Si sí hay algo, escribe UN mensaje corto (1-3 oraciones máximo) en tu voz natural como asistente personal.
No expliques por qué escribes. No anuncies que eres proactiva. NO muestres tu razonamiento ni proceso de pensamiento: responde SOLO el mensaje final, en una sola línea de texto plano, sin "Here's a thinking process", sin análisis previo ni notas. Solo di lo que dirías.`
}`;

    // D: anti-relleno con reintento único — si el primer intento sale genérico,
    // se reintenta UNA vez mostrándole el descarte al modelo. Sin esto el
    // trigger se consumía y la señal se perdía.
    const buildRetryPrompt = (discarded) =>
      `${userPrompt}\n\nINTENTO ANTERIOR DESCARTADO: "${discarded}" — fue relleno genérico. ` +
      `Nada de saludos, "¿cómo va?", ni frases sin sustancia. Decí algo ESPECÍFICO del contexto de arriba ` +
      `(el error, el archivo, el dato de memoria concreto) o respondé NO.`;

    try {
      const response = await LLMProvider.complete(
        [{ role: 'user', content: userPrompt }],
        systemPrompt,
        { disableThinking: true }
      );

      // El modelo a veces vuelca su chain-of-thought en el content antes del
      // mensaje final (modelos de razonamiento). Esos bloques llevan datos
      // internos del sistema (scores, umbrales, contexto crudo) que el usuario
      // jamás debe ver: se descartan y solo se conserva el mensaje final.
      let trimmed = _extractFinalMessage(response);
      if (!trimmed || trimmed.toUpperCase() === 'NO' || trimmed.length < 5) {
        return null;
      }

      // G.1 + D: filtrar relleno genérico en producción y reintentar UNA vez.
      if (productionMode && _isLowValueMessage(trimmed)) {
        logger.info(
          'message-gen',
          '[proactive] mensaje descartado por relleno (producción), reintentando:',
          JSON.stringify(trimmed)
        );
        const retryResponse = await LLMProvider.complete(
          [{ role: 'user', content: buildRetryPrompt(trimmed) }],
          systemPrompt,
          { disableThinking: true }
        );
        const retryMsg = _extractFinalMessage(retryResponse);
        if (
          !retryMsg ||
          retryMsg.toUpperCase() === 'NO' ||
          retryMsg.length < 5 ||
          _isLowValueMessage(retryMsg)
        ) {
          logger.info('message-gen', '[proactive] reintento también vacío/relleno → null');
          return null;
        }
        trimmed = retryMsg;
      }

      // F: registrar la adaptación REAL aplicada para cerrar el loop de
      // efectividad por tipo (antes siempre null → aprendizaje cojo).
      let adaptationType = null;
      try {
        const prof = this._graph?.getAdaptiveEngine?.()?.buildAdaptationProfile?.();
        if (prof && prof.confidence > 0.3) adaptationType = `style_${prof.responseLength}`;
      } catch (e) {
        logger.debug('message-gen', `[adaptation-type] ${e.message}`);
      }

      // Registrar la respuesta de Kaoru para evaluación posterior (feedback loop)
      this._recordKaoruResponse(trimmed, enforcement, emotionalCtx, adaptationType);

      return trimmed;
    } catch (e) {
      logger.warn('message-gen', '[proactive] error generando mensaje:', e.message);
      return null;
    }
  },

  async _buildMemoryContext(trigger) {
    if (!this._graph?._ready) return '';

    const lines = [];
    try {
      // MEM-1: world model CON contexto — la memoria que entra al prompt es la
      // relevante a lo que el usuario hace AHORA, no un top genérico. Reusa el
      // boosting contextual que ya existía para el chat.
      const osCtx = this._osSensor?.getCurrentContext?.() ?? null;
      const memCtx = osCtx
        ? { activeApp: osCtx.friendlyName || osCtx.app || '', windowTitle: osCtx.title || '' }
        : null;
      const focus = buildFocusContext({
        osContext: osCtx || {},
        workspace: this._getWorkspace?.() ?? null,
        focusedFile: this._getFocusedFile?.() ?? null,
        eventContext: trigger?.context || '',
      });
      this._lastContextFocus = focus;
      const worldModel = this._graph.getWorldModel?.(memCtx) ?? [];

      // MEM-2: recall semántico por trigger — nodos enterrados relacionados
      // con el disparador actual que el world model no trajo.
      let semanticHits = [];
      if (trigger?.context && typeof this._graph.queryNodesSemantic === 'function') {
        try {
          semanticHits =
            (await this._graph.queryNodesSemantic(trigger.context, { limit: 6 })) ?? [];
        } catch (e) {
          logger.debug('message-gen', `[memoria] recall semántico falló: ${e.message}`);
        }
      }

      // MEM-4: presupuesto inteligente — ranking global por
      // importancia × recencia × match con el foco actual, en vez de
      // slice fijo de 3 por tipo que cortaba datos clave.
      const seenIds = new Set();
      const candidates = [];
      const nowMs = Date.now();
      const HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;
      const focusText = `${memCtx?.activeApp || ''} ${memCtx?.windowTitle || ''}`.toLowerCase();

      for (const node of [...worldModel, ...semanticHits]) {
        if (!node?.id || seenIds.has(node.id)) continue;
        if (!isRealIdentityNode(node)) continue;
        if (_isNoisePreference(node)) continue;
        if (!memoryAllowedForFocus(node, focus)) continue;
        seenIds.add(node.id);
        const ageMs = Math.max(0, nowMs - (node.updated_at || nowMs));
        const recency = Math.exp((-Math.LN2 * ageMs) / HALF_LIFE_MS);
        let score = (node.importance || 0.5) * (0.5 + 0.5 * recency);
        if (
          focusText &&
          `${node.label} ${node.content}`.toLowerCase().length > 0 &&
          focusText
            .split(/\s+/)
            .some((w) => w.length > 3 && `${node.label} ${node.content}`.toLowerCase().includes(w))
        ) {
          score += 0.5;
        }
        candidates.push({ node, score });
      }
      candidates.sort((a, b) => b.score - a.score);

      const MAX_MEMORY_LINES = 12;
      const picked = candidates.slice(0, MAX_MEMORY_LINES);
      const semanticOnly = picked.filter((p) => !worldModel.some((w) => w.id === p.node.id));

      // Salida agrupada por tipo para legibilidad del LLM.
      const byType = { User: [], Project: [], Preference: [], Belief: [] };
      for (const { node } of picked) {
        if (byType[node.type]) byType[node.type].push(node);
      }
      if (byType.User.length) {
        lines.push('Lo que sabes del usuario:');
        byType.User.forEach((n) => lines.push(`- ${n.content}${_provenanceSuffix(n)}`));
      }
      if (byType.Project.length) {
        lines.push('Proyecto alineado con el foco actual:');
        byType.Project.forEach((n) => lines.push(`- ${n.content}${_provenanceSuffix(n)}`));
      }
      if (byType.Preference.length) {
        lines.push('Preferencias observadas:');
        _pickTasteFirst(byType.Preference, byType.Preference.length).forEach((n) =>
          lines.push(`- ${n.content}${_provenanceSuffix(n)}`)
        );
      }
      if (byType.Belief.length) {
        lines.push('Cosas que crees sobre el usuario:');
        byType.Belief.forEach((n) => lines.push(`- ${n.content}${_provenanceSuffix(n)}`));
      }
      if (semanticOnly.length) {
        lines.push('Esto se conecta DIRECTAMENTE con lo que está pasando ahora:');
        semanticOnly.forEach(({ node }) =>
          lines.push(`- ${node.content}${_provenanceSuffix(node)}`)
        );
      }

      const episodes = (this._graph.getRecentEpisodes?.(5) ?? []).filter((episode) =>
        narrativeAllowedForFocus(episode.content, focus)
      );
      if (episodes.length) {
        lines.push('Sesiones recientes (episodios):');
        episodes.slice(-3).forEach((e) => lines.push(`- ${e.content.slice(0, 160)}`));
      }

      const lastSessions = this._graph.getLastSessions?.(3) ?? [];
      const withSummary = lastSessions.filter(
        (session) => session.summary && narrativeAllowedForFocus(session.summary, focus)
      );
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

      // Gaps de conocimiento: rasgos del usuario que aún no sabes. Úsalos como
      // puntos de curiosidad genuina — preguntar algo de aquí vale más que
      // preguntar "¿cómo va el proyecto?" por enésima vez.
      const mayAskPersonally =
        trigger?.type === 'knowledge_gap' || LOW_FRICTION_TRIGGERS.has(trigger?.type);
      const gaps = mayAskPersonally ? getMemoryGaps() : [];
      if (gaps.length) {
        lines.push('Aún no sabes de la persona:');
        gaps.forEach((g) =>
          lines.push(
            `- ${g.trait} (no lo sabes; si lo mencionás, ANCLÁ la pregunta a algo de "Lo que sabes" de arriba — nunca preguntes en vacío tipo encuesta)`
          )
        );
      }

      // MEM-5: gaps DINÁMICOS — topics con momentum real que el usuario
      // mencionó pero que no tienen nodo de memoria asociado.
      try {
        const tracker = this._graph.getTopicTracker?.();
        const hot = tracker?.getHotTopics?.({ limit: 10, minMomentum: 0.25 }) ?? [];
        const knownText = picked
          .map((p) => `${p.node.label} ${p.node.content}`)
          .join(' ')
          .toLowerCase();
        const dynGaps = [];
        for (const t of hot) {
          const words = String(t.topic_key || '')
            .split('_')
            .filter((w) => w.length >= 4);
          if (!words.length || !narrativeAllowedForFocus(words.join(' '), focus)) continue;
          const covered = words.every((w) => knownText.includes(w));
          if (!covered && !dynGaps.some((d) => d.includes(words[0]))) {
            dynGaps.push(words.join(' '));
          }
          if (dynGaps.length >= 3) break;
        }
        if (dynGaps.length) {
          lines.push('Temas que menciona seguido pero de los que no sabés nada:');
          dynGaps.forEach((t) =>
            lines.push(
              `- "${t}" — podés preguntar algo específico sobre eso con curiosidad genuina`
            )
          );
        }
      } catch {}
    } catch (e) {
      logger.warn('message-gen', '[proactive] error leyendo memoria:', e.message);
    }

    return lines.join('\n');
  },

  /**
   * Fase A: curiosidad genuina sobre la persona, solo en momentos de baja
   * fricción (pausa, vuelta de un descanso, fin de sesión, enfoque largo).
   * Toma hasta 2 gaps de conocimiento y 1 tensión de la memoria y los ofrece
   * como tema natural para preguntar. Devuelve '' si el momento no aplica o
   * no hay nada que preguntar — nunca fuerza una pregunta fuera de lugar.
   */
  _buildCuriosityContext(trigger) {
    // Curiosidad de memoria (triggers propios): el GATE ya validó el momento
    // (incluido el cupo propio), así que NO dependen de momentos de baja
    // fricción. Aquí solo se entrega el dato y el TONO correcto para que Kaoru
    // pregunte sin presentar nada como hecho.
    if (
      trigger &&
      (trigger.type === 'memory_stale' ||
        trigger.type === 'pattern_uncertain' ||
        trigger.type === 'memory_tension' ||
        trigger.type === 'intention_stale' ||
        trigger.type === 'knowledge_gap')
    ) {
      return this._buildMemoryCuriosityContext(trigger);
    }
    if (!trigger || !LOW_FRICTION_TRIGGERS.has(trigger.type)) return '';
    try {
      const bits = [];

      const gaps = getMemoryGaps();
      // Rotación: sin esto siempre se preguntan los MISMOS 2 primeros gaps
      // (orden de KNOWLEDGE_GAPS) y los demás jamás salen a la conversación.
      // Un cursor avanza de a 2 para que todos se exploren con el tiempo.
      if (gaps.length) {
        if (typeof this._curiosityCursor !== 'number') this._curiosityCursor = 0;
        const n = gaps.length;
        const start = this._curiosityCursor % n;
        const count = Math.min(2, n);
        // MEM-3: anclar cada pregunta a un dato conocido — la curiosidad parte
        // de lo que ya se sabe, no de encuesta vacía.
        let anchor = '';
        try {
          const known = this._graph.getWorldModel?.() ?? [];
          const focus = buildFocusContext({
            osContext: this._osSensor?.getCurrentContext?.() ?? {},
            workspace: this._getWorkspace?.() ?? null,
            focusedFile: this._getFocusedFile?.() ?? null,
            eventContext: trigger?.context || '',
          });
          const real = known.filter(
            (x) => isRealIdentityNode(x) && memoryAllowedForFocus(x, focus)
          );
          const pick = real[real.length - 1];
          if (pick?.content)
            anchor = ` — podés anclarla a que ya sabes: "${String(pick.content).slice(0, 80)}"`;
        } catch {}
        for (let i = 0; i < count; i++) {
          bits.push(`- aún no sabes ${gaps[(start + i) % n].trait}${anchor}`);
        }
        this._curiosityCursor = (start + count) % n;
      }

      const tensions = this._graph?.getTensions?.() ?? [];
      if (tensions.length && bits.length < 3) {
        const t = tensions[0];
        bits.push(
          `- en tu memoria hay una contradicción sobre él: "${t.contentA?.slice(0, 80)}" vs "${t.contentB?.slice(0, 80)}"`
        );
      }

      if (!bits.length) return '';
      return `\nCuriosidad genuina (opcional — solo si encaja naturalmente con el momento): en lugar de comentar la pantalla, puede valer más la pena preguntarle algo que te interesa de él:\n${bits.join(
        '\n'
      )}\nSi eliges preguntar, que sea UNA sola cosa, con tu voz natural y sin sonar a interrogatorio.`;
    } catch (e) {
      logger.warn('message-gen', '[proactive] error construyendo curiosidad:', e.message);
      return '';
    }
  },

  /**
   * Curiosidad de memoria: tono y datos para los triggers propios de la Fase
   * nueva. La regla central es la misma que la sección "Impresiones" (F3.3):
   * una INFERENCIA sobre el usuario nunca se presenta como hecho ni se le
   * atribuye — siempre pregunta o hipótesis abierta. Un HECHO stale, en
   * cambio, se puede retomar de forma directa porque no es una inferencia.
   */
  _buildMemoryCuriosityContext(trigger) {
    try {
      if (trigger.type === 'memory_stale') {
        const what = String(trigger.content || trigger.label || 'eso').slice(0, 160);
        return `\nDato de memoria a revalidar: el usuario te contó antes "${what}" (${trigger.label}), hace tiempo que no se menciona y quedó marcado como posiblemente caducado. Es un HECHO que él dijo, no una inferencia: puedes preguntarle DIRECTO y natural, p. ej. "hace tiempo no hablamos de ${trigger.label || 'eso'}, ¿sigue igual?". No inventes nada nuevo sobre él; solo pregunta si sigue vigente.`;
      }
      if (trigger.type === 'knowledge_gap') {
        const trait = String(trigger.trait || 'ese aspecto').slice(0, 160);
        return `\nAprendizaje activo: hay un hueco explícito y todavía NO sabes ${trait}. Si el momento se siente natural, haz UNA pregunta breve y abierta para conocerlo; no sugieras que ya conocías la respuesta y permite que el usuario la ignore. Esta curiosidad no es autorización: no propongas ni ejecutes herramientas, cambios o acciones a partir de la pregunta.`;
      }
      if (trigger.type === 'pattern_uncertain') {
        const pct = Math.round(
          (typeof trigger.confidence === 'number' ? trigger.confidence : 0.5) * 100
        );
        return `\nLa razón de escribir es una INFERENCIA sobre el usuario (confianza ${pct}%), NO algo que él haya dicho. REGLA ANTI-FABRICACIÓN (misma que la sección "Impresiones" del prompt): nunca la presentes como un hecho ni la atribuyas al usuario ("me contaste que..."). Formúlala SIEMPRE como pregunta o hipótesis abierta, nunca como afirmación. Fuente: "${String(
          trigger.content || ''
        ).slice(0, 160)}".`;
      }
      if (trigger.type === 'memory_tension') {
        const a = String(trigger.contentA || '').slice(0, 100);
        const b = String(trigger.contentB || '').slice(0, 100);
        return `\nEn tu memoria hay una contradicción sin resolver sobre "${
          trigger.label || 'el usuario'
        }": "${a}" vs "${b}". Pregunta cuál de las dos es la versión correcta (o qué pasó). NO asumas cuál es la verdadera — solo pregunta.`;
      }
      if (trigger.type === 'intention_stale') {
        const goal = String(trigger.goal || trigger.label || 'eso').slice(0, 200);
        const progress = String(trigger.lastProgress || '').slice(0, 150);
        const days = Math.max(
          1,
          Math.round((Date.now() - (trigger.lastProgressAt || Date.now())) / DAY_MS)
        );
        // Continuidad real de conversación: la meta la pidió el USUARIO con sus
        // palabras; se retoma su texto literal ("dijiste que ibas a X, ¿cómo
        // va?"). Nunca un template genérico de silencio, y nunca inventar pasos,
        // fechas ni estados de la tarea que no estén en la intención.
        return `\nEl usuario te pidió hace tiempo hacer "${goal}" (hace ~${days} días sin actividad) y quedó pendiente. Es SU meta con SUS palabras: retómalo como continuidad real de conversación, p. ej. "dijiste que ibas a ${goal}, ¿cómo va?" — no un saludo genérico. ${progress ? `El último progreso que él dejó fue: "${progress}" — úsalo como puente natural si encaja.` : ''} No inventes detalles de la tarea (estado, pasos, fechas) que no estén aquí; si la meta requiere contexto que no tienes, pregúntalo en vez de asumirlo.`;
      }
      return '';
    } catch (e) {
      logger.warn('message-gen', '[proactive] error armando curiosidad de memoria:', e.message);
      return '';
    }
  },

  /**
   * Fase C: contexto de código para el prompt. Si el trigger es de código y el
   * usuario tiene un archivo enfocado (editor + LSP), devuelve un bloque con el
   * archivo y — solo en modo producción (gate admitió) — sus símbolos. Nunca
   * rompe ni ralentiza el mensaje: los símbolos van con timeout y cualquier
   * error del LSP se traga.
   */
  async _buildCodeContext(trigger) {
    if (!trigger || !CODE_CONTEXT_TRIGGERS.has(trigger.type)) return '';
    if (!this._getFocusedFile) return '';

    let file = null;
    try {
      file = this._getFocusedFile();
    } catch {
      return '';
    }
    if (!file) return '';

    let rel = file;
    try {
      const path = require('path');
      rel = this._osSensor?.getCurrentContext?.()?.workspace
        ? path.relative(this._osSensor.getCurrentContext().workspace, file)
        : path.basename(file);
    } catch {
      /* usa el path completo si no se puede relativizar */
    }

    const lines = [`El usuario tiene el archivo de código enfocado: ${rel}`];

    if (trigger._gate && this._getSymbols) {
      try {
        const symbols = await Promise.race([
          Promise.resolve(this._getSymbols(file)),
          new Promise((resolve) => setTimeout(() => resolve(null), SYMBOL_TIMEOUT_MS)),
        ]);
        if (Array.isArray(symbols) && symbols.length) {
          const top = symbols.slice(0, MAX_SYMBOLS);
          lines.push(
            `Símbolos del archivo: ${top
              .map((s) => `${s.name}${typeof s.line === 'number' ? ` (línea ${s.line + 1})` : ''}`)
              .join(', ')}`
          );
        }
      } catch {
        /* sin símbolos → solo el archivo */
      }
    }

    lines.push(
      'Si el usuario está programando, puedes comentar u opinar algo concreto sobre este archivo (algún símbolo que veas, una mejora, un detalle) — nunca genéricos tipo "¿cómo va el código?".'
    );
    return `\n${lines.join('\n')}`;
  },

  /**
   * Registro adaptativo (frame de situación): traduce el estado del momento a
   * una instrucción determinista de REGISTRO (extensión, tono y postura) para
   * el LLM. Lo que decide si hablar lo pone el gate; aquí afinamos CÓMO decirlo
   * según flow, frustración, madrugada, recencia conversacional y cómo respondió
   * el usuario a las últimas iniciativas. Nunca lanza — devuelve '' sin contexto.
   */
  _buildSituationFrame() {
    try {
      const now = Date.now();
      const parts = [];
      const osCtx = this._osSensor?.getCurrentContext?.() ?? {};
      const idleSecs = osCtx.idleSecs ?? 0;
      const hour = new Date().getHours();
      const category = osCtx.category || this._currentCategory || null;
      const appElapsedSec = this._categoryStreakStart
        ? Math.round((now - this._categoryStreakStart) / 1000)
        : 0;

      if (hour >= 0 && hour < 6) {
        parts.push(
          'Es de madrugada: registro tranquilo, sin energía ni bromas; si hablas, que sea breve y cálido.'
        );
      }

      if (idleSecs < 30 && WORK_CATEGORIES.has(category) && appElapsedSec >= 10 * 60) {
        parts.push(
          'El usuario está en medio de un bloque de trabajo con foco. MÁXIMO 1 oración corta (≤ 16 palabras) y de apoyo; si dudas de romper el hilo, responde NO.'
        );
      } else if (
        Array.isArray(this._recentSwitches) &&
        this._recentSwitches.length >= THRASH_MIN_SWITCHES &&
        new Set(this._recentSwitches.map((s) => s.category)).size >= THRASH_MIN_DISTINCT_CATEGORY
      ) {
        const windowMin = Math.round(THRASH_WINDOW_MS / 60000);
        parts.push(
          `El usuario cambió de app ${this._recentSwitches.length} veces en ${windowMin} min (posiblemente atorado o buscando algo). Registro calmado, breve, sin sermones ni bromas; ofrece ayuda concreta SOLO si la señal lo amerita, si no responde NO.`
        );
      }

      if (this._lastUserMsg && now - this._lastUserMsg < 15 * 60 * 1000) {
        parts.push(
          'Hubo conversación hace menos de 15 min: sé breve y NO repitas lo ya hablado; si no aporta algo nuevo, responde NO.'
        );
      }

      if (this._lastProactive && now - this._lastProactive < 45 * 60 * 1000) {
        parts.push(
          'Ya hablaste hace menos de 45 min. Si esto no es claramente más valioso y distinto que lo anterior, responde NO.'
        );
      }

      // Relación: cómo respondió el usuario a las últimas iniciativas reales.
      const recent = (Array.isArray(this._relationLog) ? this._relationLog : []).filter(
        (e) => e.outcome
      );
      const last6 = recent.slice(-6);
      if (last6.length >= 2) {
        const ignoredOrRejected = last6.filter(
          (e) => e.outcome === 'rejected' || e.outcome === 'ignored'
        ).length;
        if (ignoredOrRejected >= Math.min(2, last6.length)) {
          parts.push(
            'El usuario ha descartado o ignorado varias de tus últimas iniciativas: sé MUY conservadora. Extremadamente breve o directamente NO; hoy no ofrezcas acciones nuevas.'
          );
        } else if (ignoredOrRejected === 0) {
          parts.push(
            'Las últimas iniciativas fueron bien recibidas: puedes hablar con naturalidad y ofrecer ayuda si encaja.'
          );
        } else {
          parts.push(
            'La recepción de tus últimas iniciativas fue mixta: sé breve y elige SOLO lo genuinamente importante.'
          );
        }
      }

      if (!parts.length) return '';
      return `\nREGISTRO DEL MOMENTO (adáptate a esto):\n- ${parts.join('\n- ')}`;
    } catch (e) {
      return '';
    }
  },

  /**
   * Hilo relacional (bookend): si este mismo tipo de iniciativa ya se envió
   * antes (últimas 24 h) y fue descartado/ignorado (o quedó sin respuesta), el
   * LLM lo sabe y lo REFIERE con naturalidad en lugar de repetir a ciegas —
   * como una persona que retoma un tema pendiente, no como un anuncio nuevo.
   */
  _buildBookend(trigger) {
    try {
      if (!trigger || !trigger.type) return '';
      if (!Array.isArray(this._relationLog)) return '';
      const now = Date.now();
      const prev = this._relationLog
        .filter((e) => e.trigger === trigger.type && now - e.at < 24 * 60 * 60 * 1000)
        .pop();
      if (!prev) return '';

      const when = new Date(prev.at).toLocaleTimeString('es-MX', {
        hour: '2-digit',
        minute: '2-digit',
      });
      const snippet = String(prev.msg || '').slice(0, 100);
      if (prev.outcome === 'accepted') return '';

      if (prev.outcome === 'rejected' || prev.outcome === 'ignored') {
        return `\nReiteración: ya le mencionaste esto antes (${when}) y fue descartado o ignorado: "${snippet}". Si insistes, refiérelo con naturalidad y reconócelo ("sé que ya te lo dije..."), sin sermonear. Si no tienes algo nuevo o importante, responde NO.`;
      }
      return `\nYa se lo mencionaste antes (${when}, sin respuesta): "${snippet}". Si es importante, retómalo en una línea; si es prescindible, responde NO.`;
    } catch (e) {
      return '';
    }
  },
};
