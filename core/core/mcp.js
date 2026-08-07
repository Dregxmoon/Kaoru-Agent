// @ts-nocheck
// mcp.js — API pública de servidores MCP (listar, añadir, quitar, alternar y
// buscar en el registro).

const state = require('./state.js');

async function mcpListServers() {
  return state.mcp ? state.mcp.listServers() : [];
}

async function mcpAddServer(serverCfg) {
  if (!state.mcp) throw new Error('MCP no inicializado');
  return state.mcp.addServer(serverCfg);
}

async function mcpRemoveServer(id) {
  if (state.mcp) await state.mcp.removeServer(id);
}

async function mcpToggleServer(id, enabled, serverCfg) {
  if (state.mcp) await state.mcp.toggleServer(id, enabled, serverCfg);
}

async function mcpSearchRegistry(query) {
  return state.mcp ? state.mcp.searchRegistry(query) : [];
}

module.exports = {
  mcpListServers,
  mcpAddServer,
  mcpRemoveServer,
  mcpToggleServer,
  mcpSearchRegistry,
};
