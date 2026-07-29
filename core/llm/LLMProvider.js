/**
 * LLMProvider.js — Fase 0 v5
 *
 * Cambios v4 → v5 (Kimi K2 para modo 'task'/'smart'):
 *   El usuario pidió poder elegir, desde la interfaz de chat, entre un
 *   modelo "conversacional" (barato, calmado — lo que ya hacía 'fast')
 *   y un modelo "de tareas" para trabajo exhaustivo: programar, leer
 *   documentación, usar OpenClaw. La opción evaluada fue Kimi K2.
 *
 *   Requisito explícito: debía ser gratis o de nivel gratuito.
 *
 *   La API oficial de Moonshot (platform.moonshot.ai) NO tiene nivel
 *   gratuito — exige tarjeta y mínimo $10 de crédito. La alternativa
 *   real es que GROQ hospeda Kimi K2 directamente en su propio tier
 *   gratuito (moonshotai/kimi-k2-instruct-0905, 1000 req/día, 10000
 *   TPM, sin tarjeta) — el MISMO endpoint y la MISMA API key de Groq
 *   que ya está configurada. No se agregó ningún proveedor nuevo ni
 *   ningún campo de key nuevo: Kimi es, para este código, simplemente
 *   otro string de modelo dentro de MODELS.groq.
 *
 *   Se reutilizó el modo 'smart' que ya existía (en vez de crear un
 *   modo nuevo) porque ya significaba exactamente esto: "tareas
 *   complejas... edición de archivos, análisis de código, razonamiento
 *   largo". Ese modo hoy es invocado:
 *     (a) internamente por Planner._llmTransform vía completeTask(), y
 *     (b) ahora también puede invocarse desde el toggle de la UI del
 *         chat (pendiente de conectar en chat.html) cuando el usuario
 *         elija "modo tareas" en vez de "modo conversación".
 *
 *   AVISO DE CAMBIO DE COMPORTAMIENTO: esto significa que las llamadas
 *   YA EXISTENTES de Planner._llmTransform (vía completeTask) dejan de
 *   usar llama-3.3-70b-versatile y pasan a usar Kimi K2. Es una mejora
 *   esperada (Kimi rinde mejor que Llama 3.3 70B en benchmarks de
 *   coding/agentic), pero es un cambio real de comportamiento, no solo
 *   una adición — documentado aquí para que no sea una sorpresa si el
 *   estilo de las transformaciones de archivo cambia ligeramente.
 *
 *   Ajustes de presupuesto para smart/Kimi:
 *     - MAX_OUTPUT.smart: 3072 (sin cambio — Kimi razona internamente
 *       antes de responder, así que más output no necesariamente
 *       ayuda, y el tier gratuito de Groq para este modelo es de
 *       10,000 TPM — hay que ser conservador).
 *     - TIMEOUT_MS.smart: 45s → 60s, porque Kimi puede tardar más en
 *       tareas de razonamiento/herramientas que Llama 3.3 70B.
 *   MODELS.gemini.smart y MODELS.openai.smart quedan sin cambios — son
 *   el fallback si la key de Groq falta o se agota el tier gratuito de
 *   Kimi; en ese caso el modo 'smart' deja de ser "Kimi" y pasa a ser
 *   el modelo smart normal de ese proveedor (no hay Kimi gratis fuera
 *   de Groq, así que el fallback no puede ofrecer Kimi en otro lado).
 *
 * Cambios v3 → v4 (mantenidos):
 *   Sin timeout en la llamada HTTP real — post() nunca tenía un límite
 *   de tiempo propio. Si un proveedor (típicamente Groq) se quedaba
 *   colgado sin responder (no un error, simplemente sin respuesta), la
 *   promesa de post() nunca resolvía ni rechazaba. Como _callWithFallback
 *   solo avanza al siguiente proveedor cuando el await lanza un error
 *   (catch), un colgado sin error nunca disparaba el fallback — el chat
 *   completo se quedaba esperando para siempre una respuesta que no iba
 *   a llegar. Esto también era la causa de fondo de por qué main.js
 *   necesitó un timeout externo de seguridad en closeSession() — esa fue
 *   una curita en el síntoma, esto es el arreglo de la causa real.
 *
 *   Fix: post() ahora acepta un timeoutMs y usa req.setTimeout() (igual
 *   que ya hacía OpenClawBridge.postJSON, que nunca tuvo este problema).
 *   Al vencer el timeout se destruye la request y se rechaza con un
 *   error real — eso sí dispara el catch en _callWithFallback y pasa
 *   correctamente al siguiente proveedor en la lista.
 *
 *   TIMEOUT_MS diferenciado por modo, igual que MAX_OUTPUT: fast es
 *   conversación normal (no debería tardar mucho, 15s es generoso),
 *   smart puede estar generando/transformando archivos grandes
 *   (Planner._llmTransform), así que se le da más margen.
 *
 * Cambios v2 → v3 (mantenidos):
 *   Consumo excesivo de tokens — antes TODAS las llamadas (fast y smart)
 *   reservaban max_tokens: 4096 sin importar la tarea. Eso por sí solo no
 *   gasta tokens si el modelo responde corto, pero combinado con un
 *   historial sin recortar en modo fast, el INPUT crecía con cada turno
 *   de la conversación hasta comerse el límite de TPM de Groq (rate
 *   limit 429 visto en producción con llama-3.1-8b-instant: 20,000 TPM).
 *
 *   Fix aplicado:
 *     1. MAX_OUTPUT diferenciado por modo — fast reserva mucho menos
 *        output que smart, porque una respuesta conversacional normal
 *        no necesita 4096 tokens de salida.
 *     2. Truncado de historial SOLO en modo fast — las tareas smart
 *        (edit_file, completeTask) necesitan el contexto completo para
 *        razonar bien sobre archivos largos, pero el chat normal no
 *        necesita arrastrar toda la conversación, solo lo reciente.
 *     3. _buildModelConfig() centraliza el cálculo de max_tokens para
 *        no repetirlo en cada función de proveedor (Groq/Gemini/OpenAI).
 *
 *   La firma pública (complete / completeTask) no cambia — internamente
 *   ambas siguen llamando a _callWithFallback con el modo correspondiente.
 */

const https = require('https');
const http  = require('http');

const KEEP_ALIVE_AGENT = new https.Agent({ keepAlive: true, maxSockets: 4 });
const KEEP_ALIVE_AGENT_HTTP = new http.Agent({ keepAlive: true, maxSockets: 4 });
const AGENT_BY_PROTOCOL = {
  'https:': KEEP_ALIVE_AGENT,
  'http:': KEEP_ALIVE_AGENT_HTTP,
};

// ── Modelos por proveedor ─────────────────────────────────────────────────────
const MODELS = {
  groq: {
    fast:  'llama-3.1-8b-instant',          // 6,000-30,000 TPM — conversación rápida
    // v5.1: Kimi K2 (0905) fue DEPRECADO por Groq el 23 de marzo de 2026
    // (confirmado en console.groq.com/docs/deprecations) — el 404 "model
    // does not exist" no era un problema de cuenta, el modelo ya no
    // existe en Groq. El propio aviso de deprecación de Groq recomienda
    // openai/gpt-oss-120b como reemplazo — también gratis en el mismo
    // tier, sin key nueva, mismo endpoint. "openai/" es solo el nombre
    // del modelo (OpenAI lo liberó como open-weight) — sigue corriendo
    // 100% en la infraestructura de Groq con tu key de Groq, no llama a
    // la API de OpenAI.
    smart: 'openai/gpt-oss-120b',
  },
  gemini: {
    fast:  'gemini-2.0-flash',
    smart: 'gemini-2.0-flash',          // mismo modelo, Gemini no tiene límite por modelo
  },
  openai: {
    fast:  'gpt-4o-mini',
    smart: 'gpt-4o-mini',              // cambiar a 'gpt-4o' si tienes créditos
  },
};

// ── Límite de tokens de OUTPUT por modo ───────────────────────────────────────
// fast  — conversación normal de March: respuestas cortas, no necesitan
//         reservar más de ~1024 tokens de salida. Reservar 4096 aquí era
//         puro desperdicio de cupo de TPM sin beneficio real, porque el
//         modelo casi nunca generaba respuestas tan largas en modo chat.
// smart — edición de archivos, análisis de código, razonamiento largo
//         (Planner._llmTransform, completeTask), y desde v5 también el
//         "modo tareas" de la UI (Kimi K2). Aquí SÍ puede hacer falta
//         devolver archivos completos o explicaciones extensas, así que
//         se mantiene un límite más generoso — pero sin pasarse, porque
//         el tier gratuito de Kimi en Groq es de solo 10,000 TPM.
const MAX_OUTPUT = {
  fast:  1024,
  smart: 3072,
};

// ── Timeout de la llamada HTTP por modo ───────────────────────────────────────
// fast  — conversación normal, no debería tardar mucho. 15s es generoso
//         para una respuesta corta; si se cuelga más que eso, mejor
//         fallar y pasar al siguiente proveedor que seguir esperando.
// smart — puede estar generando contenido largo (archivos completos,
//         transformaciones de código) o, desde v5, razonando con Kimi K2
//         en tareas de herramientas — se le da más margen que antes
//         (45s → 60s) porque Kimi puede tardar más que Llama 3.3 70B
//         en tareas de razonamiento/tool-use.
const TIMEOUT_MS = {
  fast:  15_000,
  smart: 60_000,
};

// ── Recorte de historial por modo ─────────────────────────────────────────────
// En modo fast no tiene sentido reenviar toda la conversación al LLM en
// cada turno — el grounding ya resume lo importante en el systemPrompt,
// así que solo los últimos N mensajes aportan contexto inmediato real.
// En modo smart SÍ se respeta el historial completo, porque tareas como
// editar un archivo o razonar sobre código (o, desde v5, el modo tareas
// con Kimi) necesitan todo el contexto que el llamador decidió incluir.
const FAST_HISTORY_LIMIT = 8; // últimos 8 mensajes (~5-10 turnos pedidos)

function _trimHistoryForMode(messages, mode) {
  if (mode !== 'fast') return messages;
  if (!Array.isArray(messages) || messages.length <= FAST_HISTORY_LIMIT) return messages;
  return messages.slice(-FAST_HISTORY_LIMIT);
}

// ── Configuración por defecto ─────────────────────────────────────────────────
let _config = {
  primary:  'groq',
  apiKeys:  { groq: '', gemini: '', openai: '' },
  fallback: ['gemini', 'openai'],
};

function configure(cfg) {
  if (cfg && cfg.llm) {
    _config = { ..._config, ...cfg.llm };
    if (cfg.llm.apiKeys) _config.apiKeys = { ..._config.apiKeys, ...cfg.llm.apiKeys };
  }
  // Fallback a variables de entorno si alguna key quedó vacía
  const envFallback = {
    groq:   process.env.LLM_KEY_GROQ,
    gemini: process.env.LLM_KEY_GEMINI,
    openai: process.env.LLM_KEY_OPENAI,
  };
  for (const [provider, value] of Object.entries(envFallback)) {
    if ((!_config.apiKeys[provider] || _config.apiKeys[provider].trim() === '') && value && value.trim()) {
      _config.apiKeys[provider] = value.trim();
    }
  }
}

// ── Helper HTTP ───────────────────────────────────────────────────────────────
// FIX v4: timeoutMs ahora obligatorio en la práctica (tiene default, pero
// cada llamador de provider pasa el valor correcto según el modo). Sin
// esto, una conexión colgada nunca resolvía ni rechazaba la promesa, y
// el fallback entre proveedores jamás se disparaba.
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
        catch(e) { reject(new Error(`JSON parse error: ${data.slice(0, 200)}`)); }
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

// ── Proveedores ───────────────────────────────────────────────────────────────
// Las tres funciones comparten la misma forma: reciben (messages,
// systemPrompt, mode), resuelven el modelo y el límite de output según
// el modo, y devuelven el texto de respuesta. El cálculo de max_tokens
// y de timeoutMs vive en un solo lugar (MAX_OUTPUT[mode] / TIMEOUT_MS[mode])
// para no duplicar el número mágico ni el criterio en cada proveedor.
//
// Nota v5: callGroq() no necesita ningún cambio para soportar Kimi K2 —
// Groq expone Kimi bajo el mismo endpoint OpenAI-compatible que ya usa
// para Llama, con la misma key. Cambiar el modelo en MODELS.groq.smart
// fue suficiente; no hay lógica de proveedor específica para Kimi.

async function callGroq(messages, systemPrompt, mode = 'fast') {
  const key = _config.apiKeys.groq;
  if (!key) throw new Error('No Groq API key');

  const model     = MODELS.groq[mode];
  const maxTokens = MAX_OUTPUT[mode];
  const timeoutMs = TIMEOUT_MS[mode] ?? TIMEOUT_MS.fast;
  const history   = _trimHistoryForMode(messages, mode);
  const msgs      = [{ role: 'system', content: systemPrompt }, ...history];

  console.log(`[llm] groq model: ${model} (${mode}, max_tokens=${maxTokens}, history=${history.length}msg, timeout=${timeoutMs}ms)`);

  const res = await post(
    'https://api.groq.com/openai/v1/chat/completions',
    { Authorization: `Bearer ${key}` },
    { model, messages: msgs, max_tokens: maxTokens, temperature: 0.85 },
    timeoutMs
  );
  if (res.status !== 200) throw new Error(`Groq ${res.status}: ${JSON.stringify(res.body)}`);
  return (res.body.choices[0].message.content || '').trim();
}

async function callGemini(messages, systemPrompt, mode = 'fast') {
  const key = _config.apiKeys.gemini;
  if (!key) throw new Error('No Gemini API key');

  const model     = MODELS.gemini[mode];
  const maxTokens = MAX_OUTPUT[mode];
  const timeoutMs = TIMEOUT_MS[mode] ?? TIMEOUT_MS.fast;
  const history   = _trimHistoryForMode(messages, mode);
  const contents  = history.map(m => ({
    role:  m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  console.log(`[llm] gemini model: ${model} (${mode}, max_tokens=${maxTokens}, history=${history.length}msg, timeout=${timeoutMs}ms)`);

  const res = await post(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {},
    {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.85 },
    },
    timeoutMs
  );
  if (res.status !== 200) throw new Error(`Gemini ${res.status}: ${JSON.stringify(res.body)}`);
  return (res.body.candidates[0]?.content?.parts?.[0]?.text || '').trim();
}

async function callOpenAI(messages, systemPrompt, mode = 'fast') {
  const key = _config.apiKeys.openai;
  if (!key) throw new Error('No OpenAI API key');

  const model     = MODELS.openai[mode];
  const maxTokens = MAX_OUTPUT[mode];
  const timeoutMs = TIMEOUT_MS[mode] ?? TIMEOUT_MS.fast;
  const history   = _trimHistoryForMode(messages, mode);
  const msgs      = [{ role: 'system', content: systemPrompt }, ...history];

  console.log(`[llm] openai model: ${model} (${mode}, max_tokens=${maxTokens}, history=${history.length}msg, timeout=${timeoutMs}ms)`);

  const res = await post(
    'https://api.openai.com/v1/chat/completions',
    { Authorization: `Bearer ${key}` },
    { model, messages: msgs, max_tokens: maxTokens, temperature: 0.85 },
    timeoutMs
  );
  if (res.status !== 200) throw new Error(`OpenAI ${res.status}: ${JSON.stringify(res.body)}`);
  return (res.body.choices[0].message.content || '').trim();
}

const PROVIDERS = {
  groq:   callGroq,
  gemini: callGemini,
  openai: callOpenAI,
};

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
    if (part.text !== undefined) {
      content = (content || '') + part.text;
    }
    if (part.functionCall) {
      toolCalls.push({
        tool: part.functionCall.name,
        params: part.functionCall.args || {},
      });
    }
  }

  return { content: (content || '').trim() || null, toolCalls: toolCalls.length > 0 ? toolCalls : null };
}

async function callGroqWithTools(messages, systemPrompt, mode, tools) {
  const key = _config.apiKeys.groq;
  if (!key) throw new Error('No Groq API key');

  const model     = MODELS.groq[mode];
  const maxTokens = MAX_OUTPUT[mode];
  const timeoutMs = TIMEOUT_MS[mode] ?? TIMEOUT_MS.fast;
  const history   = _trimHistoryForMode(messages, mode);
  const msgs      = [{ role: 'system', content: systemPrompt }, ...history];

  const body = {
    model, messages: msgs,
    max_tokens: maxTokens, temperature: 0.85,
    tools: _buildOpenAITools(tools),
    tool_choice: 'auto',
  };

  console.log(`[llm] groq tool-calling model: ${model} (${mode}, ${tools.length} tools)`);

  const res = await post(
    'https://api.groq.com/openai/v1/chat/completions',
    { Authorization: `Bearer ${key}` },
    body, timeoutMs
  );
  if (res.status !== 200) throw new Error(`Groq ${res.status}: ${JSON.stringify(res.body)}`);
  return _normalizeOpenAIResponse(res.body);
}

async function callGeminiWithTools(messages, systemPrompt, mode, tools) {
  const key = _config.apiKeys.gemini;
  if (!key) throw new Error('No Gemini API key');

  const model     = MODELS.gemini[mode];
  const maxTokens = MAX_OUTPUT[mode];
  const timeoutMs = TIMEOUT_MS[mode] ?? TIMEOUT_MS.fast;
  const history   = _trimHistoryForMode(messages, mode);
  const contents  = history.map(m => ({
    role:  m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
    tools: _buildGeminiTools(tools),
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.85 },
  };

  console.log(`[llm] gemini tool-calling model: ${model} (${mode}, ${tools.length} tools)`);

  const res = await post(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {}, body, timeoutMs
  );
  if (res.status !== 200) throw new Error(`Gemini ${res.status}: ${JSON.stringify(res.body)}`);
  return _normalizeGeminiResponse(res.body);
}

async function callOpenAIWithTools(messages, systemPrompt, mode, tools) {
  const key = _config.apiKeys.openai;
  if (!key) throw new Error('No OpenAI API key');

  const model     = MODELS.openai[mode];
  const maxTokens = MAX_OUTPUT[mode];
  const timeoutMs = TIMEOUT_MS[mode] ?? TIMEOUT_MS.fast;
  const history   = _trimHistoryForMode(messages, mode);
  const msgs      = [{ role: 'system', content: systemPrompt }, ...history];

  const body = {
    model, messages: msgs,
    max_tokens: maxTokens, temperature: 0.85,
    tools: _buildOpenAITools(tools),
    tool_choice: 'auto',
  };

  console.log(`[llm] openai tool-calling model: ${model} (${mode}, ${tools.length} tools)`);

  const res = await post(
    'https://api.openai.com/v1/chat/completions',
    { Authorization: `Bearer ${key}` },
    body, timeoutMs
  );
  if (res.status !== 200) throw new Error(`OpenAI ${res.status}: ${JSON.stringify(res.body)}`);
  return _normalizeOpenAIResponse(res.body);
}

const PROVIDERS_WITH_TOOLS = {
  groq:   callGroqWithTools,
  gemini: callGeminiWithTools,
  openai: callOpenAIWithTools,
};

// ── API pública ───────────────────────────────────────────────────────────────

/**
 * Auto-reconnect (mejora #5): retry con backoff exponencial + jitter para
 * fallos que PARECEN transitorios (timeout, red caída momentáneamente,
 * 429/5xx del proveedor) — antes, un solo timeout en Groq saltaba
 * directo a Gemini sin darle a Groq una segunda oportunidad, aunque el
 * problema hubiera sido un blip de red de medio segundo.
 *
 * Errores claramente no-transitorios (401/403/404 — key inválida, sin
 * acceso, endpoint no existe) NO se reintentan — reintentar eso no
 * cambia el resultado, solo demora el fallback al siguiente proveedor.
 */
const MAX_RETRIES_PER_PROVIDER = 2; // hasta 3 intentos totales por proveedor
const RETRY_BASE_MS            = 400;

function _sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function _backoffWithJitter(attempt) {
  const base   = RETRY_BASE_MS * Math.pow(2, attempt); // 400, 800, 1600...
  const jitter = base * (0.7 + Math.random() * 0.6);   // ±30% para no sincronizar reintentos
  return Math.round(jitter);
}

function _isRetryableError(err) {
  const msg = err?.message || '';
  if (/^Timeout después de/i.test(msg)) return true;
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(msg)) return true;

  const statusMatch = msg.match(/^(?:Groq|Gemini|OpenAI) (\d{3}):/);
  if (statusMatch) {
    const status = parseInt(statusMatch[1], 10);
    // 429 (rate limit) y 5xx (problema del lado del proveedor) valen la
    // pena reintentar. 4xx (key inválida, prohibido, etc.) no — es un
    // problema de configuración, no de conexión, y no se va a arreglar solo.
    return status === 429 || (status >= 500 && status < 600);
  }
  return false; // por defecto, no reintentar algo que no reconocemos
}

/**
 * Llama al LLM con fallback automático.
 *
 * @param {Array}  messages
 * @param {string} systemPrompt
 * @param {string} [mode='fast'] — 'fast' para conversación, 'smart' para tareas complejas (Kimi K2 vía Groq desde v5)
 */
async function _callWithFallback(messages, systemPrompt, mode = 'fast') {
  const order = [_config.primary, ...(_config.fallback || [])];
  const tried = [];

  for (const providerName of order) {
    const fn  = PROVIDERS[providerName];
    if (!fn) continue;
    const key = _config.apiKeys[providerName];
    if (!key || key.trim() === '') continue;

    for (let attempt = 0; attempt <= MAX_RETRIES_PER_PROVIDER; attempt++) {
      try {
        if (attempt > 0) {
          const waitMs = _backoffWithJitter(attempt - 1);
          console.log(`[llm] reintentando ${providerName} en ${waitMs}ms (intento ${attempt + 1}/${MAX_RETRIES_PER_PROVIDER + 1})...`);
          await _sleep(waitMs);
        }
        console.log(`[llm] intentando ${providerName} (${mode})${attempt > 0 ? ` [retry ${attempt}]` : ''}...`);
        const result = await fn(messages, systemPrompt, mode);
        console.log(`[llm] respuesta de ${providerName} (${result.length} chars)`);
        return result;
      } catch(e) {
        const retryable = _isRetryableError(e);
        console.log(`[llm] ${providerName} falló${retryable ? ' (parece transitorio)' : ' (no reintentable)'}: ${e.message}`);
        if (!retryable || attempt === MAX_RETRIES_PER_PROVIDER) {
          tried.push(providerName);
          break; // agotado — pasa al siguiente proveedor de la cadena
        }
        // si es retryable y quedan intentos, el for sigue con el próximo intento
      }
    }
  }

  throw new Error(`Todos los providers fallaron: ${tried.join(', ')}`);
}

/**
 * Conversación normal — usa modelo FAST y output limitado a
 * MAX_OUTPUT.fast, con historial recortado a los últimos mensajes.
 * Para respuestas del chat, iniciativas, resúmenes cortos.
 *
 * Firma sin cambios respecto a v2 — el recorte de tokens ocurre
 * internamente, el llamador sigue pasando el historial completo y
 * esta función decide cuánto de ese historial realmente se envía.
 */
async function complete(messages, systemPrompt) {
  return _callWithFallback(messages, systemPrompt, 'fast');
}

/**
 * Tareas complejas — usa modelo SMART (Kimi K2 vía Groq desde v5) y
 * output limitado a MAX_OUTPUT.smart, SIN recortar el historial (el
 * llamador, ej. el Planner, ya decide qué incluir para la tarea).
 * Para edición de archivos, análisis de código, razonamiento largo.
 *
 * Llamado automáticamente por Planner._llmTransform().
 *
 * v5: también es el punto de entrada que debe usar chat.html cuando el
 * usuario elija "modo tareas" en el toggle de la UI, en vez de
 * complete() — misma función, mismo contrato, solo que ahora también es
 * invocable directamente desde un mensaje normal del chat, no solo
 * desde el Planner.
 */
async function completeTask(messages, systemPrompt) {
  return _callWithFallback(messages, systemPrompt, 'smart');
}

/**
 * Llama al LLM con herramientas (tool-calling nativo).
 * Retorna { content: string|null, toolCalls: Array<{tool, params}>|null }
 *
 * Si el proveedor activo o el modelo no soporta tool-calling,
 * devuelve { content, toolCalls: null } — el llamador debe tener
 * un fallback a parsing de texto (StructuredActionParser).
 */
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
    const key = _config.apiKeys[providerName];
    if (!key || key.trim() === '') continue;

    for (let attempt = 0; attempt <= MAX_RETRIES_PER_PROVIDER; attempt++) {
      try {
        if (attempt > 0) {
          const waitMs = _backoffWithJitter(attempt - 1);
          await _sleep(waitMs);
        }
        const result = await fn(messages, systemPrompt, mode, tools);
        return result;
      } catch(e) {
        const retryable = _isRetryableError(e);
        if (!retryable || attempt === MAX_RETRIES_PER_PROVIDER) {
          tried.push(providerName);
          break;
        }
      }
    }
  }

  console.warn(`[llm] tool-calling falló en todos los providers (${tried.join(', ')}), haciendo fallback a texto`);
  const text = await _callWithFallback(messages, systemPrompt, mode);
  return { content: text, toolCalls: null };
}

/**
 * Completa con herramientas (tool-calling nativo).
 * Las tools son el array de schemas de ToolSchemas.js.
 * Retorna { content: string|null, toolCalls: Array<{tool, params}>|null }
 *
 * Si el modelo no soporta tool-calling o no devuelve tool_calls,
 * toolCalls será null y content tendrá la respuesta textual.
 */
async function completeWithTools(messages, systemPrompt, tools = []) {
  return _callWithFallbackTools(messages, systemPrompt, 'smart', tools);
}

function getActiveProvider() {
  const order = [_config.primary, ...(_config.fallback || [])];
  for (const name of order) {
    const key = _config.apiKeys[name];
    if (key && key.trim() !== '') return name;
  }
  return null;
}

/**
 * Retorna el modelo activo según el modo y proveedor.
 * Útil para logs y debug.
 */
function getActiveModel(mode = 'fast') {
  const provider = getActiveProvider();
  if (!provider) return null;
  return MODELS[provider]?.[mode] ?? null;
}

module.exports = {
  configure, complete, completeTask, completeWithTools,
  getActiveProvider, getActiveModel,
  getToolSchemas: () => require('./ToolSchemas.js').TOOL_SCHEMAS,
  _debug_isRetryableError: _isRetryableError,
  _debug_backoffWithJitter: _backoffWithJitter,
  _debug_normalizeOpenAI: _normalizeOpenAIResponse,
  _debug_normalizeGemini: _normalizeGeminiResponse,
  _debug_buildOpenAITools: _buildOpenAITools,
  _debug_buildGeminiTools: _buildGeminiTools,
};
