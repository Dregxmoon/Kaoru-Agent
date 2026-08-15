// @ts-check
'use strict';

/**
 * subagent-report.js — auditoría del resumen de un subagente contra sus
 * ediciones reales.
 *
 * El subagente devuelve un reporte en lenguaje natural. Como los resúmenes de
 * LLM no son fiables, se compara lo que el subagente tocó REALMENTE (según sus
 * toolResults, no su texto) contra lo que menciona en el resumen. Si no
 * coincide, se produce una nota de discrepancia que el agente principal decide
 * si atiende — nunca bloquea.
 */

const path = require('path');

/**
 * @typedef {object} ToolParams
 * @property {string} [path]
 * @property {string} [filePath]
 * @property {string} [patch]
 * @property {string} [instructions]
 */

/**
 * @typedef {object} ToolAction
 * @property {ToolParams} [params]
 * @property {string} [tool]
 */

/**
 * @typedef {object} ToolResult
 * @property {boolean} [ok]
 * @property {string} [tool]
 * @property {ToolAction} [_action]
 * @property {ToolParams} [params]
 */

/**
 * Archivos que el subagente tocó REALMENTE: toolResults con tool de edición
 * (`editTools`) y ok:true, extrayendo el path de los params de cada llamada
 * (nunca del resumen de texto, que es justamente lo que hay que auditar).
 * @param {Array<ToolResult>|undefined} toolResults
 * @param {Set<string>} editTools
 * @param {string} projectCwd Raíz del proyecto (para presentar paths relativos).
 * @returns {Array<{ path: string, basename: string }>}
 */
function collectEditedFiles(toolResults, editTools, projectCwd) {
  const out = [];
  const seen = new Set();
  for (const r of toolResults || []) {
    if (!r || !r.ok || !r.tool) continue;
    if (!editTools.has(r.tool)) continue;
    const action = r._action || (r.params ? { params: r.params } : null);
    if (!action) continue;
    for (const p of extractEditedPaths(action)) {
      const basename = path.basename(p);
      const key = basename || p;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ path: displayPath(p, projectCwd), basename });
    }
  }
  return out;
}

/** Paths que una action de edición toca: params.path/filePath + los `+++ b/`
 *  de un apply_patch.
 *  @param {ToolAction} action
 *  @returns {string[]}
 */
function extractEditedPaths(action) {
  const params = action.params || {};
  const out = [];
  const p = params.path || params.filePath;
  if (typeof p === 'string' && p.trim()) out.push(p.trim());
  const patch = params.patch || params.instructions || '';
  if (typeof patch === 'string' && patch) {
    const re = /^\+\+\+ b\/(.+)$/gm;
    let m;
    while ((m = re.exec(patch))) {
      const pp = m[1].trim();
      if (pp && !pp.startsWith('/dev/null')) out.push(pp);
    }
  }
  return [...new Set(out)];
}

/** Presenta un path de forma legible: relativo al proyecto si está adentro.
 *  @param {string} p
 *  @param {string} projectCwd
 *  @returns {string}
 */
function displayPath(p, projectCwd) {
  try {
    if (path.isAbsolute(p)) {
      const rel = path.relative(projectCwd, p);
      if (rel && !rel.startsWith('..')) return rel;
      return p;
    }
    return p;
  } catch {
    return p;
  }
}

/** Menciones de archivos en un texto: tokens con extensión (filtra "v1.0" y
 *  similares).
 *  @param {string} text
 *  @returns {string[]}
 */
function extractMentionedPaths(text) {
  if (!text) return [];
  const re = /(?:\/|\.{1,2}\/)?[A-Za-z0-9_@~]+(?:[./-][A-Za-z0-9_@~]+)*\.([A-Za-z0-9]{1,8})/g;
  const out = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(text))) {
    if (/^\d+$/.test(m[1])) continue;
    if (seen.has(m[0])) continue;
    seen.add(m[0]);
    out.push(m[0]);
  }
  return out;
}

/**
 * Compara lo que el subagente tocó vs. lo que menciona en su resumen.
 * Devuelve null si no hay discrepancia.
 * @param {string} response
 * @param {Array<{ path: string, basename: string }>} editedFiles
 */
function analyzeSubagentReport(response, editedFiles) {
  const resp = String(response || '');
  const mentionedTokens = extractMentionedPaths(resp);
  const mentionedBasenames = new Set(mentionedTokens.map((t) => path.basename(t)));
  const touchedBasenames = new Set(editedFiles.map((f) => f.basename));

  const changedNotMentioned = [];
  for (const f of editedFiles) {
    if (!mentionedBasenames.has(f.basename) && !resp.includes(f.basename)) {
      changedNotMentioned.push(f.path);
    }
  }

  const mentionedNotChanged = [];
  const seen = new Set();
  for (const tok of mentionedTokens) {
    const b = path.basename(tok);
    if (touchedBasenames.has(b)) continue;
    if (seen.has(b)) continue;
    seen.add(b);
    mentionedNotChanged.push(tok);
    if (mentionedNotChanged.length >= 5) break;
  }

  if (changedNotMentioned.length === 0 && mentionedNotChanged.length === 0) return null;
  return { changedNotMentioned, mentionedNotChanged };
}

/** Nota legible de discrepancia para anexar al reporte que ve el padre.
 *  @param {{ changedNotMentioned?: string[], mentionedNotChanged?: string[] }} report
 *  @returns {string}
 */
function formatSubagentDiscrepancy(report) {
  const lines = [
    '[⚠ Discrepancia entre el resumen del subagente y sus ediciones reales — verificá por tu cuenta antes de confiar en el resumen:]',
  ];
  const changed = report.changedNotMentioned || [];
  const mentioned = report.mentionedNotChanged || [];
  if (changed.length > 0) {
    lines.push(`- Cambió archivo(s) que NO menciona en su resumen: ${changed.join(', ')}`);
  }
  if (mentioned.length > 0) {
    lines.push(
      `- Menciona archivo(s) que NO figuran en sus ediciones reales (toolResults): ${mentioned.join(', ')}`
    );
  }
  return lines.join('\n');
}

module.exports = {
  collectEditedFiles,
  extractEditedPaths,
  displayPath,
  extractMentionedPaths,
  analyzeSubagentReport,
  formatSubagentDiscrepancy,
};
