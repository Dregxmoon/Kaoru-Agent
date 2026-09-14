'use strict';

// Paridad de permisos: la tabla única (ToolPolicy.js) es la autoridad y los
// tres consumidores deben coincidir con ella. Si agregás una tool y olvidás
// la tabla, ESTE test falla antes que un bypass llegue a producción.

const {
  TOOL_POLICY,
  policyFor,
  isAlwaysPrompt,
  alwaysPromptTools,
  toolCapabilities,
} = require('../core/security/ToolPolicy.js');
const { TOOL_CAPABILITIES } = require('../core/desktop/DesktopCapabilities.js');
const { isHighImpact } = require('../core/planner/ActionParser.js');
const { getToolSchemas } = require('../core/llm/ToolSchemas.js');
const { approvalPattern } = require('../core/security/SessionApprovals.js');
const { isIrreversible } = require('../core/security/IrreversiblePolicy.js');

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

function knownFamilies() {
  return new Set([
    'applications',
    'browser',
    'screen',
    'pointer',
    'keyboard',
    'processes',
    'camera',
  ]);
}

async function main() {
  console.log('\n── Cobertura: toda tool registrada está en la tabla ──');
  const schemas = getToolSchemas();
  assert(schemas.length > 0, 'hay schemas registrados');
  const missing = schemas.map((s) => s.name).filter((name) => !policyFor(name));
  assert(
    missing.length === 0,
    'todas las tools del catálogo están en TOOL_POLICY',
    missing.join(', ')
  );

  console.log('\n── Paridad isHighImpact ↔ tabla (tools estáticas) ──');
  let staticChecked = 0;
  for (const [name, entry] of Object.entries(TOOL_POLICY)) {
    if (entry.impact === 'dynamic') continue;
    const expected = entry.impact === 'high';
    assert(isHighImpact(name, {}) === expected, `isHighImpact('${name}', {}) === ${expected}`);
    staticChecked++;
  }
  assert(staticChecked > 40, `${staticChecked} tools estáticas verificadas`);

  console.log('\n── Dinámicas: muestras de comportamiento por params ──');
  assert(isHighImpact('exec', { command: 'ls' }) === false, "exec 'ls' es seguro");
  assert(isHighImpact('exec', { command: 'rm -rf /' }) === true, "exec 'rm -rf /' es alto impacto");
  assert(isHighImpact('read', { path: 'README.md' }) === false, 'read dentro del proyecto');
  assert(isHighImpact('read', { path: '/etc/passwd' }) === true, 'read fuera del proyecto');
  assert(isHighImpact('git_stash', { action: 'list' }) === false, 'git_stash list');
  assert(isHighImpact('git_stash', { action: 'push' }) === true, 'git_stash push');
  assert(isHighImpact('rename', {}) === false, 'rename sin newName');
  assert(isHighImpact('rename', { newName: 'x' }) === true, 'rename con newName');
  assert(isHighImpact('plugin.foo', {}) === true, 'plugin.* siempre alto impacto');
  assert(isHighImpact('herramienta-inexistente', {}) === false, 'desconocida → bajo impacto');

  console.log('\n── Paridad capabilities ↔ tabla ──');
  const derived = toolCapabilities();
  assert(
    JSON.stringify(TOOL_CAPABILITIES) === JSON.stringify(derived),
    'DesktopCapabilities deriva de la tabla (sin lista paralela)'
  );
  const families = knownFamilies();
  const badCaps = Object.entries(TOOL_POLICY)
    .filter(([, e]) => e.capability && !families.has(e.capability))
    .map(([n]) => n);
  assert(badCaps.length === 0, 'todas las capabilities son familias conocidas', badCaps.join(', '));

  console.log('\n── Invariantes de seguridad ──');
  const always = alwaysPromptTools();
  assert(always instanceof Set && always.size > 0, 'siempre-preguntar no vacío');
  const alwaysButLow = [...always].filter((name) => TOOL_POLICY[name]?.impact !== 'high');
  assert(alwaysButLow.length === 0, 'alwaysPrompt ⟹ high impact', alwaysButLow.join(', '));
  for (const name of always) {
    assert(isHighImpact(name, {}) === true, `alwaysPrompt '${name}' pide aprobación`);
  }
  // Irreversibles representativos nunca entran en autoApprove silencioso:
  // o son alwaysPrompt, o isIrreversible los frena aunque haya scope/siempre.
  assert(
    isIrreversible({ tool: 'exec', params: { command: 'rm -rf /tmp/x' } }),
    'rm -rf es irreversible'
  );
  assert(
    isIrreversible({ tool: 'browser', params: { action: 'click', text: 'Comprar ahora' } }),
    'clic en Comprar es irreversible'
  );

  console.log('\n── Aprobaciones de sesión cubren lo alto impacto ──');
  // Invariante real de seguridad: ninguna tool high puede ejecutarse sin
  // consentimiento. O tiene patrón de sesión específico (botón "Siempre"),
  // o es alwaysPrompt (card fresca SIEMPRE, ni autoApprove la salta).
  // Las UI tools sin observationId/ref devuelven null a propósito: sus refs
  // son efímeras y un patrón genérico auto-aprobaría clics futuros.
  const representativeParams = {
    ui_get_state: { observationId: 'obs-1', ref: 'ui-1' },
    ui_click: { observationId: 'obs-1', ref: 'ui-1' },
    ui_type: { observationId: 'obs-1', ref: 'ui-1', value: 'hola' },
    ui_press: { observationId: 'obs-1', ref: 'ui-1', key: 'Enter' },
    ui_select: { observationId: 'obs-1', ref: 'ui-1' },
    ui_scroll: { observationId: 'obs-1', ref: 'ui-1', direction: 'down' },
    window_focus: { observationId: 'obs-1', ref: 'ui-1' },
    window_close: { observationId: 'obs-1', ref: 'ui-1' },
    pointer_click: { captureId: 'cap-1', x: 10, y: 10 },
    process_stop: { pid: 1234 },
    launch_app: { app: 'firefox' },
    open_website: { target: 'https://example.com/' },
    play_media: { query: 'guitarra' },
    exec: { command: 'git status' },
  };
  const uncovered = Object.entries(TOOL_POLICY)
    .filter(([, e]) => e.impact === 'high')
    .map(([n]) => n)
    .filter(
      (name) =>
        approvalPattern({ tool: name, params: representativeParams[name] || {} }) == null &&
        !isAlwaysPrompt(name)
    );
  assert(uncovered.length === 0, 'toda tool high tiene patrón o card fresca', uncovered.join(', '));
  assert(
    approvalPattern({ tool: 'ui_click', params: {} }) == null,
    'ui_click sin ref NO genera patrón (refs efímeras no se auto-aprueban)'
  );

  console.log(`\nResultado: ${passed} passed  ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
