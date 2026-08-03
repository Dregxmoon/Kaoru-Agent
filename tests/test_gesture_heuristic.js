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

const path = require('path');
const ModelAugmenter  = require('../core/behavior/ModelAugmenter.js');
const GestureHeuristic = require('../core/behavior/GestureHeuristic.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'models', 'gtest', 'gtest.model3.json');

// ── Test 1: descubrimiento y dedupe ──────────────────────────────────────────
console.log(C.bold('\n── Test 1: descubrimiento y dedupe ─────────────────────────'));
const g = ModelAugmenter.listGestures(FIXTURE);
const expNames = g.expressions.map(e => e.name);
assert(expNames.length === 2, 'solo 2 expresiones (referenciada + descubierta; sub/1.exp3.json deduplicado por basename)', JSON.stringify(expNames));
assert(expNames.includes('Feliz'), 'expresión referenciada conserva su Name ("Feliz")');
assert(expNames.includes('angry'), 'expresión descubierta toma el nombre del archivo ("angry")');

const feliz = g.expressions.find(e => e.name === 'Feliz');
assert(feliz && feliz.referenced === true, 'Feliz marcada como referenced');
const angry = g.expressions.find(e => e.name === 'angry');
assert(angry && angry.referenced === false, 'angry marcada como no referenced');

const motNames = g.motions.map(m => `${m.name}:${m.group}#${m.index}`);
assert(g.motions.length === 3, '3 motions (Idle Animation + sing + wave)', JSON.stringify(motNames));
const idle = g.motions.find(m => m.name === 'Idle Animation');
assert(idle && idle.group === 'Idle', 'motion con nombre idle → grupo Idle');
const wave = g.motions.find(m => m.name === 'wave');
assert(wave && wave.group === 'motions' && wave.index === 1, 'wave → grupo motions, index 1', JSON.stringify(wave));

// ── Test 2: augmentModel construye settings válidos ──────────────────────────
console.log(C.bold('\n── Test 2: augmentModel ────────────────────────────────────'));
const { settings, gestures } = ModelAugmenter.augmentModel(FIXTURE);
assert(settings !== null, 'augmentModel devuelve settings');
assert(typeof settings.url === 'string' && settings.url.startsWith('file:///'), 'settings.url presente', settings.url);
assert(Array.isArray(settings.FileReferences.Expressions) && settings.FileReferences.Expressions.length === 2,
  'FileReferences.Expressions inyectadas');
assert(settings.FileReferences.Motions && Object.keys(settings.FileReferences.Motions).length === 2,
  'FileReferences.Motions inyectadas (Idle + motions)');
assert(settings.FileReferences.Moc === 'gtest.moc3', 'preserva Moc original');
assert(settings.Groups && settings.Groups.length === 2, 'preserva Groups originales');
assert(gestures === ModelAugmenter.listGestures(FIXTURE), 'cache devuelve el mismo objeto de gestos');

// ── Test 3: resolveMood ──────────────────────────────────────────────────────
console.log(C.bold('\n── Test 3: resolveMood ─────────────────────────────────────'));
let r = GestureHeuristic.resolveMood('angry', g);
assert(r.ok && r.gesture.name === 'angry', 'angry → gesto "angry"', JSON.stringify(r));
r = GestureHeuristic.resolveMood('happy', g);
assert(r.ok && r.gesture.name === 'Feliz', 'happy → "Feliz" (via léxico ES)', JSON.stringify(r));
r = GestureHeuristic.resolveMood('default', g);
assert(r.ok && r.gesture.name === 'Idle Animation', 'default → animación del grupo Idle', JSON.stringify(r));
r = GestureHeuristic.resolveMood('sing', g);
assert(r.ok && r.gesture.name === 'sing', 'sing → motion "sing"', JSON.stringify(r));
r = GestureHeuristic.resolveMood('shy', g);
assert(!r.ok, 'shy → sin coincidencia en el fixture', JSON.stringify(r));

// ── Test 4: mappings explícitos ──────────────────────────────────────────────
console.log(C.bold('\n── Test 4: mappings explícitos ─────────────────────────────'));
r = GestureHeuristic.resolveMood('angry', g, { mappings: { angry: 'sing' } });
assert(r.ok && r.gesture.name === 'sing' && r.source === 'config', 'mapping config gana a la heurística', JSON.stringify(r));

// ── Test 5: falsos positivos cortos ──────────────────────────────────────────
console.log(C.bold('\n── Test 5: falsos positivos ────────────────────────────────'));
// "hi"/"no" (tokens latin de 2 letras) no deben matchear por substring.
r = GestureHeuristic.resolveMood('shake', g);
assert(!r.ok || r.gesture.name !== 'Idle Animation', '"no" no genera substring falso');
assert(GestureHeuristic.scoreGesture({ name: 'white eyes', kind: 'expression' }, 'wave') === 0,
  '"hi" no puntúa sobre "white eyes"');
assert(GestureHeuristic.scoreGesture({ name: 'No Maidens', kind: 'expression' }, 'shake') === 0,
  '"no" no puntúa sobre "No Maidens"');

// ── Test 6: resolveAll + describeGesture ─────────────────────────────────────
console.log(C.bold('\n── Test 6: resolveAll + describeGesture ────────────────────'));
const all = GestureHeuristic.resolveAll(g);
assert(all.map['happy'] && all.map['happy'].name === 'Feliz', 'resolveAll: happy→Feliz');
assert(all.map['default'] && all.map['default'].name === 'Idle Animation', 'resolveAll: default→Idle Animation');
assert(all.map['sing'] && all.map['sing'].name === 'sing', 'resolveAll: sing→sing');
assert(Array.isArray(all.unmapped), 'resolveAll: unmapped es array');

const desc = GestureHeuristic.describeGesture({ name: 'Angry', kind: 'expression' });
assert(desc.includes('angry'), 'describeGesture(Angry) → angry', JSON.stringify(desc));
const desc2 = GestureHeuristic.describeGesture({ name: '哭', kind: 'expression' });
assert(desc2.includes('cry'), 'describeGesture(哭) → cry', JSON.stringify(desc2));

// ── Test 7: motions referenciadas en el model3.json ───────────────────────────
console.log(C.bold('\n── Test 7: motions referenciadas ─────────────────────────────'));
const GREF = path.join(__dirname, 'fixtures', 'models', 'gref', 'gref.model3.json');
const gr = ModelAugmenter.listGestures(GREF);
const grMots = gr.motions.map(m => `${m.name}:${m.group}${m.referenced ? '*' : ''}`);
assert(gr.motions.length === 4, 'motions referenciadas + descubierta entran al listado (4)', JSON.stringify(grMots));
const gIdle = gr.motions.find(m => m.name === 'idle0');
assert(gIdle && gIdle.group === 'Idle' && gIdle.referenced === true,
  'motion referenciada bajo grupo "" se re-clasifica por nombre → Idle', JSON.stringify(gIdle));
const gMtn = gr.motions.find(m => m.name === 'mtn_00');
assert(gMtn && gMtn.group === 'Idle' && gMtn.referenced === true,
  'motion referenciada bajo Motions.Idle preserva el grupo Idle (aunque el archivo no diga idle)', JSON.stringify(gMtn));
const gWave = gr.motions.find(m => m.name === 'wave');
assert(gWave && gWave.group === 'motions' && gWave.referenced === true,
  'motion referenciada bajo grupo "" no-idle → motions', JSON.stringify(gWave));
assert(gr.motions.some(m => m.name === 'extra' && m.referenced === false),
  'motion descubierta en disco también entra');
assert(!gr.motions.some(m => m.name === 'idle0' && !m.referenced),
  'duplicado por basename (anim/sub/idle0) no entra dos veces');
const augRef = ModelAugmenter.augmentModel(GREF);
assert(augRef.settings.FileReferences.Motions.Idle && augRef.settings.FileReferences.Motions.Idle.length === 2,
  'settings inyecta ambas motions idle (idle0 + mtn_00) bajo grupo Idle', JSON.stringify(augRef.settings.FileReferences.Motions));

// ── Resumen ──────────────────────────────────────────────────────────────────
console.log(C.bold(`\n── GestureHeuristic: ${C.green(passed)}✓ ${failed ? C.red(failed + '✗') : ''} ──`));
console.log(`Resultado: ${passed} passed ${failed} failed / ${passed + failed} total`);
if (failed > 0) process.exitCode = 1;
