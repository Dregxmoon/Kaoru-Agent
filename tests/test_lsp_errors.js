'use strict';

/**
 * Fase D — agente de código profundo: errores LSP como señal + parches.
 *
 * IMPORTANTE: correr con ELECTRON_RUN_AS_NODE=1 (igual que el resto):
 *
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron tests/test_lsp_errors.js
 *
 * Cubre:
 *   - LSPErrorWatcher: umbral por severidad (solo errores), dedup por flanco,
 *     scope por workspace, detección del archivo enfocado desde el título de
 *     la ventana y editor tracker (getOpenFiles).
 *   - SymbolIndex: símbolos aplanados desde el LSP con cache e invalidación.
 *   - ProactiveExecutor.apply_patch: preview con diff real, validación de
 *     fragmentos exactos/únicos, guard de archivos abiertos en el editor,
 *     verificación post-acción con el LSP y rollback ante regresiones.
 *   - ProactiveEngine lsp_error: hint con apply_patch, generación de parche
 *     con el LLM, y caída a propuesta informativa si el parche no es válido.
 */

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

const { LSPErrorWatcher } = require('../infrastructure/sensors/LSPErrorWatcher.js');
const { SymbolIndex } = require('../core/lsp/SymbolIndex.js');
const { ProactiveExecutor } = require('../core/behavior/ProactiveExecutor.js');
const { ProactiveEngine } = require('../core/behavior/ProactiveEngine.js');
const { ProposalStore } = require('../core/behavior/ProposalStore.js');
const LLMProvider = require('../core/llm/LLMProvider.js');
const { getEventBus } = require('../infrastructure/event-bus/EventBus.js');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lspd-'));

// ── Stubs / helpers ───────────────────────────────────────────────────────────

function makeLSPStub({ diagnosticsByFile = {}, defaultDiag = [] } = {}) {
  const opened = new Set();
  return {
    _opened: opened,
    diagnosticsByFile,
    isRunning: true,
    async openDocument(f) {
      opened.add(f);
    },
    async getDiagnostics(f) {
      return diagnosticsByFile[f] !== undefined ? diagnosticsByFile[f] : defaultDiag;
    },
  };
}

function fakeGraph(extra = {}) {
  return {
    _ready: true,
    queryNodes: () => [],
    getWorldModel: () => [],
    getRecentEpisodes: () => [],
    getLastSessions: () => [],
    ...extra,
  };
}

function fakeSensor() {
  return {
    getCurrentContext: () => ({ category: null, elapsed: 0, idleSecs: 0 }),
    getTodaySummary: () => '',
  };
}

function stubLLM({ complete } = {}) {
  const origP = LLMProvider.getActiveProvider;
  const origC = LLMProvider.complete;
  let calls = 0;
  LLMProvider.getActiveProvider = () => 'groq';
  LLMProvider.complete = async (...args) => {
    calls++;
    return complete ? complete(...args) : 'mensaje de prueba';
  };
  return {
    calls: () => calls,
    restore: () => {
      LLMProvider.getActiveProvider = origP;
      LLMProvider.complete = origC;
    },
  };
}

function makeEngine(store, executor, graph) {
  const engine = new ProactiveEngine(graph || fakeGraph(), { store, executor });
  engine.setOSSensor(fakeSensor());
  engine.start();
  return engine;
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

// ── Test 1: LSPErrorWatcher ───────────────────────────────────────────────────

async function testWatcher() {
  console.log(C.bold('\nTest 1: LSPErrorWatcher — errores LSP como señal'));
  const ws = path.join(tmpRoot, 'ws1');
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
  const badJs = path.join(ws, 'src', 'bad.js');
  const goodJs = path.join(ws, 'src', 'good.js');
  fs.writeFileSync(badJs, 'const x = ;\n');
  fs.writeFileSync(goodJs, 'const ok = 1;\n');

  const lsp = makeLSPStub({
    diagnosticsByFile: {
      [badJs]: [
        {
          code: '1109',
          message: 'Expression expected.',
          range: { start: { line: 0, character: 10 } },
          severity: 1,
        },
        {
          code: '7031',
          message: 'Not all code paths return a value.',
          range: { start: { line: 5, character: 0 } },
          severity: 1,
        },
        {
          code: '80001',
          message: 'This is just a warning.',
          range: { start: { line: 0, character: 0 } },
          severity: 2,
        },
      ],
      [goodJs]: [],
    },
  });

  const bus = getEventBus();
  const watcher = new LSPErrorWatcher({
    lsp,
    getWorkspace: () => ws,
    getCurrentTitle: () => 'bad.js — MiProyecto — Visual Studio Code',
    listFiles: () => [badJs, goodJs],
    maxScanPerPoll: 10,
    pollMs: 50,
    bus,
  });

  // 1a/1b. El primer poll detecta el foco y emite la señal; el listener se
  // registra ANTES para no perderse el evento.
  const p = waitForEvent(bus, 'lsp:error');
  await watcher.poll();
  assert(
    watcher.getFocusedFile() === badJs,
    'detecta el archivo enfocado desde el título de la ventana'
  );
  assert(watcher.getOpenFiles().includes(badJs), 'el archivo enfocado queda en getOpenFiles()');
  const sig = await p;
  assert(
    sig && sig.file === 'src/bad.js',
    'emite lsp:error con el archivo correcto (relativo al workspace)'
  );
  assert(sig.count === 2, 'solo cuenta errores severidad 1 (el warning se ignora)');
  assert(sig.workspace === ws, 'el payload lleva el workspace (scope por proyecto)');
  assert(sig.focused === true, 'marca focused=true');
  assert(
    sig.errors.every((e) => e.severity === 1),
    'todos los errores son severidad 1'
  );
  assert(!sig.errors.some((e) => e.message.includes('warning')), 'ningún warning entra a la señal');
  assert(
    sig.languageId === 'javascript',
    'el sensor reporta el lenguaje del archivo (.js → javascript)',
    sig.languageId
  );
  assert(sig.fileType === '.js', 'el sensor reporta la extensión del archivo', sig.fileType);

  // 1c. Dedup por flanco: mismo estado → no re-emite.
  await watcher.poll();
  await new Promise((r) => setTimeout(r, 30));
  assert(watcher.getStats().emitted === 1, 'dedup: no re-emite el mismo conjunto de errores');

  // 1d. Error nuevo → re-emite.
  lsp.diagnosticsByFile[badJs] = [
    { message: 'Expression expected.', range: { start: { line: 0, character: 10 } }, severity: 1 },
    {
      code: 'NEW',
      message: 'Un error nuevo apareció.',
      range: { start: { line: 8, character: 0 } },
      severity: 1,
    },
  ];
  const p2 = waitForEvent(bus, 'lsp:error');
  await watcher.poll();
  const sig2 = await p2;
  assert(sig2.count === 2, 're-emite al aparecer un error nuevo');
  assert(
    sig2.errors.some((e) => e.code === 'NEW'),
    'la señal incluye el error nuevo'
  );

  // 1e. Error corregido → sin señal (y se limpia).
  lsp.diagnosticsByFile[badJs] = [];
  await watcher.poll();
  assert(watcher.getErrorsFor(badJs).length === 0, 'errores corregidos → getErrorsFor vacío');

  // 1f. Sin workspace → silencio total.
  watcher.resetWorkspace(null);
  const statsBefore = watcher.getStats().emitted;
  await watcher.poll();
  assert(watcher.getStats().emitted === statsBefore, 'sin workspace no emite nada');
  watcher.resetWorkspace(ws);

  // 1g. Scope: reset al cambiar de workspace.
  watcher.resetWorkspace(path.join(tmpRoot, 'otro-proyecto'));
  assert(
    watcher.getOpenFiles().length === 0,
    'resetWorkspace limpia los archivos abiertos (no mezcla proyectos)'
  );

  watcher.stop();
  console.log(C.dim('  (watcher detenido)'));
}

// ── Test 2: SymbolIndex ───────────────────────────────────────────────────────

async function testSymbolIndex() {
  console.log(C.bold('\nTest 2: SymbolIndex — símbolos desde el LSP'));
  const file = path.join(tmpRoot, 'ws1', 'src', 'bad.js');
  const lsp = makeLSPStub();
  lsp.getDocumentSymbols = async () => [
    {
      name: 'calcular',
      kind: 12,
      selectionRange: { start: { line: 0, character: 0 } },
      children: [
        {
          name: 'interna',
          kind: 6,
          selectionRange: { start: { line: 2, character: 2 } },
          children: [],
        },
      ],
    },
    {
      name: 'constante',
      kind: 13,
      selectionRange: { start: { line: 9, character: 0 } },
      children: [],
    },
  ];

  const index = new SymbolIndex({ lsp, cacheTtlMs: 60000 });
  const syms = await index.getSymbolsFor(file);
  assert(syms.length === 3, 'aplana el árbol de símbolos (2 + 1 hijo)');
  assert(
    syms[0].name === 'calcular' && syms[0].kindName === 'Function',
    'símbolo con kindName real (LSP como fuente)'
  );
  assert(
    syms[1].name === 'interna' && syms[1].kindName === 'Method',
    'los hijos se incluyen aplanados'
  );
  assert(typeof syms[0].line === 'number', 'cada símbolo lleva su línea');

  let calls = 0;
  const orig = lsp.getDocumentSymbols;
  lsp.getDocumentSymbols = async () => {
    calls++;
    return orig();
  };
  await index.getSymbolsFor(file);
  assert(calls === 0, 'cache: la segunda consulta no toca al LSP');

  index.invalidate(file);
  await index.getSymbolsFor(file);
  assert(calls === 1, 'invalidate fuerza a re-consultar al LSP');

  const empty = new SymbolIndex({ lsp: null });
  const none = await empty.getSymbolsFor(file);
  assert(Array.isArray(none) && none.length === 0, 'sin LSP devuelve []');
}

// ── Test 3: ProactiveExecutor.apply_patch ─────────────────────────────────────

async function testApplyPatch() {
  console.log(
    C.bold('\nTest 3: ProactiveExecutor.apply_patch — parche con verificación y rollback')
  );
  const ws = path.join(tmpRoot, 'ws2');
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
  const file = path.join(ws, 'src', 'errores.js');
  const original = 'function calcular() {\n  const x = ;\n  return x;\n}\n';
  fs.writeFileSync(file, original);

  const openFiles = new Set();
  let afterDiag = [];
  const executor = new ProactiveExecutor({
    getWorkspace: () => ws,
    getOpenFiles: () => Array.from(openFiles),
    getDiagnostics: async () => afterDiag,
    verifyDelayMs: 5,
  });

  const goodPatch = {
    tool: 'apply_patch',
    params: {
      file: 'src/errores.js',
      changes: [{ old: 'const x = ;', new: 'const x = 1;' }],
      targetErrors: [{ message: 'Expression expected.', line: 1 }],
    },
  };

  // 3a. Preview: diff real, sin mutar.
  const prev = await executor.preview(goodPatch);
  assert(prev.ok, 'preview apply_patch → ok');
  assert(
    prev.diff && prev.diff.includes('-  const x = ;') && prev.diff.includes('+  const x = 1;'),
    'preview muestra el diff real'
  );
  assert(fs.readFileSync(file, 'utf-8') === original, 'preview no muta el archivo');

  // 3b. Fragmento ambiguo (no único) → rechazado en preview.
  fs.writeFileSync(file, 'const y = ;\nconst y = ;\n');
  const dup = await executor.preview({
    tool: 'apply_patch',
    params: { file: 'src/errores.js', changes: [{ old: 'const y = ;', new: 'const y = 1;' }] },
  });
  assert(
    !dup.ok && dup.reason.includes('no es único'),
    'fragmento duplicado → rechazado sin tocar nada'
  );

  // 3c. File fuera del workspace / path traversal → rechazado.
  fs.writeFileSync(file, original);
  const traversal = await executor.preview({
    tool: 'apply_patch',
    params: { file: '../outside.js', changes: [{ old: 'a', new: 'b' }] },
  });
  assert(!traversal.ok, 'path traversal → rechazado');
  const abs = await executor.preview({
    tool: 'apply_patch',
    params: { file: '/etc/passwd', changes: [{ old: 'a', new: 'b' }] },
  });
  assert(!abs.ok, 'ruta absoluta → rechazado');

  // 3d. Ejecución con verificación OK (el error objetivo desaparece).
  afterDiag = [];
  const res = await executor.execute(goodPatch, { proposalId: 'p-ok' });
  assert(res.ok, 'execute aplica el parche');
  assert(res.detail.includes('verificado con el LSP'), 'reporta verificación LSP real');
  assert(fs.readFileSync(file, 'utf-8').includes('const x = 1;'), 'el archivo quedó parcheado');

  // 3e. Idempotencia por proposalId.
  const res2 = await executor.execute(goodPatch, { proposalId: 'p-ok' });
  assert(res2.ok && res2.skipped === true, 'misma proposalId → no se re-ejecuta');

  // 3f. Regresión detectada por el LSP → rollback del archivo.
  fs.writeFileSync(file, original);
  afterDiag = [
    {
      message: 'Un error NUEVO que el parche introdujo.',
      range: { start: { line: 0, character: 0 } },
      severity: 1,
    },
  ];
  const reg = await executor.execute(goodPatch, { proposalId: 'p-reg' });
  assert(reg.ok === false && reg.rolledBack === true, 'regresión → rollback (rechaza y restaura)');
  assert(
    fs.readFileSync(file, 'utf-8') === original,
    'el archivo quedó como estaba tras el rollback'
  );

  // 3g. Guard híbrido: archivo abierto + política 'refuseFocused' + enfocado
  // con input reciente → rechaza; preview sí vale. Con la política default
  // ('always') aplica — la aceptación explícita es el consentimiento.
  fs.writeFileSync(file, original);
  openFiles.add(file);
  afterDiag = [];
  const open = await executor.execute(goodPatch, { proposalId: 'p-open' });
  assert(open.ok === true, 'guard híbrido (always): abierto sin foco activo → aplica');
  assert(
    open.appliedWhileOpen === true,
    '…marca appliedWhileOpen para advertir recarga en el chat'
  );
  fs.writeFileSync(file, original);
  const cautious = new ProactiveExecutor({
    getWorkspace: () => ws,
    getOpenFiles: () => [file],
    getFocusedFile: () => file,
    getIdleSecs: () => 3,
    openFilePolicy: 'refuseFocused',
    getDiagnostics: async () => afterDiag,
  });
  const refused = await cautious.execute(goodPatch, { proposalId: 'p-open-refuse' });
  assert(
    refused.ok === false && refused.refused === 'open_in_editor_active',
    "política 'refuseFocused' + enfocado + input reciente → rechaza"
  );
  assert(fs.readFileSync(file, 'utf-8') === original, 'el archivo abierto no se tocó');
  const prevOpen = await executor.preview(goodPatch);
  assert(prevOpen.ok, 'pero el diff sí se ofrece (solo proponer)');
  openFiles.delete(file);

  // 3h. Sin verificación disponible → aplica y avisa.
  const noVerify = new ProactiveExecutor({
    getWorkspace: () => ws,
    getOpenFiles: () => [],
    getDiagnostics: null,
  });
  const resNoV = await noVerify.execute(goodPatch, { proposalId: 'p-nov' });
  assert(
    resNoV.ok && resNoV.detail.includes('sin verificación LSP'),
    'sin LSP aplica igual y lo dice'
  );

  // 3i. Archivo no existe → rechazado sin mutar.
  const missing = await executor.preview({
    tool: 'apply_patch',
    params: { file: 'src/no-existe.js', changes: [{ old: 'a', new: 'b' }] },
  });
  assert(!missing.ok, 'archivo inexistente → rechazado');
}

// ── Test 4: ProactiveEngine lsp_error ─────────────────────────────────────────

async function testEngineLspError() {
  console.log(C.bold('\nTest 4: ProactiveEngine — trigger lsp_error'));
  const ws = path.join(tmpRoot, 'ws3');
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
  const file = path.join(ws, 'src', 'buggy.js');
  const original = 'function saludar() {\n  return "hola" + ;\n}\n';
  fs.writeFileSync(file, original);

  const storePath = path.join(tmpRoot, 'feedback-lsp.json');
  const store = new ProposalStore({ filePath: storePath });
  store.reset();
  const bus = getEventBus();

  let afterDiag = [];
  const executor = new ProactiveExecutor({
    getWorkspace: () => ws,
    getOpenFiles: () => [],
    getDiagnostics: async () => afterDiag,
    verifyDelayMs: 5,
  });

  // 4a. El LLM genera el parche y el mensaje proactivo.
  const patchJSON = JSON.stringify({ changes: [{ old: '"hola" + ;', new: '"hola" + nombre' }] });
  const stub = stubLLM({
    complete: async (...args) => {
      const system = String(args[1] || '');
      if (system.startsWith('Eres un asistente de corrección')) return patchJSON;
      return 'Oye, hay un error de sintaxis en src/buggy.js — ¿te lo arreglo?';
    },
  });

  const engine = makeEngine(store, executor);
  const error = {
    code: '1109',
    message: 'Expression expected.',
    range: { start: { line: 1, character: 10 } },
    severity: 1,
  };

  const got = waitForEvent(bus, 'initiative:trigger');
  engine._onLspError({
    file: 'src/buggy.js',
    absPath: file,
    workspace: ws,
    errors: [error],
    focused: true,
    symbols: [{ name: 'saludar', kindName: 'Function', line: 0 }],
  });
  const payload = await got;

  assert(payload.reason === 'lsp_error', 'la iniciativa es de tipo lsp_error');
  assert(payload.proposal && payload.proposal.action, 'la propuesta tiene acción (apply_patch)');
  assert(payload.proposal.action.tool === 'apply_patch', 'acción es apply_patch');
  assert(payload.proposal.action.params.file === 'src/buggy.js', 'params: archivo correcto');
  assert(
    payload.proposal.action.params.changes.length === 1,
    'params: cambios generados por el LLM'
  );
  assert(
    payload.proposal.action.params.changes[0].new.includes('nombre'),
    'params: el parche del LLM viaja a la propuesta'
  );
  assert(
    payload.proposal.action.params.targetErrors.length === 1,
    'params: targetErrors para la verificación post-parche'
  );
  assert(
    payload.proposal.diff && payload.proposal.diff.includes('+'),
    'el bubble muestra el diff real'
  );
  // Cupo propio de trabajo (MEM/lsp_error): el envío consume SOLO su contador
  // de trabajo, nunca el presupuesto general de charla.
  assert(engine._workFired === 1, 'el envío consume el cupo de TRABAJO (no el general)');
  assert(store.dailyCount() === 0, 'el presupuesto general NO se toca para lsp_error');

  // 4b. Cooldown por tipo definido.
  assert(engine.getCooldownFor('lsp_error').base > 0, 'lsp_error tiene cooldown propio');
  assert(engine.getCooldownFor('lsp_error').base === 45 * 60 * 1000, 'cooldown lsp_error = 45 min');

  // 4c. Ejecución end-to-end: aceptar → aplicar → verificado.
  afterDiag = [];
  const execResult = waitForEvent(bus, 'proposal:executed');
  engine.handleDecision({
    proposalId: payload.proposal.id,
    type: 'lsp_error',
    decision: 'accepted',
  });
  const done = await execResult;
  assert(
    done.ok === true && done.detail.includes('verificado con el LSP'),
    'aceptar la propuesta aplica el parche y verifica con LSP'
  );
  assert(
    fs.readFileSync(file, 'utf-8').includes('"hola" + nombre'),
    'el archivo real quedó corregido'
  );
  stub.restore();

  // 4d. Parche inválido del LLM → propuesta informativa (no_patch).
  //     focused=true para que el gate F-4 admita la señal (en el archivo que
  //     el usuario está viendo); lo que se prueba aquí es el fallback de parche.
  fs.writeFileSync(file, original);
  const stub2 = stubLLM({
    complete: async (...args) => {
      const system = String(args[1] || '');
      if (system.startsWith('Eres un asistente de corrección')) return 'no sé arreglar esto';
      return 'Hay un error en tu código, te lo muestro';
    },
  });
  const engine2 = makeEngine(store, executor);
  const p2 = waitForEvent(bus, 'initiative:trigger');
  engine2._onLspError({
    file: 'src/buggy.js',
    absPath: file,
    workspace: ws,
    errors: [error],
    focused: true,
    symbols: [],
  });
  const payload2 = await p2;
  assert(
    payload2.proposal && payload2.proposal.action === null,
    'parche inválido → propuesta SIN acción'
  );
  assert(payload2.proposal.kind === 'info', 'propuesta informativa (ver el error)');
  stub2.restore();

  // 4e. El listener del bus lsp:error dispara el trigger (integración sensor→engine).
  // El cooldown y el gap global se reinician porque este mismo tipo ya se
  // disparó hace milisegundos en este test (mismo run).
  engine2.stop();
  engine._lastProactive = 0;
  engine._lastAttemptByType.lsp_error = 0;
  const stub3 = stubLLM({
    complete: async (...args) => {
      const system = String(args[1] || '');
      if (system.startsWith('Eres un asistente de corrección')) return patchJSON;
      return 'Detecté un error en src/buggy.js — ¿lo vemos?';
    },
  });
  const p3 = waitForEvent(bus, 'initiative:trigger');
  bus.emit('lsp:error', {
    file: 'src/buggy.js',
    absPath: file,
    workspace: ws,
    errors: [error],
    focused: true,
    symbols: [],
  });
  const payload3 = await p3;
  assert(payload3.reason === 'lsp_error', 'el bus lsp:error alimenta el trigger (sensor→engine)');
  stub3.restore();

  engine.stop();
  engine2.stop();
}

// ── Test 5: lenguaje del archivo llega al LLM y la sintaxis se valida ─────────
// Caso real detectado: ante `implicit any` (7006) en un .js bajo checkJs, un LLM
// anotaba sintaxis TS (`a: number`) y el LSP reportaba 0 errores (no marca 8010).
// Fix: el sensor reporta el lenguaje, el prompt lo prohíbe, y el executor valida
// sintaxis JS real (node --check).

async function testPatchLanguage() {
  console.log(C.bold('\nTest 5: lenguaje del archivo → prompt + validación de sintaxis JS'));
  const ws = path.join(tmpRoot, 'ws4');
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
  const file = path.join(ws, 'src', 'calc.js');
  const original = 'function sumar(a, b) {\n  return a + b;\n}\n';
  fs.writeFileSync(file, original);

  // 5a. El prompt de parche recibe la regla de lenguaje (JS → no sintaxis TS).
  let capturedSystem = '';
  const stub = stubLLM({
    complete: async (...args) => {
      capturedSystem = String(args[1] || '');
      return JSON.stringify({
        changes: [{ old: 'function sumar(a, b) {', new: 'function sumar(a, b) {' }],
      });
    },
  });
  const engine = makeEngine(
    new ProposalStore({ filePath: path.join(tmpRoot, 'feedback-lang.json') }),
    new ProactiveExecutor({
      getWorkspace: () => ws,
      getOpenFiles: () => [],
      getDiagnostics: async () => [],
      verifyDelayMs: 5,
    })
  );
  await engine._generatePatch({
    file: 'src/calc.js',
    fileType: '.js',
    absPath: file,
    workspace: ws,
    errors: [{ code: '7006', message: "Parameter 'a' implicitly has an 'any' type.", line: 0 }],
    symbols: [],
  });
  assert(
    capturedSystem.includes('El archivo es JavaScript'),
    'el prompt de parche dice que es JavaScript'
  );
  assert(
    /PROHIBIDO usar anotaciones de tipos de TypeScript/.test(capturedSystem),
    '…prohíbe explícitamente la sintaxis TS en JS'
  );
  assert(
    !capturedSystem.includes('las anotaciones de tipos (a: number) son válidas'),
    '…la regla NO dice que las anotaciones valen (eso es solo TS)'
  );
  stub.restore();

  // 5b. Un parche con sintaxis TS en un .js → el executor lo rechaza en preview.
  const executor = new ProactiveExecutor({
    getWorkspace: () => ws,
    getOpenFiles: () => [],
    getDiagnostics: async () => [],
    verifyDelayMs: 5,
  });
  const tsPatch = {
    tool: 'apply_patch',
    params: {
      file: 'src/calc.js',
      changes: [{ old: 'function sumar(a, b) {', new: 'function sumar(a: number, b: number) {' }],
    },
  };
  const prev = await executor.preview(tsPatch);
  assert(
    prev.ok === false && /sintaxis del archivo|sintaxis JS inválida/.test(prev.reason),
    'preview rechaza sintaxis TS-en-JS',
    prev.reason
  );
  assert(fs.readFileSync(file, 'utf-8') === original, '…sin tocar el archivo (solo lectura)');

  // 5c. Si por la razón que sea se intenta ejecutar → rollback.
  const execRes = await executor.execute(tsPatch, { proposalId: 'p-ts' });
  assert(
    execRes.ok === false && execRes.rolledBack === true,
    'execute → rollback ante sintaxis inválida'
  );
  assert(fs.readFileSync(file, 'utf-8') === original, '…el archivo quedó como estaba');

  // 5d. Un parche JS válido (JSDoc) sí pasa preview.
  const good = await executor.preview({
    tool: 'apply_patch',
    params: {
      file: 'src/calc.js',
      changes: [
        {
          old: 'function sumar(a, b) {',
          new: '/** @param {number} a @param {number} b */\nfunction sumar(a, b) {',
        },
      ],
    },
  });
  assert(good.ok, 'parche JS válido (JSDoc) → preview ok');
  engine.stop();
}
// ── Run ────────────────────────────────────────────────────────────────────────

console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
console.log(C.bold(C.cyan('  March 7th — Fase D: errores LSP como señal + parches')));
console.log(C.bold(C.cyan('════════════════════════════════════════════════════════')));

async function main() {
  await testWatcher();
  await testSymbolIndex();
  await testApplyPatch();
  await testEngineLspError();
  await testPatchLanguage();

  console.log(C.bold('\n════════════════════════════════════════════════════════'));
  const total = passed + failed;
  if (failed === 0) {
    console.log(
      `  ${C.green('Resultado')}: ${C.green(`${passed} passed`)}  ${C.dim('0 failed')}  / ${total} total`
    );
  } else {
    console.log(
      `  Resultado: ${C.green(`${passed} passed`)}  ${C.red(`${failed} failed`)}  / ${total} total`
    );
  }
  console.log(C.bold('════════════════════════════════════════════════════════'));
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
