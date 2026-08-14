'use strict';

/**
 * E2E streaming + cancelación IPC:
 * Verifica el flujo completo agente → LLM stream → cancelación, con un
 * provider HTTP mock local (SSE). Cubre:
 *   1. completeWithTools recibe tokens en vivo y tool_calls del SSE.
 *   2. Un abort a mitad del stream hace que completeWithTools lance
 *      AbortError y que AgentLoop devuelva { cancelled: true }.
 *   3. La cancelación es inmediata: no espera el [DONE] del server.
 */

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
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

const http = require('http');
const LLMProvider = require('../../core/llm/LLMProvider.js');
const { AgentLoop } = require('../../core/planner/AgentLoop.js');

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Server SSE que emite tokens con delay y termina con tool_call + [DONE].
function startStreamServer({ emitToolCall = true, tokenCount = 3, tokenDelayMs = 15 }) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    let i = 0;
    const tokens = Array.from({ length: tokenCount }, (_, k) => `token${k}`);
    const timer = setInterval(() => {
      if (i >= tokens.length) {
        clearInterval(timer);
        if (emitToolCall) {
          res.write(
            `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"path":"x.js"}' } }] } }] })}\n\n`
          );
        }
        res.write(`data: [DONE]\n\n`);
        res.end();
        return;
      }
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: tokens[i] + ' ' } }] })}\n\n`
      );
      i++;
    }, tokenDelayMs);
    req.on('close', () => clearInterval(timer));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// ── Test 1: completeWithTools recibe tokens en vivo y tool_call del SSE ─────
async function testStreamTokensAndToolCalls() {
  console.log(C.bold('\n── completeWithTools: tokens en vivo + tool_call SSE ─────'));

  const s = await startStreamServer({ emitToolCall: true });
  const baseURL = `http://127.0.0.1:${s.address().port}`;

  // Registrar un provider openai temporal apuntando al mock
  LLMProvider.registerProvider({
    id: 'mock-stream',
    name: 'Mock Stream',
    type: 'openai',
    baseURL,
    models: { smart: 'mock-smart', fast: 'mock-fast' },
    free: true,
  });
  LLMProvider.configure({
    llm: { primary: 'mock-stream', apiKeys: { 'mock-stream': 'fake-key' } },
  });

  const tokens = [];
  const res = await LLMProvider.completeWithTools(
    [{ role: 'user', content: 'hola' }],
    'system',
    [
      {
        name: 'read_file',
        description: 'lee',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ],
    'fast',
    { onToken: (t) => tokens.push(t) }
  );

  assert(
    tokens.join('') === 'token0 token1 token2 ',
    `onToken recibió todos los tokens (${tokens.length})`
  );
  assert(
    Array.isArray(res.toolCalls) && res.toolCalls.length === 1,
    'tool_call del SSE normalizado'
  );
  assert(res.toolCalls[0].tool === 'read_file', 'tool_call con nombre correcto');

  LLMProvider.configure({ llm: { primary: null } });
  s.close();
}

// ── Test 2: cancelación a mitad de stream ───────────────────────────────────
async function testCancelMidStream() {
  console.log(C.bold('\n── Cancelación a mitad del stream ─────────────────────────'));

  const s = await startStreamServer({ emitToolCall: false, tokenCount: 100, tokenDelayMs: 15 });
  const baseURL = `http://127.0.0.1:${s.address().port}`;

  LLMProvider.registerProvider({
    id: 'mock-cancel',
    name: 'Mock Cancel',
    type: 'openai',
    baseURL,
    models: { smart: 'mock-smart', fast: 'mock-fast' },
    free: true,
  });
  LLMProvider.configure({
    llm: { primary: 'mock-cancel', apiKeys: { 'mock-cancel': 'fake-key' } },
  });

  const abort = new AbortController();
  const tokens = [];

  const p = LLMProvider.completeWithTools(
    [{ role: 'user', content: 'hola' }],
    'system',
    [{ name: 'read_file', description: 'lee', inputSchema: { type: 'object', properties: {} } }],
    'fast',
    { onToken: (t) => tokens.push(t), signal: abort.signal }
  );

  await wait(50);
  abort.abort();

  let caught = null;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  assert(caught && caught.code === 'ABORTED', 'completeWithTools lanza AbortError al cancelar');
  assert(tokens.length < 100, `el stream se cortó antes de terminar (${tokens.length}/100 tokens)`);

  LLMProvider.configure({ llm: { primary: null } });
  s.close();
}

// ── Test 3: AgentLoop con signal → cancelled ────────────────────────────────
async function testAgentLoopCancellation() {
  console.log(C.bold('\n── AgentLoop: señal cancelada devuelve cancelled=true ─────'));

  const loop = new AgentLoop({
    maxIterations: 5,
    bridge: { execute: async () => ({ ok: true, result: 'x', tool: 'x' }) },
  });
  const abort = new AbortController();
  abort.abort();
  const res = await loop.run('prueba', 'sys', [], { signal: abort.signal });
  assert(res.cancelled === true && res.error === 'cancelled', 'cancelled=true, error=cancelled');
}

// ── Run ─────────────────────────────────────────────────────────────────────

console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
console.log(C.bold(C.cyan('  E2E: Streaming LLM + cancelación (mock HTTP)')));
console.log(C.bold(C.cyan('════════════════════════════════════════════════════════')));

(async () => {
  try {
    await testStreamTokensAndToolCalls();
    await testCancelMidStream();
    await testAgentLoopCancellation();
  } catch (e) {
    console.error(C.red('ERROR FATAL:'), e.message);
    process.exit(1);
  }

  console.log(C.bold('\n════════════════════════════════════════════════════════'));
  const total = passed + failed;
  if (failed === 0) {
    console.log(
      `  ${C.green('Resultado')}: ${C.green(`${passed} passed`)}  ${C.dim(`0 failed`)}  / ${total} total`
    );
  } else {
    console.log(
      `  Resultado: ${C.green(`${passed} passed`)}  ${C.red(`${failed} failed`)}  / ${total} total`
    );
  }
  console.log(C.bold('════════════════════════════════════════════════════════'));

  if (failed > 0) process.exit(1);
})();
