'use strict';

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

let passed = 0;
let failed = 0;
let skipped = 0;

function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  ${C.green('✓')} ${label}`);
    passed++;
  } else {
    console.log(`  ${C.red('✗')} ${label}`);
    if (detail) console.log(`    ${C.dim(detail)}`);
    failed++;
  }
}

const path = require('path');
const fs = require('fs');
const os = require('os');

function makeTool(name, domain, source = 'openclaw') {
  return {
    name,
    domain: Array.isArray(domain) ? domain : [domain],
    source,
    description: `${name} tool`,
    params: [],
  };
}

function makeMCPServer(name, tools) {
  return {
    listAllTools: () =>
      tools.map((t) => ({
        server: name,
        tool: t.name,
        description: t.description || '',
        inputSchema: { type: 'object', properties: {}, required: [] },
      })),
  };
}

function makeRegistry(openclawTools) {
  return {
    _getOpenClawTools: () => openclawTools,
    serializeToPrompt: () => null,
    getCatalog: () => ({ tools: openclawTools }),
  };
}

const { resolveToolset } = require('../core/task/ToolResolver.js');

// ── Test 1: Sin skill ni MCP → fallback a OpenClaw genérico ─────────
async function testFallbackOpenClaw() {
  const registry = makeRegistry([
    makeTool('exec', ['shell', 'git']),
    makeTool('read', ['filesystem']),
    makeTool('write', ['filesystem']),
  ]);

  const result = await resolveToolset({ toolRegistry: registry });
  assert(result.precedence === 'openclaw', 'Precedencia es openclaw sin skills ni MCP');
  assert(result.nativeToolSchemas !== null, 'nativeToolSchemas no es null');
  assert(result.nativeToolSchemas.length > 0, 'Hay schemas nativos');
  assert(result.promptCatalog !== null, 'promptCatalog no es null');
  assert(result.promptCatalog.includes('exec'), 'Catalog incluye exec');
  assert(result.promptCatalog.includes('read'), 'Catalog incluye read');
  assert(result.excluded.length === 0, 'Ninguna herramienta excluida');
}

// ── Test 2: Skill excluye herramientas genéricas por dominio ──────────
async function testSkillExcludesGeneric() {
  const registry = makeRegistry([
    makeTool('exec', ['shell', 'git', 'code']),
    makeTool('read', ['filesystem', 'code']),
    makeTool('write', ['filesystem', 'code']),
    makeTool('browser', ['web']),
  ]);

  const skillMatches = [
    {
      name: 'doc-skill',
      description: 'Word document editing',
      domains: ['filesystem'],
      replaces_domains: ['filesystem'],
      content: '# Doc skill\nInstructions for editing documents.',
      distance: 0.2,
      score: 0.8,
    },
  ];

  const result = await resolveToolset({
    toolRegistry: registry,
    matchedSkills: skillMatches,
  });

  assert(result.precedence === 'skill', 'Precedencia es skill');
  assert(result.matchedSkills.length === 1, '1 skill matcheada');
  assert(result.excluded.length >= 1, 'Al menos 1 herramienta excluida');

  const excludedNames = result.excluded.map((e) => e.tool);
  assert(excludedNames.includes('read'), 'read excluida (dominio filesystem)');
  assert(excludedNames.includes('write'), 'write excluida (dominio filesystem)');
  assert(!excludedNames.includes('browser'), 'browser NO excluida (dominio web no overlap)');

  const nativeNames = result.nativeToolSchemas.map((s) => s.name);
  assert(!nativeNames.includes('read'), 'read no está en schemas nativos');
  assert(!nativeNames.includes('write'), 'write no está en schemas nativos');
  assert(nativeNames.includes('browser'), 'browser sí está en schemas nativos');
}

// ── Test 3: Skill con replaces_domains específico ─────────────────────
async function testSkillReplacesSpecificDomain() {
  const registry = makeRegistry([
    makeTool('exec', ['shell', 'git']),
    makeTool('read', ['filesystem']),
    makeTool('write', ['filesystem']),
  ]);

  const skillMatches = [
    {
      name: 'git-skill',
      description: 'Advanced git operations',
      domains: ['git'],
      replaces_domains: ['git'],
      content: '# Git skill\nGit conventions.',
      distance: 0.15,
      score: 0.85,
    },
  ];

  const result = await resolveToolset({
    toolRegistry: registry,
    matchedSkills: skillMatches,
  });

  const excludedNames = result.excluded.map((e) => e.tool);
  assert(excludedNames.includes('exec'), 'exec excluida (dominio git)');
  assert(!excludedNames.includes('read'), 'read NO excluida (no overlap con git)');
  assert(!excludedNames.includes('write'), 'write NO excluida (no overlap con git)');
}

// ── Test 4: MCP reemplaza OpenClaw en dominios overlap ────────────────
async function testMCPReplacesOpenClaw() {
  const registry = makeRegistry([
    makeTool('exec', ['shell', 'system']),
    makeTool('read', ['filesystem']),
    makeTool('write', ['filesystem']),
  ]);

  const mcpManager = makeMCPServer('filesystem', [
    { name: 'read_file', description: 'Read file from disk' },
    { name: 'write_file', description: 'Write file to disk' },
  ]);

  const result = await resolveToolset({
    toolRegistry: registry,
    mcpManager,
  });

  assert(result.precedence === 'mcp', 'Precedencia es mcp');
  const excludedNames = result.excluded.map((e) => e.tool);
  assert(excludedNames.includes('read'), 'read excluida por MCP filesystem');
  assert(excludedNames.includes('write'), 'write excluida por MCP filesystem');
  assert(!excludedNames.includes('exec'), 'exec NO excluida (shell no overlap con filesystem)');

  assert(result.promptCatalog.includes('MCP'), 'Catalog menciona MCP');
  assert(result.promptCatalog.includes('filesystem'), 'Catalog menciona servidor filesystem');
}

// ── Test 5: Skill gana sobre MCP cuando ambas cubren mismo dominio ────
async function testSkillBeatsMCP() {
  const registry = makeRegistry([
    makeTool('read', ['filesystem']),
    makeTool('write', ['filesystem']),
  ]);

  const mcpManager = makeMCPServer('filesystem', [
    { name: 'read_file', description: 'Read' },
    { name: 'write_file', description: 'Write' },
  ]);

  const skillMatches = [
    {
      name: 'doc-skill',
      description: 'Document editing',
      domains: ['filesystem'],
      replaces_domains: ['filesystem'],
      content: '# Doc skill',
      distance: 0.2,
      score: 0.8,
    },
  ];

  const result = await resolveToolset({
    toolRegistry: registry,
    mcpManager,
    matchedSkills: skillMatches,
  });

  assert(result.precedence === 'skill', 'Precedencia es skill (no mcp)');
}

// ── Test 6: MCP sin overlap con OpenClaw → ambos coexisten ────────────
async function testMCPNoOverlap() {
  const registry = makeRegistry([makeTool('exec', ['shell']), makeTool('web_search', ['web'])]);

  const mcpManager = makeMCPServer('memory', [
    { name: 'store_memory', description: 'Store' },
    { name: 'recall_memory', description: 'Recall' },
  ]);

  const result = await resolveToolset({
    toolRegistry: registry,
    mcpManager,
  });

  assert(result.excluded.length === 0, '0 herramientas excluidas (sin overlap)');
  assert(result.precedence === 'mcp', 'Precedencia es mcp (existe MCP)');
}

// ── Test 7: promptCatalog varía según contexto ────────────────────────
async function testPromptCatalogContent() {
  const registry = makeRegistry([makeTool('exec', ['shell'])]);

  // Sin skills ni MCP
  const plain = await resolveToolset({ toolRegistry: registry });
  assert(plain.promptCatalog.includes('Herramientas del sistema'), 'Catalog base: sistema');
  assert(!plain.promptCatalog.includes('MCP'), 'Catalog base: sin MCP');

  // Con MCP
  const mcpManager = makeMCPServer('filesystem', [{ name: 'read', description: 'Read' }]);
  const withMCP = await resolveToolset({ toolRegistry: registry, mcpManager });
  assert(withMCP.promptCatalog.includes('MCP'), 'Catalog con MCP: menciona MCP');
  assert(withMCP.promptCatalog.includes('filesystem'), 'Catalog con MCP: menciona servidor');
}

// ── Test 8: Sin matchedSkills y sin DB no explota ─────────────────────
async function testNoDB() {
  const registry = makeRegistry([makeTool('exec', ['shell'])]);
  const result = await resolveToolset({
    toolRegistry: registry,
    skillManager: {
      match: async () => {
        throw new Error('no db');
      },
    },
    db: null,
  });
  assert(result.precedence === 'openclaw', 'Sin DB ni skills: precedencia openclaw');
  assert(result.matchedSkills.length === 0, '0 skills matcheadas');
  assert(result.nativeToolSchemas !== null, 'nativeToolSchemas disponible');
}

// ── Test 9: replaces_domains null → no excluye nada ──────────────────
async function testReplacesDomainsNull() {
  // If a skill has replaces_domains=null, it falls back to its `domains`
  const registry = makeRegistry([makeTool('exec', ['code']), makeTool('read', ['code'])]);

  // Skill with replaces_domains=null (not set) — no tools should be replaced
  const skillMatches = [
    {
      name: 'code-skill',
      description: 'Code patterns',
      domains: ['code'],
      replaces_domains: null,
      content: '# Code skill',
      distance: 0.2,
      score: 0.8,
    },
  ];

  const result = await resolveToolset({
    toolRegistry: registry,
    matchedSkills: skillMatches,
  });

  assert(
    result.excluded.length === 0,
    '0 herramientas excluidas (replaces_domains no está definido)'
  );
}

// ── Test 10: Múltiples skills matcheadas ──────────────────────────────
async function testMultipleSkills() {
  const registry = makeRegistry([
    makeTool('exec', ['shell', 'git']),
    makeTool('read', ['filesystem']),
    makeTool('write', ['filesystem']),
    makeTool('browser', ['web']),
    makeTool('web_search', ['web']),
  ]);

  const skillMatches = [
    {
      name: 'git-skill',
      description: 'Git workflow',
      domains: ['git'],
      replaces_domains: ['git'],
      content: '# Git',
      distance: 0.2,
      score: 0.8,
    },
    {
      name: 'web-skill',
      description: 'Web scraping',
      domains: ['web'],
      replaces_domains: ['web'],
      content: '# Web',
      distance: 0.3,
      score: 0.7,
    },
  ];

  const result = await resolveToolset({
    toolRegistry: registry,
    matchedSkills: skillMatches,
  });

  const excludedNames = result.excluded.map((e) => e.tool);
  assert(excludedNames.includes('exec'), 'exec excluida (git)');
  assert(excludedNames.includes('browser'), 'browser excluida (web)');
  assert(excludedNames.includes('web_search'), 'web_search excluida (web)');
  assert(!excludedNames.includes('read'), 'read NO excluida (filesystem no overlap)');
}

// ── Test 11: AgentLoop con ToolResolver integrado ─────────────────────
async function testAgentLoopIntegration() {
  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const mockLLM = async () => 'Respuesta sin tools.';

  const registry = makeRegistry([makeTool('exec', ['shell']), makeTool('read', ['filesystem'])]);

  const loop = new AgentLoop({ maxIterations: 1 });

  const result = await loop.run('test', 'System prompt', [], {
    llm: mockLLM,
    toolResolver: {
      resolveToolset: async () => ({
        precedence: 'openclaw',
        promptCatalog: 'Catalog test',
        nativeToolSchemas: null,
        excluded: [],
        matchedSkills: [],
      }),
    },
  });

  assert(result.response.includes('Respuesta'), 'AgentLoop con ToolResolver funciona');
  assert(!result.error, 'Sin error');
  assert(result.iterations === 1, '1 iteración');
}

// ── Run ─────────────────────────────────────────────────────────────────
console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
console.log(C.bold(C.cyan('  March 7th — Test Suite: Tool Precedence — Fase 5')));
console.log(C.bold(C.cyan('════════════════════════════════════════════════════════')));

async function main() {
  console.log(C.bold('\n── Precedencia básica ─────────────────────────────────'));
  await testFallbackOpenClaw();
  await testSkillExcludesGeneric();

  console.log(C.bold('\n── Reemplazo por dominio ────────────────────────────'));
  await testSkillReplacesSpecificDomain();
  await testReplacesDomainsNull();

  console.log(C.bold('\n── MCP ──────────────────────────────────────────────'));
  await testMCPReplacesOpenClaw();
  await testMCPNoOverlap();

  console.log(C.bold('\n── Skills + MCP combinados ──────────────────────────'));
  await testSkillBeatsMCP();
  await testMultipleSkills();

  console.log(C.bold('\n── Prompt catalog ───────────────────────────────────'));
  await testPromptCatalogContent();

  console.log(C.bold('\n── Casos borde ──────────────────────────────────────'));
  await testNoDB();
  await testAgentLoopIntegration();

  const total = passed + failed;
  console.log(C.bold('\n════════════════════════════════════════════════════════'));
  console.log(
    C.bold(
      `  Resultado: ${C.green(passed + ' passed')}  ${failed > 0 ? C.red(failed + ' failed') : C.dim('0 failed')}  ${skipped > 0 ? C.yellow(skipped + ' skipped') : ''}  / ${total + skipped} total`
    )
  );
  console.log(C.bold('════════════════════════════════════════════════════════\n'));
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(C.red('\nERROR FATAL:'), e.message);
  console.error(e.stack);
  process.exit(1);
});

module.exports = { passed, failed, skipped };
