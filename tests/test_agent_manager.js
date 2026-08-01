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

// Clear module cache so each test gets fresh state
function fresh() {
  delete require.cache[require.resolve('../core/agents/AgentManager.js')];
  return require('../core/agents/AgentManager.js');
}

// ── Test 1: defaults ───────────────────────────────────────────────────
function testDefaults() {
  const m = fresh();
  const active = m.getActive();
  assert(active !== null, 'getActive no es null');
  assert(active.name === 'conversation', 'Agente por defecto es conversation');
  assert(active.mode === 'conversational', 'Modo por defecto es conversational');
}

// ── Test 2: setActive ────────────────────────────────────────────────────
function testSetActive() {
  const m = fresh();
  const switched = m.setActive('coder');
  assert(switched !== null, 'setActive("coder") retorna agente');
  assert(switched.name === 'coder', 'Agente activo es coder');
  assert(m.getActive().name === 'coder', 'getActive refleja el cambio');
  assert(m.getMode() === 'task', 'Modo es task para coder');
}

// ── Test 3: setActive inválido ──────────────────────────────────────────
function testSetInvalid() {
  const m = fresh();
  const result = m.setActive('inexistente');
  assert(result === null, 'setActive con nombre inválido retorna null');
  assert(m.getActive().name === 'conversation', 'No cambia el activo');
}

// ── Test 4: getAll ──────────────────────────────────────────────────────
function testGetAll() {
  const m = fresh();
  const all = m.getAll();
  assert(all.length === 4, '4 agentes disponibles');
  const names = all.map(a => a.name);
  assert(names.includes('conversation'), 'Incluye conversation');
  assert(names.includes('coder'), 'Incluye coder');
  assert(names.includes('reviewer'), 'Incluye reviewer');
  assert(names.includes('planner'), 'Incluye planner');
}

// ── Test 5: getSystemPrompt ─────────────────────────────────────────────
function testGetSystemPrompt() {
  const m = fresh();
  const prompt = m.getSystemPrompt('coder');
  assert(prompt.includes('desarrolladora'), 'System prompt de coder incluye "desarrolladora"');
  assert(prompt.includes('programación'), 'Prompt de coder describe el modo');
}

// ── Test 6: getSystemPrompt agente activo ───────────────────────────────
function testGetActiveSystemPrompt() {
  const m = fresh();
  m.setActive('reviewer');
  const prompt = m.getSystemPrompt();
  assert(prompt.includes('code review'), 'System prompt activo es de reviewer');
  assert(prompt.includes('Bugs'), 'Prompt de reviewer menciona bugs');
}

// ── Test 7: getSystemPrompt agente inválido ─────────────────────────────
function testGetInvalidSystemPrompt() {
  const m = fresh();
  const prompt = m.getSystemPrompt('inexistente');
  assert(prompt === '', 'System prompt para agente inválido es string vacío');
}

// ── Test 8: get ──────────────────────────────────────────────────────────
function testGet() {
  const m = fresh();
  const agent = m.get('planner');
  assert(agent !== null, 'get("planner") retorna agente');
  assert(agent.name === 'planner', 'Nombre correcto');
  assert(agent.description.includes('plan'), 'Descripción correcta');
}

// ── Test 9: get inválido ────────────────────────────────────────────────
function testGetInvalid() {
  const m = fresh();
  assert(m.get('') === null, 'get("") retorna null');
  assert(m.get('noop') === null, 'get("noop") retorna null');
}

// ── Test 10: getMode ─────────────────────────────────────────────────────
function testGetMode() {
  const m = fresh();
  assert(m.getMode() === 'conversational', 'Modo por defecto conversational');
  assert(m.getMode('coder') === 'task', 'Modo coder es task');
  assert(m.getMode('reviewer') === 'task', 'Modo reviewer es task');
  assert(m.getMode('planner') === 'task', 'Modo planner es task');
}

// ── Test 11: getAll con nombres descriptivos ─────────────────────────────
function testGetAllLabels() {
  const m = fresh();
  const all = m.getAll();
  assert(all.every(a => a.label), 'Todos tienen label');
  assert(all.every(a => a.description), 'Todos tienen description');
}

// ── Test 12: BUILTIN_AGENTS integridad ───────────────────────────────────
function testBuiltinIntegrity() {
  const m = fresh();
  assert(m.BUILTIN_AGENTS.length === 4, '4 agentes builtin');
  for (const agent of m.BUILTIN_AGENTS) {
    assert(agent.name, `name definido para ${agent.name}`);
    assert(agent.label, `label definido para ${agent.name}`);
    assert(agent.systemPrompt, `systemPrompt definido para ${agent.name}`);
    assert(agent.description, `description definido para ${agent.name}`);
    assert(agent.mode, `mode definido para ${agent.name}`);
  }
}

// ── Test 13: setActive notifica cambios ──────────────────────────────────
function testSetActiveReturnsFull() {
  const m = fresh();
  m.setActive('coder');
  const active = m.getActive();
  assert(active.label === 'Programación', 'Label de coder correcto');
  assert(active.description.includes('Análisis'), 'Descripción de coder correcta');
}

// ── Test 14: modo task para agentes de código ───────────────────────────
function testCodeAgentModes() {
  const m = fresh();
  assert(m.getMode('coder') === 'task', 'coder en modo task');
  assert(m.getMode('reviewer') === 'task', 'reviewer en modo task');
  assert(m.getMode('planner') === 'task', 'planner en modo task');
  assert(m.getMode('conversation') === 'conversational', 'conversation en modo conversational');
}

// ── Run ─────────────────────────────────────────────────────────────────
console.log(C.bold('\n🤖 AgentManager Tests\n'));

testDefaults();
testSetActive();
testSetInvalid();
testGetAll();
testGetSystemPrompt();
testGetActiveSystemPrompt();
testGetInvalidSystemPrompt();
testGet();
testGetInvalid();
testGetMode();
testGetAllLabels();
testBuiltinIntegrity();
testSetActiveReturnsFull();
testCodeAgentModes();

const total = passed + failed;
console.log(`\n${C.bold(C.cyan(`🤖 AgentManager: ${passed}/${total} tests passed`))}${failed > 0 ? C.red(` (${failed} failed)`) : C.green(' ✅')}`);
module.exports = { passed, failed };
