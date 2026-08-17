// @ts-check
'use strict';
// Clasificación de aprobación MCP en ActionParser.isHighImpact:
//  - Llamadas de SOLO LECTURA por nombre (lista explícita list_*/read_*/get_*/...)
//    NO piden aprobación, incluso sin paths identificables. Sí piden si algún
//    target sale del workspace, es sensible (.env/.ssh/keys) o matchea
//    HIGH_IMPACT_PATTERNS.
//  - Tools mutadoras/desconocidas: default seguro con targets malos o sin path.
//  - create_file/edit_file (structured write/edit) siguen la política de
//    write/edit: solo piden aprobación si el path sale del workspace o es
//    sensible.

const path = require('path');
const fs = require('fs');
const os = require('os');

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

let passed = 0;
let failed = 0;

function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  ${C.green('✓')} ${label}`);
    passed++;
  } else {
    console.log(`  ${C.red('✗')} ${label}`);
    if (detail) console.log(`    ${C.dim ? C.dim(detail) : detail}`);
    failed++;
  }
}

let projectCwd;

function setup() {
  projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-approval-test-'));
  return projectCwd;
}

function teardown() {
  if (projectCwd) {
    try {
      fs.rmSync(projectCwd, { recursive: true, force: true });
    } catch {}
    projectCwd = null;
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

function testReadOnlyMCPNoApproval() {
  console.log(C.bold('\n── MCP solo-lectura por nombre → NO pide aprobación ─────────────'));

  const AP = require('../core/planner/ActionParser.js');
  AP.setProjectCWD(projectCwd);
  const inside = path.join(projectCwd, 'src');

  // Prefijos list_*/read_*/get_*/search_*/... con target dentro del workspace.
  const readOnlyInside = [
    ['filesystem', 'list_directory', { path: inside }],
    ['filesystem', 'read_file', { path: path.join(inside, 'a.js') }],
    ['filesystem', 'read_multiple_files', { paths: [path.join(inside, 'a.js')] }],
    ['filesystem', 'get_file_info', { path: inside }],
    ['filesystem', 'search_files', { path: inside, pattern: 'x' }],
    ['filesystem', 'fetch_url', { url: 'https://example.com' }],
    ['filesystem', 'list', { path: inside }],
    ['filesystem', 'ls', { path: inside }],
    ['github', 'get_issue', { repo: 'a/b', issue_number: 1 }],
    ['github', 'repo_status', { repo: 'a/b' }],
    ['memory', 'search_memory', { query: 'x' }],
    ['weather', 'get_current', { city: 'CABA' }],
    ['brave', 'web_search', { query: 'x' }],
    ['db', 'query_tables', { connection: 'prod' }],
    ['db', 'table_schema', { table: 'users' }],
    ['cache', 'check_status', {}],
    ['cache', 'server_health', {}],
  ];
  for (const [server, tool, args] of readOnlyInside) {
    assert(
      !AP.isHighImpact('mcp', { server, tool, args }),
      `mcp ${tool} (read-only) NO pide aprobación`,
      JSON.stringify({ server, tool, args })
    );
  }

  // Sin targets en absoluto (params no-path) → también libre.
  assert(
    !AP.isHighImpact('mcp', { server: 'github', tool: 'list_issues', args: {} }),
    'mcp list_issues sin path NO pide aprobación'
  );
  assert(
    !AP.isHighImpact('mcp', { server: 'notes', tool: 'get_note', args: { id: '42' } }),
    'mcp get_note con args no-path NO pide aprobación'
  );
}

function testReadOnlyMCPWithBadTargetApproval() {
  console.log(C.bold('\n── MCP read-only pero con target peligroso → SÍ pide ─────────────'));

  const AP = require('../core/planner/ActionParser.js');
  AP.setProjectCWD(projectCwd);

  assert(
    AP.isHighImpact('mcp', {
      server: 'filesystem',
      tool: 'read_file',
      args: { path: '/tmp/opencode/lejano.txt' },
    }),
    'read_file fuera del workspace pide aprobación'
  );
  assert(
    AP.isHighImpact('mcp', {
      server: 'filesystem',
      tool: 'get_file_info',
      args: { path: path.join(projectCwd, '.env') },
    }),
    'get_file_info de .env pide aprobación'
  );
  assert(
    AP.isHighImpact('mcp', {
      server: 'filesystem',
      tool: 'list_directory',
      args: { path: '/etc' },
    }),
    'list_directory de /etc pide aprobación'
  );
}

function testMutatingMCPDefault() {
  console.log(C.bold('\n── MCP mutadora/desconocida → default seguro ───────────────────'));

  const AP = require('../core/planner/ActionParser.js');
  AP.setProjectCWD(projectCwd);
  const inside = path.join(projectCwd, 'src');

  // Sin path identificable → preguntar.
  assert(
    AP.isHighImpact('mcp', { server: 'github', tool: 'create_issue', args: {} }),
    'create_issue sin path pide aprobación'
  );
  assert(
    AP.isHighImpact('mcp', { server: 'filesystem', tool: 'write_file', args: {} }),
    'write_file sin path pide aprobación'
  );
  assert(
    AP.isHighImpact('mcp', { server: 'git', tool: 'commit_changes', args: {} }),
    'commit_changes sin path pide aprobación'
  );
  assert(
    AP.isHighImpact('mcp', { server: 'x', tool: 'do_something_weird', args: {} }),
    'tool desconocida sin path pide aprobación'
  );

  // Con target dentro del workspace → libre (misma política que write/edit).
  assert(
    !AP.isHighImpact('mcp', {
      server: 'filesystem',
      tool: 'write_file',
      args: { path: path.join(inside, 'a.txt'), content: 'x' },
    }),
    'write_file dentro del workspace NO pide aprobación'
  );
  assert(
    !AP.isHighImpact('mcp', {
      server: 'filesystem',
      tool: 'move_file',
      args: {
        source: path.join(inside, 'a.txt'),
        destination: path.join(inside, 'b.txt'),
      },
    }),
    'move_file dentro del workspace NO pide aprobación'
  );

  // Mutadora con target fuera/sensible → preguntar.
  assert(
    AP.isHighImpact('mcp', {
      server: 'filesystem',
      tool: 'write_file',
      args: { path: '/etc/x.txt', content: 'x' },
    }),
    'write_file en /etc pide aprobación'
  );
}

function testCreateEditFileAligned() {
  console.log(C.bold('\n── create_file/edit_file alineados a write/edit ─────────────────'));

  const AP = require('../core/planner/ActionParser.js');
  AP.setProjectCWD(projectCwd);
  const inside = path.join(projectCwd, 'src');
  fs.mkdirSync(inside, { recursive: true });

  assert(
    !AP.isHighImpact('create_file', { path: path.join(inside, 'nuevo.js'), content: 'x' }),
    'create_file dentro del workspace NO pide aprobación'
  );
  assert(
    !AP.isHighImpact('edit_file', {
      path: path.join(inside, 'a.js'),
      oldString: 'a',
      newString: 'b',
    }),
    'edit_file dentro del workspace NO pide aprobación'
  );
  assert(
    AP.isHighImpact('create_file', { path: '/tmp/x.js', content: 'x' }),
    'create_file fuera del workspace pide aprobación'
  );
  assert(
    AP.isHighImpact('edit_file', { path: '/etc/hosts', oldString: 'a', newString: 'b' }),
    'edit_file en /etc pide aprobación'
  );
  assert(
    AP.isHighImpact('create_file', { path: path.join(inside, '.env'), content: 'x' }),
    'create_file de .env pide aprobación'
  );
}

function testToolRegistryCatalog() {
  console.log(C.bold('\n── Catálogo ToolRegistry: highImpact coherente para MCP ─────────'));

  const { ToolRegistry } = require('../core/task/ToolRegistry.js');
  const registry = new ToolRegistry();
  registry.setMCPManager({
    listAllTools: () => [
      { server: 'filesystem', tool: 'read_file' },
      { server: 'filesystem', tool: 'write_file' },
      { server: 'github', tool: 'list_issues' },
      { server: 'github', tool: 'create_issue' },
    ],
  });

  const catalog = registry.getCatalog();
  const byName = Object.fromEntries(catalog.tools.map((t) => [t.name, t]));
  assert(byName.read_file && byName.read_file.highImpact === false, 'read_file → highImpact false');
  assert(
    byName.write_file && byName.write_file.highImpact === true,
    'write_file → highImpact true'
  );
  assert(
    byName.list_issues && byName.list_issues.highImpact === false,
    'list_issues → highImpact false'
  );
  assert(
    byName.create_issue && byName.create_issue.highImpact === true,
    'create_issue → highImpact true'
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log(C.bold('\n════════════════════════════════════════════════════════'));
console.log(C.bold(C.cyan('  March 7th — Test Suite: Aprobación MCP (read-only por nombre)')));
console.log(C.bold('════════════════════════════════════════════════════════'));

setup();
try {
  testReadOnlyMCPNoApproval();
  testReadOnlyMCPWithBadTargetApproval();
  testMutatingMCPDefault();
  testCreateEditFileAligned();
  testToolRegistryCatalog();
} finally {
  teardown();
}

console.log(C.bold('\n════════════════════════════════════════════════════════'));
const total = passed + failed;
const status =
  failed === 0 ? C.green(`${passed} passed`) : C.red(`${passed} passed, ${failed} failed`);
console.log(
  `  Resultado: ${status}  ${failed === 0 ? C.yellow(`0 failed`) : C.red(`${failed} failed`)}  / ${total} total`
);
console.log('════════════════════════════════════════════════════════');
process.exit(failed > 0 ? 1 : 0);
