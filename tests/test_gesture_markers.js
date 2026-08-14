'use strict';

// test_gesture_markers.js — pruebas del parser de marcadores (gesto: x) que el
// LLM intercala en sus respuestas. Las funciones viven en el renderer
// (src/chat/process.js), así que el test las extrae del fuente y las evalúa en
// un sandbox mínimo (mismas funciones, sin DOM).

const fs = require('fs');
const path = require('path');

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
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

// ── Extraer funciones del fuente de process.js ────────────────────────────────
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'chat', 'process.js'), 'utf8');

const MARKER_RE_BLOCK = src.match(/_gestureMarkerRe = (.*?);/s)[1];

function grabFn(name, deps = {}) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`no se encontró la función ${name}`);
  // Encontrar el cierre de la función: balancear llaves desde el primer '{'.
  const openIdx = src.indexOf('{', start);
  let depth = 0;
  let end = openIdx;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  const fnBody = src.slice(openIdx + 1, end - 1);
  const argNames = ['_gestureMarkerRe', ...Object.keys(deps), 'console'];
  const argVals = [_gestureMarkerRe, ...Object.values(deps), console];
  return new Function(
    ...argNames,
    `'use strict';\nfunction ${name}(${_paramsOf(src, start, openIdx)}) {\n${fnBody}\n}\nreturn ${name};`
  )(...argVals);
}

function _paramsOf(src, start, openIdx) {
  const head = src.slice(start, openIdx);
  const m = head.match(/^function \w+\(([^)]*)\)/);
  return m ? m[1] : '';
}

const _gestureMarkerRe = eval(`(${MARKER_RE_BLOCK})`);
const _parseGestureMarkers = grabFn('_parseGestureMarkers');
const _playGesture = grabFn('_playGesture', {
  chatGestureEngine: { enabled: true, setEmotion() {} },
});
const _processStreamingGestures = grabFn('_processStreamingGestures', { _playGesture });
const _maskUnclosedGesture = grabFn('_maskUnclosedGesture');

// ⚠  Las funciones fueron extraídas del fuente; verificar que existan.
if (!_parseGestureMarkers) throw new Error('_parseGestureMarkers no extraída');
if (!_processStreamingGestures) throw new Error('_processStreamingGestures no extraída');
if (!_maskUnclosedGesture) throw new Error('_maskUnclosedGesture no extraída');

console.log(C.bold('\n── Test 1: parseo básico ─────────────────────────────────────'));
(() => {
  const { clean, markers } = _parseGestureMarkers('(gesto: wave) ¡Hola!');
  assert(clean === ' ¡Hola!', 'se elimina el marcador del texto visible', JSON.stringify(clean));
  assert(
    markers.length === 1 && markers[0].mood === 'wave',
    'un marker con mood wave',
    JSON.stringify(markers)
  );
  assert(markers[0].pos === 0, 'pos 0 cuando el marcador va al inicio');
})();

(() => {
  const { clean, markers } = _parseGestureMarkers('¡(gesto: happy) Perfecto, ya quedó!');
  assert(
    clean === '¡ Perfecto, ya quedó!',
    'marcador en mitad de frase se elimina',
    JSON.stringify(clean)
  );
  assert(markers.length === 1 && markers[0].mood === 'happy', 'mood happy detectado');
  assert(
    markers[0].pos === 1,
    'pos refleja la posición en el texto limpio',
    `pos=${markers[0].pos}`
  );
})();

(() => {
  const { clean, markers } = _parseGestureMarkers('(gesto: think) espera… (gesto: happy) listo');
  assert(markers.length === 2, 'dos marcadores', JSON.stringify(markers));
  assert(markers[0].mood === 'think' && markers[1].mood === 'happy', 'moods en orden');
  assert(markers[1].pos > markers[0].pos, 'posiciones crecientes');
})();

(() => {
  const { clean, markers } = _parseGestureMarkers('texto sin marcadores');
  assert(clean === 'texto sin marcadores' && markers.length === 0, 'sin marcadores → intacto');
})();

(() => {
  const { clean, markers } = _parseGestureMarkers('(gesto: 照相) foto');
  assert(
    markers.length === 1 && markers[0].mood === '照相',
    'mood con nombre CJK (modelos otros idiomas)'
  );
})();

(() => {
  const { clean, markers } = _parseGestureMarkers(null);
  assert(clean === '' && markers.length === 0, 'null → limpio vacío sin error');
})();

console.log(C.bold('\n── Test 2: streaming ────────────────────────────────────────'));
(() => {
  // Marcador que llega entero en un token.
  const out = _processStreamingGestures('hola (gesto: wave) mundo');
  assert(out === 'hola  mundo', 'marcador completo se elimina del buffer', JSON.stringify(out));
})();

(() => {
  // Marcador cortado entre tokens: "ha" llega en un token, "ppy)" en el siguiente.
  let buf = 'hola (gesto: ha';
  buf = _processStreamingGestures(buf);
  assert(buf === 'hola (gesto: ha', 'marcador a medias aún NO se elimina', JSON.stringify(buf));
  buf += 'ppy) adiós';
  buf = _processStreamingGestures(buf);
  assert(buf === 'hola  adiós', 'se completa y se elimina', JSON.stringify(buf));
})();

(() => {
  // Múltiples marcadores en un solo flush.
  const out = _processStreamingGestures('(gesto: happy)a(gesto: wink)b');
  assert(out === 'ab', 'dos marcadores en un flush', JSON.stringify(out));
})();

console.log(C.bold('\n── Test 3: máscara de marcador sin cerrar ───────────────────'));
(() => {
  const out = _maskUnclosedGesture('esto es (gesto: th');
  assert(out === 'esto es ', 'fragmento sin cerrar se oculta', JSON.stringify(out));
})();

(() => {
  const out = _maskUnclosedGesture('esto es (gesto: think) completo');
  assert(out === 'esto es (gesto: think) completo', 'marcador cerrado NO se oculta');
})();

(() => {
  const out = _maskUnclosedGesture('texto plano');
  assert(out === 'texto plano', 'sin marcador → intacto');
})();

console.log(C.bold('\n── Test 4: GestureVocabulary (core) ────────────────────────'));
(() => {
  const { buildGestureSection } = require('../core/behavior/GestureVocabulary.js');
  const empty = buildGestureSection('');
  assert(empty === '', 'sin model3Path → sección vacía');

  const noModel = buildGestureSection('/no/existe/model3.json');
  assert(noModel === '', 'ruta inexistente → sección vacía (sin lanzar)');
})();

console.log(
  `\n${C.bold('Resultado:')} ${C.green(passed + ' ok')} · ${failed ? C.red(failed + ' fallaron') : '0 fallaron'}\n`
);
if (failed > 0) process.exit(1);
