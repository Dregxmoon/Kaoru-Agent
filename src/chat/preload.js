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
function _boundedLLM() {
  return {
    complete: (messages, systemPrompt, opts) => LLMProvider.complete(messages, systemPrompt, opts),
    configure: (cfg) => LLMProvider.configure(cfg),
    getActiveProvider: () => LLMProvider.getActiveProvider(),
    getAvailableProviders: () => LLMProvider.getAvailableProviders(),
    listModels: (providerId) => LLMProvider.listModels(providerId),
    refreshProviderModels: (providerId) => LLMProvider.refreshProviderModels(providerId),
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

function renderMarkdown(md) {
  try {
    let rawHtml = marked.parse(md || '');
    rawHtml = rawHtml.replace(
      /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g,
      '<div class="mermaid">$1</div>'
    );
    return DOMPurify.sanitize(rawHtml);
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
