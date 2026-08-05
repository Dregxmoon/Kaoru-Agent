// Sandbox: la página no tiene require() ni Node. Todo llega acotado desde el
// preload vía window.assistant (contextBridge). ipcRenderer es el wrapper con
// la misma firma (invoke/send/on) que el original; marked/DOMPurify ya se
// ejecutan en el preload y devuelven HTML saneado. Usamos `var` (no const)
// porque contextBridge define window.assistant como propiedad no-configurable
// y una `const assistant` en ámbito global lanza "Identifier 'assistant' has
// already been declared" (HasRestrictedGlobalProperty).
var assistant = window.assistant;
const ipcRenderer = assistant;
const path = { join: (...p) => assistant.pathJoin(...p) };
const fs = { existsSync: (p) => assistant.existsSync(p) };
const cp = {
  spawn: () => {
    throw new Error('child_process no disponible en el renderer sandbox');
  },
};

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

// P0: antes 'marked' se cargaba desde un CDN externo (cdn.jsdelivr.net) vía
// <script src>, lo que además de depender de internet para algo tan básico
// como formatear texto, en un renderer con nodeIntegration:true es un riesgo
// de cadena de suministro (si el CDN o la conexión se comprometen, el script
// inyectado corre con Node completo disponible). Ahora se cargan como
// dependencias npm normales vía require() — más robusto además porque evita
// la detección de entorno UMD (typeof exports/module), que en un renderer
// con nodeIntegration puede hacer que la librería no llegue a exponerse como
// variable global aunque el <script> cargue bien.
// Markdown/DOMPurify se ejecutan en el preload (renderMarkdown devuelve HTML
// saneado). Estos shims mantienen la interfaz que usa el resto del chat.
const marked = { parse: (m) => assistant.renderMarkdown(m), setOptions: () => {} };
const DOMPurify = { sanitize: (h) => h };

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
// funciona sobre los proxies del bridge. El preload entrega SOLO el fuente
// de los módulos whitelisteados (getCoreModuleSource); ModelAugmenter se
// resuelve al proxy expuesto (llamadas a métodos, no constructor). Esto no
// le da a la página —ni a los scripts remotos de los CDN— acceso a Node.
const __coreLoader = (() => {
  const cache = {};
  const load = (name) => {
    const key = String(name).replace(/^\.\//, '').replace(/\.js$/, '');
    if (cache[key]) return cache[key].exports;
    if (key === 'ModelAugmenter') return assistant.ModelAugmenter;
    const source = assistant.getCoreModuleSource(key);
    if (source == null) throw new Error('Módulo core no permitido en la página: ' + name);
    const module = { exports: {} };
    cache[key] = module;
    new Function('require', 'module', 'exports', source)(load, module, module.exports);
    return module.exports;
  };
  return load;
})();
const GestureEngine = __coreLoader('./GestureEngine.js');

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
  chatGestureConfig = cfg;
  chatGestureEngine = new GestureEngine({ config: cfg });
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
let activePlanId = null;

// Plan pendiente de aprobación (fase 1 del sistema de dos fases)
let pendingPlan = null; // plan extraído
let pendingLlmResponse = null; // respuesta LLM original con el plan
let pendingPlanMsgDiv = null; // div del mensaje donde se renderizó el plan

const sessionHistory = [];
const MAX_SESSION_HISTORY = 20;

function pushToSession(role, content) {
  sessionHistory.push({ role, content });
  if (sessionHistory.length > MAX_SESSION_HISTORY)
    sessionHistory.splice(0, sessionHistory.length - MAX_SESSION_HISTORY);
}

// Markdown
marked.setOptions({ breaks: true, gfm: true });

let mermaidReady = false;

function loadMermaid() {
  const s = document.createElement('script');
  // Versión fijada a propósito — @11 sin fijar significa que cualquier
  // publicación nueva de la línea 11.x se carga automáticamente sin que
  // nadie lo decida. Actualizar este número es una decisión consciente,
  // no un "just works" silencioso.
  s.src = 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js';
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

function renderMarkdown(text) {
  try {
    let rawHtml = marked.parse(text || '');
    rawHtml = rawHtml.replace(
      /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g,
      '<div class="mermaid">$1</div>'
    );
    return DOMPurify.sanitize(rawHtml);
  } catch (e) {
    console.warn('error renderizando markdown, cae a texto plano:', e.message);
    return escapeHtml(text);
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
