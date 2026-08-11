// @ts-check
const logger = require('../observability/Logger.js');
/**
 * ContradictionResolver.js — adelantado de Fase 2
 *
 * Se encarga de reconciliar la memoria cuando llega información nueva
 * que contradice o actualiza un nodo existente.
 *
 * Estrategias:
 *   OVERWRITE  — el nuevo valor reemplaza al viejo (hechos concretos: edad, nombre)
 *   APPEND     — ambos valores coexisten (preferencias que evolucionan), con cap
 *   ARCHIVE    — el viejo se archiva, el nuevo es el activo
 *   TENSION    — se guarda la contradicción sin resolver (creencias complejas)
 *
 * El resolver corre en dos momentos:
 *   1. Al guardar un nodo nuevo (detecta si ya existe algo que contradice)
 *   2. Al inicio de sesión (limpia tensiones acumuladas)
 */

// ── Políticas por label ───────────────────────────────────────────────────────
// Define cómo manejar cada tipo de dato cuando llega info nueva.
/** @type {Record<string, 'overwrite' | 'archive_and_replace' | 'tension' | 'append'>} */
const RECONCILIATION_POLICY = {
  // Hechos únicos — siempre overwrite con el valor más reciente
  nombre_usuario: 'overwrite',
  edad_usuario: 'overwrite',
  cumpleanos_usuario: 'overwrite',
  ubicacion_usuario: 'overwrite',
  trabajo_usuario: 'overwrite',
  proyecto_principal: 'overwrite',

  // Estado del usuario (humor/energía) — efímero: el último gana, no acumula
  estado_usuario: 'overwrite',

  // Preferencias — pueden cambiar, archivar el viejo y activar el nuevo
  color_favorito: 'archive_and_replace',
  musica_favorita: 'archive_and_replace',
  comida_favorita: 'archive_and_replace',

  // Creencias / observaciones de carácter — el LLM suele "inventar" rasgos y
  // después contradecirlos. Guardar la tensión (ambos vivos + relación
  // CONTRADICES) permite que el motor proactivo pregunte en vez de sobreescribir
  // a ciegas un dato observado.
  observaciones_usuario: 'tension',

  // Todo lo demás — append por defecto (no destruir info)
  default: 'append',
};

// ── Detección de comandos técnicos ──────────────────────────────────────────
// Evita que outputs de comandos ejecutados se concatenen como "memoria" del
// proyecto. Si el contenido nuevo parece un comando/respuesta técnica, se
// descarta en vez de appendear — esos son artefactos transitorios del agente,
// no información que el usuario compartió.
const COMMAND_PATTERNS = [
  /^Ejecutar:\s/i,
  /^Voy a (leer|escribir|ejecutar)\s/i,
  /^(git|npm|node|ls|cd|cat|echo|mkdir|rm|cp|mv|docker|kubectl|pip|npx|yarn)\s/i,
  /^No (encontré|pude|se)\s/i,
  /^Lo siento/i,
  /^El comando no/i,
  /^Parece que no/i,
  /^\d+[smh] .*(?:comando|ejecutar)/i,
];

/**
 * @param {string} text
 * @returns {boolean}
 */
function _isCommandContent(text) {
  return COMMAND_PATTERNS.some((p) => p.test(text.trim()));
}

// ── Cap para la política append ───────────────────────────────────────────────
// Evita que un nodo (típicamente proyecto_*/preferencia_*) crezca sin límite
// a lo largo de meses de "Actualizado: X | Actualizado: Y | ...". Se conserva
// solo lo más reciente — esto NO afecta al mensaje del usuario ni al historial
// de sesión, solo a los nodos de memoria persistente.
const APPEND_SEPARATOR = ' | Actualizado: ';
const MAX_APPEND_SEGMENTS = 3;

// ── Tipos ────────────────────────────────────────────────────────────────────
/**
 * @typedef {object} NewNodeInfo
 * @property {string} type
 * @property {string} label
 * @property {string} content
 * @property {number} [importance]
 * @property {string[]} [tags]
 */

/**
 * @typedef {object} MemNode
 * @property {number|string} id
 * @property {string} [label]
 * @property {string} content
 * @property {number} importance
 */

/**
 * Superficie mínima de StateGraph que usa el resolver.
 * @typedef {object} StateGraphApi
 * @property {boolean} isReady
 * @property {(label: string) => MemNode | null | undefined} _findActiveNodeByLabel
 * @property {(label: string) => MemNode[]} _findNodesByLabel
 * @property {() => Record<string, string>[]} _findDuplicateLabels
 * @property {(opts: object) => number | string | null} createNode
 * @property {(id: number | string, opts: object) => unknown} updateNode
 * @property {(id: number | string) => void} _archiveNode
 * @property {(rel: object) => void} createRelation
 * @property {(opts: object) => number | string | null} upsertNode
 * @property {(label: string) => number} _invalidateCascade
 * @property {any} _db
 */

class ContradictionResolver {
  /**
   * @param {object} stateGraph
   */
  constructor(stateGraph) {
    this._graph = /** @type {StateGraphApi} */ (stateGraph);
  }

  /**
   * Punto de entrada principal.
   * Llama esto en lugar de graph.upsertNode() directamente.
   * Detecta si hay contradicción y aplica la política correcta.
   *
   * @param {NewNodeInfo} newNode - { type, label, content, importance, tags }
   * @returns {number | string | null} id del nodo resultante
   */
  resolve(newNode) {
    if (!this._graph?.isReady) return null;

    const { type, label, content, importance, tags = [] } = newNode;

    const existing = this._graph._findActiveNodeByLabel(label);

    // Si no existe, crear directamente
    if (!existing) {
      const id = this._graph.createNode({ type, label, content, importance, tags });
      logger.info('ContradictionResolver', `[resolver] creado nuevo nodo: ${label}`);
      return id;
    }

    // Si el contenido es idéntico, no hay nada que hacer — no se infla
    // importance artificialmente (eso antes creaba un efecto ratchet
    // que impedía que el decay funcionara). El touch de last_accessed_at
    // ya ocurrió cuando se leyó el nodo en el flujo de retrieval.
    if (existing.content === content) {
      return existing.id;
    }

    // Hay diferencia — aplicar política
    const policy = RECONCILIATION_POLICY[label] || RECONCILIATION_POLICY.default;
    return this._applyPolicy(policy, existing, newNode);
  }

  /**
   * @param {'overwrite' | 'archive_and_replace' | 'tension' | 'append'} policy
   * @param {MemNode} existing
   * @param {NewNodeInfo} newNode
   * @returns {number | string | null}
   */
  _applyPolicy(policy, existing, newNode) {
    const { label, content, importance = 0.7, tags = [], type } = newNode;

    switch (policy) {
      case 'overwrite': {
        // FIX: antes esto era SQL directo a la tabla — funcionaba para
        // actualizar el contenido, pero se saltaba updateNode() por
        // completo, y con eso el re-embedding automático para recall
        // semántico (ver StateGraph._scheduleNodeEmbedding). El nodo
        // quedaba con contenido nuevo pero el VECTOR seguía apuntando al
        // contenido viejo, indefinidamente — justo el caso más común
        // (alguien corrige su trabajo, su ciudad, etc.) quedaba invisible
        // para queryNodesSemantic() hasta la próxima vez que ese nodo
        // se tocara por otra vía.
        this._graph.updateNode(existing.id, {
          content: content,
          importance: Math.max(importance, existing.importance),
          // F3.1: un overwrite ES una reconfirmación del hecho — su vigencia
          // se refresca ahora, no al momento de la creación original.
          verified_at: Date.now(),
        });
        logger.info(
          'ContradictionResolver',
          `[resolver] overwrite: ${label} → "${content.slice(0, 60)}"`
        );
        // F3.1: si el label overwriteado tiene dependientes (CASCADE_STALENESS),
        // los relacionados quedan sin vigencia (verified_at=null) para que la
        // próxima pasada del FactReasoner los marque 'stale' y se revalidan.
        try {
          this._graph._invalidateCascade(label);
        } catch (e) {
          logger.warn(
            'ContradictionResolver',
            '[resolver] error en cascada de invalidación:',
            /** @type {Error} */ (e).message
          );
        }
        return existing.id;
      }

      case 'archive_and_replace': {
        this._graph._archiveNode(existing.id);
        const newId = this._graph.createNode({ type, label, content, importance, tags });
        logger.info(
          'ContradictionResolver',
          `[resolver] archive_and_replace: ${label} — viejo archivado, nuevo creado`
        );
        return newId;
      }

      case 'tension': {
        // No se destruye nada: el dato viejo y el nuevo conviven, y se registra
        // la contradicción como relación CONTRADICES para que otros módulos
        // (proactividad, planificador) puedan detectarla y preguntar.
        if (_isCommandContent(content)) return existing.id;
        const newId = this._graph.createNode({ type, label, content, importance, tags });
        this._graph.createRelation({ source: existing.id, target: newId, type: 'CONTRADICES' });
        logger.info(
          'ContradictionResolver',
          `[resolver] tension: ${label} — conviven "${existing.content.slice(0, 50)}" y "${content.slice(0, 50)}"`
        );
        return newId;
      }

      case 'append': {
        // Si el contenido nuevo parece un comando técnico, descartarlo —
        // esos son artefactos del agente, no memoria del usuario
        if (_isCommandContent(content)) {
          logger.info(
            'ContradictionResolver',
            `[resolver] append ignorado — contenido parece comando: "${content.slice(0, 60)}"`
          );
          return existing.id;
        }

        // Fusionar el contenido viejo y nuevo, pero con tope — se conservan
        // solo los últimos MAX_APPEND_SEGMENTS fragmentos, nunca crece infinito.
        // Mismo fix que 'overwrite' arriba — updateNode() en vez de SQL
        // directo, para que dispare el re-embedding del contenido fusionado.
        const segments = existing.content.split(APPEND_SEPARATOR);
        segments.push(content);
        const trimmed = segments.slice(-MAX_APPEND_SEGMENTS);
        const merged = trimmed.join(APPEND_SEPARATOR);

        this._graph.updateNode(existing.id, {
          content: merged,
          importance: Math.max(importance, existing.importance),
        });
        logger.info(
          'ContradictionResolver',
          `[resolver] append: ${label} (${trimmed.length}/${segments.length} fragmentos conservados)`
        );
        return existing.id;
      }

      default:
        return this._graph.upsertNode(newNode);
    }
  }

  /**
   * Limpia nodos duplicados del mismo label — si hay más de uno activo,
   * conserva el más reciente y archiva los viejos.
   * Los nodos en tensión (relación CONTRADICES) se EXCLUYEN: son contradicciones
   * a propósito que conviven hasta que alguien las resuelva.
   * Llamar al iniciar sesión.
   */
  deduplicateNodes() {
    if (!this._graph?.isReady) return;

    try {
      const duplicates = this._graph._findDuplicateLabels();

      // Labels cuyo par está en tensión → no tocar ninguno
      const tensionLabels = new Set();
      try {
        const rels = this._graph._db
          .prepare(
            "SELECT n1.label as a, n2.label as b FROM node_relations r JOIN nodes n1 ON n1.id=r.source_id JOIN nodes n2 ON n2.id=r.target_id WHERE r.type='CONTRADICES' AND n1.archived=0 AND n2.archived=0"
          )
          .all();
        for (const r of rels) {
          if (r.a === r.b) tensionLabels.add(r.a);
        }
      } catch (e) {
        logger.warn(
          'ContradictionResolver',
          '[resolver] error leyendo tensiones:',
          /** @type {Error} */ (e).message
        );
      }

      for (const { label } of duplicates) {
        if (tensionLabels.has(label)) {
          logger.info('ContradictionResolver', `[resolver] dedup omitido (en tensión): ${label}`);
          continue;
        }

        const nodes = this._graph._findNodesByLabel(label);

        const toArchive = nodes.slice(1);
        for (const { id } of toArchive) {
          this._graph._archiveNode(id);
        }

        if (toArchive.length > 0) {
          logger.info(
            'ContradictionResolver',
            `[resolver] dedup: ${label} — ${toArchive.length} nodo(s) duplicado(s) archivado(s)`
          );
        }
      }
    } catch (e) {
      logger.warn(
        'ContradictionResolver',
        '[resolver] error en dedup:',
        /** @type {Error} */ (e).message
      );
    }
  }

  /**
   * Contradicciones sin resolver: pares de nodos del mismo label activos con
   * relación CONTRADICES entre sí. El motor proactivo puede usarlas para
   * preguntar al usuario cuál es la versión correcta.
   * @returns {Array<{label:string, a:number, b:number, contentA:string, contentB:string}>}
   */
  getTensions() {
    if (!this._graph?.isReady) return [];
    try {
      return this._graph._db
        .prepare(
          `
        SELECT n1.label as label, n1.id as a, n2.id as b, n1.content as contentA, n2.content as contentB
        FROM node_relations r
        JOIN nodes n1 ON n1.id = r.source_id AND n1.archived = 0
        JOIN nodes n2 ON n2.id = r.target_id AND n2.archived = 0
        WHERE r.type = 'CONTRADICES'
      `
        )
        .all();
    } catch (e) {
      logger.warn(
        'ContradictionResolver',
        '[resolver] error en getTensions:',
        /** @type {Error} */ (e).message
      );
      return [];
    }
  }
}

module.exports = {
  ContradictionResolver,
  COMMAND_PATTERNS,
  MAX_APPEND_SEGMENTS,
  APPEND_SEPARATOR,
};
