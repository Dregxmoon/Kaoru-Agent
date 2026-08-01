'use strict';

/**
 * Fase B — E2E: verificación del flujo real completo del sensor al hecho.
 *
 *   GitWatcher real (git real, pollMs bajo) → git:redflag (kind=env_unignored,
 *   file=.env) → ProactiveEngine._tryTrigger → LLM (stub, tiene la última
 *   palabra) → initiative:trigger con proposal + diff REAL → decisión
 *   'accepted' vía bus → ProactiveExecutor → escribe .gitignore + verifica
 *   con git check-ignore → proposal:executed con la verificación REAL.
 *
 * No se mockea git ni el sensor: el archivo existe en disco, el repo es real,
 * el check-ignore es real. El único stub es el LLM (para que no dependa de la
 * red), porque el mensaje de la propuesta es lo único que inventa.
 *
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron tests/test_proposals_e2e.js
 */

const { execFile } = require('child_process');
const path        = require('path');
const fs          = require('fs');
const os          = require('os');

const C = {
  green:  (s) => `\x1b[32m${s}\x1b[0m`,
  red:    (s) => `\x1b[31m${s}\x1b[0m`,
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

const { GitWatcher }       = require('../infrastructure/sensors/GitWatcher.js');
const { ProactiveEngine }  = require('../core/behavior/ProactiveEngine.js');
const { ProactiveExecutor } = require('../core/behavior/ProactiveExecutor.js');
const { ProposalStore }    = require('../core/behavior/ProposalStore.js');
const { getEventBus }      = require('../infrastructure/event-bus/EventBus.js');
const LLMProvider          = require('../core/llm/LLMProvider.js');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-proposals-'));

function git(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd }, (err, stdout) => {
      resolve({ code: err ? (err.code || 1) : 0, stdout: stdout || '' });
    });
  });
}

async function makeRepo(name) {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  await git(['init'], dir);
  await git(['config', 'user.email', 'e2e@local'], dir);
  await git(['config', 'user.name', 'E2E'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), '# e2e\n');
  await git(['add', '-A'], dir);
  await git(['commit', '-m', 'init'], dir);
  return dir;
}

function waitForEvent(bus, event, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { bus.off(event, onEv); reject(new Error(`timeout esperando "${event}"`)); }, timeout);
    const onEv = (payload) => { clearTimeout(t); bus.off(event, onEv); resolve(payload); };
    bus.on(event, onEv);
  });
}

function stubLLM({ complete } = {}) {
  const origP = LLMProvider.getActiveProvider;
  const origC = LLMProvider.complete;
  LLMProvider.getActiveProvider = () => 'groq';
  LLMProvider.complete = async (...args) => (complete ? complete(...args) : 'Vi que tienes un .env sin ignorar — puedo añadirlo al .gitignore para que no se suba por accidente.');
  return { restore: () => { LLMProvider.getActiveProvider = origP; LLMProvider.complete = origC; } };
}

function fakeSensor() {
  return { getCurrentContext: () => ({ category: null, elapsed: 0, idleSecs: 0 }), getTodaySummary: () => '' };
}

// ── Runner ────────────────────────────────────────────────────────────────────

(async () => {
  console.log(C.cyan(C.bold('Fase B — E2E: GitWatcher → ProactiveEngine → ProactiveExecutor (git real)')));

  const bus = getEventBus();
  const ws  = await makeRepo('flujo');
  // El disparador del sensor: un .env REAL sin ignorar ni trackear.
  fs.writeFileSync(path.join(ws, '.env'), 'API_KEY=super-secreto-e2e\n');
  const store = new ProposalStore({ filePath: path.join(tmpRoot, 'store-e2e.json') });
  store.reset();

  // Piezas de PRODUCCIÓN: GitWatcher real (git real, poll cada 300ms),
  // ProactiveEngine real, executor real con el workspace correcto.
  const watcher = new GitWatcher({ workspace: ws, pollMs: 300 });
  const executor = new ProactiveExecutor({ getWorkspace: () => ws });
  const engine = new ProactiveEngine({ _ready: true }, { store, executor });
  engine.setOSSensor(fakeSensor());

  const stub = stubLLM();
  engine.start();

  // 1. El sensor detecta el .env en el repo y emite git:redflag → el engine
  //    consulta al LLM → emite initiative:trigger con proposal + diff real.
  const initiative = waitForEvent(bus, 'initiative:trigger');
  watcher.start();
  const payload = await initiative;

  assert(payload && payload.proposal, 'el trigger real del sensor generó una propuesta');
  assert(payload.proposal.type === 'git_redflag', `tipo del trigger correcto (${payload?.reason})`);
  assert(payload.proposal.kind === 'action', 'propuesta de tipo action');
  assert(payload.proposal.action?.tool === 'gitignore_add', 'acción declarada: gitignore_add');
  assert(payload.proposal.action?.params?.file === '.env', `params resueltos del sensor: file=${payload?.proposal?.action?.params?.file}`);
  assert(payload.proposal.diff && payload.proposal.diff.includes('+.env'), 'diff real de la propuesta (solo lectura)');
  assert(payload.suggestion && payload.suggestion.length > 5, 'mensaje del LLM presente (el LLM dio el OK)');

  // 2. El engine registró la acción pendiente.
  assert(engine._pendingActions.has(payload.proposal.id), 'acción pendiente registrada para la decisión');

  // 3. Usuario acepta (camino IPC → bus) → se EJECUTA y emite la verificación real.
  const executed = waitForEvent(bus, 'proposal:executed');
  bus.emit('initiative:decision', { proposalId: payload.proposal.id, type: payload.proposal.type, decision: 'accepted' });
  const result = await executed;

  assert(result.ok && !result.skipped, 'proposal:executed → ok');
  assert(result.detail.includes('check-ignore'), 'detail con la verificación REAL de git check-ignore');
  assert(result.proposalId === payload.proposal.id, 'resultado referenciado al proposalId correcto');

  // 4. La escritura quedó verificada en disco Y por git (fuera de oído).
  const gi = fs.readFileSync(path.join(ws, '.gitignore'), 'utf-8');
  assert(gi.includes('.env'), '.gitignore escrito con la línea exacta');
  const check = await git(['check-ignore', '.env'], ws);
  assert(check.code === 0, 'git check-ignore real confirma que .env está ignorado');

  // 5. El feedback quedó persistido y la pendiente consumida.
  assert(store._data.byType.git_redflag?.accepted === 1, 'aceptación persistida en ProposalStore');
  assert(!engine._pendingActions.has(payload.proposal.id), 'acción pendiente consumida');

  // 6. Idempotencia: el sensor sigue viendo el .env ignorado → NO re-emite
  //    env_unignored (flanco descendente); y aunque emitiera otra propuesta,
  //    la misma acción no se re-ejecuta.
  await new Promise(r => setTimeout(r, 800));
  const flags = watcher.getStats().flags;
  assert(!flags.env_unignored, 'tras ejecutar, el sensor ya no ve .env desprotegido');
  assert(!flags.merge_conflict && !flags.uncommitted, 'sin otras señales espurias del sensor');

  watcher.stop();
  engine.stop();
  stub.restore();

  console.log('');
  console.log(C.bold(`Resultado: ${C.green(passed + ' ✓')} / ${C.red(failed + ' ✗')}`));
  process.exit(failed ? 1 : 0);
})().catch(e => {
  console.error(C.red('Fallo en la ejecución de la suite:'), e);
  process.exit(1);
});
