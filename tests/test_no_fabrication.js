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

function assertIncludes(text, substring, label) {
  const ok = text.includes(substring);
  assert(ok, label, ok ? '' : `Expected "${substring}" in "${text.slice(0, 200)}..."`);
}

// ── Mock IntentDetector results ─────────────────────────────────────────────

const HIGH_CONF_INTENT = {
  detected: true,
  action: 'run_command',
  tool: 'exec',
  confidence: 0.85,
  level: 'high',
  description: 'Ejecutar un comando en la terminal',
};

const MEDIUM_CONF_INTENT = {
  detected: true,
  action: 'run_command',
  tool: 'exec',
  confidence: 0.7,
  level: 'medium',
  description: 'Posiblemente ejecutar un comando en la terminal',
};

// ── Test 1: High level incluye la prohibición de fabricación ─────────────────
function testHighLevelHasAntiFabrication() {
  console.log(C.bold('\n── High level: instrucción anti-fabricación presente ──────'));

  const { GroqSerializer } = require('../core/grounding/serializers/GroqSerializer.js');
  const serializer = new GroqSerializer();

  const contextPackage = {
    identity: null,
    osContext: null,
    persistentMemory: null,
    sessionHistory: [],
    currentMessage: { role: 'user', content: 'ejecuta un ls' },
    toolIntent: HIGH_CONF_INTENT,
  };

  const result = serializer.serialize(contextPackage);
  const prompt = result.systemPrompt;

  assertIncludes(
    prompt,
    'NUNCA describas ni simules',
    'El system prompt incluye la prohibición de no simular resultados'
  );
  assertIncludes(
    prompt,
    'no inventes salidas de terminal',
    'La prohibición menciona salidas de terminal'
  );
  assertIncludes(prompt, 'listados', 'La prohibición menciona listados de archivos');
  assertIncludes(prompt, 'contenidos de archivo', 'La prohibición menciona contenidos de archivo');
}

// ── Test 2: Medium level incluye la prohibición de fabricación ───────────────
function testMediumLevelHasAntiFabrication() {
  console.log(C.bold('\n── Medium level: instrucción anti-fabricación presente ────'));

  const { GroqSerializer } = require('../core/grounding/serializers/GroqSerializer.js');
  const serializer = new GroqSerializer();

  const contextPackage = {
    identity: null,
    osContext: null,
    persistentMemory: null,
    sessionHistory: [],
    currentMessage: { role: 'user', content: 'podrías ejecutar un ls' },
    toolIntent: MEDIUM_CONF_INTENT,
  };

  const result = serializer.serialize(contextPackage);
  const prompt = result.systemPrompt;

  assertIncludes(
    prompt,
    'NUNCA describas ni simules',
    'Medium level: prohibición de no simular presente'
  );
  assertIncludes(
    prompt,
    'no inventes salidas de terminal',
    'Medium level: mención de salidas de terminal'
  );
  assertIncludes(prompt, 'listados', 'Medium level: mención de listados de archivos');
}

// ── Test 3: Sin toolIntent no tiene la instrucción --------------------------
function testNoIntentNoFabricationBlock() {
  console.log(C.bold('\n── Sin toolIntent: no hay bloque de fabricación ───────────'));

  const { GroqSerializer } = require('../core/grounding/serializers/GroqSerializer.js');
  const serializer = new GroqSerializer();

  const contextPackage = {
    identity: null,
    osContext: null,
    persistentMemory: null,
    sessionHistory: [],
    currentMessage: { role: 'user', content: 'hola cómo estás' },
    toolIntent: null,
  };

  const result = serializer.serialize(contextPackage);
  const prompt = result.systemPrompt;

  assert(
    !prompt.includes('NUNCA describas ni simules'),
    'Sin intención: no hay instrucción anti-fabricación'
  );
}

// ── Memoria persistente: excluida por defecto de proveedores externos ───────

const MEMORY_SAMPLE = {
  nodes: [{ type: 'Dato', content: 'El usuario trabaja en el Proyecto X' }],
  episodes: [{ content: 'Conversación sobre refactor del módulo Y', created_at: '2026-01-01' }],
};

function testMemoryExcludedByDefault() {
  console.log(C.bold('\n── Memoria: excluida por defecto de proveedores externos ──'));

  const { GroqSerializer } = require('../core/grounding/serializers/GroqSerializer.js');
  const serializer = new GroqSerializer();

  const base = {
    identity: null,
    osContext: null,
    sessionHistory: [],
    currentMessage: { role: 'user', content: '¿qué sabes de mí?' },
    toolIntent: null,
  };

  const defaultResult = serializer.serialize({ ...base, persistentMemory: MEMORY_SAMPLE });
  assert(
    !defaultResult.systemPrompt.includes('Lo que sé del usuario'),
    'Por defecto NO se incluye la sección de memoria'
  );
  assert(
    !defaultResult.systemPrompt.includes('Episodios recientes'),
    'Por defecto NO se incluyen episodios'
  );

  const withMemory = serializer.serialize(
    { ...base, persistentMemory: MEMORY_SAMPLE },
    { includeMemory: true }
  );
  assert(
    withMemory.systemPrompt.includes('Lo que sé del usuario'),
    'Con includeMemory:true la memoria se incluye'
  );
  assert(withMemory.systemPrompt.includes('Proyecto X'), 'El nodo de memoria llega al prompt');

  // La memoria es excluida por defecto por el serializer único del pipeline
  // (GroqSerializer). Gemini/OpenAI ya no tienen subclases propias: los
  // serializers no-op fueron eliminados — el formato es compartido.
  const shared = serializer.serialize({ ...base, persistentMemory: MEMORY_SAMPLE });
  assert(
    !shared.systemPrompt.includes('Lo que sé del usuario'),
    'Memoria excluida por defecto (serializer compartido)'
  );
}

// ── F3.3: inferencias NUNCA se presentan como hechos ─────────────────────────

const path = require('path');
const fs = require('fs');
const os = require('os');

function testInferredSeparatedFromFacts() {
  console.log(C.bold('\n── F3.3: inferred=1 va a Impresiones, nunca a los hechos ──'));

  const { StateGraph } = require('../core/state-graph/StateGraph.js');
  const { ContextAssembler } = require('../core/grounding/ContextAssembler.js');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-inf-'));
  const graph = new StateGraph(path.join(dir, 'core.db')).init();

  const factId = graph.createNode({
    type: 'User',
    label: 'nombre_usuario',
    content: 'El usuario se llama Luka',
    importance: 0.9,
  });
  graph.createNode({
    type: 'Belief',
    label: 'valor_cocinar_en_casa',
    content: 'Al usuario le gusta cocinar en casa y probar platos nuevos',
    importance: 0.8,
    tags: ['inferred', 'value'],
    inferred: 1,
    confidence: 0.75,
  });

  // Simula el retrieval: incluye TAMBIÉN la inferencia colada en los nodos de
  // hechos (recall semántico) — el ContextAssembler debe re-particionarla.
  const factRow = graph.getNode(factId);
  const inferredRow = graph.getUserModel({ limit: 8 })[0];

  const assembler = new ContextAssembler(graph);
  const result = assembler.build({
    sessionHistory: [{ role: 'user', content: 'hola' }],
    retrievalResult: { nodes: [factRow, inferredRow], episodeNodes: [] },
    activeProvider: 'groq',
    includeMemory: true,
  });
  const prompt = result.systemPrompt;
  const factsSection = prompt.split('## Impresiones')[0];

  assertIncludes(
    prompt,
    '## Lo que sé del usuario',
    'La sección de hechos está presente en el prompt'
  );
  assert(
    !factsSection.includes('cocinar en casa'),
    'La inferencia NO aparece en la sección de hechos (aunque vino colada en retrieval)'
  );
  assertIncludes(
    prompt,
    'El usuario se llama Luka',
    'El hecho real sí está en la sección de hechos'
  );
  assertIncludes(
    prompt,
    '## Impresiones (no confirmadas por el usuario)',
    'La sección de impresiones está presente y bien titulada'
  );
  assertIncludes(
    prompt,
    'cocinar en casa',
    'La inferencia SÍ aparece en la sección de impresiones'
  );
  assertIncludes(prompt, '(75%)', 'El confidence es visible en la impresión');
  assertIncludes(prompt, 'inferencias de Kaoru', 'Disclaimer: son inferencias de Kaoru, no dichos');
  assertIncludes(
    prompt,
    'Nunca las presentes como un hecho',
    'Prohibición explícita de presentarlas como hecho'
  );
  assertIncludes(
    prompt,
    'como pregunta o hipótesis abierta',
    'Instrucción de formularlas como pregunta/hipótesis'
  );

  // getWorldModel NO devuelve inferencias (la fuente de hechos se mantiene pura).
  assert(
    !graph.getWorldModel().some((n) => n.inferred === 1),
    'getWorldModel() devuelve solo hechos (inferred=0)'
  );
  assert(
    graph.getUserModel({ limit: 8 }).every((n) => n.inferred === 1),
    'getUserModel() devuelve solo inferencias (inferred=1)'
  );

  graph.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Test 2.1: el ejemplo de formato enseña CONTENIDO a create_file/edit_file ──

function testFormatExampleTeachesContentField() {
  console.log(C.bold('\n── 2.1: create_file/edit_file enseñan el campo CONTENIDO ──────'));

  const {
    GroqSerializer,
    _debug_buildFormatExample,
  } = require('../core/grounding/serializers/GroqSerializer.js');

  const exCreate = _debug_buildFormatExample('create_file');
  assertIncludes(exCreate, 'CONTENIDO:', 'create_file: ejemplo incluye CONTENIDO:');
  assertIncludes(exCreate, 'ACCIÓN: create_file', 'create_file: conserva ACCIÓN');
  assertIncludes(exCreate, 'ARCHIVO:', 'create_file: conserva ARCHIVO:');

  const exEdit = _debug_buildFormatExample('edit_file');
  assertIncludes(exEdit, 'CONTENIDO:', 'edit_file: ejemplo incluye CONTENIDO:');
  assertIncludes(exEdit, 'ACCIÓN: edit_file', 'edit_file: conserva ACCIÓN');

  // El ejemplo llega al system prompt cuando se detecta la intención (alta
  // confianza), no solo en el helper.
  const serializer = new GroqSerializer();
  const contextPackage = {
    identity: null,
    osContext: null,
    persistentMemory: null,
    sessionHistory: [],
    currentMessage: { role: 'user', content: 'creá un archivo nuevo con mi código' },
    toolIntent: {
      detected: true,
      action: 'create_file',
      tool: 'create_file',
      confidence: 0.85,
      level: 'high',
    },
  };
  const prompt = serializer.serialize(contextPackage).systemPrompt;
  assertIncludes(
    prompt,
    'CONTENIDO:',
    'el system prompt con intención create_file enseña CONTENIDO:'
  );
}

// ── Run ─────────────────────────────────────────────────────────────────────

console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
console.log(C.bold(C.cyan('  Anti-Fabrication Prompts — Fase 0.2')));
console.log(C.bold(C.cyan('════════════════════════════════════════════════════════')));

testHighLevelHasAntiFabrication();
testMediumLevelHasAntiFabrication();
testNoIntentNoFabricationBlock();
testMemoryExcludedByDefault();
testInferredSeparatedFromFacts();
testFormatExampleTeachesContentField();

console.log(C.bold('\n════════════════════════════════════════════════════════'));
const total = passed + failed + skipped;
const color = failed === 0 ? C.green : C.red;
const skipNote = skipped > 0 ? `  ${C.yellow(`${skipped} skipped`)}` : '';
if (failed === 0) {
  console.log(
    `  ${color('Resultado')}: ${color(`${passed} passed`)}  ${C.dim(`0 failed`)}${skipNote}  / ${total} total`
  );
} else {
  console.log(
    `  Resultado: ${C.green(`${passed} passed`)}  ${C.red(`${failed} failed`)}${skipNote}  / ${total} total`
  );
}
console.log(C.bold('════════════════════════════════════════════════════════'));

if (failed > 0) process.exit(1);
