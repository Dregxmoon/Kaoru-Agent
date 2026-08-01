'use strict';

/**
 * Verificación de los sensores de señales (GitWatcher, SystemWatcher,
 * TitleWatcher, ClipboardWatcher, UpcomingEventsWatcher) y su integración con
 * el ProactiveEngine.
 *
 * IMPORTANTE: correr con ELECTRON_RUN_AS_NODE=1:
 *
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron tests/test_signal_sensors.js
 *
 * Cubre:
 *   - GitWatcher: redflags (.env sin ignorar, merge conflict, uncommitted,
 *     unpushed, cambio de rama) — con exec falso (hermético) y contra un repo
 *     git REAL (integración).
 *   - SystemWatcher: umbrales CPU/RAM/disco/batería y re-emisión mientras la
 *     condición persiste.
 *   - TitleWatcher: títulos de ventana con señales de error + dedup.
 *   - ClipboardWatcher: stacktrace/URL copiados, texto normal ignorado, opt-in.
 *   - UpcomingEventsWatcher: recordatorios próximos desde memoria.
 *   - Integración: cada evento del sensor llega a _tryTrigger → consulta al
 *     LLM → initiative:trigger con el reason correcto.
 */

const path = require('path');
const fs   = require('fs');
const os   = require('os');
const cp   = require('child_process');

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

const { getEventBus }       = require('../infrastructure/event-bus/EventBus.js');
const { GitWatcher }        = require('../infrastructure/sensors/GitWatcher.js');
const { SystemWatcher }     = require('../infrastructure/sensors/SystemWatcher.js');
const { TitleWatcher }      = require('../infrastructure/sensors/TitleWatcher.js');
const { ClipboardWatcher }  = require('../infrastructure/sensors/ClipboardWatcher.js');
const { UpcomingEventsWatcher, _parseEventTime } = require('../infrastructure/sensors/UpcomingEventsWatcher.js');
const { ProactiveEngine }   = require('../core/behavior/ProactiveEngine.js');
const { StateGraph }        = require('../core/state-graph/StateGraph.js');
const { StateUpdater }      = require('../core/state-graph/StateUpdater.js');
const LLMProvider           = require('../core/llm/LLMProvider.js');

const bus = getEventBus();
const flush = () => new Promise(r => setTimeout(r, 0));

function collect(eventName) {
  const events = [];
  const off = bus.on(eventName, (p) => events.push(p));
  return { events, off };
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitw-'));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  gitRun(repo, ['init', '-b', 'main']);
  return { dir, repo };
}

function gitRun(cwd, args) {
  try {
    const stdout = cp.execFileSync('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' });
    return { code: 0, stdout: stdout || '' };
  } catch(e) {
    return { code: e.status ?? 1, stdout: (e.stdout || '') };
  }
}

function gitCommit(repo, message) {
  gitRun(repo, ['add', '-A']);
  gitRun(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', message]);
}

// ── Test 1: GitWatcher (exec falso, hermético) ───────────────────────────────

function fakeGit(responses) {
  return (args, opts, cb) => {
    const key = args.join(' ');
    const r = typeof responses === 'function' ? responses(key) : responses[key];
    cb(null, r || { code: 0, stdout: '' });
  };
}

async function testGitWatcherUnit() {
  console.log(C.bold('\nTest 1: GitWatcher — exec falso'));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitw-unit-'));
  fs.mkdirSync(path.join(dir, 'repo'));
  fs.mkdirSync(path.join(dir, 'repo', '.git'));
  fs.writeFileSync(path.join(dir, 'repo', '.env'), 'SECRET=1');
  const repo = path.join(dir, 'repo');

  // 1a. .env sin ignorar → redflag
  let w = new GitWatcher({
    workspace: repo,
    exec: fakeGit({
      'rev-parse --is-inside-work-tree': { code: 0, stdout: 'true\n' },
      'rev-parse --abbrev-ref HEAD':     { code: 0, stdout: 'main\n' },
      'ls-files .env':                   { code: 0, stdout: '' },
      'check-ignore .env':               { code: 1, stdout: '' },
      'ls-files -u':                     { code: 0, stdout: '' },
      'status --porcelain':              { code: 0, stdout: ' M .env\n' },
      'rev-list --count @{u}..HEAD':     { code: 0, stdout: '0\n' },
    }),
    bus,
  });
  let rc = collect('git:redflag');
  await w.poll();
  assert(rc.events.length === 1 && rc.events[0].kind === 'env_unignored',
    '.env sin ignorar → git:redflag env_unignored', JSON.stringify(rc.events));
  rc.off();

  // 1b. Ahora está ignorado → la señal se limpia y no se re-emite
  w.setWorkspace(repo); // reset flags
  w = new GitWatcher({
    workspace: repo,
    exec: fakeGit({
      'rev-parse --is-inside-work-tree': { code: 0, stdout: 'true\n' },
      'rev-parse --abbrev-ref HEAD':     { code: 0, stdout: 'main\n' },
      'ls-files .env':                   { code: 0, stdout: '' },
      'check-ignore .env':               { code: 0, stdout: '.env\n' },
      'ls-files -u':                     { code: 0, stdout: '' },
      'status --porcelain':              { code: 0, stdout: '' },
      'rev-list --count @{u}..HEAD':     { code: 0, stdout: '0\n' },
    }),
    bus,
  });
  rc = collect('git:redflag');
  await w.poll();
  assert(rc.events.length === 0, '.env ignorado → sin redflag');
  assert(w.getStats().flags.env_unignored === false, 'flag env_unignored queda false');
  rc.off();

  // 1c. Merge conflict
  w = new GitWatcher({
    workspace: repo,
    exec: fakeGit({
      'rev-parse --is-inside-work-tree': { code: 0, stdout: 'true\n' },
      'rev-parse --abbrev-ref HEAD':     { code: 0, stdout: 'main\n' },
      'ls-files .env':                   { code: 0, stdout: '.env\n' },
      'ls-files -u':                     { code: 0, stdout: 'a.txt\nb.txt\n' },
      'status --porcelain':              { code: 0, stdout: 'UU a.txt\nUU b.txt\n' },
      'rev-list --count @{u}..HEAD':     { code: 0, stdout: '0\n' },
    }),
    bus,
  });
  rc = collect('git:redflag');
  await w.poll();
  assert(rc.events.some(e => e.kind === 'merge_conflict' && e.count === 2),
    'conflictos → redflag merge_conflict (count=2)', JSON.stringify(rc.events));
  rc.off();

  // 1d. Demasiados cambios sin commitear (umbral 12)
  let porcelain = Array.from({ length: 13 }, (_, i) => ` M file${i}.txt`).join('\n') + '\n';
  w = new GitWatcher({
    workspace: repo,
    exec: fakeGit({
      'rev-parse --is-inside-work-tree': { code: 0, stdout: 'true\n' },
      'rev-parse --abbrev-ref HEAD':     { code: 0, stdout: 'main\n' },
      'ls-files .env':                   { code: 0, stdout: '.env\n' },
      'ls-files -u':                     { code: 0, stdout: '' },
      'status --porcelain':              { code: 0, stdout: porcelain },
      'rev-list --count @{u}..HEAD':     { code: 0, stdout: '0\n' },
    }),
    bus,
  });
  rc = collect('git:redflag');
  await w.poll();
  assert(rc.events.some(e => e.kind === 'uncommitted' && e.count === 13),
    '13 archivos modificados → redflag uncommitted (count=13)', JSON.stringify(rc.events));
  rc.off();

  // 1e. Commits sin push
  w = new GitWatcher({
    workspace: repo,
    exec: fakeGit({
      'rev-parse --is-inside-work-tree': { code: 0, stdout: 'true\n' },
      'rev-parse --abbrev-ref HEAD':     { code: 0, stdout: 'main\n' },
      'ls-files .env':                   { code: 0, stdout: '.env\n' },
      'ls-files -u':                     { code: 0, stdout: '' },
      'status --porcelain':              { code: 0, stdout: '' },
      'rev-list --count @{u}..HEAD':     { code: 0, stdout: '3\n' },
    }),
    bus,
  });
  rc = collect('git:redflag');
  await w.poll();
  assert(rc.events.some(e => e.kind === 'unpushed_commits' && e.count === 3),
    '3 commits sin push → redflag unpushed_commits', JSON.stringify(rc.events));
  rc.off();

  // 1f. Sin upstream → no rompe ni emite unpushed
  w = new GitWatcher({
    workspace: repo,
    exec: fakeGit({
      'rev-parse --is-inside-work-tree': { code: 0, stdout: 'true\n' },
      'rev-parse --abbrev-ref HEAD':     { code: 0, stdout: 'main\n' },
      'ls-files .env':                   { code: 0, stdout: '.env\n' },
      'ls-files -u':                     { code: 0, stdout: '' },
      'status --porcelain':              { code: 0, stdout: '' },
      'rev-list --count @{u}..HEAD':     { code: 128, stdout: 'fatal: no upstream\n' },
    }),
    bus,
  });
  rc = collect('git:redflag');
  await w.poll();
  assert(rc.events.length === 0, 'sin upstream → sin redflag y sin error');
  rc.off();

  // 1g. Cambio de rama
  let branchCalls = 0;
  w = new GitWatcher({
    workspace: repo,
    exec: fakeGit((key) => {
      if (key === 'rev-parse --is-inside-work-tree') return { code: 0, stdout: 'true\n' };
      if (key === 'rev-parse --abbrev-ref HEAD') return { code: 0, stdout: ++branchCalls === 1 ? 'main\n' : 'feature\n' };
      if (key === 'ls-files .env') return { code: 0, stdout: '.env\n' };
      if (key === 'check-ignore .env') return { code: 0, stdout: '.env\n' };
      if (key === 'ls-files -u') return { code: 0, stdout: '' };
      if (key === 'status --porcelain') return { code: 0, stdout: '' };
      if (key === 'rev-list --count @{u}..HEAD') return { code: 128, stdout: '' };
      return { code: 0, stdout: '' };
    }),
    bus,
  });
  const bc = collect('git:branch-changed');
  await w.poll();                       // main (sin evento, es la primera)
  await w.poll();                       // feature → evento
  assert(bc.events.length === 1 && bc.events[0].branch === 'feature' && bc.events[0].prev === 'main',
    'cambio de rama → git:branch-changed', JSON.stringify(bc.events));
  bc.off();

  // 1h. No es un repo → silencio total
  const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitw-plain-'));
  w = new GitWatcher({ workspace: plainDir, bus });
  rc = collect('git:redflag');
  await w.poll();
  assert(rc.events.length === 0 && w.getStats().lastError === null, 'workspace sin .git → silencio');

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(plainDir, { recursive: true, force: true });
}

// ── Test 2: GitWatcher contra un repo git REAL ───────────────────────────────

async function testGitWatcherReal() {
  console.log(C.bold('\nTest 2: GitWatcher — repo git real (integración)'));

  const { dir, repo } = makeRepo();
  fs.writeFileSync(path.join(repo, 'file.txt'), 'hola\n');
  gitCommit(repo, 'init');
  fs.writeFileSync(path.join(repo, '.env'), 'SECRET=1\n');

  const w = new GitWatcher({ workspace: repo, bus });
  let rc = collect('git:redflag');
  await w.poll();
  assert(rc.events.some(e => e.kind === 'env_unignored'), '.env real sin ignorar → redflag', JSON.stringify(rc.events));
  rc.off();

  // .gitignore con .env → se limpia
  fs.writeFileSync(path.join(repo, '.gitignore'), '.env\n');
  rc = collect('git:redflag');
  await w.poll();
  assert(rc.events.length === 0, 'tras añadir .env a .gitignore → sin redflag');
  assert(w.getStats().flags.env_unignored === false, 'flag limpio');
  rc.off();

  // Cambio de rama
  gitRun(repo, ['checkout', '-b', 'feature']);
  const bc = collect('git:branch-changed');
  await w.poll();
  assert(bc.events.some(e => e.branch === 'feature'), 'cambio de rama real → git:branch-changed', JSON.stringify(bc.events));
  bc.off();

  // Merge conflict
  gitRun(repo, ['checkout', 'main']);
  fs.writeFileSync(path.join(repo, 'file.txt'), 'linea main\n');
  gitCommit(repo, 'main line');
  gitRun(repo, ['checkout', 'feature']);
  fs.writeFileSync(path.join(repo, 'file.txt'), 'linea feature\n');
  gitCommit(repo, 'feature line');
  gitRun(repo, ['checkout', 'main']);
  gitRun(repo, ['merge', 'feature']); // falla con conflicto
  rc = collect('git:redflag');
  await w.poll();
  assert(rc.events.some(e => e.kind === 'merge_conflict'),
    'conflicto de merge real → redflag', JSON.stringify(rc.events));
  rc.off();

  // Muchos archivos modificados sin commitear
  gitRun(repo, ['merge', '--abort']);
  for (let i = 0; i < 13; i++) fs.writeFileSync(path.join(repo, `new${i}.txt`), 'x\n');
  rc = collect('git:redflag');
  await w.poll();
  assert(rc.events.some(e => e.kind === 'uncommitted' && e.count >= 13),
    '13 archivos nuevos → redflag uncommitted', JSON.stringify(rc.events));
  rc.off();

  w.stop();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Test 3: SystemWatcher ────────────────────────────────────────────────────

async function testSystemWatcher() {
  console.log(C.bold('\nTest 3: SystemWatcher — umbrales y re-emisión'));

  // probe mutable por referencia — el watcher usa la función envolvente
  let currentProbe = async () => ({ cpu: 10, mem: 50, disk: 40, battery: { level: 50, charging: true } });
  const w = new SystemWatcher({ probe: () => currentProbe(), bus });
  let rc = collect('system:warning');
  await w.poll();
  assert(rc.events.length === 0, 'todo normal → sin advertencias');
  rc.off();

  // Batería baja → warning + re-emisión mientras persista
  currentProbe = async () => ({ cpu: 10, mem: 50, disk: 40, battery: { level: 12, charging: false } });
  rc = collect('system:warning');
  await w.poll();
  await w.poll();
  assert(rc.events.filter(e => e.kind === 'battery_low').length === 2,
    'batería 12% → battery_low emitida en cada poll mientras persista (2/2)', JSON.stringify(rc.events));
  rc.off();

  // Se recupera → deja de emitir
  currentProbe = async () => ({ cpu: 10, mem: 50, disk: 40, battery: { level: 50, charging: false } });
  rc = collect('system:warning');
  await w.poll();
  assert(rc.events.length === 0, 'batería recuperada → sin advertencias');
  rc.off();

  // Crítica
  currentProbe = async () => ({ cpu: 10, mem: 50, disk: 40, battery: { level: 5, charging: false } });
  rc = collect('system:warning');
  await w.poll();
  assert(rc.events.some(e => e.kind === 'battery_critical'), 'batería 5% → battery_critical', JSON.stringify(rc.events));
  rc.off();

  // CPU / RAM / disco
  currentProbe = async () => ({ cpu: 95, mem: 97, disk: 95, battery: { level: 90, charging: true } });
  rc = collect('system:warning');
  await w.poll();
  const kinds = rc.events.map(e => e.kind).sort();
  assert(kinds.includes('cpu_sustained') && kinds.includes('memory') && kinds.includes('disk'),
    'CPU/RAM/disco altos → cpu_sustained + memory + disk', JSON.stringify(kinds));
  rc.off();

  w.stop();
}

// ── Test 4: TitleWatcher ──────────────────────────────────────────────────────

async function testTitleWatcher() {
  console.log(C.bold('\nTest 4: TitleWatcher — títulos con señales de error'));

  const w = new TitleWatcher({ bus });
  const rc = collect('os:error-title');

  w._check({ app: 'code', category: 'code', title: 'main.ts — server.ts (error)' });
  assert(rc.events.length === 1 && rc.events[0].title.includes('error'),
    'título con "error" → os:error-title', JSON.stringify(rc.events));

  w._check({ app: 'code', category: 'code', title: 'main.ts — server.ts (error)' });
  assert(rc.events.length === 1, 'mismo título de error → dedup (no re-emite)');

  w._check({ app: 'code', category: 'code', title: 'main.ts — normal' });
  w._check({ app: 'code', category: 'code', title: 'main.ts — server.ts (error)' });
  assert(rc.events.length === 2, 'error → normal → error → re-emite');

  w._check({ app: 'kitty', category: 'terminal', title: 'npm run build — Process failed' });
  assert(rc.events.length === 3 && rc.events[2].category === 'terminal',
    'título de terminal con "failed" → también detecta', JSON.stringify(rc.events));

  w._check({ app: 'firefox', category: 'browser', title: 'Mi proyecto — Stack Overflow' });
  assert(rc.events.length === 3, 'título normal → no emite nada');

  rc.off();
  w.stop();
}

// ── Test 5: ClipboardWatcher ──────────────────────────────────────────────────

async function testClipboardWatcher() {
  console.log(C.bold('\nTest 5: ClipboardWatcher — stacktrace/URL (opt-in)'));

  let contents = [];
  const w = new ClipboardWatcher({ reader: () => contents[contents.length - 1] || '', bus });
  const rc = collect('clipboard:copied');

  contents.push('TypeError: Cannot read properties of undefined\n    at main (index.js:12:5)');
  w._tick();
  assert(rc.events.length === 1 && rc.events[0].kind === 'stacktrace',
    'stacktrace copiado → clipboard:copied (stacktrace)', JSON.stringify(rc.events));

  // mismo contenido → no re-emite
  w._tick();
  assert(rc.events.length === 1, 'mismo contenido copiado → dedup');

  contents.push('https://github.com/panfilo/Asistente-Vtuber');
  w._tick();
  assert(rc.events.length === 2 && rc.events[1].kind === 'url', 'URL copiada → clipboard:copied (url)');

  contents.push('la contraseña es hunter2 no la mires');
  w._tick();
  assert(rc.events.length === 2, 'texto normal copiado → ignorado (privacidad)');

  contents.push('hola');
  w._tick();
  assert(rc.events.length === 2, 'texto corto normal → ignorado');

  rc.off();
  w.stop();
}

// ── Test 6: UpcomingEventsWatcher ────────────────────────────────────────────

async function testUpcomingEvents() {
  console.log(C.bold('\nTest 6: UpcomingEventsWatcher — recordatorios próximos'));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evt-'));
  const graph = new StateGraph(path.join(dir, 'core.db')).init();
  const updater = new StateUpdater(graph);

  // 6a. Parser directo
  const now = new Date();
  now.setHours(16, 45, 0, 0);
  const p1 = _parseEventTime('Pidió recordar: tengo reunion a las 5', now.getTime());
  assert(p1 && p1.kind === 'time_event', '"a las 5" → time_event', JSON.stringify(p1));
  const p2 = _parseEventTime('Pidió recordar: debo llamar en 30 minutos', now.getTime());
  assert(p2 && Math.abs((p2.ts - now.getTime()) - 30 * 60 * 1000) < 2000, '"en 30 minutos" → relativo', JSON.stringify(p2));
  const p3 = _parseEventTime('Pidió recordar: vence en 2 horas', now.getTime());
  assert(p3 && Math.abs((p3.ts - now.getTime()) - 2 * 3600 * 1000) < 2000, '"en 2 horas" → relativo', JSON.stringify(p3));
  const p4 = _parseEventTime('Pidió recordar: examen el 10 de julio a las 9:30', now.getTime());
  assert(p4 && p4.kind === 'time_event', '"el D de MES a las HH:MM" → time_event', JSON.stringify(p4));

  // 6b. Recordatorio cercano → emite
  updater.detectAndSaveInstant('recuerda que tengo reunion a las 5');
  const w = new UpcomingEventsWatcher({ graph, bus });
  let rc = collect('memory:upcoming-event');
  await w.poll(now.getTime());
  assert(rc.events.length === 1 && rc.events[0].kind === 'time_event',
    'reunión a las 5 con ahora=16:45 → memoria emite upcoming-event', JSON.stringify(rc.events));
  await w.poll(now.getTime());
  assert(rc.events.length === 1, 'mismo momento → no se repite');
  rc.off();

  // 6c. Evento lejano → no emite
  updater.detectAndSaveInstant('recuerda que tengo cita el proximo anio');
  // "el proximo anio" no se parsea → el watcher no emite nada nuevo
  rc = collect('memory:upcoming-event');
  await w.poll(now.getTime());
  assert(rc.events.length === 0, 'recordatorio sin fecha parseable → sin evento');
  rc.off();

  // 6d. Ya pasó → no emite
  updater.detectAndSaveInstant('recuerda que debia pagar a las 2');
  const later = new Date();
  later.setHours(18, 0, 0, 0);
  rc = collect('memory:upcoming-event');
  await w.poll(later.getTime());
  assert(rc.events.length === 0, '"a las 2" con ahora=18:00 → ya pasó, sin evento');
  rc.off();

  // 6e. Evento de día (aniversario el 15 de junio) → solo emite ese día
  updater.detectAndSaveInstant('recuerda que es el aniversario el 15 de junio');
  const jun15 = new Date(now.getFullYear(), 5, 15, 10, 0, 0);
  const jun20 = new Date(now.getFullYear(), 5, 20, 10, 0, 0);
  rc = collect('memory:upcoming-event');
  await w.poll(jun15.getTime());
  assert(rc.events.some(e => e.kind === 'day_event'),
    'el 15 de junio → day_event emitido', JSON.stringify(rc.events));
  rc.off();
  rc = collect('memory:upcoming-event');
  await w.poll(jun20.getTime());
  assert(rc.events.length === 0, 'el 20 de junio → sin day_event (ya pasó)');
  rc.off();

  w.stop();
  graph.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Test 7: Integración sensores → ProactiveEngine → initiative ──────────────

function stubLLM({ provider = 'groq', complete } = {}) {
  const origP = LLMProvider.getActiveProvider;
  const origC = LLMProvider.complete;
  LLMProvider.getActiveProvider = () => provider;
  LLMProvider.complete = complete || (async () => 'mensaje de prueba');
  return () => {
    LLMProvider.getActiveProvider = origP;
    LLMProvider.complete = origC;
  };
}

async function testIntegration() {
  console.log(C.bold('\nTest 7: Integración — señales → ProactiveEngine → initiative'));

  // 7a. Antes de start() → todo bloqueado (guard _running)
  let restore = stubLLM();
  let engine = new ProactiveEngine(null);
  let res = await engine._tryTrigger({ type: 'git_redflag', context: 'x' });
  assert(res && res.blocked, 'antes de start() → _tryTrigger bloqueado');
  engine.stop();
  restore();

  // 7b. Cada señal de sensor se NORMALIZA al trigger correcto (Fase F). El gate
  //     decide: la crítica (env_unignored) emite initiative; las de relevancia
  //     media quedan QUEUE en el audit; la de relevancia baja DROP. El audit
  //     registra el tipo de cada señal — el contrato de cableado.
  restore = stubLLM();
  engine = new ProactiveEngine(null);
  engine.start();
  const fired = [];
  const listener = (p) => fired.push(p);
  bus.on('initiative:trigger', listener);

  bus.emit('git:redflag', { kind: 'env_unignored', message: '.env sin ignorar' });
  await flush();
  assert(fired.length === 1 && fired[0].reason === 'git_redflag',
    'git:redflag (crítico) → initiative con reason git_redflag', JSON.stringify(fired));
  engine._lastProactive = 0; // simular que pasó el gap global (25 min)

  bus.emit('system:warning', { kind: 'battery_low', message: 'Batería al 12%' });
  bus.emit('os:error-title', { app: 'code', category: 'code', title: 'server.ts (error)' });
  bus.emit('clipboard:copied', { kind: 'stacktrace', snippet: 'TypeError at main' });
  bus.emit('memory:upcoming-event', { content: 'Pidió recordar: reunion a las 5', when: Date.now() + 60000 });
  await flush();

  // El gate evaluó cada señal y registró su tipo en el audit (QUEUE/DROP).
  const byType = {};
  for (const e of engine._audit.getEntries({ limit: 50 })) {
    if (e.type) byType[e.type] = e.verdict;
  }
  assert(byType.system_warning === 'QUEUE', 'system:warning → gate QUEUE (tipo correcto)', JSON.stringify(byType));
  assert(byType.error_title === 'QUEUE', 'os:error-title → gate QUEUE (tipo correcto)', JSON.stringify(byType));
  assert(byType.clipboard_context === 'QUEUE', 'clipboard:copied → gate QUEUE (tipo correcto)', JSON.stringify(byType));
  assert(byType.upcoming_event === 'DROP', 'memory:upcoming-event → gate DROP (baja relevancia)', JSON.stringify(byType));
  assert(fired.length === 1, '…y NINGUNA de las de baja/medio relevancia emite initiative', `fired=${fired.length}`);

  bus.off('initiative:trigger', listener);
  engine.stop();
  restore();

  // 7c. Cooldown por tipo: la misma señal no vuelve a consultar de inmediato
  restore = stubLLM();
  engine = new ProactiveEngine(null);
  engine.start();
  const fired2 = [];
  const listener2 = (p) => fired2.push(p);
  bus.on('initiative:trigger', listener2);
  bus.emit('git:redflag', { kind: 'merge_conflict', message: 'conflicto' });
  await flush();
  bus.emit('git:redflag', { kind: 'merge_conflict', message: 'conflicto' });
  await flush();
  assert(fired2.length === 1, 'cooldown por tipo → 2º git:redflag no consulta');
  engine._lastAttemptByType = {};
  engine._lastProactive = 0; // también pasa el gap global
  bus.emit('git:redflag', { kind: 'merge_conflict', message: 'conflicto' });
  await flush();
  assert(fired2.length === 2, 'pasado el cooldown → vuelve a consultar');
  bus.off('initiative:trigger', listener2);
  engine.stop();
  restore();
}

// ── Runner ───────────────────────────────────────────────────────────────────

(async () => {
  console.log(C.bold(C.cyan('\nSensores de señales')));

  await testGitWatcherUnit();
  await testGitWatcherReal();
  await testSystemWatcher();
  await testTitleWatcher();
  await testClipboardWatcher();
  await testUpcomingEvents();
  await testIntegration();

  console.log(C.bold(`\nResultado: ${C.green(`${passed} ✓`)}${failed ? ` / ${C.red(`${failed} ✗`)}` : ''}`));
  process.exit(failed ? 1 : 0);
})().catch(e => {
  console.error(C.red('Fallo en la ejecución de la suite:'), e);
  process.exit(1);
});
