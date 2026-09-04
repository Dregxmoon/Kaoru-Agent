// @ts-nocheck
'use strict';
const logger = require('../core/observability/Logger.js');

const crypto = require('crypto');
const { ipcMain, dialog } = require('electron');
const SafeStorageCrypto = require('../infrastructure/config/SafeStorageCrypto.js');

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

  ipcMain.handle('pick-workspace-folder', async () => {
    const result = await dialog.showOpenDialog(S.chatWindow, { properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths.length) return null;
    return Core.setActiveWorkspace(result.filePaths[0]);
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
      // Devuelve lista de proveedores OAuth que tienen client ID configurado
      const configured = [];
      for (const [provider, config] of Object.entries(_getOAuthConfig('').configs || {})) {
        if (config.clientId) configured.push(provider);
      }
      // Alternativa: comprobar cada proveedor individualmente
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

  ipcMain.handle('mcp-add-server', async (e, { serverCfg }) => {
    try {
      // Conectar con las credenciales en texto plano (el proceso hijo las
      // necesita así) — el cifrado es solo para lo que toca disco.
      const status = await Core.mcpAddServer(serverCfg);
      const cfg = loadConfig();
      const servers = cfg?.mcp?.servers || [];
      const withoutDup = servers.filter((s) => s.id !== status.id);
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

  // OAuth flow for MCP servers that need authentication
  const oauthStates = new Map(); // state -> { provider, serverName, serverIdentifier, serverArgs, codeVerifier, redirectUri }

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
    return configs[provider] || null;
  }

  ipcMain.handle(
    'mcp-oauth-start',
    async (e, { provider, serverName, serverIdentifier, serverArgs }) => {
      try {
        const config = _getOAuthConfig(provider);
        if (!config || !config.clientId) {
          return {
            ok: false,
            error: `OAuth no configurado para ${provider}. Define ${provider.toUpperCase()}_CLIENT_ID en el entorno.`,
          };
        }

        _sweepExpiredOAuthStates(oauthStates);

        const state = crypto.randomUUID();
        const codeVerifier = _generateCodeVerifier();
        const codeChallenge = _generateCodeChallenge(codeVerifier);
        const redirectUri = 'http://127.0.0.1:18789/mcp/oauth/callback';

        oauthStates.set(state, {
          provider,
          serverName,
          serverIdentifier,
          serverArgs: serverArgs || [],
          codeVerifier,
          redirectUri,
          createdAt: Date.now(),
        });

        const params = new URLSearchParams({
          client_id: config.clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: config.scope,
          state,
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
        });

        const authUrl = `${config.authUrl}?${params.toString()}`;
        return { ok: true, authUrl, state };
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
      if (oauthData.tokens) {
        const tokens = oauthData.tokens;
        oauthStates.delete(state);
        return { completed: true, tokens };
      }
      return { completed: false };
    } catch (err) {
      return { completed: false, error: err.message };
    }
  });

  // Callback HTTP para OAuth (se monta en main.js)
  function _setupOAuthCallback(app) {
    const { session } = require('electron');
    const ses = session.defaultSession;

    // Interceptar la callback
    const filter = { urls: ['http://127.0.0.1:18789/mcp/oauth/callback*'] };
    ses.webRequest.onBeforeRequest(filter, (details, callback) => {
      const url = new URL(details.url);
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error) {
        callback({ cancel: true });
        // Redirigir a página de error
        return;
      }

      if (!code || !state) {
        callback({ cancel: true });
        return;
      }

      const oauthData = oauthStates.get(state);
      if (!oauthData) {
        callback({ cancel: true });
        return;
      }

      // Intercambiar code por tokens
      _exchangeCodeForTokens(oauthData, code, state)
        .then((tokens) => {
          oauthData.tokens = tokens;
        })
        .catch((err) => {
          logger.error('mcp-handlers', '[mcp] OAuth token exchange failed:', err.message);
          oauthData.error = err.message;
        });

      // Responder con página de éxito
      callback({
        cancel: true,
        redirectURL: `data:text/html,<html><body style="font-family:monospace;text-align:center;padding:50px;background:#0d0d0d;color:#e0e0e0"><h2>✅ Autorización completada</h2><p>Puedes cerrar esta ventana y volver a Kaoru.</p><script>window.close()</script></body></html>`,
      });
    });
  }

  async function _exchangeCodeForTokens(oauthData, code, state) {
    const config = _getOAuthConfig(oauthData.provider);
    if (!config) throw new Error('Provider config not found');

    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: oauthData.redirectUri,
      client_id: config.clientId,
      code_verifier: oauthData.codeVerifier,
    });

    // Para GitHub, el client_secret va en el body; para otros en Basic Auth
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    };
    if (oauthData.provider === 'github' && process.env.GITHUB_CLIENT_SECRET) {
      params.append('client_secret', process.env.GITHUB_CLIENT_SECRET);
    }

    const auth =
      config.clientId && process.env[`${oauthData.provider.toUpperCase()}_CLIENT_SECRET`]
        ? 'Basic ' +
          Buffer.from(
            `${config.clientId}:${process.env[`${oauthData.provider.toUpperCase()}_CLIENT_SECRET`]}`
          ).toString('base64')
        : null;
    if (auth) headers.Authorization = auth;

    const res = await fetch(config.tokenUrl, { method: 'POST', headers, body: params.toString() });
    const data = await res.json();

    if (!res.ok || data.error) {
      throw new Error(data.error_description || data.error || 'Token exchange failed');
    }

    // Mapear tokens a variables de entorno según el provider
    const envVars = {};
    if (data.access_token) envVars[`${oauthData.provider.toUpperCase()}_TOKEN`] = data.access_token;
    if (data.refresh_token)
      envVars[`${oauthData.provider.toUpperCase()}_REFRESH_TOKEN`] = data.refresh_token;
    if (data.expires_in)
      envVars[`${oauthData.provider.toUpperCase()}_EXPIRES_IN`] = String(data.expires_in);

    return envVars;
  }

  // Exportar para que main.js lo use
  global.__mcpOAuthSetup = _setupOAuthCallback;

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
