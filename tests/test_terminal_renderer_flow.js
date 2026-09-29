'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function main() {
  const elements = new Map();
  const element = () => ({
    hidden: false,
    clientWidth: 640,
    clientHeight: 360,
    textContent: '',
    title: '',
    value: '',
    dataset: {},
    handlers: new Map(),
    classList: {
      values: new Set(),
      add(name) {
        this.values.add(name);
      },
      remove(name) {
        this.values.delete(name);
      },
      contains(name) {
        return this.values.has(name);
      },
    },
    replaceChildren: () => {},
    addEventListener(type, handler) {
      this.handlers.set(type, handler);
    },
    setAttribute: () => {},
    focus: () => {},
    select: () => {},
  });
  for (const id of [
    'terminal-screen',
    'terminal-viewport',
    'terminal-panel',
    'terminal-error',
    'terminal-restart',
    'terminal-status',
    'terminal-shell',
    'terminal-workspace',
    'terminal-avatar-motion',
    'terminal-avatar-view',
    'terminal-appearance-toggle',
    'terminal-appearance-menu',
    'terminal-font-decrease',
    'terminal-font-increase',
    'terminal-font-size',
    'terminal-explain-error',
    'terminal-attach-output',
    'terminal-chat-toggle',
    'terminal-search-toggle',
    'terminal-search-controls',
    'terminal-search-input',
    'terminal-search-status',
    'terminal-search-prev',
    'terminal-search-next',
    'terminal-signal',
    'app',
  ])
    elements.set(id, element());
  const listeners = new Map();
  const documentHandlers = new Map();
  const sent = [];
  const writes = [];
  const callbacks = [];
  let keyHandler;
  let focused = false;
  let refreshed = false;
  let terminalOptions;
  let terminalInstance;
  let openedIn;
  let terminalDataHandler;
  let selectedLine = -1;
  let selectedCol = -1;
  let searchReads = 0;
  let terminalDraft = null;
  let selectedOutput = '';
  let resolveOpen;
  class FakeTerminal {
    constructor(options) {
      terminalInstance = this;
      this.options = options;
      terminalOptions = options;
      this.cols = 80;
      this.rows = 24;
      this.buffer = {
        active: {
          length: 2,
          getLine: (line) => {
            searchReads++;
            return { translateToString: () => ['hello hello world', 'other hello'][line] };
          },
        },
      };
    }
    loadAddon() {}
    open(element) {
      openedIn = element;
    }
    onData(handler) {
      terminalDataHandler = handler;
    }
    attachCustomKeyEventHandler(handler) {
      keyHandler = handler;
    }
    write(data, callback) {
      writes.push(data);
      callbacks.push(callback);
    }
    refresh() {
      refreshed = true;
    }
    focus() {
      focused = true;
    }
    select(col, row) {
      selectedCol = col;
      selectedLine = row;
    }
    clearSelection() {}
    hasSelection() {
      return Boolean(selectedOutput);
    }
    getSelection() {
      return selectedOutput;
    }
    scrollToLine() {}
    dispose() {}
  }
  const window = {
    addEventListener: () => {},
    kaoruI18n: {
      language: 'es',
      t: (key) => ({ searching: 'Buscando…', noMatches: 'Sin coincidencias' })[key] || key,
      format: (key, values) => `${values.count} ${key}`,
    },
    setTerminalAvatarActivity: () => {},
    confirm: () => false,
    openTerminalDraft: async (draft) => {
      terminalDraft = draft;
      return true;
    },
    Terminal: FakeTerminal,
    FitAddon: {
      FitAddon: class {
        fit() {}
      },
    },
  };
  const context = {
    window,
    currentConversationType: null,
    currentConversationId: null,
    displayedWorkspace: null,
    document: {
      documentElement: { dataset: { theme: 'dark' } },
      getElementById: (id) => elements.get(id),
      addEventListener: (type, handler) => documentHandlers.set(type, handler),
      fonts: { ready: Promise.resolve() },
    },
    ipcRenderer: {
      on: (channel, listener) => listeners.set(channel, listener),
      send: (channel, payload) => sent.push({ channel, payload }),
      invoke: () => new Promise((resolve) => (resolveOpen = resolve)),
    },
    MutationObserver: class {
      observe() {}
    },
    ResizeObserver: class {
      observe() {}
    },
    getComputedStyle: () => ({ getPropertyValue: () => '#111111' }),
    requestAnimationFrame: (callback) => callback(),
    setTimeout,
    clearTimeout,
    navigator: { clipboard: {} },
  };
  const script = fs.readFileSync(path.join(__dirname, '../src/chat/terminal.js'), 'utf8');
  vm.runInNewContext(script, context, { filename: 'terminal.js' });

  const opening = window.activateTerminal({ id: 7, workspace: '/tmp/project' });
  assert.equal(openedIn, elements.get('terminal-viewport'), 'xterm mide el interior sin padding');
  assert.equal(terminalOptions.cursorBlink, true, 'el cursor parpadea en la shell');
  assert.equal(terminalOptions.cursorWidth, 3, 'la barra es visible al escribir');
  assert.equal(elements.get('app').dataset.terminalMotion, 'subtle');
  elements.get('terminal-appearance-toggle').handlers.get('click')();
  assert.equal(elements.get('terminal-appearance-menu').hidden, false);
  elements.get('terminal-font-increase').handlers.get('click')();
  assert.equal(elements.get('terminal-font-size').textContent, '14 px');
  assert.equal(terminalOptions.fontSize, 14);
  documentHandlers.get('keydown')({
    code: 'Minus',
    key: '-',
    ctrlKey: true,
    preventDefault: () => {},
    stopPropagation: () => {},
  });
  assert.equal(terminalOptions.fontSize, 13);
  assert.equal(keyHandler({ type: 'keydown', code: 'KeyF', ctrlKey: true }), false);
  assert.equal(elements.get('terminal-search-controls').hidden, false);
  elements.get('terminal-search-input').value = 'hello';
  elements.get('terminal-search-input').handlers.get('input')();
  assert.equal(elements.get('terminal-search-status').textContent, '1/3');
  assert.equal(selectedCol, 0, 'la búsqueda selecciona la primera aparición al escribir');
  const readsAfterSearch = searchReads;
  elements.get('terminal-search-input').handlers.get('keydown')({
    key: 'Enter',
    shiftKey: false,
    preventDefault: () => {},
  });
  assert.equal(selectedLine, 0, 'la segunda coincidencia puede estar en la misma línea');
  assert.equal(selectedCol, 6);
  assert.equal(elements.get('terminal-search-status').textContent, '2/3');
  elements.get('terminal-search-input').handlers.get('keydown')({
    key: 'Enter',
    shiftKey: false,
    preventDefault: () => {},
  });
  assert.equal(selectedLine, 1, 'Enter avanza por el buffer');
  assert.equal(elements.get('terminal-search-status').textContent, '3/3');
  elements.get('terminal-search-prev').handlers.get('click')();
  assert.equal(elements.get('terminal-search-status').textContent, '2/3');
  elements.get('terminal-search-next').handlers.get('click')();
  assert.equal(elements.get('terminal-search-status').textContent, '3/3');
  elements.get('terminal-search-next').handlers.get('click')();
  assert.equal(
    elements.get('terminal-search-status').textContent,
    '1/3',
    'la búsqueda vuelve al inicio'
  );
  assert.equal(searchReads, readsAfterSearch, 'las flechas reutilizan los resultados en caché');
  elements.get('terminal-search-input').value = 'not-found';
  elements.get('terminal-search-input').handlers.get('input')();
  assert.equal(elements.get('terminal-search-status').textContent, '0/0');
  assert.equal(elements.get('terminal-search-prev').disabled, true);
  assert.equal(elements.get('terminal-search-next').disabled, true);
  terminalInstance.buffer.active = {
    length: 6000,
    getLine: (row) => {
      searchReads++;
      return { translateToString: () => (row % 100 === 0 ? 'needle needle' : 'normal line') };
    },
  };
  elements.get('terminal-search-input').value = 'needle';
  elements.get('terminal-search-input').handlers.get('input')();
  assert.equal(elements.get('terminal-search-status').textContent, 'Buscando…');
  await new Promise((resolve) => setTimeout(resolve, 110));
  assert.equal(elements.get('terminal-search-status').textContent, '1/120');
  const readsAfterLargeSearch = searchReads;
  for (let index = 0; index < 100; index++)
    elements.get('terminal-search-next').handlers.get('click')();
  assert.equal(searchReads, readsAfterLargeSearch, '100 saltos no vuelven a recorrer 6000 líneas');
  terminalInstance.buffer.active = {
    length: 2,
    getLine: (row) => ({ translateToString: () => ['hello hello world', 'other hello'][row] }),
  };
  window.reactTerminalAvatar('sad');
  assert.equal(elements.get('terminal-explain-error').hidden, false);
  terminalDataHandler('\u0003');
  assert.equal(
    elements.get('terminal-explain-error').hidden,
    false,
    'Ctrl+C no oculta la acción de explicar el error anterior'
  );
  await elements.get('terminal-explain-error').handlers.get('click')();
  assert(terminalDraft.output.includes('hello hello world'));
  assert.equal(terminalDraft.workspace, '/tmp/project');
  assert.equal(terminalDraft.terminalId, 7);
  assert.equal(elements.get('terminal-explain-error').hidden, true);
  selectedOutput = 'solo esta línea de error';
  window.reactTerminalAvatar('sad');
  await elements.get('terminal-explain-error').handlers.get('click')();
  assert(terminalDraft.output.includes(selectedOutput));
  assert(!terminalDraft.output.includes('hello hello world'), 'la selección limita el contexto');
  terminalDataHandler('x');
  assert(
    elements.get('terminal-screen').classList.contains('terminal-typing'),
    'el cursor permanece sólido mientras se escribe'
  );
  assert.equal(keyHandler({ type: 'keydown', key: 'Tab', code: 'Tab' }), true);
  assert.equal(
    keyHandler({ type: 'keydown', key: 'c', code: 'KeyC', ctrlKey: true }),
    true,
    'Tab y Ctrl+C llegan a xterm y al PTY'
  );
  const chunk = 'x'.repeat(2048);
  for (let seq = 1; seq <= 150; seq++)
    listeners.get('terminal-data')(null, { id: 7, seq, data: chunk });
  assert(
    sent.some((event) => event.channel === 'terminal-flow' && event.payload.paused),
    'el renderer pausa el PTY al acumular salida antes de estar listo'
  );
  resolveOpen({ ok: true, shell: 'bash', scrollback: chunk.repeat(50), seq: 50 });
  await opening;
  assert.equal(elements.get('terminal-shell').textContent, 'bash');
  assert.equal(window.sendSuggestedTerminalCommand('echo listo', false), true);
  assert.equal(sent.at(-1).channel, 'terminal-write');
  assert.equal(sent.at(-1).payload.id, 7);
  assert.equal(sent.at(-1).payload.data, 'echo listo');
  assert.equal(window.sendSuggestedTerminalCommand('echo listo', true), false);
  window.confirm = () => true;
  assert.equal(window.sendSuggestedTerminalCommand('echo listo', true), true);
  assert.equal(sent.at(-1).payload.data, 'echo listo\r');
  assert.equal(window.sendSuggestedTerminalCommand('echo uno\necho dos', true), false);
  assert(focused && refreshed, 'la terminal se enfoca y se redibuja al terminar de abrir');
  assert.equal(writes.join(''), chunk.repeat(150), 'el snapshot y 150 eventos no pierden salida');
  assert.equal(writes.length, 101, 'los 50 eventos incluidos en el snapshot no se duplican');
  for (const callback of callbacks) callback();
  assert(
    sent.some((event) => event.channel === 'terminal-flow' && !event.payload.paused),
    'el renderer reanuda el PTY al terminar de procesar'
  );
  const writtenBeforeReopen = writes.length;
  const staleOpen = window.activateTerminal({ id: 7, workspace: '/tmp/project' });
  const resolveStaleOpen = resolveOpen;
  const latestOpen = window.activateTerminal({ id: 7, workspace: '/tmp/project' });
  const resolveLatestOpen = resolveOpen;
  resolveStaleOpen({ ok: true, shell: 'bash', scrollback: 'BANNER VIEJO', seq: 1 });
  await staleOpen;
  resolveLatestOpen({ ok: true, shell: 'bash', scrollback: 'BANNER NUEVO', seq: 1 });
  await latestOpen;
  assert.equal(
    writes.slice(writtenBeforeReopen).join(''),
    'BANNER NUEVO',
    'una apertura anterior del mismo PTY no duplica el banner ni la salida'
  );
  console.log('Terminal renderer: más de 100 eventos pendientes sin pérdida ni duplicados OK');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
