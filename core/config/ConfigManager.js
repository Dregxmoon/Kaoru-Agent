// @ts-check
'use strict';
const logger = require('../observability/Logger.js');

/**
 * ConfigManager — carga/valida/cachea config.json con schema tipado.
 *
 * Motivo: antes la config se leía con JSON.parse crudo en main.js; un archivo
 * corrupto, un tipo equivocado o una clave desconocida pasaban desapercibidos
 * (o rompían al arrancar). Este módulo centraliza:
 *   1. Schema conocido (claves top-level + secciones anidadas).
 *   2. Defaults aplicados cuando falta una clave.
 *   3. Validación de tipos con reporte (errors + warnings), sin mutar el
 *      archivo del usuario salvo que se llame a save().
 *   4. Cache con invalidación (reload()).
 *
 * Notas de diseño:
 *   - Claves top-level desconocidas se CONSERVAN (compatibilidad hacia
 *     delante: configs escritas por versiones futuras no se destruyen), pero
 *     se registran como warning.
 *   - Una clave conocida con tipo inválido se corrige al default y se
 *     registra error en el report.
 *   - load() devuelve un clon profundo: mutaciones del llamador (p.ej.
 *     loadEffectiveConfig inyectando keys de entorno/llavero) no envenenan el
 *     cache.
 */

const fs = require('fs');

const AUTONOMY_MODES = ['observe', 'suggest', 'act'];

/**
 * Clon profundo de datos planos JSON (objetos/arrays/escrituras).
 * @param {unknown} value
 * @returns {any}
 */
function _deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Schema de config.json. Cada entrada define el tipo esperado (string,
 * boolean, number, array, object) y el default a aplicar si falta o es
 * inválido. Las secciones anidadas usan `schema` para recursión.
 * @type {Record<string, { type: string, default?: any, itemType?: string, enum?: string[], schema?: Record<string, any> }>}
 */
const SCHEMA = {
  activeModel: { type: 'string', default: 'March 7th' },
  chatTheme: { type: 'string', default: 'dark' },
  autonomy: { type: 'string', default: 'suggest', enum: AUTONOMY_MODES },
  llm: {
    type: 'object',
    default: { primary: 'groq', fallback: ['gemini'], apiKeys: {}, providers: {} },
    schema: {
      primary: { type: 'string', default: 'groq' },
      fallback: { type: 'array', default: ['gemini'], itemType: 'string' },
      apiKeys: { type: 'object', default: {} },
      providers: { type: 'object', default: {} },
      // Fase catálogo: antes vivían solo en memoria; ahora se validan y
      // persisten igual que el resto de llm.*.
      customProviders: { type: 'array', default: [], itemType: 'object' },
      queue: {
        type: 'object',
        default: { enabled: true, concurrency: 1, maxWaitMs: 30000, priority: 0 },
      },
      remoteCatalog: { type: 'object', default: { enabled: true } },
      // Selector modelo-first: favoritos ("providerId/modelId").
      favorites: { type: 'array', default: [], itemType: 'string' },
    },
  },
  sensors: {
    type: 'object',
    default: { git: true, system: true, title: true, clipboard: false, events: true, lsp: true },
    schema: {
      git: { type: 'boolean', default: true },
      system: { type: 'boolean', default: true },
      title: { type: 'boolean', default: true },
      clipboard: { type: 'boolean', default: false },
      events: { type: 'boolean', default: true },
      lsp: { type: 'boolean', default: true },
    },
  },
  gestures: {
    type: 'object',
    default: {
      enabled: true,
      cooldownMs: 15000,
      minIntervalMs: 2500,
      durationMs: 6000,
      ambient: false,
      ambientIntervalMs: 60000,
      forcedMoodFallback: 'default',
      llmDriven: true,
      mappings: {},
    },
    schema: {
      enabled: { type: 'boolean', default: true },
      cooldownMs: { type: 'number', default: 15000 },
      minIntervalMs: { type: 'number', default: 2500 },
      durationMs: { type: 'number', default: 6000 },
      ambient: { type: 'boolean', default: false },
      ambientIntervalMs: { type: 'number', default: 60000 },
      forcedMoodFallback: { type: 'string', default: 'default' },
      llmDriven: { type: 'boolean', default: true },
      mappings: { type: 'object', default: {} },
    },
  },
  mcp: {
    type: 'object',
    default: { servers: [] },
    schema: {
      servers: { type: 'array', default: [], itemType: 'object' },
    },
  },
  agent: {
    type: 'object',
    default: { approvalTimeoutMs: 120000, subagent: { enabled: true } },
    schema: {
      // Tiempo máximo (ms) para que el usuario responda a un card de
      // aprobación de alto impacto. Pasado ese lapso la acción se deniega y
      // el card se marca como expirado en la UI. 120s por defecto: el
      // usuario puede estar leyendo el resto de la respuesta del agente
      // antes de llegar a la tarjeta.
      approvalTimeoutMs: { type: 'number', default: 120000 },
      // Subagentes con perfil (F1): si se apaga, la tool subagent deja de
      // estar disponible para el agente.
      subagent: {
        type: 'object',
        default: { enabled: true },
        schema: {
          enabled: { type: 'boolean', default: true },
        },
      },
    },
  },
};

/**
 * Aplica defaults y valida un objeto plano contra un subschema.
 * Devuelve { value, errors, warnings }. Nunca lanza.
 * @param {unknown} raw
 * @param {Record<string, any>} schema
 * @param {string} pathPrefix
 * @returns {{ value: any, errors: string[], warnings: string[] }}
 */
function normalizeSection(raw, schema, pathPrefix) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];
  /** @type {Record<string, any>} */
  const value = {};

  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    /** @type {Record<string, any>} */
    const defaultObj = {};
    for (const [k, spec] of Object.entries(schema)) {
      defaultObj[k] = _deepClone(spec.default);
    }
    return { value: defaultObj, errors, warnings };
  }

  for (const [k, spec] of Object.entries(schema)) {
    const fullKey = pathPrefix ? `${pathPrefix}.${k}` : k;
    const v = /** @type {Record<string, any>} */ (raw)[k];
    if (v === undefined) {
      value[k] = _deepClone(spec.default);
      continue;
    }

    if (spec.enum && !spec.enum.includes(v)) {
      errors.push(`${fullKey}: "${String(v)}" no es válido (esperado: ${spec.enum.join('|')})`);
      value[k] = _deepClone(spec.default);
      continue;
    }

    if (spec.type === 'object') {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        errors.push(`${fullKey}: se esperaba un objeto`);
        value[k] = _deepClone(spec.default);
        continue;
      }
      if (spec.schema) {
        const sub = normalizeSection(v, spec.schema, fullKey);
        errors.push(...sub.errors);
        warnings.push(...sub.warnings);
        value[k] = sub.value;
      } else {
        value[k] = v;
      }
      continue;
    }

    if (spec.type === 'array') {
      if (!Array.isArray(v)) {
        errors.push(`${fullKey}: se esperaba un array`);
        value[k] = _deepClone(spec.default);
        continue;
      }
      if (spec.itemType === 'string') {
        value[k] = v.filter((item) => typeof item === 'string');
      } else if (spec.itemType === 'object') {
        value[k] = v.filter(
          (item) => typeof item === 'object' && item !== null && !Array.isArray(item)
        );
      } else {
        value[k] = v;
      }
      continue;
    }

    if (typeof v !== spec.type) {
      errors.push(`${fullKey}: se esperaba ${spec.type}, se recibió ${typeof v}`);
      value[k] = spec.default;
      continue;
    }

    value[k] = v;
  }

  // Claves desconocidas dentro de una sección conocida: se conservan.
  for (const [k, v] of Object.entries(/** @type {Record<string, any>} */ (raw))) {
    if (k in schema) continue;
    warnings.push(`${pathPrefix ? `${pathPrefix}.` : ''}${k}: clave desconocida (se conserva)`);
    value[k] = v;
  }

  return { value, errors, warnings };
}

/**
 * Valida un objeto de config completo contra el SCHEMA global.
 * @param {unknown} raw
 * @returns {{ ok: boolean, normalized: any, errors: string[], warnings: string[] }}
 */
function validateConfig(raw) {
  const isPlainObject = typeof raw === 'object' && raw !== null && !Array.isArray(raw);
  const src = isPlainObject ? raw : {};
  const { value, errors, warnings } = normalizeSection(src, SCHEMA, '');

  if (!isPlainObject) {
    errors.push('config.json no contiene un objeto raíz válido');
  }

  // Claves top-level desconocidas: se conservan (compat hacia delante).
  for (const [k, v] of Object.entries(src)) {
    if (k in SCHEMA) continue;
    warnings.push(`${k}: clave top-level desconocida (se conserva)`);
    value[k] = v;
  }

  return { ok: errors.length === 0, normalized: value, errors, warnings };
}

class ConfigManager {
  /**
   * @param {string|null} filePath Ruta al config.json. null → solo en memoria (tests).
   * @param {object} [opts]
   * @param {boolean} [opts.verbose] Loggear errores/warnings al cargar.
   */
  constructor(filePath, opts = {}) {
    /** @type {string | null} */
    this.filePath = filePath;
    this.verbose = opts.verbose !== false;
    this._cache = null;
    /** @type {{ ok: boolean, errors: string[], warnings: string[] } | null} */
    this.report = null;
    this._loaded = false;
  }

  /**
   * Carga, valida y cachea config.json. Devuelve un clon profundo del
   * resultado normalizado. Si el archivo no existe o está corrupto, devuelve
   * la config por defecto y lo registra en `this.report`.
   * @returns {any}
   */
  load() {
    if (this._loaded && this._cache !== null) return JSON.parse(JSON.stringify(this._cache));

    let raw = {};
    /** @type {{ ok: boolean, errors: string[], warnings: string[] }} */
    const report = { ok: true, errors: [], warnings: [] };

    if (this.filePath && fs.existsSync(this.filePath)) {
      try {
        raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        report.ok = false;
        report.errors.push(`config.json corrupto: ${msg}`);
        if (this.verbose)
          logger.info('ConfigManager', `[config] error leyendo config.json: ${msg}`);
      }
    } else if (this.filePath) {
      report.warnings.push('config.json no existe — usando defaults');
    }

    const result = validateConfig(raw);
    report.ok = report.ok && result.ok;
    report.errors.push(...result.errors);
    report.warnings.push(...result.warnings);
    this.report = report;

    if (this.verbose) {
      for (const err of result.errors) logger.info('ConfigManager', `[config] error: ${err}`);
      for (const warn of result.warnings) logger.info('ConfigManager', `[config] warning: ${warn}`);
    }

    this._cache = result.normalized;
    this._loaded = true;
    return JSON.parse(JSON.stringify(this._cache));
  }

  /**
   * Devuelve el valor de un path punteado ("llm.primary" → "groq").
   * @param {string} keyPath
   * @param {any} [fallback]
   * @returns {any}
   */
  get(keyPath, fallback) {
    const cfg = this.load();
    const parts = keyPath.split('.');
    let cur = cfg;
    for (const p of parts) {
      if (cur === null || cur === undefined || typeof cur !== 'object') return fallback;
      cur = cur[p];
    }
    return cur === undefined ? fallback : cur;
  }

  /**
   * Aplica un patch (merge superficial a nivel top-level) y persiste el
   * resultado normalizado. Invalidación y reescritura del cache.
   * @param {object} patch
   * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
   */
  save(patch) {
    const current = this.load();
    const merged = { ...current, ...patch };
    const result = validateConfig(merged);
    this._cache = result.normalized;
    this._loaded = true;
    this.report = { ok: result.ok, errors: result.errors, warnings: result.warnings };

    if (this.filePath) {
      try {
        fs.writeFileSync(this.filePath, JSON.stringify(result.normalized, null, 2), 'utf-8');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        result.errors.push(`no se pudo escribir config.json: ${msg}`);
        if (this.verbose)
          logger.info('ConfigManager', `[config] error guardando config.json: ${msg}`);
      }
    }

    return result;
  }

  /**
   * Descarta el cache y relee del disco en el próximo load().
   */
  reload() {
    this._loaded = false;
    this._cache = null;
    return this.load();
  }
}

module.exports = { ConfigManager, SCHEMA, validateConfig };
