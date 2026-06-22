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
  nombre_usuario:       'overwrite',
  edad_usuario:         'overwrite',
  cumpleanos_usuario:   'overwrite',
  ubicacion_usuario:    'overwrite',
  trabajo_usuario:      'overwrite',
  proyecto_principal:   'overwrite',

  // Preferencias — pueden cambiar, archivar el viejo y activar el nuevo
  color_favorito:       'archive_and_replace',
  musica_favorita:      'archive_and_replace',
  comida_favorita:      'archive_and_replace',

  // Todo lo demás — append por defecto (no destruir info)
  default:              'append',
};

// ── Cap para la política append ───────────────────────────────────────────────
// Evita que un nodo (típicamente proyecto_*/preferencia_*) crezca sin límite
// a lo largo de meses de "Actualizado: X | Actualizado: Y | ...". Se conserva
// solo lo más reciente — esto NO afecta al mensaje del usuario ni al historial
// de sesión, solo a los nodos de memoria persistente.
const APPEND_SEPARATOR     = ' | Actualizado: ';
const MAX_APPEND_SEGMENTS  = 3;

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
    if (!this._graph?._ready) return null;

    const { type, label, content, importance, tags = [] } = newNode;

    // Buscar nodo existente con el mismo label
    const existing = this._graph._db.prepare(
      'SELECT * FROM nodes WHERE label=? AND archived=0 ORDER BY importance DESC LIMIT 1'
    ).get(label);

    // Si no existe, crear directamente
    if (!existing) {
      const id = this._graph.createNode({ type, label, content, importance, tags });
      console.log(`[resolver] creado nuevo nodo: ${label}`);
      return id;
    }

    // Si el contenido es idéntico, solo reforzar importancia
    if (existing.content === content) {
      this._graph.updateNode(existing.id, { importance: Math.min(1.0, existing.importance + 0.1) });
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
        // Actualizar el nodo existente con el nuevo contenido
        this._graph._db.prepare(
          'UPDATE nodes SET content=?, importance=?, updated_at=?, last_accessed_at=? WHERE id=?'
        ).run(content, Math.max(importance, existing.importance), Date.now(), Date.now(), existing.id);
        console.log(`[resolver] overwrite: ${label} → "${content.slice(0, 60)}"`);
        return existing.id;
      }

      case 'archive_and_replace': {
        // Archivar el nodo viejo
        this._graph._db.prepare(
          'UPDATE nodes SET archived=1, updated_at=? WHERE id=?'
        ).run(Date.now(), existing.id);
        // Crear el nodo nuevo como activo
        const newId = this._graph.createNode({ type, label, content, importance, tags });
        console.log(`[resolver] archive_and_replace: ${label} — viejo archivado, nuevo creado`);
        return newId;
      }

      case 'append': {
        // Fusionar el contenido viejo y nuevo, pero con tope — se conservan
        // solo los últimos MAX_APPEND_SEGMENTS fragmentos, nunca crece infinito.
        const segments = existing.content.split(APPEND_SEPARATOR);
        segments.push(content);
        const trimmed = segments.slice(-MAX_APPEND_SEGMENTS);
        const merged  = trimmed.join(APPEND_SEPARATOR);

        this._graph._db.prepare(
          'UPDATE nodes SET content=?, importance=?, updated_at=?, last_accessed_at=? WHERE id=?'
        ).run(merged, Math.max(importance, existing.importance), Date.now(), Date.now(), existing.id);
        console.log(`[resolver] append: ${label} (${trimmed.length}/${segments.length} fragmentos conservados)`);
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
    if (!this._graph?._ready) return;

    try {
      // Encontrar labels con múltiples nodos activos
      const duplicates = this._graph._db.prepare(`
        SELECT label, COUNT(*) as cnt
        FROM nodes
        WHERE archived=0
        GROUP BY label
        HAVING cnt > 1
      `).all();

      for (const { label } of duplicates) {
        const nodes = this._graph._db.prepare(`
          SELECT id FROM nodes
          WHERE label=? AND archived=0
          ORDER BY updated_at DESC
        `).all(label);

        // Conservar el primero (más reciente), archivar el resto
        const toArchive = nodes.slice(1);
        for (const { id } of toArchive) {
          this._graph._db.prepare(
            'UPDATE nodes SET archived=1, updated_at=? WHERE id=?'
          ).run(Date.now(), id);
        }

        if (toArchive.length > 0) {
          console.log(`[resolver] dedup: ${label} — ${toArchive.length} nodo(s) duplicado(s) archivado(s)`);
        }
      }
    } catch(e) {
      console.warn('[resolver] error en dedup:', e.message);
    }
  }
}

module.exports = { ContradictionResolver, MAX_APPEND_SEGMENTS, APPEND_SEPARATOR };