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

const fs = require('fs');
const os = require('os');
const path = require('path');
const { UsageTracker, PRICING } = require('../core/observability/UsageTracker.js');
const { Logger, LEVELS } = require('../core/observability/Logger.js');

// ── Test 1: UsageTracker record/getSummary ──────────────────────────────────
function testRecordSummary() {
  console.log(C.bold('\n── UsageTracker: record + getSummary ─────────────────'));

  const t = new UsageTracker(null, { verbose: false });
  t.record({
    provider: 'groq',
    model: 'llama-8b',
    promptTokens: 1000,
    completionTokens: 500,
    latencyMs: 123,
  });
  t.record({
    provider: 'openai',
    model: 'gpt-4o-mini',
    promptTokens: 2000,
    completionTokens: 1000,
    latencyMs: 200,
  });
  t.record({
    provider: 'groq',
    model: 'llama-8b',
    promptTokens: 10,
    completionTokens: 20,
    latencyMs: 5,
  });

  const s = t.getSummary();
  assertEqual(s.totalRequests, 3, 'totalRequests = 3');
  assertEqual(s.totalPromptTokens, 3010, 'totalPromptTokens');
  assertEqual(s.totalCompletionTokens, 1520, 'totalCompletionTokens');
  assertEqual(s.totalTokens, 4530, 'totalTokens');
  assert(s.totalCostUsd > 0, 'coste estimado > 0');
  assertEqual(s.byProvider.groq.requests, 2, 'byProvider.groq.requests = 2');
  assertEqual(s.byProvider.openai.tokens, 3000, 'byProvider.openai.tokens');

  const costForGroq =
    ((1000 + 10) / 1000) * PRICING.groq.input + ((500 + 20) / 1000) * PRICING.groq.output;
  assertEqual(
    s.byProvider.groq.costUsd.toFixed(4),
    costForGroq.toFixed(4),
    'coste groq coincide con precio'
  );
}

// ── Test 2: persistencia a JSONL y relectura ────────────────────────────────
function testPersistence() {
  console.log(C.bold('\n── UsageTracker: persistencia ─────────────────────────'));

  const fp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'usage-')), 'usage.jsonl');
  const t = new UsageTracker(fp, { verbose: false });
  t.record({
    provider: 'deepseek',
    model: 'chat',
    promptTokens: 100,
    completionTokens: 50,
    latencyMs: 10,
  });

  const fresh = new UsageTracker(fp, { verbose: false });
  const s = fresh.getSummary();
  assertEqual(s.totalRequests, 1, 'relectura desde disco: 1 request');
  assertEqual(s.totalTokens, 150, 'relectura: tokens');

  fresh.reset();
  assertEqual(fresh.getSummary().totalRequests, 0, 'reset → 0');
  assertEqual(fs.readFileSync(fp, 'utf-8'), '', 'reset vacía el archivo');
}

// ── Test 3: archivo corrupto no rompe ───────────────────────────────────────
function testCorruptFile() {
  console.log(C.bold('\n── UsageTracker: archivo corrupto ─────────────────────'));

  const fp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'usage-')), 'usage.jsonl');
  fs.writeFileSync(
    fp,
    'garbage\n{mal\n{"ts": "2026-01-01T00:00:00.000Z", "provider": "groq", "model": "m", "mode": "fast", "promptTokens": 1, "completionTokens": 1, "costUsd": 0, "costEstimated": false, "latencyMs": 1, "stream": false, "error": false}\n',
    'utf-8'
  );
  const t = new UsageTracker(fp, { verbose: false });
  const s = t.getSummary();
  assertEqual(s.totalRequests, 1, 'solo la línea válida se cuenta');
}

// ── Test 4: Logger niveles y quiet ──────────────────────────────────────────
function testLoggerLevels() {
  console.log(C.bold('\n── Logger: niveles y quiet ────────────────────────────'));

  const logger = new Logger({ level: LEVELS.info });
  assertEqual(logger._level, LEVELS.info, 'nivel inicial info');
  logger.setLevel(LEVELS.error);
  assertEqual(logger._level, LEVELS.error, 'setLevel(error)');
  logger.setQuiet(true);
  assert(logger._quiet, 'setQuiet(true)');

  // capture de stdout para no ensuciar el test
  const log = new Logger({ level: LEVELS.debug });
  let seen = '';
  const origLog = console.log;
  const origDebug = console.debug;
  const origError = console.error;
  console.log = (s) => (seen += s + '\n');
  console.debug = (s) => (seen += s + '\n');
  console.error = (s) => (seen += s + '\n');
  try {
    log.debug('t', 'msg debug');
    log.info('t', 'msg info');
    log.warn('t', 'msg warn');
    log.error('t', 'msg error');
  } finally {
    console.log = origLog;
    console.debug = origDebug;
    console.error = origError;
  }
  assert(seen.includes('DEBUG'), 'debug se escribe');
  assert(seen.includes('INFO'), 'info se escribe');
  assert(seen.includes('WARN'), 'warn se escribe');
  assert(seen.includes('ERROR'), 'error se escribe');
  assert(seen.includes('[t]'), 'scope incluido en la línea');
}

// ── Test 5: Logger transporte a archivo + rotación ──────────────────────────
function testLoggerFile() {
  console.log(C.bold('\n── Logger: archivo y rotación ─────────────────────────'));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-'));
  const fp = path.join(dir, 'app.log');
  const logger = new Logger({ level: LEVELS.info });
  logger.attachFile(fp, 1000);
  logger.info('core', 'hola mundo');
  logger.warn('planner', 'cuidado', { n: 1 });
  logger.error('llm', 'fallo');

  const content = fs.readFileSync(fp, 'utf-8');
  assert(content.includes('hola mundo'), 'archivo contiene mensaje info');
  assert(content.includes('WARN'), 'archivo contiene nivel warn');
  assert(content.includes('"n":1'), 'archivo contiene datos extra');

  // rotación: forzar rebase con línea grande
  logger.attachFile(fp, 50);
  logger.info('core', 'X'.repeat(500));
  const rotatedExists = fs.existsSync(fp + '.1');
  assert(rotatedExists, 'rotación crea <archivo>.1');
}

// ── Test 6: LLMProvider._recordUsage extrae usage de ambos formatos ─────────
function testRecordUsageExtraction() {
  console.log(C.bold('\n── LLMProvider._recordUsage: extracción ───────────────'));

  const LLM = require('../core/llm/LLMProvider.js');
  const t = new UsageTracker(null, { verbose: false });
  LLM.setUsageTracker(t);

  const def = { name: 'Groq' };

  LLM._debug_recordUsage(
    'groq',
    def,
    'llama-8b',
    'fast',
    { usage: { prompt_tokens: 111, completion_tokens: 222 } },
    {},
    0
  );
  LLM._debug_recordUsage(
    'gemini',
    { name: 'Google Gemini' },
    'gemini-flash',
    'smart',
    { usageMetadata: { promptTokenCount: 333, candidatesTokenCount: 444 } },
    { onToken: true },
    0
  );
  LLM._debug_recordUsage('openai', { name: 'OpenAI' }, 'gpt', 'fast', {}, {}, 0);

  const s = t.getSummary();
  assertEqual(s.totalRequests, 3, '3 eventos registrados');
  assertEqual(s.totalPromptTokens, 444, 'prompt tokens de ambos formatos');
  assertEqual(s.totalCompletionTokens, 666, 'completion tokens de ambos formatos');
  const streamEv = t.recent(10).find((e) => e.stream);
  assert(streamEv, 'evento marca stream=true');
}

// ── Run ─────────────────────────────────────────────────────────────────────

console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
console.log(C.bold(C.cyan('  Kaoru — Test Suite: Observabilidad (logger + usage)')));
console.log(C.bold(C.cyan('════════════════════════════════════════════════════════')));

function main() {
  testRecordSummary();
  testPersistence();
  testCorruptFile();
  testLoggerLevels();
  testLoggerFile();
  testRecordUsageExtraction();

  console.log(C.bold('\n════════════════════════════════════════════════════════'));
  const total = passed + failed + skipped;
  const skipNote = skipped > 0 ? `  ${C.yellow(`${skipped} skipped`)}` : '';
  if (failed === 0) {
    console.log(
      `  ${C.green('Resultado')}: ${C.green(`${passed} passed`)}  ${C.dim(`0 failed`)}${skipNote}  / ${total} total`
    );
  } else {
    console.log(
      `  Resultado: ${C.green(`${passed} passed`)}  ${C.red(`${failed} failed`)}${skipNote}  / ${total} total`
    );
  }
  console.log(C.bold('════════════════════════════════════════════════════════'));

  if (failed > 0) process.exit(1);
}

main();
