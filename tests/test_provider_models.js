'use strict';

// @ts-check

// Tests de la Fase Q: catálogo de modelos por proveedor + resolución del
// modelo elegido por el usuario (providers[id].model.{fast,smart}) y el
// selector /model. Cubre:
//   1. Cada built-in provider expone un catálogo no vacío.
//   2. getAvailableProviders() devuelve catalog + activeModel.
//   3. listModels() devuelve el catálogo (y el modelo activo si es custom).
//   4. configure() con providers[id].model override → _resolveModel lo usa.
//   5. El override gana sobre el modelo por defecto del provider.
//   6. refreshProviderModels() con proveedor no-openai no revienta y cae al
//      catálogo estático.

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

const LLMProvider = require('../core/llm/LLMProvider.js');

// ── Test 1: catálogos de los built-in providers ───────────────────────────────

function testCatalogs() {
  console.log(C.bold('\n── Test 1: Catálogos estáticos por proveedor ─────────────────'));

  const providers = LLMProvider.getAvailableProviders();
  const builtin = providers.filter((p) => p.builtin);
  assert(builtin.length >= 8, `mínimo 8 providers built-in`, `actual: ${builtin.length}`);

  for (const p of builtin) {
    assert(
      Array.isArray(p.catalog) && p.catalog.length >= 2,
      `${p.id} expone catálogo con ≥2 modelos (${p.catalog.length})`
    );
  }

  // El catálogo contiene los modelos por defecto fast/smart
  for (const p of builtin) {
    for (const m of Object.values(p.models || {})) {
      assert(p.catalog.includes(m), `${p.id}: modelo por defecto "${m}" está en el catálogo`);
    }
  }
}

// ── Test 2: activeModel refleja el override ───────────────────────────────────

function testActiveModel() {
  console.log(C.bold('\n── Test 2: activeModel con override por usuario ───────────────'));

  // Sin override → el default del provider
  LLMProvider.configure({ llm: { primary: 'groq' } });
  let p = LLMProvider.getAvailableProviders().find((x) => x.id === 'groq');
  assert(p.activeModel.fast === 'llama-3.1-8b-instant', 'groq fast = default');
  assert(p.activeModel.smart === 'llama-3.3-70b-versatile', 'groq smart = default');

  // Con override → gana el elegido por el usuario
  LLMProvider.configure({
    llm: { providers: { groq: { model: { fast: 'llama-3.3-70b-versatile' } } } },
  });
  p = LLMProvider.getAvailableProviders().find((x) => x.id === 'groq');
  assert(p.activeModel.fast === 'llama-3.3-70b-versatile', 'groq fast = override del usuario');
  assert(p.activeModel.smart === 'llama-3.3-70b-versatile', 'groq smart = default (sin override)');

  // _resolveModel interno coincide con el override
  const resolved = LLMProvider._debug_resolveModel('groq', 'fast');
  assert(resolved === 'llama-3.3-70b-versatile', '_resolveModel respeta el override');
}

// ── Test 3: listModels ────────────────────────────────────────────────────────

function testListModels() {
  console.log(C.bold('\n── Test 3: listModels() ──────────────────────────────────────'));

  // Sin catálogo refrescado → el estático
  LLMProvider.configure({ llm: {} });
  const groqModels = LLMProvider.listModels('groq');
  assert(Array.isArray(groqModels) && groqModels.length >= 2, 'groq lista ≥2 modelos');
  assert(groqModels.includes('llama-3.1-8b-instant'), 'groq incluye el modelo por defecto');

  // Proveedor inexistente → []
  assert(LLMProvider.listModels('no-existe').length === 0, 'provider inexistente → []');

  // Un modelo custom elegido por usuario que NO está en el catálogo se agrega
  LLMProvider.configure({
    llm: { providers: { groq: { model: { smart: 'mi-modelo-custom-v2' } } } },
  });
  const withCustom = LLMProvider.listModels('groq');
  assert(
    withCustom.includes('mi-modelo-custom-v2'),
    'el modelo custom del usuario aparece en listModels'
  );
}

// ── Test 4: refreshProviderModels ─────────────────────────────────────────────

async function testRefresh() {
  console.log(C.bold('\n── Test 4: refreshProviderModels() ───────────────────────────'));

  // Provider sin key ni endpoint: no revienta, devuelve catálogo estático
  LLMProvider.configure({ llm: { providers: { anthropic: { model: { fast: 'x' } } } } });
  const before = LLMProvider.listModels('anthropic');
  const after = await LLMProvider.refreshProviderModels('anthropic');
  assert(Array.isArray(after) && after.length > 0, 'anthropic (no-openai) devuelve catálogo');
  assert(after.length === before.length, 'sin key/endpoint conserva el catálogo estático');

  // Provider openai sin key: no revienta, cae al estático. Usamos un custom
  // sin key para no depender del keychain del sistema (que sí puede tener la
  // key de nvidia real — contaminación silenciosa del llavero).
  LLMProvider.addCustomProvider({
    id: 'test-no-key',
    name: 'Test Sin Key',
    type: 'openai',
    baseURL: 'https://example.invalid/v1',
    models: { fast: 'test-fast', smart: 'test-smart' },
    catalog: ['test-fast', 'test-smart', 'test-extra'],
  });
  const beforeOpen = LLMProvider.listModels('test-no-key');
  const afterOpen = await LLMProvider.refreshProviderModels('test-no-key');
  assert(Array.isArray(afterOpen) && afterOpen.length > 0, 'openai sin key devuelve catálogo');
  assert(afterOpen.length === beforeOpen.length, 'sin key conserva el catálogo estático');
  assert(afterOpen.includes('test-extra'), 'catálogo estático custom intacto');
}

// ── Test 5: configure() no pierde el modelo al guardar ────────────────────────

function testConfigureMerge() {
  console.log(C.bold('\n── Test 5: configure() conserva model en providers ─────────────'));

  // El modelo elegido persiste en la config en memoria y sobrevive a otro
  // configure() que solo toque keys (como hace save-llm-keys).
  LLMProvider.configure({ llm: { providers: { gemini: { model: { smart: 'gemini-2.5-pro' } } } } });
  LLMProvider.configure({ llm: { providers: { gemini: { apiKey: 'x' } } } });
  const resolved = LLMProvider._debug_resolveModel('gemini', 'smart');
  assert(resolved === 'gemini-2.5-pro', 'el override smart sobrevive a configure() de keys');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
  console.log(C.bold(C.cyan('  Fase Q — Catálogo y selección de modelos por proveedor')));
  console.log(C.bold(C.cyan('════════════════════════════════════════════════════════')));

  testCatalogs();
  testActiveModel();
  testListModels();
  await testRefresh();
  testConfigureMerge();

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
