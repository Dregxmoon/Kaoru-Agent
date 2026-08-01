'use strict';

/**
 * Fase F-2 — test del normalizador de señales.
 *
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron tests/test_signal_normalizer.js
 *
 * Verifica que los payloads brutos reales de los sensores (GitWatcher,
 * SystemWatcher, LSPErrorWatcher, TitleWatcher, ClipboardWatcher,
 * UpcomingEventsWatcher) se convierten en candidatos con el vector de señal
 * {severity, actionability, salience, costOfIgnore} que consume F-1.
 */

const { normalize, registerProfile } = require('../core/decision/SignalNormalizer.js');

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red:   (s) => `\x1b[31m${s}\x1b[0m`,
  cyan:  (s) => `\x1b[36m${s}\x1b[0m`,
  bold:  (s) => `\x1b[1m${s}\x1b[0m`,
  dim:   (s) => `\x1b[2m${s}\x1b[0m`,
};

let passed = 0;
let failed = 0;

function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  ${C.green('✓')} ${label}`);
    passed++;
  } else {
    console.log(`  ${C.red('✗')} ${label}${detail ? `\n    ${C.dim(detail)}` : ''}`);
    failed++;
  }
}

function inRange(v, lo, hi, label) {
  return assert(v >= lo && v <= hi, label, `got=${v}`);
}

// ── Test 1: filtrado ─────────────────────────────────────────────────────────

function testFiltering() {
  console.log(C.bold('\nTest 1: qué es una señal proactiva'));

  assert(normalize('git:redflag', { kind: 'uncommitted', count: 5, message: 'x' }) !== null, 'git:redflag → candidato');
  assert(normalize('no:existe', {}) === null, 'desconocido sin datos → null (no es señal)');
  assert(normalize('os:idle-changed', { idle: true }) === null, 'contexto (idle) → no es candidato');
  assert(normalize('behavior:evaluated', {}) === null, 'contexto (behavior) → no es candidato');
  assert(normalize('git:redflag', null) === null, 'sin payload → null');

  const empty = normalize('git:redflag', {});
  assert(empty !== null && empty.kind === 'default', 'payload sin kind → kind=default');
}

// ── Test 2: candidato bien formado ───────────────────────────────────────────

function testShape() {
  console.log(C.bold('\nTest 2: forma del candidato'));

  const c = normalize('git:redflag', { kind: 'uncommitted', count: 5, message: 'Hay 5 archivos.' });
  assert(c.tipo === 'git_redflag', 'tipo = git_redflag', c.tipo);
  assert(c.kind === 'uncommitted', 'kind = uncommitted', c.kind);
  for (const k of ['severity', 'actionability', 'salience', 'costOfIgnore']) {
    inRange(c.signal[k], 0, 1, `signal.${k} en [0,1]`);
  }
  for (const k of ['urgencia', 'confianza', 'accionabilidad', 'saliencia']) {
    inRange(c[k], 0, 1, `${k} en [0,1]`);
  }
  assert(c.source.sensor === 'git:redflag' && typeof c.source.at === 'number', 'source traceable');
  assert(c.payload.message === 'Hay 5 archivos.', 'payload bruto preservado');
}

// ── Test 3: git_redflag ──────────────────────────────────────────────────────

function testGit() {
  console.log(C.bold('\nTest 3: señales de git'));

  // .env sin ignorar: riesgo de secretos → coste de ignorar alto.
  const env = normalize('git:redflag', { kind: 'env_unignored', file: '.env', message: 'x' });
  assert(env.signal.costOfIgnore > 0.9, 'env_unignored → costOfIgnore casi 1', `got=${env.signal.costOfIgnore}`);
  assert(env.signal.severity > 0.8, 'env_unignored → severidad alta', `got=${env.signal.severity}`);

  // merge_conflict: severidad alta.
  const conflict = normalize('git:redflag', { kind: 'merge_conflict', count: 3, message: 'x' });
  assert(conflict.signal.severity > 0.7, 'merge_conflict → severidad alta', `got=${conflict.signal.severity}`);

  // uncommitted: muchos archivos → más urgente que pocos.
  const few = normalize('git:redflag', { kind: 'uncommitted', count: 3 });
  const many = normalize('git:redflag', { kind: 'uncommitted', count: 30 });
  assert(many.urgencia > few.urgencia, '30 sin commitear → más urgente que 3', `few=${few.urgencia} many=${many.urgencia}`);

  // unpushed_commits accionable.
  const unpushed = normalize('git:redflag', { kind: 'unpushed_commits', count: 4 });
  assert(unpushed.accionabilidad >= 0.5, 'unpushed → accionable', `got=${unpushed.accionabilidad}`);
}

// ── Test 4: system_warning ───────────────────────────────────────────────────

function testSystem() {
  console.log(C.bold('\nTest 4: señales del sistema'));

  const crit = normalize('system:warning', { kind: 'battery_critical', level: 7 });
  assert(crit.signal.severity > 0.8, 'batería crítica → severidad alta', `got=${crit.signal.severity}`);
  assert(crit.urgencia >= 0.8, 'batería crítica → urgencia ≥ 0.8', `got=${crit.urgencia}`);

  const low = normalize('system:warning', { kind: 'battery_low', level: 20 });
  assert(low.urgencia < crit.urgencia, 'battery_low menos urgente que critical', `low=${low.urgencia} crit=${crit.urgencia}`);

  // Nivel alto de disco → más urgente.
  const diskLow  = normalize('system:warning', { kind: 'disk', level: 80 });
  const diskHigh = normalize('system:warning', { kind: 'disk', level: 96 });
  assert(diskHigh.urgencia > diskLow.urgencia, 'disco 96% más urgente que 80%', `low=${diskLow.urgencia} high=${diskHigh.urgencia}`);

  // El sensor re-emite mientras persiste la condición: normalizar dos veces
  // con el mismo payload debe dar el mismo resultado (determinista).
  const again = normalize('system:warning', { kind: 'disk', level: 96 });
  assert(JSON.stringify(again.signal) === JSON.stringify(diskHigh.signal), 'determinista ante re-emisión');
}

// ── Test 5: lsp_error ────────────────────────────────────────────────────────

function testLsp() {
  console.log(C.bold('\nTest 5: errores del LSP'));

  const err1 = { message: 'Cannot find name "x"', severity: 1, line: 10 };
  const focused = normalize('lsp:error', { file: 'src/a.ts', absPath: '/w/src/a.ts', errors: [err1], count: 1, focused: true });
  const unfocused = normalize('lsp:error', { file: 'src/b.ts', absPath: '/w/src/b.ts', errors: [err1], count: 1, focused: false });

  assert(focused.signal.salience === 1, 'archivo enfocado → saliencia 1', `got=${focused.signal.salience}`);
  assert(focused.signal.actionability > unfocused.signal.actionability, 'enfocado → más accionable');
  assert(focused.urgencia > unfocused.urgencia, 'enfocado → más urgente');
  assert(unfocused.confianza < focused.confianza, 'no enfocado → menos confianza', `f=${focused.confianza} u=${unfocused.confianza}`);

  // Más errores → más severo.
  const manyErr = normalize('lsp:error', { file: 'src/a.ts', errors: [err1, err1, err1, err1], count: 4, focused: false });
  assert(manyErr.signal.severity > focused.signal.severity, '4 errores → más severo que 1', `1=${focused.signal.severity} 4=${manyErr.signal.severity}`);
}

// ── Test 6: error_title / clipboard / upcoming ───────────────────────────────

function testOthers() {
  console.log(C.bold('\nTest 6: ventana con error, portapapeles y eventos'));

  const crash = normalize('os:error-title', { title: 'app crashed', app: 'node', category: 'crash' });
  assert(crash.signal.salience >= 0.9, 'error en pantalla → saliencia alta', `got=${crash.signal.salience}`);
  assert(crash.signal.severity > 0.7, 'crash → severidad alta', `got=${crash.signal.severity}`);

  const stack = normalize('clipboard:copied', { kind: 'stacktrace', snippet: 'TypeError: x is not a function' });
  const url = normalize('clipboard:copied', { kind: 'url', snippet: 'https://example.com' });
  assert(stack.urgencia > url.urgencia, 'stacktrace más urgente que URL', `stack=${stack.urgencia} url=${url.urgencia}`);
  assert(stack.accionabilidad > url.accionabilidad, 'stacktrace más accionable que URL');

  // Evento próximo: cerca → urgente; lejano → tranquilo.
  const now = Date.now();
  const soon = normalize('memory:upcoming-event', { content: 'Reunión', when: now + 5 * 60000 }, { now });
  const later = normalize('memory:upcoming-event', { content: 'Reunión', when: now + 5 * 3600000 }, { now });
  assert(soon.urgencia > later.urgencia, 'evento en 5 min más urgente que en 5 h', `soon=${soon.urgencia} later=${later.urgencia}`);
  assert(soon.urgencia >= 0.7, 'evento en 5 min → urgencia alta', `got=${soon.urgencia}`);
}

// ── Test 7: generalidad (Gap 1) ─────────────────────────────────────────────

function testGenerality() {
  console.log(C.bold('\nTest 7: generalidad — eventos sin perfil registrado'));

  // Evento del bus que el normalizador no conoce, PERO trae datos reales:
  // no se descarta en silencio → se deriva un perfil genérico del payload.
  const unknown = normalize('deploy:failed', { service: 'api', error: 'Connection refused', file: 'deploy.sh', count: 3 });
  assert(unknown !== null, 'desconocido con datos → candidato (no se descarta en silencio)');
  if (unknown) {
    assert(unknown.tipo === 'deploy_failed', 'tipo derivado del nombre', unknown.tipo);
    for (const k of ['severity', 'actionability', 'salience', 'costOfIgnore']) {
      inRange(unknown.signal[k], 0, 1, `genérico.signal.${k} en [0,1]`);
    }
    assert(unknown.signal.severity >= 0.5, 'payload con error/fail → severidad media-alta', `got=${unknown.signal.severity}`);
    assert(unknown.source.sensor === 'deploy:failed', 'fuente traceable');
    assert(unknown.selfGated === false, 'los sensores NO son self-gated');
  }

  // Palabras críticas en el payload → el candidato se marca crítico (entra al
  // gate con derecho a ESCALATE, igual que env_unignored).
  const secret = normalize('audit:alert', { message: 'password exposed in .env on server-7' });
  assert(secret !== null && secret.isCritical === true, 'payload con secreto → isCritical', secret ? `isCritical=${secret.isCritical}` : 'null');

  // Evento con fallo accionable → accionabilidad razonable.
  const actionable = normalize('build:failed', { message: 'build failed', command: 'npm run build' });
  assert(actionable !== null && actionable.accionabilidad >= 0.5, 'con command/file → accionable', actionable ? `a=${actionable.accionabilidad}` : 'null');

  // registerProfile: enseñar una señal nueva en caliente sin tocar el código.
  registerProfile('test:telemetry-spike', 'default', {
    severity: 0.7, actionability: 0.5, salience: 0.6, costOfIgnore: 0.5,
    urgencia: 0.6, confianza: 0.8,
  });
  const learned = normalize('test:telemetry-spike', { kind: 'default', value: 99 });
  assert(learned !== null && learned.tipo === 'test_telemetry_spike', 'registerProfile → tipo aprendido', learned ? learned.tipo : 'null');
  if (learned) assert(Math.abs(learned.signal.severity - 0.7) < 1e-9, 'registerProfile → perfil usado', `got=${learned.signal.severity}`);
}

// ── Run ─────────────────────────────────────────────────────────────────────

testFiltering();
testShape();
testGit();
testSystem();
testLsp();
testOthers();
testGenerality();

console.log(`\n${C.bold(`Resultado: ${C.green(`${passed} ✓`)} / ${C.red(`${failed} ✗`)}`)}`);
process.exit(failed ? 1 : 0);
