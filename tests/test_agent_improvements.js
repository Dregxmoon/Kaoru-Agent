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

// ── Setup / Teardown ──────────────────────────────────────────────────────────

let tmpDir;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-improve-test-'));
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ key: 'value' }), 'utf-8');
  return tmpDir;
}

function teardown() {
  if (tmpDir) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
    tmpDir = null;
  }
}

// ── Mock LLM ──────────────────────────────────────────────────────────────────

function createMockLLM(responses) {
  let callCount = 0;
  const fn = async (messages, systemPrompt) => {
    if (callCount >= responses.length) return 'Tarea completada.';
    return responses[callCount++];
  };
  fn.callCount = () => callCount;
  return fn;
}

// ── 1. write mode append (openclaw-server) ────────────────────────────────────
async function testWriteAppendMode() {
  console.log(C.bold('\n── write mode append (chunked) ───────────────────────────'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-append-'));
  process.env.OPENCLAW_ALLOWED_PATH = dir;
  process.env.OPENCLAW_API_KEY = 'test-key-append';
  const srv = require('../openclaw-server.js');

  const rel = 'grande.txt';
  const first = await srv.handleTool({
    tool: 'write',
    input: { path: rel, content: 'linea1\nlinea2\n' },
  });
  assert(!first.error, 'write inicial crea el archivo');
  const middle = await srv.handleTool({
    tool: 'write',
    input: { path: rel, content: 'linea3\nlinea4\n', mode: 'append' },
  });
  assert(!middle.error, 'write mode append no falla');
  const content = fs.readFileSync(path.join(dir, rel), 'utf-8');
  assert(
    content === 'linea1\nlinea2\nlinea3\nlinea4\n',
    'append acumula al final sin reescribir',
    JSON.stringify(content)
  );
  assert(/Appended/.test(middle.result), 'respuesta indica "Appended"');
  const modeInvalid = await srv.handleTool({
    tool: 'write',
    input: { path: 'nuevo.txt', content: 'x', mode: 'sobrescribir' },
  });
  assert(!modeInvalid.error, 'mode inválido cae a write (default)');
  assert(
    fs.readFileSync(path.join(dir, 'nuevo.txt'), 'utf-8') === 'x',
    'mode inválido sobreescribe igual'
  );
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.OPENCLAW_ALLOWED_PATH;
  delete process.env.OPENCLAW_API_KEY;
}

// ── 2. Caché de read dentro del run ───────────────────────────────────────────
async function testReadCache() {
  console.log(C.bold('\n── caché de read por-run ──────────────────────────────────'));
  const projectCwd = setup();
  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const AP = require('../core/planner/ActionParser.js');
  AP.setProjectCWD(projectCwd);

  const target = path.join(projectCwd, 'config.json');
  const LLMProvider = require('../core/llm/LLMProvider.js');
  const orig = LLMProvider.completeWithTools;
  let calls = 0;
  LLMProvider.completeWithTools = async () => {
    calls++;
    if (calls <= 2)
      return { content: null, toolCalls: [{ tool: 'read', params: { path: target } }] };
    return { content: 'Listo.', toolCalls: null };
  };
  try {
    const bridge = createMockBridge(projectCwd);
    let readExec = 0;
    const wrapped = {
      ...bridge,
      execute: async (tool, params) => {
        if (tool === 'read') readExec++;
        return bridge.execute(tool, params);
      },
    };
    const loop = new AgentLoop({ maxIterations: 6, llm: createMockLLM(['x']), bridge: wrapped });
    const result = await loop.run('leé el archivo dos veces', 'Eres un asistente.', [], {
      tools: [
        { name: 'read', description: 'lee', inputSchema: { type: 'object', properties: {} } },
      ],
    });
    assert(!result.error, 'run sin error');
    assert(
      readExec === 1,
      'la 2ª lectura sale del caché (bridge ejecutó 1 vez)',
      `read=${readExec}`
    );
    assert(
      result.toolResults.length === 2,
      'ambas lecturas se registran como tool calls',
      `tools=${result.toolResults.length}`
    );
  } finally {
    LLMProvider.completeWithTools = orig;
    teardown();
  }
}

// ── 3. Invalidación del caché de read tras write ──────────────────────────────
async function testReadCacheInvalidation() {
  console.log(C.bold('\n── invalidación del caché de read tras write ───────────────'));
  const projectCwd = setup();
  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const AP = require('../core/planner/ActionParser.js');
  AP.setProjectCWD(projectCwd);

  const target = path.join(projectCwd, 'nuevo.txt');
  fs.writeFileSync(target, 'v1', 'utf-8');
  const LLMProvider = require('../core/llm/LLMProvider.js');
  const orig = LLMProvider.completeWithTools;
  let calls = 0;
  const seq = [
    { tool: 'read', params: { path: target } },
    { tool: 'write', params: { path: target, content: 'v2' } },
    { tool: 'read', params: { path: target } },
  ];
  LLMProvider.completeWithTools = async () => {
    const s = seq[Math.min(calls, seq.length - 1)];
    calls++;
    if (calls <= seq.length)
      return { content: null, toolCalls: [{ tool: s.tool, params: s.params }] };
    return { content: 'Listo.', toolCalls: null };
  };
  try {
    const bridge = createMockBridge(projectCwd);
    let readExec = 0;
    const wrapped = {
      ...bridge,
      execute: async (tool, params) => {
        if (tool === 'read') readExec++;
        return bridge.execute(tool, params);
      },
    };
    const loop = new AgentLoop({ maxIterations: 6, llm: createMockLLM(['x']), bridge: wrapped });
    await loop.run('lee, escribí y releé', 'Eres un asistente.', [], {
      tools: [
        { name: 'read', description: 'lee', inputSchema: { type: 'object', properties: {} } },
        { name: 'write', description: 'escribe', inputSchema: { type: 'object', properties: {} } },
      ],
      onApprovalNeeded: async () => true,
    });
    assert(
      readExec === 2,
      'tras write se re-lee fresco (2 ejecuciones reales)',
      `read=${readExec}`
    );
    assert(
      fs.readFileSync(target, 'utf-8') === 'v2',
      'el write reescribió el archivo',
      fs.readFileSync(target, 'utf-8')
    );
  } finally {
    LLMProvider.completeWithTools = orig;
    teardown();
  }
}

// ── 4. Caché de exec read-only (git status) ───────────────────────────────────
async function testExecCache() {
  console.log(C.bold('\n── caché de exec read-only ─────────────────────────────────'));
  const projectCwd = setup();
  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const AP = require('../core/planner/ActionParser.js');
  AP.setProjectCWD(projectCwd);

  const LLMProvider = require('../core/llm/LLMProvider.js');
  const orig = LLMProvider.completeWithTools;
  let calls = 0;
  LLMProvider.completeWithTools = async () => {
    calls++;
    if (calls <= 2)
      return { content: null, toolCalls: [{ tool: 'exec', params: { command: 'git status' } }] };
    return { content: 'Listo.', toolCalls: null };
  };
  try {
    const bridge = createMockBridge(projectCwd);
    let execExec = 0;
    const wrapped = {
      ...bridge,
      execute: async (tool, params) => {
        if (tool === 'exec') execExec++;
        return bridge.execute(tool, params);
      },
    };
    const loop = new AgentLoop({ maxIterations: 6, llm: createMockLLM(['x']), bridge: wrapped });
    await loop.run('git status dos veces', 'Eres un asistente.', [], {
      tools: [
        { name: 'exec', description: 'ejecuta', inputSchema: { type: 'object', properties: {} } },
      ],
    });
    assert(execExec === 1, 'git status repetido sale del caché', `exec=${execExec}`);
  } finally {
    LLMProvider.completeWithTools = orig;
    teardown();
  }
}

// ── 5. Iteraciones adaptativas ────────────────────────────────────────────────
async function testAdaptiveIterations() {
  console.log(C.bold('\n── iteraciones adaptativas ─────────────────────────────────'));
  const projectCwd = setup();
  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const AP = require('../core/planner/ActionParser.js');
  AP.setProjectCWD(projectCwd);

  const target = path.join(projectCwd, 'prog.txt');
  const LLMProvider = require('../core/llm/LLMProvider.js');
  const orig = LLMProvider.completeWithTools;
  let calls = 0;
  LLMProvider.completeWithTools = async () => {
    calls++;
    if (calls <= 50)
      return {
        content: null,
        toolCalls: [{ tool: 'write', params: { path: target, content: 'x' } }],
      };
    return { content: 'Listo.', toolCalls: null };
  };
  try {
    const loop = new AgentLoop({
      maxIterations: 4,
      llm: createMockLLM(['x']),
      bridge: createMockBridge(projectCwd),
    });
    const result = await loop.run('escribí mucho', 'Eres un asistente.', [], {
      tools: [
        { name: 'write', description: 'escribe', inputSchema: { type: 'object', properties: {} } },
      ],
      onApprovalNeeded: async () => true,
    });
    assert(result.truncated === true, 'el run se trunca (el LLM no cerró)');
    assert(
      result.iterations >= 9,
      'el presupuesto se extendió más allá del inicial (4)',
      `iterations=${result.iterations}`
    );
  } finally {
    LLMProvider.completeWithTools = orig;
    teardown();
  }
}

// ── 6. git_stash ya no marca progreso (backlog 1.5) ───────────────────────────
async function testGitStashNoProgress() {
  console.log(C.bold('\n── git_stash no marca progreso (backlog 1.5) ───────────────'));
  const projectCwd = setup();
  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const AP = require('../core/planner/ActionParser.js');
  AP.setProjectCWD(projectCwd);

  const LLMProvider = require('../core/llm/LLMProvider.js');
  const orig = LLMProvider.completeWithTools;
  let calls = 0;
  let sawStuckNote = false;
  LLMProvider.completeWithTools = async (messages) => {
    calls++;
    if (calls <= 5) {
      return {
        content: null,
        toolCalls: [{ tool: 'git_stash', params: { action: 'push' } }],
      };
    }
    sawStuckNote = /sin avanzar/.test(JSON.stringify(messages));
    return { content: 'Cambio de estrategia.', toolCalls: null };
  };
  try {
    const fakeGit = { stash: async () => ({ ok: true, result: 'stashed', stdout: '' }) };
    const loop = new AgentLoop({
      maxIterations: 8,
      llm: createMockLLM(['x']),
      bridge: createMockBridge(projectCwd),
      git: fakeGit,
    });
    await loop.run('guardá en stash', 'Eres un asistente.', [], {
      tools: [
        {
          name: 'git_stash',
          description: 'stash',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      stuckToolThreshold: 2,
      onApprovalNeeded: async () => true,
    });
    assert(
      sawStuckNote,
      'git_stash ok repetido DISPARA el aviso de estancamiento (ya no es progreso)'
    );
  } finally {
    LLMProvider.completeWithTools = orig;
    teardown();
  }
}

// ── 7. onPlan: plan visible en el chat + done con _marksProgress ──────────────
async function testOnPlanEmission() {
  console.log(C.bold('\n── plan visible (onPlan) + done con _marksProgress ───────────'));
  const projectCwd = setup();
  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const AP = require('../core/planner/ActionParser.js');
  AP.setProjectCWD(projectCwd);

  const target = path.join(projectCwd, 'plan.txt');
  const LLMProvider = require('../core/llm/LLMProvider.js');
  const orig = LLMProvider.completeWithTools;
  let calls = 0;
  LLMProvider.completeWithTools = async () => {
    calls++;
    if (calls <= 1)
      return {
        content: null,
        toolCalls: [{ tool: 'write', params: { path: target, content: 'v1' } }],
      };
    return { content: 'Listo.', toolCalls: null };
  };
  const planEvents = [];
  const longMessage =
    'Necesito que realices una tarea bastante compleja y de varios pasos para el proyecto: ' +
    'primero revisar los archivos .js de configuración del módulo principal, luego modificar ' +
    'el procesamiento para que soporte el nuevo formato de datos, actualizar las pruebas ' +
    'unitarias y por último correr npm run typecheck y la verificación completa del proyecto.';
  const planLLM = createMockLLM(['PLAN:\n1. Leer contexto\n2. Escribir archivo\n']);
  try {
    const loop = new AgentLoop({
      maxIterations: 6,
      llm: planLLM,
      bridge: createMockBridge(projectCwd),
    });
    const result = await loop.run(longMessage, 'Eres un asistente.', [], {
      tools: [
        { name: 'write', description: 'escribe', inputSchema: { type: 'object', properties: {} } },
      ],
      planning: true,
      onPlan: (p) => planEvents.push(p),
      onApprovalNeeded: async () => true,
    });
    const created = planEvents.find((p) => p.kind === 'created');
    assert(created && created.steps.length === 2, 'se emitió evento "created" con los pasos');
    const progress = planEvents.filter((p) => p.kind === 'progress');
    assert(progress.length >= 1, 'se emitieron eventos de progreso durante el run');
    assert(
      result.plan && result.plan.done === 1,
      'el write cuenta como 1 paso de plan',
      JSON.stringify(result.plan)
    );
  } finally {
    LLMProvider.completeWithTools = orig;
    teardown();
  }
}

// ── 7b. Plan auto-ejecutable: sección inyectada con orden de NO preguntar ────
async function testPlanAutoExecute() {
  console.log(C.bold('\n── plan auto-ejecutable (sin pedir confirmación) ─────────────'));
  const projectCwd = setup();
  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const AP = require('../core/planner/ActionParser.js');
  AP.setProjectCWD(projectCwd);

  const loop = new AgentLoop({
    maxIterations: 4,
    llm: createMockLLM(['x']),
    bridge: createMockBridge(projectCwd),
  });
  const section = loop._renderPlanSection(['Leer contexto', 'Escribir archivo']);
  assert(
    section.includes('# PLAN DE EJECUCIÓN'),
    'la sección inyectada lleva el encabezado del plan'
  );
  assert(
    section.includes('SIN pedir confirmación'),
    'ordena ejecutar sin pedir confirmación',
    section
  );
  assert(section.includes('- [ ] Leer contexto'), 'cada paso es una casilla "- [ ]"', section);

  // Run completo: el agentPrompt que recibe el LLM incluye la sección del plan.
  const target = path.join(projectCwd, 'plan-auto.txt');
  const LLMProvider = require('../core/llm/LLMProvider.js');
  const orig = LLMProvider.completeWithTools;
  let sawPrompt = '';
  LLMProvider.completeWithTools = async (_messages, agentPrompt) => {
    sawPrompt = agentPrompt || '';
    return {
      content: null,
      toolCalls: [{ tool: 'write', params: { path: target, content: 'v1' } }],
    };
  };
  try {
    const planLLM = createMockLLM(['PLAN:\n1. Leer contexto\n2. Escribir archivo\n']);
    const loop2 = new AgentLoop({
      maxIterations: 4,
      llm: planLLM,
      bridge: createMockBridge(projectCwd),
    });
    await loop2.run(
      'Necesito que realices una tarea bastante compleja y de varios pasos para el proyecto: ' +
        'primero revisar los archivos .js de configuración del módulo principal, luego modificar ' +
        'el procesamiento para que soporte el nuevo formato de datos, actualizar las pruebas ' +
        'unitarias y por último correr npm run typecheck y la verificación completa del proyecto.',
      'Eres un asistente.',
      [],
      {
        tools: [
          {
            name: 'write',
            description: 'escribe',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
        planning: true,
        onApprovalNeeded: async () => true,
      }
    );
    assert(
      sawPrompt.includes('# PLAN DE EJECUCIÓN') && sawPrompt.includes('SIN pedir confirmación'),
      'el prompt del bucle incluye el plan con orden de ejecutar sin confirmar'
    );
  } finally {
    LLMProvider.completeWithTools = orig;
    teardown();
  }
}

// ── 8. LearningEngine.calibratedDifficulty ────────────────────────────────────
function testCalibratedDifficulty() {
  console.log(C.bold('\n── dificultad calibrada con outcomes ───────────────────────'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-cal-'));
  const { LearningEngine } = require('../core/learning/LearningEngine.js');

  const eng = new LearningEngine({ filePath: path.join(dir, 'learning.json') });
  // Sin muestras: devuelve el heurístico puro.
  assert(
    eng.calibratedDifficulty({ message: 'hola', mode: 'smart' }) === 0.2,
    'sin muestras → heurístico'
  );

  // 8 fallos seguidos en 'smart' → la tasa baja y la dificultad sube.
  const engFail = new LearningEngine({ filePath: path.join(dir, 'fail.json') });
  for (let i = 0; i < 8; i++) engFail.recordTaskOutcome({ mode: 'smart', success: false });
  const dFail = engFail.calibratedDifficulty({ message: 'hola', mode: 'smart' });
  assert(dFail === 0.35, 'tasa de éxito 0% → dificultad +0.15', `got ${dFail}`);

  // 8 éxitos → la dificultad baja.
  const engOk = new LearningEngine({ filePath: path.join(dir, 'ok.json') });
  for (let i = 0; i < 8; i++) engOk.recordTaskOutcome({ mode: 'smart', success: true });
  const dOk = engOk.calibratedDifficulty({ message: 'hola', mode: 'smart' });
  assert(dOk === 0.05, 'tasa de éxito 100% → dificultad -0.15', `got ${dOk}`);

  // Acotado en [0,1].
  const dHi = engOk.calibratedDifficulty({ message: 'hola', mode: 'smart' });
  assert(dHi >= 0 && dHi <= 1, 'siempre en [0,1]');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 9. Comandos /estado y /reanudar-tarea ─────────────────────────────────────
async function testIntentionCommands() {
  console.log(C.bold('\n── comandos /estado y /reanudar-tarea ───────────────────────'));
  const { execute } = require('../core/commands/CommandRegistry.js');

  const intentions = [
    {
      id: 7,
      goal: 'Implementar el módulo de pagos',
      steps: JSON.stringify(['diseñar schema', 'crear controlador', 'testear']),
      last_progress: 'Se interrumpió tras 12 iteraciones — plan 1/3.',
    },
  ];
  const ipc = {
    invoke: async (ch) => (ch === 'intentions-list' ? intentions : []),
  };

  const estado = await execute('/estado', { ipcRenderer: ipc });
  assert(estado && estado.result, 'estado responde resultado');
  assert(/Implementar el módulo de pagos/.test(estado.result), 'estado muestra la meta pendiente');
  assert(/reanudar-tarea 7/.test(estado.result), 'estado sugiere /reanudar-tarea con el id');

  let resumed = null;
  const reanudar = await execute('/reanudar-tarea 7', {
    ipcRenderer: ipc,
    processMessage: (msg) => {
      resumed = msg;
    },
  });
  assert(reanudar && reanudar.result && /Reanudando/.test(reanudar.result), 'reanudar responde ok');
  assert(
    resumed && /Objetivo: Implementar el módulo de pagos/.test(resumed),
    'prompt incluye el objetivo'
  );
  assert(resumed && /diseñar schema/.test(resumed), 'prompt incluye los pasos pendientes');

  // Sin id → reanuda la más reciente (tope del stack).
  let resumedTop = null;
  await execute('/reanudar-tarea', {
    ipcRenderer: ipc,
    processMessage: (msg) => {
      resumedTop = msg;
    },
  });
  assert(resumedTop && /módulo de pagos/.test(resumedTop), 'sin id reanuda la más reciente');

  // Sin intenciones → mensaje claro.
  const empty = await execute('/estado', { ipcRenderer: { invoke: async () => [] } });
  assert(empty && /No hay tareas en vuelo/.test(empty.result), 'estado sin tareas da aviso claro');
  const emptyResume = await execute('/reanudar-tarea', {
    ipcRenderer: { invoke: async () => [] },
    processMessage: () => {},
  });
  assert(
    emptyResume && /No hay tareas pendientes/.test(emptyResume.result),
    'reanudar sin tareas avisa'
  );
}

// ── Mock bridge (mismo patrón que test_agent_loop.js) ─────────────────────────

function createMockBridge(projectCwd) {
  return {
    execute: async (tool, params) => {
      const t0 = Date.now();
      try {
        switch (tool) {
          case 'read': {
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
            return { ok: true, result: content, error: null, tool, elapsed: Date.now() - t0 };
          }
          case 'write':
          case 'create_file': {
            const p = params.path;
            const dir = path.dirname(p);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(p, params.content || '', 'utf-8');
            return {
              ok: true,
              result: `Written to ${p}`,
              error: null,
              tool,
              elapsed: Date.now() - t0,
            };
          }
          case 'exec':
          case 'run_command': {
            const cmd = params.command || '';
            return {
              ok: true,
              result: { stdout: `[mock] ${cmd} ejecutado`, stderr: '', exitCode: 0 },
              error: null,
              tool,
              elapsed: Date.now() - t0,
            };
          }
          case 'edit':
          case 'edit_file': {
            const p = params.path;
            const content = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
            const oldText = params.old_text || params.instruction || '';
            const newText = params.new_text || '';
            if (oldText && content.includes(oldText)) {
              fs.writeFileSync(p, content.replace(oldText, newText), 'utf-8');
            }
            return { ok: true, result: `Edited ${p}`, error: null, tool, elapsed: Date.now() - t0 };
          }
          default:
            return {
              ok: true,
              result: `[mock] ${tool} ejecutado`,
              error: null,
              tool,
              elapsed: Date.now() - t0,
            };
        }
      } catch (e) {
        return { ok: false, error: e.message, result: null, tool, elapsed: Date.now() - t0 };
      }
    },
  };
}

// ── Runner ────────────────────────────────────────────────────────────────────

async function main() {
  await testWriteAppendMode();
  await testReadCache();
  await testReadCacheInvalidation();
  await testExecCache();
  await testAdaptiveIterations();
  await testGitStashNoProgress();
  await testOnPlanEmission();
  await testPlanAutoExecute();
  testCalibratedDifficulty();
  await testIntentionCommands();

  console.log(C.bold('\n════════════════════════════════════════════════════'));
  console.log(
    C.bold(
      `  Resultado: ${C.green(`${passed} passed`)}  ${C.red(`${failed} failed`)}  / ${passed + failed} total`
    )
  );
  console.log(C.bold('════════════════════════════════════════════════════'));
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(C.red(`  FALLO del runner: ${e.stack || e.message}`));
  process.exit(1);
});
