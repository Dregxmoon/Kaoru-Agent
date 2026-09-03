// @ts-nocheck
const logger = require('../observability/Logger.js');
// misc.js — funciones varias del núcleo: callbacks del bus de iniciativa,
// canal del chat, memoria y getters expuestos a main.js / IPC.

const state = require('./state.js');

function onInitiative(cb) {
  state.onInitiative = cb;
}

function onProposalResult(cb) {
  state.onProposalResult = cb;
}

function setChatOpen(open) {
  state.proactive?.setChatOpen(open);
}

// Fase A: el usuario respondió a una propuesta (aceptar/descartar) desde el
// chat. Se reenvía al ProactiveEngine, que persiste el feedback y ajusta la
// frecuencia futura de ese tipo de iniciativa. Fase 3 ítem 2: tras cada
// decisión, el LearningEngine recalibra los pesos de scoring (cierra el
// círculo feedback→pesos→gate). Fire-and-forget: nunca rompe el flujo.
function handleProposalDecision(decision) {
  const ok = state.proactive?.handleDecision(decision) ?? false;
  if (ok && state.learning && typeof state.learning.calibrate === 'function') {
    try {
      state.learning.calibrate();
    } catch (e) {
      logger.warn('misc', '[learning] error recalibrando pesos:', e.message);
    }
  }
  return ok;
}

async function isOpenClawAvailable() {
  if (!state.bridge) return false;
  return state.bridge.isAvailable();
}

// Estado completo de OpenClaw para la UI: disponibilidad + aislamiento de
// proceso (bwrap). Fuerza un ping fresco para no servir un caché viejo.
async function getOpenClawStatus() {
  if (!state.bridge) {
    return { available: false, sandbox: null, sandboxReason: null };
  }
  const available = await state.bridge.isAvailable(true);
  const sandbox = state.bridge.getSandboxStatus();
  return {
    available,
    sandbox: sandbox ? sandbox.enabled : null,
    sandboxReason: sandbox ? sandbox.reason : null,
  };
}

// ── Fase C: compañero persistente ─────────────────────────────────────────────

/** /olvida X — archiva los nodos de memoria que matcheen el texto. */
function forgetMemory(text) {
  if (!state.graph) return { found: 0, archived: 0, error: 'grafo no inicializado' };
  return state.graph.forget(text);
}

/** Consulta explícita de la línea autobiográfica; no ejecuta acciones. */
function recallAutobiographical(opts = {}) {
  if (!state.graph?.isReady) return [];
  return state.graph.recallAutobiographical?.(opts) || [];
}

/** Al arrancar: ofrece retomar lo pendiente (recordatorios guardados). */
function pendingRecap() {
  return state.proactive?.pendingRecap() ?? Promise.resolve(null);
}

// ── Runtime del ProactiveEngine (comando /proactive) ───────────────────────

/** Stats en vivo del engine (getStats de testing.js). */
function getProactiveStats() {
  return state.proactive?.getStats() ?? null;
}

/** Cambia el modo de autonomía (observe | suggest | act) en runtime. */
function setAutonomyMode(mode) {
  if (!state.proactive) return { ok: false, error: 'engine no inicializado' };
  state.proactive.setAutonomyMode(mode);
  return { ok: true, mode: state.proactive.getAutonomyMode() };
}

/** Cambia el shadow mode (gate/audit corren, nada se envía) en runtime. */
function setShadowMode(on) {
  if (!state.proactive) return { ok: false, error: 'engine no inicializado' };
  state.proactive.setShadowMode(on);
  return { ok: true, shadowMode: state.proactive.getShadowMode() };
}

// ── Getters ───────────────────────────────────────────────────────────────────

function getGraph() {
  return state.graph;
}
function getOSSensor() {
  return state.osSensor;
}
function getEventBus_() {
  return state.bus;
}
function getPlanner_() {
  return state.planner;
}
function getBridge() {
  return state.bridge;
}
function listSkills() {
  if (!state.skillManager) return [];
  return state.skillManager.getAllSkills();
}

/**
 * Lista los nodos de memoria (Episode, Belief, Preference, Project, User)
 * que el asistente fue creando. Para la vista local de memoria del chat.
 * @param {{ type?: string, limit?: number }} [opts]
 */
function listNodes({ type, limit = 30 } = {}) {
  if (!state.graph || state.graph.usingFallback) return [];
  try {
    return state.graph.queryNodes({ type, limit }).map(_nodeView);
  } catch (e) {
    logger.warn('misc', '[core] error listando nodos:', e.message);
    return [];
  }
}

// Tags estructurales que no aportan a la vista de conexiones (los comparten
// casi todos los nodos de un tipo → grafos saturados).
const STRUCTURAL_TAGS = new Set([
  'sesion',
  'workspace',
  'auto-init',
  'contexto',
  'proyecto',
  'context-compaction',
]);

/**
 * Tag estructural = no sirve como "tema compartido" para derivar aristas.
 * Incluye la procedencia MEM-6 (visto:<fecha>): todos los nodos de identidad
 * la llevan, así que conectaba todo con todo.
 * @param {string} tag
 * @returns {boolean}
 */
function _isStructuralTag(tag) {
  return STRUCTURAL_TAGS.has(tag) || /^visto:\d{4}-\d{2}-\d{2}$/.test(String(tag));
}

// Contenido que no aporta a la "memoria" de Kaoru: placeholders que el
// extractor usa cuando no pudo sacar un dato real del usuario.
const PLACEHOLDER_RE =
  /(falta|no determinad|no especificad|none especificado|no revelad|no proporcion|no se proporcion|no se menciona|sin informacion|no disponible|no se sabe|se desconoce)/i;

// Contenido BOILERPLATE que describe capacidades genéricas del asistente (no
// al usuario): el extractor a veces guarda texto del LLM como si fuera un
// rasgo real ("PC del usuario", "Más de 100 idiomas...", "Información sobre
// temas específicos..."). Fingir que conocemos estos datos tapa gaps (p. ej.
// dónde vive) y ensucia la memoria visible.
const GENERIC_CONTENT_RE =
  /(pc del usuario|más de \d+ idiomas|temas específicos|visualizar información compleja|historias, poemas|gráficos y diagramas)/i;

// Separador con el que el resolver concatena actualizaciones de un mismo nodo
// ("A | Actualizado: B | Actualizado: C"). Ver ContradictionResolver.
const UPDATE_SEPARATOR = ' | Actualizado: ';

// Etiquetas que son leaks de plantilla del LLM ("proyecto_[nombre]"), no datos.
const TEMPLATE_LABEL_RE = /\[|\]/;

// Colores conocidos (ES + EN). Palabras estructurales que se ignoran al validar
// que el contenido de `color_favorito` sea realmente un color ("Colores
// favoritos: rojo" → "rojo").
const COLOR_IGNORE = new Set([
  'colores',
  'color',
  'favorito',
  'favoritos',
  'favourite',
  'me',
  'gusta',
  'gustan',
  'son',
  'es',
  'el',
  'la',
  'los',
  'las',
  'un',
  'una',
  'y',
  'o',
  'e',
  'con',
  'de',
  'claro',
  'oscuro',
  'brillante',
  'bajo',
  'alto',
]);
const KNOWN_COLORS = new Set([
  'azul',
  'rojo',
  'verde',
  'amarillo',
  'negro',
  'blanco',
  'morado',
  'violeta',
  'rosa',
  'rosado',
  'naranja',
  'cafe',
  'café',
  'gris',
  'celeste',
  'turquesa',
  'cian',
  'cyan',
  'magenta',
  'fucsia',
  'beige',
  'crema',
  'marfil',
  'lavanda',
  'esmeralda',
  'marron',
  'marrón',
  'vino',
  'bordo',
  'guinda',
  'oliva',
  'coral',
  'dorado',
  'plata',
  'plateado',
  'lila',
  'purpura',
  'púrpura',
  'indigo',
  'índigo',
  'aguamarina',
  'blue',
  'red',
  'green',
  'yellow',
  'black',
  'white',
  'purple',
  'pink',
  'orange',
  'brown',
  'gray',
  'grey',
  'teal',
  'gold',
  'silver',
  'tan',
  'navy',
  'lime',
  'olive',
  'maroon',
  'turquoise',
  'violet',
  'indigo',
  'lavender',
  'peach',
  'salmon',
]);

// ¿El contenido de un nodo color_favorito es realmente un color? Evita afirmar
// como "color favorito" algo que no lo es ("humor negro") y reabre el gap para
// preguntarlo de verdad.
function _looksLikeColor(content) {
  const tokens = String(content || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
  const meaningful = tokens.filter((t) => !COLOR_IGNORE.has(t));
  if (!meaningful.length) return false;
  return meaningful.every((t) => KNOWN_COLORS.has(t));
}

// ── Edad calculada desde cumpleaños (F3.1) ───────────────────────────────────
// El cumpleaños es permanente (nunca stale), así que es la MEJOR fuente de
// vigencia para la edad: si el usuario dio su fecha de nacimiento, la edad se
// calcula de ahí en vez de depender de que `edad_usuario` esté guardado y se
// actualice a mano. `edad_usuario` sigue existiendo como fallback.
const BIRTHDAY_MONTHS = [
  null,
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];
const BIRTHDAY_MONTHS_EN = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

/**
 * Extrae { day, month, year } de un contenido con fecha de nacimiento.
 * Soportes: "Cumpleaños: 15 de junio" (sin año → age no computable),
 * "15 de junio de 1995", "15/06/1995", "1995-06-15", "June 15, 1995".
 * @param {string} content
 * @returns {{ day: number, month: number, year: number | null } | null}
 */
function _parseBirthday(content) {
  const s = String(content || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  if (!s) return null;

  // "15 de junio [de 1995]"
  const m1 = s.match(
    /(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)(\s+de\s+(\d{1,4}))?/
  );
  if (m1) {
    const month = BIRTHDAY_MONTHS.indexOf(m1[2]);
    return { day: Number(m1[1]), month, year: m1[4] ? Number(m1[4]) : null };
  }

  // "15/06/1995" | "1995-06-15"
  const m2 = s.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (m2) return { day: Number(m2[1]), month: Number(m2[2]), year: Number(m2[3]) };

  const m3 = s.match(/(\d{2,4})-(\d{1,2})-(\d{1,2})/);
  if (m3) return { year: Number(m3[1]), month: Number(m3[2]), day: Number(m3[3]) };

  // "June 15, 1995"
  const m4 = s.match(
    /(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s+(\d{2,4})/
  );
  if (m4) return { day: Number(m4[2]), month: BIRTHDAY_MONTHS_EN[m4[1]], year: Number(m4[3]) };

  return null;
}

/**
 * Edad calculada a partir del cumpleaños del usuario. Devuelve `null` si no
 * hay un cumpleaños con AÑO en memoria (sin año no se puede calcular una edad),
 * si no hay grafo o si el grafo está en modo fallback. Cuando el cumpleaños
 * tiene año, el cálculo gana sobre `edad_usuario` guardado a mano.
 * @param {object} [graph] Grafo a consultar (por defecto el compartido en `state`).
 * @returns {number | null}
 */
function getComputedAge(graph = state.graph) {
  if (!graph || graph.usingFallback) return null;
  try {
    const bday =
      typeof graph._findActiveNodeByLabel === 'function'
        ? graph._findActiveNodeByLabel('cumpleanos_usuario')
        : null;
    if (!bday) return null;
    const parsed = _parseBirthday(bday.content);
    if (!parsed || !parsed.year) return null;

    const now = new Date();
    let age = now.getFullYear() - parsed.year;
    const thisYear = new Date(now.getFullYear(), parsed.month - 1, parsed.day);
    if (now < thisYear) age--;
    return age;
  } catch (e) {
    logger.warn('misc', '[core] error calculando edad desde cumpleaños:', e.message);
    return null;
  }
}

// Tipos que forman la identidad/memoria real del usuario (excluye Episode:
// sesiones y compactaciones son ruido para la vista).
const IDENTITY_TYPES = ['User', 'Project', 'Preference', 'Belief'];

// Palabras sin poder de conexión (genéricas o del dominio del asistente).
const TERM_STOPWORDS = new Set([
  'usuario',
  'proyecto',
  'asistente',
  'actualizado',
  'informacion',
  'información',
  'descripcion',
  'descripción',
  'nombre',
  'version',
  'activo',
  'personal',
  'sistema',
  'modulo',
  'módulo',
  'más',
  'mas',
  'para',
  'con',
  'sobre',
  'como',
  'esta',
  'este',
  'esto',
  'tiene',
  'tener',
  'puede',
  'ser',
  'hacer',
  'etc',
  'del',
  'los',
  'las',
  'una',
  'unos',
  'unas',
  'que',
  'por',
  'misma',
  'mismo',
  'nuevo',
  'nueva',
  'bien',
  // Paths de workspaces ("Proyecto activo: /home/panfilo/Projects/X"): conectar
  // todo por el mismo prefijo de disco no aporta.
  'home',
  'panfilo',
  'projects',
  'proyectos',
  'opencode',
]);

// Términos significativos del contenido de un nodo, listos para comparar.
function _contentTerms(content) {
  return String(content || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4 && !TERM_STOPWORDS.has(t));
}

// ¿Dos términos se consideran "el mismo tema"? Coincidencia exacta, o uno es
// prefijo del otro (java ↔ javascript, script ↔ javascript). Requiere longitud
// mínima para no conectar por trivialidades.
function _sameTheme(a, b) {
  if (a === b) return true;
  const minLen = 4;
  if (a.length >= minLen && b.length >= minLen) {
    return a.startsWith(b) || b.startsWith(a);
  }
  return false;
}

// Ventana temporal (ms) para considerar que dos nodos nacieron en la misma
// conversación (la extracción de memoria corre al final de cada sesión).
const SAME_SESSION_WINDOW_MS = 60 * 60 * 1000;

/** @param {any} n */
function _nodeView(n) {
  let tags = [];
  try {
    tags = JSON.parse(n.tags || '[]');
  } catch {}
  return {
    id: n.id,
    type: n.type,
    label: n.label,
    content: String(n.content || '').slice(0, 200),
    importance: n.importance,
    tags: Array.isArray(tags) ? tags : [],
    createdAt: n.created_at,
    updatedAt: n.updated_at,
    lastAccessedAt: n.last_accessed_at,
    archived: n.archived,
  };
}

// Workspaces auto-init ("Proyecto: X" con tags workspace/auto-init) son
// ruido del scanner, no memoria del usuario.
function _isAutoInitWorkspace(n) {
  const tags = n.tags || [];
  return tags.includes('workspace') && tags.includes('auto-init');
}

// Preferencias que describen las capacidades del asistente, no al usuario.
function _isSystemPreference(n) {
  return n.type === 'Preference' && /preferencia_(internet|idioma|genero)/i.test(n.label);
}

/**
 * ¿Este nodo forma parte de la memoria real de Kaoru sobre el usuario?
 * Excluye episodios/compactaciones, workspaces auto-init, placeholders y
 * preferencias del sistema.
 * @param {ReturnType<typeof _nodeView>} n
 */
function _isRealIdentity(n) {
  if (!IDENTITY_TYPES.includes(n.type)) return false;
  if (_isAutoInitWorkspace(n)) return false;
  if (_isSystemPreference(n)) return false;
  const content = String(n.content || '').trim();
  if (!content) return false;
  // Labels que son leaks de plantilla del LLM ("proyecto_[nombre]") → ruido.
  if (TEMPLATE_LABEL_RE.test(n.label)) return false;
  // El resolver concatena actualizaciones ("A | Actualizado: B"). Un nodo es
  // placeholder SOLO si TODOS los segmentos lo son: así un dato real que luego
  // recibió un "Actualizado: No revelada" no se pierde (p. ej. preferencia_anime).
  const segments = content.split(UPDATE_SEPARATOR);
  const allPlaceholder = segments.every(
    (s) => PLACEHOLDER_RE.test(s) || GENERIC_CONTENT_RE.test(s)
  );
  if (allPlaceholder) return false;
  // Un "color favorito" que no es un color (ej. "humor negro") no es dato real:
  // mejor que Kaoru lo pregunte de verdad a afirmar algo incoherente.
  if (n.label === 'color_favorito' && !_looksLikeColor(content)) return false;
  return true;
}

/**
 * Variante de `_isRealIdentity` que acepta filas CRUDAS del grafo (queryNodes/
 * getWorldModel), cuyo `tags` puede ser un JSON string. La usa el motor
 * proactivo para filtrar memoria real antes de compararla con la pantalla.
 * @param {any} n
 */
function isRealIdentityNode(n) {
  let view = n;
  try {
    view = _nodeView(n);
  } catch (_) {
    view = { ...n, tags: [] };
  }
  return _isRealIdentity(view);
}

/**
 * Términos significativos de un texto libre (título de una ventana, canción,
 * video...): mismos criterios que el contenido de memoria (longitud + stopwords),
 * listos para comparar contra la memoria de gustos.
 * @param {string} text
 */
function extractThemeTerms(text) {
  return _contentTerms(text);
}

// Rasgos que Kaoru querría conocer del usuario. Cada entrada: label que debe
// existir (regex sobre el label del nodo) + cómo lo diría en el prompt.
const KNOWLEDGE_GAPS = [
  { re: /^nombre_usuario$/i, ask: 'su nombre' },
  { re: /^edad_usuario$/i, ask: 'su edad' },
  { re: /^ubicacion_usuario$|^preferencia_ubicacion$/i, ask: 'dónde vive' },
  { re: /^trabajo_usuario$/i, ask: 'a qué se dedica' },
  { re: /^musica_favorita$/i, ask: 'qué música le gusta' },
  { re: /^preferencia_anime$|^anime_favorito$/i, ask: 'si le gusta el anime y cuál' },
  { re: /^color_favorito$/i, ask: 'su color favorito' },
  { re: /^comida_favorita$/i, ask: 'su comida favorita' },
  { re: /^preferencia_(hobbie|hobby|pasatiempo)$/i, ask: 'qué le gusta hacer en su tiempo libre' },
  { re: /^preferencia_lenguaje$/i, ask: 'su lenguaje de programación favorito' },
  { re: /^preferencia_tonos$/i, ask: 'el tono que prefiere en la conversación' },
];

/**
 * Gaps de conocimiento: rasgos del usuario que Kaoru todavía no sabe (no hay
 * nodo de memoria con contenido REAL que los cubra; un nodo con placeholder
 * "falta"/"No determinado" NO cuenta como conocido). El motor proactivo puede
 * usarlos para preguntar con curiosidad genuina y armar una mejor percepción
 * del usuario.
 * @returns {Array<{ trait: string }>}
 */
function getMemoryGaps() {
  if (!state.graph || state.graph.usingFallback) return [];
  try {
    const nodes = state.graph.queryNodes({ limit: 500 }).map(_nodeView);
    const known = new Set();
    for (const n of nodes) {
      if (!_isRealIdentity(n)) continue;
      for (const g of KNOWLEDGE_GAPS) if (g.re.test(n.label)) known.add(g);
    }
    const gaps = KNOWLEDGE_GAPS.filter((g) => !known.has(g)).map((g) => ({ trait: g.ask }));

    // F3.1: los hechos fijos de larga duración marcados 'stale' por el
    // FactReasonerStore son gaps de BAJA prioridad — no es que no sepamos el
    // dato, es que hay que revalidarlo (el valor puede haber caducado). Se
    // agregan después de los unknown, sin duplicar el mismo trait.
    const staleSeen = new Set();
    for (const n of nodes) {
      if (!Array.isArray(n.tags) || !n.tags.includes('stale')) continue;
      if (!STALE_ASK[n.label] || staleSeen.has(n.label)) continue;
      staleSeen.add(n.label);
      gaps.push({ trait: STALE_ASK[n.label] });
    }

    return gaps;
  } catch (e) {
    logger.warn('misc', '[core] error calculando gaps de memoria:', e.message);
    return [];
  }
}

// F3.1: cómo se pregunta/revalida un hecho fijo que marcó 'stale'. Solo los
// labels con vigencia (los de STALENESS_DAYS) entran — los permanentes
// (nombre, cumpleaños, gustos) nunca preguntan cómo "reconfirmar".
const STALE_ASK = {
  trabajo_usuario: 'si sigue trabajando en lo mismo',
  proyecto_principal: 'si su proyecto principal sigue siendo el mismo',
  ubicacion_usuario: 'si sigue viviendo en el mismo lugar',
};

/**
 * Grafo de memoria: nodos + aristas. Deriva conexiones implícitas entre nodos:
 *  - relaciones reales registradas en node_relations (ej. CONSOLIDA)
 *  - misma conversación: nodos creados en la misma ventana temporal
 *  - tags compartidos no estructurales
 *
 * Solo muestra la "memoria real" del asistente: nodos de identidad
 * (User/Project/Preference/Belief) con contenido real. Se descarta el ruido:
 * episodios/compactaciones, workspaces auto-init, preferencias genéricas del
 * LLM y placeholders ("falta", "No determinado", etc.).
 * @param {{ limit?: number }} [opts]
 */
function listNodeGraph({ limit = 120 } = {}) {
  if (!state.graph || state.graph.usingFallback) return { nodes: [], edges: [] };
  try {
    const nodes = state.graph.queryNodes({ limit }).map(_nodeView).filter(_isRealIdentity);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const edges = new Map();

    const addEdge = (source, target, type) => {
      if (!byId.has(source) || !byId.has(target) || source === target) return;
      const key = source < target ? `${source}:${target}` : `${target}:${source}`;
      if (!edges.has(key)) edges.set(key, { source, target, type });
    };

    // 1) Relaciones reales de node_relations (las más específicas)
    try {
      const rels = state.graph._db
        .prepare('SELECT source_id, target_id, type FROM node_relations')
        .all();
      for (const r of rels)
        addEdge(r.source_id, r.target_id, String(r.type || 'relacion').toLowerCase());
    } catch {
      /* tabla ausente en DBs viejas — se ignora */
    }

    // 2) Términos compartidos del contenido (tema): nodos del mismo dominio
    // quedan conectados aunque no compartan tags ni se extrajeran en la misma
    // sesión (ej. proyecto_calculadora "Java" ↔ preferencia_lenguaje "Java").
    // Solo términos con poder discriminatorio (frecuencia de documento ≤ 30%)
    // conectan; los genéricos ("proyecto", "usuario") no ligan nada.
    const termsByNode = new Map(nodes.map((n) => [n.id, new Set(_contentTerms(n.content))]));
    const docFreq = new Map();
    for (const terms of termsByNode.values()) {
      for (const t of terms) docFreq.set(t, (docFreq.get(t) || 0) + 1);
    }
    const maxDocFreq = Math.max(1, Math.ceil(nodes.length * 0.3));
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        if (
          edges.has(
            nodes[i].id < nodes[j].id
              ? `${nodes[i].id}:${nodes[j].id}`
              : `${nodes[j].id}:${nodes[i].id}`
          )
        )
          continue;
        const termsA = termsByNode.get(nodes[i].id);
        const termsB = termsByNode.get(nodes[j].id);
        // Comparte tema si hay un par de términos "afines" y ninguno es
        // demasiado común (de lo contrario todo quedaría conectado).
        let shared = false;
        for (const tA of termsA) {
          const df = docFreq.get(tA) || 0;
          if (df > maxDocFreq) continue;
          for (const tB of termsB) {
            if (_sameTheme(tA, tB)) {
              shared = true;
              break;
            }
          }
          if (shared) break;
        }
        if (shared) addEdge(nodes[i].id, nodes[j].id, 'tema');
      }
    }

    // 3) Tags compartidos no estructurales (temas en común)
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const shared = (nodes[i].tags || []).filter(
          (t) => nodes[j].tags.includes(t) && !_isStructuralTag(t)
        );
        if (shared.length) addEdge(nodes[i].id, nodes[j].id, 'tema');
      }
    }

    // 4) Misma conversación: ventana temporal (agrupa la extracción de una
    // sesión y sus compactaciones). Dos compactaciones seguidas casi siempre
    // son sesiones distintas → no se enlazan entre sí.
    const sorted = nodes.filter((n) => n.createdAt).sort((a, b) => a.createdAt - b.createdAt);
    const isCompaction = (n) => (n.tags || []).includes('context-compaction');
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        if (sorted[j].createdAt - sorted[i].createdAt > SAME_SESSION_WINDOW_MS) break;
        if (isCompaction(sorted[i]) && isCompaction(sorted[j])) continue;
        addEdge(sorted[i].id, sorted[j].id, 'conversacion');
      }
    }

    return { nodes, edges: Array.from(edges.values()) };
  } catch (e) {
    logger.warn('misc', '[core] error construyendo grafo de memoria:', e.message);
    return { nodes: [], edges: [] };
  }
}

function storeFact({ type, label, content, importance = 0.85, tags = [] }) {
  if (!state.graph?.isReady) return null;
  try {
    return state.graph.createNode({ type, label, content, importance, tags });
  } catch (e) {
    logger.warn('misc', '[core] error guardando hecho:', e.message);
    return null;
  }
}

module.exports = {
  onInitiative,
  onProposalResult,
  setChatOpen,
  handleProposalDecision,
  isOpenClawAvailable,
  getOpenClawStatus,
  forgetMemory,
  recallAutobiographical,
  pendingRecap,
  getProactiveStats,
  setAutonomyMode,
  setShadowMode,
  getGraph,
  getOSSensor,
  getEventBus: getEventBus_,
  getPlanner: getPlanner_,
  getBridge,
  listSkills,
  listNodes,
  listNodeGraph,
  getMemoryGaps,
  getComputedAge,
  storeFact,
  isRealIdentityNode,
  extractThemeTerms,
};
