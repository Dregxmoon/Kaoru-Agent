// @ts-check
'use strict';
const assert = require('assert/strict');
const http = require('http');
// El servidor SDK de prueba usa Web Crypto, ausente del global en Electron 28.
globalThis.crypto ||= require('crypto').webcrypto;
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const {
  StreamableHTTPServerTransport,
} = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const { MCPManager } = require('../core/mcp/MCPManager.js');
const { OAuthCallbackServer } = require('../core/connectors/OAuthCallbackServer.js');
const { resolveConnectorScopes } = require('../core/connectors/ConnectorRegistry.js');
const { resolveToolset } = require('../core/task/ToolResolver.js');

async function testStdio() {
  const manager = new MCPManager();
  const cfg = {
    name: 'local',
    command: process.execPath,
    args: [path.join(__dirname, 'fixtures/mcp/stdio.cjs')],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
  try {
    const status = await manager.addServer(cfg);
    assert.equal(status.status, 'connected', status.error);
    assert(JSON.stringify(await manager.callTool('local', 'ping', {})).includes('pong'));
    await manager.toggleServer(status.id, false);
    assert.equal(manager.hasConnectedServers(), false);
    await manager.toggleServer(status.id, true, cfg);
    assert.equal(manager.hasConnectedServers(), true);
    await manager.removeServer(status.id);
    assert.equal(manager.listServers().length, 0);
  } finally {
    await manager.disconnectAll();
  }
}

async function testRemote() {
  const server = new Server({ name: 'test', version: '1' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async (req) => ({
    tools: [
      {
        name: req.params?.cursor ? 'second' : 'first',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
    ...(req.params?.cursor ? {} : { nextCursor: 'page2' }),
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: 'text', text: 'connector works' }],
  }));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => 'test-session' });
  await server.connect(transport);
  let authSeen = false;
  const listener = http.createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer test-only') {
      res.writeHead(401).end();
      return;
    }
    authSeen = true;
    void transport.handleRequest(req, res);
  });
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address();
  assert(address && typeof address !== 'string');
  const manager = new MCPManager();
  try {
    const status = await manager.addServer({
      name: 'remote',
      identifier: 'test/remote',
      transport: 'streamable-http',
      url: `http://127.0.0.1:${address.port}/mcp`,
      env: { MCP_AUTH_TOKEN: 'test-only' },
    });
    assert.equal(status.status, 'connected');
    assert.equal(status.toolCount, 2);
    assert(authSeen);
    const resolved = await resolveToolset({
      mcpManager: manager,
      toolRegistry: { _getOpenClawTools: () => [] },
    });
    assert.equal(Object.keys(resolved.nativeMcpMap).length, 2);
    const target = Object.values(resolved.nativeMcpMap)[0];
    const result = await manager.callTool(target.server, target.tool, {});
    assert(JSON.stringify(result).includes('connector works'));
    assert(!JSON.stringify(manager.listServers()).includes('test-only'));
    assert.equal(manager.listServers()[0].identifier, 'test/remote');
    await assert.rejects(
      manager.addServer({ id: 'another-id', name: 'remote', command: 'mock' }),
      /otro servidor/
    );
    await manager.toggleServer(status.id, false);
    assert.equal(manager.listAllTools().length, 0);
  } finally {
    await manager.disconnectAll();
    await server.close();
    listener.closeAllConnections();
    await new Promise((resolve) => listener.close(resolve));
  }
}

async function testCallback() {
  const states = new Map();
  let exchanges = 0;
  const callback = new OAuthCallbackServer(
    states,
    async () => {
      exchanges++;
      return { TOKEN: 'test-secret' };
    },
    { port: 0, ttlMs: 10000 }
  );
  try {
    const url = await callback.start();
    states.set('valid', { createdAt: Date.now() });
    assert.equal((await fetch(`${url}?state=unknown&code=x`)).status, 400);
    assert.equal(exchanges, 0);
    const success = await fetch(`${url}?state=valid&code=x`);
    assert.equal(success.status, 200);
    assert(!(await success.text()).includes('test-secret'));
    assert.equal(states.get('valid').tokens.TOKEN, 'test-secret');
    assert.equal((await fetch(`${url}?state=valid&code=x`)).status, 409);
    assert.equal(exchanges, 1);
    states.set('expired', { createdAt: Date.now() - 20000 });
    assert.equal((await fetch(`${url}?state=expired&code=x`)).status, 400);
    states.set('denied', { createdAt: Date.now() });
    await fetch(`${url}?state=denied&error=access_denied`);
    assert(states.get('denied').error);
    callback.exchange = async () => {
      throw new Error('secret-provider-error');
    };
    states.set('failed', { createdAt: Date.now() });
    const failure = await fetch(`${url}?state=failed&code=x`);
    assert.equal(failure.status, 502);
    assert(!(await failure.text()).includes('secret-provider-error'));
  } finally {
    callback.close();
  }
}

async function testToolErrors() {
  const { MCPServerConnection } = require('../core/mcp/MCPManager.js');
  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const manager = new MCPManager();
  const conn = new MCPServerConnection({ id: 'error', name: 'error' });
  conn.status = 'connected';
  conn.tools = [{ name: 'work', inputSchema: { type: 'object', properties: {} } }];
  conn.client = {
    callTool: async () => ({
      isError: true,
      content: [{ type: 'text', text: 'operation failed' }],
    }),
  };
  manager._connections.set(conn.id, conn);
  const loop = Object.create(AgentLoop.prototype);
  loop._mcp = manager;
  const result = await loop._executeMCP({ params: { server: 'error', tool: 'work', args: {} } });
  assert.equal(result.ok, false);
  assert(result.error.includes('operation failed'));
  assert.equal(conn.getHealth().failedCalls, 1);
  assert.equal(conn.getHealth().successfulCalls, 0);
  const restored = new MCPManager();
  await restored.init([{ id: 'disabled', name: 'disabled', command: 'unused', enabled: false }]);
  assert.equal(restored.listServers()[0].status, 'disconnected');
  assert.equal(restored.listAllTools().length, 0);
  const savedEnabled = new MCPManager();
  await savedEnabled.init([{ id: 'saved', name: 'saved', command: 'unused', enabled: true }]);
  assert.equal(savedEnabled.listServers()[0].status, 'disconnected');
  assert.equal(savedEnabled.listAllTools().length, 0);
}

async function testRouting() {
  const resolved = await resolveToolset({
    toolRegistry: {
      _getOpenClawTools: () => [{ name: 'read', source: 'openclaw', domain: ['filesystem'] }],
    },
    mcpManager: {
      listAllTools: () => [{ server: 'filesystem', tool: 'read_file' }],
      listServers: () => [{ name: 'filesystem', health: { breaker: 'open' } }],
    },
  });
  assert(resolved.nativeToolSchemas.some((tool) => tool.name === 'read'));
  assert.equal(Object.keys(resolved.nativeMcpMap).length, 0);
  assert(!resolved.promptCatalog.includes('read_file'));
  assert.equal(resolveConnectorScopes('github', ['read']).access, 'write');
  assert.throws(() => resolveConnectorScopes('google', ['toString']));
  assert.equal(resolveConnectorScopes('__proto__', []), null);
}

async function testIpc() {
  const handlers = {};
  let states;
  let opened;
  let installed;
  let saved;
  const fakeElectron = {
    ipcMain: {
      handle: (name, fn) => {
        handlers[name] = fn;
      },
    },
    dialog: {},
    shell: {
      openExternal: async (url) => {
        opened = url;
      },
    },
  };
  const sandbox = {
    module: { exports: {} },
    process: { env: { GITHUB_CLIENT_ID: 'test-id', GITHUB_CLIENT_SECRET: 'test-client-secret' } },
    URLSearchParams,
    URL,
    AbortSignal,
    Buffer,
    fetch: global.fetch,
    global: {},
    require: (name) => {
      if (name === 'electron') return fakeElectron;
      if (name.includes('Logger')) return { error: () => {}, warn: () => {} };
      if (name.includes('OAuthCallbackServer'))
        return {
          OAuthCallbackServer: class {
            constructor(value) {
              states = value;
            }
            async start() {
              return 'http://127.0.0.1:18790/mcp/oauth/callback';
            }
          },
        };
      if (name.includes('SafeStorageCrypto'))
        return {
          encryptAllKeys: (env) =>
            Object.fromEntries(Object.keys(env).map((key) => [key, 'encrypted'])),
        };
      if (name.startsWith('.')) return require(path.resolve(__dirname, '../ipc', name));
      return require(name);
    },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../ipc/mcp-handlers.js'), 'utf8'),
    sandbox
  );
  sandbox.module.exports.register({
    Core: {
      mcpAddServer: async (cfg) => {
        installed = cfg;
        return { id: 'one', status: 'connected' };
      },
    },
    S: {},
    loadConfig: () => ({}),
    saveConfig: (cfg) => {
      saved = cfg;
    },
  });
  assert.equal((await handlers['mcp-get-oauth-providers']()).github, true);
  const start = await handlers['mcp-oauth-start'](
    {},
    {
      provider: 'github',
      serverName: 'GitHub',
      serverIdentifier: '@modelcontextprotocol/server-github',
      capabilities: ['read'],
    }
  );
  assert(start.ok);
  assert.equal(opened, start.authUrl);
  states.get(start.state).tokens = { GITHUB_PERSONAL_ACCESS_TOKEN: 'test-secret' };
  const result = await handlers['mcp-oauth-check']({}, { state: start.state });
  assert(result.completed);
  assert(!JSON.stringify(result).includes('test-secret'));
  assert.equal(installed.env.GITHUB_PERSONAL_ACCESS_TOKEN, 'test-secret');
  assert.equal(saved.mcp.servers[0].env.GITHUB_PERSONAL_ACCESS_TOKEN, 'encrypted');
  assert((await handlers['mcp-oauth-check']({}, { state: start.state })).error);
}

(async () => {
  for (const test of [testStdio, testRemote, testCallback, testRouting, testIpc, testToolErrors]) {
    await test();
    console.log(`✓ ${test.name}`);
  }
  console.log('Resultado: 6 passed  0 failed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
