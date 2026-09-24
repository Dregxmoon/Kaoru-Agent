// @ts-nocheck
'use strict';
const logger = require('../core/observability/Logger.js');
const LLMProvider = require('../core/llm/LLMProvider.js');
const SafeStorageCrypto = require('../infrastructure/config/SafeStorageCrypto.js');

const fs = require('fs/promises');
const path = require('path');
const { app, BrowserWindow, dialog, ipcMain } = require('electron');

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
        // Cifrar con safeStorage si el keychain nativo no está disponible.
        const toStore = key ? SafeStorageCrypto.encrypt(key) : key;
        newProviders[id] = { ...(newProviders[id] || {}), apiKey: toStore };
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
        if (m.selected && typeof m.selected === 'string') clean.selected = m.selected;
        if (Object.keys(clean).length > 0) {
          newProviders[id] = { ...(newProviders[id] || {}), model: clean };
        }
      }
    }

    const apiKeysToSave = keychainActive
      ? {}
      : SafeStorageCrypto.encryptAllKeys(
          Object.fromEntries(
            Object.entries(newProviders)
              .filter(([, p]) => p && p.apiKey)
              .map(([id, p]) => [id, p.apiKey])
          )
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
  ipcMain.handle('set-llm-model', (e, { provider, mode, model, reasoningEffort }) => {
    if (!provider || !model || !['fast', 'smart', 'all'].includes(mode)) return false;
    if (reasoningEffort != null && !['low', 'medium', 'high'].includes(reasoningEffort)) {
      return false;
    }
    const currentCfg = loadConfig();
    const providers = { ...(currentCfg.llm?.providers || {}) };
    const currentModel = providers[provider]?.model;
    const modelRoles =
      currentModel && typeof currentModel === 'object' && !Array.isArray(currentModel)
        ? currentModel
        : {};
    providers[provider] = {
      ...(providers[provider] || {}),
      model:
        mode === 'all'
          ? { fast: model, smart: model, selected: model }
          : { ...modelRoles, [mode]: model },
      reasoningEffort: {
        ...(providers[provider]?.reasoningEffort || {}),
        ...(reasoningEffort ? { [model]: reasoningEffort } : {}),
      },
    };
    saveConfig({
      llm: {
        ...(currentCfg.llm || {}),
        primary: mode === 'all' ? provider : currentCfg.llm?.primary || 'groq',
        fallback: currentCfg.llm?.fallback || ['gemini'],
        providers,
        apiKeys: currentCfg.llm?.apiKeys || {},
      },
    });
    ctx.Core.reloadLLMConfig();
    logger.info('config-handlers', `[config] modelo ${provider}/${mode} → ${model}`);
    return true;
  });

  // Panel de settings (§9): persiste autonomía y flags del agente con merge
  // del objeto existente (save() hace merge shallow top-level, así que el
  // patch de agent reemplaza el objeto completo — se mergea contra el actual).
  ipcMain.handle('set-config', (e, patch) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return { ok: false, error: 'patch inválido' };
    }
    const currentCfg = loadConfig();
    const next = { ...currentCfg };

    if (patch.autonomy !== undefined) {
      if (!['observe', 'suggest', 'act'].includes(patch.autonomy)) {
        return { ok: false, error: `autonomía inválida: ${patch.autonomy}` };
      }
      next.autonomy = patch.autonomy;
    }

    if (patch.onboarding !== undefined) {
      if (!patch.onboarding || typeof patch.onboarding !== 'object') {
        return { ok: false, error: 'onboarding inválido' };
      }
      if (typeof patch.onboarding.completed !== 'boolean') {
        return { ok: false, error: 'onboarding.completed debe ser boolean' };
      }
      next.onboarding = {
        completed: patch.onboarding.completed,
        version: 1,
      };
    }

    if (patch.agent !== undefined) {
      if (!patch.agent || typeof patch.agent !== 'object') {
        return { ok: false, error: 'agent inválido' };
      }
      const agent = { ...(currentCfg.agent || {}) };
      if (patch.agent.autoApprove !== undefined) {
        if (typeof patch.agent.autoApprove !== 'boolean') {
          return { ok: false, error: 'autoApprove debe ser boolean' };
        }
        agent.autoApprove = patch.agent.autoApprove;
      }
      if (patch.agent.approvalTimeoutMs !== undefined) {
        const n = Number(patch.agent.approvalTimeoutMs);
        if (!Number.isFinite(n) || n <= 0) {
          return { ok: false, error: 'approvalTimeoutMs debe ser > 0' };
        }
        agent.approvalTimeoutMs = n;
      }
      if (patch.agent.pinTimeoutMs !== undefined) {
        const n = Number(patch.agent.pinTimeoutMs);
        if (!Number.isFinite(n) || n < 0) {
          return { ok: false, error: 'pinTimeoutMs debe ser >= 0' };
        }
        agent.pinTimeoutMs = n;
      }
      next.agent = agent;
    }

    if (patch.mcp !== undefined) {
      if (!patch.mcp || typeof patch.mcp !== 'object' || Array.isArray(patch.mcp)) {
        return { ok: false, error: 'mcp inválido' };
      }
      const mcp = { ...(currentCfg.mcp || {}) };
      if (patch.mcp.autoConnect !== undefined) {
        if (typeof patch.mcp.autoConnect !== 'boolean') {
          return { ok: false, error: 'mcp.autoConnect debe ser boolean' };
        }
        mcp.autoConnect = patch.mcp.autoConnect;
      }
      next.mcp = mcp;
    }

    if (patch.browser !== undefined) {
      if (!patch.browser || typeof patch.browser !== 'object' || Array.isArray(patch.browser)) {
        return { ok: false, error: 'browser inválido' };
      }
      const browser = { ...(currentCfg.browser || {}) };
      if (patch.browser.mediaControl !== undefined) {
        if (!['external', 'managed'].includes(patch.browser.mediaControl)) {
          return { ok: false, error: 'mediaControl inválido' };
        }
        browser.mediaControl = patch.browser.mediaControl;
      }
      if (patch.browser.preferred !== undefined) {
        if (
          !['default', 'brave', 'chrome', 'chromium', 'edge', 'firefox'].includes(
            patch.browser.preferred
          )
        ) {
          return { ok: false, error: 'navegador preferido inválido' };
        }
        browser.preferred = patch.browser.preferred;
      }
      next.browser = browser;
    }

    saveConfig(next);
    if (patch.autonomy !== undefined) {
      Core.setAutonomyMode(patch.autonomy);
      logger.info('config-handlers', `[config] autonomía persistida → ${patch.autonomy}`);
    }
    if (patch.agent !== undefined) {
      logger.info('config-handlers', '[config] agent config actualizada');
    }
    if (patch.browser !== undefined) {
      require('../core/planner/LocalToolBridge.js')
        .getLocalToolBridge()
        .setBrowserPreferences(next.browser);
      logger.info('config-handlers', '[config] preferencia de navegador actualizada');
    }
    return { ok: true };
  });

  ipcMain.handle('maintenance-reset-permissions', () => {
    const rules = Core.permissionsList();
    let removed = 0;
    for (const rule of Array.isArray(rules) ? rules : []) {
      const result = Core.permissionsRemoveRule({ tool: rule.tool, path: rule.path || '' });
      if (result?.ok !== false) removed++;
    }
    return { ok: true, removed };
  });

  ipcMain.handle('maintenance-clear-cache', async () => {
    const userData = app.getPath('userData');
    const targets = [
      path.join(userData, 'llm-catalog.json'),
      path.join(userData, 'repository-intelligence.json'),
      path.join(userData, 'logs'),
      path.join(userData, 'crash.log'),
    ];
    const failed = [];
    for (const target of targets) {
      try {
        await fs.rm(target, { recursive: true, force: true });
      } catch (error) {
        failed.push({ path: target, error: error.message || String(error) });
      }
    }
    try {
      await fs.mkdir(path.join(userData, 'logs'), { recursive: true });
    } catch (_) {}
    return { ok: failed.length === 0, cleared: targets.length - failed.length, failed };
  });

  ipcMain.handle('maintenance-factory-reset', async (event, { confirmation } = {}) => {
    if (confirmation !== 'BORRAR TODO') {
      return { ok: false, error: 'Escribe BORRAR TODO para confirmar.' };
    }
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options = {
      type: 'warning',
      title: 'Restablecer Kaoru',
      message: '¿Borrar todos los datos locales de Kaoru?',
      detail:
        'Se eliminarán configuración, memoria, sesiones, permisos, cachés y credenciales de Kaoru. Tus proyectos y Documentos no se tocarán.',
      buttons: ['Cancelar', 'Borrar y reiniciar'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
    const choice = owner
      ? await dialog.showMessageBox(owner, options)
      : await dialog.showMessageBox(options);
    if (choice.response !== 1) return { ok: false, cancelled: true };
    const args = process.argv
      .slice(1)
      .filter((arg) => arg !== '--kaoru-factory-reset')
      .concat('--kaoru-factory-reset');
    app.relaunch({ args });
    setTimeout(() => app.exit(0), 100);
    return { ok: true, restarting: true };
  });

  ipcMain.handle('get-python-bin', () => ctx.PYTHON_BIN);

  // ── Selector modelo-first (nivel opencode) ────────────────────────────────
  // Datos del picker: todos los modelos (curado + remoto), providers con su
  // estado de conexión y favoritos. Sin secretos (getModelPickerData nunca
  // expone keys).
  ipcMain.handle('get-model-picker', () => {
    return LLMProvider.getModelPickerData();
  });

  ipcMain.handle('search-remote-providers', (_e, { query, limit } = {}) => {
    return LLMProvider.searchRemoteProviders(query, limit);
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
          ...(newProviders[providerId]?.model &&
          typeof newProviders[providerId].model === 'object' &&
          !Array.isArray(newProviders[providerId].model)
            ? newProviders[providerId].model
            : {}),
          ...activeModel,
          ...(mode === 'all' && modelId
            ? { fast: modelId, smart: modelId, selected: modelId }
            : {}),
        },
      };

      const keychainActive = !!useKeychain && ctx.KeychainManager.isAvailable();
      const apiKeys = { ...(currentCfg.llm?.apiKeys || {}) };
      if (keychainActive) {
        if (apiKey) ctx.KeychainManager.setKey(providerId, apiKey);
        else ctx.KeychainManager.deleteKey(providerId);
        delete apiKeys[providerId];
      } else if (apiKey && typeof apiKey === 'string' && apiKey.trim()) {
        ctx.KeychainManager.deleteKey(providerId);
        // Cifrar con safeStorage si el keychain nativo no está disponible.
        apiKeys[providerId] = SafeStorageCrypto.encrypt(apiKey.trim());
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

  ipcMain.handle('remove-llm-key', (_e, { providerId } = {}) => {
    const id = String(providerId || '')
      .trim()
      .toLowerCase();
    if (!id || !/^[a-z0-9][a-z0-9._-]{0,80}$/.test(id)) {
      return { ok: false, error: 'provider inválido' };
    }
    const currentCfg = loadConfig();
    const providers = { ...(currentCfg.llm?.providers || {}) };
    const apiKeys = { ...(currentCfg.llm?.apiKeys || {}) };
    if (providers[id]) {
      providers[id] = { ...providers[id] };
      delete providers[id].apiKey;
    }
    delete apiKeys[id];
    ctx.KeychainManager.deleteKey(id);
    saveConfig({
      llm: {
        ...(currentCfg.llm || {}),
        providers,
        apiKeys,
      },
    });
    Core.reloadLLMConfig();
    const environmentManaged = Object.entries(process.env).some(([name, value]) => {
      const match = name.match(/^LLM_KEY_(.+)$/);
      return match && match[1].toLowerCase() === id && typeof value === 'string' && value.trim();
    });
    logger.info('config-handlers', `[config] credencial LLM eliminada: ${id}`);
    return {
      ok: !environmentManaged,
      removed: true,
      ...(environmentManaged
        ? { error: 'La clave guardada se eliminó, pero existe otra en .env o el entorno.' }
        : {}),
    };
  });

  ipcMain.handle('replace-llm-key', (_e, { providerId, apiKey, useKeychain } = {}) => {
    const id = String(providerId || '')
      .trim()
      .toLowerCase();
    const key = String(apiKey || '').trim();
    if (!id || !/^[a-z0-9][a-z0-9._-]{0,80}$/.test(id)) {
      return { ok: false, error: 'provider inválido' };
    }
    if (!key || key.length > 8192) return { ok: false, error: 'API key inválida' };
    const currentCfg = loadConfig();
    const providers = { ...(currentCfg.llm?.providers || {}) };
    const apiKeys = { ...(currentCfg.llm?.apiKeys || {}) };
    const keychainActive = !!useKeychain && ctx.KeychainManager.isAvailable();
    if (keychainActive) {
      ctx.KeychainManager.setKey(id, key);
      delete apiKeys[id];
    } else {
      ctx.KeychainManager.deleteKey(id);
      apiKeys[id] = SafeStorageCrypto.encrypt(key);
    }
    providers[id] = { ...(providers[id] || {}) };
    delete providers[id].apiKey;
    saveConfig({
      llm: {
        ...(currentCfg.llm || {}),
        providers,
        apiKeys,
      },
    });
    Core.reloadLLMConfig();
    logger.info('config-handlers', `[config] credencial LLM reemplazada: ${id}`);
    return { ok: true };
  });

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
