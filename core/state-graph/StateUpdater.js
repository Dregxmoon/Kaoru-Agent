// @ts-nocheck
const logger = require('../observability/Logger.js');
/**
 * StateUpdater.js — con ContradictionResolver integrado + validación de labels
 *
 * Todo guardado pasa por el resolver — nunca directo a upsertNode.
 * El resolver decide si overwrite, archive_and_replace, o append.
 *
 * Validación de labels (nuevo):
 *   - Los labels FIJOS (lista cerrada) deben coincidir EXACTO para poder
 *     reconciliarse (overwrite / archive_and_replace).
 *   - Los labels dinámicos (proyecto_*, preferencia_*) se permiten libres,
 *     para que el asistente pueda "aprender" cosas nuevas del usuario sin romper
 *     la reconciliación de los hechos fijos.
 *   - Cualquier otro label inventado por el LLM se descarta y se loggea.
 */

const LLMProvider = require('../llm/LLMProvider.js');
const { ContradictionResolver } = require('./ContradictionResolver.js');
const EmbedService = require('../grounding/EmbedService.js');

// ── Segmentación temática de sesiones ─────────────────────────────────────────
// processSession() ya no comprime TODA la sesión en un solo Episode: la divide
// por tema y extrae UN Episode por segmento (mismo prompt/formato, sub-historial
// por segmento). El corte se decide por similitud coseno entre los embeddings de
// turnos consecutivos.
//   - SEGMENT_COSINE_THRESHOLD: bajo este valor (cambio claro de tema) se corta.
//   - MIN_SEGMENT_TURNS: un segmento nunca baja de 3 turnos (no trocear charlas).
//   - MIN_SESSION_TURNS_FOR_SEGMENTATION: con mínimo 3 turnos por segmento, una
//     sesión de menos de 6 turnos no tiene espacio para 2 segmentos con sentido —
//     se trata completa, sin intentar cortar nada.
const SEGMENT_COSINE_THRESHOLD = 0.4;
const MIN_SEGMENT_TURNS = 3;
const MIN_SESSION_TURNS_FOR_SEGMENTATION = 6;

const EXTRACTION_SYSTEM = `Eres la memoria del asistente personal. Analiza la conversación y extrae lo memorable.

LABELS PERMITIDOS (usa EXACTAMENTE estos):
- nombre_usuario → nombre del usuario
- edad_usuario → edad actual
- cumpleanos_usuario → fecha de cumpleaños  
- ubicacion_usuario → dónde vive
- trabajo_usuario → profesión o trabajo
- color_favorito → colores favoritos
- musica_favorita → música o artistas favoritos
- proyecto_principal → proyecto más importante activo
- observaciones_usuario → rasgos de carácter observados del usuario (NO del asistente)
- estado_usuario → estado/ánimo/energía actual del usuario en esta conversación ("Está agotado tras la mudanza", "Está de buen humor", "Está concentrado en el proyecto")
Para proyectos secundarios: proyecto_[nombre] (ej: proyecto_asistente)
Para preferencias extra: preferencia_[tema] (ej: preferencia_anime)

RELACIONES: si dos nodos extraídos están relacionados entre sí, decláralo en "relations"
usando los mismos labels (source/target deben existir en "nodes"):
- RELATED_TO → conexión general (nodos del mismo tema/proyecto)
- IMPLIES → un hecho implica otro (ej: usa Java IMPLIES lenguaje de programación)
- PART_OF → uno es parte de otro (ej: proyecto_calculadora PART_OF trabajo_usuario)
- CONTRADICES → un hecho nuevo contradice uno viejo conocido
- USES → un proyecto usa una tecnología/preferencia (ej: proyecto_calculadora USES Java)
Solo relaciones genuinas de la conversación actual — no inventes.

REGLAS CRÍTICAS:
- Si el usuario CORRIGE algo ("en realidad", "me equivoqué", "ahora"), usa el valor NUEVO
- El valor nuevo REEMPLAZA al viejo — no los combines
- Guarda SOLO info explícita, nunca inferida
- Si no hay nada memorable: nodes:[]
- USA EXACTAMENTE los labels de la lista — no inventes variantes (ej: NO "edad_luka", usa "edad_usuario")

JSON válido únicamente, sin texto extra ni backticks:
{
  "episode_summary": "1 oración o null",
  "episode_importance": 0.0,
  "nodes": [
    {
      "type": "User|Episode|Belief|Preference|Project",
      "label": "label_exacto_de_la_lista",
      "content": "contenido a recordar",
      "importance": 0.0,
      "tags": []
    }
  ],
  "relations": [
    {
      "source": "label del nodo source",
      "target": "label del nodo target",
      "type": "RELATED_TO|IMPLIES|PART_OF|CONTRADICES|USES"
    }
  ]
}`;

// ── Validación de labels ──────────────────────────────────────────────────────
// Labels fijos: deben coincidir exacto para que el resolver pueda reconciliar
// (overwrite / archive_and_replace). Si el LLM inventa una variante de estos
// (ej. "edad_luka" en vez de "edad_usuario"), se descarta.
const FIXED_LABELS = new Set([
  'nombre_usuario',
  'edad_usuario',
  'cumpleanos_usuario',
  'ubicacion_usuario',
  'trabajo_usuario',
  'proyecto_principal',
  'color_favorito',
  'musica_favorita',
  'comida_favorita',
  'observaciones_usuario',
  'estado_usuario',
]);
// Legacy: aceptar también el label antiguo
const LEGACY_LABELS = new Map([
  ['personalidad_observada', 'observaciones_usuario'], // migrar al nuevo nombre
]);

// Prefijos dinámicos permitidos: el LLM SÍ puede crear labels nuevos aquí,
// a propósito, para ir "aprendiendo" cosas del usuario sin tocar los hechos fijos.
// 'recordar_' lo usa detectAndSaveInstant para "recuerda que X..." — se registra
// aquí para que la validación sea consistente entre el camino instantáneo (regex)
// y el camino LLM (antes era un label inventado que bypasseaba isValidLabel).
const DYNAMIC_PREFIXES = ['proyecto_', 'preferencia_', 'recordar_'];

// Patrones de contenido técnico/comando — mismo set que ContradictionResolver
// pero definido localmente para evitar acoplamiento circular
const COMMAND_PATTERNS = [
  /^Ejecutar:\s/i,
  /^Voy a (leer|escribir|ejecutar)\s/i,
  /^(git|npm|node|ls|cd|cat|echo|mkdir|rm|cp|mv|docker|kubectl|pip|npx|yarn)\s/i,
  /^No (encontré|pude|se)\s/i,
  /^Lo siento/i,
  /^El comando no/i,
  /^Parece que no/i,
  /^No obtuve/i,
  /^El sistema no/i,
  /falló\.?$/i,
  /^\[object Object\]/i,
];

function _isCommandContent(text) {
  return COMMAND_PATTERNS.some((p) => p.test(text.trim()));
}

/**
 * Similitud coseno entre dos vectores (embeddings). Devuelve 0 si alguno está
 * vacío o no se puede comparar — tratar como "sin relación" (corte) es seguro
 * porque el mínimo de segmento protege de cortar charlas cortas.
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 * @returns {number}
 */
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

function isValidLabel(label) {
  if (FIXED_LABELS.has(label)) return true;
  if (LEGACY_LABELS.has(label)) return true;
  // Leaks de plantilla del LLM ("proyecto_[nombre]") — nunca son datos reales.
  if (/[[\]]/.test(label)) return false;
  return DYNAMIC_PREFIXES.some((prefix) => label.startsWith(prefix));
}

function migrateLabel(label) {
  return LEGACY_LABELS.get(label) || label;
}

// Patrones de guardado inmediato — sin LLM
// (orden importa: el de "en realidad/ahora" va antes del genérico — si ambos
//  matchean el mismo mensaje, gana el más específico gracias al guard de abajo)
const INSTANT_PATTERNS = [
  {
    regex:
      /(?:me llamo|mi nombre es|my name is|i'?m called|call me)\s+([A-Za-záéíóúÁÉÍÓÚñÑ]{2,30})\b/i,
    node: (m) => ({
      type: 'User',
      label: 'nombre_usuario',
      content: `El usuario se llama ${m[1]}`,
      importance: 0.95,
      tags: ['nombre'],
    }),
  },
  {
    // Cobertura amplia de cómo la gente dice su edad en español/inglés:
    //   "21 años" · "tengo 21 años" · "mi edad es 21" · "mi edad son 30"
    //   "soy 19 años" · "en realidad tengo 33 años" · "i'm 28 (years old)"
    // "años" es OBLIGATORIO salvo con "mi edad es/son", para no confundir
    // "tengo 2 perros" con una edad. El prefijo de corrección va explícito.
    regex:
      /(?:en realidad |ahora |ya )?(?:mi edad (?:es|son)\s+)?(\d{1,3})\s*años|(?:en realidad |ahora |ya )?(?:mi edad (?:es|son)\s+)(\d{1,3})\b|(?:en realidad |ahora |ya )?tengo\s+(\d{1,3})\s+años|(?:en realidad |ahora |ya )?soy\s+(?:de )?(\d{1,3})\s+años|(?:actually |now )?i'?m\s+(\d{1,3})\s*(?:years? old|yr)\b|(?:actually |now )?my age is\s+(\d{1,3})\b/i,
    node: (m) => {
      const edad = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
      return {
        type: 'User',
        label: 'edad_usuario',
        content: `El usuario tiene ${edad} años`,
        importance: 0.85,
        tags: ['edad'],
      };
    },
  },
  {
    regex:
      /(?:(?:el\s+)?(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre).*cumplea[ñn]os|cumplea[ñn]os.*(?:el\s+)?(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)|(?:my )?birthday\s+(?:is\s+)?(?:on\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+of\s+(january|february|march|april|may|june|july|august|september|october|november|december))/i,
    node: (m) => {
      const dia = m[1] || m[3] || m[5];
      const mes = m[2] || m[4] || m[6];
      const mesesEn = {
        january: 'enero',
        february: 'febrero',
        march: 'marzo',
        april: 'abril',
        may: 'mayo',
        june: 'junio',
        july: 'julio',
        august: 'agosto',
        september: 'septiembre',
        october: 'octubre',
        november: 'noviembre',
        december: 'diciembre',
      };
      const mesStr = mesesEn[mes?.toLowerCase()] || mes;
      return {
        type: 'User',
        label: 'cumpleanos_usuario',
        content: `Cumpleaños: ${dia} de ${mesStr}`,
        importance: 0.92,
        tags: ['cumpleaños'],
      };
    },
  },
  {
    // Patrón de corrección — va antes del genérico a propósito
    regex:
      /(?:en realidad|ahora|actually)\s+(?:mis?\s+colou?r(?:es)?\s+(?:favorito(?:s)?\s+)?(?:son|es|me gustan?|are|is)|(?:no\s+)?me\s+gusta(?:n)?\s+(?:el\s+|los\s+)?(?:azul|rojo|verde|amarillo|negro|blanco|morado|rosa|naranja|café|gris|blue|red|green|yellow|black|white|purple|pink|orange|brown|gray|grey))\s*(?:,?\s*(?:sino|si no|pero sí|y|but|and|actually)?\s*(?:son|es|are|is)?\s*)?(.{3,50})/i,
    node: (m) => ({
      type: 'Preference',
      label: 'color_favorito',
      content: `Colores favoritos: ${m[1].trim()}`,
      importance: 0.88,
      tags: ['color'],
    }),
  },
  {
    regex:
      /(?:mi\s+)?(?:colou?r|favou?rite colou?r)(?:es)?\s+favo(u)?rito(?:s)?\s+(?:es|son|:|\s+is\s+|\s+are\s+)\s*(.{3,50})/i,
    node: (m) => ({
      type: 'Preference',
      label: 'color_favorito',
      content: `Colores favoritos: ${m[2].trim()}`,
      importance: 0.75,
      tags: ['color'],
    }),
  },
  {
    regex:
      /(?:trabajo como|me dedico a|soy\s+(?:un\s+|una\s+)?(?:desarrollador|programador|diseñador|ingeniero|doctor|maestro|estudiante)|i work as|i'?m a\s+(?:developer|programmer|designer|engineer|doctor|teacher|student))/i,
    node: (m) => ({
      type: 'User',
      label: 'trabajo_usuario',
      content: `Trabajo: ${m[0].trim()}`,
      importance: 0.8,
      tags: ['trabajo'],
    }),
  },
  {
    // Proyecto principal. Descartamos "trabajando en|programando|working on":
    // son tareas del momento, NO el proyecto principal — sin esto, cualquier
    // mensaje ("estoy trabajando en este bug") pisa el proyecto canónico.
    regex:
      /(?:estoy (?:desarrollando|construyendo|haciendo)|mi proyecto(?:\s+principal)? (?:es|se llama)|i'?m (?:developing|building|working on my)|my (?:main\s+)?project (?:is|called))\s*(?:un\s+|una\s+|an?\s+)?(.{3,60})/i,
    node: (m) => {
      const proj = m[1] || m[2];
      return {
        type: 'Project',
        label: 'proyecto_principal',
        content: `Proyecto: ${proj.trim()}`,
        importance: 0.82,
        tags: ['proyecto'],
      };
    },
  },
  {
    regex: /(?:vivo en|soy de|i live in|i'?m from)\s+([A-Za-záéíóúÁÉÍÓÚñÑ\s,]{3,40})/i,
    node: (m) => ({
      type: 'User',
      label: 'ubicacion_usuario',
      content: `Vive en: ${m[1].trim()}`,
      importance: 0.7,
      tags: ['ubicación'],
    }),
  },
  {
    regex:
      /(?:recuerda(?:lo|la)?|no olvides|remember|don'?t forget)\s+(?:que\s+|that\s+)?(.{5,100})/i,
    // FIX: label único — antes era solo `recordar_${Date.now()}` y dos
    // guardados en el MISMO milisegundo colisionaban; el resolver los
    // fusionaba (" | Actualizado: ") y el contenido quedaba corrupto
    // (ej. un day_event "aniversario el 15 de junio" mezclado con otra
    // fecha se parseaba como time_event y nunca emitía).
    node: (m) => ({
      type: 'Belief',
      label: `recordar_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      content: `Pidió recordar: ${m[1].trim()}`,
      importance: 0.88,
      tags: ['recordar'],
    }),
  },
  {
    // Estado del usuario (humor/energía/ánimo). Overwrite: el último gana.
    // Debe ir DESPUÉS de los patrones más específicos para no capturar
    // fragmentos de otras frases ("estoy desarrollando..." ya matcheó antes).
    regex:
      /(?:estoy|me siento|anda(?:ba)?|vengo)\s+(?:muy\s+|re\s+|bastante\s+|super\s+|súper\s+|bien\s+de\s+)?(cansad[oa]|agotad[oa]|frustrad[oa]|estresad[oa]|preocupad[oa]|content[oa]|feliz|triste|aburrid[oa]|motivad[oa]|concentrad[oa]|ocupad[oa]|enérgic[oa]|con\s+energía|de\s+buen\s+humor|de\s+mal\s+humor|sin\s+ganas|agobiad[oa])/i,
    node: (m) => ({
      type: 'User',
      label: 'estado_usuario',
      content: `Estado: ${m[0].trim()}`,
      importance: 0.7,
      tags: ['estado'],
    }),
  },
];

class StateUpdater {
  constructor(stateGraph) {
    this._graph = stateGraph;
    this._resolver = new ContradictionResolver(stateGraph);
  }

  /**
   * Guardado inmediato por regex — sin LLM, sin tokens.
   * Todo pasa por el resolver para manejar contradicciones.
   *
   * Guard: si dos patrones distintos matchean el mismo label en el mismo
   * mensaje (ej. "en realidad mi color favorito es rojo" matchea el genérico
   * Y el de corrección), solo se procesa el primero que aparezca — evita
   * doble resolve()/doble escritura para el mismo hecho.
   */
  detectAndSaveInstant(userMessage) {
    if (!userMessage || !this._graph?.isReady) return 0;
    let saved = 0;
    const text = userMessage.trim();
    const labelsHandled = new Set();

    for (const pattern of INSTANT_PATTERNS) {
      try {
        const match = text.match(pattern.regex);
        if (match) {
          const nodeData = pattern.node(match);
          if (labelsHandled.has(nodeData.label)) continue;
          labelsHandled.add(nodeData.label);

          this._resolver.resolve(nodeData);
          saved++;
          logger.info('StateUpdater', `[state-updater] inmediato: ${nodeData.label}`);
        }
      } catch (e) {
        logger.warn('StateUpdater', '[state-updater] error regex:', e.message);
      }
    }
    return saved;
  }

  /**
   * Divide un historial de sesión en segmentos temáticos. Un "ningún corte" se
   * traduce en UN solo segmento (la sesión completa). El corte se decide por
   * similitud coseno entre los embeddings de turnos consecutivos (EmbedService):
   * donde la similitud cae bajo SEGMENT_COSINE_THRESHOLD hay un cambio de tema.
   *
   * Reglas de no over-segmentación:
   *  - Sesiones con menos de MIN_SESSION_TURNS_FOR_SEGMENTATION (6) turnos:
   *    un solo segmento — no tiene sentido intentar cortar.
   *  - Un segmento nunca arranca con menos de MIN_SEGMENT_TURNS (3) turnos:
   *    un corte no se acepta si el segmento actual o lo que queda por delante
   *    quedaría en menos de 3 turnos.
   *
   * Si EmbedService falla o devuelve algo que no se puede comparar ("null" o
   * vacío), se respeta el caso más conservador: la sesión completa en un solo
   * segmento. Nunca rompe el pipeline de cierre de sesión.
   *
   * @param {Array<{ role: string, content: string }>} history
   * @returns {Promise<Array<Array<{ role: string, content: string }>>>}
   */
  async _segmentByTopic(history) {
    const turns = Array.isArray(history) ? history : [];
    if (turns.length < MIN_SESSION_TURNS_FOR_SEGMENTATION) {
      return [turns];
    }

    // Embeber todos los turnos en paralelo. Cualquier fallo de embebido
    // devuelve la sesión como un único segmento (nunca cortamos a ciegas).
    try {
      const vectors = await Promise.all(
        turns.map((t) => EmbedService.embedText(`${t.role}: ${t.content}`))
      );
      if (vectors.some((v) => !v || v.length === 0)) return [turns];

      const segments = [];
      let start = 0;
      for (let i = 1; i < turns.length; i++) {
        const sim = cosine(vectors[i - 1], vectors[i]);
        const currentLen = i - start;
        const remaining = turns.length - i;
        const isTopicShift = sim < SEGMENT_COSINE_THRESHOLD;
        // No aceptar un corte que deje un segmento de menos de 3 turnos.
        const respectsMinSize = currentLen >= MIN_SEGMENT_TURNS && remaining >= MIN_SEGMENT_TURNS;
        if (isTopicShift && respectsMinSize) {
          segments.push(turns.slice(start, i));
          start = i;
        }
      }
      segments.push(turns.slice(start));
      return segments;
    } catch (e) {
      logger.warn(
        'StateUpdater',
        '[state-updater] error al segmentar por tema (sesión completa como 1 segmento):',
        e.message
      );
      return [turns];
    }
  }

  /**
   * Análisis LLM al cierre de sesión.
   * Todo pasa por el resolver, y los labels se validan antes — si el LLM
   * inventa una variante de un label fijo, se descarta en vez de crear
   * un duplicado que nunca se reconcilia con el hecho canónico.
   *
   * OPTIMIZACIÓN: antes de llamar al LLM, se ejecuta detectAndSaveInstant
   * sobre los mensajes del usuario para capturar patrones triviales (nombre,
   * edad, color favorito, etc.) sin gastar tokens. Si no hay mensajes del
   * usuario (sesión de solo asistente), se omite el LLM por completo.
   *
   * SEGMENTACIÓN: la sesión se divide por tema (_segmentByTopic). El caso
   * común (1 segmento, sesiones cortas o monotemáticas) mantiene el
   * comportamiento exacto de antes: una sola llamada al LLM produce a la vez
   * el resumen de sesión (sessions.summary) y el Episode. En sesiones
   * multi-tema se hace UNA llamada al LLM por segmento, y cada segmento crea
   * su propio nodo Episode — la memoria pasa a describir cada tema, en vez de
   * comprimir toda la sesión a un solo resumen. sessions.summary SIEMPRE se
   * genera a nivel sesión completa, como hoy, para no romper getLastSessions.
   */
  async processSession(sessionId, history, turnCount) {
    if (!history || history.length < 2) {
      logger.info('StateUpdater', '[state-updater] sesión muy corta');
      this._graph.endSession(sessionId, { turnCount, summary: null });
      return { saved: 0, skipped: true };
    }

    // Pre-filtro barato: detectar patrones sin LLM
    let instantSaved = 0;
    for (const turn of history) {
      if (turn.role === 'user') {
        instantSaved += this.detectAndSaveInstant(turn.content);
      }
    }

    // Si no hay mensajes del usuario, no tiene sentido llamar al LLM
    const userMessages = history.filter((t) => t.role === 'user');
    if (userMessages.length === 0) {
      logger.info('StateUpdater', '[state-updater] sin mensajes de usuario — omitiendo LLM');
      this._graph.endSession(sessionId, { turnCount, summary: null });
      return { saved: instantSaved, skipped: true };
    }

    logger.info(
      'StateUpdater',
      `[state-updater] analizando sesión (${history.length} mensajes, ${instantSaved} instantáneos)...`
    );

    // Segmentos temáticos; _segmentByTopic nunca rompe el pipeline (ante
    // cualquier fallo devuelve la sesión completa como un único segmento).
    const segments = await this._segmentByTopic(history);

    // Map label→id para resolver las relaciones extraídas (solo nodos activos).
    // Compartido entre segmentos: un segmento puede referenciar nodos de otro.
    const idByLabel = new Map();
    let saved = 0,
      discarded = 0,
      relations = 0;
    const episodeIds = [];

    // Caso común (1 segmento = la sesión): UNA llamada al LLM hace todo,
    // exactamente como antes — resumen de sesión + Episode.
    if (segments.length === 1) {
      let extracted;
      try {
        extracted = await this._extractMemories(history);
      } catch (e) {
        logger.error('StateUpdater', '[state-updater] error LLM:', e.message);
        this._graph.endSession(sessionId, { turnCount, summary: null });
        return { saved: instantSaved, error: e.message };
      }
      const r = this._saveExtraction(extracted, idByLabel);
      saved += r.saved;
      discarded += r.discarded;
      relations += r.relations;
      const epId = this._createEpisodeNode(extracted);
      if (epId) episodeIds.push(epId);

      this._graph.endSession(sessionId, {
        turnCount,
        summary: extracted.episode_summary,
        episodeId: episodeIds[0] ?? null,
      });
      logger.info(
        'StateUpdater',
        `[state-updater] guardados: ${saved} nodos, ${relations} relaciones, descartados: ${discarded}, episodios: ${episodeIds.length}`
      );
      return { saved, relations, discarded, episodeId: episodeIds[0] ?? null, segments: 1 };
    }

    // Multi-segmento: UNA llamada al LLM por segmento, cada una con SU
    // sub-historial; cada resumen crea su propio Episode.
    const segmentSummaryTexts = [];
    for (let i = 0; i < segments.length; i++) {
      try {
        const extracted = await this._extractMemories(segments[i]);
        const r = this._saveExtraction(extracted, idByLabel);
        saved += r.saved;
        discarded += r.discarded;
        relations += r.relations;
        const epId = this._createEpisodeNode(extracted);
        if (epId) episodeIds.push(epId);
        if (extracted.episode_summary) segmentSummaryTexts.push(extracted.episode_summary);
      } catch (e) {
        logger.warn('StateUpdater', `[state-updater] error LLM en segmento ${i + 1}:`, e.message);
      }
    }

    // sessions.summary a nivel sesión completa, SIN llamada LLM extra: se
    // compone de los resúmenes por segmento (cubre toda la sesión y mantiene
    // getLastSessions legible, como pide el requisito "no romper esa función").
    // Si un segmento falló, el resto de tema(s) aún dejan un summary legible.
    const sessionSummary = segmentSummaryTexts.length ? segmentSummaryTexts.join(' | ') : null;

    this._graph.endSession(sessionId, {
      turnCount,
      summary: sessionSummary,
      episodeId: episodeIds[0] ?? null,
    });
    logger.info(
      'StateUpdater',
      `[state-updater] ${segments.length} segmentos: ${saved} nodos, ${relations} relaciones, descartados: ${discarded}, episodios: ${episodeIds.length}`
    );
    return {
      saved,
      relations,
      discarded,
      episodeId: episodeIds[0] ?? null,
      segments: segments.length,
    };
  }

  /**
   * Guarda nodos y relaciones de una extracción (a través del resolver y con
   * validación de labels). Mutaciones vía `idByLabel` (compartido entre
   * segmentos).
   * @param {{ nodes?: any[], relations?: any[] }} extracted
   * @param {Map<string, number>} idByLabel
   * @returns {{ saved: number, discarded: number, relations: number }}
   */
  _saveExtraction(extracted, idByLabel) {
    let saved = 0,
      discarded = 0,
      relations = 0;
    for (const node of extracted.nodes || []) {
      try {
        if (!node.type || !node.label || !node.content) continue;
        if (!['User', 'Episode', 'Belief', 'Preference', 'Project'].includes(node.type)) {
          discarded++;
          continue;
        }

        const label = node.label.toLowerCase().replace(/\s+/g, '_').slice(0, 80);

        if (!isValidLabel(label)) {
          logger.warn('StateUpdater', `[state-updater] label inválido descartado: ${label}`);
          discarded++;
          continue;
        }

        // Migrar labels legacy (ej. personalidad_observada → observaciones_usuario)
        const migratedLabel = migrateLabel(label);

        const id = this._resolver.resolve({
          type: node.type,
          label: migratedLabel,
          content: node.content,
          importance: Math.min(1.0, Math.max(0.1, node.importance ?? 0.6)),
          tags: Array.isArray(node.tags) ? node.tags : [],
        });
        idByLabel.set(migratedLabel, id);
        saved++;
      } catch (e) {
        logger.warn('StateUpdater', '[state-updater] error guardando nodo:', e.message);
      }
    }

    // Relaciones extraídas: conectan nodos por label (usando ids recién guardados
    // o nodos activos preexistentes). Se descartan las que no resuelvan.
    for (const rel of extracted.relations || []) {
      try {
        const sourceLabel = String(rel.source || '')
          .toLowerCase()
          .replace(/\s+/g, '_')
          .slice(0, 80);
        const targetLabel = String(rel.target || '')
          .toLowerCase()
          .replace(/\s+/g, '_')
          .slice(0, 80);
        const sourceId =
          idByLabel.get(sourceLabel) ?? this._graph._findActiveNodeByLabel(sourceLabel)?.id;
        const targetId =
          idByLabel.get(targetLabel) ?? this._graph._findActiveNodeByLabel(targetLabel)?.id;
        const type = String(rel.type || 'RELATED_TO').toUpperCase();
        if (!/^(RELATED_TO|IMPLIES|PART_OF|CONTRADICES|USES)$/.test(type)) continue;
        if (this._graph.createRelation({ source: sourceId, target: targetId, type })) {
          relations++;
        }
      } catch (e) {
        logger.warn('StateUpdater', '[state-updater] error guardando relación:', e.message);
      }
    }
    return { saved, discarded, relations };
  }

  /**
   * Crea el nodo Episode de una extracción (una extracción por segmento).
   * @param {{ episode_summary?: string, episode_importance?: number }} extracted
   * @returns {number | null} id del Episode, o null si no hay resumen.
   */
  _createEpisodeNode(extracted) {
    if (!extracted.episode_summary) return null;
    const dateStr = new Date().toLocaleDateString('es-MX', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    });
    return this._graph.createNode({
      type: 'Episode',
      label: `sesion_${Date.now()}`,
      content: `[${dateStr}] ${extracted.episode_summary}`,
      importance: Math.min(1.0, Math.max(0.1, extracted.episode_importance ?? 0.5)),
      tags: ['sesion'],
    });
  }

  async _extractMemories(history) {
    const recent = history.slice(-10);
    const conversation = recent
      .map((m) => `${m.role === 'user' ? 'Usuario' : 'Asistente'}: ${m.content}`)
      .join('\n');

    // DECISIÓN smart mode: con la segmentación por tema, el umbral de >20 turnos
    // ahora aplica POR SEGMENTO, no por sesión completa. Antes una sesión de
    // 30 turnos cambiaba a smart aunque fueran 2 temas de 15; hoy cada segmento
    // decide por sí mismo: un segmento largo (tema pesado, >20 turnos) usa
    // smart sobre SU contexto completo, y los segmentos cortos usan el modo
    // normal. Es más justo con el contexto real que recibe cada llamada. El
    // caso de 1 segmento (sesión corta/monotemática) se comporta igual que
    // siempre, porque su longitud == la de la sesión.
    const useSmart = history.length > 20;
    const raw = useSmart
      ? await LLMProvider.completeTask(
          [{ role: 'user', content: `Conversación:\n\n${conversation}` }],
          EXTRACTION_SYSTEM
        )
      : await LLMProvider.complete(
          [{ role: 'user', content: `Conversación:\n\n${conversation}` }],
          EXTRACTION_SYSTEM
        );
    return this._parseJSON(raw);
  }

  _parseJSON(raw) {
    if (!raw) return { episode_summary: null, episode_importance: 0, nodes: [], relations: [] };
    try {
      return JSON.parse(raw.trim());
    } catch (_) {}
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (_) {}
    }
    return { episode_summary: null, episode_importance: 0, nodes: [], relations: [] };
  }

  runDecay() {
    this._graph.applyDecay();
  }

  /**
   * Limpieza de memoria: encuentra nodos cuyo contenido son artefactos de
   * comandos ejecutados (fallos del agente, ejecuciones aisladas, etc.)
   * y los archiva o limpia. Esto evita que la memoria persistente se
   * llene de "Ejecutar: git status | Actualizado: Lo siento..." que
   * contamina el contexto del LLM en cada turno.
   *
   * @returns {{ archived: number, cleaned: number }}
   */
  cleanupMemoryArtifacts() {
    if (!this._graph?.isReady) return { archived: 0, cleaned: 0 };
    let archived = 0,
      cleaned = 0;

    try {
      // Obtener TODOS los nodos activos con label dinámico (proyecto_*, preferencia_*)
      // que son los más propensos a contaminarse con comandos
      const allNodes = this._graph._db
        .prepare(
          `
        SELECT id, label, content FROM nodes WHERE archived=0 AND (label LIKE 'proyecto_%' OR label LIKE 'preferencia_%')
      `
        )
        .all();

      for (const node of allNodes) {
        if (!node.content) continue;

        // Si TODO el contenido es basura de comando, archivar el nodo entero
        const lines = node.content.split(/\s*\|\s*Actualizado:\s*/);
        const allAreCommands = lines.length > 0 && lines.every((l) => _isCommandContent(l.trim()));
        if (allAreCommands) {
          logger.info(
            'StateUpdater',
            `[state-updater] archivando nodo contaminado: ${node.label} — "${node.content.slice(0, 80)}"`
          );
          this._graph._archiveNode(node.id);
          archived++;
          continue;
        }

        // Si hay mezcla, filtrar solo los segmentos de comando
        const filtered = lines.filter((l) => !_isCommandContent(l.trim()));
        if (filtered.length > 0 && filtered.length < lines.length) {
          const newContent = filtered.join(' | ');
          logger.info(
            'StateUpdater',
            `[state-updater] limpiando nodo: ${node.label} — ${lines.length - filtered.length} segmento(s) de comando eliminados`
          );
          this._graph.updateNode(node.id, { content: newContent });
          cleaned++;
        }
      }
    } catch (e) {
      logger.warn('StateUpdater', '[state-updater] error en cleanupMemoryArtifacts:', e.message);
    }

    return { archived, cleaned };
  }
}

module.exports = { StateUpdater, isValidLabel, migrateLabel, FIXED_LABELS, DYNAMIC_PREFIXES };
