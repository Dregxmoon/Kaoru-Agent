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
  return res.body.choices[0].message.content.trim();
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
  return res.body.candidates[0].content.parts[0].text.trim();
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