'use strict';

// ── _stripForbiddenPhrases: red de seguridad post-LLM ────────────────────────
// Verifica que la función _stripForbiddenPhrases (LLMProvider) elimina
// literalmente las forbidden_phrases de identity.json del texto de respuesta,
// sin romper el resto del contenido. Defensa en profundidad sobre el system
// prompt (que ya incluye la instrucción, pero el LLM puede ignorarla).

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
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
const identity = require('../core/identity/identity.json');

const forbidden = identity?.voice?.forbidden_phrases || [];

async function main() {
  console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
  console.log(C.bold('  Forbidden phrases filter: defensa post-LLM'));
  console.log(C.bold(C.cyan('════════════════════════════════════════════════════════')));

  // ── Test 1: identity.json tiene forbidden phrases definidas ──────────────
  console.log(C.cyan('\n── Test 1: identity.json tiene forbidden_phrases ─────'));
  assert(Array.isArray(forbidden) && forbidden.length > 0, 'forbidden_phrases es array no vacío', `found: ${forbidden.length}`);
  assert(forbidden.includes('¡Excelente pregunta!'), '"¡Excelente pregunta!" está en la lista');

  // ── Test 2: cada frase prohibida se elimina ─────────────────────────────
  console.log(C.cyan('\n── Test 2: cada frase prohibida se elimina ─────────────'));
  for (const phrase of forbidden) {
    const input = `Hola, ${phrase} bienvenido a todo.`;
    const result = LLMProvider._debug_stripForbiddenPhrases(input);
    assert(
      !result.includes(phrase),
      `elimina "${phrase}"`,
      `input: "${input}"\n     output: "${result}"`
    );
  }

  // ── Test 3: el texto que NO contiene prohibidas queda intacto ───────────
  console.log(C.cyan('\n── Test 3: texto sin prohibidas queda intacto ───────────'));
  const clean = '¡Hola! ¿Qué tal tu día? Me alegra verte.';
  const resultClean = LLMProvider._debug_stripForbiddenPhrases(clean);
  assert(resultClean === clean, 'texto limpio sin cambios', `output: "${resultClean}"`);

  // ── Test 4: caso mixto — una frase prohibida en medio de texto real ──────
  console.log(C.cyan('\n── Test 4: caso mixto ──────────────────────────────────'));
  const mixed = '¡Excelente pregunta! Te explico cómo funciona el sistema.';
  const resultMixed = LLMProvider._debug_stripForbiddenPhrases(mixed);
  assert(
    !resultMixed.includes('¡Excelente pregunta!'),
    'elimina la frase prohibida del medio',
    `output: "${resultMixed}"`
  );
  assert(
    resultMixed.includes('Te explico cómo funciona el sistema.'),
    'conserva el texto restante',
    `output: "${resultMixed}"`
  );

  // ── Test 5: case-insensitive ────────────────────────────────────────────
  console.log(C.cyan('\n── Test 5: case-insensitive ────────────────────────────'));
  const upperInput = '¡EXCELENTE PREGUNTA! eso es lo que pensaba.';
  const resultUpper = LLMProvider._debug_stripForbiddenPhrases(upperInput);
  assert(
    !resultUpper.toLowerCase().includes('excelente pregunta'),
    'elimina case-insensitive',
    `output: "${resultUpper}"`
  );

  // ── Test 6: texto vacío / null ──────────────────────────────────────────
  console.log(C.cyan('\n── Test 6: edge cases ──────────────────────────────────'));
  assert(LLMProvider._debug_stripForbiddenPhrases('') === '', 'string vacío → vacío');
  assert(LLMProvider._debug_stripForbiddenPhrases(null) === null, 'null → null');
  assert(LLMProvider._debug_stripForbiddenPhrases(undefined) === undefined, 'undefined → undefined');

  // ── Test 7: dobles espacios se limpian ──────────────────────────────────
  console.log(C.cyan('\n── Test 7: limpieza de espacios dobles ─────────────────'));
  const spaced = 'Hola  mundo   con    espacios.';
  const resultSpaced = LLMProvider._debug_stripForbiddenPhrases(spaced);
  assert(
    resultSpaced === 'Hola mundo con espacios.',
    'colapsa dobles espacios a uno',
    `output: "${resultSpaced}"`
  );

  // ── Test 8: saltos de línea múltiples se colapsan ───────────────────────
  console.log(C.cyan('\n── Test 8: colapsar saltos múltiples ───────────────────'));
  const multiline = 'Línea uno\n\n\n\n\nLínea dos';
  const resultMultiline = LLMProvider._debug_stripForbiddenPhrases(multiline);
  assert(
    !resultMultiline.includes('\n\n\n'),
    'máximo 2 saltos consecutivos',
    `output: "${resultMultiline}"`
  );

  // ── Resumen ─────────────────────────────────────────────────────────────
  console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
  console.log(
    C.bold(
      `  Forbidden phrases filter: ${C.green(`${passed} passed`)}  ${C.red(`${failed} failed`)}  / ${passed + failed} total`
    )
  );
  console.log(C.bold(C.cyan('════════════════════════════════════════════════════════')));

  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((e) => {
  console.error(C.red(`\n${e.message}\n${e.stack}`));
  process.exitCode = 1;
});
