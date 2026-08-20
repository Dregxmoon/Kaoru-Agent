// @ts-check
/**
 * FileDiff — vista previa de diff para las ediciones de archivos del agente.
 *
 * Calcula en MEMORIA (nunca muta el disco) qué cambiaría una tool mutadora
 * (write/edit/apply_patch) sobre un archivo, para que el chat pueda mostrar el
 * diff REAL antes de la aprobación y como registro navegable después.
 *
 * Contrato del resultado:
 *   - Objeto diff   → se pudo calcular con certeza: { path, oldContent,
 *     newContent, patch, added, removed }.
 *   - null          → estado VÁLIDO: la vista previa NO está disponible (edit
 *     ambiguo, patch que no aplica, path sin resolver). Nunca es un error: el
 *     llamador debe comunicar la ausencia explícitamente en la UI, no romper
 *     el flujo (misma filosofía que toda verificación no-crítica del run).
 */

const fs = require('fs');
const path = require('path');
const Diff = require('diff');

/** Tools de mutación de archivos que admiten vista previa de diff. */
const MUTATOR_TOOLS = new Set(['write', 'edit', 'apply_patch']);

/**
 * Resuelve el path absoluto de un archivo a tocar.
 * @param {Record<string, any>} params
 * @param {string} cwd
 * @returns {string | null}
 */
function _resolvePath(params, cwd) {
  const p = params && (params.path || params.filePath || params.file);
  if (!p || typeof p !== 'string' || !p.trim()) return null;
  return path.isAbsolute(p) ? p : path.resolve(cwd, p);
}

/**
 * Lee el contenido actual de un archivo ('' si no existe).
 * @param {string} filePath
 * @returns {string}
 */
function _readOldContent(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (_) {
    return '';
  }
}

/**
 * Replica el reemplazo determinista de la tool `edit` (openclaw-server): el
 * old_text debe aparecer EXACTAMENTE una vez. Devuelve null si es ambiguo o no
 * existe (no se puede calcular con certeza).
 * @param {string} content
 * @param {string} oldText
 * @param {string} newText
 * @returns {string | null}
 */
function _applyEdit(content, oldText, newText) {
  if (typeof oldText !== 'string' || oldText.length === 0) return null;
  if (typeof newText !== 'string') return null;
  let firstIndex = -1;
  let count = 0;
  let searchFrom = 0;
  while (true) {
    const idx = content.indexOf(oldText, searchFrom);
    if (idx === -1) break;
    if (firstIndex === -1) firstIndex = idx;
    count += 1;
    searchFrom = idx + oldText.length;
  }
  if (count !== 1) return null;
  return content.slice(0, firstIndex) + newText + content.slice(firstIndex + oldText.length);
}

/**
 * Convierte un patch unificado en un diff estructurado con contadores.
 * @param {string} filePath
 * @param {string} oldContent
 * @param {string} newContent
 * @returns {{ path: string, oldContent: string, newContent: string, patch: string, added: number, removed: number }}
 */
function _buildDiff(filePath, oldContent, newContent) {
  const patch = Diff.createTwoFilesPatch(
    'a/' + path.basename(filePath),
    'b/' + path.basename(filePath),
    oldContent,
    newContent,
    '',
    '',
    { context: 3 }
  );
  let added = 0;
  let removed = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) removed += 1;
  }
  return { path: filePath, oldContent, newContent, patch, added, removed };
}

/**
 * Calcula la vista previa de diff de una tool mutadora SIN tocar el disco.
 *
 * @param {object} args
 * @param {string} args.tool  'write' | 'edit' | 'apply_patch'
 * @param {Record<string, any>} [args.params]
 * @param {string} [args.cwd]  directorio base para resolver paths relativos.
 * @returns {null | { path: string, oldContent: string, newContent: string, patch: string, added: number, removed: number }}
 */
function computeDiffPreview({ tool, params = {}, cwd = process.cwd() }) {
  if (!MUTATOR_TOOLS.has(tool)) return null;
  const filePath = _resolvePath(params, cwd);
  if (!filePath) return null;

  if (tool === 'write') {
    const content = params.content;
    if (typeof content !== 'string') return null;
    return _buildDiff(filePath, _readOldContent(filePath), content);
  }

  if (tool === 'edit') {
    const oldContent = _readOldContent(filePath);
    if (!oldContent) return null;
    const oldText = params.old_text ?? params.oldString;
    const newText = params.new_text ?? params.newString;
    const newContent = _applyEdit(oldContent, oldText, newText);
    if (newContent === null) return null;
    return _buildDiff(filePath, oldContent, newContent);
  }

  if (tool === 'apply_patch') {
    const oldContent = _readOldContent(filePath);
    const patchText = params.patch ?? params.instructions ?? params.content;
    if (typeof patchText !== 'string' || !patchText) return null;
    let patched;
    try {
      patched = Diff.applyPatch(oldContent, patchText);
    } catch (_) {
      return null;
    }
    if (patched === false) return null;
    return _buildDiff(filePath, oldContent, patched);
  }

  return null;
}

module.exports = { computeDiffPreview, MUTATOR_TOOLS };
