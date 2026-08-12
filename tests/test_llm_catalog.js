'use strict';

// @ts-check

// Tests del catálogo LLM data-driven (Fase catálogo nivel opencode):
//   1. Metadata válida para todos los modelos del catálogo (label/context/
//      tools) y para cada default por rol.
//   2. getModelMeta / getProviderMeta resuelven (y null en desconocidos).
//   3. resolveModelId resuelve id exacto, alias y substring.
//   4. ROLE_LABELS + resolveRole mapean charla/agente ↔ fast/smart.
//   5. recommend() respeta capacidades: agent nunca sugiere sin tools; vision
//      exige visión; cheap ordena gratis primero. Sin key no sugiere nada.
//   6. refreshRemoteCatalog(): con fetcher OK añade modelos nuevos; con fallo
//      degrada sin romper; respeta TTL; respeta remoteCatalog.enabled=false.
//   7. getAvailableProviders() expone modelMeta para la UI.

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
const catalog = require('../core/llm/catalog.js');
const { recommend, applyRecommended, TASKS } = require('../core/llm/recommend.js');

// ── Test 1: metadata del catálogo ────────────────────────────────────────────

function testCatalogMetadata() {
  console.log(C.bold('\n── Test 1: metadata válida en todo el catálogo ─────────────────'));
  const providers = LLMProvider.getAvailableProviders();
  assert(providers.length >= 8, `mínimo 8 built-in providers (${providers.length})`);

  let metaErrors = 0;
  let defaultErrors = 0;
  for (const p of providers) {
    const meta = p.modelMeta || {};
    const ids = Object.keys(meta);
    assert(ids.length > 0, `${p.id}: catálogo no vacío`);
    for (const m of Object.values(meta)) {
      if (!m || typeof m.label !== 'string' || !m.label) metaErrors++;
      if (typeof m.tools !== 'boolean') metaErrors++;
      if (typeof m.context !== 'number' || m.context <= 0) metaErrors++;
    }
    // Los defaults de cada rol deben existir en el catálogo y tener tools.
    const active = p.activeModel || {};
    if (active.fast && !ids.includes(active.fast)) defaultErrors++;
    if (active.smart && !ids.includes(active.smart)) defaultErrors++;
    if (active.smart && meta[active.smart] && !meta[active.smart].tools) defaultErrors++;
  }
  assert(
    metaErrors === 0,
    'toda la metadata es válida (label/context/tools)',
    `errores: ${metaErrors}`
  );
  assert(
    defaultErrors === 0,
    'defaults por rol existen y smart tiene tools',
    `errores: ${defaultErrors}`
  );
}

// ── Test 2: getModelMeta / getProviderMeta ───────────────────────────────────

function testModelMetaLookup() {
  console.log(C.bold('\n── Test 2: getModelMeta / getProviderMeta ───────────────────────'));
  const m = LLMProvider.getModelMeta('groq', 'llama-3.3-70b-versatile');
  assert(m && m.label && m.tools === true, 'getModelMeta groq/llama-3.3 → meta con label+tools');
  assert(LLMProvider.getModelMeta('groq', 'no-existe') === null, 'modelo desconocido → null');
  assert(LLMProvider.getModelMeta('no-provider', 'x') === null, 'provider desconocido → null');
  const p = LLMProvider.getProviderMeta('deepseek');
  assert(p && p.name === 'DeepSeek' && p.baseURL, 'getProviderMeta deepseek → def con baseURL');
}

// ── Test 3: resolveModelId (id exacto / alias / substring) ───────────────────

function testResolveModelId() {
  console.log(C.bold('\n── Test 3: resolveModelId ───────────────────────────────────────'));
  assert(
    LLMProvider.resolveModelId('groq', 'llama-3.3-70b-versatile') === 'llama-3.3-70b-versatile',
    'id exacto'
  );
  assert(
    LLMProvider.resolveModelId('groq', 'llama3.3') === 'llama-3.3-70b-versatile',
    'alias del catálogo'
  );
  assert(
    LLMProvider.resolveModelId('groq', 'llama-3.3') === 'llama-3.3-70b-versatile',
    'substring inequívoco'
  );
  assert(LLMProvider.resolveModelId('openai', 'gpt-5') === 'gpt-5', 'openai gpt-5 exacto');
  assert(LLMProvider.resolveModelId('groq', 'zzz-no-existe') === null, 'sin coincidencia → null');
}

// ── Test 4: roles visibles ───────────────────────────────────────────────────

function testRoles() {
  console.log(C.bold('\n── Test 4: ROLE_LABELS + resolveRole ─────────────────────────────'));
  assert(catalog.ROLE_LABELS.fast === 'Charla', 'fast → "Charla"');
  assert(catalog.ROLE_LABELS.smart === 'Tareas de agente', 'smart → "Tareas de agente"');
  assert(catalog.resolveRole('charla') === 'fast', 'charla → fast');
  assert(catalog.resolveRole('agente') === 'smart', 'agente → smart');
  assert(catalog.resolveRole('fast') === 'fast', 'fast → fast (backward compat)');
  assert(catalog.resolveRole('smart') === 'smart', 'smart → smart (backward compat)');
  assert(catalog.resolveRole('otra-cosa') === null, 'palabra inválida → null');
  assert(LLMProvider.resolveRole('rapido') === 'fast', 'alias "rapido" → fast');
}

// ── Test 5: recommend() por capacidad ────────────────────────────────────────

function _mockProviders() {
  return [
    {
      id: 'prov-a',
      name: 'Proveedor A',
      hasKey: true,
      free: false,
      modelMeta: {
        'modelo-chat': {
          label: 'Chat',
          tools: false,
          vision: false,
          free: false,
          cost: { in: 1, out: 2 },
        },
        'modelo-agent': {
          label: 'Agent',
          tools: true,
          vision: false,
          free: false,
          cost: { in: 1, out: 2 },
        },
        'modelo-vision': {
          label: 'Vis',
          tools: true,
          vision: true,
          free: false,
          cost: { in: 1, out: 2 },
        },
      },
      activeModel: { fast: 'modelo-chat', smart: 'modelo-agent' },
    },
    {
      id: 'prov-b',
      name: 'Proveedor B',
      hasKey: true,
      free: true,
      modelMeta: {
        'gratis-chat': {
          label: 'Gratis Chat',
          tools: false,
          vision: false,
          free: true,
          cost: { in: 0, out: 0 },
        },
        'gratis-agent': {
          label: 'Gratis Agent',
          tools: true,
          vision: false,
          free: true,
          cost: { in: 0, out: 0 },
        },
      },
      activeModel: { fast: 'gratis-chat', smart: 'gratis-agent' },
    },
    {
      id: 'prov-sin-key',
      name: 'Proveedor C',
      hasKey: false,
      free: false,
      modelMeta: {
        'x-agent': { label: 'X Agent', tools: true, vision: false, free: false },
      },
      activeModel: { fast: 'x-agent', smart: 'x-agent' },
    },
  ];
}

function testRecommend() {
  console.log(C.bold('\n── Test 5: recommend() respeta capacidades ───────────────────────'));
  const providers = _mockProviders();

  assert(TASKS.chat && TASKS.agent && TASKS.vision && TASKS.cheap, 'TASKS define las 4 tareas');

  const agent = recommend('agent', providers);
  assert(agent.length === 2, 'agent: 2 providers con key viable', JSON.stringify(agent));
  assert(
    agent.every((r) => r.tools === true),
    'agent: NINGUNO sin tools',
    JSON.stringify(agent)
  );

  const vision = recommend('vision', providers);
  assert(
    vision.length >= 1 && vision.every((r) => r.vision === true),
    'vision: solo modelos con visión',
    JSON.stringify(vision)
  );

  const cheap = recommend('cheap', providers);
  assert(
    cheap.length >= 2 && cheap[0].free === true,
    'cheap: gratis primero',
    JSON.stringify(cheap)
  );

  const chat = recommend('chat', providers);
  assert(
    chat.length === 2 && chat.every((r) => r.label),
    'chat: 2 candidatos con label',
    JSON.stringify(chat)
  );

  assert(recommend('no-existe', providers).length === 0, 'tarea desconocida → []');

  // Sin keys → nada que recomendar (el usuario debe conectar primero).
  const noKeys = providers.map((p) => ({ ...p, hasKey: false }));
  assert(recommend('agent', noKeys).length === 0, 'sin keys → sin recomendación');

  // applyRecommended configura el rol del mejor candidato en memoria.
  const best = applyRecommended('agent', _mockProviders());
  assert(
    best && best.tools === true,
    'applyRecommended(agent) devuelve un modelo con tools',
    JSON.stringify(best)
  );
}

// ── Test 6: refreshRemoteCatalog (híbrido models.dev) ────────────────────────

async function testRemoteCatalog() {
  console.log(C.bold('\n── Test 6: refreshRemoteCatalog (models.dev híbrido) ─────────────'));
  let fetchCount = 0;
  const okFetcher = async () => {
    fetchCount++;
    return {
      status: 200,
      body: {
        providers: {
          deepseek: {
            name: 'DeepSeek',
            models: {
              'deepseek-v9-test': {
                name: 'DeepSeek V9',
                limits: { context: 262144, output: 65536 },
                tool_call: true,
                attachment: false,
              },
            },
          },
          'provider-inexistente': {
            name: 'Nope',
            models: { 'm-1': { name: 'M1', limits: { context: 1000, output: 500 } } },
          },
        },
      },
    };
  };

  // Fallo de red ANTES de un refresh exitoso (sin cache de disco no revienta).
  const failFetcher = async () => {
    throw new Error('ECONNREFUSED');
  };
  const fail = await LLMProvider.refreshRemoteCatalog(failFetcher);
  assert(fail === false, 'fallo de red → false (degradación silenciosa)');

  const ok = await LLMProvider.refreshRemoteCatalog(okFetcher);
  assert(ok === true, 'fetcher OK → true');
  const meta = LLMProvider.getModelMeta('deepseek', 'deepseek-v9-test');
  assert(
    meta && meta.tools === true && meta.context === 262144,
    'modelo remoto añadido con metadata',
    JSON.stringify(meta)
  );
  assert(
    LLMProvider.getModelMeta('deepseek', 'deepseek-v9-test').remote === true,
    'modelo remoto marcado (flag remote)'
  );
  assert(
    LLMProvider.listModels('deepseek').includes('deepseek-v9-test'),
    'modelo remoto entra al catálogo de listModels'
  );
  assert(
    LLMProvider.getModelMeta('provider-inexistente', 'm-1') === null,
    'provider remoto desconocido no toca el registry'
  );

  // TTL: segunda llamada dentro de la ventana NO re-consulta la red.
  const again = await LLMProvider.refreshRemoteCatalog(okFetcher);
  assert(
    again === true && fetchCount === 1,
    'TTL: no re-consulta dentro de la ventana',
    `fetches: ${fetchCount}`
  );

  // disabled → no toca la red y devuelve false.
  LLMProvider.configure({ llm: { remoteCatalog: { enabled: false } } });
  const disabled = await LLMProvider.refreshRemoteCatalog(okFetcher);
  assert(
    disabled === false && fetchCount === 1,
    'remoteCatalog.enabled=false → no consulta',
    `fetches: ${fetchCount}`
  );
  LLMProvider.configure({ llm: { remoteCatalog: { enabled: true } } });
}

// ── Test 7: getAvailableProviders expone modelMeta ───────────────────────────

function testProviderShape() {
  console.log(C.bold('\n── Test 7: getAvailableProviders() expone modelMeta ──────────────'));
  const p = LLMProvider.getAvailableProviders().find((x) => x.id === 'groq');
  assert(p && p.modelMeta && typeof p.modelMeta === 'object', 'groq trae modelMeta');
  assert(
    p.modelMeta['llama-3.1-8b-instant'] && p.modelMeta['llama-3.1-8b-instant'].tools === true,
    'modelMeta tiene metadata del modelo default'
  );
}

// ── Runner ───────────────────────────────────────────────────────────────────

(async () => {
  testCatalogMetadata();
  testModelMetaLookup();
  testResolveModelId();
  testRoles();
  testRecommend();
  await testRemoteCatalog();
  testProviderShape();

  console.log(
    C.bold(`\nResultado: ${C.green(`${passed} ✓`)}${failed ? ` / ${C.red(`${failed} ✗`)}` : ''}`)
  );
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(C.red('Fallo en la ejecución de la suite:'), e);
  process.exit(1);
});
