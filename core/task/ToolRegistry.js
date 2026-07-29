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
    params: [
      { name: 'path', type: 'string', description: 'Ruta del archivo', required: true },
    ],
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
      { name: 'oldString', type: 'string', description: 'Texto exacto a reemplazar', required: true },
      { name: 'newString', type: 'string', description: 'Texto nuevo', required: true },
    ],
    examples: [
      { cmd: 'cambiar función X por Y', desc: 'Renombrar función' },
    ],
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
      { name: 'action', type: 'string', description: 'Acción (navigate, click, read)', default: 'navigate' },
      { name: 'url', type: 'string', description: 'URL a navegar', required: true },
    ],
    examples: [
      { cmd: 'navegar a github.com', desc: 'Abrir página web' },
    ],
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
    examples: [
      { cmd: 'buscar "API de node fs"', desc: 'Buscar en Google' },
    ],
    highImpact: false,
  },
];

class ToolRegistry {
  constructor() {
    this._mcpManager = null;
    this._bridge = null;
  }

  setMCPManager(mcp) {
    this._mcpManager = mcp;
  }

  setOpenClawBridge(bridge) {
    this._bridge = bridge;
  }

  _getOpenClawTools() {
    let available = false;
    if (this._bridge) {
      try {
        const stats = this._bridge.getStats?.();
        available = stats?.available ?? false;
      } catch(e) {}
    }
    return TOOL_SCHEMAS.map(s => ({
      ...s,
      available,
      source: 'openclaw',
    }));
  }

  _getMCPTools() {
    if (!this._mcpManager) return [];
    try {
      const tools = this._mcpManager.listAllTools();
      return tools.map(t => ({
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
    const mcp = this._getMCPTools();
    let all = [...openclaw, ...mcp];

    if (domain && domain.id) {
      all = all.filter(t => t.domain.includes(domain.id));
    }

    return {
      tools: all,
      total: all.length,
      openclawAvailable: openclaw.some(t => t.available),
      mcpAvailable: mcp.length > 0,
      bySource: {
        openclaw: openclaw.length,
        mcp: mcp.length,
      },
    };
  }

  getDomainCatalog(domain) {
    return this.getCatalog(domain);
  }

  getToolById(id) {
    const all = this._getOpenClawTools().concat(this._getMCPTools());
    return all.find(t => t.id === id) || null;
  }

  serializeToPrompt(domain = null, maxTools = 30) {
    const catalog = this.getCatalog(domain);
    if (catalog.tools.length === 0) return null;

    const lines = ['# HERRAMIENTAS DISPONIBLES'];

    if (domain) {
      lines.push(`Puedes usar estas herramientas para tareas relacionadas con: ${domain.label}`);
    }
    lines.push('');

    const openclawTools = catalog.tools.filter(t => t.source === 'openclaw');
    const mcpTools = catalog.tools.filter(t => t.source === 'mcp');

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

    if (mcpTools.length > 0) {
      const capped = mcpTools.slice(0, maxTools - openclawTools.length);
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
      lines.push('  ACCIÓN: mcp_call | SERVIDOR: <servidor> | HERRAMIENTA: <herramienta> | PARAMS: {...}');
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
