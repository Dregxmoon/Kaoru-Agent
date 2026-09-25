'use strict';
/* global window, document, DOMParser, getComputedStyle */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 680, height: 420 } });
    await page.setContent(
      '<html data-theme="dark"><body><header id="header"><nav class="header-actions"></nav></header></body></html>'
    );
    const chatHtml = fs.readFileSync(path.resolve(__dirname, '../../src/chat.html'), 'utf8');
    await page.evaluate((html) => {
      const parsed = new DOMParser().parseFromString(html, 'text/html');
      document.querySelector('.header-actions').append(parsed.querySelector('.window-controls'));
      window.controlCalls = [];
      window.controlEvents = {};
      window.ipcRenderer = {
        send(channel, action) {
          window.controlCalls.push({ channel, action });
        },
        on(channel, callback) {
          window.controlEvents[channel] = callback;
        },
      };
    }, chatHtml);
    await page.addStyleTag({ path: path.resolve(__dirname, '../../src/chat.css') });
    await page.addScriptTag({ path: path.resolve(__dirname, '../../src/chat/windowControls.js') });

    assert.equal(await page.locator('.window-control').count(), 3);
    await page.locator('#window-minimize').hover();
    await page.waitForTimeout(250);
    assert.notEqual(
      await page.locator('#window-minimize svg').evaluate((el) => getComputedStyle(el).transform),
      'none',
      'minimizar encoge su icono al acercar el cursor'
    );
    await page.locator('#close-btn').hover();
    await page.waitForTimeout(250);
    assert.notEqual(
      await page.locator('#close-btn svg').evaluate((el) => getComputedStyle(el).transform),
      'none',
      'cerrar rota la X al acercar el cursor'
    );

    await page.locator('#window-minimize').click();
    await page.waitForTimeout(175);
    await page.locator('#window-maximize').click();
    await page.waitForTimeout(175);
    await page.evaluate(() => window.controlEvents['chat-window-maximized']({}, true));
    assert.equal(await page.locator('#window-maximize').getAttribute('aria-pressed'), 'true');
    assert.equal(
      await page.locator('#window-maximize').getAttribute('aria-label'),
      'Restaurar ventana'
    );
    await page.locator('#close-btn').click();
    await page.waitForTimeout(175);
    assert.deepEqual(await page.evaluate(() => window.controlCalls), [
      { channel: 'chat-window-control', action: 'minimize' },
      { channel: 'chat-window-control', action: 'maximize' },
      { channel: 'chat-close', action: 'close' },
    ]);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('#close-btn').hover();
    assert.equal(
      await page.locator('#close-btn svg').evaluate((el) => getComputedStyle(el).transform),
      'none',
      'movimiento reducido desactiva la rotación'
    );
    await page.locator('#window-maximize').click();
    await page.waitForTimeout(20);
    assert.equal((await page.evaluate(() => window.controlCalls)).length, 4);
    console.log('Window controls UI: tres acciones, animaciones y movimiento reducido correctos.');
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
