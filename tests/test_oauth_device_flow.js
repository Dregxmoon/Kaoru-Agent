'use strict';

const { OAuthDeviceFlow, DEVICE_CODE_URL, ACCESS_TOKEN_URL, DEFAULT_SCOPE } = require('../core/github/OAuthDeviceFlow.js');

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

// ── Test 1: start() parsea los campos del device code ────────────────────────

async function testStart() {
  console.log(C.bold('\n── Test 1: start() obtiene device_code y user_code ──────────────'));
  const calls = [];
  const fakeFetch = async (url, opts = {}) => {
    calls.push({ url, method: opts.method, body: opts.body?.toString?.() });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        device_code: 'dc_123',
        user_code: 'XXXX-YYYY',
        verification_uri: 'https://github.com/login/device',
        verification_uri_complete: 'https://github.com/login/device?user_code=XXXX-YYYY',
        expires_in: 900,
        interval: 5,
      }),
    };
  };
  const flow = new OAuthDeviceFlow({ fetch: fakeFetch, clientId: 'Iv1.abc' });
  const info = await flow.start();

  assert(info.deviceCode === 'dc_123', 'deviceCode parseado');
  assert(info.userCode === 'XXXX-YYYY', 'userCode parseado');
  assert(info.verificationUriComplete.includes('XXXX-YYYY'), 'verificationUriComplete con código');
  assert(info.expiresIn === 900 && info.interval === 5, 'expiresIn/interval');
  const call = calls[0];
  assert(call.url === DEVICE_CODE_URL, 'POST al endpoint de device code', call.url);
  assert(call.body.includes('client_id=Iv1.abc'), 'envía client_id', call.body);
  assert(decodeURIComponent(call.body).replace(/\+/g, ' ').includes(DEFAULT_SCOPE), 'envía scopes', call.body);
}

// ── Test 2: start() falla sin client_id ──────────────────────────────────────

function testNoClientId() {
  console.log(C.bold('\n── Test 2: sin client_id no se puede construir el flujo ──────────'));
  let threw = false;
  try { new OAuthDeviceFlow({ fetch: async () => {} }); } catch (e) { threw = /clientId/.test(e.message); }
  assert(threw, 'lanza error de clientId faltante');
}

// ── Test 3: poll() devuelve token ────────────────────────────────────────────

async function testPollToken() {
  console.log(C.bold('\n── Test 3: poll() devuelve access_token tras autorizar ───────────'));
  const fakeFetch = async (url, opts = {}) => ({
    ok: true,
    status: 200,
    json: async () => ({ access_token: 'gho_xyz', token_type: 'bearer', scope: 'repo read:user' }),
  });
  const flow = new OAuthDeviceFlow({ fetch: fakeFetch, clientId: 'Iv1.abc' });
  const res = await flow.poll('dc_1');
  assert(res.ok === true && res.accessToken === 'gho_xyz', 'token devuelto', JSON.stringify(res));
  assert(res.scope.includes('repo'), 'scope presente');
}

// ── Test 4: poll() pendiente / slow_down / denied / expired ─────────────────

async function testPollStates() {
  console.log(C.bold('\n── Test 4: poll() maneja los estados intermedios ────────────────'));
  const seq = [
    { error: 'authorization_pending' },
    { error: 'slow_down' },
    { error: 'access_denied' },
  ];
  const fakeFetch = async () => ({ ok: false, status: 200, json: async () => seq.shift() || { error: 'expired_token' } });
  const flow = new OAuthDeviceFlow({ fetch: fakeFetch, clientId: 'Iv1.abc' });

  const pending = await flow.poll('d');
  assert(pending.ok === false && pending.error === 'authorization_pending', 'authorization_pending');
  const slow = await flow.poll('d');
  assert(slow.error === 'slow_down', 'slow_down');
  const denied = await flow.poll('d');
  assert(denied.error === 'access_denied', 'access_denied');
  const expired = await flow.poll('d');
  assert(expired.error === 'expired_token', 'expired_token');
}

// ── Test 5: start() falla si el endpoint devuelve error ──────────────────────

async function testStartError() {
  console.log(C.bold('\n── Test 5: start() propaga error del endpoint ───────────────────'));
  const fakeFetch = async () => ({ ok: false, status: 422, json: async () => ({ error: 'invalid_client_id', error_description: 'Client id inválido' }) });
  const flow = new OAuthDeviceFlow({ fetch: fakeFetch, clientId: 'bad' });
  let err = null;
  try { await flow.start(); } catch (e) { err = e; }
  assert(err && /Client id inválido/.test(err.message), 'error_description propagado', err?.message);
  assert(err.status === 422, 'status preservado');
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
  console.log(C.bold(C.cyan('  Test Suite: §10 — OAuth Device Flow de GitHub ')));
  console.log(C.bold(C.cyan('════════════════════════════════════════════════════════')));

  await testStart();
  testNoClientId();
  await testPollToken();
  await testPollStates();
  await testStartError();

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
