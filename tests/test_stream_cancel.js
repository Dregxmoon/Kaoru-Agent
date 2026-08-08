'use strict';

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
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
const LLMProvider = require('../core/llm/LLMProvider.js');
const { AgentLoop } = require('../core/planner/AgentLoop.js');

// ── Mock SSE server: emite tokens con delay, luego un tool_call. ─────────────
function startSSEServer({ tokenDelayMs = 15, chunks = 3 }) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    let i = 0;
    // Emite tokens con delay real para que el abort a mitad de camino
    // realmente interrumpa el flujo (patrón de streaming en vivo).
    const timer = setInterval(() => {
      if (i >= chunks) return; // nunca manda [DONE]: el stream queda abierto
      const token = `hola-${i} `;
      i++;
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: token } }] })}\n\n`);
    }, tokenDelayMs);
    req.on('close', () => clearInterval(timer));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// ── Mock SSE server que SÍ termina con [DONE] (stream normal). ───────────────
function startDoneServer({ tokenDelayMs = 1, chunks = 3 }) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
    let i = 0;
    const timer = setInterval(() => {
      if (i < chunks) {
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: `tok-${i} ` } }] })}\n\n`
        );
        i++;
        return;
      }
      res.write('data: [DONE]\n\n');
      clearInterval(timer);
      res.end();
    }, tokenDelayMs);
    req.on('close', () => clearInterval(timer));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// ── Mock JSON server para post()/get(). ──────────────────────────────────────
function startJSONServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
    res.end(JSON.stringify({ data: [], ok: true }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
  console.log(C.bold(C.cyan('  Test Suite: Cancelación del stream LLM (AbortController)')));
  console.log(C.bold(C.cyan('════════════════════════════════════════════════════════')));

  // ── Test 1: postStream aborta y rechaza con AbortError ────────────────────
  const s1 = await startSSEServer({ chunks: 100, tokenDelayMs: 10 });
  const url = `http://127.0.0.1:${s1.address().port}/chat/completions`;
  const tokens = [];
  const abort = new AbortController();
  const p = LLMProvider._debug_postStream(
    url,
    {},
    { model: 'x', messages: [] },
    (t) => tokens.push(t),
    20_000,
    abort.signal
  );

  await wait(80); // dejar que lleguen ~8 tokens
  abort.abort();

  let caught = null;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  assert(caught && caught.code === 'ABORTED', 'postStream rechaza con AbortError al cancelar');
  assert(
    tokens.length > 0 && tokens.length < 50,
    `tokenes parciales recibidos antes de cancelar (${tokens.length})`
  );
  const preAbortCount = tokens.length;
  await wait(100); // si el abort funcionó, no deben llegar más tokens
  assert(
    tokens.length === preAbortCount,
    `el stream se detuvo al cancelar (quedó en ${preAbortCount})`
  );
  s1.close();

  // ── Test 2: abort previo (signal.aborted al inicio) ───────────────────────
  const s2 = await startSSEServer({});
  const url2 = `http://127.0.0.1:${s2.address().port}/chat/completions`;
  const abort2 = new AbortController();
  abort2.abort();
  let caught2 = null;
  try {
    await LLMProvider._debug_postStream(
      url2,
      {},
      { model: 'x', messages: [] },
      () => {},
      20_000,
      abort2.signal
    );
  } catch (e) {
    caught2 = e;
  }
  assert(caught2 && caught2.code === 'ABORTED', 'signal ya abortado → rechazo inmediato');
  s2.close();

  // ── Test 3: AgentLoop detecta cancelación entre iteraciones ──────────────
  // Loop con señal ya abortada → debe devolver { cancelled: true } sin llamar LLM.
  const loop = new AgentLoop({
    maxIterations: 5,
    bridge: { execute: async () => ({ ok: true, result: 'x' }) },
  });
  const abort3 = new AbortController();
  abort3.abort();
  const res = await loop.run('prueba', 'system', [], { signal: abort3.signal, onToken: () => {} });
  assert(res.cancelled === true, 'AgentLoop devuelve cancelled=true con señal abortada');
  assert(res.error === 'cancelled', 'error=cancelled');

  // ── Test 4: no fuga de listeners de abort en la señal compartida ─────────
  // El agent-run comparte un único AbortController para todas sus requests
  // (streaming, post y get, incluidos los reintentos). Cada request que
  // termina debe remover su listener de la señal; sin cleanup, N requests
  // dejan N listeners acumulados (fuga de memoria + MaxListenersExceeded).
  const { getEventListeners } = require('events');
  const signalFns = [
    {
      name: 'postStream',
      server: await startDoneServer({}),
      call: async (url, signal) =>
        LLMProvider._debug_postStream(
          url,
          {},
          { model: 'x', messages: [] },
          () => {},
          20_000,
          signal
        ),
    },
    {
      name: 'post',
      server: await startJSONServer(),
      call: async (url, signal) =>
        LLMProvider._debug_post(url, {}, { model: 'x', messages: [] }, 20_000, signal),
    },
    {
      name: 'get',
      server: await startJSONServer(),
      call: async (url, signal) => LLMProvider._debug_get(url, {}, 20_000, signal),
    },
  ];

  for (const { name, server, call } of signalFns) {
    const url = `http://127.0.0.1:${server.address().port}/chat/completions`;
    const shared = new AbortController();
    for (let i = 0; i < 25; i++) {
      const out = await call(url, shared.signal);
      assert(out !== undefined && out !== null, `${name} completó la request #${i + 1}`);
    }
    const leaked = getEventListeners(shared.signal, 'abort').length;
    assert(
      leaked === 0,
      `${name}: 0 listeners de abort tras 25 requests con la misma señal (leaked=${leaked})`
    );
    server.close();
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
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
