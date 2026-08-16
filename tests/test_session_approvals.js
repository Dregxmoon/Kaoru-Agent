'use strict';

// SessionApprovals — allowlist "Siempre" de sesión (estilo opencode
// once/always/reject). El botón "Siempre" del card de aprobación registra un
// patrón; mientras la sesión viva, los actions que lo matcheen se auto-aprueban
// sin volver a mostrar el card.

const {
  approvalPattern,
  isApproved,
  addApproval,
  resetApprovals,
} = require('../core/security/SessionApprovals.js');

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

function testApprovalPatterns() {
  console.log(C.bold('\n── approvalPattern: mcp / exec / path / resto ─────────────────'));

  assert(
    approvalPattern({
      tool: 'mcp',
      params: { server: 'filesystem', tool: 'write_file', args: { path: 'x' } },
    }) === 'mcp:filesystem:write_file',
    'mcp → "mcp:<server>:<tool>"',
    approvalPattern({ tool: 'mcp', params: { server: 'filesystem', tool: 'write_file' } }) || ''
  );
  assert(
    approvalPattern({ tool: 'exec', params: { command: 'git status --short' } }) ===
      'exec:git status',
    'exec → prefijo de 2 tokens',
    approvalPattern({ tool: 'exec', params: { command: 'git status --short' } }) || ''
  );
  assert(
    approvalPattern({ tool: 'read', params: { path: '/a/b/c.txt' } }) === 'path:/a/b',
    'tool con path → "path:<directorio>"',
    approvalPattern({ tool: 'read', params: { path: '/a/b/c.txt' } }) || ''
  );
  assert(
    approvalPattern({ tool: 'edit', params: { filePath: 'rel/archivo.js' } }) === 'path:rel',
    'filePath también se reconoce',
    approvalPattern({ tool: 'edit', params: { filePath: 'rel/archivo.js' } }) || ''
  );
  assert(
    approvalPattern({ tool: 'browser', params: { action: 'navigate' } }) === 'tool:browser',
    'sin path → "tool:<tool>"',
    approvalPattern({ tool: 'browser', params: {} }) || ''
  );
  assert(approvalPattern(null) === null, 'action null → null');
}

function testSessionAlways() {
  console.log(C.bold('\n── "Siempre": auto-aprobación de sesión + reset ───────────────'));

  resetApprovals();
  const p = 'mcp:filesystem:write_file';
  assert(!isApproved(p), 'sin registrar, no está aprobado');
  addApproval(p);
  assert(isApproved(p), 'tras "Siempre" queda aprobado');
  assert(isApproved('mcp:filesystem:read_file') === false, 'otro patrón NO se aprueba');

  // Un action posterior que matchee el patrón se considera aprobado sin card.
  const later = {
    tool: 'mcp',
    params: { server: 'filesystem', tool: 'write_file', args: { path: '/otro/x.txt' } },
  };
  assert(isApproved(approvalPattern(later)), 'action posterior con mismo patrón → auto-aprobado');

  resetApprovals();
  assert(!isApproved(p), 'reset limpia la sesión');
}

function main() {
  console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
  console.log(C.bold(C.cyan('  SessionApprovals — Test Suite')));
  console.log(C.bold(C.cyan('════════════════════════════════════════════════════════')));
  testApprovalPatterns();
  testSessionAlways();

  console.log(C.bold('\n════════════════════════════════════════════════════════'));
  const total = passed + failed;
  console.log(
    C.bold(
      `  Resultado: ${C.green(passed + ' passed')}  ${failed > 0 ? C.red(failed + ' failed') : C.dim('0 failed')}  / ${total} total`
    )
  );
  console.log(C.bold('════════════════════════════════════════════════════════\n'));

  if (failed > 0) process.exit(1);
}

main();
