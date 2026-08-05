'use strict';

/**
 * Test e2e: AgentLoop response basada en resultados reales.
 *
 * Verifica que cuando AgentLoop ejecuta herramientas y genera la respuesta
 * final, esa respuesta refleja el stdout REAL de la herramienta — no texto
 * inventado antes de ejecutar.
 */

const C = {
  green:  (s) => `\x1b[32m${s}\x1b[0m`,
  red:    (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan:   (s) => `\x1b[36m${s}\x1b[0m`,
  bold:   (s) => `\x1b[1m${s}\x1b[0m`,
  dim:    (s) => `\x1b[2m${s}\x1b[0m`,
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

function extractFilenameTokens(text) {
  if (!text) return new Set();
  const tokens = new Set();
  const fileRe = /[a-zA-Z0-9_\-~][a-zA-Z0-9_\-.]*\.[a-zA-Z0-9]{1,10}/g;
  let match;
  while ((match = fileRe.exec(text)) !== null) {
    const t = match[0];
    if (t.length > 3 && t.length < 80 && !/^\d+\.\d+/.test(t)) {
      tokens.add(t);
    }
  }
  const pathRe = /(?:^|\s)((?:\.{0,2}\/)?[a-zA-Z0-9_\-./]+[a-zA-Z0-9_-])(?:\s|$)/g;
  while ((match = pathRe.exec(text)) !== null) {
    const t = match[1].trim();
    if (t.includes('/') && t.length > 2) {
      tokens.add(t);
    }
  }
  return tokens;
}

// ── Mocks ─────────────────────────────────────────────────────────────────

const mockBridge = {
  execute: async (tool, params) => {
    if (tool === 'exec' && params.command === 'ls') {
      return {
        ok: true,
        result: { stdout: 'src\npackage.json\nREADME.md\nnode_modules\n.eslintrc.js', stderr: '', exitCode: 0 },
        tool,
        elapsed: 5,
      };
    }
    if (tool === 'exec' && params.command && params.command.startsWith('git status')) {
      return {
        ok: true,
        result: { stdout: 'On branch main\nChanges not staged for commit:\n  modified: src/index.js\n  modified: package.json\n\nUntracked files:\n  new-file.ts\n  todo.md\n  config.yaml', stderr: '', exitCode: 0 },
        tool,
        elapsed: 5,
      };
    }
    return { ok: false, error: `tool not mocked: ${tool}`, tool, elapsed: 0 };
  },
  isAvailable: async () => true,
  resetAvailabilityCache: () => {},
  getStats: () => ({ total: 0, ok: 0, failed: 0, tools: [], available: true }),
};

const mockToolSchemas = [
  {
    type: 'function',
    function: {
      name: 'exec',
      description: 'Ejecuta un comando',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
        },
        required: ['command'],
      },
    },
  },
];

const LLMProvider = require('../../core/llm/LLMProvider.js');
const { AgentLoop } = require('../../core/planner/AgentLoop.js');

let callHistory = [];

function setupMock(realStdout, realFilenames) {
  callHistory = [];
  let callCount = 0;
  const orig = LLMProvider.completeWithTools;
  LLMProvider.completeWithTools = async (messages, systemPrompt, tools, mode) => {
    callCount++;
    callHistory.push({ messages, callCount });
    if (callCount === 1) {
      return {
        content: 'Ejecutando...',
        toolCalls: [
          realStdout.includes('git status')
            ? { tool: 'exec', params: { command: 'git status' } }
            : { tool: 'exec', params: { command: 'ls' } },
        ],
      };
    }
    return {
      content: `Aquí tienes el resultado. Los archivos en el directorio son: ${Array.from(realFilenames).join(', ')}.`,
      toolCalls: null,
    };
  };
  return () => { LLMProvider.completeWithTools = orig; };
}

// ── Tests ─────────────────────────────────────────────────────────────────

async function testResponseContainsRealFilenames() {
  console.log(C.bold('\n── Respuesta final contiene nombres de archivo reales ─────'));

  const realStdout = 'src\npackage.json\nREADME.md\nnode_modules\n.eslintrc.js';
  const realFilenames = new Set(['src', 'package.json', 'README.md', 'node_modules', '.eslintrc.js']);

  const restore = setupMock(realStdout, realFilenames);

  const loop = new AgentLoop({
    bridge: mockBridge,
    mode: 'fast',
    maxIterations: 5,
  });

  const result = await loop.run(
    'ejecuta un ls',
    'Eres un asistente útil.',
    [],
    { tools: mockToolSchemas }
  );

  assert(!!result.response, 'Hay una respuesta');
  assert(result.toolResults.length > 0, 'Se ejecutó al menos una herramienta');

  const hasSomeReal = Array.from(realFilenames).some(f => result.response.includes(f));
  assert(hasSomeReal, 'La respuesta menciona al menos un archivo real del stdout');

  const responseTokens = extractFilenameTokens(result.response);
  const invented = Array.from(responseTokens).filter(t => !realFilenames.has(t));

  assert(invented.length <= 1, `No debe inventar archivos. Inventados: ${invented.join(', ') || 'ninguno'}`,
    `Tokens en respuesta: ${Array.from(responseTokens).join(', ')}. Reales: ${Array.from(realFilenames).join(', ')}`);

  restore();
}

async function testGitStatusReflectsRealCount() {
  console.log(C.bold('\n── git status: el número de archivos coincide con el real ─'));

  const realStdout = 'On branch main\nChanges not staged for commit:\n  modified: src/index.js\n  modified: package.json\n\nUntracked files:\n  new-file.ts\n  todo.md\n  config.yaml';
  const realFilenames = new Set(['src/index.js', 'package.json', 'new-file.ts', 'todo.md', 'config.yaml']);

  const restore = setupMock(realStdout, realFilenames);

  const loop = new AgentLoop({
    bridge: mockBridge,
    mode: 'fast',
    maxIterations: 5,
  });

  const result = await loop.run(
    'ejecuta un git status',
    'Eres un asistente útil.',
    [],
    { tools: mockToolSchemas }
  );

  assert(!!result.response, 'Hay una respuesta');

  const wrongCounts = ['6 archivos', '7 archivos', '8 archivos', '6 archivos sin seguimiento', '7 archivos sin seguimiento'];
  for (const wrong of wrongCounts) {
    assert(!result.response.includes(wrong),
      `La respuesta no debe mencionar "${wrong}" (real: 3 untracked + 2 modified)`);
  }

  const hasSomeReal = Array.from(realFilenames).some(f => result.response.includes(f));
  assert(hasSomeReal, 'La respuesta menciona al menos un archivo real del git status');

  restore();
}

async function testToolResultIsInHistoryBeforeFinalResponse() {
  console.log(C.bold('\n── El resultado real está en el historial antes del texto final'));

  const realStdout = 'src\npackage.json\nREADME.md';
  const realFilenames = new Set(['src', 'package.json', 'README.md']);

  const restore = setupMock(realStdout, realFilenames);

  const loop = new AgentLoop({
    bridge: mockBridge,
    mode: 'fast',
    maxIterations: 5,
  });

  await loop.run(
    'ejecuta un ls',
    'Eres un asistente.',
    [],
    { tools: mockToolSchemas }
  );

  const secondCall = callHistory.find(c => c.callCount === 2);
  assert(!!secondCall, 'Hubo una segunda llamada al LLM');

  if (secondCall) {
    const hasToolResult = secondCall.messages.some(m =>
      m.role === 'user' &&
      m.content.includes('package.json') &&
      m.content.includes('README.md')
    );
    assert(hasToolResult, 'El historial de la segunda llamada contiene el stdout real');
  }

  restore();
}

// ── Run ─────────────────────────────────────────────────────────────────────

console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
console.log(C.bold(C.cyan('  E2E: AgentLoop Response Integrity — Fase 2')));
console.log(C.bold(C.cyan('════════════════════════════════════════════════════════')));

(async () => {
  await testResponseContainsRealFilenames();
  await testGitStatusReflectsRealCount();
  await testToolResultIsInHistoryBeforeFinalResponse();

  console.log(C.bold('\n════════════════════════════════════════════════════════'));
  const total = passed + failed + skipped;
  const color = failed === 0 ? C.green : C.red;
  const skipNote = skipped > 0 ? `  ${C.yellow(`${skipped} skipped`)}` : '';
  if (failed === 0) {
    console.log(`  ${color('Resultado')}: ${color(`${passed} passed`)}  ${C.dim(`0 failed`)}${skipNote}  / ${total} total`);
  } else {
    console.log(`  Resultado: ${C.green(`${passed} passed`)}  ${C.red(`${failed} failed`)}${skipNote}  / ${total} total`);
  }
  console.log(C.bold('════════════════════════════════════════════════════════'));

  if (failed > 0) process.exit(1);
})();
