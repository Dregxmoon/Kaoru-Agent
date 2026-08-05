'use strict';

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

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  readProjectRules,
  buildRulesSection,
  clearRulesCache,
  MAX_RULES_CHARS,
} = require('../core/rules/ProjectRules.js');

// ── Test 1: lectura y precedencia ──────────────────────────────────────────

function testPrecedence() {
  console.log(C.bold('\n── Precedencia de archivos de reglas ─────────────────────────'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-rules-'));
  try {
    fs.writeFileSync(path.join(tmp, 'AGENTS.md'), 'AGENTS content');
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), 'CLAUDE content');
    fs.writeFileSync(path.join(tmp, '.cursorrules'), 'CURSOR content');
    clearRulesCache();
    const rules = readProjectRules(tmp);
    assert(rules === 'AGENTS content', 'AGENTS.md tiene prioridad sobre CLAUDE.md/.cursorrules');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function testFallback() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-fallback-'));
  try {
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), 'Solo CLAUDE');
    clearRulesCache();
    const rules = readProjectRules(tmp);
    assert(rules === 'Solo CLAUDE', 'CLAUDE.md como fallback cuando no hay AGENTS.md');

    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-none-'));
    try {
      clearRulesCache();
      assert(readProjectRules(tmp2) === '', 'sin archivo de reglas → cadena vacía');
    } finally {
      fs.rmSync(tmp2, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ── Test 2: sección del prompt ─────────────────────────────────────────────

function testSection() {
  console.log(C.bold('\n── Sección del system prompt ────────────────────────────────'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-sec-'));
  try {
    fs.writeFileSync(path.join(tmp, 'AGENTS.md'), 'No uses never más. Corre npm test.');
    clearRulesCache();
    const section = buildRulesSection(tmp);
    assert(section.startsWith('# REGLAS DEL PROYECTO'), 'sección con header de reglas');
    assert(section.includes('No uses never más.'), 'el contenido de AGENTS.md está en la sección');
    assert(section.includes('PRIORIDAD'), 'la sección declara prioridad sobre reglas generales');

    assert(buildRulesSection(tmp) === section, 'caché devuelve el mismo contenido');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ── Test 3: truncado y caché por mtime ─────────────────────────────────────

function testTruncateAndCache() {
  console.log(C.bold('\n── Truncado y caché ─────────────────────────────────────────'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-trunc-'));
  try {
    const big = 'X'.repeat(MAX_RULES_CHARS + 500);
    fs.writeFileSync(path.join(tmp, 'AGENTS.md'), big);
    clearRulesCache();
    const rules = readProjectRules(tmp);
    assert(
      rules.length <= MAX_RULES_CHARS + 80,
      `reglas truncadas al presupuesto (${rules.length} <= ${MAX_RULES_CHARS + 80})`
    );
    assert(rules.includes('truncadas por longitud'), 'marca de truncado presente');

    // mtime cambia → la caché se invalida
    clearRulesCache();
    fs.writeFileSync(path.join(tmp, 'AGENTS.md'), 'Nuevo contenido corto');
    const updated = readProjectRules(tmp);
    assert(updated === 'Nuevo contenido corto', 'relectura tras cambio de contenido');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────

console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
console.log(C.bold(C.cyan('  Test Suite: ProjectRules — reglas de proyecto (AGENTS.md)')));
console.log(C.bold(C.cyan('════════════════════════════════════════════════════════')));

testPrecedence();
testFallback();
testSection();
testTruncateAndCache();

console.log(C.bold('\n════════════════════════════════════════════════════════'));
const total = passed + failed;
if (failed === 0) {
  console.log(
    `  ${C.green('Resultado')}: ${C.green(`${passed} passed`)}  ${C.dim(`0 failed`)}  / ${total} total`
  );
} else {
  console.log(
    `  Resultado: ${C.green(`${passed} passed`)}  ${C.red(`${failed} failed`)}  / ${total} total`
  );
}
console.log(C.bold('════════════════════════════════════════════════════════'));

if (failed > 0) process.exit(1);
