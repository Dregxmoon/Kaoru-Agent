// @ts-check
'use strict';

/**
 * PluginManager — carga plugins locales que extienden el asistente con tools
 * propias y hooks del pipeline.
 *
 * Formato de un plugin:
 *   plugins/<nombre>/
 *     plugin.json     → { name, version, description, enabled, tools }
 *     index.js        → module.exports = { register(ctx), dispose()? }
 *
 * `register(ctx)` recibe `{ registry, dispatch, logger, workspace }` y puede
 * llamar a `ctx.registerTool({...})` (que reenvía a ToolRegistry con id
 * `plugin.<nombre>.<tool>`) o `ctx.registerHook('beforeAgentRun', fn)`.
 *
 * Los plugins nunca deben bloquear el arranque: si falla el require o el
 * register, se loggea y se sigue con el resto.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_PLUGIN_DIR = path.join(__dirname, '..', '..', 'plugins');

/**
 * @typedef {object} PluginManifest
 * @property {string} [name]
 * @property {string} [id]
 * @property {string} [version]
 * @property {string} [description]
 * @property {boolean} [enabled]
 */

/**
 * @typedef {object} PluginModule
 * @property {Function} register
 * @property {Function} [dispose]
 * @property {Function} [tools]
 * @property {Function} [run]
 */

/**
 * @typedef {object} LoadedPlugin
 * @property {string} name
 * @property {string} id
 * @property {string} version
 * @property {string} description
 * @property {boolean} enabled
 * @property {string} path
 * @property {PluginModule} api
 */

/**
 * @typedef {object} PluginTool
 * @property {string} [id]
 * @property {string} name
 * @property {string} [description]
 * @property {Array<object>} [params]
 * @property {boolean} [highImpact]
 * @property {boolean} [available]
 * @property {string|Array<string>} [domain]
 * @property {string} [source]
 * @property {Function} [run]
 */

/**
 * @typedef {object} ToolRegistryLike
 * @property {(tool: PluginTool) => void} registerPluginTool
 */

class PluginManager {
  /**
   * @param {object} opts
   * @param {string} [opts.pluginDir]
   * @param {(msg: string) => void} [opts.logger]
   */
  constructor(opts = {}) {
    this._pluginDir = opts.pluginDir || DEFAULT_PLUGIN_DIR;
    this._logger = opts.logger || ((msg) => console.log(msg));
    /** @type {Array<LoadedPlugin>} */
    this._plugins = [];
    /** @type {Map<string, Array<Function>>} */
    this._hooks = new Map();
    /** @type {Function|null} */
    this._dispatch = null;
    /** @type {ToolRegistryLike|null} */
    this._registry = null;
  }

  /**
   * @param {object} deps
   * @param {ToolRegistryLike} deps.registry - ToolRegistry (para registrar tools)
   * @param {Function} deps.dispatch - dispatch(toolId, args) → Promise<{ok,result,error}>
   */
  bind({ registry, dispatch }) {
    this._registry = registry;
    this._dispatch = dispatch;
  }

  /**
   * Escanea y carga los plugins del directorio. Devuelve el número cargado.
   * @returns {Promise<number>}
   */
  async load() {
    if (!fs.existsSync(this._pluginDir)) {
      this._logger(`[plugins] dir no existe: ${this._pluginDir}`);
      return 0;
    }
    const entries = fs
      .readdirSync(this._pluginDir, { withFileTypes: true })
      .filter((e) => e.isDirectory());
    let loaded = 0;
    for (const entry of entries) {
      const pluginPath = path.join(this._pluginDir, entry.name);
      try {
        const plugin = this._loadOne(pluginPath, entry.name);
        if (plugin) {
          this._plugins.push(plugin);
          loaded++;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this._logger(`[plugins] error cargando "${entry.name}": ${msg}`);
      }
    }
    this._logger(`[plugins] ${loaded} plugin(s) cargados de ${entries.length} carpeta(s)`);
    return loaded;
  }

  /**
   * Carga un plugin individual (carpeta con plugin.json + index.js).
   * @private
   * @param {string} pluginPath
   * @param {string} name
   * @returns {LoadedPlugin|null}
   */
  _loadOne(pluginPath, name) {
    const manifestPath = path.join(pluginPath, 'plugin.json');
    const indexPath = path.join(pluginPath, 'index.js');
    if (!fs.existsSync(indexPath)) return null;

    let manifest = /** @type {PluginManifest} */ ({});
    if (fs.existsSync(manifestPath)) {
      manifest = /** @type {PluginManifest} */ (JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
    }

    const api = require(indexPath);
    if (!api || typeof api.register !== 'function') {
      this._logger(`[plugins] "${name}" no exporta register() — ignorado`);
      return null;
    }

    const plugin = /** @type {LoadedPlugin} */ ({
      name: manifest.name || name,
      id: manifest.id || name,
      version: manifest.version || '0.0.0',
      description: manifest.description || '',
      enabled: manifest.enabled !== false,
      path: pluginPath,
      api: /** @type {PluginModule} */ (api),
    });

    if (!plugin.enabled) return null;

    if (this._registry && typeof api.tools === 'function') {
      const toolDefs = api.tools() || [];
      for (const def of toolDefs) {
        this._registry.registerPluginTool({
          ...def,
          id: def.id || `plugin.${plugin.id}.${def.name}`,
          domain: ['plugin'],
          source: 'plugin',
        });
      }
    }
    return plugin;
  }

  /**
   * Llama a register(ctx) de cada plugin. ctx es el mismo objeto (mutable)
   * que los plugins reciben, con registerTool y registerHook.
   * @param {object} extra - dependencias extra (db, workspace, etc.)
   * @returns {Array<string>} ids de plugins registrados
   */
  registerAll(extra = {}) {
    const registered = [];
    for (const plugin of this._plugins) {
      try {
        const ctx = this._buildContext(plugin, extra);
        plugin.api.register(ctx);
        registered.push(plugin.id);
        this._logger(`[plugins] "${plugin.id}" registrado`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this._logger(`[plugins] "${plugin.id}" falló register: ${msg}`);
      }
    }
    return registered;
  }

  /**
   * Construye el contexto que recibe register().
   * @private
   * @param {LoadedPlugin} plugin
   * @param {object} extra
   */
  _buildContext(plugin, extra) {
    const self = this;
    return {
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      description: plugin.description,
      path: plugin.path,
      logger: (/** @type {string} */ msg) => self._logger(`[plugin:${plugin.id}] ${msg}`),
      registry: self._registry,
      dispatch: self._dispatch,
      async callPlugin(/** @type {string} */ toolName, args = {}) {
        if (!self._dispatch) return { ok: false, error: 'dispatch no enlazado' };
        return self._dispatch(`plugin.${plugin.id}.${toolName}`, args);
      },
      /** @param {PluginTool} tool */
      registerTool(tool) {
        if (!self._registry) return;
        self._registry.registerPluginTool({
          ...tool,
          id: tool.id || `plugin.${plugin.id}.${tool.name}`,
          domain: tool.domain || ['plugin'],
          source: tool.source || 'plugin',
        });
      },
      /** @param {string} name @param {Function} fn */
      registerHook(name, fn) {
        if (!self._hooks.has(name)) self._hooks.set(name, []);
        self._hooks.get(name)?.push(fn);
      },
      ...extra,
    };
  }

  /**
   * Ejecuta un hook del pipeline. Devuelve el último valor no-undefined, o
   * undefined si no hay hooks. Si un hook lanza, se loggea y se continúa.
   * @param {string} name
   * @param {object} payload
   * @returns {Promise<*>}
   */
  async runHook(name, payload = {}) {
    const hooks = this._hooks.get(name) || [];
    let result;
    for (const fn of hooks) {
      try {
        const r = await fn(payload);
        if (r !== undefined) result = r;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this._logger(`[plugins] hook "${name}" falló: ${msg}`);
      }
    }
    return result;
  }

  /** @returns {Array<object>} */
  list() {
    return this._plugins.map((p) => ({
      id: p.id,
      name: p.name,
      version: p.version,
      description: p.description,
      enabled: p.enabled,
      path: p.path,
    }));
  }

  dispose() {
    for (const plugin of this._plugins) {
      try {
        plugin.api.dispose?.();
      } catch {}
    }
    this._plugins = [];
    this._hooks.clear();
  }
}

/** @type {PluginManager|null} */
let _singleton = null;

/** @returns {PluginManager} */
function getPluginManager() {
  if (!_singleton) _singleton = new PluginManager();
  return _singleton;
}

module.exports = { PluginManager, getPluginManager };
