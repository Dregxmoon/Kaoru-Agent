// @ts-nocheck
// Sandbox: la página no tiene require() ni Node. Todo llega acotado desde el
// preload fino vía window.assistant (contextBridge). Usamos `var` (no const)
// porque contextBridge define window.assistant como propiedad no-configurable
// y una `const assistant` en ámbito global lanza "Identifier 'assistant' has
// already been declared" (HasRestrictedGlobalProperty).
var assistant = window.assistant;
const ipcRenderer = assistant;

// Se queda SOLO con las líneas que son un trigger reconocido, sin importar
// dónde caiga la prosa alucinada del modelo — la versión anterior solo
// cortaba después del ÚLTIMO trigger, así que un párrafo alucinado
// intercalado ENTRE dos líneas "Ejecutar:" se colaba igual.
function _sanitizePlanAnnouncement(response) {
  const triggerRe = /^(Ejecutar:|Voy a leer|Voy a escribir)/i;
  const triggerLines = response
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => triggerRe.test(l));
  if (!triggerLines.length) return response;
  return triggerLines.join('\n');
}

// P0: 'marked'/'dompurify' se cargan como <script> locales (UMD en
// node_modules, sin CDN) porque con sandbox:true el preload ya no puede
// require() de Node. Exponen window.marked / window.DOMPurify en la página y
// aquí se implementa renderMarkdown completo (incl. el frame de preview de
// HTML crudo) — antes vivía en el preload (src/chat/preload.js).
marked.setOptions({ breaks: true, gfm: true });

window.PIXI = PIXI;

// FIX: antes esto era la misma ruta absoluta hardcodeada que main.js tenía
// duplicada — se rompía en cualquier máquina que no fuera exactamente esta.
// Ahora se pide una sola vez al proceso main (que ya la resuelve de forma
// portable, ver resolvePythonBin en main.js) y se cachea.
let _pythonBinPromise = null;
function getPythonBin() {
  if (!_pythonBinPromise)
    _pythonBinPromise = ipcRenderer.invoke('get-python-bin').catch(() => null);
  return _pythonBinPromise;
}
const TTS_VOICE = 'ja-JP-NanamiNeural';

// Auto-fit por contenido real del modelo (bounds del mesh, no del canvas).
// Concepto "piso": el borde inferior de la ventana es el corte del cuerpo.
//   full: f=1.0 → los pies tocan el piso. half: f=0.5 → cintura en el piso.
//   head: f=0.25 → cuello en el piso. crop=true escala por altura (recorta lados).
const VIEW = {
  full: { f: 1.0, tw: 0.98, crop: false },
  half: { f: 0.5, tw: 1.0, crop: true },
  head: { f: 0.25, tw: 1.0, crop: true },
};
const VIEW_LABELS = {
  full: 'Cuerpo completo',
  half: 'Medio cuerpo',
  head: 'Solo cabeza',
  random: 'Aleatorio',
};
const VIEW_PERSONALITY = {
  weights: { full: 50, half: 30, head: 20 },
  duration: { full: { min: 30, max: 80 }, half: { min: 18, max: 45 }, head: { min: 10, max: 25 } },
};

function computeContentBounds(model) {
  try {
    const im = model.internalModel,
      core = im && im.coreModel;
    if (!core || typeof core.getDrawableCount !== 'function') return null;
    const cw = model.width,
      ch = model.height;
    if (!cw || !ch) return null;
    const cnt = core.getDrawableCount();
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (let i = 0; i < cnt; i++) {
      const pos = core.getDrawableVertexPositions(i);
      const c = core.getDrawableVertexCount(i);
      if (!pos || !c) continue;
      for (let j = 0; j < c; j++) {
        const x = pos[j * 2],
          y = pos[j * 2 + 1];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (minX === Infinity) return null;
    const B = {
      x: (minX + 0.5) * cw,
      y: ch * (0.5 - (maxY * cw) / ch),
      width: (maxX - minX) * cw,
      height: (maxY - minY) * cw,
    };
    // Centro horizontal de la cabeza (banda superior): las vistas recortadas
    // (half/head) se centran en él para que la cara no quede cortada.
    B.headCx = null;
    const bound = B.y + B.height * 0.35;
    let hMinX = Infinity,
      hMaxX = -Infinity;
    for (let i = 0; i < cnt; i++) {
      const pos = core.getDrawableVertexPositions(i);
      const c = core.getDrawableVertexCount(i);
      if (!pos || !c) continue;
      for (let j = 0; j < c; j++) {
        const px = (pos[j * 2] + 0.5) * cw;
        const py = ch * (0.5 - (pos[j * 2 + 1] * cw) / ch);
        if (py <= bound) {
          if (px < hMinX) hMinX = px;
          if (px > hMaxX) hMaxX = px;
        }
      }
    }
    if (hMinX <= hMaxX) B.headCx = (hMinX + hMaxX) / 2;
    return B;
  } catch (_) {
    return null;
  }
}

const LLMProvider = assistant.LLMProvider;
const CommandRegistry = assistant.CommandRegistry;
const FileResolver = assistant.FileResolver;
const AgentManager = assistant.AgentManager;
const ModelAugmenter = assistant.ModelAugmenter;

// Loader mínimo de módulos core propios en la página. Las clases como
// GestureEngine DEBEN ejecutarse aquí: reciben el objeto Live2D real (creado
// por PIXI en la página) que no puede cruzar el contextBridge, y `new` no
// funciona sobre los proxies del bridge. Con sandbox:true los fuentes llegan
// en un LOTE vía IPC (chat-core-sources) y el loader los resuelve en
// síncrono — necesario porque GestureEngine.js hace `require()` en top-level
// al ejecutarse. ModelAugmenter se resuelve al proxy IPC expuesto por el
// preload (llamadas a métodos, no constructor). Esto no le da a la página —ni
// a los scripts remotos de los CDN— acceso a Node.
let __coreSources = null;
let __coreSourcesReady = null;
function initCoreSources() {
  if (!__coreSourcesReady) {
    __coreSourcesReady = assistant
      .coreSources()
      .then((s) => {
        __coreSources = s || {};
      })
      .catch(() => {
        __coreSources = {};
      });
  }
  return __coreSourcesReady;
}
const __coreLoader = (() => {
  const cache = {};
  const load = (name) => {
    const key = String(name).replace(/^\.\//, '').replace(/\.js$/, '');
    if (cache[key]) return cache[key].exports;
    if (key === 'ModelAugmenter') return assistant.ModelAugmenter;
    const source = __coreSources && __coreSources[key];
    if (source == null) throw new Error('Módulo core no permitido en la página: ' + name);
    const module = { exports: {} };
    cache[key] = module;
    new Function('require', 'module', 'exports', source)(load, module, module.exports);
    return module.exports;
  };
  return load;
})();
let GestureEngine = null;
let agentStates = null;
// Carga los módulos core en background (se resuelven síncrono después). Tanto
// initGestureEngine como el listener de agent-progress dependen de ellos.
async function initCoreModules() {
  await initCoreSources();
  if (!GestureEngine) GestureEngine = __coreLoader('./GestureEngine.js');
  if (!agentStates) agentStates = __coreLoader('./agentStates.js');
}
initCoreModules();

// Motor de gestos del mini-avatar del chat: reacciona a los eventos del propio
// chat (initiative/proposal/plan/agent/commandos) y al tono de los mensajes.
let chatGestureEngine = null;
let chatGestureConfig = null;
let _chatGestureCfgPromise = null;
function getGestureConfig() {
  if (!_chatGestureCfgPromise) {
    _chatGestureCfgPromise = ipcRenderer.invoke('gesture-config').catch(() => null);
  }
  return _chatGestureCfgPromise;
}
async function initGestureEngine() {
  if (chatGestureEngine) return chatGestureEngine;
  const cfg = (await getGestureConfig()) || {};
  // Animaciones espontáneas SIEMPRE en el mini-avatar del chat: aunque el
  // usuario no haya configurado nada, Kaoru gesticula sola periódicamente.
  chatGestureConfig = { ...cfg, ambient: cfg.ambient !== false };
  await initCoreModules();
  chatGestureEngine = new GestureEngine({ config: chatGestureConfig });
  return chatGestureEngine;
}

// Detector de emoción barato para mensajes del usuario (mismo espíritu que el
// del overlay): solo influye en el gesto del mini-avatar.
function chatDetectEmotion(text) {
  const t = String(text || '').toLowerCase();
  if (/error|fallo|problema|no pude|lo siento|perdon|triste|mal/.test(t)) return 'sad';
  if (/genial|perfecto|listo|hecho|exito|bien|super|increible|gracias/.test(t)) return 'excited';
  if (/procesando|espera|momento|calculando|buscando|puedes/.test(t)) return 'think';
  if (/hola|hey|buenos|quiero que/i.test(t)) return 'happy';
  return 'default';
}

// Estado global
let pixiApp, model;
let modelBounds = null;
let modelNativeW = 0;
let modelNativeH = 0;
let viewMode = 'random';
let currentView = 'head';
let isSpeaking = false;
let audioCtx = null;
let pendingFiles = [];
let _modelInfo = null;
let _modelNames = [];
let _motionTimer = null;
let _workspacePath = null;
let _atProjectFiles = null;

ipcRenderer
  .invoke('get-model-info')
  .then((info) => {
    if (info && info.model3Path) _modelInfo = info;
  })
  .catch((e) => console.error('[chat] no se pudo obtener info del modelo:', (e && e.message) || e));
ipcRenderer
  .invoke('models-list')
  .then((models) => {
    _modelNames = (models || []).map((m) => m.name);
  })
  .catch((e) => console.error('[chat] no se pudo listar modelos:', (e && e.message) || e));

// Fase 3
let openclawAvailable = false;

// Estado de aislamiento de proceso del server (bwrap/AppContainer), reportado en /health.
// null = sin información (no avisa); false = sandbox desactivado (aviso).
let openclawSandbox = null;
let openclawSandboxReason = null;

// Banner persistente de sandbox desactivado. No es un toast: si los execs de
// alto impacto corren sin aislamiento de proceso, el usuario lo ve siempre.
function updateSandboxBanner() {
  const banner = document.getElementById('sandbox-banner');
  if (!banner) return;
  const disabled = openclawSandbox === false;
  banner.classList.toggle('visible', disabled);
  if (disabled) {
    const reason = openclawSandboxReason || 'razón desconocida';
    banner.textContent = `Ejecución de comandos sin aislamiento de proceso — ${reason}`;
  }
}

// Modo de agente: 'agent' (tools + AgentLoop) o 'chat' (solo LLM). El modo
// 'agent' requiere que openclaw esté disponible. Tab en el input alterna el
// modo; el badge del header muestra el actual.
let _agentMode = 'agent';
const _agentModeListeners = new Set();

function setAgentMode(mode) {
  if (mode !== 'agent' && mode !== 'chat') mode = 'agent';
  const next = mode === 'agent' && !openclawAvailable ? 'chat' : mode;
  if (next === _agentMode) return;
  _agentMode = next;
  _agentModeListeners.forEach((fn) => fn(next));
  return next;
}

function getAgentMode() {
  return _agentMode;
}

function toggleAgentMode() {
  return setAgentMode(_agentMode === 'agent' ? 'chat' : 'agent');
}

function onAgentMode(fn) {
  _agentModeListeners.add(fn);
  fn(_agentMode);
  return () => _agentModeListeners.delete(fn);
}

const sessionHistory = [];
const MAX_SESSION_HISTORY = 20;

function pushToSession(role, content) {
  sessionHistory.push({ role, content });
  if (sessionHistory.length > MAX_SESSION_HISTORY)
    sessionHistory.splice(0, sessionHistory.length - MAX_SESSION_HISTORY);
}

let mermaidReady = false;

function loadMermaid() {
  const s = document.createElement('script');
  // Fase 1: se sirve local desde node_modules (sin CDN).
  s.src = '../node_modules/mermaid/dist/mermaid.min.js';
  s.onload = () => {
    mermaid.initialize({
      startOnLoad: false,
      theme: 'base',
      themeVariables: {
        background: 'transparent',
        primaryColor: '#10b981',
        primaryTextColor: '#e2e8f0',
        lineColor: '#4a5568',
      },
    });
    mermaidReady = true;
    document.querySelectorAll('.mermaid').forEach((el) => _renderMermaid(el));
  };
  document.head.appendChild(s);
}
loadMermaid();

async function _renderMermaid(el) {
  if (!mermaidReady || el.dataset.rendered) return;
  el.dataset.rendered = '1';
  try {
    const { svg } = await mermaid.render(
      `m-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      el.textContent
    );
    const wrapper = document.createElement('div');
    wrapper.className = 'mermaid-wrapper';
    wrapper.innerHTML = svg;
    el.parentNode.replaceChild(wrapper, el);
  } catch {}
}

// Marka de bloque HTML crudo extraído: se sustituye en el markdown ANTES de
// marked y se reemplaza por el frame de preview DESPUÉS de DOMPurify.
const HTML_PREVIEW_RE = /@@HTMLPREVIEW(\d+)@@/g;

// Extrae bloques de HTML crudo del texto y los reemplaza por marcadores.
// Devuelve { text, previews } donde previews[i] es el HTML crudo. Durante el
// streaming un documento llega INCOMPLETO (falta el cierre): en ese caso el
// preview pendiente se marca para mostrarse como código en vivo (no página a
// medias) hasta que el render final vea el </html> y lo convierta en iframe.
function _extractRawHtml(md, opts) {
  if (typeof md !== 'string' || !md) return { text: md, previews: [], pending: null };

  // Proteger code fences: el HTML que ya va dentro de ```html ``` NO se toca.
  const fences = [];
  const noFences = md.replace(/```[\s\S]*?```/g, (m) => {
    const idx = fences.length;
    fences.push(m);
    return `@@FENCE${idx}@@`;
  });

  const previews = [];
  let body = noFences;

  // Documento HTML completo (<!DOCTYPE html> ... </html> o <html>...</html>).
  const docRe = /(?:<!DOCTYPE\s+html[\s\S]*?<\/html>|<html[^>]*>[\s\S]*?<\/html>)/gi;
  body = body.replace(docRe, (m) => {
    previews.push(m);
    return `@@HTMLPREVIEW${previews.length - 1}@@`;
  });

  // Fragmento HTML con varios tags de bloque pero SIN <html> envolvente
  // (p. ej. el modelo emite solo <div>...<style>...<script>...).
  const fragRe =
    /((?:<style[^>]*>[\s\S]*?<\/style>|<script[^>]*>[\s\S]*?<\/script>|<[a-z][\s\S]*?<\/[a-z]+>){2,})/gi;
  body = body.replace(fragRe, (m) => {
    previews.push(m);
    return `@@HTMLPREVIEW${previews.length - 1}@@`;
  });

  // Streaming: apertura de documento sin cierre → marcar como pendiente.
  let pending = null;
  if (opts && opts.streaming && !previews.length) {
    const openRe = /<!DOCTYPE\s+html|<html[^>]*>|<body[^>]*>|<head[^>]*>/i;
    const closeRe = /<\/html>/i;
    if (openRe.test(body) && !closeRe.test(body)) {
      // Buscar el fragmento pendiente: desde la apertura hasta el final o el
      // primer doble salto de línea que cierre el bloque.
      const m = openRe.exec(body);
      if (m) {
        const rest = body.slice(m.index);
        const end = rest.search(/\n\s*\n/);
        pending = end === -1 ? rest : rest.slice(0, end);
        body =
          body.slice(0, m.index) + '@@HTMLPREVIEWSTREAM@@' + (end === -1 ? '' : rest.slice(end));
      }
    }
  }

  // Restaurar fences.
  const restored = body.replace(/@@FENCE(\d+)@@/g, (m, i) => fences[Number(i)] || '');
  return { text: restored, previews, pending };
}

function _escapeAttr(text) {
  return escapeHtml(text).replace(/"/g, '&quot;');
}

// Formatea HTML de una sola línea para mostrarlo legible en el frame de
// código: pone un salto de línea antes de cada etiqueta de apertura/cierre y
// después de los cierres de bloque. NO altera el HTML funcional (el iframe usa
// el html crudo); solo embellece la vista de "Código".
function _prettyHtml(html) {
  if (!html || typeof html !== 'string') return html;
  return html
    .replace(/>\s*</g, '>\n<')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Frame de preview: recuadro con título + ruta del archivo (si se conoce) +
// iframe sandboxed con el HTML crudo (srcdoc) y debajo el código fuente en un
// <details>. El sandbox permite scripts pero sin same-origin, así el HTML
// generado por el LLM no puede escapar del iframe ni tocar el chat.
function _htmlPreviewFrame(html, index, filePath) {
  const esc = escapeHtml(_prettyHtml(html));
  const pathHtml = filePath
    ? `<span class="html-preview-path" title="${_escapeAttr(filePath)}">${escapeHtml(filePath)}</span>`
    : '';
  return (
    '<div class="html-preview">' +
    `<div class="html-preview-head">` +
    `<span class="html-preview-title">Vista previa</span>` +
    pathHtml +
    `<span class="html-preview-count">#${index + 1}</span>` +
    `</div>` +
    `<iframe class="html-preview-iframe" sandbox="allow-scripts" srcdoc="${_escapeAttr(html)}"></iframe>` +
    '<details class="html-preview-code"><summary>Código</summary>' +
    `<pre class="html-preview-pre"><code>${esc}</code></pre>` +
    '</details>' +
    '</div>'
  );
}

function renderMarkdown(md, opts) {
  try {
    const { text, previews, pending } = _extractRawHtml(md, opts);
    let rawHtml = marked.parse(text || '');

    // HTML crudo incompleto en streaming: se muestra como código en vivo.
    if (pending) {
      const esc = escapeHtml(pending);
      rawHtml = rawHtml.replace(
        '@@HTMLPREVIEWSTREAM@@',
        `<pre class="html-preview-pre html-preview-stream"><code class="language-html">${esc}</code></pre>`
      );
    }

    rawHtml = rawHtml.replace(
      /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g,
      '<div class="mermaid">$1</div>'
    );
    rawHtml = DOMPurify.sanitize(rawHtml);
    if (previews.length) {
      const filePath = opts && opts.path ? String(opts.path) : '';
      rawHtml = rawHtml.replace(HTML_PREVIEW_RE, (m, i) => {
        const html = previews[Number(i)];
        return html == null ? '' : _htmlPreviewFrame(html, i, filePath);
      });
    }
    return rawHtml;
  } catch (e) {
    console.warn('error renderizando markdown, cae a texto plano:', e.message);
    return escapeHtml(md);
  }
}

function escapeHtml(text) {
  return (text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Tema
const html = document.documentElement;
const themeToggle = document.getElementById('theme-toggle');

function setTheme(t) {
  html.setAttribute('data-theme', t);
  ipcRenderer.send('chat-theme-changed', t);
}
themeToggle.addEventListener('click', () =>
  setTheme(html.getAttribute('data-theme') === 'dark' ? 'sakura' : 'dark')
);

function now() {
  return new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
}
