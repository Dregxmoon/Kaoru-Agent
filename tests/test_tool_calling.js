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

// ── Test 1: Validación de schema por herramienta ─────────────────────────────

function testSchemaValidation() {
  console.log(C.bold('\n── Test 1: Validación de schema por herramienta ───────────────'));

  const { TOOL_SCHEMAS } = require('../core/llm/ToolSchemas.js');

  assert(
    TOOL_SCHEMAS.length >= 8,
    `mínimo 8 herramientas (incluye LSP)`,
    `actual: ${TOOL_SCHEMAS.length}`
  );

  const toolsByName = {};
  for (const t of TOOL_SCHEMAS) toolsByName[t.name] = t;

  // Verificar que todas las herramientas tienen los campos requeridos
  const expectedTools = [
    'exec',
    'read',
    'write',
    'edit',
    'apply_patch',
    'code_execution',
    'browser',
    'web_search',
  ];
  for (const name of expectedTools) {
    assert(!!toolsByName[name], `Herramienta "${name}" existe`);
    assert(!!toolsByName[name].description, `"${name}" tiene description`);
    assert(toolsByName[name].inputSchema?.type === 'object', `"${name}" inputSchema es object`);
    assert(
      Array.isArray(toolsByName[name].inputSchema?.required),
      `"${name}" tiene required array`
    );
    assert(
      toolsByName[name].inputSchema.required.length > 0,
      `"${name}" tiene al menos 1 campo requerido`
    );
  }

  // Validar campos requeridos específicos
  const requiredChecks = [
    { tool: 'exec', required: ['command'] },
    { tool: 'read', required: ['path'] },
    { tool: 'write', required: ['path', 'content'] },
    { tool: 'edit', required: ['path', 'old_text', 'new_text'] },
    { tool: 'apply_patch', required: ['path', 'patch'] },
    { tool: 'code_execution', required: ['code'] },
    { tool: 'browser', required: ['action'] },
    { tool: 'web_search', required: ['query'] },
  ];

  for (const { tool, required } of requiredChecks) {
    const t = toolsByName[tool];
    for (const field of required) {
      assert(
        t.inputSchema.required.includes(field),
        `"${tool}" requiere "${field}"`,
        `requeridos: ${t.inputSchema.required.join(', ')}`
      );
    }
  }

  // Verificar que cada propiedad requerida tiene su definición
  for (const t of TOOL_SCHEMAS) {
    for (const req of t.inputSchema.required) {
      assert(
        !!t.inputSchema.properties[req],
        `"${t.name}" propiedad requerida "${req}" tiene definición`
      );
    }
  }
}

// ── Test 2: Normalización cruzada entre proveedores ─────────────────────────

function testCrossProviderNormalization() {
  console.log(C.bold('\n── Test 2: Normalización cruzada entre proveedores ───────────'));

  const LLMProvider = require('../core/llm/LLMProvider.js');

  const normalizedCall = { tool: 'read', params: { path: 'config.json' } };

  // Fixture: respuesta simulada de OpenAI/Groq (formato real)
  const openAIResponse = {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            {
              id: 'call_abc123',
              type: 'function',
              function: {
                name: 'read',
                arguments: '{"path": "config.json"}',
              },
            },
          ],
        },
      },
    ],
  };

  // Fixture: respuesta simulada de Gemini (formato real)
  const geminiResponse = {
    candidates: [
      {
        content: {
          parts: [
            {
              functionCall: {
                name: 'read',
                args: { path: 'config.json' },
              },
            },
          ],
        },
      },
    ],
  };

  // Fixture: respuesta simulada de Anthropic (formato Messages real)
  const anthropicResponse = {
    content: [
      { type: 'text', text: 'Voy a leer el archivo.' },
      { type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'config.json' } },
    ],
  };

  // Fixture: OpenAI con texto + tool call (caso edge)
  const openAIMixedResponse = {
    choices: [
      {
        message: {
          content: 'Voy a leer el archivo.',
          tool_calls: [
            {
              id: 'call_def456',
              type: 'function',
              function: {
                name: 'read',
                arguments: '{"path": "config.json"}',
              },
            },
          ],
        },
      },
    ],
  };

  // Normalizar OpenAI
  const normOpenAI = LLMProvider._debug_normalizeOpenAI(openAIResponse);
  assert(normOpenAI.content === null, 'OpenAI: content es null (solo tool call)');
  assert(normOpenAI.toolCalls !== null, 'OpenAI: toolCalls no es null');
  assert(normOpenAI.toolCalls.length === 1, 'OpenAI: 1 tool call');
  assert(
    normOpenAI.toolCalls[0].tool === 'read',
    `OpenAI: tool="read"`,
    `actual: ${normOpenAI.toolCalls[0].tool}`
  );
  assert(
    normOpenAI.toolCalls[0].params.path === 'config.json',
    'OpenAI: params.path="config.json"'
  );

  // Normalizar Gemini
  const normGemini = LLMProvider._debug_normalizeGemini(geminiResponse);
  assert(normGemini.content === null, 'Gemini: content es null');
  assert(normGemini.toolCalls !== null, 'Gemini: toolCalls no es null');
  assert(normGemini.toolCalls.length === 1, 'Gemini: 1 tool call');
  assert(normGemini.toolCalls[0].tool === 'read', `Gemini: tool="read"`);
  assert(
    normGemini.toolCalls[0].params.path === 'config.json',
    'Gemini: params.path="config.json"'
  );

  // Normalizar Anthropic
  const normAnthropic = LLMProvider._debug_normalizeAnthropic(anthropicResponse);
  assert(normAnthropic.content === 'Voy a leer el archivo.', 'Anthropic: content preservado');
  assert(normAnthropic.toolCalls !== null, 'Anthropic: toolCalls no es null');
  assert(normAnthropic.toolCalls.length === 1, 'Anthropic: 1 tool call');
  assert(normAnthropic.toolCalls[0].tool === 'read', `Anthropic: tool="read"`);
  assert(
    normAnthropic.toolCalls[0].params.path === 'config.json',
    'Anthropic: params.path="config.json"'
  );
  assert(normAnthropic.toolCalls[0].id === 'toolu_1', 'Anthropic: id del tool_use preservado');

  // Normalizar OpenAI mixto (text + tool call)
  const normMixed = LLMProvider._debug_normalizeOpenAI(openAIMixedResponse);
  assert(normMixed.content === 'Voy a leer el archivo.', 'OpenAI mixto: content preservado');
  assert(normMixed.toolCalls !== null, 'OpenAI mixto: toolCalls no es null');
  assert(normMixed.toolCalls[0].tool === 'read', 'OpenAI mixto: tool="read"');

  // Verificar que ambos normalizadores producen el MISMO objeto
  assert(
    normOpenAI.toolCalls[0].tool === normGemini.toolCalls[0].tool &&
      normOpenAI.toolCalls[0].params.path === normGemini.toolCalls[0].params.path,
    'Normalización produce tool+params idénticos entre proveedores'
  );

  // Anthropic produce la misma tool+params que los demás proveedores
  assert(
    normAnthropic.toolCalls[0].tool === normOpenAI.toolCalls[0].tool &&
      normAnthropic.toolCalls[0].params.path === normOpenAI.toolCalls[0].params.path,
    'Normalización produce tool+params idénticos entre proveedores (Anthropic incluido)'
  );

  // Edge case: respuesta sin tool calls
  const noToolResponse = { choices: [{ message: { content: 'Texto normal' } }] };
  const normNoTool = LLMProvider._debug_normalizeOpenAI(noToolResponse);
  assert(normNoTool.content === 'Texto normal', 'Sin tool calls: content preservado');
  assert(normNoTool.toolCalls === null, 'Sin tool calls: toolCalls es null');

  // Edge case: Gemini sin functionCall
  const geminiTextResponse = { candidates: [{ content: { parts: [{ text: 'Hola' }] } }] };
  const normGeminiText = LLMProvider._debug_normalizeGemini(geminiTextResponse);
  assert(normGeminiText.content === 'Hola', 'Gemini texto: content preservado');
  assert(normGeminiText.toolCalls === null, 'Gemini texto: toolCalls es null');
}

// ── Test 3: Construcción de tools en formato de cada proveedor ──────────────

function testProviderToolFormat() {
  console.log(C.bold('\n── Test 3: Formato de tools por proveedor ────────────────────'));

  const LLMProvider = require('../core/llm/LLMProvider.js');
  const { TOOL_SCHEMAS } = require('../core/llm/ToolSchemas.js');

  const readTool = TOOL_SCHEMAS.find((t) => t.name === 'read');
  assert(!!readTool, 'Tool "read" encontrada');

  // Formato OpenAI/Groq
  const openAITools = LLMProvider._debug_buildOpenAITools([readTool]);
  assert(openAITools.length === 1, 'OpenAI: 1 tool');
  assert(openAITools[0].type === 'function', 'OpenAI: type="function"');
  assert(openAITools[0].function.name === 'read', `OpenAI: name="read"`);
  assert(openAITools[0].function.parameters.type === 'object', 'OpenAI: parameters.type="object"');
  assert(
    openAITools[0].function.parameters.required.includes('path'),
    'OpenAI: required incluye "path"'
  );

  // Formato Gemini
  const geminiTools = LLMProvider._debug_buildGeminiTools([readTool]);
  assert(geminiTools.length === 1, 'Gemini: 1 tool array');
  assert(
    Array.isArray(geminiTools[0].function_declarations),
    'Gemini: function_declarations es array'
  );
  assert(geminiTools[0].function_declarations[0].name === 'read', `Gemini: name="read"`);
  assert(
    geminiTools[0].function_declarations[0].parameters.required.includes('path'),
    'Gemini: required incluye "path"'
  );

  // Formato Anthropic
  const anthropicTools = LLMProvider._debug_buildAnthropicTools([readTool]);
  assert(anthropicTools.length === 1, 'Anthropic: 1 tool');
  assert(anthropicTools[0].name === 'read', `Anthropic: name="read"`);
  assert(anthropicTools[0].input_schema.type === 'object', 'Anthropic: input_schema.type="object"');
  assert(
    anthropicTools[0].input_schema.required.includes('path'),
    'Anthropic: input_schema.required incluye "path"'
  );

  // Todos los formatos producen el mismo nombre de tool
  assert(
    openAITools[0].function.name === geminiTools[0].function_declarations[0].name &&
      openAITools[0].function.name === anthropicTools[0].name,
    'Mismo nombre entre formatos (OpenAI/Gemini/Anthropic)'
  );
}

// ── Test 3b: el dispatcher registra caller de tools para Anthropic ──────────

function testAnthropicToolCallerRegistered() {
  console.log(C.bold('\n── Test 3b: Anthropic tiene caller de tools en el dispatcher ────'));

  const LLMProvider = require('../core/llm/LLMProvider.js');

  // Registrar un provider Anthropic de prueba y verificar que _getToolCaller
  // le asigna callAnthropicWithTools (no null como antes).
  const id = 'test-anthropic-tools';
  LLMProvider.registerProvider({
    id,
    name: 'Test Anthropic',
    type: 'anthropic',
    baseURL: 'https://api.anthropic.com/v1',
  });
  const caller = LLMProvider._debug_getToolCaller(id);
  assert(
    caller === LLMProvider._debug_callAnthropicWithTools,
    'dispatcher asigna el caller de tools de Anthropic'
  );

  // Registrar un provider "other" → sin caller de tools.
  const otherId = 'test-other-tools';
  LLMProvider.registerProvider({
    id: otherId,
    name: 'Test Other',
    type: 'other',
    baseURL: 'https://example.com/v1',
  });
  const none = LLMProvider._debug_getToolCaller(otherId);
  assert(none === null, 'tipo "other" sin caller de tools');
}

// ── Test 4: Respuesta vacía/incompleta no rompe ─────────────────────────────

function testEdgeCases() {
  console.log(C.bold('\n── Test 4: Casos borde — respuestas vacías/incompletas ───────'));

  const LLMProvider = require('../core/llm/LLMProvider.js');

  // Sin choices
  const empty1 = LLMProvider._debug_normalizeOpenAI({});
  assert(empty1.content === null && empty1.toolCalls === null, 'OpenAI: body vacío');

  // Sin candidates
  const empty2 = LLMProvider._debug_normalizeGemini({});
  assert(empty2.content === null && empty2.toolCalls === null, 'Gemini: body vacío');

  // Anthropic sin content (array)
  const empty3 = LLMProvider._debug_normalizeAnthropic({});
  assert(empty3.content === null && empty3.toolCalls === null, 'Anthropic: body vacío');
  const empty4 = LLMProvider._debug_normalizeAnthropic({ content: [] });
  assert(empty4.content === null && empty4.toolCalls === null, 'Anthropic: content vacío');

  // tool_calls con JSON inválido en arguments
  const badJSON = {
    choices: [
      {
        message: {
          tool_calls: [
            {
              type: 'function',
              function: { name: 'exec', arguments: '{broken json}' },
            },
          ],
        },
      },
    ],
  };
  const normBad = LLMProvider._debug_normalizeOpenAI(badJSON);
  assert(
    normBad.toolCalls === null || normBad.toolCalls.length === 0,
    'OpenAI: JSON inválido en arguments no rompe'
  );

  // Múltiples tool_calls
  const multiCalls = {
    choices: [
      {
        message: {
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: { name: 'read', arguments: '{"path":"a.txt"}' },
            },
            {
              id: 'c2',
              type: 'function',
              function: { name: 'write', arguments: '{"path":"b.txt","content":"test"}' },
            },
          ],
        },
      },
    ],
  };
  const normMulti = LLMProvider._debug_normalizeOpenAI(multiCalls);
  assert(
    normMulti.toolCalls.length === 2,
    `OpenAI: 2 tool_calls`,
    `actual: ${normMulti.toolCalls?.length}`
  );
  assert(normMulti.toolCalls[0].tool === 'read', 'Multi: primera tool es read');
  assert(normMulti.toolCalls[1].tool === 'write', 'Multi: segunda tool es write');
}

// ── Test 5: Regresión — ToolSchemas exporta lo mismo que espera LLMProvider ──

function testSchemaConsistency() {
  console.log(C.bold('\n── Test 5: Consistencia ToolSchemas ↔ LLMProvider ─────────────'));

  const LLMProvider = require('../core/llm/LLMProvider.js');
  const { TOOL_SCHEMAS } = require('../core/llm/ToolSchemas.js');

  const fromProvider = LLMProvider.getToolSchemas();

  assert(fromProvider.length === TOOL_SCHEMAS.length, 'Misma cantidad de herramientas');
  assert(fromProvider[0].name === TOOL_SCHEMAS[0].name, 'Misma primera herramienta');

  // Verificar que todos los nombres de tool existen en ActionParser
  const AP = require('../core/planner/ActionParser.js');
  for (const t of TOOL_SCHEMAS) {
    // isHighImpact debería reconocer todos los nombres de tool
    const recognized = typeof AP.isHighImpact(t.name, {}) === 'boolean';
    assert(
      recognized,
      `ActionParser reconoce "${t.name}"`,
      `isHighImpact("${t.name}") = ${AP.isHighImpact(t.name, {})}`
    );
  }
}

// ── Test 6: Reintento 413 (TPM groq) con modelo smart ───────────────────────

async function testGroq413Retry() {
  console.log(C.bold('\n── Test 6: tool-calling 413 "Request too large" → reintento smart ──'));

  const LLMProvider = require('../core/llm/LLMProvider.js');
  const id = 'test-groq-413';

  LLMProvider.registerProvider({
    id,
    name: 'Test Groq 413',
    type: 'openai',
    baseURL: 'http://127.0.0.1:9', // puerto cerrado: no debe llegar a red
    free: true,
    models: { fast: 'fast-model', smart: 'smart-model' },
  });
  LLMProvider.configure({ llm: { primary: id, fallback: [], apiKeys: { [id]: 'FAKE' } } });
  LLMProvider._setKeychainResolver(false);

  const calls = { fast: 0, smart: 0 };
  LLMProvider._debug_setToolCaller(id, async (_m, _s, mode, _tools, _opts) => {
    calls[mode] = (calls[mode] || 0) + 1;
    if (mode === 'fast') {
      const err = new Error(
        'groq 413: {"error":{"message":"Request too large for model `fast-model` on tokens per minute (TPM): Limit 6000, Requested 8761"}}'
      );
      throw err;
    }
    return { content: '', toolCalls: [{ tool: 'read', params: { path: 'a.txt' }, id: 'x' }] };
  });

  const tools = [
    {
      name: 'read',
      description: 'lee un archivo',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
  ];

  try {
    const result = await LLMProvider.completeWithTools(
      [{ role: 'user', content: 'hola' }],
      'sys',
      tools,
      'fast'
    );
    assert(calls.fast === 1, 'el modelo fast se probó exactamente 1 vez', `fast=${calls.fast}`);
    assert(calls.smart === 1, 'el modelo smart se reintentó 1 vez', `smart=${calls.smart}`);
    assert(
      Array.isArray(result.toolCalls) && result.toolCalls.length === 1,
      'tool-calling resolvió en smart'
    );
    assert(result.toolCalls[0].tool === 'read', 'tool call correcto desde el reintento');
  } catch (e) {
    assert(false, 'reintento 413→smart no lanzó error', e.message);
  }

  // Caso control: error no-413 NO debe disparar el reintento smart.
  const calls2 = { fast: 0, smart: 0 };
  LLMProvider._debug_setToolCaller(id, async (_m, _s, mode, _tools, _opts) => {
    calls2[mode] = (calls2[mode] || 0) + 1;
    throw new Error('gemini 404: modelo no disponible');
  });
  LLMProvider._debug_setCaller(id, async (_m, _s, _mode, _opts) => 'fallback texto');

  const fallback = await LLMProvider.completeWithTools(
    [{ role: 'user', content: 'hola' }],
    'sys',
    tools,
    'fast'
  );
  assert(calls2.smart === 0, 'un 404 NO reintenta con smart', `smart=${calls2.smart}`);
  assert(
    fallback.content === 'fallback texto' && fallback.toolCalls === null,
    'un 404 cae a fallback de texto sin toolCalls'
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
  console.log(C.bold(C.cyan('  March 7th — Test Suite: Tool-Calling Nativo Fase 1')));
  console.log(C.bold(C.cyan('════════════════════════════════════════════════════════')));

  testSchemaValidation();
  testCrossProviderNormalization();
  testProviderToolFormat();
  testAnthropicToolCallerRegistered();
  testEdgeCases();
  testSchemaConsistency();
  await testGroq413Retry();

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
