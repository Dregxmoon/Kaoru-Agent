'use strict';

// Aprobación de alto impacto con timeout (ipc/openclaw-handlers.js):
//   - el card se muestra con 'agent-approval-needed';
//   - si el usuario NO responde dentro de agent.approvalTimeoutMs, el main
//     envía 'agent-approval-expired' y la acción se deniega con
//     { approved: false, reason: 'timeout' };
//   - un clic tardío (después del timeout) no rompe nada ni cambia el
//     resultado;
//   - responder a tiempo cancela el timer (no se envía 'expired');
//   - el AgentLoop distingue timeout de denegación explícita y el cierre del
//     run refleja la acción no ejecutada.

const Module = require('module');
const { EventEmitter } = require('events');
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Mock de electron.ipcMain ─────────────────────────────────────────────────
// El módulo bajo prueba requiere 'electron' en top-level; interceptamos el
// require para inyectar un ipcMain falso con handle()/on()/removeListener().

const mockIpcMain = new EventEmitter();
mockIpcMain._handlers = new Map();
mockIpcMain.handle = (channel, fn) => mockIpcMain._handlers.set(channel, fn);
mockIpcMain.invokeHandler = (channel, event, ...args) => {
  const fn = mockIpcMain._handlers.get(channel);
  if (!fn) throw new Error(`sin handler para ${channel}`);
  return fn(event, ...args);
};
mockIpcMain.emitResponse = (channel, payload) => mockIpcMain.emit(channel, {}, payload);

const realLoad = Module._load;
Module._load = function (_request, _parent, _isMain) {
  if (_request === 'electron') return { ipcMain: mockIpcMain };
  return realLoad.apply(this, arguments);
};

// ── Contexto falso para register(ctx) ─────────────────────────────────────────
let capturedApproval = null;
const sendLog = [];

function makeCtx(approvalTimeoutMs, agentConfig = {}) {
  return {
    S: { chatWindow: { isDestroyed: () => false } },
    sendToChat: (channel, payload) => sendLog.push({ channel, payload }),
    loadEffectiveConfig: () => ({ agent: { approvalTimeoutMs, ...agentConfig } }),
    Core: {
      runAgent: async (_text, opts) => {
        capturedApproval = opts.onApprovalNeeded;
        return new Promise((resolve) => {
          const sig = opts.signal;
          if (sig && typeof sig.addEventListener === 'function') {
            sig.addEventListener('abort', () =>
              resolve({ response: 'cancelada', iterations: 0, toolResults: [] })
            );
          }
        });
      },
      isOpenClawAvailable: () => true,
      getOpenClawStatus: () => ({ available: true }),
    },
  };
}

const { register } = require('../ipc/openclaw-handlers.js');
const { addApproval, resetApprovals } = require('../core/security/SessionApprovals.js');
const AP = require('../core/planner/ActionParser.js');
const { AgentLoop } = require('../core/planner/AgentLoop.js');

// ── Mocks para el AgentLoop (texto → parser, sin tool-calling nativo) ────────
function createMockLLM(responses) {
  let callCount = 0;
  const fn = async () => {
    if (callCount >= responses.length) return 'Tarea completada.';
    return responses[callCount++];
  };
  return fn;
}

function createMockBridge() {
  return {
    execute: async (_tool, _params) => {
      throw new Error('bridge NO debería ejecutarse');
    },
  };
}

// ── Test 1: timeout → expired + click tardío no rompe nada ────────────────────

async function testTimeoutThenLateClick() {
  console.log(C.bold('\n── Test 1: timeout → expired, clic tardío no rompe nada ───────'));
  sendLog.length = 0;
  const ctx = makeCtx(60); // timeout corto para la prueba
  register(ctx);

  const runPromise = mockIpcMain.invokeHandler('agent-run', {}, { text: 'haz algo' });
  await new Promise((r) => setImmediate(r));
  assert(typeof capturedApproval === 'function', 'onApprovalNeeded quedó capturado');

  const approvalPromise = capturedApproval({
    tool: 'exec',
    params: { command: 'rm -rf /' },
  });
  await new Promise((r) => setImmediate(r));

  const needed = sendLog.find((x) => x.channel === 'agent-approval-needed');
  assert(needed, 'se envió agent-approval-needed');
  const actionId = needed.payload.actionId;
  assert(typeof actionId === 'string' && actionId.length > 0, 'actionId presente');

  await sleep(120); // sobrepasar el timeout de 60ms

  const expired = sendLog.find((x) => x.channel === 'agent-approval-expired');
  assert(expired, 'se envió agent-approval-expired tras el timeout');
  assert(
    expired && expired.payload.actionId === actionId,
    'el expired lleva el actionId correcto',
    JSON.stringify(expired && expired.payload)
  );

  // Click tardío: el listener ya no existe, no debe lanzar ni mutar el resultado.
  let threw = false;
  try {
    mockIpcMain.emitResponse('agent-approval-response', { id: actionId, approved: true });
  } catch (e) {
    threw = true;
  }
  assert(!threw, 'click tardío no genera error');

  const value = await approvalPromise;
  assert(
    value && value.approved === false && value.reason === 'timeout',
    'el promise resuelve {approved:false, reason:"timeout"} (no true)',
    JSON.stringify(value)
  );

  // El run sigue vivo: liberar el abort para no dejar el timer colgando.
  mockIpcMain.emit('agent-cancel');
  await runPromise.catch(() => {});
}

// ── Test 2: responder a tiempo cancela el timer (no hay expired) ──────────────

async function testEarlyResponseNoExpired() {
  console.log(C.bold('\n── Test 2: responder a tiempo → sin evento de expiración ──────'));
  sendLog.length = 0;
  const ctx = makeCtx(60);
  register(ctx);

  mockIpcMain.invokeHandler('agent-run', {}, { text: 'haz algo' }).catch(() => {});
  await new Promise((r) => setImmediate(r));

  const approvalPromise = capturedApproval({
    tool: 'exec',
    params: { command: 'git push --force' },
  });
  await new Promise((r) => setImmediate(r));
  const needed = sendLog.find((x) => x.channel === 'agent-approval-needed');
  assert(needed, 'se envió agent-approval-needed');
  const actionId = needed.payload.actionId;

  mockIpcMain.emitResponse('agent-approval-response', { id: actionId, approved: true });
  const value = await approvalPromise;
  assert(value === true, 'respuesta temprana → true');

  await sleep(120); // pasar el timeout
  const expired = sendLog.find((x) => x.channel === 'agent-approval-expired');
  assert(!expired, 'NO se envía agent-approval-expired si respondió a tiempo');

  mockIpcMain.emit('agent-cancel');
}

// ── Test 3: patrón "Siempre" se auto-aprueba sin card ni timer ────────────────

async function testAlwaysPatternSkipsCard() {
  console.log(C.bold('\n── Test 3: patrón "Siempre" → auto-aprobado sin card ──────────'));
  resetApprovals();
  addApproval('exec:rm -rf');
  sendLog.length = 0;
  const ctx = makeCtx(60);
  register(ctx);

  mockIpcMain.invokeHandler('agent-run', {}, { text: 'haz algo' }).catch(() => {});
  await new Promise((r) => setImmediate(r));

  const value = await capturedApproval({ tool: 'exec', params: { command: 'rm -rf /' } });
  assert(value === true, 'patrón "Siempre" → true');
  const needed = sendLog.find((x) => x.channel === 'agent-approval-needed');
  assert(!needed, 'no se muestra card');
  const expired = sendLog.find((x) => x.channel === 'agent-approval-expired');
  assert(!expired, 'no se envía expired');
  resetApprovals();
  mockIpcMain.emit('agent-cancel');
}

// ── Test 4: AgentLoop — timeout → el cierre refleja la acción NO ejecutada ────

async function testAgentLoopTimeoutNotice() {
  console.log(C.bold('\n── Test 4: AgentLoop — timeout reflejado en la respuesta final ──'));
  const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-expiry-loop-'));
  AP.setProjectCWD(projectCwd);
  try {
    const mockLLM = createMockLLM([
      `Voy a ejecutar.
\`\`\`action
ACCIÓN: run_command | COMANDO: rm -rf /
\`\`\``,
      `Tarea completada.`,
    ]);
    const loop = new AgentLoop({
      maxIterations: 5,
      llm: mockLLM,
      bridge: createMockBridge(),
    });
    const result = await loop.run('haz algo', 'Eres un asistente.', [], {
      onApprovalNeeded: async () => ({ approved: false, reason: 'timeout' }),
    });

    assert(result.toolResults.length === 0, 'la tool de alto impacto NO se ejecutó');
    assert(
      result.response.includes('Acción NO ejecutada'),
      'la respuesta final avisa que una acción NO se ejecutó',
      result.response
    );
    assert(
      result.response.includes('expiró') && result.response.includes('exec'),
      'menciona el timeout y la herramienta (exec)',
      result.response
    );
    assert(!result.response.includes('Todo listo'), 'el cierre no suena a "todo listo"');
  } finally {
    fs.rmSync(projectCwd, { recursive: true, force: true });
  }
}

// ── Test 5: AgentLoop — denegación explícita NO añade aviso de timeout ────────

async function testAgentLoopPlainDenyNoNotice() {
  console.log(C.bold('\n── Test 5: denegación explícita → sin aviso de expiración ──────'));
  const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-deny-loop-'));
  AP.setProjectCWD(projectCwd);
  try {
    const mockLLM = createMockLLM([
      `Voy a ejecutar.
\`\`\`action
ACCIÓN: run_command | COMANDO: rm -rf /
\`\`\``,
      `Tarea completada.`,
    ]);
    const loop = new AgentLoop({
      maxIterations: 5,
      llm: mockLLM,
      bridge: createMockBridge(),
    });
    const result = await loop.run('haz algo', 'Eres un asistente.', [], {
      onApprovalNeeded: async () => false,
    });

    assert(result.toolResults.length === 0, 'la tool NO se ejecutó');
    assert(
      !result.response.includes('Acción NO ejecutada'),
      'denegación explícita no dispara el aviso de expiración',
      result.response
    );
  } finally {
    fs.rmSync(projectCwd, { recursive: true, force: true });
  }
}

// ── Test 6: AgentLoop — objeto {approved:false} no se trata como aprobado ─────

async function testAgentLoopObjectDecisionNotApproved() {
  console.log(C.bold('\n── Test 6: objeto {approved:false} NO se considera aprobado ────'));
  const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-object-loop-'));
  AP.setProjectCWD(projectCwd);
  try {
    const mockLLM = createMockLLM([
      `Voy a ejecutar.
\`\`\`action
ACCIÓN: run_command | COMANDO: rm -rf /
\`\`\``,
      `Tarea completada.`,
    ]);
    const loop = new AgentLoop({
      maxIterations: 5,
      llm: mockLLM,
      bridge: createMockBridge(),
    });
    const result = await loop.run('haz algo', 'Eres un asistente.', [], {
      onApprovalNeeded: async () => ({ approved: false, reason: 'cancelada_por_usuario' }),
    });

    assert(result.toolResults.length === 0, 'la tool NO se ejecutó (objeto no es truthy-aprobado)');
  } finally {
    fs.rmSync(projectCwd, { recursive: true, force: true });
  }
}

// ── Test 7: agent.autoApprove → sin card, aprobado al instante ───────────────

async function testAutoApproveSkipsCard() {
  console.log(C.bold('\n── Test 7: agent.autoApprove → auto-aprobado sin card ──────────'));
  resetApprovals();
  sendLog.length = 0;
  const ctx = makeCtx(60, { autoApprove: true });
  register(ctx);

  mockIpcMain.invokeHandler('agent-run', {}, { text: 'haz algo' }).catch(() => {});
  await new Promise((r) => setImmediate(r));

  const value = await capturedApproval({ tool: 'exec', params: { command: 'rm -rf /' } });
  assert(value === true, 'autoApprove → true sin mostrar card');
  const needed = sendLog.find((x) => x.channel === 'agent-approval-needed');
  assert(!needed, 'no se envía agent-approval-needed');
  const expired = sendLog.find((x) => x.channel === 'agent-approval-expired');
  assert(!expired, 'no se envía agent-approval-expired');
  resetApprovals();
  mockIpcMain.emit('agent-cancel');
}

// ── Run ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
  console.log(C.bold(C.cyan('  Aprobación con timeout — Test Suite')));
  console.log(C.bold(C.cyan('════════════════════════════════════════════════════════')));

  try {
    await testTimeoutThenLateClick();
    await testEarlyResponseNoExpired();
    await testAlwaysPatternSkipsCard();
    await testAgentLoopTimeoutNotice();
    await testAgentLoopPlainDenyNoNotice();
    await testAgentLoopObjectDecisionNotApproved();
    await testAutoApproveSkipsCard();
  } finally {
    Module._load = realLoad;
  }

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
