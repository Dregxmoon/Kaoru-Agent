// @ts-check
'use strict';

const { MCPManager, MCPServerConnection } = require('../core/mcp/MCPManager.js');

let passed = 0;
let failed = 0;

/** @param {unknown} condition @param {string} label */
function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${label}`);
  }
}

function connection(name = 'unstable') {
  const conn = new MCPServerConnection({
    id: name,
    name,
    command: 'mock',
    circuitBreaker: { failureThreshold: 3, baseCooldownMs: 100 },
  });
  conn.status = 'connected';
  conn.tools = [{ name: 'work', inputSchema: { type: 'object', properties: {} } }];
  return conn;
}

async function main() {
  console.log('\nResiliencia MCP — salud y circuit breaker');
  const conn = connection();
  assert(conn.getHealth().score === 1, 'un servidor nuevo comienza con salud completa');
  let remoteCalls = 0;
  conn.client = {
    callTool: async () => {
      remoteCalls++;
      throw new Error('servidor saturado');
    },
  };

  for (let index = 0; index < 3; index++) {
    try {
      await conn.callTool('work', {});
    } catch (_) {}
  }
  const open = conn.getHealth();
  assert(open.breaker === 'open', 'tres fallos consecutivos abren el circuito');
  assert(open.failedCalls === 3, 'registra los fallos remotos');
  assert(open.score < 0.2, 'el score refleja degradación severa');

  let circuitError = null;
  try {
    await conn.callTool('work', {});
  } catch (error) {
    circuitError = error;
  }
  assert(circuitError?.code === 'MCP_CIRCUIT_OPEN', 'rechaza rápido mientras está abierto');
  assert(remoteCalls === 3, 'el rechazo no vuelve a martillar el servidor');

  const manager = new MCPManager();
  manager._connections.set(conn.id, conn);
  assert(manager.listAllTools().length === 0, 'tools degradadas desaparecen del resolver');
  assert(manager.listServers()[0].health.breaker === 'open', 'la salud se expone al panel');

  conn._health.openUntil = Date.now() - 1;
  conn.client.callTool = async () => {
    remoteCalls++;
    return { content: [{ type: 'text', text: 'recuperado' }] };
  };
  await conn.callTool('work', {});
  const recovered = conn.getHealth();
  assert(recovered.breaker === 'closed', 'una sonda exitosa cierra el circuito');
  assert(recovered.consecutiveFailures === 0, 'la recuperación limpia la racha de fallos');
  assert(manager.listAllTools().length === 1, 'las tools vuelven tras recuperarse');
  assert(recovered.averageLatencyMs !== null, 'mantiene latencia media observable');

  const probe = connection('probe');
  probe._circuitFailureThreshold = 1;
  probe.client = { callTool: async () => Promise.reject(new Error('caído')) };
  try {
    await probe.callTool('work', {});
  } catch (_) {}
  probe._health.openUntil = Date.now() - 1;
  /** @type {null|(()=>void)} */
  let releaseProbe = null;
  probe.client.callTool = () =>
    new Promise((resolve) => {
      releaseProbe = () => resolve({ content: [] });
    });
  const activeProbe = probe.callTool('work', {});
  let concurrentError = null;
  try {
    await probe.callTool('work', {});
  } catch (error) {
    concurrentError = error;
  }
  assert(concurrentError?.code === 'MCP_CIRCUIT_OPEN', 'half-open admite una sola sonda');
  releaseProbe?.();
  await activeProbe;
  assert(probe.getHealth().breaker === 'closed', 'la sonda exclusiva recupera el circuito');

  const cancelled = connection('cancelled');
  cancelled.client = {
    callTool: async () => {
      const error = new Error('cancelled');
      error.name = 'AbortError';
      throw error;
    },
  };
  try {
    await cancelled.callTool('work', {});
  } catch (_) {}
  assert(cancelled.getHealth().failedCalls === 0, 'cancelar el usuario no penaliza al servidor');

  console.log(`\nResultado: ${passed} passed  ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
