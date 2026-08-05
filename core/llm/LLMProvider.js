'use strict';

const https = require('https');
const http = require('http');

const { ProviderQueue } = require('./RequestQueue.js');

const KEEP_ALIVE_AGENT = new https.Agent({ keepAlive: true, maxSockets: 4 });
const KEEP_ALIVE_AGENT_HTTP = new http.Agent({ keepAlive: true, maxSockets: 4 });
const AGENT_BY_PROTOCOL = {
  'https:': KEEP_ALIVE_AGENT,
  'http:': KEEP_ALIVE_AGENT_HTTP,
};

// ── Provider registry ──────────────────────────────────────────────────────────
const _registry = new Map();

function registerProvider(def) {
  if (_registry.has(def.id)) {
    console.warn(`[llm] provider "${def.id}" ya registrado — se reemplaza`);
  }
  _registry.set(def.id, { ...def });
}

function getProvider(id) {
  return _registry.get(id) || null;
}

function getProviders() {
  return [..._registry.values()];
}

function getProviderNames() {
  return [..._registry.keys()];
}

// ── Built-in providers ─────────────────────────────────────────────────────────
registerProvider({
  id: 'groq',
  name: 'Groq',
  type: 'openai',
  baseURL: 'https://api.groq.com/openai/v1',
  models: { fast: 'llama-3.1-8b-instant', smart: 'llama-3.3-70b-versatile' },
  builtin: true,
  free: true,
});

registerProvider({
  id: 'gemini',
  name: 'Google Gemini',
  type: 'gemini',
  baseURL: 'https://generativelanguage.googleapis.com/v1beta',
  models: { fast: 'gemini-2.0-flash', smart: 'gemini-2.0-flash' },
  builtin: true,
  free: true,
});

registerProvider({
  id: 'openai',
  name: 'OpenAI',
  type: 'openai',
  baseURL: 'https://api.openai.com/v1',
  models: { fast: 'gpt-4o-mini', smart: 'gpt-4o-mini' },
  builtin: true,
});

registerProvider({
  id: 'anthropic',
  name: 'Anthropic',
  type: 'anthropic',
  baseURL: 'https://api.anthropic.com/v1',
  models: { fast: 'claude-3-haiku-20240307', smart: 'claude-3-sonnet-20240229' },
  builtin: true,
});

registerProvider({
  id: 'xai',
  name: 'xAI (Grok)',
  type: 'openai',
  baseURL: 'https://api.x.ai/v1',
  models: { fast: 'grok-beta', smart: 'grok-beta' },
  builtin: true,
});

registerProvider({
  id: 'nvidia',
  name: 'NVIDIA Nemotron',
  type: 'openai',
  baseURL: 'https://integrate.api.nvidia.com/v1',
  models: { fast: 'nvidia/nemotron-3-ultra', smart: 'nvidia/nemotron-3-ultra' },
  builtin: true,
  free: true,
});

registerProvider({
  id: 'huggingface',
  name: 'Hugging Face',
  type: 'openai',
  baseURL: 'https://api-inference.huggingface.co/v1',
  models: { fast: 'meta-llama/Llama-3.2-3B-Instruct', smart: 'meta-llama/Llama-3.3-70B-Instruct' },
  builtin: true,
  free: true,
});

registerProvider({
  id: 'deepseek',
  name: 'DeepSeek',
  type: 'openai',
  baseURL: 'https://api.deepseek.com/v1',
  models: { fast: 'deepseek-chat', smart: 'deepseek-reasoner' },
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

// ── Helper HTTP ───────────────────────────────────────────────────────────────
function post(url, headers, body, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
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
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          reject(new Error(`${res.statusCode} JSON parse error: ${data.slice(0, 200)}`));
        }
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`Timeout después de ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// POST con streaming SSE (OpenAI-compatible /chat/completions con stream:true).
// onToken(text) se invoca por cada fragmento de texto; el body acumulado se
// resuelve como { status, body: { content, tool_calls } } al final del stream.
function postStream(url, headers, body, onToken, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
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
      req.destroy();
      reject(new Error(`Timeout después de ${timeoutMs}ms`));
    });
    req.on('error', reject);
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
  const model = def.models?.[safeMode];
  const maxTokens = MAX_OUTPUT[safeMode];
  const timeoutMs = TIMEOUT_MS[safeMode] ?? TIMEOUT_MS.fast;
  const history = _trimHistoryForMode(messages, safeMode);
  const msgs = [{ role: 'system', content: systemPrompt }, ...history];

  console.log(
    `[llm] ${providerId} model: ${model} (${safeMode}, max_tokens=${maxTokens}, history=${history.length}msg, timeout=${timeoutMs}ms)${opts.onToken ? ' [stream]' : ''}`
  );

  const headers = key ? { Authorization: `Bearer ${key}` } : {};
  const body = { model, messages: msgs, max_tokens: maxTokens, temperature: 0.85 };
  if (opts.onToken) body.stream = true;

  const res = opts.onToken
    ? await postStream(`${def.baseURL}/chat/completions`, headers, body, opts.onToken, timeoutMs)
    : await post(`${def.baseURL}/chat/completions`, headers, body, timeoutMs);
  if (res.status !== 200) throw new Error(`${def.name} ${res.status}: ${JSON.stringify(res.body)}`);
  return (res.body.choices[0].message.content || '').trim();
}

// ── Generic Gemini caller ─────────────────────────────────────────────────────
async function callGeminiProvider(providerId, messages, systemPrompt, mode = 'fast', opts = {}) {
  const def = _registry.get(providerId);
  if (!def) throw new Error(`Provider desconocido: ${providerId}`);
  const key = _getApiKey(providerId);
  if (!key) throw new Error(`No API key para ${def.name}`);

  const safeMode = _resolveMode(mode);
  const model = def.models?.[safeMode];
  const maxTokens = MAX_OUTPUT[safeMode];
  const timeoutMs = TIMEOUT_MS[safeMode] ?? TIMEOUT_MS.fast;
  const history = _trimHistoryForMode(messages, safeMode);
  const contents = history.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  console.log(
    `[llm] ${providerId} model: ${model} (${safeMode}, max_tokens=${maxTokens}, history=${history.length}msg, timeout=${timeoutMs}ms)${opts.onToken ? ' [stream]' : ''}`
  );

  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.85 },
  };
  if (opts.onToken) body.stream = true;

  const res = await post(
    `${def.baseURL}/models/${model}:generateContent?key=${key}${opts.onToken ? '&alt=sse' : ''}`,
    {},
    body,
    timeoutMs
  );
  if (res.status !== 200) throw new Error(`${def.name} ${res.status}: ${JSON.stringify(res.body)}`);
  // Gemini stream (alt=sse) devuelve el body como string SSE en data — si
  // llegó como JSON normal, extraemos directo; si es SSE, parseamos fragmentos.
  if (opts.onToken && typeof res.body === 'string') {
    const full = _parseGeminiSSE(res.body, opts.onToken);
    return full.trim();
  }
  return (res.body.candidates[0]?.content?.parts?.[0]?.text || '').trim();
}

function _parseGeminiSSE(raw, onToken) {
  let out = '';
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
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
    if (text) {
      out += text;
      try {
        onToken && onToken(text);
      } catch (_) {}
    }
  }
  return out;
}

// ── Generic Anthropic caller ──────────────────────────────────────────────────
async function callAnthropic(providerId, messages, systemPrompt, mode = 'fast') {
  const def = _registry.get(providerId);
  if (!def) throw new Error(`Provider desconocido: ${providerId}`);
  const key = _getApiKey(providerId);
  if (!key) throw new Error(`No API key para ${def.name}`);

  const safeMode = _resolveMode(mode);
  const model = def.models?.[safeMode];
  const maxTokens = MAX_OUTPUT[safeMode];
  const timeoutMs = TIMEOUT_MS[safeMode] ?? TIMEOUT_MS.fast;
  const history = _trimHistoryForMode(messages, safeMode);

  const msgs = history.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
  }));

  console.log(
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
  const model = def.models?.[safeMode];
  const maxTokens = MAX_OUTPUT[safeMode];
  const timeoutMs = TIMEOUT_MS[safeMode] ?? TIMEOUT_MS.fast;
  const history = _trimHistoryForMode(messages, safeMode);
  const msgs = [{ role: 'system', content: systemPrompt }, ...history];

  const body = {
    model,
    messages: msgs,
    max_tokens: maxTokens,
    temperature: 0.85,
    tools: _buildOpenAITools(tools),
    tool_choice: 'auto',
  };
  if (opts.onToken) body.stream = true;

  console.log(
    `[llm] ${providerId} tool-calling model: ${model} (${mode}, ${tools.length} tools)${opts.onToken ? ' [stream]' : ''}`
  );

  const headers = key ? { Authorization: `Bearer ${key}` } : {};
  const res = opts.onToken
    ? await postStream(`${def.baseURL}/chat/completions`, headers, body, opts.onToken, timeoutMs)
    : await post(`${def.baseURL}/chat/completions`, headers, body, timeoutMs);
  if (res.status !== 200) throw new Error(`${def.name} ${res.status}: ${JSON.stringify(res.body)}`);
  if (opts.onToken) {
    // postStream devolvió { content, tool_calls } ya normalizados a OpenAI
    return _normalizeOpenAIResponse({ choices: [{ message: res.body }] });
  }
  return _normalizeOpenAIResponse(res.body);
}

async function callGeminiWithTools(providerId, messages, systemPrompt, mode, tools) {
  const def = _registry.get(providerId);
  if (!def) throw new Error(`Provider desconocido: ${providerId}`);
  const key = _getApiKey(providerId);
  if (!key) throw new Error(`No API key para ${def.name}`);

  const safeMode = _resolveMode(mode);
  const model = def.models?.[safeMode];
  const maxTokens = MAX_OUTPUT[safeMode];
  const timeoutMs = TIMEOUT_MS[safeMode] ?? TIMEOUT_MS.fast;
  const history = _trimHistoryForMode(messages, safeMode);
  const contents = history.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
    tools: _buildGeminiTools(tools),
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.85 },
  };

  console.log(`[llm] ${providerId} tool-calling model: ${model} (${mode}, ${tools.length} tools)`);

  const res = await post(
    `${def.baseURL}/models/${model}:generateContent?key=${key}`,
    {},
    body,
    timeoutMs
  );
  if (res.status !== 200) throw new Error(`${def.name} ${res.status}: ${JSON.stringify(res.body)}`);
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

function _backoffWithJitter(attempt) {
  const base = RETRY_BASE_MS * Math.pow(2, attempt);
  const jitter = base * (0.7 + Math.random() * 0.6);
  return Math.round(jitter);
}

function _isRetryableError(err) {
  const msg = err?.message || '';
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
  const both = msg.match(/try again in (\d+(?:\.\d+)?)m(\d+(?:\.\d+)?)?s/i);
  if (both) return Math.ceil((parseFloat(both[1]) * 60 + (parseFloat(both[2]) || 0)) * 1000);
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
          console.log(
            `[llm] reintentando ${providerName} en ${waitMs}ms (intento ${attempt + 1}/${MAX_RETRIES_PER_PROVIDER + 1})...`
          );
          await _sleep(waitMs);
        }
        console.log(
          `[llm] intentando ${providerName} (${mode})${attempt > 0 ? ` [retry ${attempt}]` : ''}...`
        );
        const result = await _enqueueProviderCall(
          providerName,
          () => fn(messages, systemPrompt, mode, opts),
          opts
        );
        console.log(`[llm] respuesta de ${providerName} (${result.length} chars)`);
        return result;
      } catch (e) {
        lastErr = e;
        const retryable = _isRetryableError(e);
        console.log(
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
          await _sleep(waitMs);
        }
        const result = await _enqueueProviderCall(
          providerName,
          () => fn(messages, systemPrompt, mode, tools, opts),
          opts
        );
        return result;
      } catch (e) {
        lastErr = e;
        const retryable = _isRetryableError(e);
        if (!retryable || attempt === MAX_RETRIES_PER_PROVIDER) {
          tried.push(providerName);
          break;
        }
      }
    }
  }

  console.warn(
    `[llm] tool-calling falló en todos los providers (${tried.join(', ')})${missingKeys.length ? ` — sin key: ${missingKeys.join(', ')}` : ''}, fallback a texto`
  );
  const text = await _callWithFallback(messages, systemPrompt, mode, opts);
  return { content: text, toolCalls: null };
}

function defHasKey(providerId) {
  return !!_getApiKey(providerId);
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
  const def = _registry.get(provider);
  return def?.models?.[mode] ?? null;
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
    apiKey: _config.providers[p.id]?.apiKey || '',
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

function getCustomProviders() {
  return _config.customProviders || [];
}

module.exports = {
  configure,
  complete,
  completeTask,
  completeWithTools,
  getActiveProvider,
  getActiveModel,
  getAvailableProviders,
  getProvider,
  getProviders,
  getProviderNames,
  addCustomProvider,
  removeCustomProvider,
  getCustomProviders,
  getToolSchemas: () => require('./ToolSchemas.js').TOOL_SCHEMAS,
  registerProvider,
  getQueueStats,
  storeProviderApiKey,
  removeProviderApiKey,
  migrateApiKeysToKeychain,
  _setKeychainResolver,
  _debug_isRetryableError: _isRetryableError,
  _debug_backoffWithJitter: _backoffWithJitter,
  _debug_enqueueProviderCall: _enqueueProviderCall,
  _debug_normalizeOpenAI: _normalizeOpenAIResponse,
  _debug_normalizeGemini: _normalizeGeminiResponse,
  _debug_buildOpenAITools: _buildOpenAITools,
  _debug_buildGeminiTools: _buildGeminiTools,
};
