// @ts-nocheck
'use strict';
const logger = require('../core/observability/Logger.js');
const LLMProvider = require('../core/llm/LLMProvider.js');

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

  // ── Selector modelo-first (nivel opencode) ────────────────────────────────
  // Datos del picker: todos los modelos (curado + remoto), providers con su
  // estado de conexión y favoritos. Sin secretos (getModelPickerData nunca
  // expone keys).
  ipcMain.handle('get-model-picker', () => {
    return LLMProvider.getModelPickerData();
  });

  // Conecta un provider (registro si hace falta + key + primary) y asigna el
  // modelo al rol elegido. Persiste en config.json y recarga el pipeline.
  ipcMain.handle(
    'connect-llm-provider',
    (e, { providerId, apiKey, modelId, mode, useKeychain }) => {
      if (!providerId) return { ok: false, error: 'provider requerido' };
      const res = LLMProvider.connectProvider({ providerId, apiKey, modelId, mode });
      if (!res.ok) return res;

      const currentCfg = loadConfig();
      const newProviders = { ...(currentCfg.llm?.providers || {}) };
      const meta = LLMProvider.getProviderMeta(providerId) || {};
      const activeModel =
        (LLMProvider.getAvailableProviders() || []).find((p) => p.id === providerId)?.activeModel ||
        {};
      newProviders[providerId] = {
        ...(newProviders[providerId] || {}),
        model: {
          ...((newProviders[providerId] && newProviders[providerId].model) || {}),
          ...activeModel,
        },
      };

      const keychainActive = !!useKeychain && ctx.KeychainManager.isAvailable();
      const apiKeys = { ...(currentCfg.llm?.apiKeys || {}) };
      if (keychainActive) {
        if (apiKey) ctx.KeychainManager.setKey(providerId, apiKey);
        else ctx.KeychainManager.deleteKey(providerId);
        delete apiKeys[providerId];
      } else if (apiKey && typeof apiKey === 'string' && apiKey.trim()) {
        apiKeys[providerId] = apiKey.trim();
      }

      // Providers custom conectados desde models.dev: se persisten para
      // sobrevivir reinicios (con baseURL + tipo + catálogo).
      const customProviders = [...(currentCfg.llm?.customProviders || [])];
      const cp = meta.custom
        ? {
            id: providerId,
            name: meta.name,
            type: meta.type,
            baseURL: meta.baseURL,
            models: meta.models,
            catalog: Array.isArray(meta.catalog) ? meta.catalog : [],
          }
        : null;
      if (cp) {
        const idx = customProviders.findIndex((c) => c.id === providerId);
        if (idx >= 0) customProviders[idx] = cp;
        else customProviders.push(cp);
      }

      const primary = LLMProvider.getActiveProvider() || currentCfg.llm?.primary || 'groq';
      saveConfig({
        llm: {
          primary,
          fallback: currentCfg.llm?.fallback || ['gemini'],
          providers: newProviders,
          apiKeys,
          customProviders,
          queue: currentCfg.llm?.queue,
          remoteCatalog: currentCfg.llm?.remoteCatalog,
          favorites: currentCfg.llm?.favorites || [],
        },
      });
      ctx.Core.reloadLLMConfig();
      logger.info('config-handlers', `[config] provider conectado: ${providerId}`);
      return res;
    }
  );

  // Favoritos del picker: alterna y persiste llm.favorites.
  ipcMain.handle('favorite-model', (e, { modelKey, on }) => {
    if (typeof modelKey !== 'string' || !modelKey) return false;
    const currentCfg = loadConfig();
    let favorites = Array.isArray(currentCfg.llm?.favorites)
      ? currentCfg.llm.favorites.filter((f) => f !== modelKey)
      : [];
    if (on) favorites.push(modelKey);
    LLMProvider.setFavoriteModel(modelKey, on);
    saveConfig({
      llm: {
        primary: currentCfg.llm?.primary || 'groq',
        fallback: currentCfg.llm?.fallback || ['gemini'],
        providers: currentCfg.llm?.providers || {},
        apiKeys: currentCfg.llm?.apiKeys || {},
        customProviders: currentCfg.llm?.customProviders || [],
        queue: currentCfg.llm?.queue,
        remoteCatalog: currentCfg.llm?.remoteCatalog,
        favorites,
      },
    });
    logger.info('config-handlers', `[config] favorito ${on ? 'added' : 'removed'}: ${modelKey}`);
    return true;
  });
}

module.exports = { register };
