// @ts-nocheck
'use strict';

// Preload del chat (src/chat.html).
//
// Sandbox: contextIsolation:true + nodeIntegration:false. Todo el acceso a
// Node y a los módulos core (LLMProvider, CommandRegistry, FileResolver,
// AgentManager, GestureEngine, ModelAugmenter) vive en este mundo aislado y
// se expone vía contextBridge como window.assistant. La página solo recibe
// funciones acotadas; los scripts remotos (pixi.js, live2dcubismcore) cargan
// sin privilegios de Node.

const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');
const fs = require('fs');
const cp = require('child_process');

const { assertAllowed } = require('../../ipc/channel-whitelist.js');

const marked = require('marked');
const createDOMPurify = require('dompurify');

const LLMProvider = require('../../core/llm/LLMProvider.js');
const CommandRegistry = require('../../core/commands/CommandRegistry.js');
const FileResolver = require('../../core/commands/FileResolver.js');
const AgentManager = require('../../core/agents/AgentManager.js');
const ModelAugmenter = require('../../core/behavior/ModelAugmenter.js');

// Bridge acotado: la página SOLO recibe las funciones concretas que usa el
// chat, nunca el módulo completo. LLMProvider entero expone _getApiKey/
// _config con las API keys en claro; CommandRegistry entero expone todos los
// comandos y su motor de ejecución. Aquí se envuelve cada método de forma
// explícita y únicamente los que el renderer consume (comprobado contra
// src/chat/*.js). Si el renderer necesita algo nuevo, se añade aquí — no se
// desbloquea el módulo completo.
// AbortController del flujo simple (chat sin openclaw). El renderer NO puede
// pasar su propio AbortSignal por el contextBridge (se clona a un objeto plano
// sin addEventListener → "signal.addEventListener is not a function"), así que
// el controller vive aquí y el renderer cancela vía LLMProvider.cancelSimple().
let _simpleAbort = null;

function _boundedLLM() {
  return {
    complete: (messages, systemPrompt, opts) => {
      const controller = new AbortController();
      _simpleAbort = controller;
      return LLMProvider.complete(messages, systemPrompt, {
        ...(opts || {}),
        signal: controller.signal,
      });
    },
    cancelSimple: () => {
      if (_simpleAbort) {
        _simpleAbort.abort();
        _simpleAbort = null;
      }
    },
    configure: (cfg) => LLMProvider.configure(cfg),
    getActiveProvider: () => LLMProvider.getActiveProvider(),
    getAvailableProviders: () => LLMProvider.getAvailableProviders(),
    listModels: (providerId) => LLMProvider.listModels(providerId),
    refreshProviderModels: (providerId) => LLMProvider.refreshProviderModels(providerId),
    getModelMeta: (providerId, modelId) => LLMProvider.getModelMeta(providerId, modelId),
    resolveModelId: (providerId, modelId) => LLMProvider.resolveModelId(providerId, modelId),
    resolveRole: (token) => LLMProvider.resolveRole(token),
    ROLE_LABELS: LLMProvider.ROLE_LABELS,
    addCustomProvider: (def) => LLMProvider.addCustomProvider(def),
    removeCustomProvider: (id) => LLMProvider.removeCustomProvider(id),
    recommend: (task) => {
      const { recommend } = require('../../core/llm/recommend.js');
      return recommend(task);
    },
    getUsageTracker: () => LLMProvider.getUsageTracker(),
  };
}
function _boundedCommands() {
  return {
    getNames: () => CommandRegistry.getNames(),
    getCommand: (name) => CommandRegistry.getCommand(name),
  };
}
function _boundedFiles() {
  return {
    listProjectFiles: (cwd, pattern) => FileResolver.listProjectFiles(cwd, pattern),
    buildFileContext: (text, cwd) => FileResolver.buildFileContext(text, cwd),
  };
}
function _boundedAgents() {
  return {
    getSystemPrompt: (name) => AgentManager.getSystemPrompt(name),
  };
}
// ModelAugmenter se usa como objeto de métodos (augmentModel devuelve objetos
// planos serializables) y la página necesita listGestures para el mini-avatar.
function _boundedModelAugmenter() {
  return {
    augmentModel: (model3Path) => ModelAugmenter.augmentModel(model3Path),
    listGestures: (model3Path) => ModelAugmenter.listGestures(model3Path),
  };
}

// Fuente de los módulos core que la página necesita EJECUTAR en su propio
// mundo (GestureEngine): recibe el objeto Live2D real creado por PIXI en la
// página, que no puede cruzar el contextBridge (copia profunda inviable) y
// que tampoco admite `new` sobre proxies del bridge. La página los carga con
// un loader mínimo que SOLO puede resolver estos nombres — nada de esto
// expone Node/fs/child_process a la página ni a los CDN.
const coreBehaviorDir = path.join(__dirname, '..', '..', 'core', 'behavior');
const coreSources = {
  GestureLexicon: fs.readFileSync(path.join(coreBehaviorDir, 'GestureLexicon.js'), 'utf8'),
  GestureHeuristic: fs.readFileSync(path.join(coreBehaviorDir, 'GestureHeuristic.js'), 'utf8'),
  GestureEngine: fs.readFileSync(path.join(coreBehaviorDir, 'GestureEngine.js'), 'utf8'),
  agentStates: fs.readFileSync(path.join(coreBehaviorDir, 'agentStates.js'), 'utf8'),
};

// El preload comparte el DOM con la página (contextIsolation aísla los
// globals de JS, no el DOM), así que DOMPurify puede sanear el markdown aquí
// y entregar HTML ya limpio a la página.
marked.setOptions({ breaks: true, gfm: true });
const DOMPurify = createDOMPurify(window);

function _escapeHtml(text) {
  return (text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Marca de bloque HTML crudo extraído: se sustituye en el markdown ANTES de
// marked y se reemplaza por el frame de preview DESPUÉS de DOMPurify.
const HTML_PREVIEW_RE = /@@HTMLPREVIEW(\d+)@@/g;

// Bloque HTML crudo (documento o fragmento con tags de bloque). El modelo a
// veces emite la página completa SIN code fence; marcado la pasaría tal cual
// y DOMPurify la renderizaría como página real dentro del chat — ahora se
// extrae a un frame de preview dedicado (iframe sandboxed) + su código.

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
  return _escapeHtml(text).replace(/"/g, '&quot;');
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
  const esc = _escapeHtml(_prettyHtml(html));
  const pathHtml = filePath
    ? `<span class="html-preview-path" title="${_escapeAttr(filePath)}">${_escapeHtml(filePath)}</span>`
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
      const esc = _escapeHtml(pending);
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
    return _escapeHtml(md);
  }
}

// TTS: misma mecánica que el overlay pero con los parámetros fijos del chat.
function ttsStream(args = {}) {
  return new Promise((resolve, reject) => {
    if (!args.pythonBin) {
      reject(new Error('pythonBin requerido'));
      return;
    }
    const chunks = [];
    const proc = cp.spawn(args.pythonBin, [
      path.join(__dirname, '..', '..', 'tts_stream.py'),
      '--voice',
      args.voice || 'ja-JP-NanamiNeural',
      '--rate',
      args.rate || '+10%',
      '--pitch',
      args.pitch || '+20Hz',
      '--text',
      args.text || '',
    ]);
    proc.stdout.on('data', (c) => chunks.push(c));
    proc.on('close', (code) => {
      if (code !== 0 || chunks.length === 0) {
        reject(new Error('TTS failed'));
        return;
      }
      resolve(new Uint8Array(Buffer.concat(chunks)));
    });
    proc.on('error', reject);
  });
}

contextBridge.exposeInMainWorld('assistant', {
  // IPC con whitelist de canales: el renderer (o un script comprometido) no
  // puede invocar canales internos fuera de ipc/channel-whitelist.js.
  invoke: (channel, ...args) => {
    assertAllowed('invoke', channel);
    return ipcRenderer.invoke(channel, ...args);
  },
  send: (channel, ...args) => {
    assertAllowed('send', channel);
    return ipcRenderer.send(channel, ...args);
  },
  on: (channel, listener) => {
    assertAllowed('on', channel);
    const wrapped = (_e, ...args) => listener(_e, ...args);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },

  pathJoin: (...parts) => path.join(...parts),
  existsSync: (p) => fs.existsSync(p),
  statIsDir: (p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  cwd: () => process.cwd(),
  renderMarkdown,
  ttsStream,

  // Comandos /: el handler corre en este mundo aislado (CommandRegistry),
  // pero la página arma cmdCtx con shims fs/path mínimos (solo join/
  // existsSync) y /init, /open, /export usan readdirSync, statSync,
  // readFileSync, writeFileSync, mkdirSync y path.relative/resolve/extname/
  // sep. Solución: ejecutar aquí con los módulos reales de Node y conservar
  // solo los callbacks de la página (funciones, se cruzan baratas por el
  // bridge). La página NUNCA recibe fs/path crudos — se mantiene el sandbox.
  runCommand: async (text, pageCtx = {}) => {
    const ctx = { ...pageCtx, fs, path };
    return CommandRegistry.execute(text, ctx);
  },

  // Módulos core SOLO como bridge acotado (funciones concretas por dominio),
  // nunca los módulos completos — ver _bounded* arriba.
  LLMProvider: _boundedLLM(),
  CommandRegistry: _boundedCommands(),
  FileResolver: _boundedFiles(),
  AgentManager: _boundedAgents(),
  // GestureEngine NO se expone aquí: es una clase ES que la página instancia
  // con `new` y recibe el objeto Live2D real (creado por PIXI en la página),
  // nada de lo cual funciona a través del contextBridge (los proxies no son
  // constructables y el modelo no puede copiarse). La página lo carga vía
  // getCoreModuleSource con un loader mínimo que solo resuelve estos nombres.
  getCoreModuleSource: (name) => coreSources[name] || null,
  ModelAugmenter: _boundedModelAugmenter(),
});
