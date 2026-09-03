// @ts-nocheck
/**
 * RetrievalPlanner.js — Fase 3 (actualizado)
 *
 * CAMBIOS respecto a la versión Fase 2:
 *   - Se agrega detección semántica de intenciones de herramienta
 *     via IntentDetector (embeddings locales).
 *   - El método plan() ahora acepta un tercer argumento `detectIntent`
 *     (boolean, default true) para activar/desactivar la detección.
 *   - Se agrega planWithIntent() como método principal para el flujo
 *     de Fase 3 — retorna el resultado del StateGraph MÁS el resultado
 *     de IntentDetector en un solo objeto.
 *   - TODO lo anterior de Fase 2 (StateGraph, keywords, episodios,
 *     OS context) sigue funcionando exactamente igual — sin romper nada.
 *
 * Separación de responsabilidades:
 *   RetrievalPlanner → qué nodos del StateGraph son relevantes
 *   IntentDetector   → qué intención de herramienta tiene el mensaje
 *   ContextAssembler → los une en el Context Package final
 *
 * Flujo de datos:
 *   userMessage
 *     ├─→ RetrievalPlanner.plan()     → { nodes, episodes }  (StateGraph)
 *     └─→ IntentDetector.detect()     → { action, confidence, level }
 *           ↓
 *         ContextAssembler.build()    → Context Package con ambos resultados
 *           ↓
 *         GroqSerializer              → system prompt con instrucción de formato
 *           ↓
 *         LLM responde:               ACCIÓN: edit_file | ARCHIVO: main.js
 *           ↓
 *         StructuredActionParser      → extrae la acción sin regex frágil
 *           ↓
 *         OpenClawBridge.execute()    → herramienta real
 */

'use strict';
const logger = require('../observability/Logger.js');
const { resolveTemporalWindow } = require('../state-graph/stores/AutobiographicalMemoryStore.js');

// ── Patrones de intención para StateGraph (sin cambios de Fase 2) ──────────────
const INTENT_PATTERNS = [
  {
    pattern: /\b(proyecto|project|trabajando en|working on|construyendo|building)\b/i,
    types: ['Project'],
  },
  {
    pattern: /\b(recuerdas|recuerda|dijiste|mencionaste|remember|acordar)\b/i,
    types: ['Episode', 'Belief'],
  },
  {
    pattern: /\b(preferencia|gusta|favorito|like|prefer|odio|hate|detesto)\b/i,
    types: ['Preference'],
  },
  { pattern: /\b(quién soy|mi nombre|cómo me llamo|who am i|me llamo)\b/i, types: ['User'] },
  {
    pattern: /\b(código|programar|bug|error|función|debug|script|repo|git)\b/i,
    types: ['Project', 'Belief'],
  },
  {
    pattern: /\b(ayer|antes|última vez|last time|semana pasada|hace días|dijiste)\b/i,
    types: ['Episode'],
  },
  {
    pattern:
      /(?:^|[^\p{L}\p{N}_])(cómo estoy|cómo me ves|qué piensas de mí|qué sabes de mí|how (?:am i|do you see me)|what do you (?:know|think) (?:about|of) me)(?=$|[^\p{L}\p{N}_])/iu,
    types: ['User', 'Belief'],
  },
  {
    pattern: /\b(trabajo|empleo|empresa|cliente|reunión|jefe|equipo|meeting)\b/i,
    types: ['User', 'Project'],
  },
];

const ALWAYS_SEARCH = new Set(['bug', 'api', 'db', 'git', 'ui', 'ux', 'ml', 'ia', 'ai']);

const MEMORY_QUERY_PATTERN =
  /(?:^|[^\p{L}\p{N}_])(recuerd\w*|acuerd\w*|qué sabes de m[ií]|que sabes de mi|quién soy|quien soy|cómo me llamo|como me llamo|ayer|semana pasada|mes pasado|última vez|ultima vez|hace \d+ d[ií]as?|mi (?:nombre|color|música|musica|comida|proyecto) favorito|remember|last time|what do you know about me)(?=$|[^\p{L}\p{N}_])/iu;

/** @param {string} message */
function isMemoryQuery(message) {
  return MEMORY_QUERY_PATTERN.test(String(message || ''));
}

const STOPWORDS = new Set([
  'para',
  'como',
  'que',
  'esto',
  'este',
  'esta',
  'una',
  'uno',
  'con',
  'por',
  'pero',
  'más',
  'muy',
  'bien',
  'todo',
  'algo',
  'hace',
  'cuando',
  'donde',
  'quiero',
  'puedo',
  'puedes',
  'tengo',
  'tienes',
  'estar',
  'tener',
  'hacer',
  'decir',
  'saber',
  'poder',
  'the',
  'and',
  'that',
  'this',
  'with',
  'from',
  'have',
  'what',
  'when',
  'then',
  'where',
  'there',
  'their',
  'about',
  'would',
  'could',
  'should',
  'been',
  'also',
  'hola',
  'oye',
  'hey',
  'bueno',
  'vale',
  'okay',
  'gracias',
  'porfa',
  'please',
]);

class RetrievalPlanner {
  /**
   * @param {object} stateGraph     — instancia de StateGraph (Fase 1)
   * @param {object} intentDetector — instancia de IntentDetector (Fase 3, opcional)
   *                                  Si no se pasa, la detección semántica se deshabilita
   *                                  y el sistema cae al flujo de Fase 2 sin romper nada.
   */
  constructor(stateGraph, intentDetector = null) {
    this._graph = stateGraph;
    this._detector = intentDetector;
  }

  // ── API pública ─────────────────────────────────────────────────────────────

  /**
   * Método principal para Fase 3.
   * Ejecuta en paralelo:
   *   - Recuperación de nodos del StateGraph (síncrono)
   *   - Detección semántica de intención de herramienta (async, embeddings)
   *
   * @param {string} userMessage
   * @param {object} osContext — { app, category, elapsed, title }
   * @returns {Promise<CombinedResult>}
   *
   * CombinedResult:
   * {
   *   // Del StateGraph (igual que Fase 2)
   *   nodes:        Array,
   *   episodeNodes: Array,
   *   strategy:     string,
   *   keywords:     Array,
   *   intents:      Array,
   *
   *   // Del IntentDetector (nuevo en Fase 3)
   *   toolIntent: {
   *     detected:    boolean,
   *     action:      string | null,
   *     tool:        string | null,
   *     confidence:  number,
   *     level:       'high' | 'medium' | 'none',
   *     description: string,
   *     elapsed:     number,
   *   }
   * }
   */
  async planWithIntent(userMessage = '', osContext = null) {
    // Ejecutar StateGraph (síncrono) e IntentDetector (async) en paralelo
    const [graphResult, intentResult] = await Promise.all([
      Promise.resolve(this.plan(userMessage, osContext)),
      this._detectToolIntent(userMessage),
    ]);

    return {
      ...graphResult,
      toolIntent: intentResult,
    };
  }

  /**
   * Método heredado de Fase 2 — ahora ASYNC (antes era síncrono).
   *
   * CAMBIO: el paso 3 (antes N búsquedas LIKE, una por keyword extraída)
   * ahora es una sola búsqueda semántica sobre el mensaje completo en
   * lenguaje natural — más preciso que trocear en keywords sueltas, y
   * pondera por recencia además de importance (ver
   * StateGraph.queryNodesSemantic). Si el recall vectorial no está listo,
   * cae sola a la búsqueda LIKE de siempre — no hay caso en que esto deje
   * de funcionar, solo deja de ser tan preciso.
   *
   * Se mantiene compatible con el único call site real (GroundingEngine.
   * buildContext(), que ya es async) — no quedó ningún llamador síncrono
   * de plan() en el resto del código.
   *
   * @param {string} userMessage
   * @param {object} osContext
   * @returns {Promise<object>} — { nodes, episodeNodes, strategy, keywords, intents }
   */
  async plan(userMessage = '', osContext = null) {
    if (!this._graph?.isReady) {
      return {
        nodes: [],
        episodeNodes: [],
        strategy: 'fallback',
        keywords: [],
        intents: [],
        memoryQuery: isMemoryQuery(userMessage),
        memoryMatchCount: 0,
        relevantMemoryIds: [],
      };
    }

    const nodeIds = new Set();
    const nodes = [];
    const episodeIds = new Set();
    const episodeNodes = [];
    const relevantMemoryIds = new Set();
    const memoryQuery = isMemoryQuery(userMessage);
    const temporalWindow = resolveTemporalWindow(userMessage, Date.now());

    const addEpisode = (episode) => {
      if (episode && !episodeIds.has(episode.id)) {
        episodeIds.add(episode.id);
        episodeNodes.push(episode);
      }
    };

    const addNode = (n) => {
      // F3.3: los nodos inferidos (modelo del usuario) NO entran al bucket de
      // hechos del retrieval — van solo a la sección de impresiones vía
      // ContextAssembler.getUserModel(). Evita que un rasgo inferido consuma
      // presupuesto del recall y se cuele al prompt como "hecho".
      if (n && n.inferred === 1) return;
      // Los episodios son recuerdos resumidos, no hechos del world model.
      // Mantenerlos en su bucket evita presentarlos como afirmaciones estables.
      if (n?.type === 'Episode') {
        addEpisode(n);
        return;
      }
      if (n && !nodeIds.has(n.id)) {
        nodeIds.add(n.id);
        nodes.push(n);
      }
    };
    const addAll = (arr) => arr?.forEach(addNode);

    // 1. Siempre incluir el "world model": conocimiento estable del usuario
    // (User/Project/Preference/Belief por importancia). Antes solo entraban
    // 5 nodos User — el resto de la foto estable del usuario (creencias,
    // preferencias, proyectos) quedaba fuera del contexto del chat.
    // Fase 3: passing context for contextual boosting
    const context = {
      // GroundingEngine ya toma un snapshot del sensor y lo entrega como
      // `osContext`. Mantener una segunda referencia al sensor dentro del
      // planner dejaba este boost permanentemente vacío.
      activeApp: osContext?.app || osContext?.friendlyName || null,
      windowTitle: osContext?.title || null,
      currentTopic: this._extractKeywords(userMessage).slice(0, 3).join(' ') || null,
    };
    addAll(this._graph.getWorldModel(context));

    // 2. Detectar intención semántica para StateGraph y traer nodos específicos
    const intents = this._detectGraphIntents(userMessage);
    for (const type of intents) {
      const intentNodes = this._graph.queryNodes({ type, limit: 3 });
      addAll(intentNodes);
      if (memoryQuery && !temporalWindow && type !== 'Episode') {
        for (const node of intentNodes) relevantMemoryIds.add(Number(node.id));
      }
    }

    // 3. Recall semántico sobre el mensaje completo (antes: LIKE por keyword)
    // Si el recall vectorial no está listo (modelo aún cargando, primer mensaje
    // tras arranque) o simplemente no encuentra nada, queryNodesSemantic cae a
    // un LIKE del mensaje completo que casi nunca coincide → devolvería vacío
    // y se perdería TODO el recall por keywords. Por eso: si el resultado
    // semántico queda vacío, se reintenta con las keywords extraídas (LIKE).
    const keywords = this._extractKeywords(userMessage);
    if (userMessage && userMessage.trim().length >= 4) {
      let semantic = [];
      try {
        semantic = await this._graph.queryNodesSemantic(userMessage, { limit: 8 });
      } catch (e) {
        logger.warn(
          'RetrievalPlanner',
          '[retrieval] error en recall semántico, cayendo a keywords:',
          e.message
        );
      }
      if (semantic.length > 0) {
        addAll(semantic);
        if (memoryQuery && !temporalWindow) {
          for (const node of semantic) {
            if (node._similarity == null || Number(node._similarity) >= 0.45) {
              relevantMemoryIds.add(Number(node.id));
            }
          }
        }
      } else if (keywords.length > 0) {
        for (const kw of keywords.slice(0, 5)) {
          const matches = this._graph.queryNodes({ search: kw, limit: 2 });
          addAll(matches);
          if (memoryQuery && !temporalWindow) {
            for (const node of matches) relevantMemoryIds.add(Number(node.id));
          }
        }
      }
    }

    // 4. OS context → priorizar proyectos si el usuario está en modo trabajo
    const workCategories = ['code', 'terminal', 'api', 'design', 'docs'];
    if (osContext && workCategories.includes(osContext.category)) {
      addAll(this._graph.queryNodes({ type: 'Project', limit: 4 }));
    }

    // 5. Preferencias en conversación corta/casual
    if (!intents.length && userMessage.length < 100) {
      addAll(this._graph.queryNodes({ type: 'Preference', limit: 2 }));
    }

    // 6. Continuidad autobiográfica: combina episodios encontrados por recall
    // semántico con una selección temporal/temática. Fallback compatible para
    // bases antiguas o modo degradado.
    const autobiographical = this._graph.recallAutobiographical?.({
      query: userMessage,
      now: Date.now(),
      limit: 3,
    });
    // Una ventana temporal explícita ("ayer", "semana pasada", fecha ISO)
    // domina sobre episodios semánticos fuera de ese intervalo.
    if (temporalWindow) {
      episodeIds.clear();
      episodeNodes.length = 0;
    }
    for (const episode of autobiographical || this._graph.getRecentEpisodes(3)) {
      addEpisode(episode);
      if (
        memoryQuery &&
        (episode.memory_context?.temporalWindow || Number(episode._topicMatches) > 0)
      ) {
        relevantMemoryIds.add(Number(episode.id));
      }
    }
    const episodes = episodeNodes
      .sort(
        (a, b) =>
          (b.memory_context?.score ?? b._semanticScore ?? b.importance ?? 0) -
          (a.memory_context?.score ?? a._semanticScore ?? a.importance ?? 0)
      )
      .slice(0, 3);

    // Ordenar por importancia y recortar
    const sortedNodes = nodes.sort((a, b) => b.importance - a.importance).slice(0, 12);

    const strategy =
      intents.length > 0
        ? `intent:${intents.join(',')}`
        : keywords.length > 0
          ? `semantic:${keywords.slice(0, 2).join(',')}`
          : 'default';

    logger.info(
      'RetrievalPlanner',
      `[retrieval] strategy=${strategy}` +
        ` nodes=${sortedNodes.length}` +
        ` episodes=${episodes.length}` +
        ` keywords=[${keywords.slice(0, 3).join(',')}]`
    );

    return {
      nodes: sortedNodes,
      episodeNodes: episodes,
      strategy,
      keywords,
      intents,
      memoryQuery,
      memoryMatchCount: relevantMemoryIds.size,
      relevantMemoryIds: [...relevantMemoryIds],
    };
  }

  // ── Helpers privados ────────────────────────────────────────────────────────

  /**
   * Detección semántica de intención de herramienta.
   * Wrapper sobre IntentDetector que maneja el caso en que el detector
   * no esté disponible (Fase 2 sin embeddings).
   */
  async _detectToolIntent(userMessage) {
    const _noDetector = {
      detected: false,
      action: null,
      tool: null,
      confidence: 0,
      level: 'none',
      description: 'IntentDetector no disponible (Fase 2)',
      elapsed: 0,
    };

    if (!this._detector) return _noDetector;

    try {
      return await this._detector.detect(userMessage);
    } catch (e) {
      logger.warn('RetrievalPlanner', '[retrieval] Error en IntentDetector:', e.message);
      return { ..._noDetector, description: `Error: ${e.message}` };
    }
  }

  /** Detección de intención para queries del StateGraph (regex, igual que Fase 2). */
  _detectGraphIntents(message) {
    const types = new Set();
    for (const { pattern, types: t } of INTENT_PATTERNS) {
      if (pattern.test(message)) t.forEach((type) => types.add(type));
    }
    return [...types];
  }

  _extractKeywords(message) {
    if (!message) return [];

    const words = message
      .toLowerCase()
      .replace(/[¿?¡!.,;:()"']/g, '')
      .split(/\s+/)
      .filter((w) => {
        if (ALWAYS_SEARCH.has(w)) return true;
        return w.length >= 3 && !STOPWORDS.has(w);
      });

    return [...new Set(words)].slice(0, 6);
  }
}

module.exports = { RetrievalPlanner, isMemoryQuery };
