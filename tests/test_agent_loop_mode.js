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

// ── Mocks ─────────────────────────────────────────────────────────────────

const mockBridge = {
  execute: async (tool, params) => {
    if (tool === 'exec' && params.command === 'ls') {
      return {
        ok: true,
        result: { stdout: 'src\npackage.json\nREADME.md', stderr: '', exitCode: 0 },
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

// Mock schema que AgentLoop necesita para entrar al path de tool-calling
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

const LLMProvider = require('../core/llm/LLMProvider.js');
let capturedMode = null;
let callCount = 0;

function setupMock() {
  capturedMode = null;
  callCount = 0;

  const orig = LLMProvider.completeWithTools;
  LLMProvider.completeWithTools = async (messages, systemPrompt, tools, callMode) => {
    capturedMode = callMode;
    callCount++;
    if (callCount === 1) {
      return {
        content: 'Ejecutando el comando...',
        toolCalls: [{ tool: 'exec', params: { command: 'ls' } }],
      };
    }
    return {
      content: 'Aquí está el listado del directorio:\n- src/\n- package.json\n- README.md',
      toolCalls: null,
    };
  };
  return () => {
    LLMProvider.completeWithTools = orig;
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

function testModePropagation() {
  console.log(C.bold('\n── AgentLoop.mode se propaga a completeWithTools ───────────'));

  const { AgentLoop } = require('../core/planner/AgentLoop.js');

  const loop = new AgentLoop({
    bridge: mockBridge,
    mode: 'conversational',
    maxIterations: 5,
  });

  assert(loop._mode === 'fast', 'AgentLoop._mode = "fast" (conversational → fast)');
}

function testDefaultModeIsSmart() {
  console.log(C.bold('\n── AgentLoop default mode es "smart" ──────────────────────'));

  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const loop = new AgentLoop({ bridge: mockBridge, maxIterations: 2 });
  assert(loop._mode === 'smart', 'AgentLoop default _mode es "smart"');
}

async function testCompleteWithToolsReceivesMode() {
  console.log(C.bold('\n── completeWithTools recibe el modo ───────────────────────'));

  const restore = setupMock();
  const { AgentLoop } = require('../core/planner/AgentLoop.js');

  const loop = new AgentLoop({
    bridge: mockBridge,
    mode: 'fast',
    maxIterations: 5,
  });

  await loop.run('ejecuta un ls', 'Eres un asistente.', [], { tools: mockToolSchemas });

  assert(callCount >= 1, 'Se hizo al menos 1 llamada al LLM');
  assertEqual(capturedMode, 'fast', 'completeWithTools recibió mode="fast"');
  restore();
}

async function testTaskModeUsesSmart() {
  console.log(C.bold('\n── Modo "task" usa "smart" ────────────────────────────────'));

  const restore = setupMock();
  const { AgentLoop } = require('../core/planner/AgentLoop.js');

  const loop = new AgentLoop({
    bridge: mockBridge,
    mode: 'smart',
    maxIterations: 5,
  });

  await loop.run('ejecuta un ls', 'Eres un asistente.', [], { tools: mockToolSchemas });

  assertEqual(capturedMode, 'smart', 'completeWithTools recibió mode="smart"');
  restore();
}

async function testOnProgressCallback() {
  console.log(C.bold('\n── onProgress se llama en cada iteración ──────────────────'));

  const progressEvents = [];
  const restore = setupMock();
  const { AgentLoop } = require('../core/planner/AgentLoop.js');

  const loop = new AgentLoop({
    bridge: mockBridge,
    mode: 'fast',
    maxIterations: 5,
  });

  await loop.run('ejecuta un ls', 'Eres un asistente.', [], {
    tools: mockToolSchemas,
    onProgress: (ev) => progressEvents.push(ev),
  });

  assert(progressEvents.length > 0, 'onProgress fue llamado al menos una vez');
  if (progressEvents.length > 0) {
    const first = progressEvents[0];
    assert(first.iteration === 1, `Primer evento tiene iteration=1 (got ${first.iteration})`);
    assert(first.tool === 'exec', `Primer evento tiene tool="exec" (got "${first.tool}")`);
    assert(first.phase === 'start', `Primer evento tiene phase="start" (got "${first.phase}")`);
    const endEvent = progressEvents.find((ev) => ev.phase === 'end' && ev.tool === 'exec');
    assert(!!endEvent, 'hay un evento phase="end" para la tool exec');
    assert(
      endEvent && endEvent.status === 'ok',
      `Evento end tiene status="ok" (got "${endEvent && endEvent.status}")`
    );
  }
  restore();
}

async function testOnProgressNotCalledWhenMissing() {
  console.log(C.bold('\n── Sin onProgress, no hay error ───────────────────────────'));

  const restore = setupMock();
  const { AgentLoop } = require('../core/planner/AgentLoop.js');

  const loop = new AgentLoop({
    bridge: mockBridge,
    mode: 'fast',
    maxIterations: 5,
  });

  try {
    await loop.run('ejecuta un ls', 'Eres un asistente.', [], { tools: mockToolSchemas });
    assert(true, 'AgentLoop.run() sin onProgress no lanza error');
  } catch (e) {
    assert(false, 'AgentLoop.run() sin onProgress no debería lanzar error', e.message);
  }
  restore();
}

// ── Mode translation tests ──────────────────────────────────────────────

function testModeTranslationTask() {
  console.log(C.bold('\n── UI "task" se traduce a "smart" ─────────────────────────'));

  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const loop = new AgentLoop({ bridge: mockBridge, mode: 'task' });
  assert(loop._mode === 'smart', 'AgentLoop._mode = "smart" cuando la UI envía "task"');
}

function testModeTranslationConversational() {
  console.log(C.bold('\n── UI "conversational" se traduce a "fast" ────────────────'));

  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const loop = new AgentLoop({ bridge: mockBridge, mode: 'conversational' });
  assert(loop._mode === 'fast', 'AgentLoop._mode = "fast" cuando la UI envía "conversational"');
}

function testModeTranslationPassThrough() {
  console.log(C.bold('\n── "smart"/"fast" pasan sin traducción ────────────────────'));

  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const loop1 = new AgentLoop({ bridge: mockBridge, mode: 'smart' });
  const loop2 = new AgentLoop({ bridge: mockBridge, mode: 'fast' });
  assert(loop1._mode === 'smart', 'AgentLoop._mode = "smart"');
  assert(loop2._mode === 'fast', 'AgentLoop._mode = "fast"');
}

function testMODELSHasKeyForTranslatedModes() {
  console.log(C.bold('\n── MODELS.groq[mode traducido] nunca es undefined ──────────'));

  const MODELS = LLMProvider._debug_MODELS ? LLMProvider._debug_MODELS() : null;
  if (!MODELS) {
    skipped++;
    console.log(`  ${C.yellow('⚠')} MODELS no exportado, test saltado`);
    return;
  }

  const providers = Object.keys(MODELS);
  if (providers.length === 0) {
    skipped++;
    console.log(`  ${C.yellow('⚠')} No hay proveedores en MODELS, test saltado`);
    return;
  }

  for (const provider of providers) {
    const models = MODELS[provider];
    const fastModel = models['fast'];
    const smartModel = models['smart'];

    assert(fastModel !== undefined, `MODELS.${provider}.fast está definido (${fastModel})`);
    assert(smartModel !== undefined, `MODELS.${provider}.smart está definido (${smartModel})`);

    // También verificamos que el modelo string no es "undefined" como string
    assert(fastModel !== 'undefined', `MODELS.${provider}.fast no es el string "undefined"`);
    assert(smartModel !== 'undefined', `MODELS.${provider}.smart no es el string "undefined"`);
  }

  // Verificación final: MODELS.groq['task'] daría undefined (sin traducción)
  // y MODELS.groq['conversational'] también — eso es exactamente el bug
  if (MODELS.groq) {
    assert(
      MODELS.groq['task'] === undefined,
      'MODELS.groq["task"] es undefined (confirma que el bug existe sin traducción)'
    );
    assert(
      MODELS.groq['conversational'] === undefined,
      'MODELS.groq["conversational"] es undefined (confirma que el bug existe sin traducción)'
    );
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────

console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
console.log(C.bold(C.cyan('  AgentLoop Mode Propagation — Fase 2')));
console.log(C.bold(C.cyan('════════════════════════════════════════════════════════')));

testModePropagation();
testDefaultModeIsSmart();
testModeTranslationTask();
testModeTranslationConversational();
testModeTranslationPassThrough();
testMODELSHasKeyForTranslatedModes();

(async () => {
  await testCompleteWithToolsReceivesMode();
  await testTaskModeUsesSmart();
  await testOnProgressCallback();
  await testOnProgressNotCalledWhenMissing();

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
})();