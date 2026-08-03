'use strict';

const { ipcMain } = require('electron');

function register(ctx) {
  const { Core, loadConfig, loadEffectiveConfig, saveConfig } = ctx;

  ipcMain.handle('get-config', () => loadEffectiveConfig());

  ipcMain.handle('save-llm-keys', (e, { providers, useKeychain }) => {
    const currentCfg = loadConfig();
    const existingPrimary = currentCfg.llm?.primary || 'groq';
    const existingFallback = currentCfg.llm?.fallback || ['gemini'];

    const keychainActive = !!useKeychain && ctx.KeychainManager.isAvailable();

    const newProviders = { ...(currentCfg.llm?.providers || {}) };
    for (const [id, key] of Object.entries(providers || {})) {
      if (keychainActive) {
        if (key) ctx.KeychainManager.setKey(id, key);
        else ctx.KeychainManager.deleteKey(id);
        newProviders[id] = { ...(newProviders[id] || {}), apiKey: '' };
      } else {
        ctx.KeychainManager.deleteKey(id);
        newProviders[id] = { ...(newProviders[id] || {}), apiKey: key };
      }
    }

    const apiKeysToSave = keychainActive ? {} : (providers || {});

    saveConfig({ llm: {
      primary: existingPrimary,
      fallback: existingFallback,
      providers: newProviders,
      apiKeys: apiKeysToSave,
    } });

    console.log('[config] keys LLM actualizadas', keychainActive ? '(llavero del sistema)' : '(config.json)');
    Core.reloadLLMConfig();
    return true;
  });

  ipcMain.handle('get-key-source', () => {
    return {
      source: ctx.keySource(),
      byProvider: ctx.keySourcesByProvider(),
      keychainAvailable: ctx.KeychainManager.isAvailable(),
    };
  });

  ipcMain.handle('get-python-bin', () => ctx.PYTHON_BIN);
}

module.exports = { register };