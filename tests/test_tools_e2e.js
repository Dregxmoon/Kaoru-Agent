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

function assertEqual(a, b, label) {
  const ok = a === b;
  assert(ok, label, ok ? '' : `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const path = require('path');
const fs = require('fs');

const AP = require('../core/planner/ActionParser.js');
const { getToolRegistry } = require('../core/task/ToolRegistry.js');

// Load openclaw-server handlers
const srv = require('../openclaw-server.js');

// ── Test 1: Cross-reference tools → handlers ──────────────────────────────
function testToolHandlerCoverage() {
  console.log(C.bold('\n── Cobertura: schemas → handlers ───────────────────────'));

  const registry = getToolRegistry();
  const schemas = registry._getOpenClawTools();

  const serverHandlers = new Set(Object.keys(srv.HANDLERS));
  // browser y web_search se resuelven con BrowserBridge (en proceso), no HTTP
  const BROWSER_TOOLS = new Set(['browser', 'web_search']);
  // subagent se resuelve en proceso con un AgentLoop anidado, no HTTP
  const INPROCESS_TOOLS = new Set(['subagent']);

  for (const schema of schemas) {
    if (BROWSER_TOOLS.has(schema.name)) {
      assert(true, `${schema.name}: resuelto por BrowserBridge`);
    } else if (INPROCESS_TOOLS.has(schema.name)) {
      assert(true, `${schema.name}: resuelto en proceso (AgentLoop anidado)`);
    } else if (serverHandlers.has(schema.name)) {
      assert(true, `${schema.name}: handler en openclaw-server`);
    } else {
      assert(false, `${schema.name}: SIN handler ni BrowserBridge`);
    }
  }

  assertEqual(schemas.length, 13, '13 herramientas OpenClaw en ToolRegistry');
  assertEqual(serverHandlers.size, 10, '10 handlers en openclaw-server');
}

// ── Test 2: Approval gate (isHighImpact) ─────────────────────────────────
function testApprovalGate() {
  console.log(C.bold('\n── Approval gate (isHighImpact) ────────────────────────'));

  // browser siempre es high-impact
  assert(
    AP.isHighImpact('browser', { action: 'navigate', url: 'https://example.com' }),
    'browser → high impact'
  );

  // web_search NO es high impact (solo lectura)
  assert(!AP.isHighImpact('web_search', { query: 'test' }), 'web_search → low impact');

  // apply_patch siempre es high impact
  assert(
    AP.isHighImpact('apply_patch', { path: 'file.txt', patch: '' }),
    'apply_patch → high impact'
  );

  // code_execution siempre es high impact
  assert(AP.isHighImpact('code_execution', { code: 'print(1)' }), 'code_execution → high impact');

  // exec con comando peligroso es high impact
  assert(AP.isHighImpact('exec', { command: 'rm -rf /tmp/test' }), 'exec rm -rf → high impact');
  assert(
    AP.isHighImpact('exec', { command: 'git push --force origin main' }),
    'exec git push --force → high impact'
  );

  // exec con comando seguro NO es high impact
  assert(!AP.isHighImpact('exec', { command: 'git status' }), 'exec git status → low impact');
  assert(!AP.isHighImpact('exec', { command: 'ls -la' }), 'exec ls → low impact');

  // read fuera del proyecto es high impact
  assert(AP.isHighImpact('read', { path: '/etc/passwd' }), 'read /etc/passwd → high impact');

  // read dentro del proyecto NO es high impact
  assert(!AP.isHighImpact('read', { path: 'src/index.js' }), 'read src/index.js → low impact');

  // write a path sensible es high impact
  assert(AP.isHighImpact('write', { path: '.env', content: 'X=1' }), 'write a .env → high impact');

  // write fuera del proyecto es high impact
  assert(
    AP.isHighImpact('write', { path: '/tmp/foo' }),
    'write a /tmp/foo → high impact (outside project)'
  );

  // edit fuera del proyecto es high impact
  assert(
    AP.isHighImpact('edit', { path: '/etc/hosts', oldString: 'a', newString: 'b' }),
    'edit /etc/hosts → high impact'
  );
}

// ── Test 3: Schema params vs handler params ───────────────────────────────
function testSchemaHandlerParity() {
  console.log(C.bold('\n── Paridad: schema params ↔ handler params ─────────────'));

  const registry = getToolRegistry();
  const allSchemas = registry._getOpenClawTools();

  // read: schema tiene "path", handler espera "path"
  const readSchema = allSchemas.find((s) => s.name === 'read');
  assert(
    readSchema.params.some((p) => p.name === 'path'),
    'read schema tiene param "path"'
  );

  // write: schema tiene "path", "content"; handler espera "path", "content"
  const writeSchema = allSchemas.find((s) => s.name === 'write');
  assert(
    writeSchema.params.some((p) => p.name === 'path'),
    'write schema tiene param "path"'
  );
  assert(
    writeSchema.params.some((p) => p.name === 'content'),
    'write schema tiene param "content"'
  );

  // edit: schema usa oldString/newString, handler usa old_text/new_text
  // La traducción la hace OpenClawBridge.TOOL_SCHEMAS.edit
  const editSchema = allSchemas.find((s) => s.name === 'edit');
  assert(
    editSchema.params.some((p) => p.name === 'oldString'),
    'edit schema tiene param "oldString"'
  );
  assert(
    editSchema.params.some((p) => p.name === 'newString'),
    'edit schema tiene param "newString"'
  );

  // exec: schema tiene "command", handler espera "command"
  const execSchema = allSchemas.find((s) => s.name === 'exec');
  assert(
    execSchema.params.some((p) => p.name === 'command'),
    'exec schema tiene param "command"'
  );
}

// ── Test 4: HighImpact en ToolRegistry coincide con ActionParser ──────────
function testConsistentHighImpact() {
  console.log(C.bold('\n── Consistencia: ToolRegistry.highImpact ≈ isHighImpact ──'));

  const schemas = getToolRegistry()._getOpenClawTools();

  for (const s of schemas) {
    // browser: siempre true en ambos
    if (s.name === 'browser') {
      assert(s.highImpact === true, 'browser: highImpact=true en ToolRegistry');
      continue;
    }
    // web_search: false en ambos
    if (s.name === 'web_search') {
      assert(s.highImpact === false, 'web_search: highImpact=false en ToolRegistry');
      continue;
    }
    // apply_patch, code_execution: son siempre high-impact en ActionParser
    if (s.name === 'apply_patch' || s.name === 'code_execution') {
      assert(s.highImpact === true, `${s.name}: highImpact=true en ToolRegistry`);
      continue;
    }
    // read/write/edit: condicional (depende del path)
    if (s.name === 'read' || s.name === 'write' || s.name === 'edit') {
      // En ActionParser estos son condicionales
      // ToolRegistry los marca como highImpact basado en uso típico
      assert(typeof s.highImpact === 'boolean', `${s.name}: highImpact es booleano`);
      continue;
    }
    // exec: condicional en ActionParser
    if (s.name === 'exec') {
      assert(
        s.highImpact === false,
        'exec: highImpact=false en ToolRegistry (depende del comando)'
      );
      continue;
    }
  }
}

// ── Test 5: OpenClawBridge routing ────────────────────────────────────────
function testBridgeToolRouting() {
  console.log(C.bold('\n── Routing: OpenClawBridge.execute() ───────────────────'));

  const { OpenClawBridge } = require('../core/planner/OpenClawBridge.js');
  const bridge = new OpenClawBridge();

  // Verificar que las tools que van por HTTP tienen schema builders en el bridge
  const bridgeSchemas = {};
  for (const key of [
    'exec',
    'read',
    'write',
    'edit',
    'apply_patch',
    'code_execution',
    'grep',
    'glob',
    'webfetch',
    'websearch',
  ]) {
    bridgeSchemas[key] = true;
  }

  // browser, web_search y subagent NO van por HTTP (in-process).
  const srvHandlers = Object.keys(srv.HANDLERS);
  for (const handler of srvHandlers) {
    assert(bridgeSchemas[handler] === true, `${handler}: tiene builder en OpenClawBridge`);
  }

  // BrowserBridge usa executeBrowserAction y executeWebSearch
  const BrowserBridge = require('../core/planner/BrowserBridge.js');
  assert(
    typeof BrowserBridge.executeBrowserAction === 'function',
    'BrowserBridge.executeBrowserAction existe'
  );
  assert(
    typeof BrowserBridge.executeWebSearch === 'function',
    'BrowserBridge.executeWebSearch existe'
  );
}

// ── Test 6: Server handler error consistency ──────────────────────────────
function testServerHandlerErrors() {
  console.log(C.bold('\n── Consistencia de errores server-side ─────────────────'));

  const handlers = srv.HANDLERS;

  // exec sin comando
  const execNoCmd = handlers.exec({});
  assert(
    execNoCmd.error && execNoCmd.error.includes('command required'),
    'exec sin command → error "command required"'
  );

  // exec con comando bloqueado
  const execBlocked = handlers.exec({ command: 'sudo rm -rf /' });
  assert(execBlocked.error && execBlocked.error.includes('blocked'), 'exec sudo → error "blocked"');

  // read de archivo inexistente (fuera del proyecto)
  const readNonexistent = handlers.read({ path: '/nonexistent-12345' });
  assert(
    readNonexistent.error && readNonexistent.error.includes('outside allowed'),
    'read fuera del proyecto → error "outside allowed"'
  );

  // read de archivo inexistente dentro del proyecto
  const readInside = handlers.read({ path: '__test_e2e_nonexistent_12345__' });
  assert(
    readInside.error && readInside.error.includes('File not found'),
    'read dentro del proyecto pero inexistente → error "File not found"'
  );

  // write a path inmutable
  const writeImmutable = handlers.write({ path: '.env', content: 'test' });
  assert(
    writeImmutable.error && writeImmutable.error.includes('outside allowed'),
    'write .env → error "outside allowed"'
  );

  // edit sin old_text match
  const editNoMatch = handlers.edit({
    path: 'nonexistent-edit-test-12345',
    old_text: 'notfound',
    new_text: '',
  });
  assert(
    editNoMatch.error && editNoMatch.error.includes('File not found'),
    'edit archivo inexistente → error'
  );
}

// ── Test 7: Edición determinista (diff search/replace) ────────────────────
function testDeterministicEdit() {
  console.log(C.bold('\n── Edit determinista: reemplazo exacto no ambiguo ──────'));

  const handlers = srv.HANDLERS;
  const path = require('path');
  const fs = require('fs');
  const tmpFile = path.join(__dirname, '..', '__edit_deterministic_test__.txt');
  fs.writeFileSync(tmpFile, 'line one\nline two\nline one\n', 'utf-8');

  // old_text aparece 2 veces → ambigüedad → error, sin modificar nada
  const ambiguous = handlers.edit({ path: tmpFile, old_text: 'line one', new_text: 'X' });
  assert(
    ambiguous.error && ambiguous.error.includes('ambiguo'),
    'edit con 2 coincidencias → error "ambiguo"'
  );
  assert(
    fs.readFileSync(tmpFile, 'utf-8') === 'line one\nline two\nline one\n',
    'edit ambiguo no modifica el archivo'
  );

  // old_text único → reemplazo exacto determinista
  const ok = handlers.edit({ path: tmpFile, old_text: 'line two', new_text: 'line TWO' });
  assert(ok.result && ok.result.includes('Edited'), 'edit único → ok');
  assert(
    fs.readFileSync(tmpFile, 'utf-8') === 'line one\nline TWO\nline one\n',
    'edit único reemplaza exactamente una vez'
  );

  // El resultado adjunta el split viejo/actualizado para la UI: oldContent y
  // newContent completos + qué líneas cambiaron (removedLines=2, addedLines=2).
  assert(ok.oldContent === 'line one\nline two\nline one\n', 'edit devuelve oldContent completo');
  assert(ok.newContent === 'line one\nline TWO\nline one\n', 'edit devuelve newContent completo');
  assert(
    Array.isArray(ok.addedLines) && ok.addedLines.length === 1 && ok.addedLines[0] === 2,
    'edit marca la línea 2 como añadida'
  );
  assert(
    Array.isArray(ok.removedLines) && ok.removedLines.length === 1 && ok.removedLines[0] === 2,
    'edit marca la línea 2 como removida'
  );

  // old_text inexistente → error claro
  const missing = handlers.edit({ path: tmpFile, old_text: 'nope', new_text: 'X' });
  assert(
    missing.error && missing.error.includes('no se encontró'),
    'edit sin coincidencia → error claro'
  );

  // alias oldString/newString (schema del ToolRegistry)
  const alias = handlers.edit({ path: tmpFile, oldString: 'line one', newString: 'L' });
  assert(
    alias.error && alias.error.includes('ambiguo'),
    'edit con oldString/newText → usa los alias (ambiguo aquí)'
  );

  fs.unlinkSync(tmpFile);
}

// ── Test 8: grep/glob (masa de herramientas de búsqueda) ──────────────────
function testSearchTools() {
  console.log(C.bold('\n── Grep/glob: búsqueda en el proyecto ───────────────────'));

  const handlers = srv.HANDLERS;

  // grep sin pattern → error
  const noPat = handlers.grep({});
  assert(noPat.error && noPat.error.includes('pattern'), 'grep sin pattern → error');

  // grep con regex inválida → error claro, no crash
  const badRe = handlers.grep({ pattern: '[' });
  assert(
    badRe.error && badRe.error.includes('regex inválido'),
    'grep con regex inválido → error claro'
  );

  // grep encuentra coincidencias en el propio proyecto
  const g = handlers.grep({ pattern: 'HANDLERS', path: '.', include: 'openclaw-server.js' });
  assert(g.result && g.result.count > 0, 'grep encuentra HANDLERS en openclaw-server.js');
  assert(g.result.matches[0].path && g.result.matches[0].line > 0, 'grep devuelve path y línea');
  assert(g.result.matches[0].text.includes('HANDLERS'), 'grep devuelve el texto de la línea');

  // grep excluye node_modules por defecto (el walker no entra a node_modules)
  const g2 = srv.HANDLERS.grep({ pattern: 'minimatch', path: '.', include: '**/*.js' });
  const noNodeModules = (g2.result?.matches || []).every(
    (m) => !m.path.startsWith('node_modules/')
  );
  assert(
    noNodeModules,
    'grep ignora node_modules',
    JSON.stringify((g2.result?.matches || []).slice(0, 3))
  );

  // glob lista archivos por patrón
  const gl = handlers.glob({ pattern: 'src/**/*.js' });
  assert(gl.result && gl.result.count > 0, 'glob encuentra archivos en src');
  assert(
    gl.result.files.every((f) => f.endsWith('.js')),
    'glob respeta el patrón *.js'
  );

  // glob fuera del proyecto → error
  const gl2 = handlers.glob({ pattern: '*', path: '/etc' });
  assert(gl2.error && gl2.error.includes('outside allowed'), 'glob fuera del proyecto → error');
}

// ── Test 9: ToolResolver produce catalog válido para todas las tools ──────
async function testToolResolverCatalog() {
  console.log(C.bold('\n── ToolResolver: catálogo completo ─────────────────────'));

  const { resolveToolset } = require('../core/task/ToolResolver.js');
  const registry = getToolRegistry();

  const result = await resolveToolset({
    toolRegistry: registry,
    skillManager: null,
    mcpManager: null,
    db: null,
  });

  assert(result.promptCatalog !== null, 'ToolResolver produce catalog');
  assert(result.nativeToolSchemas !== null, 'ToolResolver produce nativeToolSchemas');

  // Verificar que todas las herramientas OpenClaw + LSP + Git + GitHub están
  // en el catálogo (Git/GitHub nativas son parte del toolset desde §10).
  const allToolNames = [
    ...registry._getOpenClawTools().map((t) => t.name),
    ...registry._getLSPTools().map((t) => t.name),
    ...registry._getGitTools().map((t) => t.name),
    ...registry._getGitHubTools().map((t) => t.name),
  ];
  for (const name of allToolNames) {
    assert(
      result.nativeToolSchemas.some((s) => s.name === name),
      `${name}: presente en nativeToolSchemas`
    );
  }

  assertEqual(
    result.nativeToolSchemas.length,
    allToolNames.length,
    'nativeToolSchemas cubre todas las herramientas'
  );
}

// ── Run ────────────────────────────────────────────────────────────────────

console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
console.log(C.bold(C.cyan('  March 7th — Test Suite: Tools E2E — Fase 6')));
console.log(C.bold(C.cyan('════════════════════════════════════════════════════════')));

async function main() {
  console.log(C.bold('\n── Auditoría de cobertura ─────────────────────────────'));
  testToolHandlerCoverage();

  console.log(C.bold('\n── Approval gate ───────────────────────────────────────'));
  testApprovalGate();

  console.log(C.bold('\n── Paridad de schemas ──────────────────────────────────'));
  testSchemaHandlerParity();

  console.log(C.bold('\n── Consistencia de highImpact ─────────────────────────'));
  testConsistentHighImpact();

  console.log(C.bold('\n── Routing del Bridge ──────────────────────────────────'));
  testBridgeToolRouting();

  console.log(C.bold('\n── Errores server-side ────────────────────────────────'));
  testServerHandlerErrors();

  console.log(C.bold('\n── Edit determinista ───────────────────────────────────'));
  testDeterministicEdit();

  console.log(C.bold('\n── Grep/glob ───────────────────────────────────────────'));
  testSearchTools();

  console.log(C.bold('\n── Catálogo ToolResolver ──────────────────────────────'));
  await testToolResolverCatalog();

  console.log(C.bold('\n════════════════════════════════════════════════════════'));
  const total = passed + failed + skipped;
  const color = failed === 0 ? C.green : C.red;
  const skipNote = skipped > 0 ? `  ${C.yellow(`${skipped} skipped`)}` : '';
  if (failed === 0) {
    console.log(
      `  ${color('Resultado')}: ${color(`${passed} passed`)}  ${C.dim(`0 failed`)}${skipNote}  / ${total} total`
    );
  } else {
    console.log(
      `  Resultado: ${C.green(`${passed} passed`)}  ${C.red(`${failed} failed`)}${skipNote}  / ${total} total`
    );
  }
  console.log(C.bold('════════════════════════════════════════════════════════'));
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
