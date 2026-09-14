// @ts-nocheck
'use strict';
const { swallow } = require('../observability/SwallowedErrors.js');

const { getToolSchemas } = require('../llm/ToolSchemas.js');
const { getToolRegistry } = require('./ToolRegistry.js');
const { CapabilityRouter } = require('./CapabilityRouter.js');

// Dominios por servidor MCP conocido. OJO con 'filesystem': reclama SOLO
// 'filesystem' (no 'code'): el server MCP filesystem ofrece read/write/edit/
// search/list — las openclaw tools read/write/edit/grep/glob (dominio
// 'filesystem') ya se excluyen por ese solapamiento real. Si además reclamara
// 'code', la exclusión por dominio barrería TAMBIÉN exec/code_execution/
// apply_patch/git/LSP, que el server filesystem NO reemplaza — y el agente se
// quedaba sin shell para tareas de archivos ("crea una carpeta y una página").
const PREDEFINED_MCP_DOMAINS = {
  filesystem: ['filesystem'],
  memory: ['memory', 'data'],
  'sequential-thinking': ['planning', 'reasoning'],
  everything: ['test'],
};

// Equivalencias reales entre las tools genéricas de OpenClaw y nombres
// habituales del servidor MCP filesystem. La mera presencia de una tool del
// mismo dominio no basta para reemplazar todas las capacidades del dominio:
// un servidor de solo lectura nunca debe ocultar write/edit.
const FILESYSTEM_MCP_EQUIVALENTS = {
  read: new Set(['read', 'read_file', 'read_text_file', 'read_multiple_files']),
  write: new Set(['write', 'write_file']),
  edit: new Set(['edit', 'edit_file']),
  grep: new Set(['grep', 'search', 'search_files']),
  glob: new Set(['glob', 'find_files', 'search_files']),
};

function _mcpReplacesOpenClaw(tool, mcpTools) {
  const domains = tool.domain || [];
  if (!domains.includes('filesystem')) return false;
  const equivalents = FILESYSTEM_MCP_EQUIVALENTS[tool.name];
  if (!equivalents) return false;
  return mcpTools.some(
    (candidate) => candidate.server === 'filesystem' && equivalents.has(candidate.name)
  );
}

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
    capabilityStatsProvider = null,
  } = context;

  const registry = toolRegistry || getToolRegistry();

  const result = {
    promptCatalog: null,
    nativeToolSchemas: null,
    excluded: [],
    precedence: 'openclaw',
    matchedSkills: [],
    nativeMcpMap: {},
    routing: [],
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
  const desktopTools = registry._getDesktopTools ? registry._getDesktopTools() : [];
  const lspTools = registry._getLSPTools ? registry._getLSPTools() : [];
  const gitTools = registry._getGitTools ? registry._getGitTools() : [];
  const githubTools = registry._getGitHubTools ? registry._getGitHubTools() : [];
  const mcpHealth = {};
  try {
    for (const server of mcpManager?.listServers?.() || []) {
      mcpHealth[server.name] = server.health || {};
    }
  } catch (_) {
    swallow('ToolResolver.resolveToolset');
  }
  let capabilityStats = {};
  try {
    capabilityStats =
      typeof capabilityStatsProvider === 'function' ? (await capabilityStatsProvider()) || {} : {};
  } catch (_) {
    swallow('ToolResolver.resolveToolset');
  }
  const router = new CapabilityRouter({ stats: capabilityStats, mcpHealth });
  const mcpTools = (mcpManager ? _getMCPTools(mcpManager) : []).filter(
    (tool) => !router.score(tool).unavailable
  );

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

  // Determine precedence winner
  if (skills.length > 0) {
    result.precedence = 'skill';
  } else if (mcpTools.length > 0) {
    result.precedence = 'mcp';
  }

  // 4. Build filtered OpenClaw tools
  const filteredOpenclaw = openclawTools.filter((t) => {
    const tDomains = t.domain || [];
    const replacedBySkill = tDomains.some((d) => excludedDomains.has(d));
    const replacedByMCP = _mcpReplacesOpenClaw(t, mcpTools);
    if (replacedBySkill || replacedByMCP) {
      result.excluded.push({ source: 'openclaw', tool: t.name, domain: t.domain });
    }
    return !replacedBySkill && !replacedByMCP;
  });

  // 5. Build result
  const ranked = router.rank([
    ...filteredOpenclaw,
    ...desktopTools,
    ...lspTools,
    ...gitTools,
    ...githubTools,
    ...mcpTools,
  ]);
  const finalTools = ranked.filter((item) => !item.route.unavailable).map((item) => item.tool);
  result.routing = ranked.map((item) => ({
    source: item.tool.source,
    server: item.tool.server || null,
    tool: item.tool.name,
    ...item.route,
  }));

  // Native tool schemas (for tool-calling API)
  const allSchemas = getToolSchemas();
  if (finalTools.length > 0) {
    const schemaByName = new Map(allSchemas.map((schema) => [schema.name, schema]));
    const baseSchemas = finalTools
      .filter((tool) => tool.source !== 'mcp')
      .map((tool) => schemaByName.get(tool.name))
      .filter(Boolean);
    const usedNames = new Set(baseSchemas.map((schema) => schema.name));
    const dynamicMcpSchemas = finalTools
      .filter((tool) => tool.source === 'mcp')
      .map((tool, index) => {
        const safe = (value) =>
          String(value || 'tool')
            .replace(/[^a-zA-Z0-9_]/g, '_')
            .replace(/_+/g, '_');
        let name = `mcp_${index}_${safe(tool.server)}_${safe(tool.name)}`.slice(0, 64);
        while (usedNames.has(name)) name = `${name.slice(0, 58)}_${index}`;
        usedNames.add(name);
        result.nativeMcpMap[name] = { server: tool.server, tool: tool.name };
        return {
          name,
          description: `[MCP ${tool.server}] ${tool.description || tool.name}`.slice(0, 500),
          inputSchema:
            tool.inputSchema && typeof tool.inputSchema === 'object'
              ? tool.inputSchema
              : { type: 'object', properties: {} },
        };
      });
    result.nativeToolSchemas = [...baseSchemas, ...dynamicMcpSchemas];
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
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
      available: true,
    }));
  } catch {
    return [];
  }
}

function _buildPromptCatalog(tools, domain, flags) {
  // Render único compartido (CatalogRenderer.js): mismo texto que antes.
  // `domain` no se usaba en el cuerpo (se conserva el parámetro por firma).
  void domain;
  const { renderToolCatalog } = require('./CatalogRenderer.js');
  return renderToolCatalog(tools, {
    skillNote: !!(flags && flags.hasSkills),
    mcpStyle: 'grouped',
    usageStyle: 'resolver',
  });
}

module.exports = { resolveToolset };
