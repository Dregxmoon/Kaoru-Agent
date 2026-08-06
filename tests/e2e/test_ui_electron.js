'use strict';

// @ts-check

// Los callbacks de page.evaluate() corren en la página (browser), aunque el
// test en sí viva en Node — por eso window/document se declaran como globals.
/* global window, document */

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

  if (await portBusy(3131)) {
    skipped++;
    console.log(C.yellow('\n  (puerto 3131 ocupado — la app real está corriendo)'));
    console.log('  Cierra la instancia activa y reintenta.');
    console.log(C.bold('\n════════════════════════════════════════════════════════'));
    console.log(`  Resultado: ${C.yellow(`${skipped} skipped`)}  (puerto 3131 ocupado)`);
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

    const headerOk = await chat.evaluate(() => {
      const title = document.getElementById('workspace-title');
      return {
        hasTitle: !!title,
        hasInput: !!document.getElementById('msg-input'),
        hasSend: !!document.getElementById('send-btn'),
        hasSessions: !!document.getElementById('sessions-btn'),
        hasMcp: !!document.getElementById('mcp-btn'),
        hasPerms: !!document.getElementById('perms-btn'),
        hasWorkspaceBtn: !!document.getElementById('workspace-btn'),
        hasThemeToggle: !!document.getElementById('theme-toggle'),
        hasUpdateBanner: !!document.getElementById('update-banner'),
        hasKeysBanner: !!document.getElementById('keys-banner'),
        title: title ? title.textContent.trim() : null,
      };
    });

    assert(headerOk.hasTitle, 'header con workspace-title');
    assert(headerOk.hasInput, 'input #msg-input presente');
    assert(headerOk.hasSend, 'botón #send-btn presente');
    assert(headerOk.hasSessions, 'botón de sesiones presente');
    assert(headerOk.hasMcp, 'botón MCP presente');
    assert(headerOk.hasPerms, 'botón de permisos presente');
    assert(headerOk.hasWorkspaceBtn, 'botón de workspace (dir) presente');
    assert(headerOk.hasThemeToggle, 'toggle de tema presente');
    assert(headerOk.hasUpdateBanner, 'banner de auto-update presente (oculto en dev)');
    assert(headerOk.hasKeysBanner, 'banner de API keys presente');

    const bannerVisible = await chat.evaluate(() =>
      document.getElementById('update-banner').classList.contains('visible')
    );
    assert(!bannerVisible, 'banner de auto-update NO visible en desarrollo');

    // ── Tema ──────────────────────────────────────────────────────────────
    // La app envía 'init-theme' en el evento did-finish-load; si se prueba el
    // toggle antes de que ese evento llegue, el tema vuelve al valor por
    // defecto ('dark') justo después del click y la aserción falla por un
    // race (no por un fallo del toggle). Esperar al load event lo elimina.
    await chat.waitForLoadState('load');
    const themeBefore = await chat.evaluate(() =>
      document.documentElement.getAttribute('data-theme')
    );
    await chat.click('#theme-toggle');
    await sleep(150);
    const themeAfter = await chat.evaluate(() =>
      document.documentElement.getAttribute('data-theme')
    );
    assert(
      themeAfter && themeAfter !== themeBefore,
      `toggle de tema cambia data-theme (${themeBefore || '?'} → ${themeAfter})`
    );

    // ── Modal de settings ─────────────────────────────────────────────────
    // El botón vive dentro de #keys-banner (oculto cuando hay proveedor por
    // defecto), así que se dispara programáticamente — el handler corre igual.
    await chat.evaluate(() => document.getElementById('open-settings-btn').click());
    await sleep(200);
    const settingsOpen = await chat.evaluate(() =>
      document.getElementById('settings-modal').classList.contains('visible')
    );
    assert(settingsOpen, 'modal de settings se abre con "Abrir configuración"');
    await chat.evaluate(() => document.getElementById('cancel-settings').click());
    await sleep(150);
    const settingsClosed = await chat.evaluate(
      () => !document.getElementById('settings-modal').classList.contains('visible')
    );
    assert(settingsClosed, 'modal de settings se cierra con Cancelar');

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
