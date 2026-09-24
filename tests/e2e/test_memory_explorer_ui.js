'use strict';
/* global document, window, openNodes, memoryExplorer */
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');

const os = require('node:os');
async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setContent(
      '<html data-theme="dark"><body><main id="messages"></main></body></html>'
    );
    await page.addStyleTag({ path: path.resolve(__dirname, '../../src/chat.css') });
    await page.evaluate(() => {
      window.messagesEl = document.getElementById('messages');
      window._scrollMessagesToBottom = () => {};
      window.escapeHtml = (s) =>
        String(s).replace(
          /[&<>"']/g,
          (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
        );
      const nodes = Array.from({ length: 250 }, (_, i) => ({
        id: i + 1,
        label: i === 0 ? 'preferencia_terminal' : `recuerdo_${i}`,
        content: i === 0 ? 'Prefiere Warp en Arch Linux' : `Recuerdo ${i} de Kaoru`,
        type: i === 0 ? 'Preference' : 'Project',
        tags: [],
        topic: i === 0 ? 'Linux' : 'Kaoru',
        createdAt: Date.now() - i * 86400000,
        updatedAt: 1,
        lastAccessedAt: 1,
        importance: 0.8,
        pinned: false,
      }));
      window.testCalls = [];
      window.ipcRenderer = {
        invoke: async (channel, payload) => {
          window.testCalls.push({ channel, payload });
          if (channel === 'memory-explorer')
            return {
              ok: true,
              nodes,
              edges: [{ source: 1, target: 2, type: 'related_to', category: 'explicit' }],
              gaps: [{ key: 'comida', trait: 'su comida favorita' }],
              gapPreferences: [],
            };
          if (channel === 'memory-inspect')
            return {
              ok: true,
              node: {
                ...nodes.find((n) => n.id === payload.nodeId),
                metamemory: {},
                confidence: 0.91,
              },
              evidence: [
                { content: 'Uso Warp <img src=x onerror=alert(1)>', source: 'chat', occurredAt: 1 },
              ],
              history: { versions: [], transitions: [] },
            };
          if (channel === 'memory-pin') {
            nodes.find((n) => n.id === payload.nodeId).pinned = payload.pinned;
            return { ok: true };
          }
          return { ok: false, cancelled: true };
        },
      };
    });
    await page.addScriptTag({ path: path.resolve(__dirname, '../../src/chat/nodes.js') });
    await page.evaluate(() => openNodes());
    assert.equal(await page.locator('.memory-clusters button').count(), 2);
    await page.locator('[data-topic="Kaoru"]').click();
    assert.equal(await page.locator('.memory-node').count(), 90);
    await page.locator('[data-action="next"]').click();
    assert.match(await page.locator('.memory-pagination').innerText(), /2 \/ 3/);
    await page.locator('.memory-search').fill('Warp');
    await page.waitForFunction(() => memoryExplorer.query === 'Warp');
    assert.equal(await page.locator('.memory-node').count(), 2);
    await page.locator('.memory-node[data-node="1"]').focus();
    await page.keyboard.press('Enter');
    await page.locator('aside h3').waitFor();
    assert.match(await page.locator('aside').innerText(), /0.91/);
    assert.equal(await page.locator('aside img').count(), 0, 'evidence is escaped');
    await page.locator('[data-edit]').click();
    await page.locator('aside textarea').fill('Prefiere otra terminal');
    await page.locator('[data-save]').click();
    await page.waitForFunction(() => window.testCalls.some((c) => c.channel === 'memory-correct'));
    assert(await page.locator('aside').isVisible(), 'cancel keeps detail and content');
    await page.locator('[data-view="list"]').click();
    assert.equal(await page.locator('.memory-row').count(), 1);
    await page.locator('[data-view="timeline"]').click();
    assert.equal(await page.locator('.memory-list h3').count(), 1);
    await page.locator('[data-action="fullscreen"]').click();
    assert(await page.locator('.memory-fullscreen').count());
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.memory-fullscreen').count(), 0);
    await page.locator('.memory-question input').fill('¿Qué recuerdas sobre Kaoru?');
    await page.locator('.memory-question button').click();
    assert.match(await page.locator('.memory-answer').innerText(), /249 recuerdos/);
    await page.locator('.memory-answer button').click();
    assert(await page.locator('.memory-used').count());
    await page.locator('[data-action="close-detail"]').click();
    await page.setViewportSize({ width: 420, height: 850 });
    await page.screenshot({
      path: path.join(os.tmpdir(), 'kaoru-memory-explorer-mobile.png'),
      fullPage: true,
    });
    assert.deepEqual(errors, []);
    console.log(
      'Memory Explorer UI: clusters, pagination, search, keyboard, detail, escaping, editing, timeline, fullscreen and query passed.'
    );
  } finally {
    await browser.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
