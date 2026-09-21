// @ts-check
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {
  buildGoogleWorkspaceConfig,
  validateGoogleWorkspace,
  authenticatedGoogleEmail,
} = require('../core/connectors/GoogleWorkspace.js');
const { storeGoogleSecret, resolveMCPEnv } = require('../core/connectors/MCPSecretStore.js');
const { MCPManager } = require('../core/mcp/MCPManager.js');
const storage = require('../infrastructure/config/SafeStorageCrypto.js');

const input = {
  clientId: '123-test.apps.googleusercontent.com',
  clientSecret: 'test-secret-only',
  services: ['calendar', 'gmail', 'contacts'],
  readOnly: true,
  uvxPath: process.execPath,
};

async function testConfiguration() {
  const cfg = await buildGoogleWorkspaceConfig(input);
  assert.deepEqual(cfg.args, [
    'workspace-mcp',
    '--tools',
    'calendar',
    'gmail',
    'contacts',
    '--read-only',
  ]);
  assert.equal(cfg.name, 'google-workspace');
  assert.equal(cfg.command, process.execPath);
  const writable = await buildGoogleWorkspaceConfig({ ...input, readOnly: false });
  assert(!writable.args.includes('--read-only'));
  for (const change of [
    { services: [] },
    { services: ['calendar,gmail'] },
    { services: ['__proto__'] },
    { clientId: 'bad' },
    { clientSecret: 'bad secret' },
    { readOnly: 'yes' },
  ])
    assert.throws(() => validateGoogleWorkspace({ ...input, ...change }));
  await assert.rejects(buildGoogleWorkspaceConfig({ ...input, uvxPath: '/no/such/uvx' }), /uvx/);
}

async function testSecrets() {
  const keys = new Map();
  const request = async (op, key, value) => {
    if (op === 'set') {
      keys.set(key, value);
      return true;
    }
    return keys.get(key);
  };
  const saved = await storeGoogleSecret('account-A', input.clientSecret, request);
  assert.equal(saved.storage, 'keychain');
  assert(!saved.value.includes(input.clientSecret));
  assert.equal(
    (await resolveMCPEnv({ GOOGLE_OAUTH_CLIENT_SECRET: saved.value }, request))
      .GOOGLE_OAUTH_CLIENT_SECRET,
    input.clientSecret
  );
  await assert.rejects(
    resolveMCPEnv({ KEY: saved.value }, async () => null),
    /llavero/
  );
  await assert.rejects(resolveMCPEnv({ KEY: 'keychain:openai' }, request), /inválida/);
  const other = await storeGoogleSecret('account-B', 'other-secret', request);
  assert.notEqual(saved.value, other.value);
  storage._setSafeStorage({
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value),
    decryptString: (buffer) => buffer.toString(),
  });
  try {
    const encrypted = await storeGoogleSecret('no-keyring', input.clientSecret, async () => false);
    assert.equal(encrypted.storage, 'encrypted');
    assert.equal((await resolveMCPEnv({ KEY: encrypted.value })).KEY, input.clientSecret);
  } finally {
    storage._setSafeStorage(null);
  }
  const legacy = await storeGoogleSecret('no-storage', input.clientSecret, async () => false);
  assert.equal(legacy.storage, 'plaintext');
}

async function testUpsertAndAccount() {
  const manager = new MCPManager();
  const cfg = {
    name: 'google-workspace',
    connector: 'google-workspace',
    command: process.execPath,
    args: [path.join(__dirname, 'fixtures/mcp/stdio.cjs')],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
  const events = [];
  manager.setOnAccountAuthenticated((account) => events.push(account));
  try {
    const first = await manager.addServer(cfg);
    assert.equal(first.status, 'connected', first.error);
    const [second, third] = await Promise.all([manager.addServer(cfg), manager.addServer(cfg)]);
    assert.equal(first.id, second.id);
    assert.equal(second.id, third.id);
    assert.equal(manager.listServers().length, 1);
    const conn = manager._connections.get(first.id);
    conn._consumeGoogleStderr(
      Buffer.from('INFO OAuth callback: Successfully authenticated user: someone@example.com.\n')
    );
    assert.equal(events.length, 1);
    conn._consumeGoogleStderr(Buffer.from('irrelevant secret log\nINFO Authenticated via stdio_'));
    conn._consumeGoogleStderr(Buffer.from('single_session: someone@example.com\n'));
    conn._consumeGoogleStderr(
      Buffer.from('INFO Authenticated via stdio_single_session: someone@example.com\n')
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].email, 'someone@example.com');
    assert.equal(manager.listServers()[0].accountEmail, 'someone@example.com');
    assert.equal(authenticatedGoogleEmail('tool output: hello someone@example.com'), null);
    assert.equal(
      authenticatedGoogleEmail('Authenticated via stdio_single_session: user@example.com garbage'),
      null
    );
  } finally {
    await manager.disconnectAll();
  }
}

async function testAuthBootstrap() {
  const state = require('../core/core/state.js');
  const { mcpStartGoogleAuth } = require('../core/core/mcp.js');
  const previous = state.mcp;
  let called = false;
  state.mcp = {
    callTool: async (id, name, args) => {
      assert.equal(id, 'workspace-id');
      assert.equal(name, 'start_google_auth');
      assert.deepEqual(args, { service_name: 'calendar', user_google_email: 'default' });
      called = true;
      return { content: [] };
    },
  };
  try {
    await mcpStartGoogleAuth('workspace-id', 'calendar');
    assert(called);
  } finally {
    state.mcp = previous;
  }
}

async function testIpcPersistence() {
  const handlers = {};
  let callback;
  let config = { mcp: { servers: [] } };
  let starts = 0;
  let opened = '';
  const context = {
    module: { exports: {} },
    global: {},
    process: { env: {} },
    URL,
    URLSearchParams,
    Buffer,
    AbortSignal,
    fetch: global.fetch,
    require: (name) => {
      if (name === 'electron')
        return {
          ipcMain: {
            handle: (key, fn) => {
              handlers[key] = fn;
            },
          },
          dialog: {},
          shell: {
            openExternal: async (url) => {
              opened = url;
            },
          },
        };
      if (name.includes('MCPSecretStore'))
        return {
          storeGoogleSecret: async () => ({
            value: 'keychain:mcp_google_' + 'a'.repeat(40),
            storage: 'keychain',
          }),
        };
      if (name.startsWith('.')) return require(path.resolve(__dirname, '../ipc', name));
      return require(name);
    },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../ipc/mcp-handlers.js'), 'utf8'),
    context
  );
  context.module.exports.register({
    S: {},
    loadConfig: () => config,
    saveConfig: (value) => {
      config = value;
    },
    Core: {
      mcpOnAccountAuthenticated: (fn) => {
        callback = fn;
      },
      mcpAddServer: async (cfg) => ({ id: cfg.id, status: 'connected', toolCount: 4 }),
      mcpStartGoogleAuth: async () => {
        starts++;
        return {
          content: [
            {
              type: 'text',
              text: 'Authorization URL: https://accounts.google.com/o/oauth2/auth?test=true',
            },
          ],
        };
      },
    },
  });
  const first = await handlers['mcp-google-workspace-connect']({}, input);
  assert(first.ok, first.error);
  assert(first.authStarted);
  assert.equal(starts, 1);
  assert(opened.startsWith('https://accounts.google.com/'));
  assert(!JSON.stringify(config).includes(input.clientSecret));
  callback({ id: first.status.id, email: 'account@example.com' });
  assert.equal(config.mcp.servers[0].env.USER_GOOGLE_EMAIL, 'account@example.com');
  const again = await handlers['mcp-google-workspace-connect']({}, input);
  assert.equal(again.status.id, first.status.id);
  assert.equal(config.mcp.servers.length, 1);
  assert.equal(config.mcp.servers[0].env.USER_GOOGLE_EMAIL, 'account@example.com');
  const info = await handlers['mcp-google-workspace-info']();
  assert.equal(info.email, 'account@example.com');
  assert(!JSON.stringify(info).includes('keychain:'));
  callback({ id: 'other-server', email: 'wrong@example.com' });
  assert.equal(config.mcp.servers[0].env.USER_GOOGLE_EMAIL, 'account@example.com');
  const rejected = await handlers['mcp-google-workspace-connect']({}, { ...input, services: [] });
  assert(!rejected.ok);
  for (const file of ['ipc/channel-whitelist.js', 'src/chat/preload.js']) {
    const text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    for (const channel of [
      'mcp-google-workspace-info',
      'mcp-google-workspace-connect',
      'mcp-google-workspace-console',
    ])
      assert(!text.includes(`'${channel}'`), `${channel} no debe exponerse en producción`);
  }
}
(async () => {
  for (const test of [
    testConfiguration,
    testSecrets,
    testUpsertAndAccount,
    testAuthBootstrap,
    testIpcPersistence,
  ]) {
    await test();
    console.log(`✓ ${test.name}`);
  }
  console.log('Resultado: 5 passed  0 failed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
