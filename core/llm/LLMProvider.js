'use strict';

const https = require('https');
const http  = require('http');

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
  id: 'groq', name: 'Groq', type: 'openai',
  baseURL: 'https://api.groq.com/openai/v1',
  models: { fast: 'llama-3.1-8b-instant', smart: 'llama-3.3-70b-versatile' },
  builtin: true, free: true,
});

registerProvider({
  id: 'gemini', name: 'Google Gemini', type: 'gemini',
  baseURL: 'https://generativelanguage.googleapis.com/v1beta',
  models: { fast: 'gemini-2.0-flash', smart: 'gemini-2.0-flash' },
  builtin: true, free: true,
});

registerProvider({
  id: 'openai', name: 'OpenAI', type: 'openai',
  baseURL: 'https://api.openai.com/v1',
  models: { fast: 'gpt-4o-mini', smart: 'gpt-4o-mini' },
  builtin: true,
});

registerProvider({
  id: 'anthropic', name: 'Anthropic', type: 'anthropic',
  baseURL: 'https://api.anthropic.com/v1',
  models: { fast: 'claude-3-haiku-20240307', smart: 'claude-3-sonnet-20240229' },
  builtin: true,
});

registerProvider({
  id: 'xai', name: 'xAI (Grok)', type: 'openai',
  baseURL: 'https://api.x.ai/v1',
  models: { fast: 'grok-beta', smart: 'grok-beta' },
  builtin: true,
});

registerProvider({
  id: 'nvidia', name: 'NVIDIA Nemotron', type: 'openai',
  baseURL: 'https://integrate.api.nvidia.com/v1',
  models: { fast: 'nvidia/nemotron-3-ultra', smart: 'nvidia/nemotron-3-ultra' },
  builtin: true, free: true,
});

registerProvider({
  id: 'huggingface', name: 'Hugging Face', type: 'openai',
  baseURL: 'https://api-inference.huggingface.co/v1',
  models: { fast: 'meta-llama/Llama-3.2-3B-Instruct', smart: 'meta-llama/Llama-3.3-70B-Instruct' },
  builtin: true, free: true,
});

registerProvider({
  id: 'deepseek', name: 'DeepSeek', type: 'openai',
  baseURL: 'https://api.deepseek.com/v1',
  models: { fast: 'deepseek-chat', smart: 'deepseek-reasoner' },
  builtin: true, free: true,
});

// ── Límites ────────────────────────────────────────────────────────────────────
const MAX_OUTPUT = { fast: 1024, smart: 3072 };
const TIMEOUT_MS = { fast: 15_000, smart: 60_000 };
const FAST_HISTORY_LIMIT = 8;
const VALID_MODES = new Set(['fast', 'smart']);
const MAX_RETRIES_PER_PROVIDER = 1;
const RETRY_BASE_MS = 2000;

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
};

function configure(cfg) {
  if (!cfg) return;
  const llm = cfg.llm || cfg;
  if (llm.primary) _config.primary = llm.primary;
  if (llm.fallback) _config.fallback = llm.fallback;
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
}

function _getApiKey(providerId) {
  const p = _config.providers[providerId];
  if (p && p.apiKey && p.apiKey.trim()) return p.apiKey.trim();
  return null;
}

function _getModels(providerId) {
  const def = _registry.get(providerId);
  if (!def) return null;
  return def.models || null;
}

// ── Helper HTTP ───────────────────────────────────────────────────────────────
function post(url, headers, body, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const lib     = parsed.protocol === 'https:' ? https : http;
    const payload = JSON.stringify(body);
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers },
    };
    options.agent = AGENT_BY_PROTOCOL[parsed.protocol] || lib.globalAgent;
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { reject(new Error(`${res.statusCode} JSON parse error: ${data.slice(0, 200)}`)); }
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`Timeout después de ${timeoutMs}ms`)); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Generic OpenAI-compatible caller ──────────────────────────────────────────
async function callOpenAI(providerId, messages, systemPrompt, mode = 'fast') {
  const def = _registry.get(providerId);
  if (!def) throw new Error(`Provider desconocido: ${providerId}`);
  const key = _getApiKey(providerId);
  if (!key && !def.free) throw new Error(`No API key para ${def.name}`);

  const safeMode  = _resolveMode(mode);
  const model     = def.models?.[safeMode];
  const maxTokens = MAX_OUTPUT[safeMode];
  const timeoutMs = TIMEOUT_MS[safeMode] ?? TIMEOUT_MS.fast;
  const history   = _trimHistoryForMode(messages, safeMode);
  const msgs      = [{ role: 'system', content: systemPrompt }, ...history];

  console.log(`[llm] ${providerId} model: ${model} (${safeMode}, max_tokens=${maxTokens}, history=${history.length}msg, timeout=${timeoutMs}ms)`);

  const headers = key ? { Authorization: `Bearer ${key}` } : {};
  const res = await post(
    `${def.baseURL}/chat/completions`,
    headers,
    { model, messages: msgs, max_tokens: maxTokens, temperature: 0.85 },
    timeoutMs
  );
  if (res.status !== 200) throw new Error(`${def.name} ${res.status}: ${JSON.stringify(res.body)}`);
  return (res.body.choices[0].message.content || '').trim();
}

// ── Generic Gemini caller ─────────────────────────────────────────────────────
async function callGeminiProvider(providerId, messages, systemPrompt, mode = 'fast') {
  const def = _registry.get(providerId);
  if (!def) throw new Error(`Provider desconocido: ${providerId}`);
  const key = _getApiKey(providerId);
  if (!key) throw new Error(`No API key para ${def.name}`);

  const safeMode  = _resolveMode(mode);
  const model     = def.models?.[safeMode];
  const maxTokens = MAX_OUTPUT[safeMode];
  const timeoutMs = TIMEOUT_MS[safeMode] ?? TIMEOUT_MS.fast;
  const history   = _trimHistoryForMode(messages, safeMode);
  const contents  = history.map(m => ({
    role:  m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  console.log(`[llm] ${providerId} model: ${model} (${safeMode}, max_tokens=${maxTokens}, history=${history.length}msg, timeout=${timeoutMs}ms)`);

  const res = await post(
    `${def.baseURL}/models/${model}:generateContent?key=${key}`,
    {},
    {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.85 },
    },
    timeoutMs
  );
  if (res.status !== 200) throw new Error(`${def.name} ${res.status}: ${JSON.stringify(res.body)}`);
  return (res.body.candidates[0]?.content?.parts?.[0]?.text || '').trim();
}

// ── Generic Anthropic caller ──────────────────────────────────────────────────
async function callAnthropic(providerId, messages, systemPrompt, mode = 'fast') {
  const def = _registry.get(providerId);
  if (!def) throw new Error(`Provider desconocido: ${providerId}`);
  const key = _getApiKey(providerId);
  if (!key) throw new Error(`No API key para ${def.name}`);

  const safeMode  = _resolveMode(mode);
  const model     = def.models?.[safeMode];
  const maxTokens = MAX_OUTPUT[safeMode];
  const timeoutMs = TIMEOUT_MS[safeMode] ?? TIMEOUT_MS.fast;
  const history   = _trimHistoryForMode(messages, safeMode);

  const msgs = history.map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
  }));

  console.log(`[llm] ${providerId} model: ${model} (${safeMode}, max_tokens=${maxTokens}, history=${history.length}msg, timeout=${timeoutMs}ms)`);

  const res = await post(
    `${def.baseURL}/messages`,
    { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    { model, messages: msgs, system: systemPrompt, max_tokens: maxTokens, temperature: 0.85 },
    timeoutMs
  );
  if (res.status !== 200) throw new Error(`${def.name} ${res.status}: ${JSON.stringify(res.body)}`);
  const content = res.body.content;
  if (!content) return '';
  return content.map(c => c.text || '').join('').trim();
}

// ── Dispatcher ────────────────────────────────────────────────────────────────
function _getCaller(providerId) {
  const def = _registry.get(providerId);
  if (!def) return null;
  switch (def.type) {
    case 'openai': return callOpenAI;
    case 'gemini': return callGeminiProvider;
    case 'anthropic': return callAnthropic;
    default: return null;
  }
}

const PROVIDERS = {};
const PROVIDERS_WITH_TOOLS = {};

function _rebuildMaps() {
  for (const [id] of _registry) {
    const fn = _getCaller(id);
    if (fn) PROVIDERS[id] = (m, s, mode) => fn(id, m, s, mode);
    const fnTools = _getToolCaller(id);
    if (fnTools) PROVIDERS_WITH_TOOLS[id] = (m, s, mode, tools) => fnTools(id, m, s, mode, tools);
  }
}

// ── Tool-calling ──────────────────────────────────────────────────────────────
const { TOOL_SCHEMAS } = require('./ToolSchemas.js');

function _buildOpenAITools(tools) {
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: (t.description || '').slice(0, 1024),
      parameters: t.inputSchema,
    },
  }));
}

function _buildGeminiTools(tools) {
  return [{
    function_declarations: tools.map(t => ({
      name: t.name,
      description: (t.description || '').slice(0, 1024),
      parameters: t.inputSchema,
    })),
  }];
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
    .filter(tc => tc.type === 'function')
    .map(tc => {
      try {
        const params = JSON.parse(tc.function.arguments);
        return { tool: tc.function.name, params, id: tc.id };
      } catch { return null; }
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
    if (part.functionCall) toolCalls.push({ tool: part.functionCall.name, params: part.functionCall.args || {} });
  }
  return { content: (content || '').trim() || null, toolCalls: toolCalls.length > 0 ? toolCalls : null };
}

async function callOpenAIWithTools(providerId, messages, systemPrompt, mode, tools) {
  const def = _registry.get(providerId);
  if (!def) throw new Error(`Provider desconocido: ${providerId}`);
  const key = _getApiKey(providerId);
  if (!key && !def.free) throw new Error(`No API key para ${def.name}`);

  const safeMode  = _resolveMode(mode);
  const model     = def.models?.[safeMode];
  const maxTokens = MAX_OUTPUT[safeMode];
  const timeoutMs = TIMEOUT_MS[safeMode] ?? TIMEOUT_MS.fast;
  const history   = _trimHistoryForMode(messages, safeMode);
  const msgs      = [{ role: 'system', content: systemPrompt }, ...history];

  const body = {
    model, messages: msgs, max_tokens: maxTokens, temperature: 0.85,
    tools: _buildOpenAITools(tools), tool_choice: 'auto',
  };

  console.log(`[llm] ${providerId} tool-calling model: ${model} (${mode}, ${tools.length} tools)`);

  const headers = key ? { Authorization: `Bearer ${key}` } : {};
  const res = await post(`${def.baseURL}/chat/completions`, headers, body, timeoutMs);
  if (res.status !== 200) throw new Error(`${def.name} ${res.status}: ${JSON.stringify(res.body)}`);
  return _normalizeOpenAIResponse(res.body);
}

async function callGeminiWithTools(providerId, messages, systemPrompt, mode, tools) {
  const def = _registry.get(providerId);
  if (!def) throw new Error(`Provider desconocido: ${providerId}`);
  const key = _getApiKey(providerId);
  if (!key) throw new Error(`No API key para ${def.name}`);

  const safeMode  = _resolveMode(mode);
  const model     = def.models?.[safeMode];
  const maxTokens = MAX_OUTPUT[safeMode];
  const timeoutMs = TIMEOUT_MS[safeMode] ?? TIMEOUT_MS.fast;
  const history   = _trimHistoryForMode(messages, safeMode);
  const contents  = history.map(m => ({
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
    {}, body, timeoutMs
  );
  if (res.status !== 200) throw new Error(`${def.name} ${res.status}: ${JSON.stringify(res.body)}`);
  return _normalizeGeminiResponse(res.body);
}

function _getToolCaller(providerId) {
  const def = _registry.get(providerId);
  if (!def) return null;
  switch (def.type) {
    case 'openai': return callOpenAIWithTools;
    case 'gemini': return callGeminiWithTools;
    default: return null;
  }
}

// ── Fallback y retry ──────────────────────────────────────────────────────────
function _sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function _backoffWithJitter(attempt) {
  const base = RETRY_BASE_MS * Math.pow(2, attempt);
  const jitter = base * (0.7 + Math.random() * 0.6);
  return Math.round(jitter);
}

function _isRetryableError(err) {
  const msg = err?.message || '';
  if (/^Timeout después de/i.test(msg)) return true;
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(msg)) return true;
  const statusMatch = msg.match(/^(.+?) (\d{3}):/);
  if (statusMatch) {
    const status = parseInt(statusMatch[2], 10);
    return status === 429 || (status >= 500 && status < 600);
  }
  return false;
}

function _parseRetryAfter(err) {
  const m = err?.message?.match(/try again in ([\d.]+)s/);
  return m ? Math.ceil(parseFloat(m[1]) * 1000) : 0;
}

async function _callWithFallback(messages, systemPrompt, mode = 'fast') {
  const order = [_config.primary, ...(_config.fallback || [])];
  const tried = [];

  for (const providerName of order) {
    const fn = PROVIDERS[providerName];
    if (!fn) continue;
    if (!defHasKey(providerName)) continue;

    let lastErr = null;
    for (let attempt = 0; attempt <= MAX_RETRIES_PER_PROVIDER; attempt++) {
      try {
        if (attempt > 0) {
          const ra = _parseRetryAfter(lastErr);
          const waitMs = ra > 0 ? ra : _backoffWithJitter(attempt - 1);
          console.log(`[llm] reintentando ${providerName} en ${waitMs}ms (intento ${attempt + 1}/${MAX_RETRIES_PER_PROVIDER + 1})...`);
          await _sleep(waitMs);
        }
        console.log(`[llm] intentando ${providerName} (${mode})${attempt > 0 ? ` [retry ${attempt}]` : ''}...`);
        const result = await fn(messages, systemPrompt, mode);
        console.log(`[llm] respuesta de ${providerName} (${result.length} chars)`);
        return result;
      } catch(e) {
        lastErr = e;
        const retryable = _isRetryableError(e);
        console.log(`[llm] ${providerName} falló${retryable ? ' (transitorio)' : ' (no reintentable)'}: ${e.message}`);
        if (!retryable || attempt === MAX_RETRIES_PER_PROVIDER) {
          tried.push(providerName);
          break;
        }
      }
    }
  }
  throw new Error(`Todos los providers fallaron: ${tried.join(', ')}`);
}

async function _callWithFallbackTools(messages, systemPrompt, mode = 'smart', tools) {
  if (!tools || tools.length === 0) {
    const text = await _callWithFallback(messages, systemPrompt, mode);
    return { content: text, toolCalls: null };
  }

  const order = [_config.primary, ...(_config.fallback || [])];
  const tried = [];

  for (const providerName of order) {
    const fn = PROVIDERS_WITH_TOOLS[providerName];
    if (!fn) continue;
    if (!defHasKey(providerName)) continue;

    let lastErr = null;
    for (let attempt = 0; attempt <= MAX_RETRIES_PER_PROVIDER; attempt++) {
      try {
        if (attempt > 0) {
          const ra = _parseRetryAfter(lastErr);
          const waitMs = ra > 0 ? ra : _backoffWithJitter(attempt - 1);
          await _sleep(waitMs);
        }
        const result = await fn(messages, systemPrompt, mode, tools);
        return result;
      } catch(e) {
        lastErr = e;
        const retryable = _isRetryableError(e);
        if (!retryable || attempt === MAX_RETRIES_PER_PROVIDER) {
          tried.push(providerName);
          break;
        }
      }
    }
  }

  console.warn(`[llm] tool-calling falló en todos los providers (${tried.join(', ')}), fallback a texto`);
  const text = await _callWithFallback(messages, systemPrompt, mode);
  return { content: text, toolCalls: null };
}

function defHasKey(providerId) {
  return !!_getApiKey(providerId);
}

// ── Public API ────────────────────────────────────────────────────────────────
function complete(messages, systemPrompt) {
  _rebuildMaps();
  return _callWithFallback(messages, systemPrompt, 'fast');
}

function completeTask(messages, systemPrompt) {
  _rebuildMaps();
  return _callWithFallback(messages, systemPrompt, 'smart');
}

async function completeWithTools(messages, systemPrompt, tools = [], mode = 'smart') {
  _rebuildMaps();
  return _callWithFallbackTools(messages, systemPrompt, mode, tools);
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
  return all.map(p => ({
    id: p.id, name: p.name, type: p.type, builtin: !!p.builtin,
    free: !!p.free, custom: !!p.custom,
    hasKey: !!_getApiKey(p.id),
    baseURL: p.baseURL, models: p.models,
    apiKey: _config.providers[p.id]?.apiKey || '',
  }));
}

function addCustomProvider(def) {
  const id = def.id || def.name.toLowerCase().replace(/[^a-z0-9]/g, '-');
  registerProvider({ ...def, id, custom: true });
  _config.customProviders = _config.customProviders || [];
  if (!_config.customProviders.find(c => c.id === id)) {
    _config.customProviders.push({ ...def, id });
  }
  _rebuildMaps();
  return id;
}

function removeCustomProvider(id) {
  const def = _registry.get(id);
  if (def && def.builtin) throw new Error(`No se puede eliminar el provider built-in: ${id}`);
  _registry.delete(id);
  _config.customProviders = (_config.customProviders || []).filter(c => c.id !== id);
  delete _config.providers[id];
  if (_config.primary === id) _config.primary = 'groq';
  _config.fallback = (_config.fallback || []).filter(f => f !== id);
  _rebuildMaps();
}

function getCustomProviders() {
  return _config.customProviders || [];
}

module.exports = {
  configure, complete, completeTask, completeWithTools,
  getActiveProvider, getActiveModel,
  getAvailableProviders, getProvider, getProviders, getProviderNames,
  addCustomProvider, removeCustomProvider, getCustomProviders,
  getToolSchemas: () => require('./ToolSchemas.js').TOOL_SCHEMAS,
  registerProvider,
  _debug_isRetryableError: _isRetryableError,
  _debug_backoffWithJitter: _backoffWithJitter,
  _debug_normalizeOpenAI: _normalizeOpenAIResponse,
  _debug_normalizeGemini: _normalizeGeminiResponse,
  _debug_buildOpenAITools: _buildOpenAITools,
  _debug_buildGeminiTools: _buildGeminiTools,
};
