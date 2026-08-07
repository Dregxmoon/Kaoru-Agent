// @ts-nocheck
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
const RECONCILIATION_POLICY = {
  // Hechos únicos — siempre overwrite con el valor más reciente
  nombre_usuario: 'overwrite',
  edad_usuario: 'overwrite',
  cumpleanos_usuario: 'overwrite',
  ubicacion_usuario: 'overwrite',
  trabajo_usuario: 'overwrite',
  proyecto_principal: 'overwrite',

  // Preferencias — pueden cambiar, archivar el viejo y activar el nuevo
  color_favorito: 'archive_and_replace',
  musica_favorita: 'archive_and_replace',
  comida_favorita: 'archive_and_replace',

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

class ContradictionResolver {
  constructor(stateGraph) {
    this._graph = stateGraph;
  }

  /**
   * Punto de entrada principal.
   * Llama esto en lugar de graph.upsertNode() directamente.
   * Detecta si hay contradicción y aplica la política correcta.
   *
   * @param {object} newNode - { type, label, content, importance, tags }
   * @returns {number} id del nodo resultante
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
        });
        logger.info(
          'ContradictionResolver',
          `[resolver] overwrite: ${label} → "${content.slice(0, 60)}"`
        );
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
   * Llamar al iniciar sesión.
   */
  deduplicateNodes() {
    if (!this._graph?.isReady) return;

    try {
      const duplicates = this._graph._findDuplicateLabels();

      for (const { label } of duplicates) {
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
      logger.warn('ContradictionResolver', '[resolver] error en dedup:', e.message);
    }
  }
}

module.exports = { ContradictionResolver, MAX_APPEND_SEGMENTS, APPEND_SEPARATOR };
