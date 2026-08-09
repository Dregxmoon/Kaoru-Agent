'use strict';

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

const path = require('path');
const fs = require('fs');
const os = require('os');

// ── Test 1: Scan on non-existent directory ────────────────────────────
async function testScanNonexistentDir() {
  const sm = new (require('../core/skills/SkillManager.js').SkillManager)({
    skillsDir: '/tmp/ruta-inexistente-xyz-99999',
  });
  const skills = await sm.scan(true);
  assert(Array.isArray(skills), 'scan en dir inexistente retorna array');
  assert(skills.length === 0, 'scan en dir inexistente retorna array vacío');
  assert(sm._skillsCache !== null, 'cache se actualiza incluso vacía');
}

// ── Test 2: Scan with invalid SKILL.md (broken frontmatter) ───────────
async function testScanBrokenFrontmatter() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-broken-'));
  fs.mkdirSync(path.join(tmpDir, 'bad-skill'));
  fs.writeFileSync(
    path.join(tmpDir, 'bad-skill', 'SKILL.md'),
    `---
description: "Good skill"
version: "1.0"
---
Body content`
  );

  fs.mkdirSync(path.join(tmpDir, 'no-frontmatter'));
  fs.writeFileSync(
    path.join(tmpDir, 'no-frontmatter', 'SKILL.md'),
    `---
Only a dash line, not real frontmatter
---

Content`
  );

  fs.mkdirSync(path.join(tmpDir, 'empty-body'));
  fs.writeFileSync(
    path.join(tmpDir, 'empty-body', 'SKILL.md'),
    `---
description: "Empty body skill"
---
`
  );

  const sm = new (require('../core/skills/SkillManager.js').SkillManager)({
    skillsDir: tmpDir,
  });
  const skills = await sm.scan(true);
  assert(
    skills.length === 2,
    '2 skills válidas (bad-skill + empty-body, no-frontmatter se ignora por falta de descripción)'
  );
  assert(
    skills.some((s) => s.name === 'bad-skill'),
    'bad-skill incluida'
  );
  assert(
    skills.some((s) => s.name === 'empty-body'),
    'empty-body incluida'
  );
  const eb = skills.find((s) => s.name === 'empty-body');
  assert(
    eb.content.includes('Empty body'),
    'empty-body tiene content igual a description (fallback)'
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── Test 3: SKILL.md with unicode description ─────────────────────────
async function testScanUnicode() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-unicode-'));
  fs.mkdirSync(path.join(tmpDir, 'unicode-skill'));
  fs.writeFileSync(
    path.join(tmpDir, 'unicode-skill', 'SKILL.md'),
    `---
description: "Gestión de archivos: ñoño, résumé, 中文, 日本語, українська"
version: "2.0.0"
---
Body with unicode: ñoño résumé`
  );

  const sm = new (require('../core/skills/SkillManager.js').SkillManager)({
    skillsDir: tmpDir,
  });
  const skills = await sm.scan(true);
  assert(skills.length === 1, 'Skill con unicode se escanea');
  assert(skills[0].description.includes('ñoño'), 'Description preserva unicode');
  assert(skills[0].description.includes('中文'), 'Description preserva chino');
  assert(skills[0].content.includes('ñoño'), 'Content preserva unicode');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── Test 4: Duplicate skill names in different directories ────────────
async function testScanDuplicateNames() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-dup-'));
  fs.mkdirSync(path.join(tmpDir, 'same-name'));
  fs.writeFileSync(
    path.join(tmpDir, 'same-name', 'SKILL.md'),
    `---
description: "First same-name"
---
First body`
  );

  // Can't have two dirs with same name in filesystem, so this is fine
  // This tests that the scan doesn't crash if somehow there are duplicates

  const sm = new (require('../core/skills/SkillManager.js').SkillManager)({
    skillsDir: tmpDir,
  });
  const skills = await sm.scan(true);
  assert(skills.length === 1, 'Solo 1 skill (nombres únicos de directorio)');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── Test 5: getSkill with empty cache ──────────────────────────────────
function testGetSkillNoCache() {
  const sm = new (require('../core/skills/SkillManager.js').SkillManager)();
  const skill = sm.getSkill('anything');
  assert(skill === null, 'getSkill sin scan retorna null');
}

// ── Test 6: getAllSkills with empty cache ──────────────────────────────
function testGetAllNoCache() {
  const sm = new (require('../core/skills/SkillManager.js').SkillManager)();
  const all = sm.getAllSkills();
  assert(Array.isArray(all), 'getAllSkills sin scan retorna array');
  assert(all.length === 0, 'getAllSkills sin scan retorna vacío');
}

// ── Test 7: buildInjection without DB → error handling ─────────────────
async function testBuildInjectionNoDB() {
  const sm = new (require('../core/skills/SkillManager.js').SkillManager)({
    skillsDir: path.resolve(process.cwd(), 'skills'),
  });
  try {
    const result = await sm.buildInjection('hola mundo');
    assert(result === null, 'buildInjection sin DB retorna null (no explota)');
  } catch (e) {
    const msg = e.message || '';
    assert(
      msg.toLowerCase().includes('db') || msg.toLowerCase().includes('conexion'),
      `Error menciona DB: "${msg.slice(0, 80)}"`
    );
  }
}

// ── Test 8: Empty skills directory in AgentLoop integration ────────────
async function testAgentLoopEmptySkills() {
  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentloop-skills-'));
  const sm = new (require('../core/skills/SkillManager.js').SkillManager)({
    skillsDir: tmpDir,
  });
  await sm.scan(true);

  const loop = new AgentLoop({ maxIterations: 1 });

  // Mock LLM that returns a text response
  const mockLLM = async () => 'Respuesta de prueba sin herramientas.';

  try {
    const result = await loop.run('test', 'System prompt', [], {
      skillManager: sm,
      llm: mockLLM,
      taskIntent: null,
    });
    assert(result.response.includes('Respuesta'), 'AgentLoop con skills vacías funciona');
    assert(!result.error, 'Sin error');
  } catch (e) {
    assert(false, `AgentLoop con skills vacías no debe lanzar: ${e.message}`);
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── Test 9: Multiple rapid scans don't cause issues ────────────────────
async function testMultipleScans() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-multi-'));
  fs.mkdirSync(path.join(tmpDir, 'skill-a'));
  fs.writeFileSync(
    path.join(tmpDir, 'skill-a', 'SKILL.md'),
    `---
description: "Skill A"
---
A body`
  );

  const sm = new (require('../core/skills/SkillManager.js').SkillManager)({
    skillsDir: tmpDir,
  });

  const r1 = await sm.scan(true);
  assert(r1.length === 1, 'Primer scan encuentra 1 skill');

  const r2 = await sm.scan(false);
  assert(r2.length === 1, 'Segundo scan (cache) encuentra 1 skill');
  assert(r1 === r2, 'Cache devuelve misma referencia');

  // Add a new skill and force re-scan
  fs.mkdirSync(path.join(tmpDir, 'skill-b'));
  fs.writeFileSync(
    path.join(tmpDir, 'skill-b', 'SKILL.md'),
    `---
description: "Skill B"
---
B body`
  );

  const r3 = await sm.scan(true);
  assert(r3.length === 2, 'Tercer scan (force) encuentra 2 skills');
  assert(r1 !== r3, 'Force refresh devuelve nueva referencia');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── Test 10: Very long description strings ─────────────────────────────
async function testLongDescription() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-long-'));
  fs.mkdirSync(path.join(tmpDir, 'long-skill'));
  const longDesc = 'A '.repeat(500) + 'description';
  fs.writeFileSync(
    path.join(tmpDir, 'long-skill', 'SKILL.md'),
    `---
description: "${longDesc}"
---
Body`
  );

  const sm = new (require('../core/skills/SkillManager.js').SkillManager)({
    skillsDir: tmpDir,
  });
  const skills = await sm.scan(true);
  assert(skills.length === 1, 'Skill con descripción larga se escanea');
  assert(skills[0].description.length > 500, 'Description larga preservada');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── Test 11: Symbols in frontmatter ────────────────────────────────────
async function testSymbolsInFrontmatter() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-symbols-'));
  fs.mkdirSync(path.join(tmpDir, 'symbol-skill'));
  fs.writeFileSync(
    path.join(tmpDir, 'symbol-skill', 'SKILL.md'),
    `---
description: "Skill with @ symbol and # and $ and % and & and * and ( and ) and ! and ?"
version: "1.0.0-beta+exp.sha.5114f85"
domains: ["code", "@special", "test#1"]
---
Body with symbols: @ # $ %`
  );

  const sm = new (require('../core/skills/SkillManager.js').SkillManager)({
    skillsDir: tmpDir,
  });
  const skills = await sm.scan(true);
  assert(skills.length === 1, 'Skill con símbolos en frontmatter se escanea');

  const skill = skills[0];
  assert(skill.description.includes('@'), 'Description con @');
  assert(skill.description.includes('$'), 'Description con $');
  assert(skill.version.includes('beta'), 'Version con pre-release tag');
  assert(skill.domains.length === 3, '3 domains incluyendo @special');
  assert(skill.content.includes('@'), 'Content con símbolos');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── Test 12: SKILL.md with only description, no content ────────────────
async function testDescriptionOnly() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-desc-only-'));
  fs.mkdirSync(path.join(tmpDir, 'desc-only'));
  fs.writeFileSync(
    path.join(tmpDir, 'desc-only', 'SKILL.md'),
    `---
description: "Solo descripción, sin contenido útil"
---
`
  );

  const sm = new (require('../core/skills/SkillManager.js').SkillManager)({
    skillsDir: tmpDir,
  });
  const skills = await sm.scan(true);
  assert(skills.length === 1, 'Skill con solo frontmatter se escanea');
  assert(
    skills[0].content.includes('Solo descripción'),
    'Content es el description (fallback cuando no hay body)'
  );
  assert(
    skills[0].description === 'Solo descripción, sin contenido útil',
    'Description preservada'
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── Test 13: Non-directory entries in skills/ ──────────────────────────
async function testFileInSkillsDir() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-file-'));
  fs.writeFileSync(path.join(tmpDir, 'README.md'), 'not a skill');
  fs.writeFileSync(path.join(tmpDir, '.gitkeep'), '');
  fs.mkdirSync(path.join(tmpDir, 'real-skill'));
  fs.writeFileSync(
    path.join(tmpDir, 'real-skill', 'SKILL.md'),
    `---
description: "Real skill"
---
Real body`
  );

  const sm = new (require('../core/skills/SkillManager.js').SkillManager)({
    skillsDir: tmpDir,
  });
  const skills = await sm.scan(true);
  assert(skills.length === 1, 'Archivos sueltos en skills/ no se confunden con skills');
  assert(skills[0].name === 'real-skill', 'Solo la skill real se encuentra');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── Test 14: Frontmatter with colons in values ─────────────────────────
async function testColonsInValues() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-colons-'));
  fs.mkdirSync(path.join(tmpDir, 'colon-skill'));
  fs.writeFileSync(
    path.join(tmpDir, 'colon-skill', 'SKILL.md'),
    `---
description: "Time: 10:30 AM - Location: Building 7"
version: "v2:3:4"
---
Body: with: colons`
  );

  const sm = new (require('../core/skills/SkillManager.js').SkillManager)({
    skillsDir: tmpDir,
  });
  const skills = await sm.scan(true);
  assert(skills.length === 1, 'Skill con colons en valores se escanea');
  assert(skills[0].description.includes('10:30'), 'Description con colons preservada');
  assert(skills[0].version.includes('v2'), 'Version con colons preservada');
  assert(skills[0].content.includes('colons'), 'Content con colons preservado');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── Test 15: No frontmatter closing delimiter ──────────────────────────
async function testUnclosedFrontmatter() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-unclosed-'));
  fs.mkdirSync(path.join(tmpDir, 'unclosed'));
  fs.writeFileSync(
    path.join(tmpDir, 'unclosed', 'SKILL.md'),
    `---
description: "No closing delimiter"
version: "1.0"
Body that should be treated as frontmatter`
  );

  const sm = new (require('../core/skills/SkillManager.js').SkillManager)({
    skillsDir: tmpDir,
  });
  const skills = await sm.scan(true);
  // Without closing `---`, everything is frontmatter, no body
  // The "description" will be parsed from what looks like frontmatter
  assert(skills.length === 1, 'SKILL.md sin cierre de frontmatter se escanea');
  assert(
    skills[0].description.includes('closing'),
    'Description se extrajo de frontmatter abierto'
  );
  assert(
    skills[0].content.includes('closing'),
    'Content es el description (fallback cuando no hay body)'
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── Run ─────────────────────────────────────────────────────────────────
console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
console.log(C.bold(C.cyan('  Skills — Edge Cases & Stress Tests')));
console.log(C.bold(C.cyan('════════════════════════════════════════════════════════')));

async function main() {
  console.log(C.bold('\n── Casos extremos de scan ─────────────────────────────'));
  await testScanNonexistentDir();
  await testScanBrokenFrontmatter();
  await testScanUnicode();
  await testScanDuplicateNames();
  await testFileInSkillsDir();
  await testColonsInValues();
  await testUnclosedFrontmatter();

  console.log(C.bold('\n── Casos extremos de datos ────────────────────────────'));
  await testLongDescription();
  await testSymbolsInFrontmatter();
  await testDescriptionOnly();
  await testMultipleScans();

  console.log(C.bold('\n── Sin estado/cache ───────────────────────────────────'));
  testGetSkillNoCache();
  testGetAllNoCache();

  console.log(C.bold('\n── Integración con AgentLoop ──────────────────────────'));
  await testBuildInjectionNoDB();
  await testAgentLoopEmptySkills();

  const total = passed + failed;
  console.log(C.bold('\n════════════════════════════════════════════════════════'));
  console.log(
    C.bold(
      `  Resultado: ${C.green(passed + ' passed')}  ${failed > 0 ? C.red(failed + ' failed') : C.dim('0 failed')}  ${skipped > 0 ? C.yellow(skipped + ' skipped') : ''}  / ${total + skipped} total`
    )
  );
  console.log(C.bold('════════════════════════════════════════════════════════\n'));
  require('../core/grounding/EmbedService.js').dispose();
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(C.red('\nERROR FATAL:'), e.message);
  console.error(e.stack);
  process.exit(1);
});

module.exports = { passed, failed, skipped };
