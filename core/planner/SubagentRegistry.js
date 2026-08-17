// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const AP = require('./ActionParser.js');

/**
 * Registro de perfiles de subagentes (F1): define los perfiles disponibles
 * (built-ins + los que el usuario añada como markdown) y resuelve qué
 * herramientas/recursos usa cada uno. Cada perfil declara:
 *   - description: qué hace y cuándo usarlo (la ve el agente principal).
 *   - mode: 'smart' | 'fast' | 'inherit' (heredar el modo del padre).
 *   - temperature: opcional (null = default del provider).
 *   - max_iterations: tope de iteraciones del subagente.
 *   - read_only: true impide herramientas mutadoras (editar/escribir/git push…).
 *   - tools: { allow, deny } listas de nombres (admiten globs "read_*").
 */

// Tools que mutan el workspace o el repo remoto. Con read_only se filtran
// SIEMPRE, aunque el perfil las liste en allow (defensa en profundidad).
const MUTATOR_TOOL_NAMES = new Set([
  'write',
  'edit',
  'apply_patch',
  'create_file',
  'edit_file',
  'move_file',
  'rename_file',
  'create_directory',
  'delete_file',
  'delete_directory',
  'write_file',
  'create_directory',
  'move_file',
  'rename',
  'code_actions',
  'git_add',
  'git_commit',
  'git_push',
  'git_rebase',
  'git_merge',
  'git_stash',
  'git_reset',
  'git_checkout',
  'git_clean',
]);

/** @typedef {'smart'|'fast'|'inherit'} SubagentMode */

/**
 * @typedef {Object} SubagentToolPolicy
 * @property {string[]} allow — nombres permitidos; '*' permite todos.
 * @property {string[]} deny — nombres bloqueados (ganan sobre allow).
 */

/**
 * @typedef {Object} SubagentProfile
 * @property {string} name
 * @property {string} description
 * @property {SubagentMode} mode
 * @property {number|null} temperature
 * @property {number|null} max_iterations
 * @property {boolean} readOnly
 * @property {SubagentToolPolicy} tools
 * @property {'builtin'|'project'|'global'} source
 */

/** Perfiles embebidos que siempre existen. */
/** @type {SubagentProfile[]} */
const BUILTIN_PROFILES = [
  {
    name: 'general',
    description:
      'Propósito general. Úsalo para sub-tareas complejas que requieran escribir archivos, ejecutar comandos o varios pasos. Es el subagente por defecto.',
    mode: 'inherit',
    temperature: null,
    max_iterations: null,
    readOnly: false,
    source: 'builtin',
    tools: { allow: ['*'], deny: [] },
  },
  {
    name: 'explorador',
    description:
      'Solo lectura. Úsalo para investigar el codebase (buscar archivos, grepear símbolos, leer código) sin tocar nada.',
    mode: 'fast',
    temperature: 0.1,
    max_iterations: 6,
    readOnly: true,
    source: 'builtin',
    tools: {
      allow: ['*'],
      deny: [
        'web_search',
        'browser',
        'subagent',
        'task',
        'exec',
        'write',
        'edit',
        'apply_patch',
        'create_file',
        'edit_file',
        'move_file',
        'rename_file',
        'create_directory',
        'delete_file',
        'delete_directory',
        'write_file',
        'rename',
        'code_actions',
        'git_add',
        'git_commit',
        'git_push',
        'git_rebase',
        'git_merge',
        'git_stash',
        'git_reset',
        'git_checkout',
        'git_clean',
      ],
    },
  },
  {
    name: 'investigador',
    description:
      'Búsqueda en la web y lectura. Úsalo para averiguar información externa (documentación, noticias, APIs) y volcar lo relevante, sin tocar archivos.',
    mode: 'fast',
    temperature: 0.2,
    max_iterations: 8,
    readOnly: true,
    source: 'builtin',
    tools: {
      allow: ['*'],
      deny: [
        'exec',
        'subagent',
        'task',
        'write',
        'edit',
        'apply_patch',
        'create_file',
        'edit_file',
        'move_file',
        'rename_file',
        'create_directory',
        'delete_file',
        'delete_directory',
        'write_file',
        'rename',
        'code_actions',
        'git_add',
        'git_commit',
        'git_push',
        'git_rebase',
        'git_merge',
        'git_stash',
        'git_reset',
        'git_checkout',
        'git_clean',
      ],
    },
  },
];

const GLOBAL_SUBAGENT_DIR = path.join(os.homedir(), '.config', 'vtuber-overlay', 'subagents');

/**
 * Parsea el frontmatter (---\n key: value \n---) de un perfil markdown.
 * Soporta keys: description, mode, temperature, max_iterations, read_only,
 * tools_allow, tools_deny. Devuelve { meta, body }.
 *
 * @param {string} raw
 * @returns {{ meta: Record<string, unknown>, body: string }}
 */
function _parseFrontmatter(raw) {
  const lines = raw.split('\n');
  /** @type {Record<string, unknown>} */
  const meta = {};
  let inFrontmatter = false;
  let bodyStart = 0;
  if (lines[0] && lines[0].trim() === '---') {
    inFrontmatter = true;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        bodyStart = i + 1;
        break;
      }
      const colonIdx = lines[i].indexOf(':');
      if (colonIdx === -1) continue;
      const key = lines[i].slice(0, colonIdx).trim().toLowerCase();
      let value = lines[i].slice(colonIdx + 1).trim();
      value = value.replace(/^["']|["']$/g, '');
      if (!value) continue;
      if (key === 'description') {
        meta[key] = value;
      } else if (key === 'mode') {
        const mode = String(value).toLowerCase();
        if (mode === 'smart' || mode === 'fast' || mode === 'inherit') meta.mode = mode;
      } else if (key === 'temperature') {
        const n = Number(value);
        if (Number.isFinite(n) && n >= 0 && n <= 2) meta.temperature = n;
      } else if (key === 'max_iterations') {
        const n = Number(value);
        if (Number.isInteger(n) && n > 0) meta.max_iterations = n;
      } else if (key === 'read_only') {
        meta.readOnly = /^(true|1|yes|sí)$/i.test(value);
      } else if (key === 'tools_allow' || key === 'tools_deny') {
        meta[key] = _parseListValue(value);
      }
    }
  }
  return { meta, body: lines.slice(bodyStart).join('\n').trim() };
}

/**
 * Convierte un valor de lista del frontmatter en array de nombres.
 * Acepta JSON (`[a, b]`), comas o espacios.
 *
 * @param {string} value
 * @returns {string[]}
 */
function _parseListValue(value) {
  if (value.startsWith('[')) {
    try {
      const parsed = JSON.parse(value.replace(/'/g, '"'));
      if (Array.isArray(parsed)) return parsed.map((s) => String(s).trim()).filter(Boolean);
    } catch {
      /* fallback abajo */
    }
  }
  return value
    .replace(/[[\]']/g, '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Coincidencia simple de globs: exacta o prefijo ("read_*").
 *
 * @param {string} pattern
 * @param {string} name
 * @returns {boolean}
 */
function _matchesGlob(pattern, name) {
  if (!pattern) return false;
  if (pattern === '*' || pattern === name) return true;
  if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
  return false;
}

/**
 * Decide si un perfil puede usar una tool concreta del catálogo.
 *
 * @param {SubagentProfile} profile
 * @param {string} toolName
 * @returns {boolean}
 */
function _toolAllowed(profile, toolName) {
  if (profile.tools.deny.some((p) => _matchesGlob(p, toolName))) return false;
  const allowAll = profile.tools.allow.includes('*');
  if (allowAll) {
    if (!profile.readOnly) return true;
    return !MUTATOR_TOOL_NAMES.has(toolName);
  }
  return profile.tools.allow.some((p) => _matchesGlob(p, toolName));
}

class SubagentRegistry {
  /**
   * @param {{ projectDir?: string|null }} [opts]
   */
  constructor(opts = {}) {
    this._projectDir = opts.projectDir || null;
    /** @type {Map<string, SubagentProfile>} */
    this._profiles = new Map();
  }

  get projectDir() {
    return this._projectDir || path.join(AP.PROJECT_CWD, '.kaoru', 'subagents');
  }

  /**
   * @param {SubagentProfile} profile
   */
  _addProfile(profile) {
    if (!profile || !profile.name) return;
    this._profiles.set(profile.name, profile);
  }

  _loadBuiltins() {
    for (const p of BUILTIN_PROFILES) {
      this._addProfile({
        ...p,
        tools: { allow: [...p.tools.allow], deny: [...p.tools.deny] },
        source: 'builtin',
      });
    }
  }

  /**
   * Carga los perfiles markdown de un directorio (proyecto o global).
   * @param {string} dir
   * @param {'project'|'global'} source
   */
  _loadFromDir(dir, source) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const name = entry.name.slice(0, -3).trim();
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) continue;
      let raw = '';
      try {
        raw = fs.readFileSync(path.join(dir, entry.name), 'utf8');
      } catch {
        continue;
      }
      const { meta, body } = _parseFrontmatter(raw);
      if (!body && !meta.description) continue;
      const toolPolicy = {
        allow: /** @type {string[]} */ (meta.tools_allow || ['*']),
        deny: /** @type {string[]} */ (meta.tools_deny || []),
      };
      this._addProfile({
        name,
        description: String(meta.description || body.slice(0, 140)),
        mode: /** @type {SubagentMode} */ (meta.mode || 'inherit'),
        temperature: /** @type {number|null} */ (meta.temperature ?? null),
        max_iterations: /** @type {number|null} */ (meta.max_iterations ?? null),
        readOnly: Boolean(meta.readOnly),
        tools: toolPolicy,
        source,
      });
    }
  }

  /**
   * (Re)construye el registro: built-ins + subagentes de proyecto + globales.
   * Los del proyecto y globales sobreescriben built-ins con el mismo nombre.
   *
   * @returns {this}
   */
  load() {
    this._profiles.clear();
    this._loadBuiltins();
    this._loadFromDir(this.projectDir, 'project');
    this._loadFromDir(GLOBAL_SUBAGENT_DIR, 'global');
    return this;
  }

  /** @returns {SubagentProfile[]} */
  list() {
    return [...this._profiles.values()];
  }

  /**
   * @param {string} name
   * @returns {SubagentProfile|null}
   */
  resolve(name) {
    if (!name) return null;
    return this._profiles.get(name) || null;
  }

  /**
   * Descripción compacta de los perfiles, para inyectar en la descripción de
   * la herramienta subagent (la lee el agente principal al decidir qué perfil
   * pedir).
   *
   * @returns {string}
   */
  describeForPrompt() {
    const lines = [];
    for (const p of this._profiles.values()) {
      const modeTxt = p.mode === 'inherit' ? 'herencia' : p.mode;
      const readTxt = p.readOnly ? ' (solo lectura)' : '';
      lines.push(`- ${p.name}${readTxt}: ${p.description} [modo ${modeTxt}]`);
    }
    return lines.join('\n');
  }
}

/** @type {SubagentRegistry | null} */
let _instance = null;

/**
 * Singleton per-proceso.
 *
 * @param {{ projectDir?: string|null }} [opts]
 * @returns {SubagentRegistry}
 */
function getSubagentRegistry(opts) {
  if (!_instance) {
    _instance = new SubagentRegistry(opts);
    _instance.load();
  }
  return _instance;
}

module.exports = {
  SubagentRegistry,
  getSubagentRegistry,
  _parseFrontmatter,
  _parseListValue,
  _matchesGlob,
  _toolAllowed,
  MUTATOR_TOOL_NAMES,
};
