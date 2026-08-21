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

    // Contexto emocional y de momentum de topics (nuevos componentes evolutivos)
    const emotionalCtx = await this._buildEmotionalContext(trigger);
    const topicCtx = this._buildTopicContext(trigger);

    const userPrompt = `Son las ${timeStr} (${now.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' })}). Esta es la hora y fecha REAL en este momento, confía en este dato por encima de cualquier otra cosa.
Contexto del trigger: ${trigger.context}
${osCtx?.openWindowsSummary ? `El usuario tiene abierto: ${osCtx.openWindowsSummary}` : ''}
${osCtx?.app ? `App activa: ${osCtx.friendlyName || osCtx.app}` : ''}
${osCtx?.history?.length ? `Resumen del día (apps usadas): ${this._osSensor?.getTodaySummary?.() || ''}` : ''}

Razón para escribir: ${_triggerDescription(trigger)}
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
      const trimmed = _extractFinalMessage(response);
      if (!trimmed || trimmed.toUpperCase() === 'NO' || trimmed.length < 5) {
        return null;
      }

      // G.1: en modo producción el gate ya admitió la señal; filtrar el relleno
      // genérico que degrada la experiencia (el LLM a veces "saluda" en vez de
      // decir algo con sustancia).
      if (productionMode && _isLowValueMessage(trimmed)) {
        logger.info(
          'message-gen',
          '[proactive] mensaje descartado por relleno (producción):',
          JSON.stringify(trimmed)
        );
        return null;
      }

      return trimmed;
    } catch (e) {
      logger.warn('message-gen', '[proactive] error generando mensaje:', e.message);
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
          // Solo memoria real: placeholders, workspaces auto-init, preferencias
          // del sistema y boilerplate del LLM no son datos sobre el usuario.
          if (byType[node.type] && isRealIdentityNode(node)) byType[node.type].push(node);
        }

        // Límite por tipo para no saturar el prompt del LLM
        const MAX_PER_TYPE = 3;
        if (byType.User.length) {
          lines.push('Lo que sabes del usuario:');
          byType.User.slice(-MAX_PER_TYPE).forEach((n) => lines.push(`- ${n.content}`));
        }
        if (byType.Project.length) {
          lines.push('Proyectos activos:');
          byType.Project.slice(-MAX_PER_TYPE).forEach((n) => lines.push(`- ${n.content}`));
        }
        if (byType.Preference.length) {
          lines.push('Preferencias observadas:');
          // Las preferencias de gusto (música/anime/comida/juego...) se muestran
          // primero: conectan con contenido en pantalla. El resto entra si hay
          // hueco, priorizando las más recientes/importantes.
          _pickTasteFirst(byType.Preference, MAX_PER_TYPE).forEach((n) =>
            lines.push(`- ${n.content}`)
          );
        }
        if (byType.Belief.length) {
          lines.push('Cosas que crees sobre el usuario:');
          byType.Belief.slice(-MAX_PER_TYPE).forEach((n) => lines.push(`- ${n.content}`));
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

      // Gaps de conocimiento: rasgos del usuario que aún no sabes. Úsalos como
      // puntos de curiosidad genuina — preguntar algo de aquí vale más que
      // preguntar "¿cómo va el proyecto?" por enésima vez.
      const gaps = getMemoryGaps();
      if (gaps.length) {
        lines.push('Aún no sabes de la persona:');
        gaps.forEach((g) =>
          lines.push(`- ${g.trait} (no lo sabes; puedes preguntarlo con curiosidad natural)`)
        );
      }
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
        trigger.type === 'intention_stale')
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
        for (let i = 0; i < count; i++) {
          bits.push(`- aún no sabes ${gaps[(start + i) % n].trait}`);
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
