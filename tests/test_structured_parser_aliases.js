'use strict';

// Verifica el fix de aliases modernos en StructuredActionParser:
// el LLM en fallback textual usa write/edit/read y exec (no solo los nombres
// legacy create_file/edit_file/read_file/run_command).

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
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

const { getStructuredActionParser } = require('../core/planner/StructuredActionParser.js');

const parser = getStructuredActionParser('/tmp');

// ── Test 1: alias write → create_file ────────────────────────────────────────
console.log(C.bold('\n── Test 1: alias modernos write/edit/read ─────────────────'));
let r = parser.parse(
  '```action\nACCIÓN: write\nARCHIVO: hola.txt\nCONTENIDO: hola\n```',
  'crea hola.txt'
);
let a = r && r.find((x) => x.tool === 'create_file');
assert(!!a, 'ACCIÓN: write → tool create_file', JSON.stringify(r));
assert(
  a && a.params && a.params.path === 'hola.txt',
  'write: params.path = hola.txt',
  JSON.stringify(a && a.params)
);
assert(
  a && a.params && typeof a.params.instruction === 'string' && a.params.instruction.length > 0,
  'write: params.instruction presente (para el flujo create_file)',
  JSON.stringify(a && a.params)
);

r = parser.parse('```action\nACCIÓN: edit\nARCHIVO: a.js\nCONTENIDO: nuevo\n```', 'edita a.js');
a = r && r.find((x) => x.tool === 'edit_file');
assert(!!a, 'ACCIÓN: edit → tool edit_file', JSON.stringify(r));
assert(a && a.params && a.params.path === 'a.js', 'edit: params.path = a.js');

r = parser.parse('```action\nACCIÓN: read\nARCHIVO: a.js\n```', null);
a = r && r.find((x) => x.tool === 'read');
assert(!!a, 'ACCIÓN: read → tool read', JSON.stringify(r));
assert(a && a.params && a.params.path === 'a.js', 'read: params.path = a.js');

// ── Test 2: exec no cae en {raw: fields} ─────────────────────────────────────
console.log(C.bold('\n── Test 2: exec extrae COMANDO (no raw) ────────────────────'));
r = parser.parse('```action\nACCIÓN: exec\nCOMANDO: npm test\n```', null);
a = r && r.find((x) => x.tool === 'exec');
assert(!!a, 'ACCIÓN: exec → tool exec', JSON.stringify(r));
assert(
  a && a.params && a.params.command === 'npm test',
  'exec: params.command = "npm test" (sin wrapper raw)',
  JSON.stringify(a && a.params)
);
assert(a && !('raw' in (a.params || {})), 'exec: params NO contiene campo raw');

// ── Test 3: legacy sigue funcionando (no regresión) ──────────────────────────
console.log(C.bold('\n── Test 3: nombres legacy intactos ─────────────────────────'));
r = parser.parse('```action\nACCIÓN: create_file\nARCHIVO: b.txt\n```', 'crea b.txt');
assert(!!(r && r.find((x) => x.tool === 'create_file')), 'create_file legacy OK');
r = parser.parse('```action\nACCIÓN: run_command\nCOMANDO: ls\n```', null);
assert(!!(r && r.find((x) => x.tool === 'exec')), 'run_command legacy OK');

// ── Test 4: CONTENIDO se usa como instruction (no userGoal) ──────────────────
console.log(C.bold('\n── Test 4: CONTENIDO → instruction en write/edit ────────────'));
r = parser.parse(
  '```action\nACCIÓN: write\nARCHIVO: hola.txt\nCONTENIDO: hola\n```',
  'el userGoal NO debe ser el contenido'
);
a = r && r.find((x) => x.tool === 'create_file');
assert(!!a, 'write con CONTENIDO → create_file');
assert(
  a && a.params && a.params.instruction === 'hola',
  'write: instruction = CONTENIDO ("hola"), no el userGoal',
  JSON.stringify(a && a.params)
);
assert(
  a && a.params && a.params.instruction !== 'el userGoal NO debe ser el contenido',
  'write: instruction NO es el userGoal'
);

// ── Test 5: CONTENIDO multilínea se captura completo ─────────────────────────
console.log(C.bold('\n── Test 5: CONTENIDO multilínea ────────────────────────────'));
r = parser.parse(
  '```action\nACCIÓN: write\nARCHIVO: docs/README.md\nCONTENIDO: # Demo\n\nProyecto demo v1.0.0.\nIncluye src/index.js.\n```',
  'userGoal'
);
a = r && r.find((x) => x.tool === 'create_file');
assert(!!a, 'write multilínea → create_file');
assert(
  a &&
    a.params &&
    a.params.instruction === '# Demo\n\nProyecto demo v1.0.0.\nIncluye src/index.js.',
  'instruction conserva el contenido completo (multilínea)',
  JSON.stringify(a && a.params && a.params.instruction)
);

// CONTENIDO seguido de otro campo en la misma línea se corta ahí
r = parser.parse(
  '```action\nACCIÓN: edit\nARCHIVO: a.js\nCONTENIDO: nuevo | OTRO: valor\n```',
  'userGoal'
);
a = r && r.find((x) => x.tool === 'edit_file');
assert(
  a && a.params && a.params.instruction === 'nuevo',
  'CONTENIDO en línea única con | se corta en el siguiente campo',
  JSON.stringify(a && a.params)
);

console.log(
  C.bold(
    `\n── StructuredActionParser aliases: ${C.green(passed)}✓ ${failed ? C.red(failed + '✗') : ''} ──`
  )
);
console.log(`Resultado: ${passed} passed ${failed} failed / ${passed + failed} total`);
if (failed > 0) process.exitCode = 1;
