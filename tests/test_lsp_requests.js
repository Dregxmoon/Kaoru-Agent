'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

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

// Instancia LSP real (JSON-RPC) con _send capturado en vez de un proceso real.
function createInstance(serverConfig) {
  const { _LSPInstance } = require('../core/lsp/LSPManager.js');
  const inst = new _LSPInstance(serverConfig, serverConfig.languageId || 'typescript');
  const sent = [];
  inst._send = (msg) => sent.push(msg);
  inst._workspacePath = '/tmp/lsp-tests-ws';
  return { inst, sent };
}

const TS_CONFIG = {
  languageId: 'typescript',
  filePatterns: ['.ts', '.tsx'],
  initializationOptions: { preferences: { includeCompletionsForModuleExports: true } },
};

// ── Test 1: workspace/configuration se responde con initializationOptions ─────

function testWorkspaceConfiguration() {
  console.log(C.bold('\n── Test 1: workspace/configuration → responde initializationOptions ─'));

  const { inst, sent } = createInstance(TS_CONFIG);

  inst._handleMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'workspace/configuration',
    params: { items: [{ section: 'preferences' }] },
  });

  assert(sent.length === 1, 'Envió una respuesta', `sent: ${sent.length}`);
  const resp = sent[0];
  assert(resp.id === 1, 'Respuesta con el id del request');
  assert(Array.isArray(resp.result) && resp.result[0]?.includeCompletionsForModuleExports === true,
    'Devuelve la sección pedida de initializationOptions', JSON.stringify(resp.result));
  assert(resp.error === undefined, 'Sin error en la respuesta');
}

// ── Test 2: workspace/workspaceFolders → devuelve el root ─────────────────────

function testWorkspaceFolders() {
  console.log(C.bold('\n── Test 2: workspace/workspaceFolders → devuelve el root ─────────'));

  const { inst, sent } = createInstance(TS_CONFIG);
  sent.length = 0;

  inst._handleMessage({
    jsonrpc: '2.0',
    id: 2,
    method: 'workspace/workspaceFolders',
    params: {},
  });

  assert(sent.length === 1, 'Envió una respuesta');
  const resp = sent[0];
  assert(resp.id === 2, 'Respuesta con el id del request');
  assert(Array.isArray(resp.result) && resp.result[0]?.uri === 'file:///tmp/lsp-tests-ws',
    'Devuelve el workspace folder con el root', JSON.stringify(resp.result));
}

// ── Test 3: requests que se responden con null + request desconocida ─────────

function testOtherRequests() {
  console.log(C.bold('\n── Test 3: registerCapability null + request desconocida → MethodNotFound ─'));

  const { inst, sent } = createInstance(TS_CONFIG);

  inst._handleMessage({ jsonrpc: '2.0', id: 3, method: 'client/registerCapability', params: {} });
  assert(sent.length === 1 && sent[0].result === null, 'client/registerCapability responde null');

  inst._handleMessage({ jsonrpc: '2.0', id: 4, method: 'window/workDoneProgress/create', params: {} });
  assert(sent.length === 2 && sent[1].result === null, 'window/workDoneProgress/create responde null');

  inst._handleMessage({ jsonrpc: '2.0', id: 5, method: 'textDocument/unknownRequest', params: {} });
  assert(sent.length === 3, 'Request desconocida también se responde', `sent: ${sent.length}`);
  const unknown = sent[2];
  assert(unknown.error?.code === -32601 && unknown.error?.message.includes('textDocument/unknownRequest'),
    'Request desconocida → MethodNotFound (-32601)', JSON.stringify(unknown.error));
}

// ── Test 4: waitForDiagnostics resuelve con el push fresco (debounce) ─────────

async function testWaitForDiagnostics() {
  console.log(C.bold('\n── Test 4: waitForDiagnostics espera el push fresco con debounce ────'));

  const { inst } = createInstance(TS_CONFIG);
  const filePath = '/tmp/lsp-tests-ws/main.ts';
  const uri = `file://${filePath}`;

  // Push inicial (viejo): no debería resolver el wait todavía (debounce aplica
  // solo a pushes recibidos durante el wait).
  const wait = inst.waitForDiagnostics(filePath, { debounceMs: 100, timeoutMs: 3000 });

  // Push nuevo tras 50ms
  setTimeout(() => {
    inst._handleMessage({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri, diagnostics: [{ severity: 1, message: 'type X no es asignable', range: { start: { line: 0, character: 0 } } }] },
    });
  }, 50);

  const diags = await wait;
  assert(Array.isArray(diags) && diags.length === 1 && diags[0].severity === 1,
    'Resuelve con los diagnósticos frescos', JSON.stringify(diags));
  assert(diags[0].message.includes('type X'), 'Contiene el mensaje del push nuevo');
}

// ── Test 5: waitForDiagnostics con timeout devuelve la cache (no se cuelga) ───

async function testWaitForDiagnosticsTimeout() {
  console.log(C.bold('\n── Test 5: waitForDiagnostics timeout → cache sin colgarse ────────'));

  const { inst } = createInstance(TS_CONFIG);
  const filePath = '/tmp/lsp-tests-ws/other.ts';
  const uri = `file://${filePath}`;

  // Cache previa (p.ej. un push de antes)
  inst._diagnostics.set(uri, [{ severity: 1, message: 'viejo', range: { start: { line: 0, character: 0 } } }]);

  const t0 = Date.now();
  const diags = await inst.waitForDiagnostics(filePath, { debounceMs: 50, timeoutMs: 200 });
  const elapsed = Date.now() - t0;

  assert(Array.isArray(diags) && diags.length === 1 && diags[0].message === 'viejo',
    'Timeout → devuelve la cache de push', JSON.stringify(diags));
  assert(elapsed < 3000, `No se cuelga (resolvió en ${elapsed}ms)`, `elapsed: ${elapsed}ms`);
}

// ── Test 6: publishDiagnostics actualiza la cache y emite el evento ──────────

async function testPublishDiagnosticsCachesAndEmits() {
  console.log(C.bold('\n── Test 6: publishDiagnostics actualiza cache + emite evento ──────'));

  const { inst } = createInstance(TS_CONFIG);
  const filePath = '/tmp/lsp-tests-ws/emit.ts';
  const uri = `file://${filePath}`;

  const events = [];
  inst._emitter.on('diagnostics', (u, d) => events.push({ u, d }));

  inst._handleMessage({
    jsonrpc: '2.0',
    method: 'textDocument/publishDiagnostics',
    params: { uri, diagnostics: [{ severity: 2, message: 'warn', range: { start: { line: 1, character: 0 } } }] },
  });

  assert(events.length === 1 && events[0].u === uri, 'El evento diagnostics se emitió');
  const cached = inst._diagnostics.get(uri);
  assert(Array.isArray(cached) && cached.length === 1 && cached[0].message === 'warn', 'La cache push se actualizó');
}

// ── Test 7: hover → request textDocument/hover + normalización (LSP.3) ───────

async function testHover() {
  console.log(C.bold('\n── Test 7: hover → request + resultado plano (LSP.3) ─────────────'));

  const { inst, sent } = createInstance(TS_CONFIG);
  const filePath = '/tmp/lsp-tests-ws/main.ts';

  const hoverPromise = inst.hover(filePath, 2, 3);
  await new Promise((r) => setImmediate(r)); // dejar que hover llegue a _request
  const req = sent.find((m) => m.method === 'textDocument/hover');
  assert(req, 'Envió textDocument/hover', `sent: ${JSON.stringify(sent.map(m => m.method))}`);
  assert(req.params.textDocument.uri === `file://${filePath}`, 'uri correcta');
  assert(req.params.position.line === 2 && req.params.position.character === 3, 'posición correcta');

  inst._handleMessage({
    jsonrpc: '2.0',
    id: req.id,
    result: { contents: { language: 'typescript', value: 'const x: number' }, range: null },
  });
  const res = await hoverPromise;
  assert(res && res.contents.includes('const x'), 'Hover normalizado a texto plano', JSON.stringify(res));
  assert(res.language === 'typescript', 'Lenguaje del hover preservado');
}

// ── Test 8: rename → devuelve edits SIN aplicarlos (LSP.3) ────────────────────

async function testRename() {
  console.log(C.bold('\n── Test 8: rename → workspace edits sin aplicar (LSP.3) ───────────'));

  const { inst, sent } = createInstance(TS_CONFIG);
  const filePath = '/tmp/lsp-tests-ws/main.ts';

  let threw = null;
  try { await inst.rename(filePath, 0, 0, ''); } catch (e) { threw = e; }
  assert(threw && threw.message.includes('newName'), 'rename sin newName → error claro');

  sent.length = 0;
  const renamePromise = inst.rename(filePath, 4, 5, 'nuevoNombre');
  await new Promise((r) => setImmediate(r)); // dejar que rename llegue a _request
  const req = sent.find((m) => m.method === 'textDocument/rename');
  assert(req && req.params.newName === 'nuevoNombre', 'Envía newName en el request');
  assert(req.params.position.line === 4, 'Posición correcta en el request');

  inst._handleMessage({
    jsonrpc: '2.0',
    id: req.id,
    result: {
      changes: {
        [`file://${filePath}`]: [{ range: { start: { line: 4, character: 5 }, end: { line: 4, character: 18 } }, newText: 'nuevoNombre' }],
      },
    },
  });
  const edits = await renamePromise;
  assert(Array.isArray(edits) && edits.length === 1, 'Devuelve los workspace edits', JSON.stringify(edits));
  assert(edits[0].filePath === filePath, 'filePath decodificado del uri');
  assert(edits[0].edits[0].newText === 'nuevoNombre', 'El edit contiene el texto nuevo');
  assert(inst._send !== null, 'El test no aplicó los edits (solo los calculó)');
}

// ── Test 9: codeActions → request con contexto de diagnósticos (LSP.3) ────────

async function testCodeActions() {
  console.log(C.bold('\n── Test 9: codeActions → request + normalización (LSP.3) ─────────'));

  const { inst, sent } = createInstance(TS_CONFIG);
  const filePath = '/tmp/lsp-tests-ws/main.ts';
  inst._diagnostics.set(`file://${filePath}`, [{ severity: 1, message: 'fixable', range: { start: { line: 1, character: 0 } } }]);

  const caPromise = inst.codeActions(filePath, 1, 0);
  await new Promise((r) => setImmediate(r)); // dejar que codeActions llegue a _request
  const req = sent.find((m) => m.method === 'textDocument/codeAction');
  assert(req, 'Envió textDocument/codeAction');
  assert(req.params.range.start.line === 1, 'Rango = posición pedida');
  assert(Array.isArray(req.params.context.diagnostics) && req.params.context.diagnostics.length === 1,
    'Contexto incluye los diagnósticos cacheados', JSON.stringify(req.params.context));

  inst._handleMessage({
    jsonrpc: '2.0',
    id: req.id,
    result: [{ title: 'Fix rápido', kind: 'quickfix', edit: { changes: {} }, isPreferred: true }],
  });
  const actions = await caPromise;
  assert(Array.isArray(actions) && actions.length === 1, 'Devuelve las code actions', JSON.stringify(actions));
  assert(actions[0].title === 'Fix rápido' && actions[0].isPreferred === true, 'Normaliza title/isPreferred');
}

// ── Test 10: recovery — reinicio con backoff + re-open + límite + crashed ─────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function testRecoveryRestart() {
  console.log(C.bold('\n── Test 10: recovery — backoff, re-open, límite y evento crashed ───'));

  const { _LSPInstance } = require('../core/lsp/LSPManager.js');
  const config = {
    languageId: 'typescript', filePatterns: ['.ts'],
    maxRestartAttempts: 2, restartDelayMs: 5, maxRestartDelayMs: 10, restartStableMs: 0,
  };
  const inst = new _LSPInstance(config, 'typescript');
  inst._send = () => {};
  inst._workspacePath = '/tmp/lsp-tests-ws';

  let startCalls = 0;
  let reopenCalls = 0;
  const crashed = [];
  inst._emitter.on('crashed', (lang) => crashed.push(lang));
  inst.start = async () => { startCalls++; inst._process = {}; inst._started = true; };
  inst._reopenAfterRestart = async () => { reopenCalls++; };
  inst._openedDocs.set('file:///tmp/lsp-tests-ws/a.ts', 1);

  // Crash 1 → programa reinicio (intento 1)
  inst._handleExit(1);
  await sleep(30);
  assert(startCalls === 1, '1er crash → reinicio ejecutado', `startCalls: ${startCalls}`);
  assert(reopenCalls === 1, 'Re-abre los documentos que estaban abiertos');
  assert(inst._restartAttempts === 1, 'Contador de intentos avanzó a 1', `attempts: ${inst._restartAttempts}`);

  // Crash 2 (rápido, inestable) → intento 2
  inst._handleExit(1);
  await sleep(30);
  assert(startCalls === 2, '2º crash → segundo reinicio (backoff bajo el límite)', `startCalls: ${startCalls}`);
  assert(inst._restartAttempts === 2, 'Contador de intentos = 2');

  // Crash 3 → supera el límite → cede y emite crashed
  inst._handleExit(1);
  await sleep(30);
  assert(startCalls === 2, 'Cede tras el límite de intentos (no reinicia más)', `startCalls: ${startCalls}`);
  assert(crashed.length === 1 && crashed[0] === 'typescript', 'Emite el evento crashed', JSON.stringify(crashed));
}

// ── Test 11: recovery — server estable resetea el contador ────────────────────

async function testRecoveryStableReset() {
  console.log(C.bold('\n── Test 11: recovery — server estable resetea el backoff ──────────'));

  const { _LSPInstance } = require('../core/lsp/LSPManager.js');
  const config = {
    languageId: 'typescript', filePatterns: ['.ts'],
    maxRestartAttempts: 2, restartDelayMs: 5, maxRestartDelayMs: 10, restartStableMs: 0,
  };
  const inst = new _LSPInstance(config, 'typescript');
  inst._send = () => {};
  inst._workspacePath = '/tmp/lsp-tests-ws';

  let startCalls = 0;
  inst.start = async () => { startCalls++; inst._process = {}; inst._started = true; };
  inst._reopenAfterRestart = async () => {};

  // El server llevaba mucho tiempo estable → el crash resetea el contador y
  // el backoff arranca de nuevo (se vuelve a intentar).
  inst._startedAt = Date.now() - 100000;
  inst._restartAttempts = 1;
  inst._handleExit(1);
  await sleep(30);
  assert(startCalls === 1, 'Crash de un server estable → se vuelve a reiniciar', `startCalls: ${startCalls}`);
  assert(inst._restartAttempts === 1, 'Contador reseteado y re-arrancado (backoff desde el inicio)',
    `attempts: ${inst._restartAttempts}`);
}

// ── Test 12: recovery — stop cancela un reinicio programado ───────────────────

async function testRecoveryStopCancels() {
  console.log(C.bold('\n── Test 12: recovery — stop cancela el reinicio pendiente ─────────'));

  const { _LSPInstance } = require('../core/lsp/LSPManager.js');
  const config = {
    languageId: 'typescript', filePatterns: ['.ts'],
    maxRestartAttempts: 5, restartDelayMs: 5, restartStableMs: 0,
  };
  const inst = new _LSPInstance(config, 'typescript');
  inst._send = () => {};
  inst._workspacePath = '/tmp/lsp-tests-ws';

  let startCalls = 0;
  inst.start = async () => { startCalls++; inst._process = {}; inst._started = true; };
  inst._reopenAfterRestart = async () => {};

  inst._handleExit(1);
  assert(inst._restartTimer !== null, 'Reinicio quedó programado');
  await inst.stop();
  assert(inst._restartTimer === null, 'stop cancela el timer de reinicio');
  const before = startCalls;
  await sleep(40);
  assert(startCalls === before, 'Ningún reinicio se ejecutó tras stop', `startCalls: ${startCalls}`);
}

// ── Test 13: LSP.2 auto-install — installCmd se ejecuta y reintenta ───────────

async function testAutoInstall() {
  console.log(C.bold('\n── Test 13: auto-install — installCmd + reintento (LSP.2) ─────────'));

  const { _LSPInstance } = require('../core/lsp/LSPManager.js');
  const config = {
    languageId: 'python', filePatterns: ['.py'],
    command: 'comando-lsp-inexistente-xyz', args: [],
    installCmd: 'true', autoInstall: true,
  };
  const inst = new _LSPInstance(config, 'python');
  inst._send = () => {};
  let installRuns = 0;
  inst._runInstall = async () => { installRuns++; };

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-autoin-'));
  try {
    let thrown = null;
    try { await inst.start(ws); } catch (e) { thrown = e; }
    assert(thrown !== null, 'start falla: el comando no existe y no se instala solo', thrown?.message || '');
    assert(installRuns === 1, 'auto-install corrió exactamente 1 vez', `installs: ${installRuns}`);
    assert(thrown && thrown.message.includes('comando-lsp-inexistente-xyz'),
      'El error final es el spawn del binario (sin reintentar otra vez)', thrown?.message || '');
  } finally {
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
  }
}

async function main() {
  console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
  console.log(C.bold(C.cyan('  Test Suite: LSP requests + recovery + auto-install + tools semánticas')));
  console.log(C.bold(C.cyan('════════════════════════════════════════════════════════')));

  testWorkspaceConfiguration();
  testWorkspaceFolders();
  testOtherRequests();
  await testWaitForDiagnostics();
  await testWaitForDiagnosticsTimeout();
  await testPublishDiagnosticsCachesAndEmits();
  await testHover();
  await testRename();
  await testCodeActions();
  await testRecoveryRestart();
  await testRecoveryStableReset();
  await testRecoveryStopCancels();
  await testAutoInstall();

  console.log(C.bold('\n════════════════════════════════════════════════════════'));
  const total = passed + failed;
  console.log(
    C.bold(`  Resultado: ${C.green(passed + ' passed')}  ${failed > 0 ? C.red(failed + ' failed') : C.dim('0 failed')}  / ${total} total`)
  );
  console.log(C.bold('════════════════════════════════════════════════════════\n'));

  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(C.red('\nERROR FATAL:'), e.message);
  console.error(e.stack);
  process.exit(1);
});
