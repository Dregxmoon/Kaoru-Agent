/**
 * LLMProvider.js — Fase 0 v3
 *
 * Cambios v2 → v3:
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

// ── Modelos por proveedor ─────────────────────────────────────────────────────
const MODELS = {
  groq: {
    fast:  'llama-3.1-8b-instant',      // 20,000 TPM — conversación rápida
    smart: 'llama-3.3-70b-versatile',   // 12,000 TPM — razonamiento complejo
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
//         (Planner._llmTransform, completeTask). Aquí SÍ puede hacer
//         falta devolver archivos completos o explicaciones extensas,
//         así que se mantiene un límite más generoso.
const MAX_OUTPUT = {
  fast:  1024,
  smart: 3072,
};

// ── Recorte de historial por modo ─────────────────────────────────────────────
// En modo fast no tiene sentido reenviar toda la conversación al LLM en
// cada turno — el grounding ya resume lo importante en el systemPrompt,
// así que solo los últimos N mensajes aportan contexto inmediato real.
// En modo smart SÍ se respeta el historial completo, porque tareas como
// editar un archivo o razonar sobre código necesitan todo el contexto
// que el llamador decidió incluir (el Planner ya selecciona qué mandar).
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
}

// ── Helper HTTP ───────────────────────────────────────────────────────────────
function post(url, headers, body) {
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
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { reject(new Error(`JSON parse error: ${data.slice(0, 200)}`)); }
      });
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
// vive en un solo lugar (MAX_OUTPUT[mode]) para no duplicar el número
// mágico ni el criterio en cada proveedor.

async function callGroq(messages, systemPrompt, mode = 'fast') {
  const key = _config.apiKeys.groq;
  if (!key) throw new Error('No Groq API key');

  const model     = MODELS.groq[mode];
  const maxTokens = MAX_OUTPUT[mode];
  const history   = _trimHistoryForMode(messages, mode);
  const msgs      = [{ role: 'system', content: systemPrompt }, ...history];

  console.log(`[llm] groq model: ${model} (${mode}, max_tokens=${maxTokens}, history=${history.length}msg)`);

  const res = await post(
    'https://api.groq.com/openai/v1/chat/completions',
    { Authorization: `Bearer ${key}` },
    { model, messages: msgs, max_tokens: maxTokens, temperature: 0.85 }
  );
  if (res.status !== 200) throw new Error(`Groq ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body.choices[0].message.content.trim();
}

async function callGemini(messages, systemPrompt, mode = 'fast') {
  const key = _config.apiKeys.gemini;
  if (!key) throw new Error('No Gemini API key');

  const model     = MODELS.gemini[mode];
  const maxTokens = MAX_OUTPUT[mode];
  const history   = _trimHistoryForMode(messages, mode);
  const contents  = history.map(m => ({
    role:  m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  console.log(`[llm] gemini model: ${model} (${mode}, max_tokens=${maxTokens}, history=${history.length}msg)`);

  const res = await post(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {},
    {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.85 },
    }
  );
  if (res.status !== 200) throw new Error(`Gemini ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body.candidates[0].content.parts[0].text.trim();
}

async function callOpenAI(messages, systemPrompt, mode = 'fast') {
  const key = _config.apiKeys.openai;
  if (!key) throw new Error('No OpenAI API key');

  const model     = MODELS.openai[mode];
  const maxTokens = MAX_OUTPUT[mode];
  const history   = _trimHistoryForMode(messages, mode);
  const msgs      = [{ role: 'system', content: systemPrompt }, ...history];

  console.log(`[llm] openai model: ${model} (${mode}, max_tokens=${maxTokens}, history=${history.length}msg)`);

  const res = await post(
    'https://api.openai.com/v1/chat/completions',
    { Authorization: `Bearer ${key}` },
    { model, messages: msgs, max_tokens: maxTokens, temperature: 0.85 }
  );
  if (res.status !== 200) throw new Error(`OpenAI ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body.choices[0].message.content.trim();
}

const PROVIDERS = {
  groq:   callGroq,
  gemini: callGemini,
  openai: callOpenAI,
};

// ── API pública ───────────────────────────────────────────────────────────────

/**
 * Llama al LLM con fallback automático.
 *
 * @param {Array}  messages
 * @param {string} systemPrompt
 * @param {string} [mode='fast'] — 'fast' para conversación, 'smart' para tareas complejas
 */
async function _callWithFallback(messages, systemPrompt, mode = 'fast') {
  const order = [_config.primary, ...(_config.fallback || [])];
  const tried = [];

  for (const providerName of order) {
    const fn  = PROVIDERS[providerName];
    if (!fn) continue;
    const key = _config.apiKeys[providerName];
    if (!key || key.trim() === '') continue;

    try {
      console.log(`[llm] intentando ${providerName} (${mode})...`);
      const result = await fn(messages, systemPrompt, mode);
      console.log(`[llm] respuesta de ${providerName} (${result.length} chars)`);
      return result;
    } catch(e) {
      console.log(`[llm] ${providerName} falló: ${e.message}`);
      tried.push(providerName);
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
 * Tareas complejas — usa modelo SMART y output limitado a
 * MAX_OUTPUT.smart, SIN recortar el historial (el llamador, ej. el
 * Planner, ya decide qué incluir para la tarea).
 * Para edición de archivos, análisis de código, razonamiento largo.
 * Llamado automáticamente por Planner._llmTransform().
 */
async function completeTask(messages, systemPrompt) {
  return _callWithFallback(messages, systemPrompt, 'smart');
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

module.exports = { configure, complete, completeTask, getActiveProvider, getActiveModel };