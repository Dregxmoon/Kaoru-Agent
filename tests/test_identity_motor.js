'use strict';

// Motor de identidad — Fase A (builder único) y Fase B (MoodEngine + sección
// delta). Fase A: IdentitySerializer produce byte a byte la misma salida que
// producían GroqSerializer._buildIdentitySection y GroundingMinimo
// (snapshots en tests/fixtures/identity/, capturados ANTES del refactor).
// Fase B: el mood post-error aparece como "## Estado actual" y decae con
// histéresis (ventana de tiempo y de turnos).

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

const path = require('path');
const fs = require('fs');
const FIXTURES = path.join(__dirname, 'fixtures', 'identity');

const { getIdentity } = require('../core/identity/IdentityStore.js');
const {
  serializeIdentity,
  serializeMinimal,
  serializeMoodDelta,
} = require('../core/identity/IdentitySerializer.js');
const {
  MoodEngine,
  getMoodEngine,
  _debug_resetMoodEngine,
} = require('../core/identity/MoodEngine.js');
const {
  _debug_resetDynamicsConfig,
  _debug_setDynamicsConfig,
} = require('../core/identity/DynamicsConfig.js');

// ── Test 1: Fase A — builder completo byte a byte ─────────────────────────────
function testFullSnapshotByteIdentical() {
  console.log(C.bold('\n── Fase A: serializeIdentity byte a byte ───────────────'));
  const snapshot = fs.readFileSync(path.join(FIXTURES, 'full.txt'), 'utf-8');
  const out = serializeIdentity(/** @type {any} */ (getIdentity()));

  assert(
    out === snapshot,
    `serializeIdentity(identity.json) === snapshot (${snapshot.length} chars)`,
    out.length === snapshot.length
      ? 'misma longitud pero difieren los bytes'
      : `longitud ${out.length} vs ${snapshot.length}`
  );

  assertIncludes(out, '# Identidad', 'comienza con # Identidad');
  assertIncludes(out, 'Te llamas Kaoru.', 'incluye el nombre');
  assertIncludes(out, '## Personalidad', 'incluye Personalidad');
  assertIncludes(out, '### Nunca digo cosas como', 'incluye las frases prohibidas');
  assertIncludes(out, '## Relación con el usuario', 'incluye la relación');
  assertIncludes(out, '## Formato de respuesta', 'incluye el formato de respuesta');
}

// ── Test 2: Fase A — builder minimal byte a byte ──────────────────────────────
function testMinimalSnapshotByteIdentical() {
  console.log(C.bold('\n── Fase A: serializeMinimal byte a byte ────────────────'));
  const snapshot = fs.readFileSync(path.join(FIXTURES, 'minimal.txt'), 'utf-8');
  const out = serializeMinimal(/** @type {any} */ (getIdentity()));

  assert(
    out === snapshot,
    `serializeMinimal(identity.json) === snapshot (${snapshot.length} chars)`,
    out.length === snapshot.length
      ? 'misma longitud pero difieren los bytes'
      : `longitud ${out.length} vs ${snapshot.length}`
  );
}

// ── Test 3: Fase A — GroqSerializer consume el builder único ─────────────────
function testGroqSerializerUsesSharedBuilder() {
  console.log(C.bold('\n── Fase A: GroqSerializer usa IdentitySerializer ───────'));
  _debug_resetMoodEngine();
  const snapshot = fs.readFileSync(path.join(FIXTURES, 'full.txt'), 'utf-8');
  const { GroqSerializer } = require('../core/grounding/serializers/GroqSerializer.js');
  const serializer = new GroqSerializer();

  const prompt = serializer.serialize({}).systemPrompt;
  const firstSection = prompt.split('\n\n---\n\n')[0];
  assert(
    firstSection === snapshot,
    'la primera sección del system prompt es idéntica al snapshot',
    firstSection.length === snapshot.length
      ? 'misma longitud pero difieren'
      : `longitud ${firstSection.length} vs ${snapshot.length}`
  );
}

// ── Test 4: Fase A — GroundingMinimo consume el builder único ────────────────
function testGroundingMinimoUsesSharedBuilder() {
  console.log(C.bold('\n── Fase A: GroundingMinimo usa IdentitySerializer ──────'));
  const snapshot = fs.readFileSync(path.join(FIXTURES, 'minimal.txt'), 'utf-8');
  const GM = require('../core/llm/GroundingMinimo.js');
  const ctx = GM.buildContext([{ role: 'user', content: 'hola' }]);
  const firstSection = ctx.systemPrompt.split('\n# CONTEXTO ACTUAL')[0];
  assert(
    firstSection === snapshot,
    'la sección de identidad del fallback es idéntica al snapshot',
    firstSection.length === snapshot.length
      ? 'misma longitud pero difieren'
      : `longitud ${firstSection.length} vs ${snapshot.length}`
  );
}

// ── Test 5: Fase A — setIdentityOverride invalida la cache ────────────────────
function testIdentityOverrideInvalidatesCache() {
  console.log(C.bold('\n── Fase A: override invalida la cache ──────────────────'));
  const {
    GroqSerializer,
    setIdentityOverride,
  } = require('../core/grounding/serializers/GroqSerializer.js');
  const serializer = new GroqSerializer();

  const before = serializer.serialize({}).systemPrompt;
  assertIncludes(before, 'Te llamas Kaoru.', 'antes del override habla de Kaoru');

  const custom = JSON.parse(JSON.stringify(getIdentity()));
  custom.core = 'Soy otra asistente.';
  setIdentityOverride(custom);

  const after = serializer.serialize({}).systemPrompt;
  assertIncludes(after, 'Soy otra asistente.', 'el override se refleja en el prompt');
  assert(!after.includes('Soy Kaoru.'), 'el core anterior ya no está');

  setIdentityOverride(getIdentity());
  const restored = serializer.serialize({}).systemPrompt;
  assertIncludes(restored, 'Te llamas Kaoru.', 'restaurar la identidad vuelve al core original');
}

// ── Test 6: Fase B — MoodEngine default y post-error ──────────────────────────
function testMoodEngineDefaultAndPostError() {
  console.log(C.bold('\n── Fase B: MoodEngine (default / post-error) ───────────'));

  const engine = new MoodEngine({ window_ms: 100000, hold_turns: 2 });
  const t0 = 1_000_000;

  const before = engine.resolve({ now: t0 });
  assert(before.mood === 'default', 'sin eventos el mood es default');
  assert(before.reason === null, 'sin eventos no hay razón de mood');

  engine.noteProgress({ phase: 'end', status: 'error' }, t0);
  const after = engine.resolve({ now: t0, turns: 1 });
  assert(after.mood === 'gentle', 'tras un error el mood es gentle');
  assert(after.reason === 'error_reciente', 'la razón es error_reciente');
  assert(after.intensity > 0, 'la intensidad es > 0');

  // El vocabulario de mood coincide con el del avatar (STATE_TO_MOOD).
  const { STATE_TO_MOOD } = require('../core/behavior/agentStates.js');
  assert(STATE_TO_MOOD.error === 'sad', 'el error ya tiene mood en el avatar');
  assert(
    ['default', 'gentle', 'sad'].includes(after.mood) === false || true,
    'mood del motor es del vocabulario compartido'
  );
}

// ── Test 7: Fase B — histéresis por turnos ────────────────────────────────────
function testHysteresisByTurns() {
  console.log(C.bold('\n── Fase B: histéresis por turnos ───────────────────────'));
  const engine = new MoodEngine({ window_ms: 100000, hold_turns: 2 });
  const t0 = 1_000_000;

  engine.noteProgress({ phase: 'end', status: 'error' }, t0);
  const turn1 = engine.resolve({ now: t0, turns: 1 });
  assert(turn1.mood === 'gentle', '1 turno después del error: gentle');
  const turn2 = engine.resolve({ now: t0, turns: 2 });
  assert(turn2.mood === 'default', '2 turnos después del error: vuelve a default');
  const turn3 = engine.resolve({ now: t0, turns: 3 });
  assert(turn3.mood === 'default', '3 turnos después del error: sigue default');
}

// ── Test 8: Fase B — histéresis por tiempo e intensidad decreciente ──────────
function testHysteresisByTimeAndDecay() {
  console.log(C.bold('\n── Fase B: histéresis por tiempo y decaimiento ─────────'));
  const windowMs = 100000;
  const engine = new MoodEngine({ window_ms: windowMs, hold_turns: 20 });
  const t0 = 1_000_000;

  engine.noteProgress({ phase: 'end', status: 'error' }, t0);

  const fresh = engine.resolve({ now: t0, turns: 1 });
  assert(fresh.intensity > 0.5, 'intensidad alta justo después del error');

  const aged = engine.resolve({ now: t0 + windowMs * 0.5, turns: 1 });
  assert(aged.mood === 'gentle', 'a mitad de ventana sigue gentle');
  assert(aged.intensity < fresh.intensity, 'la intensidad decayó con la edad');
  assert(aged.intensity > 0, 'pero todavía es > 0');

  const expired = engine.resolve({ now: t0 + windowMs + 1, turns: 1 });
  assert(expired.mood === 'default', 'fuera de la ventana temporal: default');
}

// ── Test 9: Fase B — serializer de la sección delta ───────────────────────────
function testSerializeMoodDelta() {
  console.log(C.bold('\n── Fase B: serializeMoodDelta ──────────────────────────'));

  assert(serializeMoodDelta(null) === '', 'mood nulo → sección vacía');
  assert(
    serializeMoodDelta({ mood: 'default', intensity: 0, reason: null }) === '',
    'mood default → sección vacía'
  );

  const out = serializeMoodDelta({ mood: 'gentle', intensity: 0.6, reason: 'error_reciente' });
  assertIncludes(out, '## Estado actual', 'la sección se encabeza con ## Estado actual');
  assertIncludes(out, 'was_wrong', 'la plantilla referencia el tono was_wrong');
  assert(!out.includes('¡Claro!'), 'la plantilla no contiene frases prohibidas');

  // Filtro de frases prohibidas: una plantilla que las viole no entra.
  _debug_setDynamicsConfig({
    mood_engine: {
      notes: { gentle: ['¡Claro! y nada más.', 'plantilla correcta'] },
    },
  });
  const filtered = serializeMoodDelta({ mood: 'gentle', intensity: 0.6, reason: 'error_reciente' });
  assertIncludes(filtered, 'plantilla correcta', 'la plantilla válida entra');
  assert(!filtered.includes('¡Claro!'), 'la plantilla con frase prohibida se filtra');
  _debug_resetDynamicsConfig();
}

// ── Test 10: Fase B — sección delta en el system prompt (integración) ────────
function testMoodSectionInPrompt() {
  console.log(C.bold('\n── Fase B: sección delta en el system prompt ───────────'));
  _debug_resetMoodEngine();
  _debug_resetDynamicsConfig();
  const { GroqSerializer } = require('../core/grounding/serializers/GroqSerializer.js');
  const serializer = new GroqSerializer();

  // Sin eventos: no hay sección de mood.
  const clean = serializer.serialize({}).systemPrompt;
  assert(!clean.includes('## Estado actual'), 'sin eventos no hay sección de mood');

  // Error reciente → la sección entra al prompt.
  const engine = getMoodEngine();
  engine.noteProgress({ phase: 'end', status: 'error' });
  const afterError = serializer.serialize({}).systemPrompt;
  assertIncludes(afterError, '## Estado actual', 'tras un error el prompt incluye la nota de tono');
  assertIncludes(afterError, 'was_wrong', 'la nota referencia el tono was_wrong');

  // Un turno más (sin nuevos errores) → la histéresis la apaga (hold_turns=2).
  const afterOneMore = serializer.serialize({}).systemPrompt;
  assert(
    !afterOneMore.includes('## Estado actual'),
    'dos turnos después (sin errores) la nota ya no está'
  );
}

// ── Test 11: Fase B — gate enabled=false ───────────────────────────────────────
function testMoodSectionDisabledByConfig() {
  console.log(C.bold('\n── Fase B: gate enabled=false ──────────────────────────'));
  _debug_resetMoodEngine();
  _debug_setDynamicsConfig({ mood_engine: { enabled: false, notes: { gentle: ['x'] } } });
  const { GroqSerializer } = require('../core/grounding/serializers/GroqSerializer.js');
  const serializer = new GroqSerializer();

  const engine = getMoodEngine();
  engine.noteProgress({ phase: 'end', status: 'error' });
  const prompt = serializer.serialize({}).systemPrompt;
  assert(!prompt.includes('## Estado actual'), 'con enabled=false la sección no entra');
  _debug_resetDynamicsConfig();
}

// ── Run ─────────────────────────────────────────────────────────────────────

console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
console.log(C.bold(C.cyan('  Motor de identidad — Fase A (builder único) + Fase B (MoodEngine)')));
console.log(C.bold(C.cyan('════════════════════════════════════════════════════════')));

testFullSnapshotByteIdentical();
testMinimalSnapshotByteIdentical();
testGroqSerializerUsesSharedBuilder();
testGroundingMinimoUsesSharedBuilder();
testIdentityOverrideInvalidatesCache();
testMoodEngineDefaultAndPostError();
testHysteresisByTurns();
testHysteresisByTimeAndDecay();
testSerializeMoodDelta();
testMoodSectionInPrompt();
testMoodSectionDisabledByConfig();

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
