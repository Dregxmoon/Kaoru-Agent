'use strict';

// @ts-check
/**
 * diffBlock.js — bloque visual de diff para las ediciones de archivos del
 * agente (write/edit/apply_patch).
 *
 * Dos usos, mismo renderizado:
 *   1. Card de aprobación: `renderDiffBlockHtml(diff)` devuelve el HTML de un
 *      bloque colapsable (colapsado por defecto) con resumen +N/−M en el
 *      título. La UI lo incrusta ANTES de que el usuario apruebe.
 *   2. Registro navegable post-edición: `renderDiffBlock(diff)` inserta el
 *      mismo bloque en el feed (antes del ancla de actividad), como registro
 *      al que se puede volver después del run.
 *
 * El diff llega desde main con el patch unificado ya calculado (FileDiff.js /
 * openclaw-server) — el renderer no tiene acceso a la lib `diff`. El estado
 * `null` (vista previa no disponible) lo comunica el llamador con el texto
 * explícito "vista previa no disponible"; acá nunca se dibuja un bloque vacío
 * silencioso.
 */

/**
 * @typedef {Object} FileDiff
 * @property {string} path - ruta absoluta del archivo tocado
 * @property {string} [oldContent]
 * @property {string} [newContent]
 * @property {string} patch - patch unificado (headers + líneas)
 * @property {number} added - líneas agregadas
 * @property {number} removed - líneas quitadas
 */

/** @type {HTMLElement | null} */
let _diffAnchor = null; // ancla (bubble del asistente) — se inserta antes

/**
 * Marca el ancla donde se insertan los bloques (junto al ancla de actividad).
 * @param {HTMLElement | null} anchor
 */
function setDiffAnchor(anchor) {
  _diffAnchor = anchor;
}

/**
 * @param {string} s
 * @returns {string}
 */
function _escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Nombre base del archivo (último segmento de la ruta).
 * @param {string} filePath
 * @returns {string}
 */
function _baseName(filePath) {
  const p = String(filePath || '');
  return p.split(/[\\/]/).pop() || p;
}

/**
 * Líneas del patch unificado coloreadas (reutiliza la paleta de activityBlock).
 * @param {string} patch
 * @returns {string}
 */
function _patchLinesHtml(patch) {
  return String(patch || '')
    .split('\n')
    .map((l) => {
      const esc = _escapeHtml(l);
      if (l.startsWith('+') && !l.startsWith('+++')) return `<span class="diff-add">${esc}</span>`;
      if (l.startsWith('-') && !l.startsWith('---')) return `<span class="diff-del">${esc}</span>`;
      if (l.startsWith('@@')) return `<span class="diff-hunk">${esc}</span>`;
      return `<span class="diff-ctx">${esc}</span>`;
    })
    .join('\n');
}

/**
 * HTML del bloque colapsable de un diff (para incrustar en el card de
 * aprobación o como cuerpo del bloque del feed).
 * @param {FileDiff} diff
 * @returns {string}
 */
function renderDiffBlockHtml(diff) {
  if (!diff || typeof diff.patch !== 'string') return '';
  const name = _baseName(diff.path);
  const summary =
    (diff.added > 0 ? `+${diff.added}` : '') +
    (diff.added > 0 && diff.removed > 0 ? '/' : '') +
    (diff.removed > 0 ? `−${diff.removed}` : '');
  return (
    '<div class="diff-block">' +
    `<div class="diff-block-header" role="button" tabindex="0">` +
    `<span class="diff-block-chevron">▸</span>` +
    `<span class="diff-block-file">${_escapeHtml(name)}</span>` +
    (summary ? `<span class="diff-block-summary">${summary}</span>` : '') +
    `</div>` +
    `<div class="diff-block-body"><pre>${_patchLinesHtml(diff.patch)}</pre></div>` +
    '</div>'
  );
}

/**
 * Inserta un bloque de diff como registro navegable en el feed (antes del
 * ancla, mismo patrón que planBlock/activityBlock). El bloque viene colapsado
 * por defecto.
 * @param {FileDiff} diff
 */
function renderDiffBlock(diff) {
  if (!diff || typeof diff.patch !== 'string') return;
  const parent = _diffAnchor ? _diffAnchor.parentNode : document.getElementById('messages');
  if (!parent) return;

  const block = document.createElement('div');
  block.innerHTML = renderDiffBlockHtml(diff);
  const root = /** @type {HTMLElement | null} */ (block.firstChild);
  if (!root) return;
  const header = root.querySelector('.diff-block-header');
  if (header) {
    header.addEventListener('click', () => {
      root.classList.toggle('open');
    });
    header.addEventListener('keydown', (e) => {
      const key = /** @type {KeyboardEvent} */ (e).key;
      if (key === 'Enter' || key === ' ') {
        e.preventDefault();
        root.classList.toggle('open');
      }
    });
  }

  parent.insertBefore(root, _diffAnchor || null);
  const feed = document.getElementById('messages');
  if (feed) feed.scrollTop = feed.scrollHeight;
}

/** Limpia el ancla de diffs (llamar al terminar/cancelar el agent-run). */
function resetDiffBlocks() {
  _diffAnchor = null;
}
