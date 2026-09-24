'use strict';
/* global window, document, navigator, getComputedStyle, renderMarkdown */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 760, height: 850 } });
    await page.setContent(
      '<html data-theme="dark"><body><main id="messages"><div class="msg assistant"><div class="msg-body"><div class="msg-bubble markdown"></div></div></div></main></body></html>'
    );
    await page.addStyleTag({ path: path.resolve(__dirname, '../../src/chat.css') });
    await page.addScriptTag({
      path: path.resolve(__dirname, '../../node_modules/marked/marked.min.js'),
    });
    await page.addScriptTag({
      path: path.resolve(__dirname, '../../node_modules/dompurify/dist/purify.min.js'),
    });
    const source = fs.readFileSync(path.resolve(__dirname, '../../src/chat/core.js'), 'utf8');
    await page.addScriptTag({
      content: source.slice(source.indexOf('const HTML_PREVIEW_RE'), source.indexOf('// Tema\n')),
    });
    const messages = fs.readFileSync(path.resolve(__dirname, '../../src/chat/messages.js'), 'utf8');
    await page.addScriptTag({
      content: messages.slice(0, messages.indexOf('function addMessage(')),
    });
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (text) => {
            window.copiedCode = text;
          },
        },
      });
    });
    const code = 'const saludo = "Hola, Kaoru";\nconsole.log(saludo);\n';
    const markdown =
      '# Una respuesta más legible\n\nEl código conserva **la tipografía del proyecto** y se puede copiar.\n\n```javascript\n' +
      code +
      '```\n\n| Cambio | Resultado |\n| --- | --- |\n| Espaciado | Más cómodo |\n\n> Una nota con contexto.\n';
    await page.evaluate((text) => {
      document.querySelector('.msg-bubble').innerHTML = renderMarkdown(text);
    }, markdown);
    assert.equal(await page.locator('.message-code-language').textContent(), 'javascript');
    assert.equal(await page.locator('.message-code-count').textContent(), '2 líneas');
    assert.equal(await page.locator('.message-table table').count(), 1);
    await page.getByRole('button', { name: 'Copiar', exact: true }).click();
    assert.equal(await page.evaluate(() => window.copiedCode), code);
    await page.getByRole('button', { name: 'Ajustar líneas' }).click();
    assert.equal(
      await page.locator('.message-code pre').evaluate((el) => getComputedStyle(el).whiteSpace),
      'pre-wrap'
    );
    assert.equal(
      await page.getByRole('button', { name: 'Ajustar líneas' }).getAttribute('aria-pressed'),
      'true'
    );
    for (const theme of ['dark', 'light']) {
      await page.evaluate(
        (value) => document.documentElement.setAttribute('data-theme', value),
        theme
      );
      for (const selector of ['.message-code code', '.message-code button', '.msg-bubble h1']) {
        assert(
          (
            await page
              .locator(selector)
              .first()
              .evaluate((el) => getComputedStyle(el).fontFamily)
          ).includes('JetBrains Mono')
        );
      }
    }
    await page.setViewportSize({ width: 360, height: 780 });
    await page.evaluate(() => {
      document.querySelector('.msg-bubble').innerHTML = renderMarkdown(
        '```text\n' + 'x'.repeat(600) + '\n```'
      );
    });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.evaluate(() => {
      document.querySelector('.msg-bubble').innerHTML = renderMarkdown(
        '```html\n<img src=x onerror="window.compromised=true">\n```\n\n<img src=x onerror="window.compromised=true">'
      );
    });
    assert.equal(await page.evaluate(() => Boolean(window.compromised)), false);
    assert.equal(await page.locator('[onerror]').count(), 0);
    await page.evaluate(() => {
      document.querySelector('.msg-bubble').innerHTML = renderMarkdown(
        '```javascript\nconst parcial =',
        { streaming: true }
      );
    });
    assert.equal(await page.locator('.message-code').count(), 1);
    assert((await page.locator('.message-code code').textContent()).includes('const parcial ='));
    console.log(
      'Message UI: code controls, exact copy, typography, themes, mobile, sanitization and streaming passed.'
    );
  } finally {
    await browser.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
