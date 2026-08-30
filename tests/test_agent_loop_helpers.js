// @ts-nocheck
'use strict';

/**
 * tests/test_agent_loop_helpers.js
 * Unit tests for AgentLoop._makeAbortResponse() and _formatActionsSummary().
 *
 * Ejecutar con: ELECTRON_RUN_AS_NODE=1 node tests/test_agent_loop_helpers.js
 */

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failed++;
    console.error(`  \x1b[31m✗\x1b[0m ${label}`);
  }
}

// ── _makeAbortResponse ──────────────────────────────────────────────────────

console.log('\n\x1b[36m─ _makeAbortResponse ──────────────────────────────────\x1b[0m');

// Creamos un mock mínimo de AgentLoop para invocar el método
const { AgentLoop } = require('../core/planner/AgentLoop.js');
const loop = new AgentLoop({ runId: 'test', projectRoot: '/tmp' });

{
  const res = loop._makeAbortResponse(5, [{ tool: 'edit', ok: true }]);
  assert(res.response === 'Generación cancelada por el usuario.', 'response text');
  assert(res.iterations === 5, 'iterations preserved');
  assert(res.toolResults.length === 1, 'toolResults preserved');
  assert(res.cancelled === true, 'cancelled flag');
  assert(res.error === 'cancelled', 'error code');
}

{
  const res = loop._makeAbortResponse(0, []);
  assert(res.iterations === 0, 'zero iterations');
  assert(res.toolResults.length === 0, 'empty toolResults');
}

// ── _formatActionsSummary ───────────────────────────────────────────────────

console.log('\n\x1b[36m─ _formatActionsSummary ─────────────────────────────────\x1b[0m');

{
  const result = loop._formatActionsSummary([]);
  assert(result === '  (ninguna acción ejecutada)', 'empty → default msg');
}

{
  const result = loop._formatActionsSummary(null);
  assert(result === '  (ninguna acción ejecutada)', 'null → default msg');
}

{
  const result = loop._formatActionsSummary(undefined);
  assert(result === '  (ninguna acción ejecutada)', 'undefined → default msg');
}

{
  const tools = [
    { tool: 'edit', ok: true, _action: { params: { filePath: '/tmp/test.js' } } },
    { tool: 'read', ok: false, error: 'file not found', _action: { params: {} } },
  ];
  const result = loop._formatActionsSummary(tools);
  assert(result.includes('edit'), 'contains first tool name');
  assert(result.includes('read'), 'contains second tool name');
  assert(result.includes('OK'), 'contains OK for success');
  assert(result.includes('FALLÓ'), 'contains FALLÓ for failure');
  assert(result.includes('file not found'), 'contains error message');
}

{
  const tools = [
    {
      tool: 'edit',
      ok: true,
      _action: {
        params: {
          filePath:
            '/tmp/very-long-path-that-should-be-truncated-because-it-is-really-really-long.js',
        },
      },
    },
  ];
  const result = loop._formatActionsSummary(tools);
  assert(
    !result.includes('very-long-path-that-should-be-truncated-because-it-is-really-really-long.js'),
    'params truncated at 60 chars'
  );
}

{
  const tools = [
    { tool: 'edit', ok: true, _action: { params: { filePath: '/tmp/a.js' } } },
    { tool: 'read', ok: true, _action: { params: {} } },
  ];
  const result = loop._formatActionsSummary(tools, { join: ' | ' });
  assert(result.includes(' | '), 'custom join separator');
}

{
  const tools = [{ tool: 'edit', ok: true, _action: { params: {} } }];
  const result = loop._formatActionsSummary(tools, { empty: 'nada' });
  assert(!result.includes('ninguna acción'), 'empty not used when tools exist');
}

{
  const tools = [{ tool: 'edit', ok: true, _action: { params: { key: 'value' } } }];
  const result = loop._formatActionsSummary(tools, {
    format: (t, params, ok) => `[${t.tool}] ${ok}`,
  });
  assert(result === '[edit] OK', 'custom format function');
}

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n\x1b[36m══════════════════════════════════════════════════════════\x1b[0m`);
console.log(
  `  AgentLoop helpers: \x1b[32m${passed} passed\x1b[0m  \x1b[31m${failed} failed\x1b[0m  / ${passed + failed} total`
);
console.log(`\x1b[36m══════════════════════════════════════════════════════════\x1b[0m\n`);
process.exit(failed > 0 ? 1 : 0);
