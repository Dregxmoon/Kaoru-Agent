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

// ── Run ─────────────────────────────────────────────────────────────────────

console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
console.log(C.bold(C.cyan('  Anti-Fabrication Prompts — Fase 0.2')));
console.log(C.bold(C.cyan('════════════════════════════════════════════════════════')));

testHighLevelHasAntiFabrication();
testMediumLevelHasAntiFabrication();
testNoIntentNoFabricationBlock();

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
