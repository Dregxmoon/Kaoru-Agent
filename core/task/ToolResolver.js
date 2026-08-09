// @ts-nocheck
'use strict';

const { getToolSchemas } = require('../llm/ToolSchemas.js');
const { getToolRegistry } = require('./ToolRegistry.js');

const PRECEDENCE_ORDER = ['skill', 'mcp', 'openclaw'];

const PREDEFINED_MCP_DOMAINS = {
  filesystem: ['filesystem', 'code'],
  memory: ['memory', 'data'],
  'sequential-thinking': ['planning', 'reasoning'],
  everything: ['test'],
};

function _getMCPDomains(serverName) {
  return PREDEFINED_MCP_DOMAINS[serverName] || ['mcp'];
}

async function resolveToolset(context = {}) {
  const {
    userMessage = '',
    domain = null,
    toolRegistry,
    skillManager = null,
    mcpManager = null,
    db = null,
    matchedSkills = null,
  } = context;

  const registry = toolRegistry || getToolRegistry();

  const result = {
    promptCatalog: null,
    nativeToolSchemas: null,
    excluded: [],
    precedence: 'openclaw',
    matchedSkills: [],
  };

  // 1. Resolve matched skills
  let skills = matchedSkills;
  if (!skills && skillManager && db) {
    try {
      skills = await skillManager.match(userMessage, db);
    } catch {
      skills = null;
    }
  }
  if (!skills) skills = [];

  result.matchedSkills = skills;

  // 2. Collect all candidate tools
  const openclawTools = registry._getOpenClawTools ? registry._getOpenClawTools() : [];
  const lspTools = registry._getLSPTools ? registry._getLSPTools() : [];
  const gitTools = registry._getGitTools ? registry._getGitTools() : [];
  const githubTools = registry._getGitHubTools ? registry._getGitHubTools() : [];
  const mcpTools = mcpManager ? _getMCPTools(mcpManager) : [];
  const allTools = [];

  const openclawByDomain = _indexToolsByDomain(openclawTools);
  const mcpByDomain = _indexMCPByDomain(mcpTools);

  // 3. Determine excluded domains
  const excludedDomains = new Set();

  // Skills exclude ONLY if replaces_domains is explicitly set
  for (const skill of skills) {
    if (
      !skill.replaces_domains ||
      !Array.isArray(skill.replaces_domains) ||
      skill.replaces_domains.length === 0
    )
      continue;
    for (const d of skill.replaces_domains) {
      excludedDomains.add(d);
    }
  }

  // MCP excludes overlapping OpenClaw domains
  for (const [domain] of mcpByDomain) {
    if (openclawByDomain.has(domain)) {
      excludedDomains.add(domain);
    }
  }

  // Determine precedence winner
  if (skills.length > 0) {
    result.precedence = 'skill';
  } else if (mcpTools.length > 0) {
    result.precedence = 'mcp';
  }

  // 4. Build filtered OpenClaw tools
  const filteredOpenclaw = openclawTools.filter((t) => {
    const tDomains = t.domain || [];
    const hasExcluded = tDomains.some((d) => excludedDomains.has(d));
    if (hasExcluded) result.excluded.push({ source: 'openclaw', tool: t.name, domain: t.domain });
    return !hasExcluded;
  });

  // 5. Build result
  const finalTools = [...filteredOpenclaw, ...lspTools, ...gitTools, ...githubTools, ...mcpTools];

  // Native tool schemas (for tool-calling API)
  const allSchemas = getToolSchemas();
  if (finalTools.length > 0) {
    result.nativeToolSchemas = allSchemas.filter((s) =>
      finalTools.some((ft) => ft.name === s.name)
    );
  }

  // Prompt catalog (text for system prompt)
  if (finalTools.length > 0) {
    result.promptCatalog = _buildPromptCatalog(finalTools, domain, {
      hasSkills: skills.length > 0,
      hasMCP: mcpTools.length > 0,
      hasLSP: lspTools.length > 0,
    });
  }

  return result;
}

function _getMCPTools(mcpManager) {
  try {
    if (typeof mcpManager.listAllTools !== 'function') return [];
    const raw = mcpManager.listAllTools();
    return raw.map((t) => ({
      id: `mcp.${t.server}.${t.tool}`,
      name: t.tool,
      domain: _getMCPDomains(t.server),
      source: 'mcp',
      server: t.server,
      description: t.description || `MCP tool: ${t.tool}`,
      params: t.inputSchema?.properties
        ? Object.entries(t.inputSchema.properties).map(([k, v]) => ({
            name: k,
            type: v.type || 'any',
            description: v.description || '',
            required: t.inputSchema.required?.includes(k) || false,
          }))
        : [],
      available: true,
    }));
  } catch {
    return [];
  }
}

function _indexToolsByDomain(tools) {
  const map = new Map();
  for (const t of tools) {
    const domains = t.domain || [];
    for (const d of domains) {
      if (!map.has(d)) map.set(d, []);
      map.get(d).push(t.name);
    }
  }
  return map;
}

function _indexMCPByDomain(mcpTools) {
  const map = new Map();
  for (const t of mcpTools) {
    const domains = t.domain || ['mcp'];
    for (const d of domains) {
      if (!map.has(d)) map.set(d, []);
      map.get(d).push(`${t.server}/${t.name}`);
    }
  }
  return map;
}

function _buildPromptCatalog(tools, domain, flags) {
  const lines = ['# HERRAMIENTAS DISPONIBLES'];

  if (flags.hasSkills) {
    lines.push('Se han cargado skills específicas que reemplazan herramientas genéricas.');
  }
  lines.push('');

  const openclawTools = tools.filter((t) => t.source === 'openclaw');
  const lspTools = tools.filter((t) => t.source === 'lsp');
  const gitTools = tools.filter((t) => t.source === 'git');
  const githubTools = tools.filter((t) => t.source === 'github');
  const mcpTools = tools.filter((t) => t.source === 'mcp');

  if (openclawTools.length > 0) {
    lines.push('## Herramientas del sistema');
    for (const t of openclawTools) {
      let line = `  - ${t.name}`;
      if (t.description) line += `: ${t.description}`;
      lines.push(line);
    }
    lines.push('');
  }

  if (lspTools.length > 0) {
    lines.push('## Herramientas LSP (análisis de código)');
    for (const t of lspTools) {
      let line = `  - ${t.name}`;
      if (t.description) line += `: ${t.description}`;
      lines.push(line);
    }
    lines.push('');
  }

  if (mcpTools.length > 0) {
    lines.push('## Herramientas MCP');
    const grouped = {};
    for (const t of mcpTools) {
      if (!grouped[t.server]) grouped[t.server] = [];
      grouped[t.server].push(t);
    }
    for (const [server, serverTools] of Object.entries(grouped)) {
      lines.push(`  Servidor: ${server}`);
      for (const t of serverTools) {
        let line = `    - ${t.name}`;
        if (t.description) line += ` — ${t.description}`;
        lines.push(line);
      }
    }
    lines.push('');
    lines.push(
      'Para usar MCP, usa el formato:\n  ```action\n  MCP_TOOL: <servidor>.<herramienta> | ARCHIVO/RUTA/CONTENIDO: <valor>\n  ```\n' +
        '  donde <servidor>.<herramienta> es el nombre EXACTO de la lista de arriba (p.ej. filesystem.write_file).\n' +
        '  ARCHIVO→path, RUTA→path, CONTENIDO→content, COMANDO→command, QUERY→query, URL→url.\n' +
        '  Alternativa clásica:\n' +
        '  ```action\n  ACCIÓN: mcp_call | SERVIDOR: <servidor> | HERRAMIENTA: <herramienta> | PARAMS: {...}\n  ```'
    );
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
    lines.push(
      'Guía de uso: PREFIERE estas herramientas nativas a exec para operaciones de',
      'git (son más confiables y git_commit ya hace add -A). Si usas exec con',
      'comandos git: (1) corre git status antes de commitear; (2) usa "git add ."',
      'salvo que el usuario pida un archivo puntual; (3) si no hay cambios staged,',
      'AVISA y no inventes un commit; (4) usa el mensaje de commit que pidió el',
      'usuario; (5) cuando el push confirme éxito la tarea está completa — detente.'
    );
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

  lines.push('### Formato de uso');
  lines.push('Describe EXACTAMENTE qué acción quieres ejecutar.');
  lines.push('  - Para comandos: describe el comando directamente');
  lines.push('  - Para archivos: describe qué archivo y qué cambio');
  lines.push('  - Para web: describe qué buscar o navegar');

  return lines.join('\n');
}

module.exports = { resolveToolset };
