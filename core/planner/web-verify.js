// @ts-check
'use strict';

/**
 * web-verify.js — Validación automática de artefactos web generados.
 *
 * Caso que motiva esto (Pac-Man, agosto 2026): el LLM generó un juego HTML
 * injugable (Pac-Man nacía dentro de una pared) y lo declaró como terminado.
 * El verify clásico corre comandos del PROYECTO — un HTML suelto no tiene
 * ninguno. Este módulo cierra el hueco: carga cada .html mutado en Chromium
 * headless, captura errores de consola/pageerror y los reporta para que el
 * AgentLoop le pida al modelo corregir ANTES de declarar la tarea lista.
 *
 * Diseño:
 *   - Nunca lanza: sin playwright o sin navegador instalado → { skipped }.
 *   - Timeout acotado por página; un page.goto colgado no congela el run.
 *   - Solo se invoca cuando el run MUTÓ archivos .html (cero costo en runs
 *     que no tocan web).
 */

const path = require('path');
const logger = require('../observability/Logger.js');

/** @type {import('playwright').Chromium | null} */
let _chromium = null;
let _chromiumTried = false;

function _loadChromium() {
  if (_chromiumTried) return _chromium;
  _chromiumTried = true;
  for (const id of ['playwright', 'playwright-core']) {
    try {
      // require dinámico intencional: playwright es opcional y se resuelve en
      // runtime con fallback a playwright-core; el catch de abajo lo cubre.
      const pw = require(id);
      if (pw?.chromium) {
        _chromium = pw.chromium;
        break;
      }
    } catch (_) {
      /* siguiente candidato */
    }
  }
  return _chromium;
}

/**
 * Carga una página file:// en Chromium headless y recolecta errores.
 * @param {string} filePath - ruta absoluta del .html
 * @param {{ timeoutMs?: number, settleMs?: number }} [opts]
 * @returns {Promise<{ ok: boolean, skipped?: string, errors: string[] }>}
 */
async function checkPage(filePath, { timeoutMs = 6000, settleMs = 1200 } = {}) {
  const chromium = _loadChromium();
  if (!chromium) return { ok: true, skipped: 'playwright no disponible', errors: [] };

  /** @type {string[]} */
  const errors = [];
  let browser = null;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`consola: ${msg.text().slice(0, 200)}`);
    });
    page.on('pageerror', (err) =>
      errors.push(`excepción: ${String(err?.message || err).slice(0, 200)}`)
    );

    await page.goto('file://' + path.resolve(filePath), {
      waitUntil: 'load',
      timeout: timeoutMs,
    });
    // Dar tiempo a scripts async (canvas games, fetches locales) a fallar si
    // van a fallar.
    await page.waitForTimeout(settleMs);
  } catch (e) {
    errors.push(`carga: ${String(e?.message || e).slice(0, 160)}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Verifica TODOS los .html mutados en un run. Corta en el primer archivo con
 * errores (el feedback al modelo es por archivo, uno basta para iterar).
 * @param {string[]} htmlFiles - rutas absolutas
 * @param {{ maxFiles?: number }} [opts]
 * @returns {Promise<{ ok: boolean, skipped?: string, results: Array<{ file: string, ok: boolean, skipped?: string, errors: string[] }> }>}
 */
async function verifyHtmlFiles(htmlFiles, { maxFiles = 3 } = {}) {
  const files = (htmlFiles || []).slice(0, maxFiles);
  if (files.length === 0) return { ok: true, results: [] };

  if (!_loadChromium()) return { ok: true, skipped: 'playwright no disponible', results: [] };

  /** @type {Array<{ file: string, ok: boolean, skipped?: string, errors: string[] }>} */
  const results = [];
  for (const file of files) {
    const r = await checkPage(file);
    results.push({ file, ...r });
    logger.info(
      'web-verify',
      `[web-verify] ${path.basename(file)}: ${r.skipped ? `skip (${r.skipped})` : r.ok ? 'sin errores ✓' : `${r.errors.length} error(es)`}`
    );
    if (!r.ok && !r.skipped) break;
  }
  const failed = results.find((r) => !r.ok && !r.skipped);
  return { ok: !failed, results };
}

module.exports = { checkPage, verifyHtmlFiles, _loadChromium };
