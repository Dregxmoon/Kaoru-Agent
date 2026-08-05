'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

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

// ── Mocks ─────────────────────────────────────────────────────────────────────

// Bridge que registra qué tools recibe — permite comprobar que las LSP
// NO caen al puente OpenClaw.
function createTrackingBridge() {
  const calls = [];
  return {
    calls,
    execute: async (tool, params) => {
      calls.push(tool);
      return { ok: true, result: `[bridge] ${tool}`, error: null, tool, elapsed: 0 };
    },
  };
}

// LSP manager fake: supportsFile por extensión, igual que el real.
function createMockLSP(overrides = {}) {
  const changeCalls = [];
  return {
    isRunning: true,
    activeLanguages: ['javascript'],
    supportsFile: (filePath) => path.extname(String(filePath)) === '.js',
    getDiagnostics: async (filePath) => [
      { severity: 1, message: 'Error sintáctico', range: { start: { line: 1, character: 0 } } },
    ],
    getDocumentSymbols: async (filePath) => [{ name: 'main', kind: 5 }],
    goToDefinition: async (filePath, line, character) => null,
    findReferences: async (filePath, line, character) => [],
    hover: async (filePath, line, character) => ({
      contents: 'const x: number',
      language: 'typescript',
      range: null,
    }),
    rename: async (filePath, line, character, newName) => [],
    codeActions: async (filePath, line, character, context) => [],
    changeDocument: async (filePath, content) => {
      changeCalls.push(filePath);
    },
    waitForDiagnostics: async (filePath) => [
      { severity: 1, message: 'no-use-before-define', range: { start: { line: 0, character: 0 } } },
    ],
    changeCalls,
    ...overrides,
  };
}

// Stub de completeWithTools: la 1ª llamada devuelve un tool-call LSP y la 2ª
// cierra con texto (mismo patrón que testNativeToolCallEmptyContent).
function stubCompleteWithTools(toolCall) {
  const LLMProvider = require('../core/llm/LLMProvider.js');
  const original = LLMProvider.completeWithTools;
  let calls = 0;
  LLMProvider.completeWithTools = async () => {
    calls++;
    if (calls === 1) return { content: null, toolCalls: [toolCall] };
    return { content: 'Tarea completada.', toolCalls: null };
  };
  return {
    calls: () => calls,
    restore: () => {
      LLMProvider.completeWithTools = original;
    },
  };
}

// ── Test 1: get_diagnostics se despacha al LSPManager, no al bridge ───────────

async function testLSPDispatch() {
  console.log(C.bold('\n── Test 1: Tool LSP se ejecuta en el LSPManager (no en OpenClaw) ─'));

  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const filePath = '/tmp/agent-loop-lsp-test/main.js';

  const stub = stubCompleteWithTools({ tool: 'get_diagnostics', params: { filePath } });
  const bridge = createTrackingBridge();
  const lsp = createMockLSP();

  try {
    const loop = new AgentLoop({
      maxIterations: 5,
      llm: createMockLLM(['no se usa']),
      bridge,
      lsp,
    });

    const result = await loop.run('diagnostica main.js', 'Eres un asistente.', [], {
      tools: [
        {
          name: 'get_diagnostics',
          description: 'diagnósticos',
          inputSchema: { type: 'object', properties: { filePath: { type: 'string' } } },
        },
      ],
    });

    assert(
      result.toolResults.length === 1,
      '1 herramienta ejecutada',
      `tools: ${result.toolResults.length}`
    );
    const tr = result.toolResults[0];
    assert(tr.tool === 'get_diagnostics', 'Tool: get_diagnostics');
    assert(tr.ok, 'La tool LSP tuvo éxito', tr.error || '');
    assert(
      Array.isArray(tr.result) && tr.result[0]?.message === 'Error sintáctico',
      'Resultado real del LSPManager llega al loop',
      JSON.stringify(tr.result)
    );
    assert(
      !bridge.calls.includes('get_diagnostics'),
      'get_diagnostics NO llegó al bridge OpenClaw',
      `bridge recibió: ${bridge.calls.join(', ')}`
    );
    assert(!result.error, 'Sin error de loop', result.error || '');
    assert(
      stub.calls() === 2,
      'completeWithTools llamado 2 veces (tool call + cierre)',
      `llamadas: ${stub.calls()}`
    );
  } finally {
    stub.restore();
  }
}

// ── Test 2: Lenguaje no soportado → error explícito, no [] silencioso ────────

async function testLSPUnsupportedLanguage() {
  console.log(C.bold('\n── Test 2: Lenguaje no soportado → error informativo ────────────'));

  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const filePath = '/tmp/agent-loop-lsp-test/main.c';

  const stub = stubCompleteWithTools({ tool: 'get_diagnostics', params: { filePath } });
  const bridge = createTrackingBridge();
  const lsp = createMockLSP();

  try {
    const loop = new AgentLoop({
      maxIterations: 5,
      llm: createMockLLM(['no se usa']),
      bridge,
      lsp,
    });

    const result = await loop.run('diagnostica main.c', 'Eres un asistente.', [], {
      tools: [
        {
          name: 'get_diagnostics',
          description: 'diagnósticos',
          inputSchema: { type: 'object', properties: { filePath: { type: 'string' } } },
        },
      ],
    });

    const tr = result.toolResults[0];
    assert(tr && !tr.ok, 'La tool falla (lenguaje no soportado)');
    assert(
      tr.error.includes('no está soportado por el LSP activo'),
      'Error explica que el lenguaje no está soportado',
      tr.error || ''
    );
    assert(
      tr.error.includes('javascript'),
      'El error lista los servidores activos',
      tr.error || ''
    );
    assert(
      !bridge.calls.includes('get_diagnostics'),
      'No cayó al bridge',
      `bridge recibió: ${bridge.calls.join(', ')}`
    );
  } finally {
    stub.restore();
  }
}

// ── Test 3: Sin LSPManager → error claro ──────────────────────────────────────

async function testLSPNotAvailable() {
  console.log(C.bold('\n── Test 3: Sin LSPManager → error claro ─────────────────────────'));

  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const filePath = '/tmp/agent-loop-lsp-test/main.js';

  const stub = stubCompleteWithTools({ tool: 'get_diagnostics', params: { filePath } });
  const bridge = createTrackingBridge();

  try {
    const loop = new AgentLoop({
      maxIterations: 5,
      llm: createMockLLM(['no se usa']),
      bridge,
    });

    const result = await loop.run('diagnostica main.js', 'Eres un asistente.', [], {
      tools: [
        {
          name: 'get_diagnostics',
          description: 'diagnósticos',
          inputSchema: { type: 'object', properties: { filePath: { type: 'string' } } },
        },
      ],
    });

    const tr = result.toolResults[0];
    assert(tr && !tr.ok, 'La tool falla sin LSP');
    assert(
      tr.error.includes('LSP no disponible'),
      'Error indica LSP no disponible',
      tr.error || ''
    );
    assert(
      !bridge.calls.includes('get_diagnostics'),
      'No cayó al bridge',
      `bridge recibió: ${bridge.calls.join(', ')}`
    );
  } finally {
    stub.restore();
  }
}

// ── Test 4: tras un edit, el turno recibe el feedback LSP (patrón opencode) ───

// Bridge que edita archivos reales en disco (para el feedback post-edit).
function createEditBridge() {
  const calls = [];
  return {
    calls,
    execute: async (tool, params) => {
      const t0 = Date.now();
      try {
        if (tool === 'edit' || tool === 'edit_file') {
          const p = params.path;
          if (!fs.existsSync(p)) {
            return {
              ok: false,
              error: `File not found: ${p}`,
              result: null,
              tool,
              elapsed: Date.now() - t0,
            };
          }
          const content = fs.readFileSync(p, 'utf-8');
          const oldText = params.oldString || params.old_text || params.instruction || '';
          const newText = params.newString || params.new_text || '';
          calls.push(tool);
          if (oldText && content.includes(oldText)) {
            fs.writeFileSync(p, content.replace(oldText, newText), 'utf-8');
            return { ok: true, result: `Edited ${p}`, error: null, tool, elapsed: Date.now() - t0 };
          }
          return {
            ok: true,
            result: `File ${p} unchanged (no matching text)`,
            error: null,
            tool,
            elapsed: Date.now() - t0,
          };
        }
        calls.push(tool);
        return {
          ok: true,
          result: `[bridge] ${tool}`,
          error: null,
          tool,
          elapsed: Date.now() - t0,
        };
      } catch (e) {
        return { ok: false, error: e.message, result: null, tool, elapsed: Date.now() - t0 };
      }
    },
  };
}

async function testLSPFeedbackAfterEdit() {
  console.log(C.bold('\n── Test 4: edit devuelve diagnósticos LSP post-edición al loop ─────'));

  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-lsp-edit-'));
  const filePath = path.join(tmpDir, 'bug.js');
  fs.writeFileSync(filePath, 'const x = 1;\n', 'utf-8');

  const stub = stubCompleteWithTools({
    tool: 'edit',
    params: { path: filePath, oldString: 'x = 1', newString: 'y = 2' },
  });
  const lsp = createMockLSP();

  try {
    const loop = new AgentLoop({
      maxIterations: 5,
      llm: createMockLLM(['no se usa']),
      bridge: createEditBridge(),
      lsp,
    });

    const result = await loop.run('edita bug.js', 'Eres un asistente.', [], {
      onApprovalNeeded: async () => true,
      tools: [
        {
          name: 'edit',
          description: 'edita',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              oldString: { type: 'string' },
              newString: { type: 'string' },
            },
          },
        },
      ],
    });

    const tr = result.toolResults[0];
    assert(tr && tr.ok, 'La edición tuvo éxito', tr?.error || '');
    assert(tr.tool === 'edit', 'Tool: edit');
    assert(
      Array.isArray(tr.lspDiagnostics) && tr.lspDiagnostics.length === 1,
      'El resultado lleva los diagnósticos post-edición',
      JSON.stringify(tr.lspDiagnostics)
    );
    assert(
      tr.lspDiagnostics[0].message === 'no-use-before-define',
      'El diagnóstico LSP es el esperado'
    );
    assert(
      lsp.changeCalls.length === 1 && lsp.changeCalls[0] === filePath,
      'changeDocument fue avisado del archivo editado'
    );
    assert(fs.readFileSync(filePath, 'utf-8').includes('y = 2'), 'El archivo se editó en disco');
    assert(!result.error, 'Sin error de loop', result.error || '');
  } finally {
    stub.restore();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

// ── Test 5: edit sin LSP activo no rompe el loop (feedback opcional) ─────────

async function testLSPFeedbackSkippedWhenNotRunning() {
  console.log(C.bold('\n── Test 5: edit sin LSP activo no rompe el loop ─────────────────'));

  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-lsp-edit2-'));
  const filePath = path.join(tmpDir, 'bug.js');
  fs.writeFileSync(filePath, 'const x = 1;\n', 'utf-8');

  const stub = stubCompleteWithTools({
    tool: 'edit',
    params: { path: filePath, oldString: 'x = 1', newString: 'y = 2' },
  });

  try {
    const loop = new AgentLoop({
      maxIterations: 5,
      llm: createMockLLM(['no se usa']),
      bridge: createEditBridge(),
      // sin lsp
    });

    const result = await loop.run('edita bug.js', 'Eres un asistente.', [], {
      onApprovalNeeded: async () => true,
      tools: [
        {
          name: 'edit',
          description: 'edita',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              oldString: { type: 'string' },
              newString: { type: 'string' },
            },
          },
        },
      ],
    });

    const tr = result.toolResults[0];
    assert(tr && tr.ok, 'La edición sigue funcionando sin LSP', tr?.error || '');
    assert(
      tr.lspDiagnostics === undefined,
      'Sin feedback LSP (no hay manager)',
      JSON.stringify(tr.lspDiagnostics)
    );
    assert(!result.error, 'Sin error de loop', result.error || '');
  } finally {
    stub.restore();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

// ── Test 6: hover (LSP.3) se despacha al LSPManager ───────────────────────────

async function testHoverDispatch() {
  console.log(C.bold('\n── Test 6: hover (LSP.3) se despacha al LSPManager ───────────────'));

  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const filePath = '/tmp/agent-loop-lsp-test/main.js';

  const stub = stubCompleteWithTools({
    tool: 'hover',
    params: { filePath, line: 2, character: 3 },
  });
  const bridge = createTrackingBridge();
  const lsp = createMockLSP();

  try {
    const loop = new AgentLoop({
      maxIterations: 5,
      llm: createMockLLM(['no se usa']),
      bridge,
      lsp,
    });

    const result = await loop.run('hover sobre main.js', 'Eres un asistente.', [], {
      tools: [
        {
          name: 'hover',
          description: 'hover',
          inputSchema: { type: 'object', properties: { filePath: { type: 'string' } } },
        },
      ],
    });

    const tr = result.toolResults[0];
    assert(tr && tr.ok, 'La tool hover tuvo éxito', tr?.error || '');
    assert(tr.tool === 'hover', 'Tool: hover');
    assert(
      tr.result?.contents === 'const x: number',
      'Resultado del hover llega al loop',
      JSON.stringify(tr.result)
    );
    assert(
      !bridge.calls.includes('hover'),
      'hover NO llegó al bridge OpenClaw',
      `bridge: ${bridge.calls.join(', ')}`
    );
    assert(!result.error, 'Sin error de loop', result.error || '');
  } finally {
    stub.restore();
  }
}

// ── Helpers / Main ────────────────────────────────────────────────────────────

function createMockLLM(responses) {
  let callCount = 0;
  const fn = async () => {
    if (callCount >= responses.length) return 'Tarea completada.';
    return responses[callCount++];
  };
  fn.callCount = () => callCount;
  return fn;
}

async function main() {
  console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
  console.log(C.bold(C.cyan('  Test Suite: AgentLoop dispatch LSP (fix tools LSP)')));
  console.log(C.bold(C.cyan('════════════════════════════════════════════════════════')));

  await testLSPDispatch();
  await testLSPUnsupportedLanguage();
  await testLSPNotAvailable();
  await testLSPFeedbackAfterEdit();
  await testLSPFeedbackSkippedWhenNotRunning();
  await testHoverDispatch();

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

main().catch((e) => {
  console.error(C.red('\nERROR FATAL:'), e.message);
  console.error(e.stack);
  process.exit(1);
});
