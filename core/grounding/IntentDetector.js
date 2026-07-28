/**
 * IntentDetector.js — Fase 3 (Semántica de Herramientas)
 *
 * Módulo SEPARADO del RetrievalPlanner original (que maneja StateGraph).
 * Su única responsabilidad: detectar si el mensaje del usuario expresa
 * una intención de herramienta (edit_file, run_command, etc.) usando
 * embeddings locales + búsqueda coseno en sqlite-vec.
 *
 * Integración con el flujo existente:
 *   ContextAssembler.build() → llama a IntentDetector.detect()
 *   → resultado se inyecta en el Context Package
 *   → GroqSerializer lo incluye en el system prompt
 *   → LLM responde en formato estructurado
 *   → ActionParser (simplificado) extrae la acción
 *
 * NO reemplaza RetrievalPlanner.js — ese archivo sigue manejando
 * nodos del StateGraph exactamente igual que antes.
 *
 * Diseño de confianza:
 *   score >= THRESHOLD_HIGH   → alta confianza, inyectar con énfasis fuerte
 *   score >= THRESHOLD_LOW    → confianza media, inyectar como sugerencia
 *   score <  THRESHOLD_LOW    → sin intención de herramienta detectada
 *                               → flujo conversacional normal (answer_question)
 *
 * Las acciones answer_question y explain_code se tratan como
 * "intenciones de conversación" — no activan herramientas de OpenClaw.
 */

'use strict';

const path = require('path');

// ── Umbrales de confianza ─────────────────────────────────────────────────────
// Ajustados para all-MiniLM-L6-v2 con similitud coseno normalizada.
// Los scores de este modelo rara vez superan 0.95 en matches perfectos.
// 0.72 filtra la mayoría de preguntas conversacionales que accidentalmente
// comparten vocabulario con acciones de herramienta.
const THRESHOLD_HIGH = 0.78;
const THRESHOLD_LOW  = 0.62;

// Número de candidatos a recuperar de sqlite-vec antes de agregar por acción.
// Más candidatos = más preciso, pero más lento. 8 es el sweet spot para
// un catálogo de ~120 frases en el Athlon Silver.
const TOP_K = 8;

// Acciones que NO activan herramientas — solo flujo LLM normal.
const CONVERSATIONAL_ACTIONS = new Set(['answer_question', 'explain_code']);

// ── Singleton del embedder ────────────────────────────────────────────────────
// El modelo se carga UNA SOLA VEZ en toda la vida del proceso Electron.
// Primera carga: ~3-8s en el Athlon Silver (descarga el modelo si no está en caché).
// Cargas siguientes: <500ms (caché local en ~/.cache/huggingface).
let _embedder = null;
let _embedderPromise = null;

async function _getEmbedder() {
  if (_embedder) return _embedder;

  // Evitar race condition si se llaman dos detects() en paralelo
  // antes de que el modelo termine de cargar.
  if (_embedderPromise) return _embedderPromise;

  _embedderPromise = (async () => {
    const { pipeline } = await import('@xenova/transformers');
    console.log('[intent-detector] Cargando modelo all-MiniLM-L6-v2...');
    _embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      progress_callback: undefined, // silenciar en producción
    });
    console.log('[intent-detector] Modelo listo.');
    _embedderPromise = null;
    return _embedder;
  })();

  return _embedderPromise;
}

/**
 * Genera embedding para un texto.
 * Retorna Float32Array de 384 dimensiones (normalizado L2).
 */
async function _embed(text) {
  const embedder = await _getEmbedder();
  const output   = await embedder(text, { pooling: 'mean', normalize: true });
  return output.data; // Float32Array
}

function _float32ToBuffer(arr) {
  return Buffer.from(arr.buffer);
}

/**
 * Genera embedding para un texto — expuesto para reuso fuera de este
 * archivo (StateGraph.js lo usa para embeddings de nodos de memoria).
 * Comparte el mismo singleton de _getEmbedder(), así que NO carga el
 * modelo dos veces sin importar quién lo llame primero.
 * Retorna Float32Array de 384 dimensiones (normalizado L2).
 */
async function embedText(text) {
  return _embed(text);
}

function float32ToBuffer(arr) {
  return _float32ToBuffer(arr);
}

// ── IntentDetector ────────────────────────────────────────────────────────────

class IntentDetector {
  /**
   * @param {import('better-sqlite3').Database} db — instancia ya abierta de march.db
   */
  constructor(db) {
    this._db    = db;
    this._ready = false;
    this._cache = new Map(); // cache LRU simple para mensajes recientes

    this._init();
  }

  _init() {
    try {
      // Verificar que las tablas existen
      const row = this._db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='intent_catalog'")
        .get();

      if (!row) {
        console.warn('[intent-detector] Tablas de intenciones no encontradas.');
        console.warn('[intent-detector] Ejecuta: node infrastructure/database/init_vectors.js');
        this._ready = false;
        return;
      }

      const count = this._db
        .prepare('SELECT COUNT(*) as n FROM intent_catalog')
        .get().n;

      if (count === 0) {
        console.warn('[intent-detector] Catálogo vacío. Ejecuta init_vectors.js');
        this._ready = false;
        return;
      }

      // Preparar queries reutilizables
      this._queryVec = this._db.prepare(`
        SELECT
          iv.rowid,
          ic.action,
          ic.tool,
          ic.description,
          ic.phrase,
          distance
        FROM intent_vectors iv
        JOIN intent_catalog ic ON ic.id = iv.rowid
        WHERE embedding MATCH ?
          AND k = ?
        ORDER BY distance
      `);

      this._ready = true;
      console.log(`[intent-detector] Listo. ${count} frases en el catálogo.`);

    } catch (e) {
      console.warn('[intent-detector] Error al inicializar:', e.message);
      this._ready = false;
    }
  }

  /**
   * Detecta la intención de herramienta en el mensaje del usuario.
   *
   * @param {string} userMessage
   * @returns {Promise<IntentResult>}
   *
   * IntentResult:
   * {
   *   detected:    boolean          — si se detectó alguna intención
   *   action:      string | null    — 'edit_file', 'run_command', etc.
   *   tool:        string | null    — herramienta de OpenClaw correspondiente
   *   confidence:  number           — 0.0 - 1.0
   *   level:       'high'|'medium'|'none'
   *   description: string           — descripción humana de la intención
   *   candidates:  Array            — top candidatos (para debug)
   *   elapsed:     number           — ms que tardó la detección
   * }
   */
  async detect(userMessage) {
    const t0 = Date.now();

    const _none = (reason) => ({
      detected: false, action: null, tool: null,
      confidence: 0, level: 'none', description: reason,
      candidates: [], elapsed: Date.now() - t0,
    });

    if (!userMessage || userMessage.trim().length < 3) {
      return _none('Mensaje muy corto');
    }

    if (!this._ready) {
      return _none('IntentDetector no inicializado (faltan tablas o modelo)');
    }

    // Cache: mensajes idénticos no re-embedean
    const cacheKey = userMessage.trim().toLowerCase();
    if (this._cache.has(cacheKey)) {
      const cached = this._cache.get(cacheKey);
      return { ...cached, elapsed: Date.now() - t0, _cached: true };
    }

    // ── 1. Generar embedding del mensaje ──────────────────────────────────────
    let queryVector;
    try {
      queryVector = await _embed(userMessage);
    } catch (e) {
      console.warn('[intent-detector] Error generando embedding:', e.message);
      return _none(`Error al embedear: ${e.message}`);
    }

    // ── 2. Búsqueda por similitud coseno en sqlite-vec ─────────────────────
    // sqlite-vec devuelve "distance" que es 1 - cosine_similarity.
    // Para obtener el score de similitud: score = 1 - distance.
    let rows;
    try {
      rows = this._queryVec.all(
        _float32ToBuffer(queryVector),
        TOP_K
      );
    } catch (e) {
      console.warn('[intent-detector] Error en búsqueda vectorial:', e.message);
      return _none(`Error en búsqueda: ${e.message}`);
    }

    if (!rows || rows.length === 0) {
      return _none('Sin resultados en el catálogo');
    }

    // ── 3. Agregar scores por acción ──────────────────────────────────────────
    // En lugar de tomar solo el mejor resultado individual, agrupamos
    // todos los candidatos por acción y sumamos sus scores.
    // Esto significa que una acción con 3 frases similares al mensaje
    // vence a otra con solo 1 frase muy similar — más robusto.
    const actionScores = new Map();
    const actionMeta   = new Map();

    for (const row of rows) {
      const score = Math.max(0, 1 - (row.distance ?? 1)); // distance → similarity
      const prev  = actionScores.get(row.action) ?? 0;
      actionScores.set(row.action, prev + score);

      if (!actionMeta.has(row.action)) {
        actionMeta.set(row.action, {
          action:      row.action,
          tool:        row.tool,
          description: row.description,
          topPhrase:   row.phrase,
          topScore:    score,
        });
      }
    }

    // Normalizar: dividir por TOP_K para que el score máximo posible sea 1.0
    // (si todos los candidatos apuntan a la misma acción)
    const normalized = [];
    for (const [action, rawScore] of actionScores) {
      const meta = actionMeta.get(action);
      normalized.push({
        action,
        tool:        meta.tool,
        description: meta.description,
        topPhrase:   meta.topPhrase,
        score:       rawScore / TOP_K,
        rawScore,
      });
    }

    // Ordenar por score descendente
    normalized.sort((a, b) => b.score - a.score);

    const best = normalized[0];

    // ── 4. Aplicar umbrales ───────────────────────────────────────────────────
    let level;
    if (best.score >= THRESHOLD_HIGH) {
      level = 'high';
    } else if (best.score >= THRESHOLD_LOW) {
      level = 'medium';
    } else {
      level = 'none';
    }

    const detected = level !== 'none' && !CONVERSATIONAL_ACTIONS.has(best.action);

    const result = {
      detected,
      action:      detected ? best.action : null,
      tool:        detected ? best.tool : null,
      confidence:  parseFloat(best.score.toFixed(4)),
      level,
      description: best.description,
      candidates:  normalized.slice(0, 3), // top 3 para debug
      elapsed:     Date.now() - t0,
    };

    // Cache: guardar resultado (LRU simple: máx 50 entradas)
    if (this._cache.size >= 50) {
      const firstKey = this._cache.keys().next().value;
      this._cache.delete(firstKey);
    }
    this._cache.set(cacheKey, result);

    const logScore = (best.score * 100).toFixed(1);
    console.log(
      `[intent-detector] "${userMessage.slice(0, 40)}..." ` +
      `→ ${best.action} (${logScore}%, ${level}) en ${result.elapsed}ms`
    );

    return result;
  }

  /** Warm-up: pre-carga el modelo antes de que el usuario escriba. */
  async warmup() {
    try {
      await _embed('hola');
      console.log('[intent-detector] Modelo precalentado.');
    } catch (e) {
      console.warn('[intent-detector] Error en warmup:', e.message);
    }
  }

  /** Liberar recursos (llamar al cerrar la app). */
  dispose() {
    _embedder = null;
    _embedderPromise = null;
    this._cache.clear();
    this._ready = false;
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────
let _instance = null;

function getIntentDetector(db) {
  if (!_instance) {
    if (!db) throw new Error('[intent-detector] Se requiere instancia de DB para la primera creación');
    _instance = new IntentDetector(db);
  }
  return _instance;
}

module.exports = { IntentDetector, getIntentDetector, THRESHOLD_HIGH, THRESHOLD_LOW, embedText, float32ToBuffer };
