'use strict';

// B3 — parser bilingüe: el LLM puede emitir campos en inglés (ACTION/TARGET/
// APPLICATION/WINDOW/NAME) o español (ACCIÓN/SITIO/APLICACIÓN/VENTANA/NOMBRE).
// Ambos deben producir los mismos params. Sin regresión en español.

const { StructuredActionParser } = require('../core/planner/StructuredActionParser.js');

let passed = 0;
let failed = 0;

function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
    passed++;
  } else {
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

const parser = new StructuredActionParser(process.cwd());

function parseFirst(text, goal) {
  const actions = parser.parse(text, goal || '');
  return actions[0] || null;
}

console.log('\x1b[1m\n════ StructuredActionParser bilingüe (B3) ════\x1b[0m');

console.log('\n── open_website ES/EN ──');
let es = parseFirst('```action\nACCIÓN: open_website | SITIO: amazon\n```', 'abre amazon');
let en = parseFirst('```action\nACTION: open_website | TARGET: amazon\n```', 'open amazon');
assert(es && es.tool === 'open_website' && es.params.target === 'amazon', 'ES: SITIO → target');
assert(en && en.tool === 'open_website' && en.params.target === 'amazon', 'EN: TARGET → target');
assert(es && en && es.params.target === en.params.target, 'ES y EN producen el mismo target');

console.log('\n── launch_app ES/EN ──');
es = parseFirst('```action\nACCIÓN: launch_app | APLICACIÓN: Steam\n```', 'abre steam');
en = parseFirst('```action\nACTION: launch_app | APPLICATION: Steam\n```', 'open steam');
assert(es && es.params.app === 'Steam', 'ES: APLICACIÓN → app');
assert(en && en.params.app === 'Steam', 'EN: APPLICATION → app');
en = parseFirst('```action\nACTION: launch_app | NAME: Steam\n```', 'open steam');
assert(en && en.params.app === 'Steam', 'EN: NAME → app');

console.log('\n── desktop_snapshot ES/EN ──');
es = parseFirst('```action\nACCIÓN: desktop_snapshot | APLICACIÓN: Writer\n```', 'mira writer');
en = parseFirst('```action\nACTION: desktop_snapshot | WINDOW: Writer\n```', 'look at writer');
assert(es && es.params.application === 'Writer', 'ES: APLICACIÓN → application');
assert(en && en.params.application === 'Writer', 'EN: WINDOW → application');

console.log('\n── Sin regresión: bloques inválidos se siguen rechazando ──');
const sinCampo = parseFirst('```action\nACCIÓN: open_website\n```', 'abre algo');
assert(sinCampo === null, 'open_website sin SITIO/TARGET/URL se rechaza');
const accionRara = parser.parse('```action\nACCIÓN: volar | DESTINO: luna\n```', 'vuela');
assert(
  accionRara.length === 1 && accionRara[0].source === 'unrecognized',
  'acción desconocida se marca, no se ejecuta en silencio'
);

console.log(`\nResultado: ${passed} passed  ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
