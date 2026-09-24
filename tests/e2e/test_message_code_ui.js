'use strict';
/* global window, document, navigator, getComputedStyle, renderMarkdown, DOMParser, setAgentState, showThinking, removeThinking, attachRetryDraft, attachRunSummary, pendingFiles */
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
    const chatHtml = fs.readFileSync(path.resolve(__dirname, '../../src/chat.html'), 'utf8');
    await page.evaluate((html) => {
      const parsed = new DOMParser().parseFromString(html, 'text/html');
      document.body.appendChild(parsed.getElementById('input-area'));
    }, chatHtml);
    const activity = fs.readFileSync(
      path.resolve(__dirname, '../../src/chat/activityBlock.js'),
      'utf8'
    );
    await page.addScriptTag({
      content: activity.slice(
        activity.indexOf('const AGENT_STATES'),
        activity.indexOf('// ── Spinner')
      ),
    });
    await page.evaluate(() => setAgentState('thinking', 'Pensando'));
    assert.equal(await page.locator('#composer-status').textContent(), 'Pensando');
    await page.evaluate(() => {
      document.body.dataset.awaitingPermission = 'true';
      setAgentState('working');
    });
    assert.equal(await page.locator('#composer-status').textContent(), 'Esperando tu permiso');
    await page.evaluate(() => {
      document.body.dataset.awaitingPermission = 'false';
      setAgentState('working', 'Consultando memoria');
    });
    assert.equal(await page.locator('#composer-status').textContent(), 'Consultando memoria');
    assert.equal(await page.locator('#attach-btn').count(), 1);
    assert.equal(await page.locator('#models-btn').count(), 1);
    for (const selector of ['.composer-toolbar', '#input-row']) {
      assert.equal(
        await page.locator(selector).evaluate((el) => getComputedStyle(el).paddingRight),
        '20px',
        'los controles mantienen margen respecto al panel del modelo'
      );
    }
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
    await page.addScriptTag({
      content: messages.slice(
        messages.indexOf('function showThinking()'),
        messages.indexOf('// Config LLM')
      ),
    });
    const messageCount = await page.locator('#messages .msg').count();
    await page.addScriptTag({
      content: 'let pendingFiles = []; function addFiles(files) { pendingFiles.push(...files); }',
    });
    await page.addScriptTag({
      content: messages.slice(
        messages.indexOf('function attachRetryDraft('),
        messages.indexOf('function showThinking()')
      ),
    });
    await page.evaluate(() => {
      setAgentState('error', 'Error');
      attachRetryDraft(document.querySelector('.msg-bubble'), 'Revisa este archivo', [
        { name: 'ejemplo.js', size: 15 },
      ]);
      document.getElementById('msg-input').value = 'Mi borrador';
    });
    await page.getByRole('button', { name: 'Preparar reintento' }).click();
    assert.equal(await page.locator('#msg-input').inputValue(), 'Mi borrador');
    await page.locator('#msg-input').fill('');
    await page.getByRole('button', { name: 'Preparar reintento' }).click();
    assert.equal(await page.locator('#msg-input').inputValue(), 'Revisa este archivo');
    assert.equal(await page.evaluate(() => pendingFiles[0].name), 'ejemplo.js');
    await page.evaluate(() => {
      document.getElementById('msg-input').value = '';
      pendingFiles.splice(0);
      attachRunSummary(document.querySelector('.msg-bubble'), {
        toolResults: [
          { ok: true, _action: { tool: 'edit', params: { path: '<script>archivo.js</script>' } } },
          { ok: false, _action: { tool: 'exec', params: { command: 'npm test' } } },
        ],
      });
    });
    assert(
      (await page.locator('.run-summary').textContent()).includes('Sin verificación automática')
    );
    assert(
      (await page.locator('.run-summary').textContent()).includes(
        'npm test · fallido o sin confirmar'
      )
    );
    assert.equal(await page.locator('.run-summary script').count(), 0);
    await page.evaluate(() => {
      showThinking();
      showThinking();
    });
    assert.equal(await page.locator('#composer-status').textContent(), 'Pensando');
    assert.equal(await page.locator('#thinking-msg').count(), 0);
    assert.equal(await page.locator('#messages .msg').count(), messageCount);
    await page.evaluate(() => {
      setAgentState('streaming', 'Respondiendo');
      removeThinking();
    });
    assert.equal(await page.locator('#composer-status').textContent(), 'Respondiendo');
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
    assert.equal(await page.locator('.syntax-keyword').first().textContent(), 'const');
    assert.equal(await page.locator('.syntax-string').first().textContent(), '"Hola, Kaoru"');
    assert.equal(await page.locator('.syntax-function').first().textContent(), 'log');
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
      for (const selector of [
        '.message-code code',
        '.message-code button',
        '.msg-bubble h1',
        '.composer-toolbar button',
        '#composer-status',
      ]) {
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
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(
      await page
        .locator('#composer-status')
        .evaluate((el) => getComputedStyle(el, '::before').animationName),
      'none'
    );
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
    // Usar la estructura completa: el fixture aislado no detecta solapamientos
    // entre la cabecera y la fila del chat en la cuadrícula principal.
    const layout = await browser.newPage();
    await layout.setContent('<html data-theme="dark"><body></body></html>');
    await layout.evaluate((html) => {
      const parsed = new DOMParser().parseFromString(html, 'text/html');
      document.body.appendChild(parsed.getElementById('app'));
      document.getElementById('messages').innerHTML =
        '<div class="msg user"><div class="msg-body"><div class="msg-bubble">¿Cómo estás?</div></div></div>';
    }, chatHtml);
    await layout.addStyleTag({ path: path.resolve(__dirname, '../../src/chat.css') });
    await layout.emulateMedia({ reducedMotion: 'reduce' });
    for (const width of [1200, 760, 480]) {
      await layout.setViewportSize({ width, height: 800 });
      const bounds = await layout.evaluate(() => {
        const header = document.getElementById('header').getBoundingClientRect();
        const chat = document.getElementById('chat-panel').getBoundingClientRect();
        const message = document.querySelector('#messages .msg').getBoundingClientRect();
        return { headerBottom: header.bottom, chatTop: chat.top, messageTop: message.top };
      });
      assert(bounds.chatTop >= bounds.headerBottom, 'la cabecera no invade el chat');
      assert(
        bounds.messageTop >= bounds.headerBottom + 18,
        'el primer mensaje conserva el margen superior'
      );
    }
    await layout.close();
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
