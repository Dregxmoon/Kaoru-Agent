// @ts-nocheck
'use strict';
const logger = require('../core/observability/Logger.js');

const crypto = require('crypto');
const { ipcMain, dialog, shell } = require('electron');
const { OAuthCallbackServer } = require('../core/connectors/OAuthCallbackServer.js');
const SafeStorageCrypto = require('../infrastructure/config/SafeStorageCrypto.js');
const { buildGoogleWorkspaceConfig, findUvx } = require('../core/connectors/GoogleWorkspace.js');
const { storeGoogleSecret } = require('../core/connectors/MCPSecretStore.js');
const { resolveConnectorScopes } = require('../core/connectors/ConnectorRegistry.js');

// TTL de estados OAuth pendientes: si un state nunca completa el flujo
// (usuario cierra la ventana, cancela, o simplemente lo abandona), antes
// quedaba vivo para siempre en el Map — fuga de memoria y una ventana de
// reutilización de 'state' más larga de lo necesario (mitigación CSRF).
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutos

function _sweepExpiredOAuthStates(states) {
  const now = Date.now();
  for (const [state, data] of states) {
    if (now - (data.createdAt || 0) > OAUTH_STATE_TTL_MS) states.delete(state);
  }
}

function register(ctx) {
  const { Core, S, loadConfig, saveConfig } = ctx;

  ipcMain.handle('pick-workspace-folder', async (event) => {
    if (!S.chatWindow || event.sender !== S.chatWindow.webContents)
      return { ok: false, error: 'Ventana no autorizada' };
    if (
      require('./openclaw-handlers.js').hasActiveRun() ||
      require('./chat-handlers.js').hasSimpleRun() ||
      require('./chat-handlers.js').hasRendererBusy()
    )
      return { ok: false, error: 'Espera a que termine Kaoru o cancela la tarea' };
    const result = await dialog.showOpenDialog(S.chatWindow, { properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths.length) return null;
    const switched = await Core.switchConversation({ workspace: result.filePaths[0] });
    if (switched.ok) {
      if (!switched.unchanged) require('./openclaw-handlers.js').resetSessionApprovals();
      S.chatWindow.webContents.send('conversation-opened', switched.conversation);
    }
    return switched;
  });

  ipcMain.handle('choose-workspace-folder', async (event) => {
    if (!S.chatWindow || event.sender !== S.chatWindow.webContents) return null;
    const result = await dialog.showOpenDialog(S.chatWindow, { properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0] || null;
  });

  ipcMain.handle('get-workspace', () => {
    try {
      return Core.getWorkspace();
    } catch (e) {
      logger.warn('mcp-handlers', '[main] error en get-workspace:', e.message);
      return null;
    }
  });

  ipcMain.handle('mcp-list-servers', async () => {
    try {
      return await Core.mcpListServers();
    } catch (e) {
      logger.error('mcp-handlers', '[main] error en mcp-list-servers:', e.message);
      return { error: e.message };
    }
  });

  ipcMain.handle('mcp-search-registry', async (e, { query, category, sort, limit }) => {
    try {
      return await Core.mcpSearchRegistry(query || '', { category, sort, limit });
    } catch (e) {
      logger.error('mcp-handlers', '[main] error en mcp-search-registry:', e.message);
      return { error: e.message };
    }
  });

  ipcMain.handle('mcp-get-featured', async (e, limit = 12) => {
    try {
      return await Core.mcpGetFeatured(limit);
    } catch (e) {
      logger.error('mcp-handlers', '[main] error en mcp-get-featured:', e.message);
      return { error: e.message };
    }
  });

  ipcMain.handle('mcp-get-categories', async () => {
    try {
      return Core.mcpGetCategories();
    } catch (e) {
      logger.error('mcp-handlers', '[main] error en mcp-get-categories:', e.message);
      return { error: e.message };
    }
  });

  ipcMain.handle('mcp-get-oauth-providers', async () => {
    try {
      // Solo anunciar proveedores con configuración utilizable.
      const providers = [
        'github',
        'gitlab',
        'google',
        'microsoft',
        'slack',
        'discord',
        'notion',
        'linear',
        'atlassian',
      ];
      const result = {};
      for (const p of providers) {
        const config = _getOAuthConfig(p);
        result[p] = !!(config && config.clientId);
      }
      return result;
    } catch (e) {
      logger.error('mcp-handlers', '[main] error en mcp-get-oauth-providers:', e.message);
      return { error: e.message };
    }
  });

  Core.mcpOnAccountAuthenticated?.(({ id, email }) => {
    const servers = loadConfig()?.mcp?.servers || [];
    const server = servers.find((item) => item.id === id);
    if (!server || server.env?.USER_GOOGLE_EMAIL === email) return;
    saveConfig({
      mcp: {
        servers: servers.map((item) =>
          item.id === id ? { ...item, env: { ...item.env, USER_GOOGLE_EMAIL: email } } : item
        ),
      },
    });
  });

  ipcMain.handle('mcp-google-workspace-info', async () => {
    const server = (loadConfig()?.mcp?.servers || []).find(
      (item) => item.name === 'google-workspace'
    );
    let uvxPath = '';
    try {
      uvxPath = await findUvx(server?.command || '');
    } catch (_) {}
    return { uvxPath, configured: !!server, email: server?.env?.USER_GOOGLE_EMAIL || null };
  });

  ipcMain.handle('mcp-google-workspace-console', async () => {
    await shell.openExternal('https://console.cloud.google.com/projectcreate');
    return { ok: true };
  });

  let googleSave = Promise.resolve();
  ipcMain.handle('mcp-google-workspace-connect', (_e, input) => {
    const pending = googleSave.then(async () => {
      try {
        const serverCfg = await buildGoogleWorkspaceConfig(input);
        const existing = (loadConfig()?.mcp?.servers || []).find(
          (item) => item.name === serverCfg.name
        );
        const id = existing?.id || crypto.randomUUID();
        const secret = await storeGoogleSecret(id, serverCfg.env.GOOGLE_OAUTH_CLIENT_SECRET);
        serverCfg.env.GOOGLE_OAUTH_CLIENT_SECRET = secret.value;
        // Conservar la cuenta solo si el usuario sigue usando el mismo cliente OAuth.
        if (
          existing?.env?.GOOGLE_OAUTH_CLIENT_ID === serverCfg.env.GOOGLE_OAUTH_CLIENT_ID &&
          existing.env.USER_GOOGLE_EMAIL
        ) {
          serverCfg.env.USER_GOOGLE_EMAIL = existing.env.USER_GOOGLE_EMAIL;
        }
        const cfg = { ...serverCfg, id, enabled: true };
        const servers = loadConfig()?.mcp?.servers || [];
        saveConfig({
          mcp: {
            servers: [...servers.filter((item) => item.id !== id && item.name !== cfg.name), cfg],
          },
        });
        const status = await Core.mcpAddServer(cfg);
        let authStarted = false;
        let authError = null;
        if (status?.status === 'connected' && !status.accountEmail) {
          try {
            const result = await Core.mcpStartGoogleAuth(id, input.services[0]);
            const content = (result?.content || [])
              .filter((item) => item.type === 'text')
              .map((item) => item.text)
              .join('\n');
            const urls = content.match(/https:\/\/accounts\.google\.com\/[^\s<>"\]]+/g) || [];
            const authUrl = urls
              .map((value) => new URL(value))
              .find(
                (url) =>
                  url.origin === 'https://accounts.google.com' &&
                  url.pathname.startsWith('/o/oauth2/') &&
                  !url.username &&
                  !url.password
              );
            if (result?.isError || !authUrl)
              throw new Error(
                'No se pudo iniciar la autorización de Google. Revisa tus credenciales e inténtalo otra vez.'
              );
            await shell.openExternal(authUrl.href);
            authStarted = true;
          } catch (error) {
            authError = error.message;
          }
        }
        return { ok: true, status, credentialStorage: secret.storage, authStarted, authError };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    });
    googleSave = pending.catch(() => {});
    return pending;
  });

  ipcMain.handle('mcp-add-server', async (e, { serverCfg }) => {
    try {
      // Conectar con las credenciales en texto plano (el proceso hijo las
      // necesita así) — el cifrado es solo para lo que toca disco.
      const existing = (loadConfig()?.mcp?.servers || []).find(
        (item) => item.name === serverCfg.name
      );
      serverCfg = { ...serverCfg, id: existing?.id || serverCfg.id };
      const status = await Core.mcpAddServer(serverCfg);
      const cfg = loadConfig();
      const servers = cfg?.mcp?.servers || [];
      const withoutDup = servers.filter((s) => s.id !== status.id && s.name !== serverCfg.name);
      const persistedCfg = {
        ...serverCfg,
        id: status.id,
        enabled: true,
        env: SafeStorageCrypto.encryptAllKeys(serverCfg.env || {}),
      };
      saveConfig({
        mcp: { servers: [...withoutDup, persistedCfg] },
      });
      return { ok: true, status };
    } catch (e) {
      logger.error('mcp-handlers', '[main] error en mcp-add-server:', e.message);
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('mcp-remove-server', async (e, { id }) => {
    try {
      await Core.mcpRemoveServer(id);
      const cfg = loadConfig();
      const servers = (cfg?.mcp?.servers || []).filter((s) => s.id !== id);
      saveConfig({ mcp: { servers } });
      return { ok: true };
    } catch (e) {
      logger.error('mcp-handlers', '[main] error en mcp-remove-server:', e.message);
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('mcp-toggle-server', async (e, { id, enabled }) => {
    try {
      const cfg = loadConfig();
      const servers = cfg?.mcp?.servers || [];
      const serverCfg = servers.find((s) => s.id === id);
      if (!serverCfg) return { ok: false, error: 'Servidor no encontrado en config' };

      // env viene cifrado desde config.json (ver mcp-add-server) — hay que
      // descifrarlo antes de pasarlo al proceso hijo del servidor MCP.
      const runtimeCfg = {
        ...serverCfg,
        env: SafeStorageCrypto.decryptAllKeys(serverCfg.env || {}),
      };
      await Core.mcpToggleServer(id, enabled, runtimeCfg);

      const updated = servers.map((s) => (s.id === id ? { ...s, enabled } : s));
      saveConfig({ mcp: { servers: updated } });
      return { ok: true };
    } catch (e) {
      logger.error('mcp-handlers', '[main] error en mcp-toggle-server:', e.message);
      return { ok: false, error: e.message };
    }
  });

  async function installOAuthServer(oauthData) {
    const serverCfg = {
      name: oauthData.serverName,
      identifier: oauthData.serverIdentifier,
      command: 'npx',
      args: ['-y', oauthData.serverIdentifier, ...oauthData.serverArgs],
      env: oauthData.tokens,
    };
    const status = await Core.mcpAddServer(serverCfg);
    const servers = loadConfig()?.mcp?.servers || [];
    saveConfig({
      mcp: {
        servers: [
          ...servers.filter((server) => server.id !== status.id),
          {
            ...serverCfg,
            id: status.id,
            enabled: true,
            env: SafeStorageCrypto.encryptAllKeys(serverCfg.env),
          },
        ],
      },
    });
    return status;
  }

  // OAuth flow for MCP servers that need authentication
  const oauthStates = new Map(); // state -> { provider, serverName, serverIdentifier, serverArgs, codeVerifier, redirectUri }

  const callbackServer = new OAuthCallbackServer(oauthStates, _exchangeCodeForTokens, {
    port: Number(process.env.MCP_OAUTH_CALLBACK_PORT || 18790),
    ttlMs: OAUTH_STATE_TTL_MS,
  });

  function _generateCodeVerifier() {
    const bytes = crypto.randomBytes(32);
    return bytes.toString('base64url');
  }

  function _generateCodeChallenge(verifier) {
    return crypto.createHash('sha256').update(verifier).digest('base64url');
  }

  function _getOAuthConfig(provider) {
    const configs = {
      github: {
        authUrl: 'https://github.com/login/oauth/authorize',
        tokenUrl: 'https://github.com/login/oauth/access_token',
        clientId: process.env.GITHUB_CLIENT_ID || '',
        scope: 'repo read:user user:email',
      },
      gitlab: {
        authUrl: 'https://gitlab.com/oauth/authorize',
        tokenUrl: 'https://gitlab.com/oauth/token',
        clientId: process.env.GITLAB_CLIENT_ID || '',
        scope: 'read_user read_repository',
      },
      google: {
        authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        clientId: process.env.GOOGLE_CLIENT_ID || '',
        scope:
          'https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile',
      },
      microsoft: {
        authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
        tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
        clientId: process.env.MICROSOFT_CLIENT_ID || '',
        scope: 'User.Read',
      },
      slack: {
        authUrl: 'https://slack.com/oauth/v2/authorize',
        tokenUrl: 'https://slack.com/api/oauth.v2.access',
        clientId: process.env.SLACK_CLIENT_ID || '',
        scope: 'channels:read chat:write users:read',
      },
      discord: {
        authUrl: 'https://discord.com/api/oauth2/authorize',
        tokenUrl: 'https://discord.com/api/oauth2/token',
        clientId: process.env.DISCORD_CLIENT_ID || '',
        scope: 'identify guilds',
      },
      notion: {
        authUrl: 'https://api.notion.com/v1/oauth/authorize',
        tokenUrl: 'https://api.notion.com/v1/oauth/token',
        clientId: process.env.NOTION_CLIENT_ID || '',
        scope: '',
      },
      linear: {
        authUrl: 'https://linear.app/oauth/authorize',
        tokenUrl: 'https://api.linear.app/oauth/token',
        clientId: process.env.LINEAR_CLIENT_ID || '',
        scope: '',
      },
      atlassian: {
        authUrl: 'https://auth.atlassian.com/authorize',
        tokenUrl: 'https://auth.atlassian.com/oauth/token',
        clientId: process.env.ATLASSIAN_CLIENT_ID || '',
        scope: 'read:jira-work read:jira-user',
      },
    };
    // Estos proveedores aceptan el intercambio form/PKCE implementado aquí.
    // Los demás se configuran con las credenciales declaradas por el servidor.
    if (!['github', 'gitlab', 'google', 'microsoft'].includes(provider)) return null;
    if (provider === 'github' && !process.env.GITHUB_CLIENT_SECRET) return null;
    return configs[provider] || null;
  }

  ipcMain.handle(
    'mcp-oauth-start',
    async (e, { provider, serverName, serverIdentifier, serverArgs, capabilities }) => {
      try {
        if (
          typeof serverIdentifier !== 'string' ||
          !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:@[a-zA-Z0-9.*^~+-]+)?$/.test(serverIdentifier) ||
          serverIdentifier.startsWith('-')
        ) {
          throw new Error('Identificador npm inválido para OAuth');
        }
        if (
          !Array.isArray(serverArgs || []) ||
          (serverArgs || []).some((arg) => typeof arg !== 'string' || /^<.*>$/.test(arg))
        ) {
          throw new Error('Configura los argumentos del servidor antes de OAuth');
        }
        const config = _getOAuthConfig(provider);
        if (!config || !config.clientId) {
          return {
            ok: false,
            error: `OAuth no configurado para ${provider}. Define ${provider.toUpperCase()}_CLIENT_ID en el entorno.`,
          };
        }

        _sweepExpiredOAuthStates(oauthStates);
        const connectorRequest = resolveConnectorScopes(provider, capabilities);
        const requestedScope = connectorRequest ? connectorRequest.scope : config.scope;

        const state = crypto.randomUUID();
        const codeVerifier = _generateCodeVerifier();
        const codeChallenge = _generateCodeChallenge(codeVerifier);
        const redirectUri = await callbackServer.start();

        oauthStates.set(state, {
          provider,
          serverName,
          serverIdentifier,
          serverArgs: serverArgs || [],
          capabilities: connectorRequest?.capabilities || [],
          access: connectorRequest?.access || 'provider_default',
          codeVerifier,
          redirectUri,
          createdAt: Date.now(),
        });

        const params = new URLSearchParams({
          client_id: config.clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: requestedScope,
          state,
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
        });

        const authUrl = `${config.authUrl}?${params.toString()}`;
        try {
          await shell.openExternal(authUrl);
        } catch (_) {
          oauthStates.delete(state);
          throw new Error('No se pudo abrir el navegador para autorizar la conexión');
        }
        return {
          ok: true,
          authUrl,
          state,
          consent: connectorRequest
            ? {
                provider,
                capabilities: connectorRequest.capabilities,
                access: connectorRequest.access,
                scopes: connectorRequest.scopes,
              }
            : null,
        };
      } catch (err) {
        logger.error('mcp-handlers', '[mcp] OAuth start error:', err.message);
        return { ok: false, error: err.message };
      }
    }
  );

  ipcMain.handle('mcp-oauth-check', async (e, { state }) => {
    try {
      const oauthData = oauthStates.get(state);
      if (!oauthData) return { completed: false, error: 'Estado OAuth inválido o expirado' };
      if (Date.now() - (oauthData.createdAt || 0) > OAUTH_STATE_TTL_MS) {
        oauthStates.delete(state);
        return { completed: false, error: 'Estado OAuth expirado, reintenta la conexión' };
      }

      // El callback HTTP real recibe el code y lo intercambia por tokens
      // Aquí solo verificamos si ya se completó (el servidor HTTP lo guarda en oauthData.tokens)
      if (oauthData.error) {
        oauthStates.delete(state);
        return { completed: false, error: oauthData.error };
      }
      if (oauthData.tokens) {
        // Consumir el estado antes de instalar: no duplicar procesos al sondear.
        oauthStates.delete(state);
        const status = await installOAuthServer(oauthData);
        return { completed: true, status };
      }
      return { completed: false };
    } catch (err) {
      return { completed: false, error: err.message };
    }
  });

  async function _exchangeCodeForTokens(oauthData, code) {
    const config = _getOAuthConfig(oauthData.provider);
    if (!config) throw new Error('Provider config not found');

    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: oauthData.redirectUri,
      client_id: config.clientId,
      code_verifier: oauthData.codeVerifier,
    });

    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    };
    const secret = process.env[`${oauthData.provider.toUpperCase()}_CLIENT_SECRET`];
    if (secret) params.append('client_secret', secret);

    const res = await fetch(config.tokenUrl, {
      method: 'POST',
      headers,
      body: params.toString(),
      signal: AbortSignal.timeout(30000),
    });
    const data = await res.json();

    if (!res.ok || data.error || !data.access_token) {
      throw new Error(
        'El proveedor rechazó el intercambio OAuth. Revisa la configuración y vuelve a conectar.'
      );
    }

    // Mapear tokens a variables de entorno según el provider
    const envVars = {};
    const tokenEnv =
      {
        github: 'GITHUB_PERSONAL_ACCESS_TOKEN',
        gitlab: 'GITLAB_PERSONAL_ACCESS_TOKEN',
        slack: 'SLACK_BOT_TOKEN',
        notion: 'NOTION_API_KEY',
      }[oauthData.provider] || `${oauthData.provider.toUpperCase()}_TOKEN`;
    envVars[tokenEnv] = data.access_token;
    if (data.refresh_token)
      envVars[`${oauthData.provider.toUpperCase()}_REFRESH_TOKEN`] = data.refresh_token;
    if (data.expires_in)
      envVars[`${oauthData.provider.toUpperCase()}_EXPIRES_IN`] = String(data.expires_in);

    return envVars;
  }

  // Exportar para que main.js lo use
  global.__mcpOAuthSetup = (app) => app.once('before-quit', () => callbackServer.close());

  ipcMain.handle('telemetry-report', () => {
    return Core.getTelemetryReport();
  });

  ipcMain.handle('get-bridge-stats', () => {
    try {
      const stats = Core.getStats();
      return stats.openclaw || { error: 'no disponible' };
    } catch (e) {
      return { error: `Core no inicializado: ${e.message}` };
    }
  });
}

module.exports = { register };
