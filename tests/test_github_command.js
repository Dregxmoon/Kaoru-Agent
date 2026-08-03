'use strict';

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

const VALID_PAT = 'ghp_' + 'a1b2c3d4e5f6a7b8c9d0'.repeat(2); // 40+ chars, parece válido

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Captura la definición del comando vía el register() del módulo.
const registerCommands = require('../core/commands/github.js');
let def = null;
registerCommands((d) => { def = d; });
assert(def && def.name === 'github', 'comando /github registrado');

function makeHarness(opts = {}) {
  const calls = { set: [], delete: [], configure: [] };
  const kc = {
    setKey: (k, v) => { calls.set.push([k, v]); return opts.setOk !== false; },
    deleteKey: (k) => { calls.delete.push(k); return opts.deleteOk !== false; },
    getKey: () => (opts.storedToken || null),
  };
  const gh = {
    configure: (o) => { calls.configure.push(o); },
    whoami: async () => {
      if (opts.whoamiError) throw new Error(opts.whoamiError);
      return opts.whoami || { login: 'panfilo', name: 'Panfilo', publicRepos: 3 };
    },
    get hasToken() {
      return Promise.resolve(!!(opts.token || opts.storedToken));
    },
  };
  const ctx = { githubManager: gh, KeychainManager: kc };
  return { calls, gh, kc, ctx };
}

function run(args, ctx) {
  return def.handler(args, ctx);
}

// ── Test 1: status sin token ─────────────────────────────────────────────────

async function testStatusNoToken() {
  console.log(C.bold('\n── Test 1: status sin cuenta conectada ──────────────────────────'));
  const { ctx } = makeHarness();
  const out = await run(['status'], ctx);
  assert(/no hay cuenta conectada/.test(out), 'avisa que no hay cuenta', out);
  const out2 = await run([], ctx);
  assert(/no hay cuenta conectada/.test(out2), 'sin args → status', out2);
}

// ── Test 2: login sin token / inválido ───────────────────────────────────────

async function testLoginValidation() {
  console.log(C.bold('\n── Test 2: login valida el token antes de persistir ─────────────'));
  const { calls, ctx } = makeHarness();
  const noToken = await run(['login'], ctx);
  assert(/Client ID/.test(noToken), 'sin PAT → pide configurar Client ID', noToken);
  assert(calls.set.length === 0, 'no persistió nada sin token');

  const short = await run(['login', 'abc'], ctx);
  assert(/muy corto/.test(short), 'PAT corto rechazado', short);
  assert(calls.set.length === 0, 'PAT corto no persistido');
}

// ── Test 3: login con token válido ───────────────────────────────────────────

async function testLoginSuccess() {
  console.log(C.bold('\n── Test 3: login verifica, persiste y reporta la cuenta ─────────'));
  const { calls, ctx } = makeHarness({ whoami: { login: 'panfilo', name: 'Panfilo', publicRepos: 7 } });
  const out = await run(['login', VALID_PAT], ctx);
  assert(/@panfilo/.test(out), 'muestra la cuenta conectada', out);
  assert(calls.set.some(([k, v]) => k === 'github_token' && v === VALID_PAT), 'persistió en github_token');
  assert(calls.configure[0] && calls.configure[0].token === VALID_PAT, 'configuró el manager con el token');
  assert(!out.includes(VALID_PAT), 'el token NO aparece en la respuesta');
  assert(calls.configure[0].token !== VALID_PAT || !out.includes(VALID_PAT), 'token nunca filtrado');
}

// ── Test 4: login con token inválido (API rechaza) ───────────────────────────

async function testLoginRejected() {
  console.log(C.bold('\n── Test 4: token rechazado por la API → no se guarda nada ───────'));
  const { calls, ctx } = makeHarness({ whoamiError: 'Token inválido o sin permisos.' });
  const out = await run(['login', VALID_PAT], ctx);
  assert(/se pudo verificar/i.test(out), 'informa el error de verificación', out);
  assert(calls.set.length === 0, 'token inválido NO se persiste');
  assert(!out.includes(VALID_PAT), 'el token rechazado no aparece');
}

// ── Test 5: whoami ───────────────────────────────────────────────────────────

async function testWhoami() {
  console.log(C.bold('\n── Test 5: whoami conectado y desconectado ──────────────────────'));
  const ok = makeHarness({ whoami: { login: 'octo', name: 'Octo Cat', publicRepos: 12 } });
  const outOk = await run(['whoami'], ok.ctx);
  assert(/@octo/.test(outOk) && /12/.test(outOk), 'muestra login y repos', outOk);

  const fail = makeHarness({ whoamiError: 'no' });
  const outFail = await run(['whoami'], fail.ctx);
  assert(/No hay una sesión/.test(outFail), 'sin sesión → aviso', outFail);
}

// ── Test 6: logout ───────────────────────────────────────────────────────────

async function testLogout() {
  console.log(C.bold('\n── Test 6: logout elimina el token y limpia memoria ─────────────'));
  const { calls, ctx } = makeHarness({ storedToken: VALID_PAT });
  const out = await run(['logout'], ctx);
  assert(/cerrada/.test(out), 'confirma cierre de sesión', out);
  assert(calls.delete.includes('github_token'), 'borró github_token del llavero');
  assert(calls.configure.some(c => c.token === null), 'limpió el token en memoria');
}

// ── Test 7: keychain no disponible → advertencia de sesión ───────────────────

async function testPersistenceWarning() {
  console.log(C.bold('\n── Test 7: sin llavero → advierte que es solo de sesión ─────────'));
  const { ctx } = makeHarness({ setOk: false });
  const out = await run(['login', VALID_PAT], ctx);
  assert(/solo durante esta sesión/.test(out), 'avisa persistencia fallida', out);
  assert(/@panfilo/.test(out), 'aún así conecta en memoria', out);
  assert(!out.includes(VALID_PAT), 'token no filtrado');
}

// ── Test 8: registro global ──────────────────────────────────────────────────

async function testRegistry() {
  console.log(C.bold('\n── Test 8: /github en el registro de comandos ───────────────────'));
  const { getNames, getHelp } = require('../core/commands/CommandRegistry.js');
  assert(getNames().includes('github'), 'github está en getNames');
  const help = getHelp();
  assert(help.includes('/github'), 'aparece en /help', help.slice(0, 300));
}

// ── Test 9: client-id guarda el Client ID ────────────────────────────────────

async function testClientId() {
  console.log(C.bold('\n── Test 9: /github client-id guarda el Client ID ────────────────'));
  const { calls, ctx } = makeHarness();
  const noArg = await run(['client-id'], ctx);
  assert(/applications\/new/.test(noArg), 'sin arg → explica cómo crear la app', noArg);
  const ok = await run(['client-id', 'Iv1.abc123'], ctx);
  assert(/Client ID guardado/.test(ok), 'confirma el guardado', ok);
  assert(calls.set.some(([k, v]) => k === 'github_client_id' && v === 'Iv1.abc123'), 'persistió github_client_id');
}

// ── Test 10: login con device flow abre navegador y notifica ─────────────────

async function testDeviceLogin() {
  console.log(C.bold('\n── Test 10: /github login dispara el device flow ────────────────'));
  const notified = [];
  const calls = { set: [], open: [] };
  const kc = {
    setKey: (k, v) => { calls.set.push([k, v]); return true; },
    deleteKey: (k) => true,
    getKey: (k) => (k === 'github_client_id' ? 'Iv1.abc' : null),
  };
  let polled = 0;
  const gh = {
    configure: () => {},
    whoami: async () => ({ login: 'panfilo', name: 'Panfilo', publicRepos: 3 }),
    get hasToken() { return Promise.resolve(false); },
  };
  const fakeFlow = {
    start: async () => ({
      deviceCode: 'dc_1', userCode: 'ABCD-EFGH',
      verificationUri: 'https://github.com/login/device',
      verificationUriComplete: 'https://github.com/login/device?user_code=ABCD-EFGH',
      expiresIn: 900, interval: 0.05,
    }),
    poll: async () => {
      polled++;
      if (polled === 1) return { ok: false, error: 'authorization_pending' };
      return { ok: true, accessToken: 'gho_devtoken', tokenType: 'bearer', scope: 'repo' };
    },
  };
  const ctx = {
    githubManager: gh,
    KeychainManager: kc,
    createDeviceFlow: (opts) => { assert(opts.clientId === 'Iv1.abc', 'clientId pasado al flujo'); return fakeFlow; },
    openExternal: (url) => { calls.open.push(url); },
    addMessage: (role, text) => { notified.push(text); },
    pushToSession: () => {},
  };

  const out = await run(['login'], ctx);
  assert(/AB CD|ABCD/.test(out) || /verificationUri/.test(out) || out.includes('GitHub'), 'responde al instante', out.slice(0, 120));
  assert(!out.includes('gho_devtoken'), 'el token del flujo no aparece en la respuesta inicial');
  assert(calls.open[0] && calls.open[0].includes('ABCD-EFGH'), 'abrió el navegador con el código pre-cargado', calls.open[0]);

  // Esperar a que el poll en background complete (floor de intervalo = 1s →
  // 2 polls ≈ 2s) y notifique.
  await sleep(2800);
  assert(calls.set.some(([k, v]) => k === 'github_token' && v === 'gho_devtoken'), 'persistió el token del flujo', JSON.stringify(calls.set));
  assert(notified.some(t => t.includes('@panfilo')), 'notificó por chat la cuenta conectada', notified.join(' | '));
  assert(notified.some(t => t.includes('gho_devtoken')) === false, 'el token nunca se notifica por chat');
}

// ── Test 11: device flow sin client_id → instrucciones ───────────────────────

async function testDeviceLoginNoClientId() {
  console.log(C.bold('\n── Test 11: device flow sin client_id explica el setup ───────────'));
  const { ctx } = makeHarness();
  const out = await run(['login'], ctx);
  assert(/Client ID/.test(out) && /applications\/new/.test(out), 'explica cómo crear la OAuth App', out);
  assert(/PAT/.test(out), 'ofrece la alternativa PAT', out);
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
  console.log(C.bold(C.cyan('  Test Suite: §10 — comando /github (conexión de cuenta) ')));
  console.log(C.bold(C.cyan('════════════════════════════════════════════════════════')));

  await testStatusNoToken();
  await testLoginValidation();
  await testLoginSuccess();
  await testLoginRejected();
  await testWhoami();
  await testLogout();
  await testPersistenceWarning();
  await testRegistry();
  await testClientId();
  await testDeviceLogin();
  await testDeviceLoginNoClientId();

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
