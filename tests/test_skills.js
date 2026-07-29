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
const { SkillManager, _parseFrontmatter } = require('../core/skills/SkillManager.js');

// ── Test 1: Parseo de frontmatter ─────────────────────────────────────
function testParseFrontmatter() {
  const raw = `---
description: "Test skill description"
version: "2.0.0"
domains: ["code", "git"]
---

# Skill Body

Content here`;
  const { meta, body } = _parseFrontmatter(raw);
  assert(meta.description === 'Test skill description', 'Extrae description del frontmatter');
  assert(meta.version === '2.0.0', 'Extrae version del frontmatter');
  assert(Array.isArray(meta.domains), 'domains es array');
  assert(meta.domains.length === 2, 'domains tiene 2 elementos');
  assert(meta.domains[0] === 'code', 'primer domain es code');
  assert(body.includes('Skill Body'), 'Extrae el body');
  assert(body.includes('Content here'), 'Body completo preservado');
}

// ── Test 2: Parseo sin frontmatter ─────────────────────────────────────
function testParseNoFrontmatter() {
  const raw = `# Solo body\n\nSin frontmatter.\n---\nEsto no es frontmatter.`;
  const { meta, body } = _parseFrontmatter(raw);
  assert(meta.description === '', 'Sin frontmatter → description vacío');
  assert(meta.version === '1.0.0', 'Sin frontmatter → version default');
  assert(body === raw.trim(), 'Sin frontmatter → body completo');
}

// ── Test 3: Parseo con frontmatter incompleto ──────────────────────────
function testParsePartialFrontmatter() {
  const raw = `---
description: "Solo descripción"
---

Body`;
  const { meta, body } = _parseFrontmatter(raw);
  assert(meta.description === 'Solo descripción', 'Description extraída');
  assert(meta.version === '1.0.0', 'Version default cuando no está en frontmatter');
  assert(body === 'Body', 'Body extraído');
}

// ── Test 4: Scan descubre skills del directorio real ───────────────────
async function testScanDiscoversSkills() {
  const skillsDir = path.resolve(process.cwd(), 'skills');
  if (!fs.existsSync(skillsDir)) {
    console.log(`  ${C.yellow('⚠')} skills/ no existe, saltando testScan`);
    skipped++;
    return;
  }

  const sm = new SkillManager({ skillsDir });
  const skills = await sm.scan(true);
  assert(skills.length >= 3, `Encuentra al menos 3 skills (encontró ${skills.length})`);
  const names = skills.map(s => s.name);
  assert(names.includes('git-workflow'), 'Encuentra skill git-workflow');
  assert(names.includes('code-review'), 'Encuentra skill code-review');
  assert(names.includes('testing-patterns'), 'Encuentra skill testing-patterns');

  const gitSkill = skills.find(s => s.name === 'git-workflow');
  assert(gitSkill.description.includes('git'), 'git-workflow tiene description');
  assert(gitSkill.content.length > 100, 'git-workflow tiene contenido sustancial');
  assert(gitSkill.version === '1.0.0', 'git-workflow tiene version');
  assert(gitSkill.replaces_domains === null, 'git-workflow no tiene replaces_domains (no definido en frontmatter)');
}

// ── Test 5: Scan con replaces_domains ─────────────────────────────────
async function testScanReplacesDomains() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-rd-'));
  fs.mkdirSync(path.join(tmpDir, 'replacer'));
  fs.writeFileSync(path.join(tmpDir, 'replacer', 'SKILL.md'), `---
description: "Skill that replaces tools"
version: "1.0.0"
domains: ["code", "git"]
replaces_domains: ["filesystem", "web"]
---
Body`);

  const sm = new (require('../core/skills/SkillManager.js').SkillManager)({
    skillsDir: tmpDir,
  });
  const skills = await sm.scan(true);
  assert(skills.length === 1, 'Skill con replaces_domains se escanea');
  assert(Array.isArray(skills[0].replaces_domains), 'replaces_domains es array');
  assert(skills[0].replaces_domains.length === 2, '2 replaces_domains');
  assert(skills[0].replaces_domains.includes('filesystem'), 'replaces_domains incluye filesystem');
  assert(skills[0].replaces_domains.includes('web'), 'replaces_domains incluye web');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── Test 6: Scan ignora directorios sin SKILL.md ───────────────────────
async function testScanIgnoresNoSkillMd() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-test-'));
  fs.mkdirSync(path.join(tmpDir, 'empty-dir'));
  fs.mkdirSync(path.join(tmpDir, 'has-skill'));
  fs.writeFileSync(path.join(tmpDir, 'has-skill', 'SKILL.md'), `---\ndescription: "Test"\n---\nBody`);
  fs.mkdirSync(path.join(tmpDir, 'no-skill'));
  fs.writeFileSync(path.join(tmpDir, 'no-skill', 'README.md'), 'not a skill');

  const sm = new SkillManager({ skillsDir: tmpDir });
  const skills = await sm.scan(true);
  assert(skills.length === 1, 'Solo 1 skill válida (has-skill)');
  assert(skills[0].name === 'has-skill', 'La skill encontrada es has-skill');
  assert(skills[0].content === 'Body', 'Contenido correcto');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── Test 6: SkillManager.getSkill ──────────────────────────────────────
async function testGetSkill() {
  const skillsDir = path.resolve(process.cwd(), 'skills');
  if (!fs.existsSync(skillsDir)) { skipped++; return; }

  const sm = new SkillManager({ skillsDir });
  await sm.scan(true);
  const skill = sm.getSkill('git-workflow');
  assert(skill !== null, 'getSkill git-workflow no es null');
  assert(skill.name === 'git-workflow', 'Nombre correcto');
  assert(skill.description.length > 0, 'Tiene description');

  const missing = sm.getSkill('no-existe');
  assert(missing === null, 'getSkill para skill inexistente retorna null');
}

// ── Test 7: getAllSkills ───────────────────────────────────────────────
async function testGetAllSkills() {
  const skillsDir = path.resolve(process.cwd(), 'skills');
  if (!fs.existsSync(skillsDir)) { skipped++; return; }

  const sm = new SkillManager({ skillsDir });
  await sm.scan(true);
  const all = sm.getAllSkills();
  assert(all.length >= 3, 'getAllSkills devuelve todas');
  assert(all.every(s => s.name), 'Cada skill tiene name');
  assert(all.every(s => s.description), 'Cada skill tiene description');
}

// ── Tests que requieren DB ─────────────────────────────────────────────
// Se ejecutan con una base de datos en memoria (sqlite-vec + better-sqlite3)
// Si no están disponibles, se saltan.

async function testWithDB(description, fn) {
  let db;
  try {
    const Database = require('better-sqlite3');
    const sqliteVec = require('sqlite-vec');
    db = new Database(':memory:');
    sqliteVec.load(db);
  } catch {
    console.log(`  ${C.yellow('⚠')} better-sqlite3/sqlite-vec no disponible, saltando: ${description}`);
    skipped++;
    return;
  }
  try {
    await fn(db);
  } finally {
    if (db) db.close();
  }
}

// ── Test 8: Indexar skills en DB ────────────────────────────────────────
function testIndexSkills() {
  return testWithDB('Index skills', async (db) => {
    const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-index-'));
    fs.mkdirSync(path.join(skillsDir, 'skill-a'));
    fs.writeFileSync(path.join(skillsDir, 'skill-a', 'SKILL.md'), `---
description: "How to use git for version control"
---
# Git skill
Content about git operations`);

    fs.mkdirSync(path.join(skillsDir, 'skill-b'));
    fs.writeFileSync(path.join(skillsDir, 'skill-b', 'SKILL.md'), `---
description: "How to test JavaScript code"
---
# Testing skill
Content about testing`);

    const sm = new SkillManager({ skillsDir, db, threshold: 0.5 });
    const skills = await sm.scan(true);
    assert(skills.length === 2, '2 skills escaneadas');

    const indexed = await sm.index(skills);
    assert(indexed === 2, '2 skills indexadas');

    const count = db.prepare('SELECT COUNT(*) as cnt FROM skill_catalog').get();
    assert(count.cnt === 2, 'skill_catalog tiene 2 filas');

    const vecCount = db.prepare('SELECT COUNT(*) as cnt FROM skill_vectors').get();
    assert(vecCount.cnt === 2, 'skill_vectors tiene 2 filas');

    fs.rmSync(skillsDir, { recursive: true, force: true });
  });
}

// ── Test 9: Index es idempotente ────────────────────────────────────────
function testIndexIdempotent() {
  return testWithDB('Index idempotent', async (db) => {
    const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-idem-'));
    fs.mkdirSync(path.join(skillsDir, 'skill-x'));
    fs.writeFileSync(path.join(skillsDir, 'skill-x', 'SKILL.md'), `---
description: "Unique test skill"
---
Content`);

    const sm = new SkillManager({ skillsDir, db });
    await sm.scan(true);
    const first = await sm.index();
    assert(first === 1, 'Primera indexación: 1 skill');

    const second = await sm.index();
    assert(second === 0, 'Segunda indexación: 0 nuevas (idempotente)');

    const count = db.prepare('SELECT COUNT(*) as cnt FROM skill_catalog').get();
    assert(count.cnt === 1, 'Solo 1 fila después de indexación repetida');

    fs.rmSync(skillsDir, { recursive: true, force: true });
  });
}

// ── Test 10: Match skills por similitud semántica ───────────────────────
function testMatchSkills() {
  return testWithDB('Match skills', async (db) => {
    const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-match-'));
    fs.mkdirSync(path.join(skillsDir, 'git-skill'));
    fs.writeFileSync(path.join(skillsDir, 'git-skill', 'SKILL.md'), `---
description: "Version control with git: commits, branches, merges"
---
# Git Content
Content about git workflow`);

    fs.mkdirSync(path.join(skillsDir, 'test-skill'));
    fs.writeFileSync(path.join(skillsDir, 'test-skill', 'SKILL.md'), `---
description: "Writing and running tests for Node.js projects"
---
# Test Content
Content about testing`);

    const sm = new SkillManager({ skillsDir, db, threshold: 0.5, topK: 3 });
    await sm.scan(true);
    await sm.index();

    const gitMatches = await sm.match('quiero hacer un commit de git', db);
    assert(gitMatches.length >= 1, 'Match para query de git devuelve resultados');
    const hasGit = gitMatches.some(m => m.name === 'git-skill');
    assert(hasGit, 'Query de git matchea git-skill');

    const testMatches = await sm.match('necesito escribir tests para mi codigo', db);
    assert(testMatches.length >= 1, 'Match para query de test devuelve resultados');
    const hasTest = testMatches.some(m => m.name === 'test-skill');
    assert(hasTest, 'Query de test matchea test-skill');

    fs.rmSync(skillsDir, { recursive: true, force: true });
  });
}

// ── Test 11: Match con query genérica no activa skills ─────────────────
function testMatchGeneric() {
  return testWithDB('Match generic', async (db) => {
    const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-gen-'));
    fs.mkdirSync(path.join(skillsDir, 'skill-a'));
    fs.writeFileSync(path.join(skillsDir, 'skill-a', 'SKILL.md'), `---
description: "Advanced Kubernetes cluster management and deployment"
---
# K8s Content`);

    fs.mkdirSync(path.join(skillsDir, 'skill-b'));
    fs.writeFileSync(path.join(skillsDir, 'skill-b', 'SKILL.md'), `---
description: "Deep learning model training with PyTorch and TensorFlow"
---
# ML Content`);

    const sm = new SkillManager({ skillsDir, db, threshold: 0.72, topK: 3 });
    await sm.scan(true);
    await sm.index();

    const matches = await sm.match('hola como estas', db);
    assert(matches.length === 0, 'Query genérica no activa skills (threshold 0.72)');

    fs.rmSync(skillsDir, { recursive: true, force: true });
  });
}

// ── Test 12: buildInjection devuelve texto formateado ──────────────────
function testBuildInjection() {
  return testWithDB('buildInjection', async (db) => {
    const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-inject-'));
    fs.mkdirSync(path.join(skillsDir, 'git-skill'));
    fs.writeFileSync(path.join(skillsDir, 'git-skill', 'SKILL.md'), `---
description: "Git version control operations"
---
# Git Content
Detailed git workflows.`);

    const sm = new SkillManager({ skillsDir, db, threshold: 0.5 });
    await sm.scan(true);
    await sm.index();

    const result = await sm.buildInjection('haz un commit de git', db);
    assert(result !== null, 'buildInjection devuelve texto');
    assert(result.includes('Skills activas'), 'Texto incluye cabecera de skills');
    assert(result.includes('git-skill'), 'Texto incluye nombre de skill');
    assert(result.includes('Git Content'), 'Texto incluye contenido de skill');

    const noMatch = await sm.buildInjection('tiempo en paris', db);
    assert(noMatch === null, 'buildInjection sin match devuelve null');

    fs.rmSync(skillsDir, { recursive: true, force: true });
  });
}

// ── Test 13: ensureIndexed no reindexa si ya hay datos ─────────────────
function testEnsureIndexed() {
  return testWithDB('ensureIndexed', async (db) => {
    const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-ensure-'));
    fs.mkdirSync(path.join(skillsDir, 'test-skill'));
    fs.writeFileSync(path.join(skillsDir, 'test-skill', 'SKILL.md'), `---
description: "Test skill"
---
Content`);

    const sm = new SkillManager({ skillsDir, db });
    await sm.scan(true);

    const first = await sm.ensureIndexed();
    assert(first === true, 'Primera vez: ensureIndexed indexa (true)');

    const second = await sm.ensureIndexed();
    assert(second === false, 'Segunda vez: ensureIndexed no reindexa (false)');

    fs.rmSync(skillsDir, { recursive: true, force: true });
  });
}

// ── Test 14: Score y distance son coherentes ────────────────────────────
function testScoreConsistency() {
  return testWithDB('Score consistency', async (db) => {
    const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-score-'));
    fs.mkdirSync(path.join(skillsDir, 'test-skill'));
    fs.writeFileSync(path.join(skillsDir, 'test-skill', 'SKILL.md'), `---
description: "JavaScript testing with Node.js and assertions"
---
Content`);

    const sm = new SkillManager({ skillsDir, db, threshold: 0.3, topK: 5 });
    await sm.scan(true);
    await sm.index();

    const matches = await sm.match('como escribo tests en javascript', db);
    if (matches.length > 0) {
      assert(typeof matches[0].score === 'number', 'score es número');
      assert(matches[0].score >= 0 && matches[0].score <= 1, 'score entre 0 y 1');
      assert(typeof matches[0].distance === 'number', 'distance es número');
      assert(matches[0].distance >= 0, 'distance >= 0');
      assert(Math.abs(matches[0].score - (1 - matches[0].distance)) < 0.001,
        'score + distance ≈ 1');
    }

    fs.rmSync(skillsDir, { recursive: true, force: true });
  });
}

// ── Run ─────────────────────────────────────────────────────────────────
console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
console.log(C.bold(C.cyan('  March 7th — Test Suite: Skills — Fase 4')));
console.log(C.bold(C.cyan('════════════════════════════════════════════════════════')));

async function main() {
  // Tests sin DB (siempre corren)
  console.log(C.bold('\n── Parseo de SKILL.md ─────────────────────────────────'));
  testParseFrontmatter();
  testParseNoFrontmatter();
  testParsePartialFrontmatter();

  console.log(C.bold('\n── Escaneo de skills ──────────────────────────────────'));
  await testScanDiscoversSkills();
  await testScanReplacesDomains();
  await testScanIgnoresNoSkillMd();
  await testGetSkill();
  await testGetAllSkills();

  console.log(C.bold('\n── Indexado en DB ─────────────────────────────────────'));
  await testIndexSkills();
  await testIndexIdempotent();

  console.log(C.bold('\n── Matching semántico ──────────────────────────────────'));
  await testMatchSkills();
  await testMatchGeneric();
  await testBuildInjection();
  await testEnsureIndexed();
  await testScoreConsistency();

  const total = passed + failed;
  console.log(C.bold('\n════════════════════════════════════════════════════════'));
  console.log(
    C.bold(`  Resultado: ${C.green(passed + ' passed')}  ${failed > 0 ? C.red(failed + ' failed') : C.dim('0 failed')}  ${skipped > 0 ? C.yellow(skipped + ' skipped') : ''}  / ${total + skipped} total`)
  );
  console.log(C.bold('════════════════════════════════════════════════════════\n'));
  if (failed > 0) process.exit(1);
}

main().catch(e => {
  console.error(C.red('\nERROR FATAL:'), e.message);
  console.error(e.stack);
  process.exit(1);
});

module.exports = { passed, failed, skipped };
