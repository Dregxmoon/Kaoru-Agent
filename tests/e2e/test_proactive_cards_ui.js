'use strict';
/* global document, window, _renderProposal */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<textarea id="msg-input"></textarea><main id="cards"></main>');
    await page.evaluate(() => {
      window.decisions = [];
      window.ipcRenderer = {
        send: (channel, payload) => window.decisions.push({ channel, payload }),
      };
      window._scrollMessagesToBottom = () => {};
    });
    const source = fs.readFileSync(path.resolve(__dirname, '../../src/chat/ipc.js'), 'utf8');
    const start = source.indexOf('const _proposalActions = new Map();');
    const end = source.indexOf('// Fase B: resultado real', start);
    assert(start >= 0 && end > start);
    await page.addScriptTag({ content: source.slice(start, end) });
    const render = async (proposal) => {
      await page.evaluate((value) => {
        const bubble = document.getElementById('cards');
        bubble.replaceChildren();
        _renderProposal(value, bubble);
      }, proposal);
    };
    await render({ id: 'info', type: 'memory_stale', kind: 'info', action: null });
    await page.getByRole('button', { name: 'Conversar sobre esto' }).click();
    assert(await page.locator('#msg-input').evaluate((el) => el === document.activeElement));
    assert.equal(await page.evaluate(() => window.decisions.at(-1).payload.decision), 'respond');
    assert(!(await page.locator('#cards').innerText()).includes('en proceso'));
    await render({ id: 'later', type: 'memory_tension', kind: 'info', action: null });
    await page.getByRole('button', { name: 'Ahora no' }).click();
    assert.equal(await page.evaluate(() => window.decisions.at(-1).payload.decision), 'deferred');
    await render({ id: 'gap', type: 'knowledge_gap', kind: 'question', action: null });
    await page.getByRole('button', { name: 'No me preguntes esto' }).click();
    assert.equal(await page.evaluate(() => window.decisions.at(-1).payload.decision), 'never');
    await render({
      id: 'action',
      type: 'git_redflag',
      kind: 'action',
      title: 'Añadir .env a .gitignore',
      action: { tool: 'gitignore_add' },
    });
    await page.getByRole('button', { name: 'Añadir .env a .gitignore' }).click();
    assert.equal(await page.evaluate(() => window.decisions.at(-1).payload.decision), 'accepted');
    assert((await page.locator('#cards').innerText()).includes('esperando resultado'));
    console.log('Proactive cards: conversation, deferral, opt-out and explicit actions passed.');
  } finally {
    await browser.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
