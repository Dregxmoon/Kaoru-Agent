'use strict';

// CatalogRenderer: UN solo renderizador para ToolRegistry.serializeToPrompt y
// ToolResolver._buildPromptCatalog. Fija marcadores estables y que ambas vías
// cubren todas las fuentes sin duplicar lógica de formato.

const { renderToolCatalog } = require('../core/task/CatalogRenderer.js');
const { ToolRegistry } = require('../core/task/ToolRegistry.js');
const { resolveToolset } = require('../core/task/ToolResolver.js');

let passed = 0;
let failed = 0;

function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
    passed++;
  } else {
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

function sampleTools() {
  return [
    { name: 'exec', description: 'Comandos', source: 'openclaw' },
    { name: 'launch_app', description: 'Apps', source: 'desktop' },
    { name: 'read', description: 'Leer', source: 'openclaw' },
    { name: 'git_status', description: 'Estado', source: 'git', highImpact: false },
    { name: 'git_push', description: 'Subir', source: 'git', highImpact: true },
    { name: 'write_file', description: 'Escribir', source: 'mcp', server: 'filesystem' },
  ];
}

async function main() {
  console.log('\n── Render compartido: marcadores estables ──');
  const grouped = renderToolCatalog(sampleTools(), { mcpStyle: 'grouped', usageStyle: 'resolver' });
  assert(grouped.includes('# HERRAMIENTAS DISPONIBLES'), 'marcador raíz');
  assert(grouped.includes('## Herramientas MCP'), 'sección MCP');
  assert(grouped.includes('Servidor: filesystem'), 'MCP agrupado por servidor');
  assert(grouped.includes('MCP_TOOL:'), 'bloque de formato MCP');
  assert(grouped.includes('(requiere aprobación)'), 'marca highImpact en git');

  const flat = renderToolCatalog(sampleTools(), {
    mcpStyle: 'flat-capped',
    maxTools: 30,
    usageStyle: 'legacy',
    rulesSection: true,
  });
  assert(flat.includes('[filesystem] write_file'), 'MCP plano con servidor');
  assert(flat.includes('### Reglas importantes'), 'sección de reglas legacy');
  assert(flat.includes('NUNCA inventes resultados'), 'regla anti-fabricación');

  const capped = renderToolCatalog(sampleTools(), { mcpStyle: 'flat-capped', maxTools: 1 });
  assert(capped.includes('herramientas más'), 'overflow MCP truncado con aviso');

  console.log('\n── Guía de git única (normalizada) ──');
  const registry = new ToolRegistry();
  registry.setOpenClawBridge({ getStats: () => ({ available: true }) });
  const text = registry.serializeToPrompt(null);
  const resolverOut = await resolveToolset({ toolRegistry: registry });
  const gitGuide = 'PREFIERE estas herramientas nativas a exec';
  assert(text.includes(gitGuide), 'registry incluye guía git');
  assert(resolverOut.promptCatalog.includes(gitGuide), 'resolver incluye guía git');
  const guideLines = (s) =>
    s
      .split('\n')
      .filter((l) => l.startsWith('git (son más confiables'))
      .join(' ');
  assert(
    guideLines(text) === guideLines(resolverOut.promptCatalog),
    'misma guía en ambas vías (sin divergencia silenciosa)'
  );

  console.log('\n── Registry delega (secciones propias intactas) ──');
  registry.registerPluginTool({
    id: 'plugin.demo.hola',
    name: 'hola',
    domain: ['demo'],
    description: 'Saluda',
    params: [],
    highImpact: false,
  });
  const withPlugin = registry.serializeToPrompt(null);
  assert(withPlugin.includes('## Herramientas de plugins'), 'sección plugins vía registry');
  assert(
    withPlugin.includes('Puedes usar estas herramientas') === false,
    'sin dominio no hay línea de dominio'
  );
  const withDomain = registry.serializeToPrompt({ id: 'desktop', label: 'Cositas' });
  assert(withDomain && withDomain.includes('Cositas'), 'línea de dominio con domain');

  console.log(`\nResultado: ${passed} passed  ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
