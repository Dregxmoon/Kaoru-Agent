'use strict';

/**
 * Fase B — ejecución de propuestas proactivas con ProactiveExecutor.
 *
 * IMPORTANTE: correr con ELECTRON_RUN_AS_NODE=1 (igual que test_proposals):
 *
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron tests/test_proposals_executor.js
 *
 * Cubre:
 *   - Whitelist estricta: tools y params forzados (nada inventado por el LLM);
 *     filenames peligrosos (path traversal, saltos de línea, vacíos) rechazados.
 *   - preview() SOLO lectura: git_status y gitignore_add nunca mutan.
 *   - execute() tras "confirmación": gitignore_add escribe en el workspace
 *     CORRECTO (cwd inyectado, no heredado) y verifica post-acción REAL con
 *     `git check-ignore` (no reporta "listo" de oído).
 *   - Idempotencia: misma proposalId no se re-ejecuta; archivo ya ignorado
 *     reporta skipped vía check-ignore.
 *   - Workspace inválido: inexistente o no-repo → rechazado sin mutar nada.
 *   - Lock: una sola mutación a la vez.
 *   - Integración engine→executor: propuesta con diff real → handleDecision
 *     (accepted) → 'proposal:executed' con la verificación REAL; rejected →
 *     solo feedback.
 */

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

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

const { ProactiveExecutor } = require('../core/behavior/ProactiveExecutor.js');
const { ProactiveEngine } = require('../core/behavior/ProactiveEngine.js');
const { ProposalStore } = require('../core/behavior/ProposalStore.js');
const { getEventBus } = require('../infrastructure/event-bus/EventBus.js');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'executor-'));

function git(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code || 1 : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

async function makeRepo(name) {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  await git(['init'], dir);
  await git(['config', 'user.email', 'test@local'], dir);
  await git(['config', 'user.name', 'Test'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), '# repo de prueba\n');
  await git(['add', '-A'], dir);
  await git(['commit', '-m', 'init'], dir);
  return dir;
}

function makeExecutor(workspace, opts = {}) {
  return new ProactiveExecutor({ getWorkspace: () => workspace, ...opts });
}

function waitForEvent(bus, event, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      bus.off(event, onEv);
      reject(new Error(`timeout esperando "${event}"`));
    }, timeout);
    const onEv = (payload) => {
      clearTimeout(t);
      bus.off(event, onEv);
      resolve(payload);
    };
    bus.on(event, onEv);
  });
}

// ── Test 1: preview SOLO lectura ───────────────────────────────────────────────

async function testPreviewReadOnly() {
  console.log(C.bold('\nTest 1: preview() es solo lectura (nunca muta)'));

  const ws = await makeRepo('t1');
  const exec = makeExecutor(ws);

  const gs = await exec.preview({ tool: 'git_status', params: {} });
  assert(gs.ok, 'preview git_status → ok');
  assert(
    typeof gs.preview === 'string' && gs.preview.startsWith('git status'),
    'preview git_status describe el estado'
  );
  assert(gs.diff === null, 'git_status no lleva diff (es lectura)');

  const gs2 = await exec.preview({ tool: 'git_status', params: { file: 'X' } });
  assert(gs2.ok, 'git_status ignora params extra');

  const gi = await exec.preview({ tool: 'gitignore_add', params: { file: '.env' } });
  assert(gi.ok, 'preview gitignore_add → ok');
  assert(gi.preview.includes('.env'), 'preview anuncia el archivo exacto');
  assert(gi.diff && gi.diff.includes('+.env'), 'diff muestra la línea que se añadirá');

  assert(
    !fs.existsSync(path.join(ws, '.gitignore')),
    'tras preview NO se creó .gitignore (solo lectura)'
  );
  const after = await git(['status', '--porcelain'], ws);
  assert(
    after.code === 0 && !after.stdout.includes('.gitignore'),
    'git no registra ningún cambio tras preview'
  );
}

// ── Test 2: ejecución real con verificación ───────────────────────────────────

async function testExecuteVerified() {
  console.log(C.bold('\nTest 2: execute() escribe y verifica con git check-ignore'));

  const ws = await makeRepo('t2');
  const exec = makeExecutor(ws);

  const res = await exec.execute(
    { tool: 'gitignore_add', params: { file: '.env' } },
    { proposalId: 't2-p1' }
  );
  assert(res.ok, 'execute gitignore_add → ok');
  assert(res.detail.includes('check-ignore'), 'detail menciona la verificación REAL');

  const gi = fs.readFileSync(path.join(ws, '.gitignore'), 'utf-8');
  assert(gi.includes('.env'), '.gitignore creado en el workspace con la línea exacta');

  const check = await git(['check-ignore', '.env'], ws);
  assert(check.code === 0, 'git check-ignore confirma (fuera de oído)');

  // 2a. Idempotencia: misma proposalId → skipped, no re-escribe
  const again = await exec.execute(
    { tool: 'gitignore_add', params: { file: '.env' } },
    { proposalId: 't2-p1' }
  );
  assert(again.ok && again.skipped, 'misma proposalId → skipped (idempotente)');

  // 2b. Archivo ya ignorado (proposalId nueva) → skipped vía check-ignore
  const dup = await exec.execute(
    { tool: 'gitignore_add', params: { file: '.env' } },
    { proposalId: 't2-p2' }
  );
  assert(
    dup.ok && dup.skipped && dup.detail.includes('ignorado'),
    'archivo ya ignorado → skipped con detalle'
  );

  // 2c. Un segundo archivo se APPENDEA (no duplica ni pisa)
  const add2 = await exec.execute(
    { tool: 'gitignore_add', params: { file: 'build' } },
    { proposalId: 't2-p3' }
  );
  assert(add2.ok, 'segundo archivo → ok');
  const gi2 = fs.readFileSync(path.join(ws, '.gitignore'), 'utf-8');
  assert(
    gi2.split('\n').filter((l) => l.trim() === '.env').length === 1,
    '.env sigue apareciendo UNA sola vez'
  );
  assert(gi2.includes('build'), 'build añadido');

  // 2d. git_status "ejecutado" es solo lectura
  const st = await exec.execute({ tool: 'git_status', params: {} }, { proposalId: 't2-p4' });
  assert(
    st.ok && st.detail && st.detail.includes('git status'),
    'execute git_status → lectura del estado'
  );
}

// ── Test 3: params peligrosos rechazados ──────────────────────────────────────

async function testDangerousParams() {
  console.log(C.bold('\nTest 3: params peligrosos → rechazados sin mutar'));

  const ws = await makeRepo('t3');
  const exec = makeExecutor(ws);

  const bad = [
    ['../.env', 'path traversal'],
    ['secret.txt\nrm -rf ~', 'salto de línea / inyección de comandos'],
    ['../../etc/passwd', 'traversal profundo'],
    ['.env local', 'espacios'],
    ['', 'vacío'],
    [null, 'null'],
    ['.env\x00x', 'byte nulo'],
  ];

  for (const [file, label] of bad) {
    const p = await exec.preview({ tool: 'gitignore_add', params: { file } });
    assert(!p.ok, `preview rechaza: ${label}`);
    const e = await exec.execute(
      { tool: 'gitignore_add', params: { file } },
      { proposalId: 't3-x' }
    );
    assert(!e.ok, `execute rechaza: ${label}`);
  }

  assert(!fs.existsSync(path.join(ws, '.gitignore')), 'ningún archivo inválido tocó .gitignore');

  const notAllowed = await exec.execute({ tool: 'rm -rf', params: {} }, { proposalId: 't3-1' });
  assert(!notAllowed.ok, 'tool fuera de whitelist → rechazada');
  const noArgs = await exec.execute({ tool: 'gitignore_add', params: {} }, { proposalId: 't3-2' });
  assert(!noArgs.ok, 'gitignore_add sin file → rechazada');
}

// ── Test 4: workspace inválido ─────────────────────────────────────────────────

async function testInvalidWorkspace() {
  console.log(C.bold('\nTest 4: workspace inexistente o no-repo → rechazado'));

  const missing = makeExecutor(path.join(tmpRoot, 'no-existe-xyz'));
  const m = await missing.execute(
    { tool: 'gitignore_add', params: { file: '.env' } },
    { proposalId: 't4-1' }
  );
  assert(!m.ok, 'workspace inexistente → rechazado');
  const mp = await missing.preview({ tool: 'git_status', params: {} });
  assert(!mp.ok, 'preview en workspace inexistente → rechazado');

  const plain = path.join(tmpRoot, 'no-repo');
  fs.mkdirSync(plain, { recursive: true });
  const exec = makeExecutor(plain);
  const p = await exec.preview({ tool: 'git_status', params: {} });
  assert(!p.ok && p.reason.includes('no es un repositorio'), 'dir normal → no es repositorio git');
  const e = await exec.execute(
    { tool: 'gitignore_add', params: { file: '.env' } },
    { proposalId: 't4-2' }
  );
  assert(!e.ok, 'execute en no-repo → rechazado');
  assert(!fs.existsSync(path.join(plain, '.gitignore')), 'no se escribió nada en un no-repo');

  const noWs = new ProactiveExecutor({ getWorkspace: () => null });
  const n = await noWs.execute(
    { tool: 'gitignore_add', params: { file: '.env' } },
    { proposalId: 't4-3' }
  );
  assert(!n.ok, 'sin workspace (null) → rechazado');
}

// ── Test 5: CWD correcto + lock ────────────────────────────────────────────────

async function testCwdAndLock() {
  console.log(C.bold('\nTest 5: CWD correcto y una mutación a la vez'));

  const wsA = await makeRepo('t5-a');
  const wsB = await makeRepo('t5-b');
  const execA = makeExecutor(wsA);
  const execB = makeExecutor(wsB);

  await execA.execute({ tool: 'gitignore_add', params: { file: '.env' } }, { proposalId: 't5-p1' });
  assert(fs.existsSync(path.join(wsA, '.gitignore')), 'el .gitignore cayó en el workspace A');
  assert(
    !fs.existsSync(path.join(wsB, '.gitignore')),
    'el workspace B NO fue tocado (cwd no heredado)'
  );

  const giA = fs.readFileSync(path.join(wsA, '.gitignore'), 'utf-8');
  assert(!giA.includes('build'), 'workspace A no tiene líneas de B');
  await execB.execute(
    { tool: 'gitignore_add', params: { file: 'build' } },
    { proposalId: 't5-p2' }
  );
  assert(
    fs.readFileSync(path.join(wsB, '.gitignore'), 'utf-8').includes('build'),
    'B tiene solo su línea'
  );

  // Lock: exec lento → segunda execute rechazada mientras corre
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const slowExec = (args, opts, cb) => {
    gate.then(() => cb(null, { code: 0, stdout: 'true' }));
  };
  const lockExec = makeExecutor(wsA, { exec: slowExec });
  const first = lockExec.execute(
    { tool: 'gitignore_add', params: { file: 'lockfile' } },
    { proposalId: 't5-lock' }
  );
  await new Promise((r) => setTimeout(r, 30));
  const second = await lockExec.execute(
    { tool: 'gitignore_add', params: { file: 'otro' } },
    { proposalId: 't5-lock2' }
  );
  assert(
    !second.ok && second.reason.includes('en ejecución'),
    'segunda mutación rechazada por el lock'
  );
  release();
  await first;
  assert(lockExec.isDone('t5-lock'), 'la primera terminó y quedó registrada como done');
}

// ── Test 6: integración engine → executor ─────────────────────────────────────

async function testEngineIntegration() {
  console.log(C.bold('\nTest 6: integración ProactiveEngine → ProactiveExecutor'));

  const bus = getEventBus();
  const ws = await makeRepo('t6');
  const store = new ProposalStore({ filePath: path.join(tmpRoot, 'store-6.json') });
  store.reset();
  const engine = new ProactiveEngine(
    { _ready: true },
    {
      store: store,
      executor: makeExecutor(ws),
    }
  );

  // 6a. La propuesta de git_redflag lleva action + diff REAL (no genérico)
  const proposal = await engine._buildProposal({
    type: 'git_redflag',
    kind: 'env_unignored',
    file: '.env',
  });
  assert(
    proposal && proposal.action?.tool === 'gitignore_add',
    'propuesta con acción gitignore_add'
  );
  assert(
    proposal.action.params.file === '.env',
    'params resueltos desde el trigger (determinista)'
  );
  assert(
    proposal.diff && proposal.diff.includes('+.env'),
    'propuesta con diff real (solo lectura)'
  );
  assert(proposal.requiresConsent === 'confirm', 'requiere consentimiento');
  assert(
    engine._pendingActions.has(proposal.id),
    'acción pendiente registrada (proposalId → action)'
  );

  // 6b. Aceptar vía bus (camino real) → ejecuta y emite la verificación REAL
  const executed = waitForEvent(bus, 'proposal:executed');
  bus.emit('initiative:decision', {
    proposalId: proposal.id,
    type: proposal.type,
    decision: 'accepted',
  });
  const result = await executed;
  assert(result.ok && !result.skipped, 'proposal:executed → ok con verificación real');
  assert(result.detail.includes('check-ignore'), 'detail trae la confirmación de git check-ignore');
  assert(result.proposalId === proposal.id, 'evento referenciado al proposalId correcto');
  assert(fs.existsSync(path.join(ws, '.gitignore')), 'el archivo quedó escrito de verdad');
  assert(!engine._pendingActions.has(proposal.id), 'acción pendiente consumida tras ejecutarse');
  assert(store._data.byType.git_redflag?.accepted === 1, 'aceptar también registra feedback');

  // 6c. Rejected → solo feedback, sin ejecución
  const proposal2 = await engine._buildProposal({
    type: 'git_redflag',
    kind: 'uncommitted',
    file: '.env',
  });
  assert(engine._pendingActions.has(proposal2.id), 'segunda propuesta pendiente');
  let fired = false;
  const l = () => {
    fired = true;
  };
  bus.on('proposal:executed', l);
  bus.emit('initiative:decision', {
    proposalId: proposal2.id,
    type: proposal2.type,
    decision: 'rejected',
  });
  await new Promise((r) => setTimeout(r, 80));
  bus.off('proposal:executed', l);
  assert(!fired, 'rejected → NO ejecuta ni emite proposal:executed');
  assert(!engine._pendingActions.has(proposal2.id), 'rejected → acción pendiente descartada');
  assert(store._data.byType.git_redflag?.rejected === 1, 'rejected registra feedback');
  assert(engine.getCooldownFor('git_redflag').factor === 1.5, 'factor de cooldown tras el rechazo');

  // 6d. Sin executor → la propuesta sigue llevando acción declarada pero no ejecuta
  const noExec = new ProactiveEngine(
    { _ready: true },
    { store: new ProposalStore({ filePath: path.join(tmpRoot, 'store-6b.json') }) }
  );
  const p3 = await noExec._buildProposal({
    type: 'git_redflag',
    kind: 'env_unignored',
    file: '.env',
  });
  assert(p3 && p3.action, 'sin executor la propuesta aún declara su acción');
  assert(p3.diff === null, 'sin executor no hay diff real');
  assert(
    noExec._pendingActions.has(p3.id),
    'sin executor igual se registra pendiente (no hará nada)'
  );
  let fired3 = false;
  const l3 = () => {
    fired3 = true;
  };
  bus.on('proposal:executed', l3);
  noExec.handleDecision({ proposalId: p3.id, type: p3.type, decision: 'accepted' });
  await new Promise((r) => setTimeout(r, 80));
  bus.off('proposal:executed', l3);
  assert(!fired3, 'sin executor → aceptar no ejecuta (solo feedback)');
  const gi = fs.readFileSync(path.join(ws, '.gitignore'), 'utf-8');
  assert(
    gi.split('\n').filter((l) => l.trim() === '.env').length === 1,
    'sin executor no duplicó el .gitignore'
  );

  engine.stop();
  noExec.stop();
}

// ── Test 7: guard híbrido de archivos abiertos ────────────────────────────────

async function testHybridOpenFileGuard() {
  console.log(C.bold('\nTest 7: guard híbrido — abierto quieto aplica, editando activo se niega'));

  const ws = await makeRepo('t7');
  const file = path.join(ws, 'script.js');
  fs.writeFileSync(file, 'function suma(a, b) {\n  return a - b;\n}\nmodule.exports = { suma };\n');

  const patchAction = {
    tool: 'apply_patch',
    params: {
      file: 'script.js',
      changes: [{ old: 'return a - b;', new: 'return a + b;' }],
      targetErrors: [],
    },
  };

  // Caso A: abierto pero NO enfocado → aplica igual, con appliedWhileOpen.
  const execA = makeExecutor(ws, {
    getOpenFiles: () => [file],
    getFocusedFile: () => null,
    getIdleSecs: () => 2,
    getDiagnostics: null,
  });
  const resA = await execA.execute(patchAction, { proposalId: 't7-a' });
  assert(resA.ok === true, 'abierto NO enfocado → aplica', resA.detail);
  assert(resA.appliedWhileOpen === true, '…y marca appliedWhileOpen');
  assert(
    fs.readFileSync(file, 'utf-8').includes('return a + b;'),
    'el parche quedó escrito en disco'
  );
  assert(typeof resA.diff === 'string' && /\+.*return a \+ b;/.test(resA.diff), 'incluye diff del cambio');

  // Caso B: enfocado AHORA + input reciente (<60s) → se niega.
  fs.writeFileSync(file, 'function suma(a, b) {\n  return a - b;\n}\nmodule.exports = { suma };\n');
  const execB = makeExecutor(ws, {
    getOpenFiles: () => [file],
    getFocusedFile: () => file,
    getIdleSecs: () => 5,
    getDiagnostics: null,
  });
  const resB = await execB.execute(patchAction, { proposalId: 't7-b' });
  assert(resB.ok === false, 'enfocado + input reciente → se niega');
  assert(resB.refused === 'open_in_editor_active', 'refused = open_in_editor_active', resB.refused);
  assert(
    fs.readFileSync(file, 'utf-8').includes('return a - b;'),
    'el archivo NO fue tocado'
  );

  // Caso C: enfocado pero AFK (idle ≥ 60s) → aplica (no hay edición activa).
  const execC = makeExecutor(ws, {
    getOpenFiles: () => [file],
    getFocusedFile: () => file,
    getIdleSecs: () => 120,
    getDiagnostics: null,
  });
  const resC = await execC.execute(patchAction, { proposalId: 't7-c' });
  assert(resC.ok === true, 'enfocado + AFK → aplica', resC.detail);
  assert(resC.appliedWhileOpen === true, '…con appliedWhileOpen');

  // Caso D: sin señal de idle (null) y enfocado → conservador: se niega.
  fs.writeFileSync(file, 'function suma(a, b) {\n  return a - b;\n}\nmodule.exports = { suma };\n');
  const execD = makeExecutor(ws, {
    getOpenFiles: () => [file],
    getFocusedFile: () => file,
    getIdleSecs: () => null,
    getDiagnostics: null,
  });
  const resD = await execD.execute(patchAction, { proposalId: 't7-d' });
  assert(resD.ok === false && resD.refused === 'open_in_editor_active', 'sin datos de idle + enfocado → se niega');

  fs.rmSync(ws, { recursive: true, force: true });
}

// ── Runner ────────────────────────────────────────────────────────────────────

(async () => {
  console.log(
    C.cyan(
      C.bold(
        'Fase B — ejecución de propuestas proactivas (whitelist, verificación real, idempotencia)'
      )
    )
  );

  await testPreviewReadOnly();
  await testExecuteVerified();
  await testDangerousParams();
  await testInvalidWorkspace();
  await testCwdAndLock();
  await testEngineIntegration();
  await testHybridOpenFileGuard();

  console.log('');
  console.log(C.bold(`Resultado: ${C.green(passed + ' ✓')} / ${C.red(failed + ' ✗')}`));
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(C.red('Fallo en la ejecución de la suite:'), e);
  process.exit(1);
});
