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
 *     para que March pueda "aprender" cosas nuevas del usuario sin romper
 *     la reconciliación de los hechos fijos.
 *   - Cualquier otro label inventado por el LLM se descarta y se loggea.
 */

const LLMProvider              = require('../llm/LLMProvider.js');
const { ContradictionResolver } = require('./ContradictionResolver.js');

const EXTRACTION_SYSTEM = `Eres la memoria de March 7th. Analiza la conversación y extrae lo memorable.

LABELS PERMITIDOS (usa EXACTAMENTE estos):
- nombre_usuario → nombre del usuario
- edad_usuario → edad actual
- cumpleanos_usuario → fecha de cumpleaños  
- ubicacion_usuario → dónde vive
- trabajo_usuario → profesión o trabajo
- color_favorito → colores favoritos
- musica_favorita → música o artistas favoritos
- proyecto_principal → proyecto más importante activo
- observaciones_usuario → rasgos de carácter observados del usuario (NO de March)
Para proyectos secundarios: proyecto_[nombre] (ej: proyecto_march7th)
Para preferencias extra: preferencia_[tema] (ej: preferencia_anime)

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
  ]
}`;

// ── Validación de labels ──────────────────────────────────────────────────────
// Labels fijos: deben coincidir exacto para que el resolver pueda reconciliar
// (overwrite / archive_and_replace). Si el LLM inventa una variante de estos
// (ej. "edad_luka" en vez de "edad_usuario"), se descarta.
const FIXED_LABELS = new Set([
  'nombre_usuario', 'edad_usuario', 'cumpleanos_usuario', 'ubicacion_usuario',
  'trabajo_usuario', 'proyecto_principal', 'color_favorito', 'musica_favorita',
  'comida_favorita', 'observaciones_usuario',
]);
// Legacy: aceptar también el label antiguo
const LEGACY_LABELS = new Map([
  ['personalidad_observada', 'observaciones_usuario'], // migrar al nuevo nombre
]);

// Prefijos dinámicos permitidos: el LLM SÍ puede crear labels nuevos aquí,
// a propósito, para ir "aprendiendo" cosas del usuario sin tocar los hechos fijos.
const DYNAMIC_PREFIXES = ['proyecto_', 'preferencia_'];

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
  return COMMAND_PATTERNS.some(p => p.test(text.trim()));
}

function isValidLabel(label) {
  if (FIXED_LABELS.has(label)) return true;
  if (LEGACY_LABELS.has(label)) return true;
  return DYNAMIC_PREFIXES.some(prefix => label.startsWith(prefix));
}

function migrateLabel(label) {
  return LEGACY_LABELS.get(label) || label;
}

// Patrones de guardado inmediato — sin LLM
// (orden importa: el de "en realidad/ahora" va antes del genérico — si ambos
//  matchean el mismo mensaje, gana el más específico gracias al guard de abajo)
const INSTANT_PATTERNS = [
  {
    regex: /(?:me llamo|mi nombre es|my name is|i'?m called|call me)\s+([A-Za-záéíóúÁÉÍÓÚñÑ]{2,30})\b/i,
    node: (m) => ({ type: 'User', label: 'nombre_usuario', content: `El usuario se llama ${m[1]}`, importance: 0.95, tags: ['nombre'] }),
  },
  {
    regex: /(?:en realidad |ahora |ya )?tengo\s+(\d{1,3})\s+años|(?:actually |now )?i'?m\s+(\d{1,3})\s+(?:years old|years?\s*yo)/i,
    node: (m) => {
      const edad = m[1] || m[2];
      return { type: 'User', label: 'edad_usuario', content: `El usuario tiene ${edad} años`, importance: 0.85, tags: ['edad'] };
    },
  },
  {
    regex: /(?:(?:el\s+)?(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre).*cumplea[ñn]os|cumplea[ñn]os.*(?:el\s+)?(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)|(?:my )?birthday\s+(?:is\s+)?(?:on\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+of\s+(january|february|march|april|may|june|july|august|september|october|november|december))/i,
    node: (m) => {
      const dia = m[1] || m[3] || m[5]; const mes = m[2] || m[4] || m[6];
      const mesesEn = { january:'enero', february:'febrero', march:'marzo', april:'abril', may:'mayo', june:'junio', july:'julio', august:'agosto', september:'septiembre', october:'octubre', november:'noviembre', december:'diciembre' };
      const mesStr = mesesEn[mes?.toLowerCase()] || mes;
      return { type: 'User', label: 'cumpleanos_usuario', content: `Cumpleaños: ${dia} de ${mesStr}`, importance: 0.92, tags: ['cumpleaños'] };
    },
  },
  {
    // Patrón de corrección — va antes del genérico a propósito
    regex: /(?:en realidad|ahora|actually)\s+(?:mis?\s+colou?r(?:es)?\s+(?:favorito(?:s)?\s+)?(?:son|es|me gustan?|are|is)|(?:no\s+)?me\s+gusta(?:n)?\s+(?:el\s+|los\s+)?(?:azul|rojo|verde|amarillo|negro|blanco|morado|rosa|naranja|café|gris|blue|red|green|yellow|black|white|purple|pink|orange|brown|gray|grey))\s*(?:,?\s*(?:sino|si no|pero sí|y|but|and|actually)?\s*(?:son|es|are|is)?\s*)?(.{3,50})/i,
    node: (m) => ({ type: 'Preference', label: 'color_favorito', content: `Colores favoritos: ${m[1].trim()}`, importance: 0.88, tags: ['color'] }),
  },
  {
    regex: /(?:mi\s+)?(?:colou?r|favou?rite colou?r)(?:es)?\s+favo(u)?rito(?:s)?\s+(?:es|son|:|\s+is\s+|\s+are\s+)\s*(.{3,50})/i,
    node: (m) => ({ type: 'Preference', label: 'color_favorito', content: `Colores favoritos: ${m[2].trim()}`, importance: 0.75, tags: ['color'] }),
  },
  {
    regex: /(?:trabajo como|me dedico a|soy\s+(?:un\s+|una\s+)?(?:desarrollador|programador|diseñador|ingeniero|doctor|maestro|estudiante)|i work as|i'?m a\s+(?:developer|programmer|designer|engineer|doctor|teacher|student))/i,
    node: (m) => ({ type: 'User', label: 'trabajo_usuario', content: `Trabajo: ${m[0].trim()}`, importance: 0.8, tags: ['trabajo'] }),
  },
  {
    regex: /(?:estoy (?:desarrollando|construyendo|trabajando en|programando)|mi proyecto(?:\s+principal)? (?:es|se llama)|i'?m (?:developing|building|working on)|my (?:main\s+)?project (?:is|called))\s*(?:un\s+|una\s+|an?\s+)?(.{3,60})/i,
    node: (m) => {
      const proj = m[1] || m[2];
      return { type: 'Project', label: 'proyecto_principal', content: `Proyecto: ${proj.trim()}`, importance: 0.82, tags: ['proyecto'] };
    },
  },
  {
    regex: /(?:vivo en|soy de|i live in|i'?m from)\s+([A-Za-záéíóúÁÉÍÓÚñÑ\s,]{3,40})/i,
    node: (m) => ({ type: 'User', label: 'ubicacion_usuario', content: `Vive en: ${m[1].trim()}`, importance: 0.7, tags: ['ubicación'] }),
  },
  {
    regex: /(?:recuerda(?:lo|la)?|no olvides|remember|don'?t forget)\s+(?:que\s+|that\s+)?(.{5,100})/i,
    node: (m) => ({ type: 'Belief', label: `recordar_${Date.now()}`, content: `Pidió recordar: ${m[1].trim()}`, importance: 0.88, tags: ['recordar'] }),
  },
];

class StateUpdater {
  constructor(stateGraph) {
    this._graph    = stateGraph;
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
          console.log(`[state-updater] inmediato: ${nodeData.label}`);
        }
      } catch(e) {
        console.warn('[state-updater] error regex:', e.message);
      }
    }
    return saved;
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
   * usuario (sesión de solo March), se omite el LLM por completo.
   */
  async processSession(sessionId, history, turnCount) {
    if (!history || history.length < 2) {
      console.log('[state-updater] sesión muy corta');
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
    const userMessages = history.filter(t => t.role === 'user');
    if (userMessages.length === 0) {
      console.log('[state-updater] sin mensajes de usuario — omitiendo LLM');
      this._graph.endSession(sessionId, { turnCount, summary: null });
      return { saved: instantSaved, skipped: true };
    }

    console.log(`[state-updater] analizando sesión (${history.length} mensajes, ${instantSaved} instantáneos)...`);

    let extracted;
    try {
      extracted = await this._extractMemories(history);
    } catch(e) {
      console.error('[state-updater] error LLM:', e.message);
      this._graph.endSession(sessionId, { turnCount, summary: null });
      return { saved: instantSaved, error: e.message };
    }

    let saved = 0, discarded = 0;
    for (const node of (extracted.nodes || [])) {
      try {
        if (!node.type || !node.label || !node.content) continue;
        if (!['User','Episode','Belief','Preference','Project'].includes(node.type)) {
          discarded++;
          continue;
        }

        const label = node.label.toLowerCase().replace(/\s+/g, '_').slice(0, 80);

        if (!isValidLabel(label)) {
          console.warn(`[state-updater] label inválido descartado: ${label}`);
          discarded++;
          continue;
        }

        // Migrar labels legacy (ej. personalidad_observada → observaciones_usuario)
        const migratedLabel = migrateLabel(label);

        this._resolver.resolve({
          type:       node.type,
          label:      migratedLabel,
          content:    node.content,
          importance: Math.min(1.0, Math.max(0.1, node.importance ?? 0.6)),
          tags:       Array.isArray(node.tags) ? node.tags : [],
        });
        saved++;
      } catch(e) {
        console.warn('[state-updater] error guardando nodo:', e.message);
      }
    }

    let episodeId = null;
    if (extracted.episode_summary) {
      const dateStr = new Date().toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' });
      episodeId = this._graph.createNode({
        type: 'Episode', label: `sesion_${Date.now()}`,
        content: `[${dateStr}] ${extracted.episode_summary}`,
        importance: Math.min(1.0, Math.max(0.1, extracted.episode_importance ?? 0.5)),
        tags: ['sesion'],
      });
    }

    this._graph.endSession(sessionId, { turnCount, summary: extracted.episode_summary, episodeId });
    console.log(`[state-updater] guardados: ${saved} nodos, descartados: ${discarded}, episodio: ${episodeId ? 'sí' : 'no'}`);
    return { saved, discarded, episodeId };
  }

  async _extractMemories(history) {
    const recent = history.slice(-10);
    const conversation = recent.map(m =>
      `${m.role === 'user' ? 'Usuario' : 'March'}: ${m.content}`
    ).join('\n');

    // Para sesiones largas (> 20 turnos), usar smart mode para mejor
    // razonamiento sobre el contexto completo.
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
    if (!raw) return { episode_summary: null, episode_importance: 0, nodes: [] };
    try { return JSON.parse(raw.trim()); } catch(_) {}
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) { try { return JSON.parse(match[0]); } catch(_) {} }
    return { episode_summary: null, episode_importance: 0, nodes: [] };
  }

  runDecay() { this._graph.applyDecay(); }

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
    let archived = 0, cleaned = 0;

    try {
      // Obtener TODOS los nodos activos con label dinámico (proyecto_*, preferencia_*)
      // que son los más propensos a contaminarse con comandos
      const allNodes = this._graph._db.prepare(`
        SELECT id, label, content FROM nodes WHERE archived=0 AND (label LIKE 'proyecto_%' OR label LIKE 'preferencia_%')
      `).all();

      for (const node of allNodes) {
        if (!node.content) continue;

        // Si TODO el contenido es basura de comando, archivar el nodo entero
        const lines = node.content.split(/\s*\|\s*Actualizado:\s*/);
        const allAreCommands = lines.length > 0 && lines.every(l => _isCommandContent(l.trim()));
        if (allAreCommands) {
          console.log(`[state-updater] archivando nodo contaminado: ${node.label} — "${node.content.slice(0, 80)}"`);
          this._graph._archiveNode(node.id);
          archived++;
          continue;
        }

        // Si hay mezcla, filtrar solo los segmentos de comando
        const filtered = lines.filter(l => !_isCommandContent(l.trim()));
        if (filtered.length > 0 && filtered.length < lines.length) {
          const newContent = filtered.join(' | ');
          console.log(`[state-updater] limpiando nodo: ${node.label} — ${lines.length - filtered.length} segmento(s) de comando eliminados`);
          this._graph.updateNode(node.id, { content: newContent });
          cleaned++;
        }
      }
    } catch(e) {
      console.warn('[state-updater] error en cleanupMemoryArtifacts:', e.message);
    }

    return { archived, cleaned };
  }
}

module.exports = { StateUpdater, isValidLabel, migrateLabel, FIXED_LABELS, DYNAMIC_PREFIXES };
