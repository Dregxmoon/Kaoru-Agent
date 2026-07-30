'use strict';

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

// ── Test 1: buildContext en modo agent siempre resuelve herramientas ─────────
function testAgentModeAlwaysResolvesTools() {
  console.log(C.bold('\n── Modo agent: buildContext resuelve nativeToolSchemas ────'));

  // Verificamos estructuralmente que el código de MarchCore.buildContext()
  // para modo 'agent' ya no retorna nativeToolSchemas: null
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'core', 'MarchCore.js'),
    'utf-8'
  );

  // La línea que retorna en modo agent debe tener nativeToolSchemas desde
  // resolvedTools, no null hardcoded
  const agentReturnMatch = src.match(/mode.*agent[\s\S]{0,500}return \{[\s\S]{0,200}nativeToolSchemas/);
  if (agentReturnMatch) {
    const hasResolvedTools = agentReturnMatch[0].includes('resolvedTools?.nativeToolSchemas');
    const hasNull = agentReturnMatch[0].includes('nativeToolSchemas: null');
    assert(hasResolvedTools && !hasNull,
      'modo agent retorna nativeToolSchemas desde resolvedTools (no null)',
      `Match: ${agentReturnMatch[0].slice(0, 150)}...`
    );
  } else {
    assert(false, 'No se encontró el return de modo agent en buildContext');
  }

  // Verificar que resolveToolset NO está condicionado por toolIntent
  const resolveToolsetCalls = src.match(/resolveToolset\s*\(/g);
  const resolveToolsetCount = resolveToolsetCalls ? resolveToolsetCalls.length : 0;
  assert(resolveToolsetCount >= 1, 'resolveToolset se llama en buildContext');

  // Verificar que el gate de toolIntent?.detected para OpenClaw ya no existe
  // en el modo chat
  const chatSection = src.match(/mode === 'chat'[\s\S]{0,1700}(?=\n  \/\/ Truncado inteligente)/);
  if (chatSection) {
    const hasIntentGate = chatSection[0].includes('toolIntent?.detected');
    const hasBridgeCheck = chatSection[0].includes("_bridge?.getStats()?.available");
    assert(!hasIntentGate, 'modo chat ya no gatilla OpenClaw en toolIntent?.detected',
      hasIntentGate ? 'Todavía contiene toolIntent?.detected' : '');
    assert(hasBridgeCheck, 'modo chat sigue verificando disponibilidad de OpenClaw');
  } else {
    assert(false, 'No se encontró sección de modo chat');
  }
}

// ── Test 2: GroqSerializer no controla visibilidad de herramientas ──────────
function testSerializerDoesNotGateTools() {
  console.log(C.bold('\n── GroqSerializer: no decide visibilidad de herramientas ──'));

  const { GroqSerializer } = require('../core/grounding/serializers/GroqSerializer.js');
  const serializer = new GroqSerializer();

  // Probar que el serializer funciona con y sin toolIntent — ambos producen
  // un systemPrompt válido. El toolIntent solo agrega contexto textual.
  const withIntent = serializer.serialize({
    identity: null,
    osContext: null,
    persistentMemory: null,
    sessionHistory: [],
    currentMessage: { role: 'user', content: 'ejecuta un ls' },
    toolIntent: {
      detected: true,
      action: 'run_command',
      tool: 'exec',
      confidence: 0.85,
      level: 'high',
      description: 'Ejecutar comando',
    },
  });

  const withoutIntent = serializer.serialize({
    identity: null,
    osContext: null,
    persistentMemory: null,
    sessionHistory: [],
    currentMessage: { role: 'user', content: 'hola cómo estás' },
    toolIntent: null,
  });

  assert(withIntent.systemPrompt.length > 0,
    'Con toolIntent: systemPrompt no vacío');
  assert(withoutIntent.systemPrompt.length > 0,
    'Sin toolIntent: systemPrompt no vacío');
  assert(withIntent.messages.length === 1,
    'Con toolIntent: 1 mensaje en el array');
  assert(withoutIntent.messages.length === 1,
    'Sin toolIntent: 1 mensaje en el array');

  // Verificar que el serializer nunca devuelve nativeToolSchemas
  // (eso es responsabilidad de MarchCore.buildContext/AgentLoop)
  assert(withIntent.nativeToolSchemas === undefined,
    'GroqSerializer no inyecta nativeToolSchemas');
}

// ── Test 3: Los tres niveles producen prompts v├ílidos con herramientas ──────
function testAllLevelsProduceValidPrompts() {
  console.log(C.bold('\n── Los 3 niveles de intención producen prompts válidos ────'));

  const { GroqSerializer } = require('../core/grounding/serializers/GroqSerializer.js');
  const serializer = new GroqSerializer();

  const levels = ['high', 'medium', 'none'];
  const messages = [
    'ejecuta un ls -la',
    'podrías listar los archivos',
    'hola cómo estás',
  ];

  for (let i = 0; i < levels.length; i++) {
    const level = levels[i];
    const msg = messages[i];
    const isDetected = level !== 'none';

    const result = serializer.serialize({
      identity: null,
      osContext: null,
      persistentMemory: null,
      sessionHistory: [],
      currentMessage: { role: 'user', content: msg },
      toolIntent: isDetected ? {
        detected: true,
        action: 'run_command',
        tool: 'exec',
        confidence: level === 'high' ? 0.85 : 0.70,
        level,
        description: 'test',
      } : null,
    });

    assert(result.systemPrompt.length > 0,
      `Nivel "${level}": systemPrompt no vacío`);
    assert(result.messages.length === 1,
      `Nivel "${level}": exactamente 1 mensaje`);
    assert(typeof result.systemPrompt === 'string',
      `Nivel "${level}": systemPrompt es string`);
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────

console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
console.log(C.bold(C.cyan('  Tool Visibility — Fase 1')));
console.log(C.bold(C.cyan('════════════════════════════════════════════════════════')));

testAgentModeAlwaysResolvesTools();
testSerializerDoesNotGateTools();
testAllLevelsProduceValidPrompts();

console.log(C.bold('\n════════════════════════════════════════════════════════'));
const total = passed + failed + skipped;
const color = failed === 0 ? C.green : C.red;
const skipNote = skipped > 0 ? `  ${C.yellow(`${skipped} skipped`)}` : '';
if (failed === 0) {
  console.log(`  ${color('Resultado')}: ${color(`${passed} passed`)}  ${C.dim(`0 failed`)}${skipNote}  / ${total} total`);
} else {
  console.log(`  Resultado: ${C.green(`${passed} passed`)}  ${C.red(`${failed} failed`)}${skipNote}  / ${total} total`);
}
console.log(C.bold('════════════════════════════════════════════════════════'));

if (failed > 0) process.exit(1);
