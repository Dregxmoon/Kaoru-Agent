'use strict';

// @ts-check

// Los callbacks de page.evaluate() corren en la página (browser), aunque el
// test en sí viva en Node — por eso window/document se declaran como globals.
/* global window, document, KeyboardEvent, MouseEvent, renderPlanBlock, preservePlanBlock, pausePlanBlock, resetPlanBlock, renderActivityBlock */

/**
 * E2E UI real — lanza la app Electron completa con Playwright (_electron)
 * y verifica la ventana de chat (y el overlay) desde el punto de vista del
 * renderer: elementos clave, tema, modal de settings, input y banners.
 *
 * Requisitos:
 *   - Display disponible (DISPLAY o WAYLAND_DISPLAY). Sin display la suite
 *     se OMITE (no falla) para no romper run-all.sh en terminales sin X.
 *   - La app real NO debe estar corriendo (puerto 3131 libre) — si lo está,
 *     se omite con un aviso.
 *
 * Uso:
 *   ELECTRON_RUN_AS_NODE=1 electron tests/e2e/test_ui_electron.js
 */

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

let passed = 0;
let failed = 0;
let skipped = 0;

function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  ${C.green('✓')} ${label}`);
    passed++;
  } else {
    console.log(`  ${C.red('✗')} ${label}`);
    if (detail) console.log(`    ${C.dim(detail)}`);
    failed++;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hasDisplay() {
  return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

async function portBusy(port) {
  return new Promise((resolve) => {
    const net = require('net');
    const sock = net.connect(port, '127.0.0.1');
    sock.once('connect', () => {
      sock.destroy();
      resolve(true);
    });
    sock.once('error', () => resolve(false));
    sock.setTimeout(1500, () => {
      sock.destroy();
      resolve(false);
    });
  });
}

async function findChatWindow(app) {
  for (let i = 0; i < 80; i++) {
    const wins = await app.windows();
    for (const w of wins) {
      try {
        const url = await w.evaluate(() => window.location.href);
        if (url && url.includes('chat.html')) return w;
      } catch (_) {}
    }
    await sleep(250);
  }
  return null;
}

async function findOverlayWindow(app) {
  const wins = await app.windows();
  for (const w of wins) {
    try {
      const url = await w.evaluate(() => window.location.href);
      if (url && url.includes('index.html')) return w;
    } catch (_) {}
  }
  return null;
}

// Los screenshots son diagnóstico: si fallan (ventana transparente/alwaysOnTop
// a veces no se captura) no deben romper la suite.
async function tryScreenshot(page, name) {
  try {
    await page.screenshot({
      path: require('path').join(__dirname, 'artifacts', name),
      timeout: 10000,
    });
  } catch (e) {
    console.log(C.dim(`  (screenshot ${name} omitido: ${e.message.slice(0, 60)})`));
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────

console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
console.log(C.bold(C.cyan('  E2E UI: Electron + Playwright (ventana de chat + overlay)')));
console.log(C.bold(C.cyan('════════════════════════════════════════════════════════')));

(async () => {
  if (!hasDisplay()) {
    skipped++;
    console.log(C.yellow('\n  (sin DISPLAY/WAYLAND_DISPLAY — suite E2E UI omitida)'));
    console.log('  Úsala bajo X/Wayland o con xvfb-run.');
    console.log(C.bold('\n════════════════════════════════════════════════════════'));
    console.log(`  Resultado: ${C.yellow(`${skipped} skipped`)}  (sin display)`);
    console.log(C.bold('════════════════════════════════════════════════════════'));
    process.exit(0);
  }

  if ((await portBusy(3131)) || (await portBusy(18789))) {
    skipped++;
    console.log(C.yellow('\n  (puerto 3131/18789 ocupado — la app real está corriendo)'));
    console.log('  Cierra la instancia activa y reintenta.');
    console.log(C.bold('\n════════════════════════════════════════════════════════'));
    console.log(
      C.bold(`  Resultado: ${C.yellow(`${skipped} skipped`)}  (puerto 3131/18789 ocupado)`)
    );
    console.log(C.bold('════════════════════════════════════════════════════════'));
    process.exit(0);
  }

  const path = require('path');
  const os = require('os');
  const fs = require('fs');
  const { _electron } = require('playwright');

  const repoRoot = path.join(__dirname, '..', '..');
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'vtuber-e2e-'));
  const artifactsDir = path.join(__dirname, 'artifacts');
  fs.mkdirSync(artifactsDir, { recursive: true });

  /** @type {import('playwright').ElectronApplication | null} */
  let app = null;

  try {
    // El runner corre con ELECTRON_RUN_AS_NODE=1; no debe filtrarse al app hijo
    // o `require('electron')` dentro de electron-updater devuelve el path (no
    // la API) y el main process revienta en getVersion().
    const childEnv = { ...process.env };
    delete childEnv.ELECTRON_RUN_AS_NODE;

    app = await _electron.launch({
      // require('electron') devuelve la ruta del binario cuando el runner es
      // el Node de Electron (ELECTRON_RUN_AS_NODE=1) — y también bajo node.
      executablePath: require('electron'),
      args: ['.', '--no-sandbox', '--disable-gpu', `--user-data-dir=${userData}`],
      cwd: repoRoot,
      env: childEnv,
      timeout: 90000,
    });

    console.log(C.dim('\n  app Electron lanzada, esperando ventana de chat...'));

    const chat = await findChatWindow(app);
    assert(!!chat, 'se abrió la ventana de chat (src/chat.html)', 'timeout buscando chat.html');

    if (!chat) {
      await app.close().catch(() => {});
      app = null;
      throw new Error('No se encontró la ventana de chat');
    }

    // ── Carga básica del chat ─────────────────────────────────────────────
    await chat.waitForSelector('#msg-input', { timeout: 20000 });
    await chat.waitForLoadState('load');

    const headerOk = await chat.evaluate(() => {
      const title = document.getElementById('workspace-title');
      return {
        hasTitle: !!title,
        hasInput: !!document.getElementById('msg-input'),
        hasHeaderModel: !!document.getElementById('header-model'),
        hasCancelBtn: !!document.getElementById('cancel-btn'),
        hasNoSendBtn: !document.getElementById('send-btn'),
        hasThemeToggle: !!document.getElementById('theme-toggle'),
        hasModelsBtn: !!document.getElementById('models-btn'),
        hasNoMcpUi:
          !document.getElementById('mcp-btn') &&
          !document.getElementById('mcp-modal') &&
          !document.getElementById('mcp-count'),
        hasPermsBtn: !!document.getElementById('perms-btn'),
        hasCommandsBtn: !!document.getElementById('commands-btn'),
        hasCloseBtn: !!document.getElementById('close-btn'),
        hasMinimizeBtn: !!document.getElementById('window-minimize'),
        hasMaximizeBtn: !!document.getElementById('window-maximize'),
        windowControlsVisible: [...document.querySelectorAll('.window-control')].every(
          (button) => button.getBoundingClientRect().width > 0
        ),
        hasUpdateBanner: !!document.getElementById('update-banner'),
        hasKeysBanner: !!document.getElementById('keys-banner'),
        hasTaskDock: !!document.getElementById('task-dock'),
        hasNoViewIndicator: !document.getElementById('view-indicator'),
        hasStatusBtn: !!document.getElementById('status-btn'),
        workspaceIsButton: title?.tagName === 'BUTTON',
        headerRows: (() => {
          const workspace = title?.getBoundingClientRect();
          const model = document.getElementById('models-btn')?.getBoundingClientRect();
          const actions = document.querySelector('.header-actions')?.getBoundingClientRect();
          return !!(
            workspace &&
            model &&
            actions &&
            model.top > workspace.top &&
            actions.left > workspace.left &&
            Math.abs(actions.top - workspace.top) < 15
          );
        })(),
        unifiedMode: document.getElementById('agent-mode-badge')?.textContent.trim() === 'Auto',
        title: title ? title.textContent.trim() : null,
      };
    });

    assert(headerOk.hasTitle, 'header con workspace-title');
    assert(headerOk.hasInput, 'input #msg-input presente');
    assert(headerOk.hasHeaderModel, 'header muestra modelo/proveedor activo');
    assert(headerOk.hasCancelBtn, 'botón de cancelar generación presente');
    assert(headerOk.hasNoSendBtn, 'sin botón enviar — envío con Enter (diseño minimizado)');
    assert(headerOk.hasThemeToggle, 'toggle de tema presente');
    assert(headerOk.hasModelsBtn, 'acceso directo a modelos presente');
    assert(headerOk.hasNoMcpUi, 'MCP no aparece en la experiencia de producción');
    assert(headerOk.hasPermsBtn, 'acceso directo a permisos presente');
    assert(headerOk.hasCommandsBtn, 'acceso directo a comandos presente');
    assert(headerOk.hasCloseBtn, 'botón de cerrar presente');
    assert(
      headerOk.hasMinimizeBtn && headerOk.hasMaximizeBtn && headerOk.windowControlsVisible,
      'minimizar, maximizar y cerrar están visibles arriba a la derecha'
    );
    assert(headerOk.hasUpdateBanner, 'banner de auto-update presente (oculto en dev)');
    assert(headerOk.hasKeysBanner, 'banner de API keys presente');
    assert(headerOk.hasTaskDock, 'espacio persistente para el plan presente');
    assert(headerOk.hasNoViewIndicator, 'el label temporal de pose Live2D fue eliminado');
    assert(headerOk.hasStatusBtn, 'la barra ofrece un resumen de estado');
    assert(headerOk.workspaceIsButton, 'el workspace se puede cambiar desde el título');
    assert(headerOk.headerRows, 'acciones arriba a la derecha y modelo en la segunda línea');
    assert(headerOk.unifiedMode, 'la UI expone un flujo AUTO único, sin selector chat/agente');

    await chat.evaluate(() => document.getElementById('status-btn').click());
    const statusSummary = await chat.evaluate(() => ({
      visible: !document.getElementById('status-popover').hidden,
      expanded: document.getElementById('status-btn').getAttribute('aria-expanded') === 'true',
      hasModel: !!document.getElementById('status-model').textContent.trim(),
      hasMode: !!document.getElementById('agent-mode-badge').textContent.trim(),
    }));
    assert(
      statusSummary.visible &&
        statusSummary.expanded &&
        statusSummary.hasModel &&
        statusSummary.hasMode,
      'estado abre el resumen de modelo y modo'
    );
    await chat.evaluate(() => document.getElementById('status-btn').click());

    const executionUi = await chat.evaluate(() => {
      renderPlanBlock({
        kind: 'created',
        steps: ['Inspeccionar', 'Editar', 'Verificar'],
        done: 1,
        total: 3,
      });
      const dock = document.getElementById('task-dock');
      const plan = dock.querySelector('.plan-block');

      const feed = document.getElementById('messages');
      renderActivityBlock(feed, {
        phase: 'start',
        iteration: 999,
        tool: 'edit',
        params: { path: 'demo.js' },
      });
      renderActivityBlock(feed, {
        phase: 'end',
        iteration: 999,
        tool: 'edit',
        params: { path: 'demo.js' },
        status: 'ok',
        result: 'ok',
        meta: {
          oldContent: 'const value = 1;',
          newContent: 'const value = 2;',
          removedLines: [1],
          addedLines: [1],
        },
      });
      const activity = feed.querySelector('.activity-block');
      const result = {
        planVisible: !dock.hidden && plan?.classList.contains('open'),
        planProgress: plan?.textContent.includes('1/3'),
        removedVisible: !!activity?.querySelector('.activity-split-col.old .changed'),
        addedVisible: !!activity?.querySelector('.activity-split-col.new .changed'),
      };
      resetPlanBlock();
      result.planClearsForNextPrompt = dock.hidden && !dock.querySelector('.plan-block');
      renderPlanBlock({
        kind: 'resumed',
        goalId: 22,
        steps: ['Inspeccionar', 'Editar', 'Verificar'],
        done: 1,
        total: 3,
      });
      const resumedPlan = dock.querySelector('.plan-block');
      pausePlanBlock();
      result.planShowsPausedFailure =
        dock.querySelector('.plan-block') === resumedPlan &&
        resumedPlan?.textContent.includes('PLAN PAUSADO');
      renderPlanBlock({
        kind: 'created',
        steps: ['Nuevo análisis', 'Nueva verificación'],
        done: 0,
        total: 2,
      });
      result.newPlanReplacesPrevious =
        dock.querySelector('.plan-block') === resumedPlan &&
        resumedPlan?.textContent.includes('Nuevo análisis') &&
        !resumedPlan?.textContent.includes('Inspeccionar');
      renderPlanBlock({
        kind: 'progress',
        steps: ['Nuevo análisis', 'Nueva verificación'],
        done: 2,
        total: 2,
      });
      preservePlanBlock();
      result.completedPlanRemainsVisible =
        dock.querySelector('.plan-block') === resumedPlan &&
        resumedPlan?.textContent.includes('PLAN COMPLETADO · 2/2') &&
        resumedPlan?.classList.contains('complete');
      activity?.remove();
      resetPlanBlock();
      return result;
    });
    assert(
      executionUi.planVisible && executionUi.planProgress,
      'el plan elegido aparece abierto y muestra progreso'
    );
    assert(
      executionUi.removedVisible && executionUi.addedVisible,
      'las ediciones muestran líneas eliminadas y agregadas'
    );
    assert(
      executionUi.planClearsForNextPrompt,
      'un mensaje nuevo descarta el HUD de la tarea anterior'
    );
    assert(executionUi.planShowsPausedFailure, 'un fallo conserva y marca el plan como pausado');
    assert(
      executionUi.newPlanReplacesPrevious,
      'un plan nuevo reemplaza al anterior sin duplicarlo'
    );
    assert(executionUi.completedPlanRemainsVisible, 'el plan completado permanece visible');

    const bannerVisible = await chat.evaluate(() =>
      document.getElementById('update-banner').classList.contains('visible')
    );
    assert(!bannerVisible, 'banner de auto-update NO visible en desarrollo');
    await sleep(150);
    const contextLabel = await chat.evaluate(() =>
      document.getElementById('footer-session').textContent.trim()
    );
    assert(
      contextLabel.startsWith('Contexto') && !contextLabel.toLowerCase().includes('sesión'),
      'el pie explica el contexto del modelo y no muestra un label de sesión',
      contextLabel
    );

    // Reducir por debajo del breakpoint responsive y restaurar. El panel del
    // avatar debe conservar un tamaño válido; antes terminaba en 0x0 y PIXI
    // dejaba el modelo recortado o invisible al volver.
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().includes('chat.html')
      );
      if (win) win.setSize(700, 520);
    });
    await sleep(250);
    const compactAvatar = await chat.evaluate(async () => {
      const panel = document.getElementById('model-panel');
      const container = document.getElementById('model-canvas-container');
      const canvas = document.getElementById('live2d-chat-canvas');
      const panelRect = panel.getBoundingClientRect();
      const restingRect = container.getBoundingClientRect();
      const restingOverflow = window.getComputedStyle(panel).overflow;
      window.animateAvatarPresence('working');
      await new Promise((resolve) => setTimeout(resolve, 500));
      const animatedRect = container.getBoundingClientRect();
      return {
        visible: window.getComputedStyle(panel).display !== 'none',
        validSize:
          restingRect.width > 1 && restingRect.height > 1 && canvas.width > 1 && canvas.height > 1,
        containedAtRest:
          restingOverflow === 'hidden' &&
          Math.abs(restingRect.left - panelRect.left) < 2 &&
          Math.abs(restingRect.width - panelRect.width) < 2,
        staysFixed: Math.abs(animatedRect.left - restingRect.left) < 2,
        animated: container.classList.contains('avatar-working'),
      };
    });
    assert(
      compactAvatar.visible && compactAvatar.validSize,
      'Live2D conserva dimensiones válidas al compactar la UI'
    );
    assert(
      compactAvatar.containedAtRest,
      'Live2D queda alineado y contenido cuando está en reposo'
    );
    assert(
      compactAvatar.staysFixed,
      'Live2D conserva su posición horizontal durante una animación',
      JSON.stringify(compactAvatar)
    );
    assert(compactAvatar.animated, 'Live2D activa estados visuales de presencia');
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().includes('chat.html')
      );
      if (win) win.setSize(1040, 720);
    });
    await sleep(250);
    assert(
      await chat.evaluate(() => {
        const container = document.getElementById('model-canvas-container').getBoundingClientRect();
        const canvas = document.getElementById('live2d-chat-canvas');
        return container.width > 1 && container.height > 1 && canvas.width > 1 && canvas.height > 1;
      }),
      'Live2D recupera el tamaño al restaurar la UI'
    );

    // ── Tema ──────────────────────────────────────────────────────────────
    // La app envía 'init-theme' en el evento did-finish-load; si se prueba el
    // toggle antes de que ese evento llegue, el tema vuelve al valor por
    // defecto ('dark') justo después del click y la aserción falla por un
    // race (no por un fallo del toggle). Esperar al load event lo elimina.
    // Nota: el click se dispara programáticamente (no `page.click`): con la
    // ventana de chat en `sandbox: true`, los clicks reales de Playwright no
    // completan la actionability (rAF del renderer sandboxed muy throttled en
    // entornos sin WM), pero el handler del toggle corre igual.
    const themeBefore = await chat.evaluate(() => ({
      name: document.documentElement.getAttribute('data-theme'),
      background: window.getComputedStyle(document.documentElement).getPropertyValue('--term-bg'),
      panel: window.getComputedStyle(document.documentElement).getPropertyValue('--term-panel'),
    }));
    await chat.evaluate(() => document.getElementById('theme-toggle').click());
    await sleep(150);
    const themeAfter = await chat.evaluate(() => ({
      name: document.documentElement.getAttribute('data-theme'),
      background: window.getComputedStyle(document.documentElement).getPropertyValue('--term-bg'),
      panel: window.getComputedStyle(document.documentElement).getPropertyValue('--term-panel'),
    }));
    assert(
      themeAfter.name && themeAfter.name !== themeBefore.name,
      `toggle de tema cambia data-theme (${themeBefore.name || '?'} → ${themeAfter.name})`
    );
    assert(
      themeAfter.background !== themeBefore.background && themeAfter.panel !== themeBefore.panel,
      'el tema cambia fondos y superficies además del acento'
    );

    // ── Modal de settings (ahora el picker de modelos) ───────────────────
    // El botón vive dentro de #keys-banner (oculto cuando hay proveedor por
    // defecto), así que se dispara programáticamente — el handler corre igual.
    await chat.evaluate(() => {
      document.getElementById('models-btn').focus();
      document.getElementById('open-settings-btn').click();
    });
    await sleep(300);
    const settingsOpen = await chat.evaluate(() =>
      document.getElementById('settings-modal').classList.contains('visible')
    );
    assert(settingsOpen, 'picker de modelos se abre con "Elegir modelo"');
    const hasSearch = await chat.evaluate(() => Boolean(document.getElementById('picker-search')));
    assert(hasSearch, 'picker tiene campo de búsqueda');
    assert(
      await chat.evaluate(() => document.activeElement?.id === 'picker-search'),
      'al abrir el picker el foco pasa a la búsqueda'
    );
    await chat.evaluate(() => document.getElementById('picker-close').click());
    await sleep(150);
    const settingsClosed = await chat.evaluate(
      () => !document.getElementById('settings-modal').classList.contains('visible')
    );
    assert(settingsClosed, 'picker de modelos se cierra con ×');
    assert(
      await chat.evaluate(() => document.activeElement?.id === 'models-btn'),
      'al cerrar el picker el foco vuelve al botón que lo abrió'
    );

    // ── Accesos directos a módulos ───────────────────────────────────────
    await chat.evaluate(() => document.getElementById('perms-btn').click());
    await sleep(200);
    assert(
      await chat.evaluate(() =>
        document.getElementById('perms-modal').classList.contains('visible')
      ),
      'acceso Permisos abre su módulo'
    );
    const permsUi = await chat.evaluate(() => {
      const tool = document.getElementById('perms-tool');
      const path = document.getElementById('perms-path');
      const close = document.getElementById('perms-close-x').getBoundingClientRect();
      return {
        sameFont:
          tool &&
          path &&
          window.getComputedStyle(tool).fontFamily === window.getComputedStyle(path).fontFamily &&
          window.getComputedStyle(tool).fontFamily ===
            window.getComputedStyle(document.body).fontFamily,
        closeCentered: Math.abs(close.width - close.height) < 1,
        browserPreferences:
          document.getElementById('media-browser-control')?.value === 'external' &&
          document.getElementById('media-browser-preferred')?.value === 'default',
      };
    });
    assert(permsUi.sameFont, 'campos y placeholders de permisos usan la tipografía terminal');
    assert(permsUi.closeCentered, 'la X de Permisos está centrada');
    assert(
      permsUi.browserPreferences,
      'Permisos expone navegador personal/administrado y navegador preferido'
    );
    await chat.evaluate(() => document.getElementById('perms-close-x').click());

    await chat.evaluate(() => document.getElementById('settings-btn').click());
    await sleep(200);
    const credentialsUi = await chat.evaluate(() => ({
      open: document.getElementById('prefs-modal').classList.contains('visible'),
      credentials: Boolean(document.getElementById('prefs-llm-credentials')),
      recovery:
        Boolean(document.getElementById('prefs-reset-permissions-btn')) &&
        Boolean(document.getElementById('prefs-factory-reset-btn')) &&
        Boolean(document.getElementById('prefs-previous-versions-btn')),
      onboarding:
        Boolean(document.getElementById('onboarding-models')) &&
        Boolean(document.getElementById('onboarding-permissions')) &&
        Boolean(document.getElementById('onboarding-finish')),
    }));
    assert(credentialsUi.open, 'Ajustes abre el panel de preferencias');
    assert(credentialsUi.credentials, 'Ajustes incluye gestión de credenciales LLM');
    assert(credentialsUi.recovery, 'Ajustes incluye recuperación, borrado y versiones anteriores');
    assert(credentialsUi.onboarding, 'el primer arranque guía modelos, permisos y primera tarea');
    await chat.evaluate(() => document.getElementById('prefs-close').click());

    await chat.fill('#msg-input', '');
    await chat.evaluate(() => document.getElementById('commands-btn').click());
    await sleep(100);
    assert((await chat.inputValue('#msg-input')) === '/', 'acceso Comandos abre la paleta inline');
    assert(
      await chat.evaluate(() => Boolean(document.querySelector('.command-suggestion-description'))),
      'la paleta explica para qué sirve cada comando'
    );
    await chat.fill('#msg-input', '');

    // ── Browser de modelos inline (/model) ────────────────────────────────
    await chat.fill('#msg-input', '/model');
    await chat.evaluate(() => {
      document.getElementById('msg-input').dispatchEvent(new Event('input'));
    });
    await sleep(300);
    const mbrVisible = await chat.evaluate(
      () => document.getElementById('model-browser').style.display !== 'none'
    );
    assert(mbrVisible, '/model expande el browser de modelos inline');
    // Sin API keys el browser arranca mostrando solo conectados/favoritos
    // (posiblemente 0 filas). El toggle expande el catálogo completo — esa es
    // la vista que hay que validar (no depende de credenciales en el runner).
    await chat.evaluate(() => document.getElementById('mbr-toggle-all').click());
    await sleep(200);
    const mbrRows = await chat.evaluate(
      () => document.querySelectorAll('#model-browser-list .model-browser-row').length
    );
    assert(mbrRows > 0, `browser lista modelos (${mbrRows} filas)`);
    const mbrHasProvider = await chat.evaluate(() => {
      const first = document.querySelector('#model-browser-list .model-browser-row');
      return first ? first.querySelector('.mbr-provider') !== null : false;
    });
    assert(mbrHasProvider, 'cada modelo muestra su empresa debajo');
    await chat.fill('#msg-input', '/model chatgpt');
    await chat.evaluate(() => {
      document.getElementById('msg-input').dispatchEvent(new Event('input'));
    });
    await sleep(150);
    const searchDedupe = await chat.evaluate(() => {
      const labels = [...document.querySelectorAll('#model-browser-list .mbr-name')].map((el) =>
        el.textContent.trim().toLowerCase()
      );
      return { count: labels.length, unique: new Set(labels).size };
    });
    assert(
      searchDedupe.count > 0 && searchDedupe.count === searchDedupe.unique,
      'la búsqueda por empresa no repite modelos'
    );
    await chat.fill('#msg-input', '/model o3');
    await chat.evaluate(() => {
      document.getElementById('msg-input').dispatchEvent(new Event('input'));
    });
    await sleep(150);
    const reasoningRow = await chat.evaluate(() => {
      const row = document.querySelector(
        '#model-browser-list .mbr-group[data-provider="openai"] .model-browser-row, #model-browser-list .mbr-group[data-provider="openrouter"] .model-browser-row'
      );
      if (!row) {
        return {
          found: false,
          providers: [...document.querySelectorAll('.mbr-group')].map(
            (group) => group.dataset.provider
          ),
        };
      }
      row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      return { found: true, label: row.textContent.trim() };
    });
    await sleep(100);
    const hasEffortControl = await chat.evaluate(() =>
      Boolean(document.querySelector('.mbr-effort-select'))
    );
    assert(
      reasoningRow.found && hasEffortControl,
      'los modelos compatibles permiten elegir esfuerzo de razonamiento',
      JSON.stringify({ reasoningRow, hasEffortControl })
    );
    await chat.evaluate(() => {
      document
        .getElementById('msg-input')
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await sleep(150);
    const mbrClosed = await chat.evaluate(
      () => document.getElementById('model-browser').style.display === 'none'
    );
    assert(mbrClosed, 'Esc cierra el browser de modelos');
    await chat.fill('#msg-input', '');

    // ── Input funcional ───────────────────────────────────────────────────
    await chat.fill('#msg-input', 'hola kaoru, prueba e2e');
    const typed = await chat.inputValue('#msg-input');
    assertEqualish(typed, 'hola kaoru, prueba e2e', 'el textarea acepta texto');

    await tryScreenshot(chat, 'chat.png');

    // ── Overlay ───────────────────────────────────────────────────────────
    const overlay = await findOverlayWindow(app);
    assert(!!overlay, 'se abrió la ventana overlay (src/index.html)');
    if (overlay) {
      await overlay.waitForSelector('#live2d-canvas', { timeout: 15000 });
      const overlayTitle = await overlay.evaluate(() => document.title);
      assert(overlayTitle.includes('Asistente'), `overlay con título (${overlayTitle})`);
      await tryScreenshot(overlay, 'overlay.png');
    }

    console.log(C.dim(`\n  screenshots → ${path.relative(process.cwd(), artifactsDir)}/`));
  } catch (e) {
    assert(false, `E2E UI completó sin errores: ${e.message}`);
  } finally {
    if (app) await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
  }

  console.log(C.bold('\n════════════════════════════════════════════════════════'));
  const total = passed + failed + skipped;
  const skipNote = skipped > 0 ? `  ${C.yellow(`${skipped} skipped`)}` : '';
  if (failed === 0) {
    console.log(
      `  ${C.green('Resultado')}: ${C.green(`${passed} passed`)}  ${C.dim(`0 failed`)}${skipNote}  / ${total} total`
    );
  } else {
    console.log(
      `  Resultado: ${C.green(`${passed} passed`)}  ${C.red(`${failed} failed`)}${skipNote}  / ${total} total`
    );
  }
  console.log(C.bold('════════════════════════════════════════════════════════'));

  if (failed > 0) process.exit(1);
})();

function assertEqualish(a, b, label) {
  assert(a === b, label, `Esperaba "${b}", obtuve "${a}"`);
}
