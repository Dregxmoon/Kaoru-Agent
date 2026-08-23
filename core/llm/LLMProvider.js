// @ts-nocheck
'use strict';
const logger = require('../observability/Logger.js');

const https = require('https');
const http = require('http');

const { ProviderQueue } = require('./RequestQueue.js');
const { UsageTracker } = require('../observability/UsageTracker.js');

const KEEP_ALIVE_AGENT = new https.Agent({ keepAlive: true, maxSockets: 4 });
const KEEP_ALIVE_AGENT_HTTP = new http.Agent({ keepAlive: true, maxSockets: 4 });
const AGENT_BY_PROTOCOL = {
  'https:': KEEP_ALIVE_AGENT,
  'http:': KEEP_ALIVE_AGENT_HTTP,
};

// ── Uso (observabilidad) ─────────────────────────────────────────────────────
// Tracker por defecto en memoria; Core.init() inyecta uno persistido a disco
// con setUsageTracker() cuando tiene app.getPath('userData') disponible.
let _usageTracker = new UsageTracker(null);

function setUsageTracker(tracker) {
  _usageTracker = tracker || new UsageTracker(null);
}

function getUsageTracker() {
  return _usageTracker;
}

/**
 * Extrae tokens de un body de respuesta y registra el evento de uso.
 * Devuelve los tokens extraídos (puede ser 0 si el provider no los reporta,
 * p.ej. en streams).
 * @param {string} providerId
 * @param {any} def
 * @param {string} model
 * @param {string} mode
 * @param {any} resBody
 * @param {object} opts
 * @param {number} startedAt
 * @param {boolean} [isError]
 */
function _recordUsage(providerId, def, model, mode, resBody, opts, startedAt, isError) {
  let promptTokens = 0;
  let completionTokens = 0;
  if (resBody && typeof resBody === 'object') {
    const u = resBody.usage;
    if (u) {
      promptTokens = u.prompt_tokens || u.input_tokens || 0;
      completionTokens = u.completion_tokens || u.output_tokens || 0;
    } else if (resBody.usageMetadata) {
      promptTokens = resBody.usageMetadata.promptTokenCount || 0;
      completionTokens = resBody.usageMetadata.candidatesTokenCount || 0;
    }
  }
  _usageTracker.record({
    provider: providerId,
    model: model || def?.name || providerId,
    mode,
    promptTokens,
    completionTokens,
    latencyMs: Date.now() - startedAt,
    stream: opts.onToken === true,
    error: isError === true,
  });
  return promptTokens + completionTokens;
}

// ── Provider registry ──────────────────────────────────────────────────────────
const _registry = new Map();

function registerProvider(def) {
  if (_registry.has(def.id)) {
    logger.warn('LLMProvider', `[llm] provider "${def.id}" ya registrado — se reemplaza`);
  }
  _registry.set(def.id, { ...def });
}

function getProviders() {
  return [..._registry.values()];
}

// ── Built-in providers ─────────────────────────────────────────────────────────
// Catálogo data-driven (core/llm/catalog.js). Es el fallback de la lista
// "todos los modelos disponibles" que muestra el selector: si el proveedor
// expone GET /models (OpenAI-compatible), refreshProviderModels() consulta la
// lista viva y la interseca con este catálogo curado (solo se ofrecen modelos
// que la cuenta del usuario realmente tiene accesibles — evita listar modelos
// que devuelven 404 "Function not found" por no estar desplegados en la
// cuenta); si no, esta es la que se muestra.
const {
  BUILTIN_PROVIDERS,
  ROLE_LABELS,
  resolveRole,
  getModelMeta: getCuratedModelMeta,
  getProviderDef: getCuratedProviderDef,
  resolveModelId: resolveCuratedModelId,
} = require('./catalog.js');

for (const def of BUILTIN_PROVIDERS) {
  registerProvider({
    id: def.id,
    name: def.name,
    type: def.type,
    baseURL: def.baseURL,
    models: { fast: def.defaults.fast, smart: def.defaults.smart },
    catalog: Object.keys(def.models),
    modelMeta: def.models,
    timeoutMs: def.timeoutMs,
    builtin: true,
    free: def.free,
  });
}

// ── Límites ────────────────────────────────────────────────────────────────────
const MAX_OUTPUT = { fast: 1024, smart: 8192 };
const TIMEOUT_MS = { fast: 15_000, smart: 60_000 };
const FAST_HISTORY_LIMIT = 8;
const VALID_MODES = new Set(['fast', 'smart']);
// Reintentos por provider: 2 reintentos (3 intentos en total). Los fallos
// transitorios (429 con espera corta, timeouts, red) se reintentan con backoff
// exponencial + jitter; el mensaje de rate-limit "espera > 30s" NO se espera de
// forma síncrona (ver MAX_RETRY_WAIT_MS) y degrada el provider para el fallback.
const MAX_RETRIES_PER_PROVIDER = 2;
const RETRY_BASE_MS = 2000;
// Si un rate-limit dice "espera > 30s", no lo esperamos de forma síncrona
// (una request no puede quedar colgada 50 min): fallamos ya y el mensaje
// final le avisa al usuario cuánto esperar o que cambie de proveedor.
const MAX_RETRY_WAIT_MS = 30_000;

// ── Filtro de forbidden phrases (defensa en profundidad) ─────────────────────
// El system prompt ya incluye las forbidden_phrases de identity.json como
// instrucción (IdentitySerializer), pero el LLM puede ignorarlas bajo presión
// de contexto. Esta función actúa como red de seguridad: si la respuesta
// contiene una frase prohibida textual, se elimina antes de llegar al usuario.
// Es regex sobre texto plano — no reemplaza la instrucción en el prompt.
function _stripForbiddenPhrases(text) {
  if (!text) return text;
  let identity;
  try {
    identity = require('../identity/IdentityStore.js').getIdentity();
  } catch {
    return text;
  }
  const forbidden = identity?.voice?.forbidden_phrases || [];
  let cleaned = text;
  for (const phrase of forbidden) {
    if (!phrase) continue;
    const re = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    if (re.test(cleaned)) {
      logger.debug('LLMProvider', `[filter] frase prohibida eliminada: "${phrase}"`);
      cleaned = cleaned.replace(re, '');
    }
  }
  return cleaned.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

// ── Anti-fabricación para funciones sin tools por diseño ──────────────────────
// complete(), completeTask() y completeForMode() nunca tienen acceso a tools
// reales. Sin esta nota, el LLM "sigue en personaje" y narra acciones que
// nunca ejecutó (crear archivos, buscar web, etc.). La constante se usa tanto
// acá como en el fallback de completeWithTools() para no duplicar el string.
const NO_TOOLS_NOTICE =
  '\n\nIMPORTANTE: en esta respuesta NO tenés acceso a herramientas ' +
  '(crear archivos, buscar en la web, ejecutar comandos, etc.). ' +
  'Si la tarea que te piden requiere alguna de esas capacidades, decilo explícitamente ' +
  "(ej: 'no puedo ejecutar esto ahora mismo, intentá de nuevo') — NUNCA " +
  'describas, narres o simules que ya la ejecutaste.';

// Providers que aceptan el campo `chat_template_kwargs` (OpenAI-compatible) en
// el body para desactivar el thinking de Qwen3/DeepSeek. Groq NO lo acepta y
// responde HTTP 400; otros lo ignoran o lo rechazan. Si el provider no está en
// esta lista, el CoT se elimina del content con _stripCot (red de seguridad).
const CHAT_TEMPLATE_KWARGS_PROVIDERS = new Set([
  'nvidia',
  'deepseek',
  'openrouter',
  'siliconflow',
  'moonshot',
  'xai',
  'zhipu',
  'xinference',
  'fireworks',
  'together',
  'mistral',
]);

// TTL del catálogo validado contra el endpoint del provider: evitar pegarle a
// la API en cada invocación de /model <provider> o del selector de modelos.
// Pasado el TTL, refreshProviderModels() re-valida contra GET /models.
const CATALOG_REFRESH_TTL_MS = 5 * 60 * 1000;

// Temperature de las llamadas: los perfiles de subagente pueden pedir una
// distinta; si no, se usa el default del provider (0.85).
function _temp(opts) {
  if (opts && Number.isFinite(opts.temperature)) return opts.temperature;
  return 0.85;
}

function _resolveMode(mode) {
  return VALID_MODES.has(mode) ? mode : 'fast';
}

function _trimHistoryForMode(messages, mode) {
  if (mode !== 'fast') return messages;
  if (!Array.isArray(messages) || messages.length <= FAST_HISTORY_LIMIT) return messages;
  return messages.slice(-FAST_HISTORY_LIMIT);
}

// ── Configuración por defecto ─────────────────────────────────────────────────
let _config = {
  primary: 'groq',
  fallback: ['gemini'],
  providers: {},
  customProviders: [],
  // Fase J: cola por provider (concurrency 1 = serial, cooldown por 429,
  // presupuesto de espera por request). Desactivable con queue.enabled=false.
  queue: { enabled: true, concurrency: 1, maxWaitMs: MAX_RETRY_WAIT_MS, priority: 0 },
  // Fase híbrida: el catálogo remoto (models.dev/api.json) enriquece el catálogo
  // curado con modelos nuevos + metadata. Solo datos, no toca keys ni envía
  // nada del usuario. Desactivable con remoteCatalog.enabled=false.
  remoteCatalog: { enabled: true },
  // Selector modelo-first: modelos favoritos (array de "providerId/modelId").
  favorites: [],
};

// Marca de tiempo del último refresh exitoso del catálogo por provider
// (Date.now). Permite aplicar el TTL sin re-consultar la API en cada uso.
const _catalogRefreshedAt = {};

function configure(cfg) {
  if (!cfg) return;
  const llm = cfg.llm || cfg;
  if (llm.primary) _config.primary = llm.primary;
  if (llm.fallback) _config.fallback = llm.fallback;
  if (llm.queue) {
    _config.queue = { ..._config.queue, ...llm.queue };
  }
  if (llm.remoteCatalog) {
    _config.remoteCatalog = { ..._config.remoteCatalog, ...llm.remoteCatalog };
  }
  if (Array.isArray(llm.favorites)) {
    _config.favorites = [...llm.favorites];
  }
  if (llm.apiKeys) {
    for (const [id, key] of Object.entries(llm.apiKeys)) {
      if (!_config.providers[id]) _config.providers[id] = {};
      _config.providers[id].apiKey = key;
    }
  }
  if (llm.providers) {
    for (const [id, p] of Object.entries(llm.providers)) {
      _config.providers[id] = { ...(_config.providers[id] || {}), ...p };
    }
  }
  if (llm.customProviders) {
    _config.customProviders = llm.customProviders;
    for (const cp of llm.customProviders) {
      registerProvider({ ...cp, custom: true });
    }
  }
  // Env var fallback for all built-in providers
  for (const [id] of _registry) {
    const envKey = `LLM_KEY_${id.toUpperCase()}`;
    const envVal = process.env[envKey];
    if (envVal && envVal.trim()) {
      if (!_config.providers[id]) _config.providers[id] = {};
      if (!_config.providers[id].apiKey) _config.providers[id].apiKey = envVal.trim();
    }
  }
  _applyKeychainOverlay();
}

function _getApiKey(providerId) {
  const p = _config.providers[providerId];
  if (p && p.apiKey && p.apiKey.trim()) return p.apiKey.trim();
  return null;
}

// ── Llavero del sistema ─────────────────────────────────────────────────────
// Fase 1 del roadmap: LLMProvider resuelve las keys del KeychainManager por sí
// mismo (máxima prioridad), así ningún caller necesita pre-fusionarlas. El
// overlay es aditivo: si el llavero no está disponible o no tiene la key, cae
// a lo que venga en config/env sin tocar nada.
let _keychainStore = null;
let _keychainDisabled = false;
function _setKeychainResolver(resolver) {
  _keychainDisabled = resolver === false;
  _keychainStore =
    !_keychainDisabled && resolver && typeof resolver === 'object'
      ? resolver
      : !_keychainDisabled && typeof resolver === 'function'
        ? { getKey: resolver }
        : null;
}

function _keychain() {
  if (_keychainDisabled) return null;
  if (_keychainStore) return _keychainStore;
  try {
    const KeychainManager = require('../../infrastructure/keychain/KeychainManager.js');
    return KeychainManager.isAvailable() ? KeychainManager : null;
  } catch {
    return null;
  }
}

function _resolveKeychainKey(providerId) {
  const K = _keychain();
  if (!K || typeof K.getKey !== 'function') return null;
  try {
    return K.getKey(providerId) || null;
  } catch {
    return null;
  }
}

function _applyKeychainOverlay() {
  for (const [id] of _registry) {
    const stored = _resolveKeychainKey(id);
    if (stored && stored.trim()) {
      if (!_config.providers[id]) _config.providers[id] = {};
      _config.providers[id].apiKey = stored.trim();
    }
  }
}

function storeProviderApiKey(providerId, apiKey) {
  const K = _keychain();
  if (!K || !apiKey || typeof K.setKey !== 'function') return false;
  return K.setKey(providerId, apiKey) === true;
}

function removeProviderApiKey(providerId) {
  const K = _keychain();
  if (!K || typeof K.deleteKey !== 'function') return false;
  return K.deleteKey(providerId) === true;
}

function migrateApiKeysToKeychain(cfg) {
  const K = _keychain();
  if (!K || typeof K.getKey !== 'function' || typeof K.setKey !== 'function') {
    return { migrated: [], keychainAvailable: false };
  }
  const llm = (cfg && (cfg.llm || cfg)) || {};
  const candidates = { ...(llm.apiKeys || {}) };
  for (const [id, p] of Object.entries(llm.providers || {})) {
    if (p && p.apiKey && p.apiKey.trim()) candidates[id] = p.apiKey;
  }
  const migrated = [];
  for (const [id, key] of Object.entries(candidates)) {
    if (key && key.trim() && !K.getKey(id) && K.setKey(id, key.trim()) === true) {
      migrated.push(id);
    }
  }
  return { migrated, keychainAvailable: true };
}

function _getModels(providerId) {
  const def = _registry.get(providerId);
  if (!def) return null;
  return def.models || null;
}

// Resuelve el modelo efectivo para un provider+modo. Prioridad:
// 1. modelo elegido por el usuario (config/env: providers[id].model[modo])
// 2. modelo por defecto del provider (def.models[modo])
function _resolveModel(providerId, mode) {
  const def = _registry.get(providerId);
  if (!def) return null;
  const override = _config.providers?.[providerId]?.model?.[mode];
  if (override && typeof override === 'string' && override.trim()) return override.trim();
  return def.models?.[mode] || null;
}

// Catálogo de modelos disponibles para un provider: el refrescado vía API
// (en memoria) si existe, si no el estático del registro.
function _providerCatalog(providerId) {
  const def = _registry.get(providerId);
  if (!def) return [];
  const refreshed = _config.providers?.[providerId]?.catalog;
  if (Array.isArray(refreshed) && refreshed.length > 0) return refreshed;
  return Array.isArray(def.catalog) ? def.catalog : [];
}

// ── Auto-recuperación ante modelos descontinuados ─────────────────────────────
// Los providers retiran modelos (Groq deprecó llama-3.1-70b-versatile sin
// aviso). Ante error model_decommissioned/model_not_found: se marca el modelo
// como muerto, se consulta el catálogo vivo del provider y se elige reemplazo
// en memoria (persistir en config.json queda para el usuario/UI).

/** @type {Set<string>} claves "provider:model" confirmadas como no disponibles */
const _deadModels = new Set();

function _isModelUnavailableError(msg) {
  return /model_decommissioned|model_not_found|decommissioned|does not exist|not a valid model/i.test(
    String(msg)
  );
}

/**
 * Reemplaza en memoria un modelo muerto por uno vivo del mismo provider.
 * @param {string} providerId
 * @param {string} mode 'fast' | 'smart'
 * @returns {Promise<boolean>} true si encontró reemplazo
 */
async function _recoverDecommissionedModel(providerId, mode) {
  const dead = _resolveModel(providerId, mode);
  if (!dead || _deadModels.has(`${providerId}:${dead}`)) return false;
  let live = [];
  try {
    live = await refreshProviderModels(providerId);
  } catch {
    /* catálogo estático como fallback */
  }
  const candidates = (Array.isArray(live) ? live : []).filter(
    (m) => m && m !== dead && !_deadModels.has(`${providerId}:${m}`)
  );
  if (candidates.length === 0) {
    logger.warn(
      'LLMProvider',
      `[llm] ${dead} (${providerId}) no está disponible y no hay catálogo vivo para elegir reemplazo`
    );
    return false;
  }
  // Heurística de tier: smart prefiere el modelo más grande, fast uno chico.
  const prefer = /smart/i.test(mode) ? /120b|70b|large|405b/i : /mini|8b|20b|small|instant|flash/i;
  const pick = candidates.find((m) => prefer.test(m)) || candidates[0];
  _deadModels.add(`${providerId}:${dead}`);
  if (!_config.providers[providerId]) _config.providers[providerId] = {};
  if (!_config.providers[providerId].model) _config.providers[providerId].model = {};
  _config.providers[providerId].model[mode] = pick;
  logger.warn(
    'LLMProvider',
    `[llm] modelo ${dead} de ${providerId} fue retirado — reemplazo automático: ${pick} (${mode}). ` +
      'El cambio es en memoria: actualizá config.json o la UI para hacerlo permanente.'
  );
  return true;
}

// Fase Q: lista "todos los modelos disponibles" de un provider. Es la vía
// que usan el selector de credenciales y /model para ofrecer modelos que no
// son los dos por defecto (fast/smart). Incluye el modelo activo aunque no
// esté en el catálogo (p.ej. un modelo custom del usuario).
function listModels(providerId) {
  const def = _registry.get(providerId);
  if (!def) return [];
  const catalog = _providerCatalog(providerId);
  const active = {
    fast: _resolveModel(providerId, 'fast'),
    smart: _resolveModel(providerId, 'smart'),
  };
  const seen = new Set(catalog);
  const out = [...catalog];
  for (const m of Object.values(active)) {
    if (m && typeof m === 'string' && !seen.has(m)) {
      out.push(m);
      seen.add(m);
    }
  }
  return out;
}

// Fase Q: refresca el catálogo consultando GET /models del provider
// (OpenAI-compatible) con la key configurada. El resultado NO reemplaza la
// lista completa del endpoint: se interseca con el catálogo estático curado,
// de modo que solo se ofrecen modelos que la cuenta realmente tiene accesibles
// (los proveedores tipo NVIDIA Build listan modelos en /models que devuelven
// 404 "Function not found" si la cuenta no tiene la función desplegada). Si
// falla (proveedor sin endpoint, sin key, red) devuelve el catálogo estático
// sin tocar nada. Con TTL: dentro de CATALOG_REFRESH_TTL_MS no re-consulta la
// API y devuelve el catálogo ya validado en memoria.
// @param {string} providerId
// @param {function(string, object, number, AbortSignal|null): Promise<{status:number, body:any}>} [fetcher]
async function refreshProviderModels(providerId, fetcher = get) {
  const def = _registry.get(providerId);
  if (!def) return listModels(providerId);
  if (def.type !== 'openai') return listModels(providerId);
  const key = _getApiKey(providerId);
  if (!key) return listModels(providerId);
  const lastRefreshed = _catalogRefreshedAt[providerId];
  if (lastRefreshed && Date.now() - lastRefreshed < CATALOG_REFRESH_TTL_MS) {
    return listModels(providerId);
  }
  try {
    const res = await fetcher(
      `${def.baseURL}/models`,
      { Authorization: `Bearer ${key}` },
      20_000,
      null
    );
    if (res.status !== 200) return listModels(providerId);
    const data = Array.isArray(res.body?.data) ? res.body.data : [];
    const live = data
      .map((m) => (typeof m === 'string' ? m : m?.id))
      .filter((m) => typeof m === 'string' && m.trim());
    if (live.length === 0) return listModels(providerId);
    // Intersección: solo modelos del catálogo estático que también están en
    // la lista viva del endpoint (validación por cuenta). Si el provider no
    // tiene catálogo estático (custom sin catalog), se acepta la lista viva.
    const staticCatalog = Array.isArray(def.catalog) ? def.catalog : [];
    const validated =
      staticCatalog.length > 0 ? staticCatalog.filter((m) => live.includes(m)) : live;
    if (validated.length === 0) return listModels(providerId);
    if (!_config.providers[providerId]) _config.providers[providerId] = {};
    _config.providers[providerId].catalog = validated;
    _catalogRefreshedAt[providerId] = Date.now();
    logger.info(
      'LLMProvider',
      `[llm] catálogo de ${providerId} validado contra la API: ${validated.length} modelos disponibles`
    );
    return validated;
  } catch {
    return listModels(providerId);
  }
}

// ── Catálogo remoto híbrido (models.dev) ──────────────────────────────────────
// Capa de conocimiento adicional al catálogo curado: consulta
// https://models.dev/api.json (GET sin datos del usuario, JSON validado) y
// enriquece el registry con modelos nuevos + metadata (contexto, output, tools,
// visión, coste). TTL largo + cache a disco en userData → funciona offline con
// lo último conocido. NUNCA borra lo curado: solo añade y rellena campos que
// el catálogo curado no trae. Si la red falla o la respuesta es inválida,
// degrada en silencio al catálogo curado.
const REMOTE_CATALOG_URL = 'https://models.dev/api.json';
const REMOTE_CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

let _remoteCatalog = null; // { providerId: { modelId: meta } } (en memoria)
let _remoteRefreshedAt = 0;
let _catalogCachePath = null; // userData/llm-catalog.json (injectado por init.js)
// Índice de providers del catálogo remoto (models.dev): info de conexión
// (api/baseURL, env, npm, doc) + modelos. Es la fuente del selector modelo-
// first y de connectProvider(). Se construye desde el body raw (red o cache).
let _remoteProviderIndex = new Map();

/** Inyecta la ruta de cache (app.getPath('userData')). Best-effort. */
function setCatalogCachePath(path) {
  _catalogCachePath = path;
}

// Formato del cache a disco. v1: { providerId: { modelId: meta } } (solo
// metas). v2: { __v: 2, providers: <body raw de models.dev> } (metas + info
// de conexión). El body raw es datos públicos; se guarda tal cual para poder
// reconstruir el índice de providers sin re-consultar la red.
const CATALOG_CACHE_VERSION = 2;

function _buildRemoteProviderIndex(raw) {
  const data = (raw && raw.providers) || raw;
  if (!data || typeof data !== 'object') return new Map();
  const index = new Map();
  for (const [pid, rawP] of Object.entries(data)) {
    if (!rawP || typeof rawP !== 'object' || !rawP.models || typeof rawP.models !== 'object') {
      continue;
    }
    index.set(pid, {
      id: pid,
      name: (rawP.name && String(rawP.name)) || pid,
      api: rawP.api && typeof rawP.api === 'string' ? rawP.api : null,
      env: Array.isArray(rawP.env) ? rawP.env.map(String) : [],
      npm: rawP.npm && typeof rawP.npm === 'string' ? rawP.npm : null,
      doc: rawP.doc && typeof rawP.doc === 'string' ? rawP.doc : null,
    });
  }
  return index;
}

function _mapRemoteModel(id, raw) {
  return {
    label: (raw && raw.name) || id,
    context: raw && raw.limits && raw.limits.context ? raw.limits.context : 0,
    maxOutput: raw && raw.limits && raw.limits.output ? raw.limits.output : 0,
    tools: !!(raw && raw.tool_call),
    vision: !!(raw && raw.attachment),
    reasoning: !!(raw && raw.reasoning),
    free: false,
    cost: {
      in: raw && raw.cost && typeof raw.cost.prompt === 'number' ? raw.cost.prompt : 0,
      out: raw && raw.cost && typeof raw.cost.completion === 'number' ? raw.cost.completion : 0,
    },
    remote: true,
  };
}

/** Mapea el body de models.dev/api.json a { providerId: { modelId: meta } }. */
function _mapRemoteCatalog(body) {
  const data = (body && body.providers) || body;
  if (!data || typeof data !== 'object') return null;
  const out = {};
  for (const [pid, raw] of Object.entries(data)) {
    if (!raw || typeof raw !== 'object' || !raw.models || typeof raw.models !== 'object') continue;
    const models = {};
    for (const [mid, m] of Object.entries(raw.models)) {
      models[mid] = _mapRemoteModel(mid, m);
    }
    if (Object.keys(models).length > 0) out[pid] = models;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function _loadCachedCatalog() {
  if (!_catalogCachePath) return null;
  try {
    const fs = require('fs');
    if (!fs.existsSync(_catalogCachePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(_catalogCachePath, 'utf8'));
    if (parsed && parsed.__v === CATALOG_CACHE_VERSION) {
      // v2: body raw → metas + índice de providers.
      const remote = _mapRemoteCatalog(parsed.providers);
      const raw = parsed.providers;
      return remote && raw ? { remote, raw } : null;
    }
    // v1 (metas a secas): se migra en memoria; sin info de conexión.
    const remote = _mapRemoteCatalog({ providers: parsed });
    return remote ? { remote, raw: null } : null;
  } catch {
    return null;
  }
}

function _saveCatalogCache(remote, raw) {
  if (!_catalogCachePath) return;
  try {
    const fs = require('fs');
    const payload = raw
      ? { __v: CATALOG_CACHE_VERSION, providers: raw }
      : { __v: CATALOG_CACHE_VERSION, providers: remote };
    fs.writeFileSync(_catalogCachePath, JSON.stringify(payload));
  } catch {
    /* best-effort */
  }
}

/**
 * Fusiona el catálogo remoto en el registry. Reglas:
 *  - modelos nuevos → se añaden al catálogo del provider (con flag remote);
 *  - modelos existentes → el remoto solo RELLENA campos que el curado deja
 *    sin definir (nunca pisa lo curado ni el override del usuario).
 */
function _mergeRemoteCatalog(remote) {
  for (const [pid, models] of Object.entries(remote || {})) {
    const def = _registry.get(pid);
    if (!def) continue;
    const metas = def.modelMeta || (def.modelMeta = {});
    for (const [mid, meta] of Object.entries(models || {})) {
      const existing = metas[mid];
      if (!existing) {
        metas[mid] = meta;
        if (!Array.isArray(def.catalog)) def.catalog = [];
        if (!def.catalog.includes(mid)) def.catalog.push(mid);
      } else {
        for (const [k, v] of Object.entries(meta)) {
          if (existing[k] === undefined || existing[k] === null || existing[k] === 0) {
            existing[k] = v;
          }
        }
      }
    }
  }
}

function _applyRemoteCatalog(remote, now, raw) {
  if (!remote) return;
  _remoteCatalog = remote;
  _remoteRefreshedAt = now;
  _remoteProviderIndex = _buildRemoteProviderIndex(raw || null);
  _mergeRemoteCatalog(remote);
}

/**
 * Refresca (y cachea) el catálogo remoto. Con TTL: dentro de
 * REMOTE_CATALOG_TTL_MS no re-consulta la red. Fallo → cache a disco → curado.
 * @param {function(string, object, number, AbortSignal|null): Promise<{status:number, body:any}>} [fetcher]
 * @returns {Promise<boolean>}
 */
async function refreshRemoteCatalog(fetcher = get) {
  if (_config.remoteCatalog?.enabled === false) return false;
  const now = Date.now();
  if (_remoteCatalog && now - _remoteRefreshedAt < REMOTE_CATALOG_TTL_MS) return true;
  try {
    const res = await fetcher(REMOTE_CATALOG_URL, {}, 20_000, null);
    const raw = res && res.status === 200 ? res.body : null;
    const mapped = raw ? _mapRemoteCatalog(raw) : null;
    if (!mapped) {
      const cached = _loadCachedCatalog();
      _applyRemoteCatalog(cached ? cached.remote : null, now, cached ? cached.raw : null);
      return false;
    }
    _applyRemoteCatalog(mapped, now, raw);
    _saveCatalogCache(mapped, raw);
    const count = Object.values(mapped).reduce((n, m) => n + Object.keys(m).length, 0);
    logger.info(
      'LLMProvider',
      `[llm] catálogo remoto (models.dev) aplicado: ${Object.keys(mapped).length} providers, ${count} modelos`
    );
    return true;
  } catch {
    const cached = _loadCachedCatalog();
    _applyRemoteCatalog(cached ? cached.remote : null, now, cached ? cached.raw : null);
    return false;
  }
}

// ── Providers remotos (selector modelo-first) ────────────────────────────────
// Info de conexión del catálogo remoto, accesible aunque el provider aún no
// esté en el registry (no conectado). Solo datos públicos; nunca keys.

/** Índice de providers remotos: [{id, name, api, env, npm, doc, modelCount}]. */
function getRemoteProviders() {
  const out = [];
  for (const [id, info] of _remoteProviderIndex) {
    const models = (_remoteCatalog && _remoteCatalog[id]) || {};
    out.push({ ...info, modelCount: Object.keys(models).length });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Info de conexión de un provider remoto (o null). */
function getRemoteProvider(providerId) {
  return _remoteProviderIndex.get(providerId) || null;
}

// ── Helper HTTP ───────────────────────────────────────────────────────────────
function _abortError() {
  const err = new Error('Llamada LLM cancelada por el usuario');
  err.name = 'AbortError';
  err.code = 'ABORTED';
  return err;
}

// Adjunta un listener de abort al request y devuelve una función que lo
// remueve cuando el request termina (end/error/timeout). Sin cleanup, cada
// llamada que reutilice la misma AbortSignal — el agent-run comparte un único
// AbortController para TODAS sus requests de LLM, incluidos los reintentos del
// loop y las llamadas de iteraciones sucesivas — acumularía listeners para
// siempre: fuga de memoria + MaxListenersExceededWarning. Devuelve null si no
// hay signal (nada que limpiar).
function _attachAbortListener(req, signal, reject) {
  if (!signal) return null;
  const onAbort = () => {
    req.destroy();
    reject(_abortError());
  };
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

function post(url, headers, body, timeoutMs = 20_000, signal = null) {
  return new Promise((resolve, reject) => {
    let cleanupAbort = null;
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const payload = JSON.stringify(body);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      family: 4,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers,
      },
    };
    options.agent = AGENT_BY_PROTOCOL[parsed.protocol] || lib.globalAgent;
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        cleanupAbort?.();
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          // Si es un stream SSE (p. ej. Gemini con alt=sse), devolvemos el
          // raw como string para que el caller lo parsee fragmento a fragmento.
          if (String(data).trimStart().startsWith('data:')) {
            resolve({ status: res.statusCode, body: data });
          } else {
            reject(new Error(`${res.statusCode} JSON parse error: ${data.slice(0, 200)}`));
          }
        }
      });
    });
    req.setTimeout(timeoutMs, () => {
      cleanupAbort?.();
      req.destroy();
      reject(new Error(`Timeout después de ${timeoutMs}ms`));
    });
    req.on('error', (e) => {
      cleanupAbort?.();
      reject(e);
    });
    if (signal && signal.aborted) {
      req.destroy();
      reject(_abortError());
      return;
    }
    cleanupAbort = _attachAbortListener(req, signal, reject);
    req.write(payload);
    req.end();
  });
}

// GET genérico con headers (sin body). Lo usa refreshProviderModels() para
// consultar /models. Devuelve { status, body }.
function get(url, headers = {}, timeoutMs = 20_000, signal = null) {
  return new Promise((resolve, reject) => {
    let cleanupAbort = null;
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      family: 4,
      headers: { Accept: 'application/json', ...headers },
    };
    options.agent = AGENT_BY_PROTOCOL[parsed.protocol] || lib.globalAgent;
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        cleanupAbort?.();
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          reject(new Error(`${res.statusCode} JSON parse error: ${data.slice(0, 200)}`));
        }
      });
    });
    req.setTimeout(timeoutMs, () => {
      cleanupAbort?.();
      req.destroy();
      reject(new Error(`Timeout después de ${timeoutMs}ms`));
    });
    req.on('error', (e) => {
      cleanupAbort?.();
      reject(e);
    });
    if (signal && signal.aborted) {
      req.destroy();
      reject(_abortError());
      return;
    }
    cleanupAbort = _attachAbortListener(req, signal, reject);
    req.end();
  });
}

// POST con streaming SSE (OpenAI-compatible /chat/completions con stream:true).
// onToken(text) se invoca por cada fragmento de texto; el body acumulado se
// resuelve como { status, body: { content, tool_calls } } al final del stream.
// signal (AbortSignal) cancela el request en curso: destruye la conexión y
// rechaza con un error AbortError (para que el caller distinga cancelación
// de un fallo real del provider).
function postStream(url, headers, body, onToken, timeoutMs = 20_000, signal = null) {
  return new Promise((resolve, reject) => {
    let cleanupAbort = null;
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const payload = JSON.stringify(body);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      family: 4,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers,
      },
    };
    options.agent = AGENT_BY_PROTOCOL[parsed.protocol] || lib.globalAgent;
    const req = lib.request(options, (res) => {
      if (res.statusCode !== 200) {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          cleanupAbort?.();
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch {
            parsed = data;
          }
          reject(new Error(`HTTP ${res.statusCode}: ${JSON.stringify(parsed).slice(0, 200)}`));
        });
        return;
      }
      let buffer = '';
      let content = '';
      const toolCalls = []; // acumulados por índice (deltas incrementales)
      // Filtro de CoT en vivo: los bloques <thinking> pueden llegar partidos
      // entre chunks SSE; se retienen los últimos bytes por si un marker se
      // corta, y no se emite nada mientras el estado esté dentro de un bloque.
      const cotState = { pending: '', inThinking: false };
      const emitToken = (text) => {
        const keep = Math.min(12, text.length);
        const combined = (cotState.pending || '') + text;
        cotState.pending = combined.slice(-keep);
        const head = combined.slice(0, -keep);
        let out = '';
        const re = /<thinking>|<\/thinking>/gi;
        let last = 0;
        let m;
        while ((m = re.exec(head))) {
          if (!cotState.inThinking && /<thinking>/i.test(m[0])) {
            out += head.slice(last, m.index);
            cotState.inThinking = true;
          } else if (cotState.inThinking && /<\/thinking>/i.test(m[0])) {
            cotState.inThinking = false;
          }
          last = re.lastIndex;
        }
        out += cotState.inThinking ? '' : head.slice(last);
        if (out) {
          try {
            onToken && onToken(out);
          } catch (_) { logger.debug('LLMProvider', 'callback onToken falló'); }
        }
      };
      const parseDelta = (delta) => {
        if (delta && typeof delta.content === 'string' && delta.content.length > 0) {
          content += delta.content;
          emitToken(delta.content);
        }
        if (delta && Array.isArray(delta.tool_calls)) {
          for (const piece of delta.tool_calls) {
            const idx = piece.index || 0;
            const slot = toolCalls[idx] || (toolCalls[idx] = { id: null, name: '', arguments: '' });
            if (piece.id) slot.id = piece.id;
            if (piece.function && piece.function.name) slot.name += piece.function.name;
            if (piece.function && typeof piece.function.arguments === 'string')
              slot.arguments += piece.function.arguments;
          }
        }
      };
      res.on('data', (c) => {
        buffer += c;
        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          let json;
          try {
            json = JSON.parse(data);
          } catch {
            continue;
          }
          const delta = json.choices?.[0]?.delta;
          if (delta) parseDelta(delta);
        }
      });
      res.on('end', () => {
        cleanupAbort?.();
        // Vaciar el buffer del filtro CoT: el último trozo retenido (por si un
        // marker </thinking> se cortaba entre chunks) debe emitirse al cerrar.
        if (cotState.pending && !cotState.inThinking) {
          try {
            onToken && onToken(cotState.pending);
          } catch (_) { logger.debug('LLMProvider', 'callback onToken (CoT) falló'); }
          cotState.pending = '';
        }
        const toolCallsOut = toolCalls
          .filter((tc) => tc && tc.name && tc.arguments)
          .map((tc) => ({ id: tc.id, function: { name: tc.name, arguments: tc.arguments } }));
        resolve({
          status: res.statusCode,
          body: {
            content: _stripCot(content),
            tool_calls: toolCallsOut.length > 0 ? toolCallsOut : null,
          },
        });
      });
    });
    req.setTimeout(timeoutMs, () => {
      cleanupAbort?.();
      req.destroy();
      reject(new Error(`Timeout después de ${timeoutMs}ms`));
    });
    req.on('error', (e) => {
      cleanupAbort?.();
      reject(e);
    });
    if (signal && signal.aborted) {
      req.destroy();
      reject(_abortError());
      return;
    }
    cleanupAbort = _attachAbortListener(req, signal, reject);
    req.write(payload);
    req.end();
  });
}

// ── Generic OpenAI-compatible caller ──────────────────────────────────────────
async function callOpenAI(providerId, messages, systemPrompt, mode = 'fast', opts = {}) {
  const def = _registry.get(providerId);
  if (!def) throw new Error(`Provider desconocido: ${providerId}`);
  const key = _getApiKey(providerId);
  if (!key && !def.free) throw new Error(`No API key para ${def.name}`);

  const safeMode = _resolveMode(mode);
  const model = _resolveModel(providerId, safeMode);
  const maxTokens = MAX_OUTPUT[safeMode];
  const timeoutMs = def.timeoutMs?.[safeMode] ?? TIMEOUT_MS[safeMode] ?? TIMEOUT_MS.fast;
  const history = _trimHistoryForMode(messages, safeMode);
  const msgs = [{ role: 'system', content: systemPrompt }, ...history];
  const startedAt = Date.now();

  logger.info(
    'LLMProvider',
    `[llm] ${providerId} model: ${model} (${safeMode}, max_tokens=${maxTokens}, history=${history.length}msg, timeout=${timeoutMs}ms)${opts.onToken ? ' [stream]' : ''}`
  );

  const headers = key ? { Authorization: `Bearer ${key}` } : {};
  const body = { model, messages: msgs, max_tokens: maxTokens, temperature: _temp(opts) };
  if (opts.onToken) body.stream = true;
  // Modelos de razonamiento (Qwen3/DeepSeek) vuelcan su chain-of-thought en el
  // content y ese CoT se filtra al usuario por el chat. Se desactiva el modo
  // "thinking" por defecto; quien realmente quiera razonamiento lo pide con
  // opts.enableThinking. El campo NO lo aceptan todos los providers (Groq lo
  // rechaza con HTTP 400), así que solo se envía a los que lo soportan; el
  // resto se cubre con _stripCot sobre el content de la respuesta.
  if (
    CHAT_TEMPLATE_KWARGS_PROVIDERS.has(providerId) &&
    /qwen3|deepseek/i.test(model) &&
    !opts.enableThinking
  ) {
    body.chat_template_kwargs = { enable_thinking: false };
  }

  const res = opts.onToken
    ? await postStream(
        `${def.baseURL}/chat/completions`,
        headers,
        body,
        opts.onToken,
        timeoutMs,
        opts.signal
      )
    : await post(`${def.baseURL}/chat/completions`, headers, body, timeoutMs, opts.signal);
  if (res.status !== 200) throw new Error(`${def.name} ${res.status}: ${JSON.stringify(res.body)}`);
  _recordUsage(providerId, def, model, safeMode, res.body, opts, startedAt);
  // En streaming, postStream normaliza a { content, tool_calls } (sin el
  // campo choices de OpenAI crudo) — no acceder a choices[0] en ese caso.
  if (opts.onToken) return _stripCot(res.body.content || '').trim();
  const content = _stripCot(res.body.choices?.[0]?.message?.content || '');
  if (!content) throw new Error(`${def.name}: respuesta sin choices válidos`);
  return content.trim();
}

// ── Generic Gemini caller ─────────────────────────────────────────────────────
async function callGeminiProvider(providerId, messages, systemPrompt, mode = 'fast', opts = {}) {
  const def = _registry.get(providerId);
  if (!def) throw new Error(`Provider desconocido: ${providerId}`);
  const key = _getApiKey(providerId);
  if (!key) throw new Error(`No API key para ${def.name}`);

  const safeMode = _resolveMode(mode);
  const model = _resolveModel(providerId, safeMode);
  const maxTokens = MAX_OUTPUT[safeMode];
  const timeoutMs = TIMEOUT_MS[safeMode] ?? TIMEOUT_MS.fast;
  const history = _trimHistoryForMode(messages, safeMode);
  const contents = history.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const startedAt = Date.now();

  logger.info(
    'LLMProvider',
    `[llm] ${providerId} model: ${model} (${safeMode}, max_tokens=${maxTokens}, history=${history.length}msg, timeout=${timeoutMs}ms)${opts.onToken ? ' [stream]' : ''}`
  );

  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig: { maxOutputTokens: maxTokens, temperature: _temp(opts) },
  };
  // OJO: para Gemini el streaming NO se activa con el campo `stream` en el
  // body (generateContent no lo acepta → 400 "Unknown name stream"). Se
  // activa con `alt=sse` en la URL (más abajo). No poner body.stream aquí.
  // La API key NO va en el query string (quedaría en logs de red/proxies):
  // va en el header `x-goog-api-key` (método documentado por Google).

  const res = await post(
    `${def.baseURL}/models/${model}:generateContent${opts.onToken ? '?alt=sse' : ''}`,
    { 'x-goog-api-key': key },
    body,
    timeoutMs,
    opts.signal
  );
  if (res.status !== 200) throw new Error(`${def.name} ${res.status}: ${JSON.stringify(res.body)}`);
  // Gemini stream (alt=sse) devuelve el body como string SSE en data — si
  // llegó como JSON normal, extraemos directo; si es SSE, parseamos fragmentos.
  if (opts.onToken && typeof res.body === 'string') {
    _recordUsage(providerId, def, model, safeMode, {}, opts, startedAt);
    const full = _parseGeminiSSE(res.body, opts.onToken);
    return full.text.trim();
  }
  _recordUsage(providerId, def, model, safeMode, res.body, opts, startedAt);
  return (res.body.candidates[0]?.content?.parts?.[0]?.text || '').trim();
}

function _parseGeminiSSE(raw, onToken) {
  let out = '';
  /** @type {Array<{ tool: string, params: object }>} */
  const toolCalls = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const data = t.slice(5).trim();
    if (data === '[DONE]') continue;
    let json;
    try {
      json = JSON.parse(data);
    } catch {
      continue;
    }
    const parts = json.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const text = part.text;
      if (text) {
        out += text;
        try {
          onToken && onToken(text);
        } catch (_) { logger.debug('LLMProvider', 'callback onToken (Gemini) falló'); }
      }
      if (part.functionCall) {
        toolCalls.push({
          tool: part.functionCall.name,
          params: part.functionCall.args || {},
        });
      }
    }
  }
  return { text: out, toolCalls };
}

// ── Generic Anthropic caller ──────────────────────────────────────────────────
async function callAnthropic(providerId, messages, systemPrompt, mode = 'fast') {
  const def = _registry.get(providerId);
  if (!def) throw new Error(`Provider desconocido: ${providerId}`);
  const key = _getApiKey(providerId);
  if (!key) throw new Error(`No API key para ${def.name}`);

  const safeMode = _resolveMode(mode);
  const model = _resolveModel(providerId, safeMode);
  const maxTokens = MAX_OUTPUT[safeMode];
  const timeoutMs = TIMEOUT_MS[safeMode] ?? TIMEOUT_MS.fast;
  const history = _trimHistoryForMode(messages, safeMode);

  const msgs = history.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
  }));

  logger.info(
    'LLMProvider',
    `[llm] ${providerId} model: ${model} (${safeMode}, max_tokens=${maxTokens}, history=${history.length}msg, timeout=${timeoutMs}ms)`
  );

  const res = await post(
    `${def.baseURL}/messages`,
    { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    { model, messages: msgs, system: systemPrompt, max_tokens: maxTokens, temperature: 0.85 },
    timeoutMs
  );
  if (res.status !== 200) throw new Error(`${def.name} ${res.status}: ${JSON.stringify(res.body)}`);
  const content = res.body.content;
  if (!content) return '';
  return content
    .map((c) => c.text || '')
    .join('')
    .trim();
}

// ── Anthropic tool-calling ────────────────────────────────────────────────────
// Formato de la API Messages: `tools` con `{ name, description, input_schema }`
// y la respuesta en `content` como lista de bloques `{ type: 'tool_use', id,
// name, input }` / `{ type: 'text', text }`. Se normaliza a { content,
// toolCalls: [{ tool, params, id }] } como el resto del pipeline.
function _buildAnthropicTools(tools) {
  return tools.map((t) => ({
    name: t.name,
    description: (t.description || '').slice(0, 1024),
    input_schema: t.inputSchema || { type: 'object', properties: {} },
  }));
}

function _normalizeAnthropicResponse(body) {
  const blocks = body.content;
  if (!Array.isArray(blocks)) return { content: null, toolCalls: null };
  let content = null;
  const toolCalls = [];
  for (const block of blocks) {
    if (block.type === 'text' && block.text) content = (content || '') + block.text;
    else if (block.type === 'tool_use' && block.name)
      toolCalls.push({ tool: block.name, params: block.input || {}, id: block.id });
  }
  return {
    content: (content || '').trim() || null,
    toolCalls: toolCalls.length > 0 ? toolCalls : null,
  };
}

async function callAnthropicWithTools(providerId, messages, systemPrompt, mode, tools, opts = {}) {
  const def = _registry.get(providerId);
  if (!def) throw new Error(`Provider desconocido: ${providerId}`);
  const key = _getApiKey(providerId);
  if (!key) throw new Error(`No API key para ${def.name}`);

  const safeMode = _resolveMode(mode);
  const model = _resolveModel(providerId, safeMode);
  const maxTokens = MAX_OUTPUT[safeMode];
  const timeoutMs = def.timeoutMs?.[safeMode] ?? TIMEOUT_MS[safeMode] ?? TIMEOUT_MS.fast;
  const history = _trimHistoryForMode(messages, safeMode);

  const msgs = history.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
  }));
  const startedAt = Date.now();

  const body = {
    model,
    messages: msgs,
    system: systemPrompt,
    max_tokens: maxTokens,
    temperature: _temp(opts),
    tools: _buildAnthropicTools(tools),
  };

  logger.info(
    'LLMProvider',
    `[llm] ${providerId} tool-calling model: ${model} (${mode}, ${tools.length} tools)`
  );

  const res = await post(
    `${def.baseURL}/messages`,
    { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body,
    timeoutMs,
    opts.signal
  );
  if (res.status !== 200) throw new Error(`${def.name} ${res.status}: ${JSON.stringify(res.body)}`);
  _recordUsage(providerId, def, model, safeMode, res.body, opts, startedAt);
  return _normalizeAnthropicResponse(res.body);
}

// ── Dispatcher ────────────────────────────────────────────────────────────────
function _getCaller(providerId) {
  const def = _registry.get(providerId);
  if (!def) return null;
  switch (def.type) {
    case 'openai':
      return callOpenAI;
    case 'gemini':
      return callGeminiProvider;
    case 'anthropic':
      return callAnthropic;
    default:
      return null;
  }
}

const PROVIDERS = {};
const PROVIDERS_WITH_TOOLS = {};
// Callers inyectados por tests (_debug_setCaller / _debug_setToolCaller).
// _rebuildMaps los respeta por encima de los callers derivados del tipo.
const _injectedCallers = new Map();
const _injectedToolCallers = new Map();

function _rebuildMaps() {
  for (const [id] of _registry) {
    const fn = _injectedCallers.has(id) ? _injectedCallers.get(id) : _getCaller(id);
    if (fn) PROVIDERS[id] = (m, s, mode, opts) => fn(id, m, s, mode, opts);
    const fnTools = _injectedToolCallers.has(id)
      ? _injectedToolCallers.get(id)
      : _getToolCaller(id);
    if (fnTools)
      PROVIDERS_WITH_TOOLS[id] = (m, s, mode, tools, opts) => fnTools(id, m, s, mode, tools, opts);
  }
}

// ── Tool-calling ──────────────────────────────────────────────────────────────
const { TOOL_SCHEMAS } = require('./ToolSchemas.js');

function _buildOpenAITools(tools) {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: (t.description || '').slice(0, 1024),
      parameters: t.inputSchema,
    },
  }));
}

function _buildGeminiTools(tools) {
  return [
    {
      function_declarations: tools.map((t) => ({
        name: t.name,
        description: (t.description || '').slice(0, 1024),
        parameters: t.inputSchema,
      })),
    },
  ];
}

function _normalizeOpenAIResponse(body) {
  const choice = body.choices?.[0];
  if (!choice) return { content: null, toolCalls: null };
  const msg = choice.message;
  if (!msg) return { content: null, toolCalls: null };
  const content = msg.content || null;
  const rawCalls = msg.tool_calls;
  if (!rawCalls || rawCalls.length === 0) return { content: _stripCot(content), toolCalls: null };
  const toolCalls = rawCalls
    .filter((tc) => tc.type === 'function')
    .map((tc) => {
      try {
        const params = JSON.parse(tc.function.arguments);
        return { tool: tc.function.name, params, id: tc.id };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return { content: _stripCot(content), toolCalls: toolCalls.length > 0 ? toolCalls : null };
}

function _normalizeGeminiResponse(body) {
  const candidate = body.candidates?.[0];
  if (!candidate) return { content: null, toolCalls: null };
  const parts = candidate.content?.parts;
  if (!parts) return { content: null, toolCalls: null };
  let content = null;
  const toolCalls = [];
  for (const part of parts) {
    if (part.text !== undefined) content = (content || '') + part.text;
    if (part.functionCall)
      toolCalls.push({ tool: part.functionCall.name, params: part.functionCall.args || {} });
  }
  return {
    content: (content || '').trim() || null,
    toolCalls: toolCalls.length > 0 ? toolCalls : null,
  };
}

// Elimina el chain-of-thought que modelos de razonamiento (Qwen3/DeepSeek)
// vuelcan dentro del `content` cuando el thinking quedó activo (el campo
// chat_template_kwargs no lo aceptan todos los providers). Maneja dos formatos:
//   1. Bloques explícitos `<thinking>...</thinking>` (o con sangría/espacios).
//   2. Prosa libre de razonamiento tipo Qwen3 ("Here's a thinking process:",
//      "Let me think", párrafos de auto-análisis) que se recorta conservando
//      solo la parte que parece la respuesta final.
// Es conservador: si no hay rastros claros de razonamiento devuelve el texto
// tal cual (respuestas legítimas no se tocan).
const COT_THINKING_BLOCK = /<thinking>[\s\S]*?<\/thinking>/gi;
const COT_MARKERS = [
  /^Here('| i)?s a thinking process[:.]?\s*/i,
  /^Let me think\b/i,
  /^Let's think\b/i,
  /^Let’s think\b/i,
  /^I need to think\b/i,
  /^Thought:\s*$/m,
  /^Thought process:/i,
  /^Analy(se|ze) the (user input|task|request|prompt)/i,
  /^Current Context:/i,
  /^Open Apps:/i,
  /^Trigger\/Reason:/i,
  /^Constraints:/i,
  /^Memory\/Projects:/i,
  /^Identify Key Contextual Hooks:/i,
  /^Draft[ :]/i,
  /^Check constraints:/i,
  /^Let's verify/i,
  /^Let’s verify/i,
];

function _stripCot(content) {
  if (!content || typeof content !== 'string') return content;
  let out = content.replace(COT_THINKING_BLOCK, '').trim();
  if (!out) return out;

  // Prosa libre: solo si el arranque del texto es claramente razonamiento
  // (cabecera tipo "Here's a thinking process"), recortamos hasta el primer
  // párrafo que no parezca auto-análisis.
  const header = COT_MARKERS.find((m) => m.test(out));
  if (header) {
    const lines = out.split('\n');
    const start = lines.findIndex(
      (l, i) =>
        i > 0 &&
        !/^(constraint|memory|open app|trigger|analy|draft|check|current context)/i.test(
          l.trim()
        ) &&
        l.trim().length > 0
    );
    const keep = start > 0 ? lines.slice(start).join('\n') : out;
    if (keep.trim()) out = keep.trim();
  }
  return out;
}

async function callOpenAIWithTools(providerId, messages, systemPrompt, mode, tools, opts = {}) {
  const def = _registry.get(providerId);
  if (!def) throw new Error(`Provider desconocido: ${providerId}`);
  const key = _getApiKey(providerId);
  if (!key && !def.free) throw new Error(`No API key para ${def.name}`);

  const safeMode = _resolveMode(mode);
  const model = _resolveModel(providerId, safeMode);
  const maxTokens = MAX_OUTPUT[safeMode];
  const timeoutMs = def.timeoutMs?.[safeMode] ?? TIMEOUT_MS[safeMode] ?? TIMEOUT_MS.fast;
  const history = _trimHistoryForMode(messages, safeMode);
  const msgs = [{ role: 'system', content: systemPrompt }, ...history];
  const startedAt = Date.now();

  const body = {
    model,
    messages: msgs,
    max_tokens: maxTokens,
    temperature: _temp(opts),
    tools: _buildOpenAITools(tools),
    tool_choice: 'auto',
  };
  if (opts.onToken) body.stream = true;
  // Modelos de razonamiento (Qwen3/DeepSeek) vuelcan su chain-of-thought en el
  // content y ese CoT se filtra al usuario por el chat (también en el modo
  // tool-calling). Se desactiva el modo "thinking" por defecto; quien quiera
  // razonamiento lo pide con opts.enableThinking. El campo NO lo aceptan todos
  // los providers (Groq lo rechaza con HTTP 400) → solo a los que lo soportan;
  // el resto se cubre con _stripCot sobre el content.
  if (
    CHAT_TEMPLATE_KWARGS_PROVIDERS.has(providerId) &&
    /qwen3|deepseek/i.test(model) &&
    !opts.enableThinking
  ) {
    body.chat_template_kwargs = { enable_thinking: false };
  }

  logger.info(
    'LLMProvider',
    `[llm] ${providerId} tool-calling model: ${model} (${mode}, ${tools.length} tools)${opts.onToken ? ' [stream]' : ''}`
  );

  const headers = key ? { Authorization: `Bearer ${key}` } : {};
  const res = opts.onToken
    ? await postStream(
        `${def.baseURL}/chat/completions`,
        headers,
        body,
        opts.onToken,
        timeoutMs,
        opts.signal
      )
    : await post(`${def.baseURL}/chat/completions`, headers, body, timeoutMs, opts.signal);
  if (res.status !== 200) throw new Error(`${def.name} ${res.status}: ${JSON.stringify(res.body)}`);
  if (opts.onToken) {
    // postStream devolvió { content, tool_calls } con tool_calls en formato
    // OpenAI crudo ({ id, function: { name, arguments } }). Normalizamos a
    // { tool, params } como el resto del pipeline.
    const body = res.body || {};
    const toolCalls = (body.tool_calls || [])
      .filter((tc) => tc && tc.function)
      .map((tc) => {
        try {
          return { tool: tc.function.name, params: JSON.parse(tc.function.arguments), id: tc.id };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    _recordUsage(providerId, def, model, safeMode, {}, opts, startedAt);
    return { content: _stripCot(body.content), toolCalls: toolCalls.length > 0 ? toolCalls : null };
  }
  _recordUsage(providerId, def, model, safeMode, res.body, opts, startedAt);
  return _normalizeOpenAIResponse(res.body);
}

async function callGeminiWithTools(providerId, messages, systemPrompt, mode, tools, opts = {}) {
  const def = _registry.get(providerId);
  if (!def) throw new Error(`Provider desconocido: ${providerId}`);
  const key = _getApiKey(providerId);
  if (!key) throw new Error(`No API key para ${def.name}`);

  const safeMode = _resolveMode(mode);
  const model = _resolveModel(providerId, safeMode);
  const maxTokens = MAX_OUTPUT[safeMode];
  const timeoutMs = TIMEOUT_MS[safeMode] ?? TIMEOUT_MS.fast;
  const history = _trimHistoryForMode(messages, safeMode);
  const contents = history.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const startedAt = Date.now();

  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
    tools: _buildGeminiTools(tools),
    generationConfig: { maxOutputTokens: maxTokens, temperature: _temp(opts) },
  };
  // Gemini: el streaming se activa con `alt=sse` en la URL, no con `body.stream`.

  logger.info(
    'LLMProvider',
    `[llm] ${providerId} tool-calling model: ${model} (${mode}, ${tools.length} tools)${opts.onToken ? ' [stream]' : ''}`
  );

  // Gemini: el streaming se activa con `alt=sse` en la URL, no con `body.stream`.
  // La API key NO va en el query string (quedaría en logs de red/proxies):
  // va en el header `x-goog-api-key` (método documentado por Google).

  const res = await post(
    `${def.baseURL}/models/${model}:generateContent${opts.onToken ? '?alt=sse' : ''}`,
    { 'x-goog-api-key': key },
    body,
    timeoutMs,
    opts.signal
  );
  if (res.status !== 200) throw new Error(`${def.name} ${res.status}: ${JSON.stringify(res.body)}`);

  if (opts.onToken && typeof res.body === 'string') {
    _recordUsage(providerId, def, model, safeMode, {}, opts, startedAt);
    const sse = _parseGeminiSSE(res.body, opts.onToken);
    return {
      content: sse.text.trim() || null,
      toolCalls: sse.toolCalls.length > 0 ? sse.toolCalls : null,
    };
  }
  _recordUsage(providerId, def, model, safeMode, res.body, opts, startedAt);
  return _normalizeGeminiResponse(res.body);
}

function _getToolCaller(providerId) {
  const def = _registry.get(providerId);
  if (!def) return null;
  switch (def.type) {
    case 'openai':
      return callOpenAIWithTools;
    case 'gemini':
      return callGeminiWithTools;
    case 'anthropic':
      return callAnthropicWithTools;
    default:
      return null;
  }
}

// ── Fallback y retry ──────────────────────────────────────────────────────────
function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// sleep que aborta temprano si la señal de cancelación se dispara.
function _sleepAbortable(ms, signal) {
  return new Promise((resolve, reject) => {
    if (!signal) return setTimeout(resolve, ms);
    if (signal.aborted) return reject(_abortError());
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(_abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function _backoffWithJitter(attempt) {
  const base = RETRY_BASE_MS * Math.pow(2, attempt);
  const jitter = base * (0.7 + Math.random() * 0.6);
  return Math.round(jitter);
}

function _isRetryableError(err) {
  const msg = err?.message || '';
  if (err?.code === 'ABORTED' || err?.name === 'AbortError') return false;
  if (/^Timeout después de/i.test(msg)) return true;
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(msg))
    return true;
  const statusMatch = msg.match(/^(.+?) (\d{3}):/);
  if (statusMatch) {
    const status = parseInt(statusMatch[2], 10);
    return status === 429 || (status >= 500 && status < 600);
  }
  return false;
}

function _parseRetryAfter(err) {
  const msg = err?.message || '';
  // Groq/otros: "Please try again in 50m14.495999999s" — minutos + segundos.
  // OJO: el patrón m+s NO debe capturar "80ms" (milisegundos) como minutos —
  // el regex de minutos exige un dígito tras la m, así "80ms" cae en el caso
  // de milisegundos y devuelve 80ms, no 80 minutos.
  const both = msg.match(/try again in (\d+(?:\.\d+)?)m(\d+(?:\.\d+)+)s/i);
  if (both) return Math.ceil((parseFloat(both[1]) * 60 + parseFloat(both[2])) * 1000);
  const mins = msg.match(/try again in (\d+(?:\.\d+)?)m\b/i);
  if (mins) return Math.ceil(parseFloat(mins[1]) * 60 * 1000);
  const millis = msg.match(/try again in (\d+(?:\.\d+)?)ms/i);
  if (millis) return Math.ceil(parseFloat(millis[1]));
  const secs = msg.match(/try again in (\d+(?:\.\d+)?)s/i);
  return secs ? Math.ceil(parseFloat(secs[1]) * 1000) : 0;
}

// ── Fase 4: estado de degradación por provider ───────────────────────────────
// Cuando un provider entra en rate-limit con una espera larga, se recuerda
// durante un rato y la rotación lo SALTE A (va directo al fallback). Sin esto,
// un provider agotado (p. ej. Groq "try again in 50m") se martilla en CADA
// request del mismo período: reintenta, falla y solo después prueba el fallback,
// quemando latencia y tokens. La memoria se extiende con el retry-after real.
const _degradedProviders = new Map(); // providerId → { until: number, reason: string }
const DEGRADED_BASE_MS = 60_000; // memoria mínima (1 min)
const DEGRADED_TRIGGER_MS = 10_000; // degradar solo si la espera es "larga"

/** Marca un provider como degradado hasta `Date.now() + max(waitMs, base)`. */
function _markProviderDegraded(providerId, reason, waitMs = 0) {
  const until = Date.now() + Math.max(waitMs || 0, DEGRADED_BASE_MS);
  _degradedProviders.set(providerId, { until, reason });
  logger.info(
    'LLMProvider',
    `[llm] ${providerId} marcado DEGRADADO hasta ${new Date(until).toISOString()} (${reason})`
  );
  return until;
}

/** true mientras el provider esté en cooldown de degradación. */
function _isProviderDegraded(providerId) {
  const d = _degradedProviders.get(providerId);
  if (!d) return false;
  if (Date.now() > d.until) {
    _degradedProviders.delete(providerId);
    return false;
  }
  return true;
}

/**
 * Orden de rotación de providers teniendo en cuenta la degradación: los
 * providers degradados (en rate-limit con espera larga) se empujan al FINAL
 * conservando su orden relativo; el resto mantiene el orden configurado.
 * Así el primary degradado deja de martillarse y el fallback sano responde.
 */
function _rotationOrder() {
  const order = [_config.primary, ...(_config.fallback || [])];
  const healthy = [];
  const degraded = [];
  for (const p of order) {
    if (p && _isProviderDegraded(p)) degraded.push(p);
    else healthy.push(p);
  }
  return [...healthy, ...degraded];
}

// ── Fase J: cola de requests por provider ─────────────────────────────────────
const _queues = new Map(); // providerId → ProviderQueue

function _queueFor(providerId) {
  let q = _queues.get(providerId);
  if (!q) {
    q = new ProviderQueue({ concurrency: _config.queue?.concurrency ?? 1 });
    _queues.set(providerId, q);
  }
  return q;
}

function _enqueueProviderCall(providerId, run, opts = {}) {
  const qcfg = _config.queue || {};
  if (qcfg.enabled === false) return run();
  return _queueFor(providerId).submit(run, {
    priority: opts.priority ?? qcfg.priority ?? 0,
    maxWaitMs: opts.maxWaitMs ?? qcfg.maxWaitMs ?? MAX_RETRY_WAIT_MS,
  });
}

/** Stats de las colas por provider (para el reporte del benchmark / telemetría). */
function getQueueStats() {
  const out = {};
  for (const [id, q] of _queues) out[id] = q.stats;
  return out;
}

async function _callWithFallback(messages, systemPrompt, mode = 'fast', opts = {}) {
  const order = _rotationOrder();
  const tried = [];
  const missingKeys = [];
  const rateLimits = []; // { provider, waitMs } — 429/429-ish para dar consejo útil

  for (const providerName of order) {
    const fn = PROVIDERS[providerName];
    if (!fn) continue;
    if (!defHasKey(providerName)) {
      missingKeys.push(providerName);
      continue;
    }

    let lastErr = null;
    for (let attempt = 0; attempt <= MAX_RETRIES_PER_PROVIDER; attempt++) {
      try {
        if (attempt > 0) {
          const ra = _parseRetryAfter(lastErr);
          if (ra > MAX_RETRY_WAIT_MS) {
            tried.push(providerName);
            break;
          }
          const waitMs = ra > 0 ? ra : _backoffWithJitter(attempt - 1);
          logger.info(
            'LLMProvider',
            `[llm] reintentando ${providerName} en ${waitMs}ms (intento ${attempt + 1}/${MAX_RETRIES_PER_PROVIDER + 1})...`
          );
          await _sleepAbortable(waitMs, opts.signal);
        }
        logger.info(
          'LLMProvider',
          `[llm] intentando ${providerName} (${mode})${attempt > 0 ? ` [retry ${attempt}]` : ''}...`
        );
        const result = await _enqueueProviderCall(
          providerName,
          () => fn(messages, systemPrompt, mode, opts),
          opts
        );
        logger.info('LLMProvider', `[llm] respuesta de ${providerName} (${result.length} chars)`);
        return _stripForbiddenPhrases(result);
      } catch (e) {
        lastErr = e;
        if (e?.code === 'ABORTED' || e?.name === 'AbortError') throw e;
        const retryable = _isRetryableError(e);
        logger.info(
          'LLMProvider',
          `[llm] ${providerName} falló${retryable ? ' (transitorio)' : ' (no reintentable)'}: ${e.message}`
        );
        if (retryable && /(\b429\b|rate limit|quota|too many requests)/i.test(e.message)) {
          rateLimits.push({ provider: providerName, waitMs: _parseRetryAfter(e) });
          // Fase 4: espera larga → marcar degradado para que las próximas
          // requests vayan directo al fallback en vez de martillar el provider.
          const waitMs = _parseRetryAfter(e);
          if (waitMs >= DEGRADED_TRIGGER_MS) {
            _markProviderDegraded(providerName, 'rate-limit', waitMs);
          }
        }
        // Modelo retirado por el provider: elegir reemplazo vivo y reintentar
        // en el próximo attempt (fn resuelve el modelo por llamada vía
        // _resolveModel, así que el override en memoria alcanza).
        let modelRecovered = false;
        if (_isModelUnavailableError(e.message)) {
          try {
            modelRecovered = await _recoverDecommissionedModel(providerName, mode);
          } catch (_) {
            /* recuperación best-effort */
          }
        }
        // Si hubo reemplazo NO cortamos aunque el error sea "no reintentable":
        // el attempt siguiente ya usa el modelo nuevo.
        if ((!retryable && !modelRecovered) || attempt === MAX_RETRIES_PER_PROVIDER) {
          tried.push(providerName);
          break;
        }
      }
    }
  }
  if (tried.length > 0) {
    let msg = `Todos los providers fallaron: ${tried.join(', ')}`;
    if (rateLimits.length > 0) {
      rateLimits.sort((a, b) => b.waitMs - a.waitMs);
      const worst = rateLimits[0];
      const when =
        worst.waitMs > 0
          ? `vuelve a intentar en ~${Math.ceil(worst.waitMs / 60000)} min`
          : 'su cuota diaria puede estar agotada (los tiers gratis tienen límites)';
      msg += `. ${worst.provider} está en rate-limit — ${when} o cambia de proveedor con /model.`;
    }
    throw new Error(msg);
  }
  throw new Error(
    `Sin API key para: ${missingKeys.join(', ') || '(ninguno)'}. ` +
      'Todos los proveedores (incluso los "gratis") necesitan su propia API key — configúrala en el selector de modelos (tocá el modelo en la barra superior o escribí /model).'
  );
}

async function _callWithFallbackTools(messages, systemPrompt, mode = 'smart', tools, opts = {}) {
  if (!tools || tools.length === 0) {
    const text = await _callWithFallback(messages, systemPrompt, mode, opts);
    return { content: text, toolCalls: null };
  }

  const order = _rotationOrder();
  const tried = [];
  const missingKeys = [];

  for (const providerName of order) {
    const fn = PROVIDERS_WITH_TOOLS[providerName];
    if (!fn) continue;
    if (!defHasKey(providerName)) {
      missingKeys.push(providerName);
      continue;
    }

    let lastErr = null;
    // Tool-calling arranca SIEMPRE en 'smart': el catálogo completo (27 tools)
    // + system prompt (~7-8,5K tokens) excede el TPM del modelo fast de Groq
    // (llama-3.1-8b-instant, 6K) → HTTP 413 ~100% de las veces. Empezar por
    // 'fast' solo agrega latencia sin chance real de éxito; 'fast' queda solo
    // para las llamadas de texto puro (complete/completeTask).
    let callMode = 'smart';
    for (let attempt = 0; attempt <= MAX_RETRIES_PER_PROVIDER; attempt++) {
      try {
        if (attempt > 0) {
          const ra = _parseRetryAfter(lastErr);
          if (ra > MAX_RETRY_WAIT_MS) {
            tried.push(providerName);
            break;
          }
          const waitMs = ra > 0 ? ra : _backoffWithJitter(attempt - 1);
          await _sleepAbortable(waitMs, opts.signal);
        }
        const result = await _enqueueProviderCall(
          providerName,
          () => fn(messages, systemPrompt, callMode, tools, opts),
          opts
        );
        return { ...result, content: _stripForbiddenPhrases(result.content) };
      } catch (e) {
        lastErr = e;
        if (e?.code === 'ABORTED' || e?.name === 'AbortError') throw e;
        const retryable = _isRetryableError(e);
        logger.info(
          'LLMProvider',
          `[llm] ${providerName} tool-calling falló${retryable ? ' (transitorio)' : ' (no reintentable)'}: ${e.message}`
        );
        // Fase 4: espera larga en tool-calling → marcar degradado también aquí.
        if (retryable && /(\b429\b|rate limit|quota|too many requests)/i.test(e.message)) {
          const waitMs = _parseRetryAfter(e);
          if (waitMs >= DEGRADED_TRIGGER_MS) {
            _markProviderDegraded(providerName, 'rate-limit (tool-calling)', waitMs);
          }
        }
        // Modelo retirado: reemplazo vivo + reintento (igual que path de texto).
        let modelRecovered = false;
        if (_isModelUnavailableError(e.message)) {
          try {
            modelRecovered = await _recoverDecommissionedModel(providerName, mode);
          } catch (_) {
            /* recuperación best-effort */
          }
        }
        if ((!retryable && !modelRecovered) || attempt === MAX_RETRIES_PER_PROVIDER) {
          tried.push(providerName);
          break;
        }
      }
    }
  }

  logger.warn(
    'LLMProvider',
    `[llm] tool-calling falló en todos los providers (${tried.join(', ')})${missingKeys.length ? ` — sin key: ${missingKeys.join(', ')}` : ''}, fallback a texto`
  );
  // Fallback sin tools: el system prompt original enmarca al modelo como agente
  // con herramientas. Sin capacidad real de ejecutar nada, "sigue en personaje"
  // y narra acciones que nunca ejecutó. Se inyecta una nota que le obliga a
  // declarar su limitación en vez de fingir resultados.
  const fallbackPrompt =
    systemPrompt +
    '\n\nIMPORTANTE: en esta respuesta NO tenés acceso a herramientas ' +
    '(crear archivos, buscar en la web, ejecutar comandos, etc.). ' +
    'Si la tarea que te piden requiere alguna de esas capacidades, decilo explícitamente ' +
    "(ej: 'no puedo ejecutar esto ahora mismo, intentá de nuevo') — NUNCA " +
    'describas, narres o simules que ya la ejecutaste.';
  const text = await _callWithFallback(messages, fallbackPrompt, mode, opts);
  return { content: text, toolCalls: null };
}

function defHasKey(providerId) {
  return !!_getApiKey(providerId);
}

// Acceso main-process a la key resuelta (config/env/keychain). NO expone la
// key al renderer — es para el núcleo y tests. Fase 1: getAvailableProviders()
// ya no devuelve apiKey; esta es la vía explícita para quien la necesite.
function getResolvedApiKey(providerId) {
  return _getApiKey(providerId);
}

// ── Public API ────────────────────────────────────────────────────────────────
// Estas funciones NUNCA tienen acceso a tools reales (son "texto puro").
// Sin la nota anti-fabricación, el system prompt —que incluye catálogo de
// herramientas e instrucciones de uso— lleva al LLM a narrar acciones que
// nunca ejecuta. Se inyecta NO_TOOLS_NOTICE antes de pasar al LLM.
function complete(messages, systemPrompt, opts) {
  _rebuildMaps();
  return _callWithFallback(messages, systemPrompt + NO_TOOLS_NOTICE, 'fast', opts);
}

function completeTask(messages, systemPrompt, opts) {
  _rebuildMaps();
  return _callWithFallback(messages, systemPrompt + NO_TOOLS_NOTICE, 'smart', opts);
}

// Texto puro con modo explícito: los subagentes con perfil 'fast' bindean acá
// en vez de completeTask (que siempre usa 'smart') para su fallback textual.
function completeForMode(messages, systemPrompt, mode = 'fast', opts) {
  _rebuildMaps();
  return _callWithFallback(messages, systemPrompt + NO_TOOLS_NOTICE, mode, opts);
}

async function completeWithTools(messages, systemPrompt, tools = [], mode = 'smart', opts) {
  _rebuildMaps();
  const result = await _callWithFallbackTools(messages, systemPrompt, mode, tools, opts);
  return { ...result, content: _stripForbiddenPhrases(result.content) };
}

function getActiveProvider() {
  const order = _rotationOrder();
  for (const name of order) {
    if (defHasKey(name)) return name;
  }
  return null;
}

function getActiveModel(mode = 'fast') {
  const provider = getActiveProvider();
  if (!provider) return null;
  return _resolveModel(provider, mode);
}

function getAvailableProviders() {
  const all = getProviders();
  return all.map((p) => ({
    id: p.id,
    name: p.name,
    type: p.type,
    builtin: !!p.builtin,
    free: !!p.free,
    custom: !!p.custom,
    remote: !!p.remote,
    hasKey: !!_getApiKey(p.id),
    baseURL: p.baseURL,
    models: p.models,
    // Fase Q: el selector de modelos muestra el catálogo completo del
    // provider (estático o refrescado) y qué modelo está activo por modo.
    catalog: _providerCatalog(p.id),
    // Fase catálogo: metadata por modelo (label, contexto, tools, visión,
    // coste) para que la UI recomiende y advierta sin IDs crudos.
    modelMeta: p.modelMeta || {},
    activeModel: { fast: _resolveModel(p.id, 'fast'), smart: _resolveModel(p.id, 'smart') },
  }));
}

function addCustomProvider(def) {
  const id = def.id || def.name.toLowerCase().replace(/[^a-z0-9]/g, '-');
  registerProvider({ ...def, id, custom: true });
  _config.customProviders = _config.customProviders || [];
  if (!_config.customProviders.find((c) => c.id === id)) {
    _config.customProviders.push({ ...def, id });
  }
  _rebuildMaps();
  return id;
}

// ── Selector modelo-first (nivel opencode) ───────────────────────────────────
// El picker de modelos une provider + credenciales + modelos en un solo flujo:
// lista todos los modelos del catálogo (curado + remoto de models.dev) y, al
// elegir uno, conecta el provider si hace falta (registro + key) y asigna el
// modelo al rol. Estas funciones corren en el main process; el renderer solo
// ve proyecciones sin secretos (getModelPickerData).

/** Mapea el paquete AI SDK de models.dev al tipo de caller del pipeline. */
function _mapNpmToType(npm) {
  if (!npm) return 'other';
  if (
    /openai-compatible|@ai-sdk\/openai$|@ai-sdk\/groq|@ai-sdk\/mistral|@ai-sdk\/xai|togetherai|cerebras|deepinfra|perplexity|openrouter|gateway/.test(
      npm
    )
  )
    return 'openai';
  if (/anthropic/.test(npm)) return 'anthropic';
  if (/google|gemini/.test(npm)) return 'gemini';
  return 'other';
}

const DEFAULT_BASE_URL = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
};

// Estados de provider para el picker: registry (built-in/custom) + remotos de
// models.dev aún no conectados. Nunca incluye keys.
function _providerPickerStates() {
  const byId = new Map();
  for (const p of getProviders()) {
    byId.set(p.id, {
      id: p.id,
      name: p.name,
      type: p.type,
      free: !!p.free,
      builtin: !!p.builtin,
      custom: !!p.custom,
      remote: false,
      hasKey: !!_getApiKey(p.id),
      connectable: true,
    });
  }
  for (const info of getRemoteProviders()) {
    const type = _mapNpmToType(info.npm);
    // Conectable solo si el pipeline tiene un caller para ese tipo
    // (openai/anthropic/gemini). Un SDK nicho con endpoint (cohere, bedrock…)
    // no tiene caller → requiere /provider add, aunque models.dev dé api.
    const connectable = type !== 'other';
    if (byId.has(info.id)) {
      const s = byId.get(info.id);
      s.remote = true;
      s.hasKey = !!_getApiKey(info.id);
    } else {
      byId.set(info.id, {
        id: info.id,
        name: info.name,
        type,
        free: false,
        builtin: false,
        custom: false,
        remote: true,
        hasKey: !!_getApiKey(info.id),
        connectable,
        api: info.api || null,
        doc: info.doc || null,
        env: info.env || [],
        npm: info.npm || null,
        modelCount: info.modelCount,
      });
    }
  }
  return [...byId.values()];
}

function _pushPickerModel(models, seen, providerId, modelId, meta, remote) {
  const key = `${providerId}\u0000${modelId}`;
  if (seen.has(key)) return;
  seen.add(key);
  const m = meta || {};
  models.push({
    providerId,
    modelId,
    label: (m.label && String(m.label)) || modelId,
    context: typeof m.context === 'number' ? m.context : 0,
    maxOutput: typeof m.maxOutput === 'number' ? m.maxOutput : 0,
    tools: !!m.tools,
    vision: !!m.vision,
    reasoning: !!m.reasoning,
    free: !!m.free,
    costIn: m.cost && typeof m.cost.in === 'number' ? m.cost.in : 0,
    costOut: m.cost && typeof m.cost.out === 'number' ? m.cost.out : 0,
    remote: !!remote,
  });
}

/**
 * Datos completos del selector de modelos (sin secretos). Une el catálogo
 * curado (registry) con el remoto (models.dev), marca conectados y favoritos.
 * @returns {object}
 */
/**
 * Modelos que el picker muestra por defecto (sin query): solo proveedores con
 * API key configurada (`hasKey`) + favoritos. El resto del catálogo remoto
 * (400+ providers de models.dev) queda oculto hasta buscar o togglear
 * "ver todos". Orden: favoritos primero, luego providerId alfabético.
 * @param {Array<{id: string, hasKey?: boolean}>} providers
 * @param {Array<{providerId: string, modelId: string}>} models
 * @param {Array<string>} favorites keys "providerId/modelId"
 * @returns {Array<{providerId: string, modelId: string}>}
 */
function computeDefaultPickerRows(providers, models, favorites) {
  const byId = new Map(providers.map((p) => [p.id, p]));
  const favs = new Set(Array.isArray(favorites) ? favorites : []);
  const key = (m) => `${m.providerId}/${m.modelId}`;
  const rows = models.filter((m) => {
    const p = byId.get(m.providerId) || {};
    return !!p.hasKey || favs.has(key(m));
  });
  rows.sort(
    (a, b) =>
      (favs.has(key(a)) ? 0 : 1) - (favs.has(key(b)) ? 0 : 1) ||
      a.providerId.localeCompare(b.providerId)
  );
  return rows;
}

function getModelPickerData() {
  const providers = _providerPickerStates();
  const registry = new Map(getProviders().map((p) => [p.id, p]));
  const models = [];
  const seen = new Set();
  for (const ps of providers) {
    const def = registry.get(ps.id);
    if (def) {
      const metas = def.modelMeta || {};
      const ids = Object.keys(metas).length > 0 ? Object.keys(metas) : def.catalog || [];
      for (const mid of ids) {
        _pushPickerModel(
          models,
          seen,
          ps.id,
          mid,
          metas[mid] || null,
          !!(metas[mid] && metas[mid].remote)
        );
      }
    } else if (_remoteCatalog && _remoteCatalog[ps.id]) {
      for (const [mid, meta] of Object.entries(_remoteCatalog[ps.id])) {
        _pushPickerModel(models, seen, ps.id, mid, meta, true);
      }
    }
  }
  const favorites = Array.isArray(_config.favorites) ? [..._config.favorites] : [];
  return {
    roles: ROLE_LABELS,
    active: {
      provider: getActiveProvider(),
      fast: getActiveModel('fast'),
      smart: getActiveModel('smart'),
    },
    favorites,
    providers,
    models,
    defaultModels: computeDefaultPickerRows(providers, models, favorites),
  };
}

/**
 * Conecta un provider y (opcionalmente) asigna un modelo a un rol. Si el
 * provider no está en el registry, lo registra como custom usando la info de
 * conexión de models.dev (mapeo npm→tipo + baseURL). Guarda la key en el
 * llavero si está disponible; si no, en _config.providers[id].apiKey (el IPC
 * handler persiste en config.json y recarga).
 * @param {{providerId: string, apiKey?: string, modelId?: string, mode?: 'fast'|'smart'}} opts
 * @returns {{ok: boolean, error?: string, provider?: object}}
 */
function connectProvider({ providerId, apiKey, modelId, mode } = {}) {
  if (!providerId) return { ok: false, error: 'provider requerido' };
  let def = _registry.get(providerId);
  const remote = getRemoteProvider(providerId);

  if (!def) {
    if (!remote) return { ok: false, error: `provider desconocido: ${providerId}` };
    const type = _mapNpmToType(remote.npm);
    if (type === 'other') {
      return {
        ok: false,
        error: `${remote.name} no es conectable automáticamente (SDK ${remote.npm || 'desconocido'}). Elegí un modelo de un provider conectable.`,
      };
    }
    const baseURL = remote.api || DEFAULT_BASE_URL[type] || null;
    if (!baseURL) {
      return { ok: false, error: `${remote.name} no expone un endpoint conectable.` };
    }
    const metas = (_remoteCatalog && _remoteCatalog[providerId]) || {};
    const catalog = Object.keys(metas);
    const defaults = catalog[0] ? { fast: catalog[0], smart: catalog[0] } : null;
    def = {
      id: providerId,
      name: remote.name,
      type,
      baseURL,
      models: defaults || { fast: null, smart: null },
      catalog,
      modelMeta: metas,
      custom: true,
      remote: true,
      free: false,
    };
    registerProvider(def);
    _config.customProviders = _config.customProviders || [];
    if (!_config.customProviders.find((c) => c.id === providerId)) {
      _config.customProviders.push({
        id: providerId,
        name: remote.name,
        type,
        baseURL,
        models: def.models,
        catalog,
      });
    }
    _rebuildMaps();
  }

  if (apiKey && typeof apiKey === 'string' && apiKey.trim()) {
    const stored = storeProviderApiKey(providerId, apiKey.trim());
    // Disponible de inmediato para _getApiKey: en el llavero (config guarda
    // apiKey:'' y el overlay la recupera al recargar) o como fallback en
    // config/providers cuando el llavero no está.
    _config.providers[providerId] = {
      ...(_config.providers[providerId] || {}),
      apiKey: apiKey.trim(),
    };
    if (stored) {
      // El llavero manda; config solo recuerda que existe (no la key).
      _config.providers[providerId].apiKey = '';
      _applyKeychainOverlay();
    }
  }

  const model = modelId || def.models?.smart || def.models?.fast || null;
  if (model) {
    const prev = {
      ...((_config.providers[providerId] && _config.providers[providerId].model) || {}),
    };
    if (mode === 'fast' || mode === 'smart') prev[mode] = model;
    else {
      prev.fast = model;
      prev.smart = model;
    }
    _config.providers[providerId] = { ...(_config.providers[providerId] || {}), model: prev };
  }

  if (_getApiKey(providerId)) _config.primary = providerId;

  return {
    ok: true,
    provider: {
      id: providerId,
      name: def.name,
      type: def.type,
      hasKey: !!_getApiKey(providerId),
      fast: _resolveModel(providerId, 'fast'),
      smart: _resolveModel(providerId, 'smart'),
    },
  };
}

/** Favorito: key "providerId/modelId". Devuelve true si cambió el estado. */
function setFavoriteModel(modelKey, on) {
  if (typeof modelKey !== 'string' || !modelKey) return false;
  _config.favorites = Array.isArray(_config.favorites)
    ? _config.favorites.filter((f) => f !== modelKey)
    : [];
  if (on) _config.favorites.push(modelKey);
  return true;
}

function getFavorites() {
  return Array.isArray(_config.favorites) ? [..._config.favorites] : [];
}

function removeCustomProvider(id) {
  const def = _registry.get(id);
  if (def && def.builtin) throw new Error(`No se puede eliminar el provider built-in: ${id}`);
  _registry.delete(id);
  _config.customProviders = (_config.customProviders || []).filter((c) => c.id !== id);
  delete _config.providers[id];
  if (_config.primary === id) _config.primary = 'groq';
  _config.fallback = (_config.fallback || []).filter((f) => f !== id);
  _rebuildMaps();
}

// ── Metadata de modelos (catálogo) ────────────────────────────────────────────
// El registry es la fuente viva (incluye lo que el catálogo remoto añadió);
// el catálogo curado es el fallback de los built-ins.

/** Metadata de un modelo: curada/remota del registry, si no del catálogo. */
function getModelMeta(providerId, modelId) {
  const def = _registry.get(providerId);
  if (def && def.modelMeta && def.modelMeta[modelId]) return def.modelMeta[modelId];
  return getCuratedModelMeta(providerId, modelId);
}

/** Metadata del provider (registry o catálogo curado). */
function getProviderMeta(providerId) {
  const def = _registry.get(providerId);
  if (def) return { ...def };
  return getCuratedProviderDef(providerId);
}

/**
 * Resuelve un token a un id de modelo del provider: id exacto, alias del
 * catálogo o substring (case-insensitive) sobre el catálogo vivo.
 */
function resolveModelId(providerId, token) {
  const curated = resolveCuratedModelId(providerId, token);
  if (curated) return curated;
  const def = _registry.get(providerId);
  if (!def || !token) return null;
  const t = String(token).trim().toLowerCase();
  const ids = [
    ...(Array.isArray(def.catalog) ? def.catalog : []),
    ...Object.keys(def.modelMeta || {}),
  ];
  return ids.find((id) => id.toLowerCase().includes(t)) || null;
}

module.exports = {
  configure,
  complete,
  completeTask,
  completeForMode,
  completeWithTools,
  getActiveProvider,
  getActiveModel,
  getResolvedApiKey,
  getAvailableProviders,
  addCustomProvider,
  removeCustomProvider,
  getToolSchemas: () => require('./ToolSchemas.js').TOOL_SCHEMAS,
  registerProvider,
  getQueueStats,
  listModels,
  refreshProviderModels,
  refreshRemoteCatalog,
  setCatalogCachePath,
  getModelMeta,
  getProviderMeta,
  resolveModelId,
  getModelPickerData,
  computeDefaultPickerRows,
  connectProvider,
  setFavoriteModel,
  getFavorites,
  getRemoteProviders,
  getRemoteProvider,
  ROLE_LABELS,
  resolveRole,
  storeProviderApiKey,
  removeProviderApiKey,
  migrateApiKeysToKeychain,
  _setKeychainResolver,
  _debug_enqueueProviderCall: _enqueueProviderCall,
  _debug_normalizeOpenAI: _normalizeOpenAIResponse,
  _debug_stripCot: _stripCot,
  _debug_normalizeGemini: _normalizeGeminiResponse,
  _debug_normalizeAnthropic: _normalizeAnthropicResponse,
  _debug_buildOpenAITools: _buildOpenAITools,
  _debug_buildGeminiTools: _buildGeminiTools,
  _debug_buildAnthropicTools: _buildAnthropicTools,
  _debug_getToolCaller: _getToolCaller,
  _debug_callAnthropicWithTools: callAnthropicWithTools,
  _debug_postStream: postStream,
  _debug_post: post,
  _debug_get: get,
  setUsageTracker,
  getUsageTracker,
  _debug_recordUsage: _recordUsage,
  _debug_resolveModel: _resolveModel,
  _debug_rotationOrder: _rotationOrder,
  _debug_markProviderDegraded: _markProviderDegraded,
  _debug_isProviderDegraded: _isProviderDegraded,
  _debug_degradedProviders: _degradedProviders,
  _debug_callWithFallbackTools: _callWithFallbackTools,
  _debug_stripForbiddenPhrases: _stripForbiddenPhrases,
  _debug_setToolCaller(providerId, fn) {
    if (typeof fn !== 'function') {
      _injectedToolCallers.delete(providerId);
      return;
    }
    _injectedToolCallers.set(providerId, (_id, m, s, mode, tools, opts) =>
      fn(m, s, mode, tools, opts)
    );
  },
  _debug_setCaller(providerId, fn) {
    if (typeof fn !== 'function') {
      _injectedCallers.delete(providerId);
      return;
    }
    _injectedCallers.set(providerId, (_id, m, s, mode, opts) => fn(m, s, mode, opts));
  },
};
