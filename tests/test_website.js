'use strict';
/* global window, document */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../docs/web');
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
};
let passed = 0;
const check = (condition, message) => {
  assert(condition, message);
  passed++;
};

async function main() {
  const server = http.createServer((req, res) => {
    const file = path.resolve(
      root,
      `.${decodeURIComponent(new URL(req.url, 'http://localhost').pathname)}`
    );
    if (!file.startsWith(`${root}${path.sep}`)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (error, buffer) => {
      if (error) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': mime[path.extname(file)] || 'application/octet-stream',
      });
      res.end(buffer);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const base = `http://127.0.0.1:${server.address().port}`;
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      colorScheme: 'light',
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    for (const lang of ['es', 'en', 'ja']) {
      for (const name of ['index', 'guide', 'privacy', 'terms']) {
        const route = `${lang === 'es' ? '' : `${lang}/`}${name}.html`;
        await page.goto(`${base}/${route}`, { waitUntil: 'networkidle' });
        await page.evaluate(() => {
          for (const image of document.images) image.loading = 'eager';
        });
        await page.waitForFunction(() => [...document.images].every((image) => image.complete));
        check((await page.locator('html').getAttribute('lang')) === lang, `${route}: language`);
        check(!/\bMCP\b/i.test(await page.locator('body').innerText()), `${route}: no MCP copy`);
        check((await page.locator('h1').count()) === 1, `${route}: one heading`);
        check((await page.locator('.language-bar a').count()) === 3, `${route}: three languages`);
        const broken = await page.evaluate(() =>
          [...document.querySelectorAll('a[href],link[rel="stylesheet"],script[src],img[src]')]
            .map((el) => el.getAttribute('href') || el.getAttribute('src'))
            .filter(Boolean)
        );
        for (const href of broken) {
          const url = new URL(href, `${base}/${route}`);
          if (url.origin !== base) continue;
          const file = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
          assert(fs.existsSync(file), `${route}: missing ${href}`);
          if (url.hash)
            assert(
              fs
                .readFileSync(file, 'utf8')
                .includes(`id="${decodeURIComponent(url.hash.slice(1))}"`),
              `${route}: missing anchor ${href}`
            );
        }
        check(true, `${route}: local links and anchors`);
        check(
          await page.evaluate(() =>
            [...document.images].every((img) => img.complete && img.naturalWidth > 0)
          ),
          `${route}: images load`
        );
        check(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          `${route}: desktop width`
        );
        await page.setViewportSize({ width: 390, height: 844 });
        check(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          `${route}: mobile width`
        );
        if (name === 'index') {
          check(
            (await page.locator('#requirements .requirements-card').count()) === 2,
            `${route}: requirements shown for both modes`
          );
          const specs = await page.locator('#requirements table tbody').allTextContents();
          check(
            specs[0].includes('4 GB') && specs[0].includes('8 GB') && specs[1].includes('16 GB'),
            `${route}: RAM minimums and recommendations visible`
          );
          check(
            (await page.locator('#site-navigation a[href="index.html#requirements"]').count()) ===
              1,
            `${route}: requirements reachable from navigation`
          );
        }
        await page.setViewportSize({ width: 1440, height: 1000 });
      }
    }
    check(errors.length === 0, `page errors: ${errors.join(', ')}`);
    await page.goto(`${base}/guide.html#verification`);
    await page.getByRole('link', { name: '日本語', exact: true }).click();
    check(
      page.url().endsWith('/ja/guide.html#verification'),
      'language switch preserves page and section'
    );
    await page.locator('#theme-toggle').click();
    await page.reload();
    check(
      await page.locator('html').evaluate((el) => el.classList.contains('dark')),
      'theme persists'
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.menu-toggle').click();
    check(
      (await page.locator('.menu-toggle').getAttribute('aria-expanded')) === 'true',
      'mobile menu opens'
    );
    await page.keyboard.press('Escape');
    check(
      (await page.locator('.menu-toggle').getAttribute('aria-expanded')) === 'false',
      'Escape closes mobile menu'
    );
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${base}/index.html`);
    check(
      (await page.locator('.reveal-pending').count()) === 0,
      'reduced motion keeps content visible'
    );
    const noJs = await browser.newContext({
      javaScriptEnabled: false,
      viewport: { width: 390, height: 844 },
    });
    const plain = await noJs.newPage();
    await plain.goto(`${base}/en/index.html`);
    check(
      await plain.getByRole('heading', { name: 'More than a coding agent' }).isVisible(),
      'content available without JavaScript'
    );
    check(
      await plain.locator('#site-navigation').isVisible(),
      'mobile navigation available without JavaScript'
    );
    await noJs.close();
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(`${base}/guide.html`);
    await page.locator('[data-copy]').click();
    await page.waitForFunction(
      () => document.querySelector('.copy-status')?.textContent === 'Copiado'
    );
    check(
      (await page.locator('.copy-status').textContent()) === 'Copiado',
      'copy commands reports success'
    );
    check(
      await page.evaluate(async () =>
        (await window.navigator.clipboard.readText()).startsWith('git clone')
      ),
      'copy writes actual commands'
    );
    const blockedStorage = await browser.newContext();
    await blockedStorage.addInitScript(() =>
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw new Error('blocked');
        },
      })
    );
    const resilient = await blockedStorage.newPage();
    const storageErrors = [];
    resilient.on('pageerror', (error) => storageErrors.push(error.message));
    await resilient.goto(`${base}/index.html`);
    await resilient.locator('#theme-toggle').click();
    check(storageErrors.length === 0, 'theme works when storage is blocked');
    await blockedStorage.close();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${base}/index.html`);
    await page.locator('#theme-toggle').click();
    await page.evaluate(() => {
      for (const image of document.images) image.loading = 'eager';
    });
    await page.waitForFunction(() => [...document.images].every((image) => image.complete));
    await page.screenshot({
      path: path.join(os.tmpdir(), 'kaoru-landing-desktop.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/ja/index.html`);
    await page.evaluate(() => {
      for (const image of document.images) image.loading = 'eager';
    });
    await page.waitForFunction(() => [...document.images].every((image) => image.complete));
    await page.screenshot({
      path: path.join(os.tmpdir(), 'kaoru-landing-mobile.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${base}/en/privacy.html`);
    await page.locator('#theme-toggle').click();
    await page.screenshot({ path: path.join(os.tmpdir(), 'kaoru-landing-privacy.png') });
    console.log(`Resultado: ${passed} passed  0 failed`);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
