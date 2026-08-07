/**
 * BrowserBridge.js — navegador propio del asistente (Playwright headless)
 *
 * El asistente tiene su propio navegador Chromium, completamente separado
 * del navegador personal del usuario. Corre headless (sin ventana)
 * y mantiene una sesión persistente mientras la app esté abierta.
 *
 * Responsabilidades:
 *   - browser: navegar, click, leer texto, screenshot
 *   - web_search: búsqueda real en Google/Bing, extrae resultados del HTML
 *
 * Instalación requerida (una sola vez):
 *   npm install playwright
 *   npx playwright install chromium
 */

'use strict';

// Límite de confianza anti prompt-injection (P3): el texto que el navegador
// extrae de páginas web de terceros NO es confiable — una página maliciosa
// puede incluir instrucciones ocultas para el agente. Todo contenido de
// terceros que entra al contexto del LLM pasa por wrapUntrusted (delimitación
// + neutralización de patrones de inyección).
const { wrapUntrusted, wrapUntrustedItems } = require('../grounding/untrustedContent.js');

let _playwright = null;
let _browser = null;
let _page = null;
let _launching = null; // promesa en curso, evita lanzar 2 navegadores en paralelo

/**
 * Lanza el navegador headless si no está corriendo ya.
 * Reutiliza la misma instancia entre llamadas para no pagar el costo
 * de arrancar Chromium en cada acción.
 */
async function _ensureBrowser() {
  if (_browser && _page && !_page.isClosed()) return _page;
  if (_launching) return _launching;

  _launching = (async () => {
    try {
      _playwright = require('playwright');
    } catch (e) {
      throw new Error(
        'Playwright no está instalado. Ejecuta:\n' +
          '  npm install playwright\n' +
          '  npx playwright install chromium'
      );
    }

    console.log('[browser-bridge] lanzando Chromium headless...');
    _browser = await _playwright.chromium.launch({ headless: true });
    _page = await _browser.newPage({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    });
    console.log('[browser-bridge] navegador listo');
    return _page;
  })();

  try {
    return await _launching;
  } finally {
    _launching = null;
  }
}

/**
 * Cierra el navegador. Llamar al cerrar la app (app.on('before-quit')).
 */
async function closeBrowser() {
  if (_browser) {
    await _browser.close().catch(() => {});
    _browser = null;
    _page = null;
    console.log('[browser-bridge] navegador cerrado');
  }
}

// ── Acciones de browser ────────────────────────────────────────────────────────

/**
 * Ejecuta una acción de navegador.
 *
 * @param {object} input
 * @param {string} input.action   — 'navigate' | 'click' | 'get_text' | 'screenshot'
 * @param {string} [input.url]      — para 'navigate'
 * @param {string} [input.selector] — para 'click' / 'get_text'
 */
async function executeBrowserAction(input) {
  const { action, url, selector } = input;
  const page = await _ensureBrowser();

  switch (action) {
    case 'navigate': {
      if (!url) throw new Error('navigate requiere "url"');
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      const title = await page.title();
      return { result: `Navegado a ${url} — título: "${title}"` };
    }

    case 'click': {
      if (!selector) throw new Error('click requiere "selector"');
      await page.click(selector, { timeout: 10000 });
      return { result: `Click ejecutado en: ${selector}` };
    }

    case 'get_text': {
      if (selector) {
        const text = await page.textContent(selector).catch(() => null);
        if (text === null) throw new Error(`No se encontró el elemento: ${selector}`);
        // Contenido de terceros → límite de confianza antes de entrar al prompt.
        return { result: wrapUntrusted(text.trim()) };
      }
      // Sin selector → texto completo del body, recortado para no inflar contexto
      const bodyText = await page.evaluate(() => document.body?.innerText || '');
      return { result: wrapUntrusted(bodyText.slice(0, 5000)) };
    }

    case 'screenshot': {
      const buffer = await page.screenshot({ type: 'png' });
      return { result: `[screenshot] ${buffer.length} bytes (base64 disponible si se requiere)` };
    }

    default:
      throw new Error(`Acción de navegador desconocida: ${action}`);
  }
}

// ── web_search real ───────────────────────────────────────────────────────────

/**
 * Búsqueda real usando el navegador propio del asistente.
 * Navega a Google, extrae título + URL + snippet de los resultados orgánicos.
 *
 * @param {object} input
 * @param {string} input.query
 * @param {number} [input.max_results]
 */
async function executeWebSearch(input) {
  const { query, max_results = 5 } = input;
  if (!query) throw new Error('web_search requiere "query"');

  const page = await _ensureBrowser();
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=es`;

  console.log(`[browser-bridge] web_search: "${query}"`);
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

  // Extraer resultados orgánicos del DOM de Google.
  // Los selectores de Google cambian con frecuencia; este es robusto
  // a varias variantes comunes del HTML de resultados.
  const results = await page.evaluate((max) => {
    const items = [];
    const blocks = document.querySelectorAll('div.g, div[data-sokoban-container]');

    for (const block of blocks) {
      if (items.length >= max) break;

      const titleEl = block.querySelector('h3');
      const linkEl = block.querySelector('a');
      const snippetEl = block.querySelector('div[data-sncf], div.VwiC3b, span.aCOpRe');

      if (titleEl && linkEl?.href) {
        items.push({
          title: titleEl.innerText.trim(),
          url: linkEl.href,
          snippet: snippetEl ? snippetEl.innerText.trim() : '',
        });
      }
    }
    return items;
  }, max_results);

  if (!results.length) {
    return {
      result: [],
      error:
        'No se encontraron resultados (Google pudo haber cambiado su HTML, o hay un captcha bloqueando)',
    };
  }

  // P3: los snippets de resultados son contenido de terceros → límite de
  // confianza (delimitación + neutralización de patrones de inyección).
  console.log(`[browser-bridge] web_search: ${results.length} resultados`);
  return { result: wrapUntrustedItems(results) };
}

module.exports = {
  executeBrowserAction,
  executeWebSearch,
  closeBrowser,
};
