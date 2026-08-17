'use strict';

// @ts-check
// Regresión del bug CRÍTICO de corrupción de pipes en StructuredActionParser:
// _parseBlockContent normalizaba "|" → salto de línea sobre TODO el bloque ANTES
// de extraer CONTENIDO, así que los "|" literales del contenido (operador "||"
// de JS, alternancia de regex, tablas markdown) se escribían corruptos en disco.
//
// Ahora CONTENIDO se extrae crudo ANTES de la normalización (igual que PARAMS),
// y el contenido se preserva exacto. El único separador de campos real es una
// línea NUEVA "CLAVE: valor".

const fs = require('fs');
const os = require('os');
const path = require('path');

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
const parser = getStructuredActionParser(os.tmpdir());

function parseWrite(block, userGoal = 'userGoal') {
  const r = parser.parse(`\`\`\`action\n${block}\n\`\`\``, userGoal);
  const a = r && r.find((x) => x.tool === 'create_file' || x.tool === 'write');
  return a && a.params;
}

// Escribe params.instruction a disco y verifica que los bytes coinciden con el
// contenido esperado (simula el flujo create_file real: params.instruction → fs).
function assertWrittenExact(block, expected, label) {
  const p = parseWrite(block);
  assert(p && p.path, `${label}: params.path presente`, JSON.stringify(p));
  assert(
    p && p.instruction === expected,
    `${label}: instruction === contenido exacto`,
    JSON.stringify(p && p.instruction) + ' != ' + JSON.stringify(expected)
  );
  if (!p || p.instruction !== expected) return;
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-test-')),
    p.path.split('/').pop()
  );
  fs.writeFileSync(file, p.instruction, 'utf8');
  const onDisk = fs.readFileSync(file, 'utf8');
  assert(onDisk === expected, `${label}: bytes en disco idénticos (sin corrupción)`);
  try {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  } catch {}
}

// ── Test 1: operador "||" de JS se preserva exacto ───────────────────────────
console.log(C.bold('\n── Test 1: CONTENIDO con "||" de JS se preserva exacto ───────'));
const jsContent = [
  'const value = a || b;',
  'const ok = x && y;',
  'if (a || b) {',
  '  run();',
  '}',
].join('\n');
assertWrittenExact(
  `ACCIÓN: write\nARCHIVO: utils.js\nCONTENIDO: ${jsContent}`,
  jsContent,
  'write con "||"'
);

// También en el formato compacto de UNA línea (ACCIÓN | ARCHIVO | CONTENIDO).
const compactJs = 'const x = a || b; const y = c && d;';
assertWrittenExact(
  `ACCIÓN: write | ARCHIVO: compact.js | CONTENIDO: ${compactJs}`,
  compactJs,
  'write compacto 1-línea con "||"'
);

// ── Test 2: "|" simple (markdown / regex) se preserva exacto ─────────────────
console.log(C.bold('\n── Test 2: CONTENIDO con "|" simple se preserva exacto ────────'));
const markdown = '| Col A | Col B |\n| --- | --- |\n| v1 | v2 |';
assertWrittenExact(
  `ACCIÓN: write\nARCHIVO: docs/tabla.md\nCONTENIDO: ${markdown}`,
  markdown,
  'write con tabla markdown'
);

const regex = 'const re = /^([a-z]+|\\d+)$/;';
assertWrittenExact(
  `ACCIÓN: write\nARCHIVO: re.js\nCONTENIDO: ${regex}`,
  regex,
  'write con alternancia de regex a|b'
);

// ── Test 3: formato compacto sin CONTENIDO multilínea sigue parseando ────────
console.log(C.bold('\n── Test 3: compacto 1-línea sin CONTENIDO multilínea ──────────'));
let r = parser.parse('```action\nACCIÓN: run_command | COMANDO: git status\n```', null);
let a = r && r.find((x) => x.tool === 'exec');
assert(!!a, 'run_command compacto → tool exec', JSON.stringify(r));
assert(a && a.params && a.params.command === 'git status', 'exec: params.command = "git status"');

r = parser.parse('```action\nACCIÓN: read | ARCHIVO: src/main.js\n```', null);
a = r && r.find((x) => x.tool === 'read');
assert(!!a, 'read compacto → tool read');
assert(a && a.params && a.params.path === 'src/main.js', 'read: params.path = src/main.js');

r = parser.parse('```action\nACCIÓN: edit | ARCHIVO: a.js | CONTENIDO: hola\n```', null);
a = r && r.find((x) => x.tool === 'edit_file');
assert(!!a, 'edit compacto con CONTENIDO → tool edit_file');
assert(a && a.params && a.params.instruction === 'hola', 'edit compacto: instruction = "hola"');

// ── Test 4: límite de campo = línea nueva "CLAVE: valor", no "|" ─────────────
console.log(C.bold('\n── Test 4: límite de campo solo en línea nueva ────────────────'));
const multi = ['const a = 1;', 'const b = 2;'].join('\n');
const p = parseWrite(
  `ACCIÓN: write\nARCHIVO: multi.js\nCONTENIDO: ${multi}\nNOTA: contenido a continuación`
);
assert(
  p && p.instruction === multi,
  'CONTENIDO multilínea se corta en la línea NUEVA "NOTA:" (no en un "|" de contenido)',
  JSON.stringify(p && p.instruction)
);
assert(p && p.path === 'multi.js', 'campo ARCHIVO anterior intacto');

// Un campo DESPUÉS de un CONTENIDO se sigue capturando (antes todo lo que
// seguía a CONTENIDO se descartaba). Con exec lo vemos en params.command.
r = parser.parse('```action\nACCIÓN: exec\nCONTENIDO: data | nota\nCOMANDO: ls -la\n```', null);
a = r && r.find((x) => x.tool === 'exec');
assert(!!a, 'exec con CONTENIDO previo → tool exec', JSON.stringify(r));
assert(
  a && a.params && a.params.command === 'ls -la',
  'COMANDO tras un CONTENIDO multilínea se captura (no se pierde)',
  JSON.stringify(a && a.params)
);

// La frontera NO aplica dentro del contenido: una línea de código no se confunde
// con un campo aunque lleve ":".
const withColon = 'const obj = { a: 1 };\nreturn obj;';
const p2 = parseWrite(`ACCIÓN: write\nARCHIVO: obj.js\nCONTENIDO: ${withColon}`);
assert(
  p2 && p2.instruction === withColon,
  'línea de código con ":" dentro de CONTENIDO se preserva',
  JSON.stringify(p2 && p2.instruction)
);

console.log(C.bold('\n──────────────────────────────────────────────────────────────────'));
const total = passed + failed;
console.log(
  C.bold(
    `  Resultado: ${C.green(passed + ' passed')}  ${failed > 0 ? C.red(failed + ' failed') : C.dim('0 failed')}  / ${total} total`
  )
);
console.log(C.bold('──────────────────────────────────────────────────────────────────\n'));

process.exit(failed === 0 ? 0 : 1);
