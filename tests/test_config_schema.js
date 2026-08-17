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
const { ConfigManager, SCHEMA, validateConfig } = require('../core/config/ConfigManager.js');

function makeTmpConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoru-cfg-'));
  return path.join(dir, 'config.json');
}

// ── Test 1: SCHEMA cubre las claves reales ─────────────────────────────────
function testSchemaShape() {
  console.log(C.bold('\n── Schema cubre claves reales ─────────────────────────'));

  for (const k of [
    'activeModel',
    'chatTheme',
    'autonomy',
    'llm',
    'sensors',
    'gestures',
    'mcp',
    'agent',
  ]) {
    assert(k in SCHEMA, `schema incluye "${k}"`);
  }
  assertEqual(
    SCHEMA.agent.schema.approvalTimeoutMs.default,
    120000,
    'agent.approvalTimeoutMs default 120000'
  );
  for (const k of ['primary', 'fallback', 'apiKeys', 'providers']) {
    assert(k in SCHEMA.llm.schema, `schema.llm incluye "${k}"`);
  }
}

// ── Test 2: defaults (archivo ausente) ─────────────────────────────────────
function testDefaults() {
  console.log(C.bold('\n── Defaults ───────────────────────────────────────────'));

  const mgr = new ConfigManager(null, { verbose: false });
  const cfg = mgr.load();
  assertEqual(cfg.autonomy, 'suggest', 'autonomy default "suggest"');
  assertEqual(cfg.activeModel, 'March 7th', 'activeModel default "March 7th"');
  assertEqual(cfg.chatTheme, 'dark', 'chatTheme default "dark"');
  assertEqual(cfg.llm.primary, 'groq', 'llm.primary default "groq"');
  assertEqual(cfg.sensors.git, true, 'sensors.git default true');
  assertEqual(cfg.gestures.cooldownMs, 15000, 'gestures.cooldownMs default');
  assert(Array.isArray(cfg.mcp.servers), 'mcp.servers default []');
  assert(mgr.report && mgr.report.ok, 'report ok sin archivo');

  const mgr2 = new ConfigManager(makeTmpConfig(), { verbose: false });
  const cfg2 = mgr2.load();
  assertEqual(cfg2.autonomy, 'suggest', 'archivo inexistente → defaults');
  assert(
    mgr2.report && mgr2.report.warnings.some((w) => w.includes('no existe')),
    'warning de archivo inexistente'
  );
}

// ── Test 3: archivo corrupto ───────────────────────────────────────────────
function testCorruptFile() {
  console.log(C.bold('\n── Archivo corrupto ────────────────────────────────────'));

  const fp = makeTmpConfig();
  fs.writeFileSync(fp, '{ not valid json', 'utf-8');
  const mgr = new ConfigManager(fp, { verbose: false });
  const cfg = mgr.load();
  assertEqual(cfg.autonomy, 'suggest', 'corrupto → defaults');
  assert(mgr.report && !mgr.report.ok, 'report marca error');
  assert(
    mgr.report && mgr.report.errors.some((e) => e.includes('corrupto')),
    'error describe archivo corrupto'
  );
}

// ── Test 4: tipos inválidos → default + error ──────────────────────────────
function testTypeValidation() {
  console.log(C.bold('\n── Validación de tipos ────────────────────────────────'));

  const fp = makeTmpConfig();
  fs.writeFileSync(
    fp,
    JSON.stringify({
      autonomy: 123,
      llm: { primary: 5, fallback: 'nope' },
      gestures: { cooldownMs: 'x' },
    }),
    'utf-8'
  );
  const mgr = new ConfigManager(fp, { verbose: false });
  const cfg = mgr.load();

  assertEqual(cfg.autonomy, 'suggest', 'autonomy numérico → default');
  assertEqual(cfg.llm.primary, 'groq', 'llm.primary numérico → default');
  assertEqual(cfg.gestures.cooldownMs, 15000, 'gestures.cooldownMs string → default');
  assert(mgr.report && mgr.report.errors.length >= 3, 'report acumula 3+ errores');
  const joined = (mgr.report && mgr.report.errors.join(' ')) || '';
  assert(joined.includes('autonomy'), 'error menciona autonomy');
}

// ── Test 5: enum y arrays ──────────────────────────────────────────────────
function testEnumAndArrays() {
  console.log(C.bold('\n── Enum y arrays ──────────────────────────────────────'));

  const fp = makeTmpConfig();
  fs.writeFileSync(
    fp,
    JSON.stringify({
      autonomy: 'volador',
      llm: { fallback: ['gemini', 42, null, 'openai', {}] },
    }),
    'utf-8'
  );
  const mgr = new ConfigManager(fp, { verbose: false });
  const cfg = mgr.load();

  assertEqual(cfg.autonomy, 'suggest', 'autonomy fuera de enum → default');
  assert(
    mgr.report && mgr.report.errors.some((e) => e.includes('no es válido')),
    'error de enum registrado'
  );
  assertEqual(cfg.llm.fallback.length, 2, 'fallback filtra no-strings');
  assertEqual(cfg.llm.fallback[0], 'gemini', 'fallback conserva strings');
  assertEqual(cfg.llm.fallback[1], 'openai', 'fallback conserva strings (2)');
}

// ── Test 6: claves desconocidas se conservan + warning ─────────────────────
function testUnknownKeys() {
  console.log(C.bold('\n── Claves desconocidas ────────────────────────────────'));

  const fp = makeTmpConfig();
  fs.writeFileSync(
    fp,
    JSON.stringify({ claveFutura: { x: 1 }, llm: { futureOption: true } }),
    'utf-8'
  );
  const mgr = new ConfigManager(fp, { verbose: false });
  const cfg = mgr.load();

  assertEqual(
    JSON.stringify(cfg.claveFutura),
    JSON.stringify({ x: 1 }),
    'top-level desconocida conservada'
  );
  assertEqual(cfg.llm.futureOption, true, 'anidada desconocida conservada');
  assert(
    mgr.report && mgr.report.warnings.some((w) => w.includes('claveFutura')),
    'warning para top-level desconocida'
  );
}

// ── Test 7: get() con path punteado ────────────────────────────────────────
function testGet() {
  console.log(C.bold('\n── get() por path ─────────────────────────────────────'));

  const mgr = new ConfigManager(null, { verbose: false });
  assertEqual(mgr.get('llm.primary'), 'groq', 'get llm.primary');
  assertEqual(mgr.get('mcp.servers.length'), 0, 'get mcp.servers.length');
  assertEqual(mgr.get('no.existe', 'fallback'), 'fallback', 'get con fallback');
}

// ── Test 8: save() persiste y reload() relee ───────────────────────────────
function testSaveReload() {
  console.log(C.bold('\n── save/reload ────────────────────────────────────────'));

  const fp = makeTmpConfig();
  const mgr = new ConfigManager(fp, { verbose: false });
  mgr.load();
  const res = mgr.save({ autonomy: 'act', llm: { primary: 'openai' } });
  assert(res.ok, 'save devuelve ok');

  const onDisk = JSON.parse(fs.readFileSync(fp, 'utf-8'));
  assertEqual(onDisk.autonomy, 'act', 'disco: autonomy persistido');
  assertEqual(onDisk.llm.primary, 'openai', 'disco: llm.primary persistido');
  assertEqual(onDisk.llm.fallback[0], 'gemini', 'disco: defaults de fallback conservados');

  const fresh = new ConfigManager(fp, { verbose: false });
  assertEqual(fresh.load().autonomy, 'act', 'relectura desde disco refleja el cambio');
}

// ── Test 8b: persistencia de llm.customProviders / queue / remoteCatalog ─────
function testLLMCatalogPersistence() {
  console.log(C.bold('\n── llm customProviders/queue/remoteCatalog ─────────────────'));

  const fp = makeTmpConfig();
  const mgr = new ConfigManager(fp, { verbose: false });
  mgr.load();
  const res = mgr.save({
    llm: {
      primary: 'groq',
      customProviders: [{ id: 'mi-proxy', name: 'Mi Proxy', baseURL: 'http://localhost:8080/v1' }],
      queue: { enabled: false, concurrency: 2 },
      remoteCatalog: { enabled: false },
    },
  });
  assert(res.ok, 'save con customProviders/queue/remoteCatalog ok');

  const fresh = new ConfigManager(fp, { verbose: false });
  const cfg = fresh.load();
  assert(
    Array.isArray(cfg.llm.customProviders) && cfg.llm.customProviders.length === 1,
    'customProviders persiste',
    JSON.stringify(cfg.llm.customProviders)
  );
  assert(
    cfg.llm.customProviders[0].id === 'mi-proxy' &&
      cfg.llm.customProviders[0].baseURL.includes('8080'),
    'contenido de customProviders intacto'
  );
  assert(
    cfg.llm.queue && cfg.llm.queue.enabled === false && cfg.llm.queue.concurrency === 2,
    'queue persiste con valores',
    JSON.stringify(cfg.llm.queue)
  );
  assert(
    cfg.llm.remoteCatalog && cfg.llm.remoteCatalog.enabled === false,
    'remoteCatalog persiste con valores'
  );
}

// ── Test 9: load() devuelve clon (mutación no envenena cache) ──────────────
function testCloneIsolation() {
  console.log(C.bold('\n── Aislamiento del clon ───────────────────────────────'));

  const mgr = new ConfigManager(null, { verbose: false });
  const a = mgr.load();
  a.llm.primary = 'hacked';
  a.autonomy = 'act';
  const b = mgr.load();
  assertEqual(b.llm.primary, 'groq', 'segundo load no refleja mutación del primero');
  assertEqual(b.autonomy, 'suggest', 'autonomy aislado');
}

// ── Test 10: validateConfig puro ───────────────────────────────────────────
function testValidatePure() {
  console.log(C.bold('\n── validateConfig ─────────────────────────────────────'));

  const good = validateConfig({ autonomy: 'observe' });
  assert(good.ok, 'config válida → ok');
  assertEqual(good.normalized.autonomy, 'observe', 'valor válido conservado');

  const bad = validateConfig({ autonomy: 'zzz' });
  assert(!bad.ok, 'config inválida → !ok');
  assertEqual(bad.normalized.autonomy, 'suggest', 'inválida → default');

  assert(!validateConfig('string').ok, 'no-objeto → !ok');
}

// ── Run ─────────────────────────────────────────────────────────────────────

console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
console.log(C.bold(C.cyan('  Kaoru — Test Suite: Config con Schema')));
console.log(C.bold(C.cyan('════════════════════════════════════════════════════════')));

function main() {
  testSchemaShape();
  testDefaults();
  testCorruptFile();
  testTypeValidation();
  testEnumAndArrays();
  testUnknownKeys();
  testGet();
  testSaveReload();
  testLLMCatalogPersistence();
  testCloneIsolation();
  testValidatePure();

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
