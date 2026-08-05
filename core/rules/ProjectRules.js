// @ts-check
/**
 * ProjectRules.js — reglas de proyecto auto-inyectadas al prompt.
 *
 * Patrón opencode: el agente lee un archivo de reglas del workspace y las
 * inyecta al system prompt de TODOS los modos (chat, plan, execute, agent).
 *
 * Precedencia por convención (como opencode con AGENTS.md):
 *   1. AGENTS.md           (estándar de facto, primero)
 *   2. CLAUDE.md           (alternativa de Anthropic)
 *   3. .cursorrules        (legacy de Cursor)
 *
 * Las reglas se cachean por (workspace, mtime) para no releer en cada turno:
 * el prompt solo re-lanza IO si el archivo cambió.
 */

const fs = require('fs');
const path = require('path');

// Máx. caracteres de reglas inyectadas — nunca pueden comerse el presupuesto
// de tokens de la tarea.
const MAX_RULES_CHARS = 6000;

// Orden de candidatos (nombres en la raíz del workspace).
const RULE_FILES = ['AGENTS.md', 'CLAUDE.md', '.cursorrules'];

/** @type {{ workspace: string, mtimeMs: number, content: string } | null} */
let _cache = null;

/**
 * Resuelve el archivo de reglas del workspace (precedencia RULE_FILES).
 * @param {string} workspace
 * @returns {string | null} ruta absoluta del archivo de reglas, o null
 */
function _resolveRulesFile(workspace) {
  for (const name of RULE_FILES) {
    const candidate = path.join(workspace, name);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch (_) {
      /* no existe */
    }
  }
  return null;
}

/**
 * Lee las reglas del proyecto con caché por mtime.
 * @param {string} workspace - raíz del proyecto del usuario
 * @returns {string} contenido de las reglas (truncado), o '' si no hay
 */
function readProjectRules(workspace) {
  if (!workspace) return '';
  const file = _resolveRulesFile(workspace);
  if (!file) return '';

  let stat;
  try {
    stat = fs.statSync(file);
  } catch (_) {
    return '';
  }

  if (_cache && _cache.workspace === workspace && _cache.mtimeMs === stat.mtimeMs) {
    return _cache.content;
  }

  let content = '';
  try {
    content = fs.readFileSync(file, 'utf-8');
  } catch (_) {
    return '';
  }

  content = content.trim();
  if (content.length > MAX_RULES_CHARS) {
    content = content.slice(0, MAX_RULES_CHARS) + '\n\n[... reglas truncadas por longitud]';
  }

  _cache = { workspace, mtimeMs: stat.mtimeMs, content };
  return content;
}

/**
 * Serializa las reglas como sección del system prompt.
 * @param {string} workspace - raíz del proyecto del usuario
 * @returns {string} sección listo para pegar al prompt, o '' si no hay reglas
 */
function buildRulesSection(workspace) {
  const rules = readProjectRules(workspace);
  if (!rules) return '';
  return [
    '# REGLAS DEL PROYECTO',
    'Estas reglas del workspace tienen PRIORIDAD sobre cualquier otra instrucción',
    'general. Síguelas siempre que apliquen a la tarea actual:',
    '',
    rules,
  ].join('\n');
}

/** Limpia la caché (útil en tests y al cambiar de workspace). */
function clearRulesCache() {
  _cache = null;
}

module.exports = { readProjectRules, buildRulesSection, clearRulesCache, MAX_RULES_CHARS };
