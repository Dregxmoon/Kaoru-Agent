'use strict';
/* global window, document, terminalReady, terminalView, terminalContext, sessionHistory, getComputedStyle */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');

function portBusy(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.setTimeout(1500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function main() {
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    console.log('Terminal UI: omitida sin sesión gráfica.');
    return;
  }
  if ((await portBusy(3131)) || (await portBusy(18789))) {
    console.log('Terminal UI: omitida porque Kaoru ya está abierto.');
    return;
  }
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoru-terminal-ui-'));
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await _electron.launch({
      executablePath: require('electron'),
      args: ['.', '--no-sandbox', '--disable-gpu', `--user-data-dir=${userData}`],
      cwd: path.resolve(__dirname, '../..'),
      env: childEnv,
      timeout: 90000,
    });
    let chat;
    for (let attempt = 0; attempt < 80 && !chat; attempt++) {
      for (const page of await app.windows()) {
        if ((await page.url()).includes('chat.html')) chat = page;
      }
      if (!chat) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert(chat, 'la ventana de chat se abrió');
    await chat.waitForSelector('#new-chat-btn:not([disabled])', { timeout: 20000 });
    await chat.evaluate(async () => {
      if (document.getElementById('onboarding-modal').classList.contains('visible'))
        document.getElementById('onboarding-later').click();
      const result = await window.assistant.invoke('conversation-new', { type: 'terminal' });
      if (!result?.ok) throw new Error(result?.error || 'No se pudo crear la terminal');
      window.initialTerminalId = result.conversation.id;
      window.showConversation(result.conversation);
    });
    try {
      await chat.waitForFunction(
        () => document.getElementById('app').classList.contains('terminal-mode') && terminalReady,
        null,
        { timeout: 30000, polling: 100 }
      );
    } catch (error) {
      const details = await chat.evaluate(() => ({
        terminalMode: document.getElementById('app').classList.contains('terminal-mode'),
        terminalReady,
        terminalError: document.getElementById('terminal-error').textContent,
        sessionsError: document.getElementById('sessions-error').textContent,
        xtermLoaded: Boolean(window.Terminal),
      }));
      throw new Error(`Terminal no disponible: ${JSON.stringify(details)}`, { cause: error });
    }
    const layout = await chat.evaluate(() => {
      const model = document.getElementById('model-panel');
      const screen = document.getElementById('terminal-screen');
      const viewport = document.getElementById('terminal-viewport');
      const xterm = viewport.querySelector('.xterm');
      const frameBounds = screen.getBoundingClientRect();
      const viewportBounds = viewport.getBoundingClientRect();
      const xtermBounds = xterm.getBoundingClientRect();
      const base = getComputedStyle(document.documentElement).getPropertyValue('--bg-panel').trim();
      return {
        modelWidth: model.getBoundingClientRect().width,
        screenWidth: screen.getBoundingClientRect().width,
        modelHeight: document.getElementById('model-canvas-container').getBoundingClientRect()
          .height,
        canvasWidth: document.getElementById('live2d-chat-canvas').width,
        avatarFilter: getComputedStyle(document.getElementById('live2d-chat-canvas')).filter,
        screenBackground: terminalView.options.theme.background,
        cursorBlink: terminalView.options.cursorBlink,
        screenBorder: getComputedStyle(screen).borderTopWidth,
        terminalState: document.getElementById('terminal-panel').dataset.state,
        cols: terminalView.cols,
        rows: terminalView.rows,
        workspaceLabel: document.getElementById('terminal-workspace').textContent,
        statusLabel: document.getElementById('terminal-status').textContent,
        terminalLabel: document.getElementById('terminal-shell').textContent,
        terminalFitsFrame:
          viewportBounds.left > frameBounds.left &&
          viewportBounds.top > frameBounds.top &&
          viewportBounds.right < frameBounds.right &&
          viewportBounds.bottom < frameBounds.bottom &&
          xtermBounds.right <= viewportBounds.right + 1 &&
          xtermBounds.bottom <= viewportBounds.bottom + 1,
        base,
      };
    });
    assert(layout.modelWidth >= 150 && layout.modelWidth <= 241, JSON.stringify(layout));
    assert(layout.screenWidth > layout.modelWidth * 2, JSON.stringify(layout));
    assert(layout.modelHeight > 200 && layout.canvasWidth > 1, JSON.stringify(layout));
    assert(
      !layout.avatarFilter.includes('saturate') && !layout.avatarFilter.includes('brightness'),
      'el avatar conserva su color natural'
    );
    assert.equal(layout.screenBackground, layout.base, 'terminal y avatar comparten el tema');
    assert.equal(layout.cursorBlink, true, 'el cursor parpadea mientras la terminal está activa');
    assert.equal(layout.screenBorder, '1px', 'la terminal tiene una superficie delimitada');
    assert(layout.terminalFitsFrame, 'xterm no rebasa el borde inferior ni el lateral del marco');
    assert.equal(layout.terminalState, 'ready', 'la conexión muestra el estado disponible');
    assert(layout.cols > 40 && layout.rows > 5, 'la terminal arranca con dimensiones visibles');
    assert(
      layout.workspaceLabel &&
        layout.statusLabel === 'Lista' &&
        layout.terminalLabel === 'Terminal',
      JSON.stringify(layout)
    );
    await chat.click('#terminal-appearance-toggle');
    assert.equal(await chat.isVisible('#terminal-appearance-menu'), true);
    await chat.click('#terminal-font-increase');
    assert.equal(await chat.textContent('#terminal-font-size'), '14 px');
    assert.equal(await chat.evaluate(() => terminalView.options.fontSize), 14);
    await chat.selectOption('#terminal-avatar-motion', 'off');
    await chat.selectOption('#terminal-avatar-view', 'half');
    assert.deepEqual(
      await chat.evaluate(() => ({
        motion: document.getElementById('app').dataset.terminalMotion,
        view: window.terminalAvatarViewPreference,
      })),
      { motion: 'off', view: 'half' },
      'los controles del avatar actualizan el modo terminal'
    );
    await chat.evaluate(() => window.reactTerminalAvatar('happy'));
    assert.equal(await chat.textContent('#terminal-signal'), 'Señal positiva');
    assert.equal(
      await chat.evaluate(
        () => getComputedStyle(document.getElementById('live2d-chat-canvas')).animationName
      ),
      'none',
      'sin efectos desactiva la animación visual'
    );
    await chat.selectOption('#terminal-avatar-motion', 'lively');
    await chat.click('#terminal-appearance-toggle');
    await chat.evaluate(() => window.reactTerminalAvatar('happy'));
    assert.equal(
      await chat.evaluate(
        () => getComputedStyle(document.getElementById('live2d-chat-canvas')).animationName
      ),
      'terminal-avatar-success',
      'Kaoru reacciona al resultado de la terminal'
    );
    await chat.evaluate(() => terminalView.focus());
    await chat.waitForSelector(
      '#terminal-screen .xterm-rows.xterm-focus .xterm-cursor.xterm-cursor-blink.xterm-cursor-bar'
    );
    const cursorBefore = await chat.evaluate(
      () =>
        document
          .querySelector('#terminal-screen .xterm-cursor.xterm-cursor-bar')
          .getBoundingClientRect().left
    );
    await chat.keyboard.type('x');
    await chat.waitForFunction(
      (left) =>
        document
          .querySelector('#terminal-screen .xterm-cursor.xterm-cursor-bar')
          ?.getBoundingClientRect().left >
        left + 2,
      cursorBefore,
      { timeout: 5000, polling: 50 }
    );
    const typingCursor = await chat.evaluate(() => {
      const cursor = document.querySelector('#terminal-screen .xterm-cursor.xterm-cursor-bar');
      const caret = getComputedStyle(cursor, '::before');
      return {
        typing: document.getElementById('terminal-screen').classList.contains('terminal-typing'),
        animation: caret.animationName,
        color: caret.backgroundColor,
        opacity: caret.opacity,
        width: caret.width,
        height: caret.height,
        className: cursor.className,
        xtermClassName: cursor.closest('.xterm')?.className,
        inlineStyle: cursor.getAttribute('style'),
      };
    });
    assert(typingCursor.typing, 'la terminal reconoce que se está escribiendo');
    assert.equal(typingCursor.animation, 'none', 'el cursor no desaparece mientras se escribe');
    assert.equal(typingCursor.opacity, '1', 'la barra permanece visible mientras se escribe');
    assert.notEqual(typingCursor.color, 'rgba(0, 0, 0, 0)', JSON.stringify(typingCursor));
    assert.equal(typingCursor.width, '3px', JSON.stringify(typingCursor));
    assert(parseFloat(typingCursor.height) > 0, JSON.stringify(typingCursor));
    await chat.waitForFunction(
      () => !document.getElementById('terminal-screen').classList.contains('terminal-typing'),
      null,
      { timeout: 2000, polling: 50 }
    );
    await chat.evaluate(() => {
      window.terminalKeyProbe = [];
      terminalView.onData((data) => window.terminalKeyProbe.push(data));
    });
    await chat.keyboard.press('Tab');
    await chat.keyboard.press('Control+c');
    assert.deepEqual(
      await chat.evaluate(() => window.terminalKeyProbe.slice(-2)),
      ['\t', '\x03'],
      'Tab y Ctrl+C llegan a la shell'
    );
    await chat.keyboard.type('echo KAORU_SEARCH_MARKER');
    await chat.keyboard.press('Enter');
    await chat.waitForFunction(
      () =>
        Array.from({ length: terminalView.buffer.active.length }, (_, index) =>
          terminalView.buffer.active.getLine(index)?.translateToString(true)
        ).some((line) => line?.includes('KAORU_SEARCH_MARKER')),
      null,
      { timeout: 5000 }
    );
    const writesBeforeSearch = await chat.evaluate(() => window.terminalKeyProbe.length);
    await chat.click('#terminal-search-toggle');
    await chat.fill('#terminal-search-input', 'KAORU_SEARCH_MARKER');
    await chat.waitForFunction(
      () =>
        Number(document.getElementById('terminal-search-status').textContent.split('/')[1]) >= 2,
      null,
      { timeout: 5000 }
    );
    const searchTotal = Number((await chat.textContent('#terminal-search-status')).split('/')[1]);
    assert.equal(await chat.textContent('#terminal-search-status'), `1/${searchTotal}`);
    await chat.click('#terminal-search-next');
    assert.equal(await chat.textContent('#terminal-search-status'), `2/${searchTotal}`);
    await chat.click('#terminal-search-prev');
    assert.equal(await chat.textContent('#terminal-search-status'), `1/${searchTotal}`);
    assert(
      await chat.evaluate(() => {
        const controls = document
          .getElementById('terminal-search-controls')
          .getBoundingClientRect();
        const toolbar = document.querySelector('.terminal-toolbar').getBoundingClientRect();
        return controls.left >= toolbar.left && controls.right <= toolbar.right;
      }),
      'la búsqueda cabe dentro de la barra de la terminal'
    );
    assert.equal(
      await chat.evaluate(() => terminalView.getSelection()),
      'KAORU_SEARCH_MARKER',
      'buscar selecciona la coincidencia sin enviar texto a la shell'
    );
    assert.equal(
      await chat.evaluate(() => window.terminalKeyProbe.length),
      writesBeforeSearch,
      'la búsqueda no escribe en el PTY'
    );
    await chat.press('#terminal-search-input', 'Escape');
    await chat.waitForFunction(
      () => !document.getElementById('terminal-screen').classList.contains('terminal-typing'),
      null,
      { timeout: 2000, polling: 50 }
    );
    const cursorAnimation = () =>
      chat.evaluate(
        () =>
          getComputedStyle(
            document.querySelector('#terminal-screen .xterm-cursor.xterm-cursor-bar'),
            '::before'
          ).animationName
      );
    assert.equal(await cursorAnimation(), 'terminal-caret-blink', 'el cursor parpadea en reposo');
    await chat.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await cursorAnimation(), 'none', 'el cursor respeta reducir movimiento');
    await chat.evaluate(() => window.reactTerminalAvatar('happy'));
    assert.equal(
      await chat.evaluate(
        () => getComputedStyle(document.getElementById('live2d-chat-canvas')).animationName
      ),
      'none',
      'el avatar respeta reducir movimiento'
    );
    assert.equal(
      await chat.evaluate(
        () => getComputedStyle(document.getElementById('terminal-panel')).animationName
      ),
      'none',
      'la entrada animada respeta reducir movimiento'
    );
    await chat.emulateMedia({ reducedMotion: 'no-preference' });

    await chat.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await chat.waitForFunction(
      () => {
        const base = getComputedStyle(document.documentElement)
          .getPropertyValue('--bg-panel')
          .trim();
        return terminalView.options.theme.background === base;
      },
      null,
      { polling: 100 }
    );
    await chat.evaluate(() => {
      document.getElementById('new-chat-btn').click();
      document.getElementById('new-session-chat').click();
    });
    await chat.waitForFunction(
      () => !document.getElementById('app').classList.contains('terminal-mode'),
      null,
      { polling: 100 }
    );
    assert(await chat.isEnabled('#msg-input'), 'el chat recupera su campo de entrada');
    await chat.evaluate(async () => {
      const result = await window.assistant.invoke('conversation-open', {
        id: window.initialTerminalId,
      });
      if (!result?.ok) throw new Error(result?.error || 'No se pudo restaurar la terminal');
      window.showConversation(result.conversation);
    });
    await chat.waitForFunction(
      () => terminalReady && terminalView.cols > 40 && terminalView.rows > 5
    );
    await app.close();
    app = await _electron.launch({
      executablePath: require('electron'),
      args: ['.', '--no-sandbox', '--disable-gpu', `--user-data-dir=${userData}`],
      cwd: path.resolve(__dirname, '../..'),
      env: childEnv,
      timeout: 90000,
    });
    chat = null;
    for (let attempt = 0; attempt < 80 && !chat; attempt++) {
      for (const page of await app.windows()) {
        if ((await page.url()).includes('chat.html')) chat = page;
      }
      if (!chat) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert(chat, 'la ventana de chat se reabrió');
    try {
      await chat.waitForFunction(
        () =>
          typeof terminalReady !== 'undefined' &&
          document.getElementById('app').classList.contains('terminal-mode') &&
          terminalReady &&
          terminalView.cols > 40 &&
          terminalView.rows > 5 &&
          document.activeElement ===
            document.querySelector('#terminal-screen .xterm-helper-textarea'),
        null,
        { timeout: 30000, polling: 100 }
      );
    } catch (error) {
      const details = await chat.evaluate(() => ({
        terminalMode: document.getElementById('app').classList.contains('terminal-mode'),
        ready: terminalReady,
        cols: terminalView?.cols,
        rows: terminalView?.rows,
        focused: document.activeElement?.className,
        panelHidden: document.getElementById('terminal-panel').hidden,
        panelDisplay: getComputedStyle(document.getElementById('terminal-panel')).display,
        panelState: document.getElementById('terminal-panel').dataset.state,
        error: document.getElementById('terminal-error').textContent,
        chatWidth: document.getElementById('chat-panel').clientWidth,
        sessionsOpen: document.getElementById('app').classList.contains('sessions-open'),
        screenWidth: document.getElementById('terminal-screen').clientWidth,
        screenHeight: document.getElementById('terminal-screen').clientHeight,
      }));
      throw new Error(`Terminal al reabrir: ${JSON.stringify(details)}`, { cause: error });
    }
    assert.deepEqual(
      await chat.evaluate(() => ({
        motion: document.getElementById('terminal-avatar-motion').value,
        view: document.getElementById('terminal-avatar-view').value,
        fontSize: terminalView.options.fontSize,
      })),
      { motion: 'lively', view: 'half', fontSize: 14 },
      'la vista, la intensidad y el zoom se conservan al reiniciar'
    );
    await chat.evaluate(() => terminalView.focus());
    await chat.keyboard.type("printf 'KAORU_CONTEXT_ERROR\\n'");
    await chat.keyboard.press('Enter');
    await chat.waitForFunction(() =>
      Array.from({ length: terminalView.buffer.active.length }, (_, row) =>
        terminalView.buffer.active.getLine(row)?.translateToString(true)
      ).some((line) => line?.includes('KAORU_CONTEXT_ERROR'))
    );
    await chat.evaluate(() => {
      const onboarding = document.getElementById('onboarding-modal');
      if (onboarding.classList.contains('visible'))
        document.getElementById('onboarding-later').click();
    });
    await chat.evaluate(() => window.reactTerminalAvatar('sad'));
    await chat.click('#terminal-explain-error');
    await chat.waitForFunction(
      () =>
        document.getElementById('app').classList.contains('terminal-companion') &&
        !document.getElementById('app').classList.contains('terminal-mode') &&
        terminalReady
    );
    assert(
      await chat.evaluate(() => terminalContext?.output.includes('KAORU_CONTEXT_ERROR')),
      'la salida reciente aparece como adjunto revisable'
    );
    assert.equal(
      await chat.isVisible('#terminal-panel'),
      true,
      'la terminal sigue visible junto al chat'
    );
    assert.match(await chat.inputValue('#msg-input'), /Explica la causa probable/);
    assert.equal(
      await chat.evaluate(() => sessionHistory.length),
      0,
      'el borrador no se envía automáticamente'
    );
    await chat.click('#terminal-return');
    await chat.waitForFunction(
      () => document.getElementById('app').classList.contains('terminal-mode') && terminalReady
    );
    console.log(
      'Terminal UI: layout, teclas, restauración inicial, movimiento reducido y tema correctos.'
    );
  } finally {
    await app?.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
