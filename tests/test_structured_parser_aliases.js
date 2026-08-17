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

// CONTENIDO con "|" literal se preserva (fix corrupción de pipes): un "|"
// dentro del contenido es CONTENIDO, no un separador de campos. El límite de
// un campo solo aplica en una línea NUEVA tipo "CLAVE: valor".
r = parser.parse(
  '```action\nACCIÓN: edit\nARCHIVO: a.js\nCONTENIDO: nuevo | OTRO: valor\n```',
  'userGoal'
);
a = r && r.find((x) => x.tool === 'edit_file');
assert(
  a && a.params && a.params.instruction === 'nuevo | OTRO: valor',
  'CONTENIDO en línea única con | preserva el pipe (no lo parte en un campo)',
  JSON.stringify(a && a.params)
);

// CONTENIDO multilínea seguido de una línea "CLAVE: valor" SÍ marca el límite.
r = parser.parse(
  '```action\nACCIÓN: edit\nARCHIVO: a.js\nCONTENIDO: nuevo\nOTRO: valor\n```',
  'userGoal'
);
a = r && r.find((x) => x.tool === 'edit_file');
assert(
  a && a.params && a.params.instruction === 'nuevo',
  'CONTENIDO multilínea se corta en la siguiente línea "CLAVE: valor"',
  JSON.stringify(a && a.params)
);

console.log(
  C.bold(
    `\n── StructuredActionParser aliases: ${C.green(passed)}✓ ${failed ? C.red(failed + '✗') : ''} ──`
  )
);
console.log(`Resultado: ${passed} passed ${failed} failed / ${passed + failed} total`);
if (failed > 0) process.exitCode = 1;

// ── Test 6: acción no reconocida → marcador visible (2.2) ─────────────────────
console.log(C.bold('\n── Test 6: acción no reconocida → marcador visible (2.2) ─────'));
r = parser.parse('```action\nACCIÓN: hipnopatía_laser\n```', null);
let u = r && r.find((x) => x.source === 'unrecognized');
assert(!!u, 'acción desconocida devuelve marcador (no se descarta en silencio)', JSON.stringify(r));
assert(u && u.tool === 'unknown_action', 'marcador: tool = unknown_action', u && u.tool);
assert(u && u.action === 'hipnopatía_laser', 'marcador: conserva la acción original');
assert(
  !(r || []).some((x) => x.source !== 'unrecognized'),
  'no hay acciones ejecutables junto al marcador'
);

r = parser.parse('```action\nACCIÓN: answer_question\n```', null);
assert(!r || r.length === 0, 'answer_question sigue sin acción (conversacional)');

r = parser.parse('```action\nSin campo ACCIÓN\n```', null);
assert(!r || r.length === 0, 'bloque sin ACCIÓN sigue descartado (null)');

// ── Test 7: subagente por perfil (agent param) ───────────────────────────────
console.log(C.bold('\n── Test 7: subagente con perfil (agent) ───────────────────'));
r = parser.parse(
  '```action\nACCIÓN: subagent\nTAREA: revisa la API\nAGENT: investigador\n```',
  null
);
a = r && r.find((x) => x.tool === 'subagent');
assert(!!a, 'ACCIÓN: subagent → tool subagent', JSON.stringify(r));
assert(a && a.params.task === 'revisa la API', 'params.task desde TAREA', a && a.params.task);
assert(a && a.params.agent === 'investigador', 'params.agent desde AGENT', a && a.params.agent);

r = parser.parse(
  '```action\nACCIÓN: subagent\nPARAMS: {"task": "busca X", "agent": "explorador", "max_iterations": 4}\n```',
  null
);
a = r && r.find((x) => x.tool === 'subagent');
assert(
  a && a.params.task === 'busca X' && a.params.agent === 'explorador',
  'PARAMS JSON gana: task + agent',
  JSON.stringify(a && a.params)
);
assert(
  a && a.params.max_iterations === 4,
  'PARAMS JSON: max_iterations',
  a && a.params.max_iterations
);

console.log(
  C.bold(
    `\n── StructuredActionParser aliases: ${C.green(passed)}✓ ${failed ? C.red(failed + '✗') : ''} ──`
  )
);
console.log(`Resultado: ${passed} passed ${failed} failed / ${passed + failed} total`);
if (failed > 0) process.exitCode = 1;
