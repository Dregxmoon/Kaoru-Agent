// @ts-nocheck
'use strict';
const logger = require('../core/observability/Logger.js');

const { ipcMain } = require('electron');

const MASKED_KEY_VALUE = '***';

function register(ctx) {
  const { Core, loadConfig, loadEffectiveConfig, redactKeys, saveConfig } = ctx;

  ipcMain.handle('get-config', () => redactKeys(loadEffectiveConfig()));

  ipcMain.handle('save-llm-keys', (e, { providers, useKeychain }) => {
    const currentCfg = loadConfig();
    const existingPrimary = currentCfg.llm?.primary || 'groq';
    const existingFallback = currentCfg.llm?.fallback || ['gemini'];

    const keychainActive = !!useKeychain && ctx.KeychainManager.isAvailable();

    const newProviders = { ...(currentCfg.llm?.providers || {}) };
    for (const [id, key] of Object.entries(providers || {})) {
      if (key === MASKED_KEY_VALUE) {
        // El renderer solo ve '***' (get-config redacta). Si llega sin
        // cambios, se conserva la key guardada sin tocarla.
        continue;
      }
      if (keychainActive) {
        if (key) ctx.KeychainManager.setKey(id, key);
        else ctx.KeychainManager.deleteKey(id);
        newProviders[id] = { ...(newProviders[id] || {}), apiKey: '' };
      } else {
        ctx.KeychainManager.deleteKey(id);
        newProviders[id] = { ...(newProviders[id] || {}), apiKey: key };
      }
    }

    const apiKeysToSave = keychainActive
      ? {}
      : Object.fromEntries(
          Object.entries(newProviders)
            .filter(([, p]) => p && p.apiKey)
            .map(([id, p]) => [id, p.apiKey])
        );

    saveConfig({
      llm: {
        primary: existingPrimary,
        fallback: existingFallback,
        providers: newProviders,
        apiKeys: apiKeysToSave,
      },
    });

    logger.info(
      'config-handlers',
      '[config] keys LLM actualizadas',
      keychainActive ? '(llavero del sistema)' : '(config.json)'
    );
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
