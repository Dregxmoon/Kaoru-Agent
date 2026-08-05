'use strict';

const TOOL_SCHEMAS = [
  {
    id: 'openclaw.exec',
    name: 'exec',
    domain: ['shell', 'system', 'git', 'package', 'docker', 'code'],
    source: 'openclaw',
    description: 'Ejecuta cualquier comando en la terminal del sistema',
    params: [
      { name: 'command', type: 'string', description: 'Comando a ejecutar', required: true },
      { name: 'cwd', type: 'string', description: 'Directorio de trabajo (opcional)' },
      { name: 'timeout', type: 'number', description: 'Timeout en segundos', default: 15 },
    ],
    examples: [
      { cmd: 'git status', desc: 'Ver estado del repo' },
      { cmd: 'ls -la', desc: 'Listar archivos' },
      { cmd: 'node script.js', desc: 'Ejecutar script' },
    ],
    highImpact: false,
  },
  {
    id: 'openclaw.read',
    name: 'read',
    domain: ['filesystem', 'code', 'data'],
    source: 'openclaw',
    description: 'Lee el contenido de uno o varios archivos',
    params: [{ name: 'path', type: 'string', description: 'Ruta del archivo', required: true }],
    examples: [
      { cmd: 'README.md', desc: 'Leer README' },
      { cmd: 'src/index.js', desc: 'Leer archivo fuente' },
    ],
    highImpact: false,
  },
  {
    id: 'openclaw.write',
    name: 'write',
    domain: ['filesystem', 'code', 'data'],
    source: 'openclaw',
    description: 'Escribe o sobreescribe contenido en un archivo',
    params: [
      { name: 'path', type: 'string', description: 'Ruta del archivo', required: true },
      { name: 'content', type: 'string', description: 'Contenido a escribir', required: true },
    ],
    examples: [
      { cmd: 'crear index.js con código', desc: 'Crear archivo nuevo' },
      { cmd: 'actualizar config.json', desc: 'Sobreescribir archivo' },
    ],
    highImpact: true,
  },
  {
    id: 'openclaw.edit',
    name: 'edit',
    domain: ['filesystem', 'code'],
    source: 'openclaw',
    description: 'Modifica partes específicas de un archivo (reemplazo exacto de texto)',
    params: [
      { name: 'path', type: 'string', description: 'Ruta del archivo', required: true },
      {
        name: 'oldString',
        type: 'string',
        description: 'Texto exacto a reemplazar',
        required: true,
      },
      { name: 'newString', type: 'string', description: 'Texto nuevo', required: true },
    ],
    examples: [{ cmd: 'cambiar función X por Y', desc: 'Renombrar función' }],
    highImpact: true,
  },
  {
    id: 'openclaw.apply_patch',
    name: 'apply_patch',
    domain: ['filesystem', 'code'],
    source: 'openclaw',
    description: 'Aplica parches multi-bloque a uno o más archivos',
    params: [
      { name: 'path', type: 'string', description: 'Ruta del archivo', required: true },
      { name: 'patch', type: 'string', description: 'Contenido del parche', required: true },
    ],
    highImpact: true,
  },
  {
    id: 'openclaw.code_execution',
    name: 'code_execution',
    domain: ['code', 'data'],
    source: 'openclaw',
    description: 'Ejecuta código Python',
    params: [
      { name: 'code', type: 'string', description: 'Código Python a ejecutar', required: true },
    ],
    highImpact: true,
  },
  {
    id: 'openclaw.browser',
    name: 'browser',
    domain: ['web'],
    source: 'openclaw',
    description: 'Navega a una URL y obtiene el contenido de la página',
    params: [
      {
        name: 'action',
        type: 'string',
        description: 'Acción (navigate, click, read)',
        default: 'navigate',
      },
      { name: 'url', type: 'string', description: 'URL a navegar', required: true },
    ],
    examples: [{ cmd: 'navegar a github.com', desc: 'Abrir página web' }],
    highImpact: true,
  },
  {
    id: 'openclaw.web_search',
    name: 'web_search',
    domain: ['web'],
    source: 'openclaw',
    description: 'Busca información en internet usando Google',
    params: [
      { name: 'query', type: 'string', description: 'Término de búsqueda', required: true },
      { name: 'max_results', type: 'number', description: 'Máximo de resultados', default: 5 },
    ],
    examples: [{ cmd: 'buscar "API de node fs"', desc: 'Buscar en Google' }],
    highImpact: false,
  },
  {
    id: 'openclaw.grep',
    name: 'grep',
    domain: ['filesystem', 'code'],
    source: 'openclaw',
    description: 'Busca un patrón (regex) dentro del contenido de los archivos del proyecto',
    params: [
      {
        name: 'pattern',
        type: 'string',
        description: 'Patrón regex o texto a buscar',
        required: true,
      },
      {
        name: 'path',
        type: 'string',
        description: 'Directorio o archivo donde buscar',
        required: false,
      },
      {
        name: 'include',
        type: 'string',
        description: 'Glob de archivos a incluir, ej: "*.js"',
        required: false,
      },
      {
        name: 'ignore',
        type: 'string',
        description: 'Directorio/patrón a excluir',
        required: false,
      },
      { name: 'max_results', type: 'number', description: 'Máximo de coincidencias', default: 50 },
    ],
    examples: [{ cmd: 'buscar dónde se usa X en el código', desc: 'Grep en el proyecto' }],
    highImpact: false,
  },
  {
    id: 'openclaw.glob',
    name: 'glob',
    domain: ['filesystem', 'code'],
    source: 'openclaw',
    description: 'Lista archivos que coinciden con un patrón glob',
    params: [
      {
        name: 'pattern',
        type: 'string',
        description: 'Patrón glob, ej: "src/**/*.js"',
        required: true,
      },
      { name: 'path', type: 'string', description: 'Directorio base', required: false },
    ],
    examples: [{ cmd: 'listar los archivos de src', desc: 'Glob' }],
    highImpact: false,
  },
  {
    id: 'openclaw.subagent',
    name: 'subagent',
    domain: ['planning', 'code', 'web', 'data'],
    source: 'openclaw',
    description:
      'Lanza un subagente autónomo que resuelve una sub-tarea de forma independiente y devuelve un resumen conciso',
    params: [
      {
        name: 'task',
        type: 'string',
        description: 'Sub-tarea concreta a resolver',
        required: true,
      },
      {
        name: 'context',
        type: 'string',
        description: 'Contexto adicional (opcional)',
        required: false,
      },
      {
        name: 'max_iterations',
        type: 'number',
        description: 'Máximo de iteraciones del subagente',
        default: 8,
      },
    ],
    examples: [{ cmd: 'investigar X y resumir', desc: 'Subagente de investigación' }],
    highImpact: false,
  },
  // ── LSP tools (Fase 7) ─────────────────────────────────────────────────────
  {
    id: 'lsp.get_diagnostics',
    name: 'get_diagnostics',
    domain: ['code', 'lsp'],
    source: 'lsp',
    description:
      'Obtiene diagnósticos (errores, advertencias) de un archivo a través del servidor LSP',
    params: [
      {
        name: 'filePath',
        type: 'string',
        description: 'Ruta del archivo a diagnosticar',
        required: true,
      },
    ],
    highImpact: false,
  },
  {
    id: 'lsp.go_to_definition',
    name: 'go_to_definition',
    domain: ['code', 'lsp'],
    source: 'lsp',
    description: 'Navega a la definición de un símbolo en una posición específica',
    params: [
      { name: 'filePath', type: 'string', description: 'Ruta del archivo', required: true },
      { name: 'line', type: 'number', description: 'Línea (0-indexed)', required: true },
      { name: 'character', type: 'number', description: 'Columna (0-indexed)', required: true },
    ],
    highImpact: false,
  },
  {
    id: 'lsp.find_references',
    name: 'find_references',
    domain: ['code', 'lsp'],
    source: 'lsp',
    description: 'Encuentra todas las referencias a un símbolo en el proyecto',
    params: [
      { name: 'filePath', type: 'string', description: 'Ruta del archivo', required: true },
      { name: 'line', type: 'number', description: 'Línea (0-indexed)', required: true },
      { name: 'character', type: 'number', description: 'Columna (0-indexed)', required: true },
    ],
    highImpact: false,
  },
  {
    id: 'lsp.get_symbols',
    name: 'get_symbols',
    domain: ['code', 'lsp'],
    source: 'lsp',
    description: 'Obtiene la lista de símbolos (funciones, clases, variables) de un archivo',
    params: [{ name: 'filePath', type: 'string', description: 'Ruta del archivo', required: true }],
    highImpact: false,
  },
  // ── Git nativo (§10) ───────────────────────────────────────────────────────
  {
    id: 'git.git_status',
    name: 'git_status',
    domain: ['git', 'code'],
    source: 'git',
    description:
      'Estado del repo git: rama actual, ahead/behind, cambios staged/unstaged, untracked y conflictos',
    params: [
      {
        name: 'cwd',
        type: 'string',
        description: 'Directorio de trabajo (opcional)',
        required: false,
      },
    ],
    highImpact: false,
  },
  {
    id: 'git.git_diff',
    name: 'git_diff',
    domain: ['git', 'code'],
    source: 'git',
    description: 'Diff de cambios no confirmados; con staged=true muestra lo que ya fue agregado',
    params: [
      {
        name: 'file',
        type: 'string',
        description: 'Archivo específico (opcional)',
        required: false,
      },
      {
        name: 'staged',
        type: 'boolean',
        description: 'Diff de lo staged (opcional)',
        required: false,
      },
    ],
    highImpact: false,
  },
  {
    id: 'git.git_log',
    name: 'git_log',
    domain: ['git', 'code'],
    source: 'git',
    description: 'Historial de commits recientes (hash, autor, fecha, subject)',
    params: [
      {
        name: 'count',
        type: 'number',
        description: 'Cantidad de commits (máx 50)',
        default: 20,
        required: false,
      },
      {
        name: 'file',
        type: 'string',
        description: 'Filtrar por archivo (opcional)',
        required: false,
      },
    ],
    highImpact: false,
  },
  {
    id: 'git.git_branch',
    name: 'git_branch',
    domain: ['git', 'code'],
    source: 'git',
    description: 'Lista las ramas locales con su upstream y desfase ahead/behind',
    params: [],
    highImpact: false,
  },
  {
    id: 'git.git_commit',
    name: 'git_commit',
    domain: ['git', 'code'],
    source: 'git',
    description: 'Hace git add -A y commit con el mensaje dado (REQUIERE APROBACIÓN)',
    params: [
      { name: 'message', type: 'string', description: 'Mensaje del commit', required: true },
    ],
    highImpact: true,
  },
  {
    id: 'git.git_stash',
    name: 'git_stash',
    domain: ['git', 'code'],
    source: 'git',
    description:
      'Lista stashes (list, lectura) o ejecuta push/pop/apply/drop (muta, requiere aprobación)',
    params: [
      {
        name: 'action',
        type: 'string',
        description: 'list | push | pop | apply | drop',
        default: 'list',
        required: true,
      },
      {
        name: 'message',
        type: 'string',
        description: 'Mensaje para action=push (opcional)',
        required: false,
      },
    ],
    highImpact: true,
  },
  {
    id: 'git.git_merge',
    name: 'git_merge',
    domain: ['git', 'code'],
    source: 'git',
    description:
      'Fusiona una rama en la actual; detecta conflictos y los devuelve estructurados (REQUIERE APROBACIÓN)',
    params: [
      { name: 'branch', type: 'string', description: 'Rama a fusionar', required: true },
      {
        name: 'message',
        type: 'string',
        description: 'Mensaje del merge (opcional)',
        required: false,
      },
    ],
    highImpact: true,
  },
  {
    id: 'git.git_rebase',
    name: 'git_rebase',
    domain: ['git', 'code'],
    source: 'git',
    description:
      'Reaplica los commits de la rama actual sobre otra; detecta conflictos estructurados (REQUIERE APROBACIÓN)',
    params: [
      { name: 'branch', type: 'string', description: 'Rama base del rebase', required: true },
    ],
    highImpact: true,
  },
  {
    id: 'git.git_push',
    name: 'git_push',
    domain: ['git', 'code', 'github'],
    source: 'git',
    description:
      'Sube los commits de la rama actual al remoto (origin). Usa el token de GitHub conectado si está (REQUIERE APROBACIÓN)',
    params: [
      {
        name: 'remote',
        type: 'string',
        description: 'Remoto (opcional, por defecto origin)',
        required: false,
      },
      {
        name: 'branch',
        type: 'string',
        description: 'Rama a pushear (opcional, por defecto la actual)',
        required: false,
      },
      { name: 'force', type: 'boolean', description: 'Push forzado (peligroso)', required: false },
    ],
    highImpact: true,
  },
  // ── GitHub nativo (§10) ─────────────────────────────────────────────────────
  {
    id: 'github.github_repo_info',
    name: 'github_repo_info',
    domain: ['github', 'git', 'code'],
    source: 'github',
    description:
      'Información de un repo de GitHub (descripción, default branch, estrellas, license)',
    params: [
      { name: 'repo', type: 'string', description: 'Repo en formato "owner/repo"', required: true },
    ],
    highImpact: false,
  },
  {
    id: 'github.github_issue_list',
    name: 'github_issue_list',
    domain: ['github', 'git', 'code'],
    source: 'github',
    description: 'Lista issues de un repo filtrados por estado',
    params: [
      { name: 'repo', type: 'string', description: 'Repo en formato "owner/repo"', required: true },
      {
        name: 'state',
        type: 'string',
        description: 'open | closed | all',
        default: 'open',
        required: false,
      },
      {
        name: 'limit',
        type: 'number',
        description: 'Máx resultados',
        default: 10,
        required: false,
      },
    ],
    highImpact: false,
  },
  {
    id: 'github.github_issue_create',
    name: 'github_issue_create',
    domain: ['github', 'git', 'code'],
    source: 'github',
    description: 'Crea un issue en un repo (REQUIERE APROBACIÓN)',
    params: [
      { name: 'repo', type: 'string', description: 'Repo en formato "owner/repo"', required: true },
      { name: 'title', type: 'string', description: 'Título del issue', required: true },
      { name: 'body', type: 'string', description: 'Cuerpo del issue (opcional)', required: false },
      { name: 'labels', type: 'array', description: 'Labels (opcional)', required: false },
    ],
    highImpact: true,
  },
  {
    id: 'github.github_issue_comment',
    name: 'github_issue_comment',
    domain: ['github', 'git', 'code'],
    source: 'github',
    description: 'Comenta en un issue (REQUIERE APROBACIÓN)',
    params: [
      { name: 'repo', type: 'string', description: 'Repo en formato "owner/repo"', required: true },
      { name: 'issue_number', type: 'number', description: 'Número del issue', required: true },
      { name: 'body', type: 'string', description: 'Cuerpo del comentario', required: true },
    ],
    highImpact: true,
  },
  {
    id: 'github.github_issue_close',
    name: 'github_issue_close',
    domain: ['github', 'git', 'code'],
    source: 'github',
    description: 'Cierra un issue (REQUIERE APROBACIÓN)',
    params: [
      { name: 'repo', type: 'string', description: 'Repo en formato "owner/repo"', required: true },
      { name: 'issue_number', type: 'number', description: 'Número del issue', required: true },
    ],
    highImpact: true,
  },
  {
    id: 'github.github_pr_list',
    name: 'github_pr_list',
    domain: ['github', 'git', 'code'],
    source: 'github',
    description: 'Lista pull requests de un repo filtrados por estado',
    params: [
      { name: 'repo', type: 'string', description: 'Repo en formato "owner/repo"', required: true },
      {
        name: 'state',
        type: 'string',
        description: 'open | closed | all',
        default: 'open',
        required: false,
      },
      {
        name: 'limit',
        type: 'number',
        description: 'Máx resultados',
        default: 10,
        required: false,
      },
    ],
    highImpact: false,
  },
  {
    id: 'github.github_pr_create',
    name: 'github_pr_create',
    domain: ['github', 'git', 'code'],
    source: 'github',
    description: 'Crea una pull request (REQUIERE APROBACIÓN)',
    params: [
      { name: 'repo', type: 'string', description: 'Repo en formato "owner/repo"', required: true },
      { name: 'title', type: 'string', description: 'Título de la PR', required: true },
      { name: 'head', type: 'string', description: 'Rama origen', required: true },
      { name: 'base', type: 'string', description: 'Rama destino', required: true },
      { name: 'body', type: 'string', description: 'Descripción (opcional)', required: false },
    ],
    highImpact: true,
  },
  {
    id: 'github.github_pr_review',
    name: 'github_pr_review',
    domain: ['github', 'git', 'code'],
    source: 'github',
    description:
      'Envía una review a una PR (APPROVE | REQUEST_CHANGES | COMMENT) (REQUIERE APROBACIÓN)',
    params: [
      { name: 'repo', type: 'string', description: 'Repo en formato "owner/repo"', required: true },
      { name: 'pull_number', type: 'number', description: 'Número de la PR', required: true },
      {
        name: 'event',
        type: 'string',
        description: 'APPROVE | REQUEST_CHANGES | COMMENT',
        default: 'COMMENT',
        required: true,
      },
      { name: 'body', type: 'string', description: 'Cuerpo de la review', required: true },
    ],
    highImpact: true,
  },
  {
    id: 'github.github_actions_status',
    name: 'github_actions_status',
    domain: ['github', 'git', 'code'],
    source: 'github',
    description: 'Estado de las GitHub Actions de un repo (runs recientes, status, conclusion)',
    params: [
      { name: 'repo', type: 'string', description: 'Repo en formato "owner/repo"', required: true },
      { name: 'limit', type: 'number', description: 'Máx runs', default: 10, required: false },
    ],
    highImpact: false,
  },
];

class ToolRegistry {
  constructor() {
    this._mcpManager = null;
    this._bridge = null;
    this._lspManager = null;
    /** @type {Array<object>} Tools de plugins registradas dinámicamente */
    this._pluginTools = [];
  }

  setMCPManager(mcp) {
    this._mcpManager = mcp;
  }

  setOpenClawBridge(bridge) {
    this._bridge = bridge;
  }

  setLSPManager(lsp) {
    this._lspManager = lsp;
  }

  /**
   * Registra una tool de plugin (o reemplaza una existente con el mismo id).
   * Formato id: `plugin.<nombre-plugin>.<tool>` (namespaced, patrón MCP).
   * @param {object} tool - { id, name, domain, source, description, params, highImpact, available }
   */
  registerPluginTool(tool) {
    if (!tool || !tool.id || !tool.name) return;
    const idx = this._pluginTools.findIndex((t) => t.id === tool.id);
    if (idx >= 0) this._pluginTools[idx] = { ...tool, source: 'plugin' };
    else this._pluginTools.push({ ...tool, source: 'plugin' });
  }

  /** @param {Array<object>} tools */
  registerPluginTools(tools) {
    for (const t of tools) this.registerPluginTool(t);
  }

  /** @returns {Array<object>} */
  _getPluginTools() {
    return this._pluginTools.map((t) => ({ ...t, available: t.available !== false }));
  }

  _getOpenClawTools() {
    let available = false;
    if (this._bridge) {
      try {
        const stats = this._bridge.getStats?.();
        available = stats?.available ?? false;
      } catch (e) {}
    }
    return TOOL_SCHEMAS.filter((s) => (s.source || 'openclaw') === 'openclaw').map((s) => ({
      ...s,
      available,
    }));
  }

  _getLSPTools() {
    const lspAvailable = this._lspManager?.isRunning || false;
    return TOOL_SCHEMAS.filter((s) => s.source === 'lsp').map((s) => ({
      ...s,
      available: lspAvailable,
    }));
  }

  _getGitTools() {
    return TOOL_SCHEMAS.filter((s) => s.source === 'git').map((s) => ({ ...s, available: true }));
  }

  _getGitHubTools() {
    return TOOL_SCHEMAS.filter((s) => s.source === 'github').map((s) => ({
      ...s,
      available: true,
    }));
  }

  _getMCPTools() {
    if (!this._mcpManager) return [];
    try {
      const tools = this._mcpManager.listAllTools();
      return tools.map((t) => ({
        id: `mcp.${t.server}.${t.tool}`,
        name: t.tool,
        domain: ['mcp'],
        source: 'mcp',
        server: t.server,
        description: t.description || `Tool MCP del servidor ${t.server}`,
        params: t.inputSchema?.properties
          ? Object.entries(t.inputSchema.properties).map(([k, v]) => ({
              name: k,
              type: v.type || 'any',
              description: v.description || '',
              required: t.inputSchema.required?.includes(k) || false,
            }))
          : [],
        highImpact: true,
        available: true,
      }));
    } catch (e) {
      return [];
    }
  }

  getCatalog(domain = null) {
    const openclaw = this._getOpenClawTools();
    const lsp = this._getLSPTools();
    const git = this._getGitTools();
    const github = this._getGitHubTools();
    const mcp = this._getMCPTools();
    const plugin = this._getPluginTools();
    let all = [...openclaw, ...lsp, ...git, ...github, ...mcp, ...plugin];

    if (domain && domain.id) {
      all = all.filter((t) => t.domain.includes(domain.id));
    }

    return {
      tools: all,
      total: all.length,
      openclawAvailable: openclaw.some((t) => t.available),
      lspAvailable: lsp.some((t) => t.available),
      mcpAvailable: mcp.length > 0,
      pluginAvailable: plugin.length > 0,
      bySource: {
        openclaw: openclaw.length,
        lsp: lsp.length,
        git: git.length,
        github: github.length,
        mcp: mcp.length,
        plugin: plugin.length,
      },
    };
  }

  getDomainCatalog(domain) {
    return this.getCatalog(domain);
  }

  getToolById(id) {
    const all = this._getOpenClawTools()
      .concat(this._getLSPTools())
      .concat(this._getGitTools())
      .concat(this._getGitHubTools())
      .concat(this._getMCPTools())
      .concat(this._getPluginTools());
    return all.find((t) => t.id === id) || null;
  }

  serializeToPrompt(domain = null, maxTools = 30) {
    const catalog = this.getCatalog(domain);
    if (catalog.tools.length === 0) return null;

    const lines = ['# HERRAMIENTAS DISPONIBLES'];

    if (domain) {
      lines.push(`Puedes usar estas herramientas para tareas relacionadas con: ${domain.label}`);
    }
    lines.push('');

    const openclawTools = catalog.tools.filter((t) => t.source === 'openclaw');
    const lspTools = catalog.tools.filter((t) => t.source === 'lsp');
    const gitTools = catalog.tools.filter((t) => t.source === 'git');
    const githubTools = catalog.tools.filter((t) => t.source === 'github');
    const mcpTools = catalog.tools.filter((t) => t.source === 'mcp');
    const pluginTools = catalog.tools.filter((t) => t.source === 'plugin');

    if (openclawTools.length > 0) {
      lines.push('## Herramientas del sistema (OpenClaw)');
      for (const t of openclawTools) {
        let line = `  - ${t.name}`;
        if (t.description) line += `: ${t.description}`;
        if (!catalog.openclawAvailable) line += ' (servicio no disponible)';
        lines.push(line);
      }
      lines.push('');
    }

    if (lspTools.length > 0) {
      lines.push('## Herramientas LSP (análisis de código)');
      for (const t of lspTools) {
        let line = `  - ${t.name}`;
        if (t.description) line += `: ${t.description}`;
        if (!catalog.lspAvailable) line += ' (LSP no activo)';
        lines.push(line);
      }
      lines.push('');
    }

    if (mcpTools.length > 0) {
      const usedByOthers =
        openclawTools.length +
        lspTools.length +
        gitTools.length +
        githubTools.length +
        pluginTools.length;
      const capped = mcpTools.slice(0, Math.max(0, maxTools - usedByOthers));
      lines.push('## Herramientas MCP externas');
      for (const t of capped) {
        let line = `  - [${t.server}] ${t.name}`;
        if (t.description) line += ` — ${t.description}`;
        lines.push(line);
      }
      if (mcpTools.length > capped.length) {
        lines.push(`  ... y ${mcpTools.length - capped.length} herramientas más`);
      }
      lines.push('');
    }

    if (gitTools.length > 0) {
      lines.push('## Herramientas Git (nativas)');
      for (const t of gitTools) {
        let line = `  - ${t.name}`;
        if (t.description) line += `: ${t.description}`;
        if (t.highImpact) line += ' (requiere aprobación)';
        lines.push(line);
      }
      lines.push('');
    }

    if (githubTools.length > 0) {
      lines.push('## Herramientas GitHub (nativas)');
      for (const t of githubTools) {
        let line = `  - ${t.name}`;
        if (t.description) line += `: ${t.description}`;
        if (t.highImpact) line += ' (requiere aprobación)';
        lines.push(line);
      }
      lines.push('');
    }

    if (pluginTools.length > 0) {
      lines.push('## Herramientas de plugins');
      for (const t of pluginTools) {
        let line = `  - ${t.name}`;
        if (t.description) line += `: ${t.description}`;
        if (t.highImpact) line += ' (requiere aprobación)';
        lines.push(line);
      }
      lines.push('');
    }

    lines.push('### Formato de uso');
    lines.push('Para usar OpenClaw, describe EXACTAMENTE la acción con el formato apropiado:');
    lines.push('  - Comandos: "Ejecutar: <comando>"');
    lines.push('  - Leer: "Voy a leer el archivo <ruta>"');
    lines.push('  - Escribir: "Voy a escribir el archivo <ruta>"');
    lines.push('  - Editar: "Voy a editar el archivo <ruta>"');
    lines.push('  - Web: "Buscar en internet: <consulta>"');

    if (mcpTools.length > 0) {
      lines.push('');
      lines.push('Para usar herramientas MCP, responde con formato exacto:');
      lines.push('  ```action');
      lines.push(
        '  ACCIÓN: mcp_call | SERVIDOR: <servidor> | HERRAMIENTA: <herramienta> | PARAMS: {...}'
      );
      lines.push('  ```');
    }

    lines.push('');
    lines.push('### Reglas importantes');
    lines.push('1. NUNCA inventes resultados de comandos o herramientas');
    lines.push('2. Anuncia cada acción antes de ejecutarla');
    lines.push('3. Si una acción requiere aprobación, espera confirmación');
    lines.push('4. No ejecutes acciones que no te hayan pedido explícitamente');

    return lines.join('\n');
  }
}

let _instance = null;
function getToolRegistry() {
  if (!_instance) _instance = new ToolRegistry();
  return _instance;
}

module.exports = { ToolRegistry, getToolRegistry };
