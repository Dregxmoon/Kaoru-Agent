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
// Catálogo estático de modelos por proveedor. Es el fallback de la lista
// "todos los modelos disponibles" que muestra el selector: si el proveedor
// expone GET /models (OpenAI-compatible), refreshProviderModels() consulta la
// lista viva y la interseca con este catálogo estático (solo se ofrecen
// modelos curados que la cuenta del usuario realmente tiene accesibles — evita
// listar modelos que devuelven 404 "Function not found" por no estar
// desplegados en la cuenta); si no, esta es la que se muestra.
const MODEL_CATALOG = {
  groq: [
    'llama-3.1-8b-instant',
    'llama-3.1-70b-versatile',
    'llama-3.3-70b-versatile',
    'llama-3.2-3b-preview',
    'llama-3.2-11b-vision-preview',
    'llama-3.2-90b-vision-preview',
    'gemma2-9b-it',
    'gemma2-27b-it',
    'mixtral-8x7b-32768',
    'deepseek-r1-distill-llama-70b',
    'openai/gpt-oss-120b',
    'openai/gpt-oss-20b',
  ],
  gemini: [
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
    'gemini-2.0-pro',
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-1.5-flash',
    'gemini-1.5-flash-8b',
    'gemini-1.5-pro',
  ],
  openai: [
    'gpt-4o-mini',
    'gpt-4o',
    'gpt-4.1-mini',
    'gpt-4.1',
    'gpt-4.1-nano',
    'gpt-4-turbo',
    'gpt-4',
    'o3-mini',
    'o4-mini',
    'gpt-5',
    'gpt-5-mini',
  ],
  anthropic: [
    'claude-3-haiku-20240307',
    'claude-3-sonnet-20240229',
    'claude-3-opus-20240229',
    'claude-3-5-haiku-latest',
    'claude-3-5-sonnet-latest',
    'claude-3-7-sonnet-latest',
    'claude-4-sonnet',
    'claude-4-opus',
  ],
  xai: ['grok-beta', 'grok-2', 'grok-2-1212', 'grok-3', 'grok-3-mini', 'grok-3-fast'],
  nvidia: [
    'meta/llama-3.3-70b-instruct',
    'meta/llama-3.1-70b-instruct',
    'meta/llama-3.1-8b-instruct',
    'meta/llama-3.2-11b-vision-instruct',
    'mistralai/mistral-large-2-instruct',
    'mistralai/mixtral-8x22b-v0.1',
    'minimaxai/minimax-m3',
    'nvidia/nemotron-3-nano-30b-a3b',
    'nvidia/nemotron-3-super-120b-a12b',
    'nvidia/llama-3.3-nemotron-super-49b-v1.5',
    'openai/gpt-oss-120b',
    'openai/gpt-oss-20b',
    'z-ai/glm-5.2',
    'stepfun-ai/step-3.7-flash',
    'google/gemma-3-12b-it',
    'google/gemma-3-4b-it',
    'google/gemma-4-31b-it',
    'ai21labs/jamba-1.5-large-instruct',
  ],
  huggingface: [
    'meta-llama/Llama-3.2-3B-Instruct',
    'meta-llama/Llama-3.3-70B-Instruct',
    'mistralai/Mistral-7B-Instruct-v0.3',
    'google/gemma-2-27b-it',
    'Qwen/Qwen2.5-7B-Instruct',
  ],
  deepseek: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v3.1', 'deepseek-r1', 'deepseek-v4'],
};

registerProvider({
  id: 'groq',
  name: 'Groq',
  type: 'openai',
  baseURL: 'https://api.groq.com/openai/v1',
  models: { fast: 'llama-3.1-8b-instant', smart: 'llama-3.3-70b-versatile' },
  catalog: MODEL_CATALOG.groq,
  builtin: true,
  free: true,
});

registerProvider({
  id: 'gemini',
  name: 'Google Gemini',
  type: 'gemini',
  baseURL: 'https://generativelanguage.googleapis.com/v1beta',
  models: { fast: 'gemini-2.0-flash', smart: 'gemini-2.0-flash' },
  catalog: MODEL_CATALOG.gemini,
  builtin: true,
  free: true,
});

registerProvider({
  id: 'openai',
  name: 'OpenAI',
  type: 'openai',
  baseURL: 'https://api.openai.com/v1',
  models: { fast: 'gpt-4o-mini', smart: 'gpt-4o-mini' },
  catalog: MODEL_CATALOG.openai,
  builtin: true,
});

registerProvider({
  id: 'anthropic',
  name: 'Anthropic',
  type: 'anthropic',
  baseURL: 'https://api.anthropic.com/v1',
  models: { fast: 'claude-3-haiku-20240307', smart: 'claude-3-sonnet-20240229' },
  catalog: MODEL_CATALOG.anthropic,
  builtin: true,
});

registerProvider({
  id: 'xai',
  name: 'xAI (Grok)',
  type: 'openai',
  baseURL: 'https://api.x.ai/v1',
  models: { fast: 'grok-beta', smart: 'grok-beta' },
  catalog: MODEL_CATALOG.xai,
  builtin: true,
});

registerProvider({
  id: 'nvidia',
  name: 'NVIDIA Builds',
  type: 'openai',
  baseURL: 'https://integrate.api.nvidia.com/v1',
  models: { fast: 'openai/gpt-oss-20b', smart: 'minimaxai/minimax-m3' },
  catalog: MODEL_CATALOG.nvidia,
  timeoutMs: { fast: 45_000, smart: 120_000 },
  builtin: true,
  free: true,
});

registerProvider({
  id: 'huggingface',
  name: 'Hugging Face',
  type: 'openai',
  baseURL: 'https://api-inference.huggingface.co/v1',
  models: { fast: 'meta-llama/Llama-3.2-3B-Instruct', smart: 'meta-llama/Llama-3.3-70B-Instruct' },
  catalog: MODEL_CATALOG.huggingface,
  builtin: true,
  free: true,
});

registerProvider({
  id: 'deepseek',
  name: 'DeepSeek',
  type: 'openai',
  baseURL: 'https://api.deepseek.com/v1',
  models: { fast: 'deepseek-chat', smart: 'deepseek-reasoner' },
  catalog: MODEL_CATALOG.deepseek,
  builtin: true,
  free: true,
});

// ── Límites ────────────────────────────────────────────────────────────────────
const MAX_OUTPUT = { fast: 1024, smart: 3072 };
const TIMEOUT_MS = { fast: 15_000, smart: 60_000 };
const FAST_HISTORY_LIMIT = 8;
const VALID_MODES = new Set(['fast', 'smart']);
const MAX_RETRIES_PER_PROVIDER = 1;
const RETRY_BASE_MS = 2000;
// Si un rate-limit dice "espera > 30s", no lo esperamos de forma síncrona
// (una request no puede quedar colgada 50 min): fallamos ya y el mensaje
// final le avisa al usuario cuánto esperar o que cambie de proveedor.
const MAX_RETRY_WAIT_MS = 30_000;

// TTL del catálogo validado contra el endpoint del provider: evitar pegarle a
// la API en cada invocación de /model <provider> o del selector de modelos.
// Pasado el TTL, refreshProviderModels() re-valida contra GET /models.
const CATALOG_REFRESH_TTL_MS = 5 * 60 * 1000;

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
  for (const [id, def] of _registry) {
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
      const parseDelta = (delta) => {
        if (delta && typeof delta.content === 'string' && delta.content.length > 0) {
          content += delta.content;
          try {
            onToken && onToken(delta.content);
          } catch (_) {}
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
        const toolCallsOut = toolCalls
          .filter((tc) => tc && tc.name && tc.arguments)
          .map((tc) => ({ id: tc.id, function: { name: tc.name, arguments: tc.arguments } }));
        resolve({
          status: res.statusCode,
          body: { content, tool_calls: toolCallsOut.length > 0 ? toolCallsOut : null },
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
  const body = { model, messages: msgs, max_tokens: maxTokens, temperature: 0.85 };
  if (opts.onToken) body.stream = true;

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
  if (opts.onToken) return (res.body.content || '').trim();
  return (res.body.choices[0].message.content || '').trim();
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
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.85 },
  };
  // OJO: para Gemini el streaming NO se activa con el campo `stream` en el
  // body (generateContent no lo acepta → 400 "Unknown name stream"). Se
  // activa con `alt=sse` en la URL (más abajo). No poner body.stream aquí.

  const res = await post(
    `${def.baseURL}/models/${model}:generateContent?key=${key}${opts.onToken ? '&alt=sse' : ''}`,
    {},
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
        } catch (_) {}
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

function _rebuildMaps() {
  for (const [id] of _registry) {
    const fn = _getCaller(id);
    if (fn) PROVIDERS[id] = (m, s, mode, opts) => fn(id, m, s, mode, opts);
    const fnTools = _getToolCaller(id);
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
  if (!rawCalls || rawCalls.length === 0) return { content, toolCalls: null };
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
  return { content, toolCalls: toolCalls.length > 0 ? toolCalls : null };
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
    temperature: 0.85,
    tools: _buildOpenAITools(tools),
    tool_choice: 'auto',
  };
  if (opts.onToken) body.stream = true;

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
    return { content: body.content || null, toolCalls: toolCalls.length > 0 ? toolCalls : null };
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
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.85 },
  };
  // Gemini: el streaming se activa con `alt=sse` en la URL, no con `body.stream`.

  logger.info(
    'LLMProvider',
    `[llm] ${providerId} tool-calling model: ${model} (${mode}, ${tools.length} tools)${opts.onToken ? ' [stream]' : ''}`
  );

  const res = await post(
    `${def.baseURL}/models/${model}:generateContent?key=${key}${opts.onToken ? '&alt=sse' : ''}`,
    {},
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
  const order = [_config.primary, ...(_config.fallback || [])];
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
        return result;
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
        }
        if (!retryable || attempt === MAX_RETRIES_PER_PROVIDER) {
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
      'Todos los proveedores (incluso los "gratis") necesitan su propia API key — configúrala con /credenciales.'
  );
}

async function _callWithFallbackTools(messages, systemPrompt, mode = 'smart', tools, opts = {}) {
  if (!tools || tools.length === 0) {
    const text = await _callWithFallback(messages, systemPrompt, mode, opts);
    return { content: text, toolCalls: null };
  }

  const order = [_config.primary, ...(_config.fallback || [])];
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
          () => fn(messages, systemPrompt, mode, tools, opts),
          opts
        );
        return result;
      } catch (e) {
        lastErr = e;
        if (e?.code === 'ABORTED' || e?.name === 'AbortError') throw e;
        const retryable = _isRetryableError(e);
        if (!retryable || attempt === MAX_RETRIES_PER_PROVIDER) {
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
  const text = await _callWithFallback(messages, systemPrompt, mode, opts);
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
function complete(messages, systemPrompt, opts) {
  _rebuildMaps();
  return _callWithFallback(messages, systemPrompt, 'fast', opts);
}

function completeTask(messages, systemPrompt, opts) {
  _rebuildMaps();
  return _callWithFallback(messages, systemPrompt, 'smart', opts);
}

async function completeWithTools(messages, systemPrompt, tools = [], mode = 'smart', opts) {
  _rebuildMaps();
  return _callWithFallbackTools(messages, systemPrompt, mode, tools, opts);
}

function getActiveProvider() {
  const order = [_config.primary, ...(_config.fallback || [])];
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
    hasKey: !!_getApiKey(p.id),
    baseURL: p.baseURL,
    models: p.models,
    // Fase Q: el selector de modelos muestra el catálogo completo del
    // provider (estático o refrescado) y qué modelo está activo por modo.
    catalog: _providerCatalog(p.id),
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

module.exports = {
  configure,
  complete,
  completeTask,
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
  storeProviderApiKey,
  removeProviderApiKey,
  migrateApiKeysToKeychain,
  _setKeychainResolver,
  _debug_enqueueProviderCall: _enqueueProviderCall,
  _debug_normalizeOpenAI: _normalizeOpenAIResponse,
  _debug_normalizeGemini: _normalizeGeminiResponse,
  _debug_buildOpenAITools: _buildOpenAITools,
  _debug_buildGeminiTools: _buildGeminiTools,
  _debug_postStream: postStream,
  _debug_post: post,
  _debug_get: get,
  setUsageTracker,
  getUsageTracker,
  _debug_recordUsage: _recordUsage,
  _debug_resolveModel: _resolveModel,
};
