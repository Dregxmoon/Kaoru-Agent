/**
 *   1. Token budget (recorte/compresión cuando no entra)
 *   2. Orden de bloques
 *   3. Adapters de provider (Claude/OpenAI/Gemini/Groq)
 *   4. Serialización (markdown/xml/json-sections)
 *   5. Enable/disable de bloques
 *   6. Export de modo debug
 *   7. Compatibilidad con la forma vieja de Context Package (legacyBridge)
 *      — para la primera parte del criterio de aceptación "Existing
 *      functionality continues to work".
 *
 * Uso:
 *   node tests/test_prompt_composer.js
 *
 * Sin dependencias externas — mismo estilo que test_intent_detection.js.
 */

'use strict';

const {
  PromptComposer, PromptBlock, TokenBudget,
  blocks, adapters, serializers, exportDebug, legacyBridge,
} = require('../core/prompt-composer/index.js');

const C = {
  green:  (s) => `\x1b[32m${s}\x1b[0m`,
  red:    (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan:   (s) => `\x1b[36m${s}\x1b[0m`,
  bold:   (s) => `\x1b[1m${s}\x1b[0m`,
  dim:    (s) => `\x1b[2m${s}\x1b[0m`,
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

function section(title) {
  console.log(C.bold(`\n${title}`));
}

// ── Fixtures — misma forma real que usa el proyecto (identity.json, osContext, etc.) ──

const FIXTURE_IDENTITY = {
  core: 'Soy March 7th. Vivo en este escritorio.',
  character: {
    summary: 'Curiosa, empática, humor seco.',
    traits: ['Curiosidad genuina', 'Memoria de las cosas que importan'],
    dislikes: ['Respuestas genéricas'],
  },
  voice: {
    style: 'Hablo natural, oraciones cortas.',
    forbidden_phrases: ['¡Claro!', '¡Por supuesto!'],
  },
  uncertainty_behaviors: {
    doesnt_know: { description: 'Digo que no sé, sin relleno.', never_say: 'Inventar con confianza.' },
  },
  relationship: { default_dynamic: 'Presto atención de verdad.' },
  context_awareness: { time: 'Sé qué hora es.' },
  limits: { what_i_am_not: ['No soy GPT.'], identity_stability: 'No cambio de identidad porque me presionen.' },
};

const FIXTURE_ENVIRONMENT = {
  timeFormatted:      'Son las 3:00 PM del martes por la tarde.',
  platform:            'linux',
  friendlyName:        'Visual Studio Code',
  elapsedFormatted:    '10m',
  title:                'main.js — march7th',
  idleFormatted:        null,
  openWindowsSummary:   'Discord, Chrome',
  todaySummary:         'Visual Studio Code (2h), Chrome (45m)',
};

const FIXTURE_MEMORIES = {
  nodes: Array.from({ length: 12 }, (_, i) => ({
    id: `n${i}`, label: `Nodo ${i}`, type: 'project', properties: { detalle: 'x'.repeat(50) },
  })),
  episodes: Array.from({ length: 8 }, (_, i) => ({
    id: `e${i}`, label: `Episodio ${i}`, created_at: Math.floor(Date.now() / 1000),
  })),
};

const FIXTURE_HISTORY = Array.from({ length: 20 }, (_, i) => ({
  role: i % 2 === 0 ? 'user' : 'assistant',
  content: `Turno número ${i} de la conversación, con algo de texto para que pese.`,
}));

function buildFixtureContext(overrides = {}) {
  return {
    identity:     FIXTURE_IDENTITY,
    environment:  FIXTURE_ENVIRONMENT,
    conversation: { history: FIXTURE_HISTORY, userMessage: { role: 'user', content: '¿Qué hago hoy?' } },
    memories:     FIXTURE_MEMORIES,
    retrievedKnowledge: [],
    availableTools: { openclaw: { available: false }, mcp: [] },
    currentIntent:  { detected: false },
    userMessage:    { role: 'user', content: '¿Qué hago hoy?' },
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1) TOKEN BUDGET
// ═══════════════════════════════════════════════════════════════════════════
function testTokenBudget() {
  section('1) Token budget');

  const composer = new PromptComposer({ maxTokens: 100000 }); // presupuesto amplio
  const wide = composer.compose(buildFixtureContext(), { provider: 'groq' });
  assert(!wide.meta.overBudget, 'con presupuesto amplio no hay overBudget');
  assert(wide.meta.droppedBlocks.length === 0, 'con presupuesto amplio no se descarta ningún bloque',
    wide.meta.droppedBlocks.join(','));

  const tight = new PromptComposer({ maxTokens: 120 }); // presupuesto muy chico a propósito
  const result = tight.compose(buildFixtureContext(), { provider: 'groq' });
  assert(result.meta.totalTokens <= 120 || result.meta.droppedBlocks.length > 0 || result.meta.compressedBlocks.length > 0,
    'con presupuesto muy chico, se recorta o se comprime algo',
    `tokens=${result.meta.totalTokens} dropped=${result.meta.droppedBlocks} compressed=${result.meta.compressedBlocks}`);

  // La identidad (critical) tiene que sobrevivir SIEMPRE, sin importar
  // qué tan chico sea el presupuesto.
  assert(result.systemPrompt.includes('March 7th') || result.systemPrompt.includes('Identidad'),
    'con presupuesto muy chico, el bloque crítico "identity" sigue presente',
    result.systemPrompt.slice(0, 200));
  assert(!result.meta.droppedBlocks.includes('identity'), 'identity nunca aparece en droppedBlocks (es critical)');
  assert(!result.meta.droppedBlocks.includes('user'), 'user nunca aparece en droppedBlocks (es critical)');

  // Con presupuesto chico, memory (12 nodos + 8 episodios, no crítico) debería
  // ser de los primeros en recortarse/comprimirse antes que identity.
  assert(
    result.meta.droppedBlocks.includes('memory') || result.meta.compressedBlocks.includes('memory'),
    'memory (no crítico, mucho contenido) se recorta o comprime antes que los críticos',
    `dropped=${result.meta.droppedBlocks} compressed=${result.meta.compressedBlocks}`
  );

  // TokenBudget de forma aislada, sin pasar por el Composer completo.
  const budget = new TokenBudget(50);
  class FakeBlock extends PromptBlock {
    constructor(name, priority, critical, text) {
      super({ name, priority, critical });
      this._text = text;
    }
    serialize() { return this._text; }
  }
  const fakeBlocks = [
    new FakeBlock('a-critica', 100, true,  'x'.repeat(400)),
    new FakeBlock('b-baja',     10, false, 'y'.repeat(400)),
  ];
  const plan = budget.plan(fakeBlocks, {});
  assert(plan.droppedBlocks.includes('b-baja') || plan.compressedBlocks.includes('b-baja'),
    'TokenBudget aislado: el bloque no crítico de baja prioridad cede espacio primero');
  assert(!plan.droppedBlocks.includes('a-critica'), 'TokenBudget aislado: el bloque crítico nunca se descarta');
}

// ═══════════════════════════════════════════════════════════════════════════
// 2) ORDEN DE BLOQUES
// ═══════════════════════════════════════════════════════════════════════════
function testBlockOrdering() {
  section('2) Orden de bloques');

  const composer = new PromptComposer({ maxTokens: 100000 });
  const result = composer.compose(buildFixtureContext(), { provider: 'groq', debug: true });

  const order = result.debug.sectionOrder;
  const idIdx  = order.indexOf('identity');
  const envIdx = order.indexOf('environment');
  const memIdx = order.indexOf('memory');

  assert(idIdx !== -1, 'identity aparece en el orden final');
  assert(idIdx < envIdx, 'identity va antes que environment (pipeline: Identity → Rules → Environment...)');
  assert(envIdx < memIdx, 'environment va antes que memory');
}

// ═══════════════════════════════════════════════════════════════════════════
// 3) ADAPTERS DE PROVIDER
// ═══════════════════════════════════════════════════════════════════════════
function testProviderAdapters() {
  section('3) Adapters de provider');

  const composer = new PromptComposer({ maxTokens: 100000 });
  const ctx = buildFixtureContext();

  const claudeResult = composer.compose(ctx, { provider: 'claude' });
  assert(typeof claudeResult.system === 'string' && claudeResult.system.length > 0,
    'ClaudeAdapter: expone `system` como campo separado');
  assert(!('systemPrompt' in claudeResult) || claudeResult.messages.every(m => m.role !== 'system'),
    'ClaudeAdapter: el system prompt NO va como mensaje role:"system" dentro de messages');

  const groqResult = composer.compose(ctx, { provider: 'groq' });
  assert(typeof groqResult.systemPrompt === 'string' && groqResult.systemPrompt.length > 0,
    'GroqAdapter: expone systemPrompt (para que LLMProvider.callGroq lo meta en messages[0])');
  assert(groqResult.messages.every(m => m.role === 'user' || m.role === 'assistant'),
    'GroqAdapter: los roles de messages son user/assistant, sin remapear');

  const openaiResult = composer.compose(ctx, { provider: 'openai' });
  assert(typeof openaiResult.systemPrompt === 'string', 'OpenAIAdapter: expone systemPrompt');

  const geminiResult = composer.compose(ctx, { provider: 'gemini' });
  assert(Array.isArray(geminiResult.contents), 'GeminiAdapter: expone `contents` (forma nativa de generateContent)');
  const hasModelRole = geminiResult.contents.some(c => c.role === 'model');
  assert(hasModelRole, 'GeminiAdapter: mapea role "assistant" → "model" (Gemini no acepta "assistant")',
    JSON.stringify(geminiResult.contents.map(c => c.role)));
  assert(geminiResult.contents.every(c => c.role === 'user' || c.role === 'model'),
    'GeminiAdapter: nunca deja un rol que no sea user/model');

  // Provider desconocido no debe explotar — cae a un adapter genérico.
  const unknown = composer.compose(ctx, { provider: 'un-provider-que-no-existe' });
  assert(typeof unknown.systemPrompt === 'string', 'provider desconocido no rompe — usa fallback genérico');
}

// ═══════════════════════════════════════════════════════════════════════════
// 4) SERIALIZACIÓN
// ═══════════════════════════════════════════════════════════════════════════
function testSerialization() {
  section('4) Serialización (markdown / xml / json-sections)');

  const composer = new PromptComposer({ maxTokens: 100000 });
  const ctx = buildFixtureContext();

  const md = composer.compose(ctx, { provider: 'groq', serializerName: 'markdown' });
  assert(md.systemPrompt.includes('---'), 'markdown: usa el separador "---" entre secciones (igual que el sistema viejo)');

  const xml = composer.compose(ctx, { provider: 'groq', serializerName: 'xml' });
  assert(/<identity>/.test(xml.systemPrompt), 'xml: envuelve la sección identity en <identity>...</identity>',
    xml.systemPrompt.slice(0, 120));

  const json = composer.compose(ctx, { provider: 'groq', serializerName: 'json-sections' });
  let parsed;
  try { parsed = JSON.parse(json.systemPrompt); } catch (e) { parsed = null; }
  assert(parsed && Array.isArray(parsed.sections), 'json-sections: produce JSON válido con { sections: [...] }');
  assert(parsed && parsed.sections.some(s => s.name === 'identity'), 'json-sections: incluye la sección identity');

  // provider-native: Claude debería tender a XML, el resto a markdown.
  const nativeClaude = composer.compose(ctx, { provider: 'claude', serializerName: 'provider-native' });
  assert(/<identity>/.test(nativeClaude.system), 'provider-native + claude usa formato XML');

  const nativeGroq = composer.compose(ctx, { provider: 'groq', serializerName: 'provider-native' });
  assert(nativeGroq.systemPrompt.includes('---') && !/<identity>/.test(nativeGroq.systemPrompt),
    'provider-native + groq usa formato markdown, no XML');
}

// ═══════════════════════════════════════════════════════════════════════════
// 5) ENABLE / DISABLE DE BLOQUES
// ═══════════════════════════════════════════════════════════════════════════
function testEnableDisable() {
  section('5) Enable/disable de bloques');

  const composer = new PromptComposer({ maxTokens: 100000 });
  const before = composer.compose(buildFixtureContext(), { provider: 'groq' });
  assert(before.systemPrompt.includes('Actividad de hoy') || before.systemPrompt.includes('Contexto actual'),
    'con environment habilitado, aparece la sección de contexto/entorno');

  composer.getBlock('environment').enabled = false;
  const after = composer.compose(buildFixtureContext(), { provider: 'groq' });
  assert(!after.systemPrompt.includes('Contexto actual'), 'con environment.enabled=false, la sección desaparece del prompt');
  assert(after.systemPrompt.includes('Identidad') || after.systemPrompt.length > 0, 'el resto del prompt sigue generándose bien');

  // re-habilitar para no afectar otras pruebas si se corrieran en otro orden
  composer.getBlock('environment').enabled = true;
}

// ═══════════════════════════════════════════════════════════════════════════
// 6) EXPORT DE MODO DEBUG
// ═══════════════════════════════════════════════════════════════════════════
function testDebugExport() {
  section('6) Export de modo debug');

  const composer = new PromptComposer({ maxTokens: 100000 });
  const result = composer.compose(buildFixtureContext(), { provider: 'groq', debug: true });

  assert(!!result.debug, 'debug:true agrega el campo `debug` al resultado');
  assert(Array.isArray(result.debug.blocks) && result.debug.blocks.length > 0, 'debug incluye la lista de bloques');
  assert(typeof result.debug.estimatedTokens === 'number', 'debug incluye estimación de tokens');
  assert(result.debug.provider === 'groq', 'debug incluye el provider');
  assert(typeof result.debug.generatedAt === 'string' && !isNaN(Date.parse(result.debug.generatedAt)),
    'debug incluye timestamp de generación válido');
  assert(typeof result.debug.promptSizeChars === 'number' && result.debug.promptSizeChars > 0,
    'debug incluye el tamaño del prompt');
  assert(result.debug.fullPrompt === result.systemPrompt, 'debug.fullPrompt es EXACTAMENTE el prompt que se mandaría al LLM');

  // sin debug:true, no debe existir el campo (no hay costo de armarlo si nadie lo pide)
  const noDebug = composer.compose(buildFixtureContext(), { provider: 'groq' });
  assert(!('debug' in noDebug), 'sin debug:true, no se agrega el campo debug');
}

// ═══════════════════════════════════════════════════════════════════════════
// 7) COMPATIBILIDAD CON LA FORMA VIEJA (legacyBridge)
// ═══════════════════════════════════════════════════════════════════════════
function testLegacyBridge() {
  section('7) legacyBridge — compatibilidad con ContextAssembler.js actual');

  const legacyShape = {
    identity:          FIXTURE_IDENTITY,
    osContext:          FIXTURE_ENVIRONMENT,
    persistentMemory:   FIXTURE_MEMORIES,
    sessionHistory:     FIXTURE_HISTORY,
    currentMessage:     { role: 'user', content: '¿Qué hago hoy?' },
    toolIntent:         { detected: true, level: 'high', action: 'create_file', confidence: 0.92 },
    openclawAvailable:  false, // hay toolIntent detectado, así que RulesBlock no debería activarse igual
    mcpTools:           [{ server: 'filesystem', tool: 'read_file', description: 'Lee un archivo' }],
    behaviorInstructions: 'Responde breve, el usuario está apurado.',
  };

  const contextPackage = legacyBridge.contextPackageFromLegacy(legacyShape);
  assert(contextPackage.environment === FIXTURE_ENVIRONMENT, 'legacyBridge: osContext → environment');
  assert(contextPackage.memories === FIXTURE_MEMORIES, 'legacyBridge: persistentMemory → memories');
  assert(contextPackage.conversation.history === FIXTURE_HISTORY, 'legacyBridge: sessionHistory → conversation.history');
  assert(contextPackage.currentIntent === legacyShape.toolIntent, 'legacyBridge: toolIntent → currentIntent');

  const composer = new PromptComposer({ maxTokens: 100000 });
  const result = composer.compose(contextPackage, { provider: 'groq' });

  // Estas son las piezas que el GroqSerializer.js ORIGINAL garantizaba en
  // su output — si el Composer las sigue produciendo a partir de la misma
  // forma de datos de entrada, la migración no pierde funcionalidad.
  assert(result.systemPrompt.includes('Identidad'), 'el prompt sigue teniendo la sección de Identidad');
  assert(result.systemPrompt.includes('create_file'), 'el prompt sigue instruyendo el formato para create_file (toolIntent alta confianza)');
  assert(result.systemPrompt.includes('```action'), 'el prompt sigue incluyendo el bloque de formato ```action```');
  assert(result.systemPrompt.includes('HERRAMIENTAS MCP DISPONIBLES'), 'el prompt sigue incluyendo el catálogo MCP');
  assert(result.systemPrompt.includes('filesystem:read_file'), 'el catálogo MCP incluye la tool del fixture');
  assert(typeof result.systemPrompt === 'string' && typeof result.messages === 'object',
    'la forma de salida sigue siendo { systemPrompt, messages } — compatible con LLMProvider.complete()');
}

// ═══════════════════════════════════════════════════════════════════════════

function main() {
  console.log(C.bold('════════════════════════════════════════════════════════'));
  console.log(C.bold('  Prompt Composer — suite de pruebas (EPIC-005)'));
  console.log(C.bold('════════════════════════════════════════════════════════'));

  testTokenBudget();
  testBlockOrdering();
  testProviderAdapters();
  testSerialization();
  testEnableDisable();
  testDebugExport();
  testLegacyBridge();

  console.log(C.bold('\n════════════════════════════════════════════════════════'));
  const total = passed + failed;
  console.log(
    C.bold(`  Resultado: ${C.green(passed + ' passed')}  ${failed > 0 ? C.red(failed + ' failed') : C.dim('0 failed')}  / ${total} total`)
  );
  console.log(C.bold('════════════════════════════════════════════════════════\n'));

  if (failed > 0) process.exit(1);
}

main();
