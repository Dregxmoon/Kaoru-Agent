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

// ── Test 1: parseRetryAfterMs ──────────────────────────────────────────────────

function testParseRetryAfter() {
  console.log(C.bold('\n── Test 1: parseRetryAfterMs parsea "try again in X" ───────────'));

  const { parseRetryAfterMs } = require('../core/llm/RequestQueue.js');
  assert(parseRetryAfterMs('Please retry in 3m20.5s') === 200500, '3m20.5s → 200500ms');
  assert(parseRetryAfterMs('Please try again in 0.05s') === 50, '0.05s → 50ms');
  assert(parseRetryAfterMs('try again in 12s') === 12000, '12s → 12000ms');
  assert(parseRetryAfterMs('error cualquiera') === 0, 'sin match → 0');
}

// ── Test 2: serialización (concurrency 1) ─────────────────────────────────────

async function testSerialization() {
  console.log(C.bold('\n── Test 2: concurrency 1 — nunca dos llamadas a la vez ──────────'));

  const { ProviderQueue } = require('../core/llm/RequestQueue.js');
  const q = new ProviderQueue();

  let running = 0;
  let maxRunning = 0;
  const order = [];
  const mk = (label, delay) => () =>
    new Promise((res) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      order.push(label);
      setTimeout(() => {
        running--;
        res(label);
      }, delay);
    });

  const [a, b] = await Promise.all([q.submit(mk('a', 20)), q.submit(mk('b', 5))]);
  assert(a === 'a' && b === 'b', 'ambas resuelven con su resultado');
  assert(
    maxRunning === 1,
    'nunca 2 llamadas simultáneas (concurrency 1)',
    `maxRunning: ${maxRunning}`
  );
  assert(order[0] === 'a' && order[1] === 'b', 'Orden de llegada', JSON.stringify(order));
  assert(
    q.stats.completed === 2 && q.stats.total === 2,
    'stats: completed/total',
    JSON.stringify(q.stats)
  );
}

// ── Test 3: prioridad ──────────────────────────────────────────────────────────

async function testPriority() {
  console.log(C.bold('\n── Test 3: mayor prioridad sale primero entre los en cola ───────'));

  const { ProviderQueue } = require('../core/llm/RequestQueue.js');
  const q = new ProviderQueue();
  const order = [];

  // Ocupar la cola con una tarea lenta, luego encolar 3 más.
  const gate = q.submit(
    () =>
      new Promise((res) =>
        setTimeout(() => {
          order.push('gate');
          res();
        }, 30)
      )
  );
  const low1 = q.submit(
    async () => {
      order.push('low1');
      return 1;
    },
    { priority: 0 }
  );
  const high = q.submit(
    async () => {
      order.push('high');
      return 2;
    },
    { priority: 10 }
  );
  const low2 = q.submit(
    async () => {
      order.push('low2');
      return 3;
    },
    { priority: 0 }
  );

  await Promise.all([gate, low1, high, low2]);
  assert(
    order.indexOf('high') < order.indexOf('low1'),
    'Alta prioridad sale antes que baja',
    JSON.stringify(order)
  );
  assert(order.indexOf('high') < order.indexOf('low2'), 'Alta prioridad sale antes que la 2ª baja');
  assert(order.indexOf('low1') < order.indexOf('low2'), 'Bajas mantienen orden de llegada');
}

// ── Test 4: cooldown por 429 ───────────────────────────────────────────────────

async function testCooldown() {
  console.log(C.bold('\n── Test 4: 429 → cooldown; la request en cola espera y corre ─────'));

  const { ProviderQueue } = require('../core/llm/RequestQueue.js');
  const q = new ProviderQueue();

  let ran2 = false;
  const t0 = Date.now();
  const p1 = q.submit(() => {
    throw new Error('Groq 429: Please try again in 0.05s');
  });
  const p2 = q.submit(async () => {
    ran2 = true;
    return 'ok';
  });

  let p1Err = null;
  try {
    await p1;
  } catch (e) {
    p1Err = e;
  }
  assert(p1Err && /429/.test(p1Err.message), 'La 1ª request falla con el 429');

  const res = await p2;
  const elapsed = Date.now() - t0;
  assert(ran2 && res === 'ok', 'La 2ª request espera el cooldown y corre después');
  assert(
    elapsed >= 45,
    `Esperó al menos el cooldown (elapsed ${elapsed}ms)`,
    `elapsed: ${elapsed}ms`
  );
  assert(q.stats.rateLimited === 1, 'rateLimited contado', JSON.stringify(q.stats));
  assert(q.cooldownRemainingMs === 0, 'Cooldown terminó');
}

// ── Test 5: presupuesto de espera (maxWaitMs) ─────────────────────────────────

async function testBudget() {
  console.log(C.bold('\n── Test 5: maxWaitMs corto → rechazo por cooldown sin esperar ─────'));

  const { ProviderQueue } = require('../core/llm/RequestQueue.js');
  const q = new ProviderQueue();

  q.submit(() => {
    throw new Error('429: Please try again in 0.3s');
  }).catch(() => {});

  const t0 = Date.now();
  let rejected = null;
  try {
    await q.submit(async () => 'x', { maxWaitMs: 50 });
  } catch (e) {
    rejected = e;
  }
  const elapsed = Date.now() - t0;
  assert(rejected, 'Se rechaza por exceder el presupuesto', rejected?.message || '');
  assert(
    elapsed < 200,
    `Rechazó sin esperar el cooldown completo (${elapsed}ms)`,
    `elapsed: ${elapsed}ms`
  );
  assert(
    q.stats.rateLimited >= 2,
    'rateLimited incluye el rechazo por presupuesto',
    JSON.stringify(q.stats)
  );
}

// ── Test 6: disable/enable ─────────────────────────────────────────────────────

async function testDisableEnable() {
  console.log(C.bold('\n── Test 6: disable congela, enable reanuda ───────────────────────'));

  const { ProviderQueue } = require('../core/llm/RequestQueue.js');
  const q = new ProviderQueue();
  q.disable();

  let ran = false;
  const p = q.submit(async () => {
    ran = true;
    return 'ok';
  });
  await sleep(30);
  assert(!ran, 'Con disable la tarea no corre');
  q.enable();
  const res = await p;
  assert(ran && res === 'ok', 'Tras enable corre y resuelve');
}

// ── Test 7: flush ──────────────────────────────────────────────────────────────

async function testFlush() {
  console.log(C.bold('\n── Test 7: flush espera a que la cola se vacíe ───────────────────'));

  const { ProviderQueue } = require('../core/llm/RequestQueue.js');
  const q = new ProviderQueue();
  q.submit(() => new Promise((r) => setTimeout(r, 20)));
  q.submit(() => new Promise((r) => setTimeout(r, 10)));
  await q.flush();
  assert(q.stats.pending === 0, 'Cola vacía tras flush', `pending: ${q.stats.pending}`);
  assert(q.stats.completed === 2, 'Ambas completaron', JSON.stringify(q.stats));
}

// ── Test 8: integración con LLMProvider (glue) ────────────────────────────────

async function testLLMProviderIntegration() {
  console.log(C.bold('\n── Test 8: LLMProvider enruta por la cola y expone stats ─────────'));

  const LLMProvider = require('../core/llm/LLMProvider.js');
  LLMProvider.configure({ llm: { queue: { enabled: true, concurrency: 1, maxWaitMs: 5000 } } });

  const res = await LLMProvider._debug_enqueueProviderCall('groq', async () => 'ok');
  assert(res === 'ok', 'El glue resuelve con el resultado de la tarea');

  const st = LLMProvider.getQueueStats();
  assert(
    st.groq && st.groq.completed === 1,
    'getQueueStats reporta la cola de groq',
    JSON.stringify(st)
  );

  // enabled:false → bypass total de la cola
  LLMProvider.configure({ llm: { queue: { enabled: false } } });
  const direct = await LLMProvider._debug_enqueueProviderCall('groq', async () => 'directo');
  assert(direct === 'directo', 'Con enabled:false no pasa por la cola');
  const after = LLMProvider.getQueueStats();
  assert(
    after.groq && after.groq.completed === 1,
    'El bypass no tocó las stats de la cola',
    JSON.stringify(after.groq)
  );
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
  console.log(C.bold(C.cyan('  Test Suite: Fase J — cola de requests con rate-limit')));
  console.log(C.bold(C.cyan('════════════════════════════════════════════════════════')));

  testParseRetryAfter();
  await testSerialization();
  await testPriority();
  await testCooldown();
  await testBudget();
  await testDisableEnable();
  await testFlush();
  await testLLMProviderIntegration();

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
