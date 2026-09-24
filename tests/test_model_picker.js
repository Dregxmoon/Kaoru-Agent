'use strict';

// @ts-check

// Tests del selector de modelos (picker modelo-first, nivel opencode):
//   1. getModelPickerData(): shape completa, roles, active, favoritos,
//      providers (built-in + remotos) y modelos. NUNCA expone keys.
//   2. Mapeo npm→tipo de conexión: openai/anthropic/gemini conectables,
//      SDKs nicho (bedrock/cohere) no conectables.
//   3. Modelos remotos del picker con metadata (label/context/tools/vision).
//   4. connectProvider(): registra custom+remote, guarda key (en memoria,
//      llavero desactivado en tests), asigna modelo por rol, marca primary.
//      Rechaza providers no conectables.
//   5. Favoritos: setFavoriteModel/getFavorites ida y vuelta.

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

// Los tests nunca tocan el llavero del sistema ni config.json real: keys en
// memoria, remote catalog inyectado por fetcher stub.
LLMProvider._setKeychainResolver(false);

// Body plano de models.dev (formato real: { providerId: { name, api, env,
// npm, doc, models } }).
const FAKE_RAW = {
  providers: {
    openrouter: {
      name: 'OpenRouter',
      api: 'https://openrouter.ai/api/v1',
      env: ['OPENROUTER_API_KEY'],
      npm: '@ai-sdk/openai-compatible',
      doc: 'https://openrouter.ai/docs',
      models: {
        'openrouter/auto': {
          name: 'OpenRouter Auto',
          limits: { context: 32000, output: 8000 },
          tool_call: true,
          attachment: false,
          reasoning: true,
          cost: { prompt: 0, completion: 0 },
        },
      },
    },
    anthropic: {
      name: 'Anthropic',
      api: 'https://api.anthropic.com/v1',
      env: ['ANTHROPIC_API_KEY'],
      npm: '@ai-sdk/anthropic',
      doc: 'https://docs.anthropic.com',
      models: {
        'claude-sonnet-4': {
          name: 'Claude Sonnet 4',
          limits: { context: 200000, output: 64000 },
          tool_call: true,
          attachment: true,
          cost: { prompt: 3, completion: 15 },
        },
      },
    },
    gemini: {
      name: 'Google Gemini',
      api: 'https://generativelanguage.googleapis.com/v1beta',
      env: ['GEMINI_API_KEY'],
      npm: '@ai-sdk/google',
      doc: 'https://ai.google.dev',
      models: {
        'gemini-2.5-pro': {
          name: 'Gemini 2.5 Pro',
          limits: { context: 1000000, output: 65536 },
          tool_call: true,
          attachment: true,
          reasoning: true,
          cost: { prompt: 1.25, completion: 10 },
        },
      },
    },
    'amazon-bedrock': {
      name: 'Amazon Bedrock',
      env: ['AWS_ACCESS_KEY_ID'],
      npm: '@ai-sdk/amazon-bedrock',
      models: {
        'amazon-nova-pro': { name: 'Amazon Nova Pro', limits: { context: 32000 }, tool_call: true },
      },
    },
    cohere: {
      name: 'Cohere',
      // api presente pero SDK nicho: sin caller en el pipeline → no conectable.
      api: 'https://api.cohere.com',
      env: ['COHERE_API_KEY'],
      npm: '@ai-sdk/cohere',
      models: {
        'command-r': { name: 'Command R', limits: { context: 128000 }, tool_call: true },
      },
    },
    mistral: {
      name: 'Mistral',
      api: 'https://api.mistral.ai/v1',
      env: ['MISTRAL_API_KEY'],
      npm: '@ai-sdk/mistral',
      models: {
        'mistral-large-latest': {
          name: 'Mistral Large',
          limits: { context: 128000, output: 32768 },
          tool_call: true,
          cost: { prompt: 2, completion: 6 },
        },
      },
    },
  },
};

const okFetcher = async () => ({ status: 200, body: FAKE_RAW });

// ── Test 1: shape de getModelPickerData y ausencia de secretos ───────────────

async function testPickerShape() {
  console.log(C.bold('\n── Test 1: getModelPickerData() sin secretos ─────────────────────'));
  const applied = await LLMProvider.refreshRemoteCatalog(okFetcher);
  assert(applied === true, 'remote catalog aplicado con fetcher stub');

  const data = LLMProvider.getModelPickerData();
  assert(data && typeof data === 'object', 'devuelve objeto');
  assert(
    data.roles && data.roles.fast && data.roles.smart,
    'roles expuestos',
    JSON.stringify(data.roles)
  );
  assert(
    data.active && (typeof data.active.provider === 'string' || data.active.provider === null),
    'active.provider presente (string o null sin key)',
    JSON.stringify(data.active && data.active.provider)
  );
  assert(
    Array.isArray(data.providers) && data.providers.length >= 5,
    `providers listado (${data.providers.length})`
  );
  assert(
    Array.isArray(data.models) && data.models.length > 0,
    `modelos listado (${data.models.length})`
  );
  assert(Array.isArray(data.favorites), 'favorites es array');

  const serialized = JSON.stringify(data);
  assert(
    !serialized.includes('sk-test-') && !serialized.includes('apiKey'),
    'ninguna key en el payload del picker'
  );
  assert(
    !data.providers.some((p) => Object.prototype.hasOwnProperty.call(p, 'apiKey')),
    'ningún provider expone campo apiKey'
  );

  // Tope anti-miles: UNA entrada por empresa. Los 400+ remotos de models.dev
  // NO están en el payload salvo key/custom (ver remoteHidden + búsqueda).
  assert(!data.providers.some((p) => p.id === 'openrouter'), 'remoto sin key fuera del payload');
  assert(
    !data.models.some((m) => m.providerId === 'openrouter'),
    'modelos remotos sin key fuera del payload'
  );
  assert(
    data.remoteHidden && data.remoteHidden.providers > 0,
    `remoteHidden cuenta lo oculto (${JSON.stringify(data.remoteHidden)})`
  );
  const curated = [
    'groq',
    'gemini',
    'openai',
    'anthropic',
    'xai',
    'nvidia',
    'huggingface',
    'deepseek',
  ];
  for (const id of curated) {
    assert(
      data.providers.some((p) => p.id === id),
      `curado presente: ${id}`
    );
  }
}

// ── Test 1b: búsqueda remota acotada ─────────────────────────────────────────

function testRemoteSearch() {
  console.log(C.bold('\n── Test 1b: searchRemoteProviders (acotada, sin secretos) ────'));
  const found = LLMProvider.searchRemoteProviders('openrouter');
  assert(found.length >= 1 && found.length <= 12, `acotada 1..12 (${found.length})`);
  const openrouter = found.find((p) => p.id === 'openrouter');
  assert(openrouter && openrouter.connectable === true, 'openrouter remoto y conectable');
  assert(openrouter && openrouter.hasKey === false, 'openrouter sin key al inicio');
  assert(
    openrouter && openrouter.doc === 'https://openrouter.ai/docs',
    'doc del provider presente'
  );
  assert(
    openrouter && Array.isArray(openrouter.env) && openrouter.env[0] === 'OPENROUTER_API_KEY',
    'env expuesto (solo nombre de var)'
  );
  assert(
    openrouter && Array.isArray(openrouter.models) && openrouter.models.length <= 5,
    'máx 5 modelos por remoto'
  );
  assert(!JSON.stringify(found).includes('apiKey'), 'la búsqueda no expone keys');
  assert(LLMProvider.searchRemoteProviders('').length === 0, 'query vacía → []');
  assert(LLMProvider.searchRemoteProviders('zzz-sin-existir').length === 0, 'sin match → []');
}

// ── Test 2: mapeo npm→tipo de conexión ───────────────────────────────────────

function testTypeMapping() {
  console.log(C.bold('\n── Test 2: mapeo npm→tipo (conectable vs nicho) ────────────────'));
  const data = LLMProvider.getModelPickerData();
  const byId = new Map(data.providers.map((p) => [p.id, p]));

  const anthropic = byId.get('anthropic');
  const gemini = byId.get('gemini');
  assert(anthropic && anthropic.type === 'anthropic', '@ai-sdk/anthropic → anthropic');
  assert(gemini && gemini.type === 'gemini', '@ai-sdk/google → gemini');

  // Remotos solo vía búsqueda acotada (fuera del payload por defecto).
  const remote = LLMProvider.searchRemoteProviders('openrouter');
  const openrouter = remote.find((p) => p.id === 'openrouter');
  const bedrock = LLMProvider.searchRemoteProviders('bedrock').find(
    (p) => p.id === 'amazon-bedrock'
  );
  const cohere = LLMProvider.searchRemoteProviders('cohere').find((p) => p.id === 'cohere');
  const mistral = LLMProvider.searchRemoteProviders('mistral').find((p) => p.id === 'mistral');

  assert(openrouter && openrouter.type === 'openai', 'openai-compatible → openai');
  assert(bedrock && bedrock.type === 'other', '@ai-sdk/amazon-bedrock → other');
  assert(bedrock && bedrock.connectable === false, 'amazon-bedrock NO conectable');
  assert(cohere && cohere.connectable === false, 'cohere NO conectable (SDK nicho, pese a api)');
  assert(
    mistral && mistral.type === 'openai' && mistral.connectable === true,
    '@ai-sdk/mistral → openai conectable'
  );
}

// ── Test 3: modelos remotos con metadata en el picker ─────────────────────────

function testPickerModels() {
  console.log(C.bold('\n── Test 3: modelos con metadata + referencias ──────────────────'));
  const data = LLMProvider.getModelPickerData();
  const providerIds = new Set(data.providers.map((p) => p.id));

  // Remotos con metadata llegan por búsqueda acotada (no en el payload base).
  const remote = LLMProvider.searchRemoteProviders('openrouter');
  const auto = (remote.find((p) => p.id === 'openrouter') || { models: [] }).models.find(
    (m) => m.modelId === 'openrouter/auto'
  );
  assert(auto && auto.label === 'OpenRouter Auto', 'label del modelo remoto');
  assert(auto && auto.context === 32000, 'context del modelo remoto');
  assert(auto && auto.tools === true, 'tools del modelo remoto');

  const sonnet = data.models.find(
    (m) => m.providerId === 'anthropic' && m.modelId === 'claude-sonnet-4'
  );
  assert(sonnet && sonnet.vision === true, 'visión del modelo curado');
  assert(sonnet && sonnet.context === 200000, 'context amplio del modelo curado');
  assert(sonnet && sonnet.costIn === 3 && sonnet.costOut === 15, 'costes por M expuestos');

  assert(
    data.models.every((m) => providerIds.has(m.providerId)),
    'todos los modelos referencian providers existentes',
    'algún modelId con providerId fuera del índice'
  );
  assert(
    data.models.every((m) => typeof m.modelId === 'string' && m.modelId.length > 0),
    'modelId siempre no vacío'
  );
}

// ── Test 4: connectProvider (3 tipos + rechazos) ──────────────────────────────

function testConnectProvider() {
  console.log(C.bold('\n── Test 4: connectProvider (openai/anthropic/nicho) ─────────────'));

  // openai-compatible con key + modelo + rol → conecta y queda primary.
  const openrouter = LLMProvider.connectProvider({
    providerId: 'openrouter',
    apiKey: 'sk-test-openrouter',
    modelId: 'openrouter/auto',
    mode: 'fast',
  });
  assert(openrouter.ok === true, 'openrouter conecta', JSON.stringify(openrouter.error));
  assert(openrouter.provider && openrouter.provider.hasKey === true, 'openrouter tiene key');
  assert(openrouter.provider && openrouter.provider.type === 'openai', 'tipo mapeado a openai');
  assert(
    openrouter.provider && openrouter.provider.fast === 'openrouter/auto',
    'modelo asignado a charla'
  );

  const data = LLMProvider.getModelPickerData();
  assert(data.active.provider === 'openrouter', 'openrouter queda como primary');
  assert(
    data.providers.find((p) => p.id === 'openrouter').hasKey === true,
    'picker refleja hasKey tras conectar'
  );
  const reg = LLMProvider.getAvailableProviders().find((p) => p.id === 'openrouter');
  assert(reg && reg.custom === true && reg.remote === true, 'registrado como custom+remote');

  // anthropic ES built-in (catálogo curado): el default por rol es el suyo.
  const anthropic = LLMProvider.connectProvider({
    providerId: 'anthropic',
    apiKey: 'sk-ant-test',
    mode: 'smart',
  });
  assert(anthropic.ok === true, 'anthropic conecta', JSON.stringify(anthropic.error));
  assert(
    anthropic.provider &&
      typeof anthropic.provider.smart === 'string' &&
      anthropic.provider.smart.length > 0,
    'anthropic resuelve un modelo smart',
    JSON.stringify(anthropic.provider && anthropic.provider.smart)
  );

  // provider remoto (sin built-in) sin modelo → default al primer modelo del
  // catálogo remoto.
  const mistral = LLMProvider.connectProvider({ providerId: 'mistral', apiKey: 'x' });
  assert(mistral.ok === true, 'mistral conecta', JSON.stringify(mistral.error));
  assert(
    mistral.provider && mistral.provider.smart === 'mistral-large-latest',
    'provider remoto sin modelo → primer modelo del catálogo',
    JSON.stringify(mistral.provider && mistral.provider.smart)
  );

  // SDK nicho sin endpoint → rechazo controlado (no toca el registry).
  const bedrock = LLMProvider.connectProvider({ providerId: 'amazon-bedrock', apiKey: 'x' });
  assert(bedrock.ok === false, 'amazon-bedrock rechazado', JSON.stringify(bedrock.error));
  assert(
    bedrock.error && /no es conectable/.test(bedrock.error),
    'error explica que no es conectable',
    bedrock.error
  );
  assert(
    LLMProvider.getAvailableProviders().find((p) => p.id === 'amazon-bedrock') === undefined,
    'amazon-bedrock no quedó registrado'
  );

  // Sin key → ok pero sin conexión real (hasKey false).
  const noKey = LLMProvider.connectProvider({ providerId: 'cohere' });
  assert(
    noKey.ok === false && /conectable/.test(noKey.error || ''),
    'cohere sin key → rechazo no conectable'
  );

  const gemini = LLMProvider.connectProvider({ providerId: 'gemini', apiKey: 'AIza-test' });
  assert(gemini.ok === true && gemini.provider.hasKey === true, 'gemini conecta (google SDK)');
}

// ── Test 5: favoritos ida y vuelta ────────────────────────────────────────────

function testFavorites() {
  console.log(C.bold('\n── Test 5: favoritos (setFavoriteModel/getFavorites) ─────────────'));
  const key = 'openrouter/openrouter/auto';
  assert(LLMProvider.setFavoriteModel(key, true) === true, 'setFavoriteModel(on) → true');
  assert(LLMProvider.getFavorites().includes(key), 'favorito persistido en memoria');
  assert(
    LLMProvider.getModelPickerData().favorites.includes(key),
    'getModelPickerData() lo refleja'
  );
  assert(LLMProvider.setFavoriteModel(key, false) === true, 'setFavoriteModel(off) → true');
  assert(!LLMProvider.getFavorites().includes(key), 'favorito removido');
  assert(LLMProvider.setFavoriteModel('', true) === false, 'modelKey vacío → false');
  assert(LLMProvider.setFavoriteModel('x/y', true) === true, 'modelKey bien formado aceptado');
  assert(LLMProvider.setFavoriteModel('x/y', false) === true, 'remoción limpia');
}

function testReasoningEffortPayloads() {
  console.log(C.bold('\n── Test 6: esfuerzo de razonamiento por API ────────────────────'));
  const openaiBody = { temperature: 0.85 };
  LLMProvider._applyReasoningEffort(openaiBody, 'openai', 'o3', {
    reasoningEffort: 'high',
  });
  assert(openaiBody.reasoning_effort === 'high', 'OpenAI recibe reasoning_effort');
  assert(
    !Object.prototype.hasOwnProperty.call(openaiBody, 'temperature'),
    'OpenAI reasoning omite temperature'
  );

  const openrouterBody = {};
  LLMProvider._applyReasoningEffort(openrouterBody, 'openrouter', 'openai/o3', {
    reasoningEffort: 'low',
  });
  assert(openrouterBody.reasoning?.effort === 'low', 'OpenRouter recibe reasoning.effort');

  const unsupportedBody = {};
  LLMProvider._applyReasoningEffort(unsupportedBody, 'gemini', 'gemini-2.5-pro', {
    reasoningEffort: 'high',
  });
  assert(Object.keys(unsupportedBody).length === 0, 'no se inventan campos en APIs no adaptadas');
}

function testSingleModelSelection() {
  console.log(C.bold('\n── Un modelo para todas las solicitudes ──'));
  const selected = LLMProvider.connectProvider({
    providerId: 'openrouter',
    apiKey: 'test-key',
    modelId: 'openrouter/auto',
    mode: 'all',
  });
  assert(selected.ok, 'conecta y selecciona un solo modelo');
  assert(selected.provider.fast === selected.provider.smart, 'el routing conserva el mismo modelo');
  LLMProvider.configure({
    llm: {
      primary: 'openrouter',
      providers: {
        openrouter: {
          model: { fast: 'modelo-antiguo', smart: 'otro-antiguo', selected: 'openrouter/auto' },
        },
      },
    },
  });
  const active = LLMProvider.getAvailableProviders().find((p) => p.id === 'openrouter');
  assert(
    active?.activeModel?.fast === 'openrouter/auto' &&
      active.activeModel.smart === 'openrouter/auto',
    'la elección única prevalece sobre roles heredados después de recargar'
  );
}

// ── Runner ───────────────────────────────────────────────────────────────────

(async () => {
  await testPickerShape();
  testRemoteSearch();
  testTypeMapping();
  testPickerModels();
  testConnectProvider();
  testFavorites();
  testReasoningEffortPayloads();
  testSingleModelSelection();

  console.log(
    C.bold(`\nResultado: ${C.green(`${passed} ✓`)}${failed ? ` / ${C.red(`${failed} ✗`)}` : ''}`)
  );
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(C.red('Fallo en la ejecución de la suite:'), e);
  process.exit(1);
});
