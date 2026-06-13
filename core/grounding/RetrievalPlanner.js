/**
 * RetrievalPlanner.js — Fase 2 (mejorado)
 *
 * Decide qué nodos del StateGraph son relevantes para el mensaje actual
 * ANTES de construir el context package.
 *
 * Mejoras respecto a la versión anterior:
 *   - Regex de código corregido (tenía "función" duplicado)
 *   - Keywords mínimas: 3 chars para el vocabulario general +
 *     set ALWAYS_SEARCH para términos técnicos cortos (bug, api, db, git...)
 *   - Boost por recencia en episodios (los más recientes suben al top)
 *   - Límite de nodos aumentado a 12
 *   - Nuevo intent: "estado/emoción" para preguntas personales
 *   - OS category "design" y "docs" también priorizan proyectos
 */

const INTENT_PATTERNS = [
  { pattern: /\b(proyecto|project|trabajando en|working on|construyendo|building)\b/i,  types: ['Project'] },
  { pattern: /\b(recuerdas|recuerda|dijiste|mencionaste|remember|acordar)\b/i,          types: ['Episode', 'Belief'] },
  { pattern: /\b(preferencia|gusta|favorito|like|prefer|odio|hate|detesto)\b/i,        types: ['Preference'] },
  { pattern: /\b(quién soy|mi nombre|cómo me llamo|who am i|me llamo)\b/i,             types: ['User'] },
  { pattern: /\b(código|programar|bug|error|función|debug|script|repo|git)\b/i,        types: ['Project', 'Belief'] },
  { pattern: /\b(ayer|antes|última vez|last time|semana pasada|hace días|dijiste)\b/i, types: ['Episode'] },
  { pattern: /\b(cómo estoy|cómo me ves|qué piensas de mí|qué sabes de mí)\b/i,      types: ['User', 'Belief'] },
  { pattern: /\b(trabajo|empleo|empresa|cliente|reunión|jefe|equipo|meeting)\b/i,      types: ['User', 'Project'] },
];

// Términos técnicos cortos que siempre se buscan en el grafo
const ALWAYS_SEARCH = new Set(['bug', 'api', 'db', 'git', 'ui', 'ux', 'ml', 'ia', 'ai']);

const STOPWORDS = new Set([
  'para', 'como', 'que', 'esto', 'este', 'esta', 'una', 'uno', 'con', 'por', 'pero',
  'más', 'muy', 'bien', 'todo', 'algo', 'hace', 'cuando', 'donde', 'quiero', 'puedo',
  'puedes', 'tengo', 'tienes', 'estar', 'tener', 'hacer', 'decir', 'saber', 'poder',
  'the', 'and', 'that', 'this', 'with', 'from', 'have', 'what', 'when', 'then',
  'where', 'there', 'their', 'about', 'would', 'could', 'should', 'been', 'also',
  'hola', 'oye', 'hey', 'bueno', 'vale', 'okay', 'gracias', 'porfa', 'please',
]);

class RetrievalPlanner {
  constructor(stateGraph) {
    this._graph = stateGraph;
  }

  /**
   * Punto de entrada principal.
   *
   * @param {string} userMessage
   * @param {object} osContext — { app, category, elapsed, title, openWindows }
   * @returns {{ nodes: Array, episodeNodes: Array, strategy: string, keywords: Array, intents: Array }}
   */
  plan(userMessage = '', osContext = null) {
    if (!this._graph?._ready) {
      return { nodes: [], episodeNodes: [], strategy: 'fallback', keywords: [], intents: [] };
    }

    const nodeIds = new Set();
    const nodes   = [];

    const addNode = (n) => {
      if (n && !nodeIds.has(n.id)) { nodeIds.add(n.id); nodes.push(n); }
    };
    const addAll = (arr) => arr?.forEach(addNode);

    // 1. Siempre incluir nodos User de alta importancia
    addAll(this._graph.queryNodes({ type: 'User', limit: 5 }));

    // 2. Detectar intención y traer nodos específicos
    const intents = this._detectIntents(userMessage);
    for (const type of intents) {
      addAll(this._graph.queryNodes({ type, limit: 3 }));
    }

    // 3. Búsqueda por keywords extraídas del mensaje
    const keywords = this._extractKeywords(userMessage);
    for (const kw of keywords.slice(0, 5)) {
      addAll(this._graph.queryNodes({ search: kw, limit: 2 }));
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

    // 6. Episodios recientes — getRecentEpisodes ordena por importance DESC, created_at DESC
    const episodes = this._graph.getRecentEpisodes(6);

    // Ordenar nodos finales por importancia y recortar
    const sortedNodes = nodes
      .sort((a, b) => b.importance - a.importance)
      .slice(0, 12);

    const strategy = intents.length > 0
      ? `intent:${intents.join(',')}`
      : keywords.length > 0
        ? `keywords:${keywords.slice(0, 2).join(',')}`
        : 'default';

    console.log(`[retrieval] strategy=${strategy} nodes=${sortedNodes.length} episodes=${episodes.length} keywords=[${keywords.slice(0, 3).join(',')}]`);

    return {
      nodes:        sortedNodes,
      episodeNodes: episodes,
      strategy,
      keywords,
      intents,
    };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  _detectIntents(message) {
    const types = new Set();
    for (const { pattern, types: t } of INTENT_PATTERNS) {
      if (pattern.test(message)) t.forEach(type => types.add(type));
    }
    return [...types];
  }

  _extractKeywords(message) {
    if (!message) return [];

    const words = message
      .toLowerCase()
      .replace(/[¿?¡!.,;:()"']/g, '')
      .split(/\s+/)
      .filter(w => {
        if (ALWAYS_SEARCH.has(w)) return true;  // términos técnicos cortos: siempre
        return w.length >= 3 && !STOPWORDS.has(w);
      });

    return [...new Set(words)].slice(0, 6);
  }
}

module.exports = { RetrievalPlanner };