'use strict';

// Test suite: PIN de bloqueo local (§11.1) y panel de settings (§9).
//
//   - security-handlers.js: pin-set / pin-status / pin-check / pin-clear,
//     con hash scrypt en el llavero (mock), nunca en config;
//   - config-handlers.js: set-config persiste autonomía + agent flags
//     (merge del objeto existente, validación de tipos/enum).

const Module = require('module');
const { EventEmitter } = require('events');

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
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

// ── Mock de electron.ipcMain ─────────────────────────────────────────────────
const mockIpcMain = new EventEmitter();
mockIpcMain._handlers = new Map();
mockIpcMain.handle = (channel, fn) => mockIpcMain._handlers.set(channel, fn);
mockIpcMain.invokeHandler = (channel, event, ...args) => {
  const fn = mockIpcMain._handlers.get(channel);
  if (!fn) throw new Error(`sin handler para ${channel}`);
  return fn(event, ...args);
};

const realLoad = Module._load;
Module._load = function (_request, _parent, _isMain) {
  if (_request === 'electron') return { ipcMain: mockIpcMain };
  if (typeof _request === 'string' && _request.includes('KeychainManager.js')) return fakeK;
  return realLoad.apply(this, arguments);
};

// ── Mock de KeychainManager (hash en memoria) ─────────────────────────────────
const keyStore = new Map();
function makeFakeKeychain() {
  return {
    isAvailable: () => true,
    getKey: (k) => (keyStore.has(k) ? keyStore.get(k) : null),
    setKey: (k, v) => {
      keyStore.set(k, v);
      return true;
    },
    deleteKey: (k) => keyStore.delete(k),
    getAllKeys: (ks) => Object.fromEntries(ks.map((k) => [k, keyStore.get(k) ?? null])),
    setAllKeys: (o) => {
      for (const [k, v] of Object.entries(o)) keyStore.set(k, v);
    },
  };
}

const fakeK = makeFakeKeychain();

// ── Contexto falso para register(ctx) ─────────────────────────────────────────
const savedConfigs = [];
function makeCtx() {
  return {
    Core: {
      setAutonomyMode: (mode) => ({ ok: true, mode }),
      permissionsList: () => [],
      permissionsSetRule: () => ({ ok: true }),
      permissionsRemoveRule: () => ({ ok: true }),
    },
    loadConfig: () => {
      return {
        autonomy: 'suggest',
        agent: { approvalTimeoutMs: 120000, autoApprove: false, subagent: { enabled: true } },
      };
    },
    loadEffectiveConfig: () => ({ agent: { pinTimeoutMs: 0 } }),
    redactKeys: (c) => c,
    saveConfig: (patch) => savedConfigs.push(patch),
    KeychainManager: fakeK,
    keySource: () => 'keychain',
    keySourcesByProvider: () => ({}),
    PYTHON_BIN: '/usr/bin/python3',
  };
}

const { register: registerSecurity } = require('../ipc/security-handlers.js');
const { register: registerConfig } = require('../ipc/config-handlers.js');

// ── Test 1: ciclo completo del PIN ────────────────────────────────────────────

async function testPinLifecycle() {
  console.log(C.bold('\n── Test 1: ciclo completo del PIN ─────────────────────────────'));
  const ctx = makeCtx();
  registerSecurity(ctx);

  // sin PIN → no bloquea
  let st = await mockIpcMain.invokeHandler('pin-status');
  assert(st.set === false && st.locked === false, 'sin PIN: set=false, locked=false');

  // set con PIN corto → error
  const bad = await mockIpcMain.invokeHandler('pin-set', {}, '123');
  assert(bad.ok === false, 'PIN de 3 caracteres rechazado');

  // set válido → guarda hash en el llavero (no en config)
  const setRes = await mockIpcMain.invokeHandler('pin-set', {}, '1234');
  assert(setRes.ok === true, 'PIN de 4 caracteres aceptado');
  assert(keyStore.has('app_pin_hash'), 'el hash se guardó en el llavero (app_pin_hash)');
  const stored = keyStore.get('app_pin_hash');
  assert(
    typeof stored === 'string' && stored.startsWith('scrypt$'),
    'el valor guardado es un hash scrypt (nunca el PIN en claro)',
    stored
  );

  // status ahora: set=true, locked=true (unlockedAt se marcó al setear,
  // pero el flag de "nunca desbloqueada" previo a un set no aplica aquí;
  // locked depende del flujo: re-visitamos con un módulo fresco en Test 2).
  st = await mockIpcMain.invokeHandler('pin-status');
  assert(st.set === true, 'después del set: set=true');

  // check correcto / incorrecto
  const okPin = await mockIpcMain.invokeHandler('pin-check', {}, '1234');
  assert(okPin.ok === true, 'PIN correcto → ok');
  const badPin = await mockIpcMain.invokeHandler('pin-check', {}, '0000');
  assert(badPin.ok === false, 'PIN incorrecto → error');

  // clear → deja de existir
  const clearRes = await mockIpcMain.invokeHandler('pin-clear', {});
  assert(clearRes.ok === true, 'pin-clear ok');
  assert(!keyStore.has('app_pin_hash'), 'tras clear el hash se eliminó del llavero');
}

// ── Test 2: lock tras reload (hash persistido + sin unlockedAt) ───────────────

async function testLockAfterReload() {
  console.log(C.bold('\n── Test 2: lock tras reload (persistencia del hash) ────────────'));
  // Configurar un PIN en una "sesión" y simular reload (los handlers se
  // re-registran con estado fresco de unlockedAt).
  const ctx1 = makeCtx();
  registerSecurity(ctx1);
  await mockIpcMain.invokeHandler('pin-set', {}, '9999');

  // "reload": nuevo register (estado unlockedAt vuelve a 0). El hash sigue en
  // el keyStore mock (persistente) → la app arranca bloqueada. Como el módulo
  // está cacheado, se descarta el cache para simular un proceso nuevo.
  keyStore.set('app_pin_hash', keyStore.get('app_pin_hash'));
  const secPath = require.resolve('../ipc/security-handlers.js');
  delete require.cache[secPath];
  const { register: registerSecurityFresh } = require('../ipc/security-handlers.js');
  registerSecurityFresh(makeCtx());
  const st = await mockIpcMain.invokeHandler('pin-status');
  assert(st.set === true && st.locked === true, 'con PIN persistido: arranca bloqueada');

  const ok = await mockIpcMain.invokeHandler('pin-check', {}, '9999');
  assert(ok.ok === true, 'el PIN persistido sigue válido tras reload');
  const st2 = await mockIpcMain.invokeHandler('pin-status');
  assert(st2.locked === false, 'tras validar: desbloqueada');

  await mockIpcMain.invokeHandler('pin-clear', {});
  keyStore.clear();
}

// ── Test 3: set-config — autonomía ────────────────────────────────────────────

async function testSetConfigAutonomy() {
  console.log(C.bold('\n── Test 3: set-config — autonomía ─────────────────────────────'));
  const ctx = makeCtx();
  savedConfigs.length = 0;
  registerConfig(ctx);

  const bad = await mockIpcMain.invokeHandler('set-config', {}, { autonomy: 'hack' });
  assert(bad.ok === false, 'autonomía inválida rechazada');

  const res = await mockIpcMain.invokeHandler('set-config', {}, { autonomy: 'act' });
  assert(res.ok === true, 'autonomía válida aceptada');
  assert(savedConfigs.length === 1, 'se persistió una vez');
  assert(savedConfigs[0].autonomy === 'act', 'autonomy=act persistido');
  assert(
    savedConfigs[0].agent && savedConfigs[0].agent.autoApprove === false,
    'el objeto agent se conserva (merge, no reemplazo)'
  );
}

// ── Test 4: set-config — agent flags ──────────────────────────────────────────

async function testSetConfigAgent() {
  console.log(C.bold('\n── Test 4: set-config — flags del agente ──────────────────────'));
  const ctx = makeCtx();
  savedConfigs.length = 0;
  registerConfig(ctx);

  const badType = await mockIpcMain.invokeHandler(
    'set-config',
    {},
    { agent: { autoApprove: 'yes' } }
  );
  assert(badType.ok === false, 'autoApprove no-boolean rechazado');

  const badTimeout = await mockIpcMain.invokeHandler(
    'set-config',
    {},
    {
      agent: { approvalTimeoutMs: -5 },
    }
  );
  assert(badTimeout.ok === false, 'approvalTimeoutMs <= 0 rechazado');

  const res = await mockIpcMain.invokeHandler(
    'set-config',
    {},
    {
      agent: { autoApprove: true, approvalTimeoutMs: 30000 },
    }
  );
  assert(res.ok === true, 'patch válido aceptado');
  assert(savedConfigs[0].agent.autoApprove === true, 'autoApprove=true persistido');
  assert(savedConfigs[0].agent.approvalTimeoutMs === 30000, 'approvalTimeoutMs=30000 persistido');
  assert(
    savedConfigs[0].agent.subagent && savedConfigs[0].agent.subagent.enabled === true,
    'subagent conservado (merge del objeto agent existente)'
  );

  const pinPatch = await mockIpcMain.invokeHandler(
    'set-config',
    {},
    { agent: { pinTimeoutMs: 60000 } }
  );
  assert(pinPatch.ok === true, 'pinTimeoutMs aceptado');
  assert(savedConfigs[1].agent.pinTimeoutMs === 60000, 'pinTimeoutMs=60000 persistido');
}

// ── Test 5: github-status (panel de credenciales) ─────────────────────────────

async function testGithubStatus() {
  console.log(C.bold('\n── Test 5: github-status — panel de credenciales ──────────────'));
  const ctx = makeCtx();
  const { register: registerGithub } = require('../ipc/github-handlers.js');
  registerGithub(ctx);

  // Sin token en el llavero → no conectado.
  keyStore.delete('github_token');
  keyStore.delete('github_client_id');
  let st = await mockIpcMain.invokeHandler('github-status');
  assert(st.connected === false, 'sin token: connected=false');
  assert(st.login === null, 'sin token: login=null');
  assert(st.clientIdSet === false, 'sin client id: clientIdSet=false');

  // Con client_id pero sin token → clientIdSet=true, connected=false.
  keyStore.set('github_client_id', 'Ov23_abcdef');
  st = await mockIpcMain.invokeHandler('github-status');
  assert(st.clientIdSet === true, 'client_id en el llavero: clientIdSet=true');
  assert(st.connected === false, 'sin token sigue connected=false');

  // Con token: quienami resuelve el login. No se expone el token.
  keyStore.set('github_token', 'ghp_fake');
  const gh = require('../core/github/GitHubManager.js').getGitHubManager();
  const originalWhoami = gh.whoami;
  gh.whoami = async () => ({ login: 'panfilo', name: 'Panfilo' });
  st = await mockIpcMain.invokeHandler('github-status');
  assert(st.connected === true, 'con token: connected=true');
  assert(st.login === 'panfilo', 'login resuelto por whoami', JSON.stringify(st));
  assert(!JSON.stringify(st).includes('ghp_fake'), 'el token NUNCA se expone en la respuesta');
  gh.whoami = originalWhoami;
  keyStore.delete('github_token');
}

// ── Run ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
  console.log(C.bold(C.cyan('  PIN local (§11.1) + Settings (§9) — Test Suite')));
  console.log(C.bold(C.cyan('════════════════════════════════════════════════════════')));

  try {
    await testPinLifecycle();
    await testLockAfterReload();
    await testSetConfigAutonomy();
    await testSetConfigAgent();
    await testGithubStatus();
  } finally {
    Module._load = realLoad;
    keyStore.clear();
  }

  console.log(C.bold('\n════════════════════════════════════════════════════════'));
  const total = passed + failed;
  console.log(
    C.bold(
      `  Resultado: ${C.green(passed + ' passed')}  ${failed > 0 ? C.red(failed + ' failed') : C.dim('0 failed')}  / ${total} total`
    )
  );
  console.log(C.bold('════════════════════════════════════════════════════════\n'));

  if (failed > 0) process.exit(1);
}

main();
