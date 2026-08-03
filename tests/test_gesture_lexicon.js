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

const Lexicon = require('../core/behavior/GestureLexicon.js');

// ── Test 1: moods canónicos ─────────────────────────────────────────────────
console.log(C.bold('\n── Test 1: moods canónicos ──────────────────────────────'));
for (const m of ['happy', 'excited', 'sad', 'tired', 'gentle', 'default', 'angry', 'surprised', 'shy', 'think']) {
  assert(Lexicon.MOODS.includes(m), `MOODS incluye ${m}`);
}
assert(Lexicon.MOODS.includes('wave') && Lexicon.MOODS.includes('dance') && Lexicon.MOODS.includes('wink'),
  'MOODS incluye acciones (wave/dance/wink)');

// ── Test 2: normalización ────────────────────────────────────────────────────
console.log(C.bold('\n── Test 2: normalización ──────────────────────────────────'));
assert(Lexicon.normalizeToken('  Angry!  ') === 'angry!', 'normalizeToken: minúsculas + trim', Lexicon.normalizeToken('  Angry!  '));
assert(Lexicon.normalizeToken('Leek_Spin-Animation') === 'leek spin animation', 'normalizeToken: separadores', Lexicon.normalizeToken('Leek_Spin-Animation'));
assert(Lexicon.normalizeToken(' 哭 ') === '哭', 'normalizeToken: conserva CJK');

// ── Test 3: tokens por mood (multilingüe) ────────────────────────────────────
console.log(C.bold('\n── Test 3: tokens por mood ─────────────────────────────────'));
const happyTokens = Lexicon.tokensFor('happy');
assert(happyTokens.includes('happy'), 'tokensFor(happy) → happy');
assert(happyTokens.includes('feliz'), 'tokensFor(happy) → feliz (ES)');
assert(happyTokens.includes('开心'), 'tokensFor(happy) → 开心 (ZH)');
assert(happyTokens.includes('嬉しい'), 'tokensFor(happy) → 嬉しい (JA)');
assert(Lexicon.tokensFor('angry').includes('黑脸'), 'tokensFor(angry) → 黑脸');
assert(Lexicon.tokensFor('cry').includes('哭'), 'tokensFor(cry) → 哭');

// ── Test 4: índice inverso ───────────────────────────────────────────────────
console.log(C.bold('\n── Test 4: índice inverso ──────────────────────────────────'));
const cryMoods = Lexicon.moodOfToken('哭');
assert(cryMoods.includes('cry'), 'moodOfToken(哭) → incluye cry', JSON.stringify(cryMoods));
const felizMoods = Lexicon.moodOfToken('feliz');
assert(felizMoods.includes('happy'), 'moodOfToken(feliz) → incluye happy', JSON.stringify(felizMoods));

// ── Test 5: ruido ────────────────────────────────────────────────────────────
console.log(C.bold('\n── Test 5: ruido ───────────────────────────────────────────'));
assert(Lexicon.isNoise('animation'), 'isNoise(animation)');
assert(Lexicon.isNoise('Idle'), 'isNoise(Idle)');
assert(Lexicon.isNoise('motions'), 'isNoise(motions)');
assert(!Lexicon.isNoise('wink'), 'isNoise(wink) → false');
assert(!Lexicon.isNoise('哭'), 'isNoise(哭) → false');

// ── Test 6: moods de acción ──────────────────────────────────────────────────
console.log(C.bold('\n── Test 6: moods de acción ─────────────────────────────────'));
assert(Lexicon.isActionMood('wave'), 'isActionMood(wave)');
assert(Lexicon.isActionMood('dance'), 'isActionMood(dance)');
assert(Lexicon.isActionMood('photo'), 'isActionMood(photo)');
assert(!Lexicon.isActionMood('sad'), 'isActionMood(sad) → false');
assert(!Lexicon.isActionMood('angry'), 'isActionMood(angry) → false');

// ── Resumen ──────────────────────────────────────────────────────────────────
console.log(C.bold(`\n── Lexicon: ${C.green(passed)}✓ ${failed ? C.red(failed + '✗') : ''} ──`));
console.log(`Resultado: ${passed} passed ${failed} failed / ${passed + failed} total`);
if (failed > 0) process.exitCode = 1;
