// config.js — carga de configuración del núcleo (LLM, MCP, sensores y
// autonomía) desde config.json, con merge de claves del llavero del sistema.

const { readJsonFile } = require('../utils/fsUtils.js');
const LLMProvider = require('../llm/LLMProvider.js');
const KeychainManager = require('../../infrastructure/keychain/KeychainManager.js');

const state = require('./state.js');

// ── Config LLM ────────────────────────────────────────────────────────────────

function loadLLMConfig() {
  try {
    if (!state.configPath || !require('fs').existsSync(state.configPath)) return;
    const cfg = readJsonFile(state.configPath, null);

    // Merge con keys del llavero del sistema (máxima prioridad)
    if (cfg?.llm?.apiKeys) {
      const keychainKeys = KeychainManager.getAllKeys(['groq', 'gemini', 'openai']);
      for (const [k, v] of Object.entries(keychainKeys)) {
        if (v) cfg.llm.apiKeys[k] = v;
      }
    }

    if (cfg?.llm) {
      LLMProvider.configure(cfg);
      console.log('[core] LLMProvider configurado, provider:', LLMProvider.getActiveProvider());
    }
  } catch (e) {
    console.warn('[core] error cargando config:', e.message);
  }
}

function reloadLLMConfig() {
  loadLLMConfig();
}

// ── MCP ────────────────────────────────────────────────────────────────────────
// Los servidores se guardan/editan desde main.js (que ya tiene loadConfig/
// saveConfig para config.json) — esto solo LEE al arrancar para reconectar
// automáticamente los que estaban enabled:true en la sesión anterior. No
// bloquea init() — si un servidor tarda o falla en conectar, el resto de
// el asistente sigue funcionando normal (por diseño: MCP es una capacidad extra,
// nunca un requisito).
function loadMCPConfig() {
  try {
    if (!state.configPath || !require('fs').existsSync(state.configPath)) {
      state.mcpReadyPromise = Promise.resolve();
      return;
    }
    const cfg = readJsonFile(state.configPath, null);
    const servers = cfg?.mcp?.servers || [];
    if (!servers.length) {
      state.mcpReadyPromise = Promise.resolve();
      return;
    }
    state.mcpReadyPromise = state.mcp
      .init(servers)
      .catch((e) => console.warn('[core] error inicializando servidores MCP:', e.message));
  } catch (e) {
    console.warn('[core] error leyendo config de MCP:', e.message);
    state.mcpReadyPromise = Promise.resolve();
  }
}

function readSensorsConfig() {
  const cfg = readJsonFile(state.configPath, null);
  return (cfg && cfg.sensors) || {};
}

function readAutonomyConfig() {
  const cfg = readJsonFile(state.configPath, null);
  return (cfg && cfg.autonomy) || 'suggest';
}

module.exports = {
  loadLLMConfig,
  reloadLLMConfig,
  loadMCPConfig,
  readSensorsConfig,
  readAutonomyConfig,
};
