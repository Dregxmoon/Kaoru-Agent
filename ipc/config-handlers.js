// @ts-nocheck
'use strict';
const logger = require('../core/observability/Logger.js');

const { ipcMain } = require('electron');

const MASKED_KEY_VALUE = '***';

function register(ctx) {
  const { Core, loadConfig, loadEffectiveConfig, redactKeys, saveConfig } = ctx;

  ipcMain.handle('get-config', () => redactKeys(loadEffectiveConfig()));

  ipcMain.handle('save-llm-keys', (e, { providers, useKeychain, models }) => {
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

    // Fase Q: el selector de modelos persiste el modelo elegido por
    // proveedor+modo (llm.providers[id].model.{fast,smart}). Se conserva
    // aunque esa corrida solo toque keys.
    if (models && typeof models === 'object') {
      for (const [id, m] of Object.entries(models)) {
        if (!m || typeof m !== 'object') continue;
        const clean = {};
        if (m.fast && typeof m.fast === 'string') clean.fast = m.fast;
        if (m.smart && typeof m.smart === 'string') clean.smart = m.smart;
        if (Object.keys(clean).length > 0) {
          newProviders[id] = { ...(newProviders[id] || {}), model: clean };
        }
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

  // Fase Q: /model id <modelo> [fast|smart] persiste el modelo elegido por
  // proveedor+modo en config.json (llm.providers[id].model[modo]) sin tocar keys.
  ipcMain.handle('set-llm-model', (e, { provider, mode, model }) => {
    if (!provider || !model || !['fast', 'smart'].includes(mode)) return false;
    const currentCfg = loadConfig();
    const providers = { ...(currentCfg.llm?.providers || {}) };
    providers[provider] = {
      ...(providers[provider] || {}),
      model: { ...(providers[provider]?.model || {}), [mode]: model },
    };
    saveConfig({
      llm: {
        primary: currentCfg.llm?.primary || 'groq',
        fallback: currentCfg.llm?.fallback || ['gemini'],
        providers,
        apiKeys: currentCfg.llm?.apiKeys || {},
      },
    });
    ctx.Core.reloadLLMConfig();
    logger.info('config-handlers', `[config] modelo ${provider}/${mode} → ${model}`);
    return true;
  });

  ipcMain.handle('get-python-bin', () => ctx.PYTHON_BIN);
}

module.exports = { register };
