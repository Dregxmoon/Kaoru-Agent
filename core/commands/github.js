'use strict';

// Comando /github — conectar la cuenta de GitHub del usuario.
//
// Diseñado para ser distribuible:
//   - `/github login` (sin PAT) dispara el OAuth Device Flow: abre el navegador
//     de GitHub con el código pre-cargado y avisa por chat cuando el usuario
//     autoriza. Sin client_secret (solo client_id público).
//   - `/github login <PAT>` sigue disponible para power users / CI (síncrono).
//   - `/github client-id <ID>` guarda el client_id de tu OAuth App (público).
//   - El token NUNCA aparece en la salida, logs ni config.json. Se guarda en el
//     llavero (KeychainManager, key "github_token").
//
// El polling del device flow corre en background (fire-and-forget) y el
// resultado se notifica por chat vía ctx.addMessage — el comando responde al
// instante con el código, sin bloquear.

const KeychainManager = require('../../infrastructure/keychain/KeychainManager.js');
const { getGitHubManager, GITHUB_TOKEN_KEY } = require('../github/GitHubManager.js');
const { OAuthDeviceFlow } = require('../github/OAuthDeviceFlow.js');

const CLIENT_ID_KEY = 'github_client_id';
const MIN_PAT_LENGTH = 20;
const POLL_WAIT_MS = 250;

module.exports = function registerCommands(register) {
  register({
    name: 'github',
    description: 'Conecta tu cuenta de GitHub (login, whoami, logout, status, client-id)',
    usage: '/github <login|whoami|logout|status|client-id>',
    handler: async (args, ctx) => {
      const action = (args[0] || 'status').toLowerCase();
      const gh = (ctx && ctx.githubManager) || getGitHubManager();
      const K = (ctx && ctx.KeychainManager) || KeychainManager;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

      switch (action) {
        case 'login': {
          const token = (args[1] || '').trim();
          if (token) return _patLogin(token, gh, K);
          return await _deviceLogin(ctx, gh, K, sleep);
        }

        case 'client-id': {
          const id = (args[1] || '').trim();
          if (!id) {
            return 'Uso: `/github client-id <CLIENT_ID>`. Creá una OAuth App en github.com/settings/applications/new y pegá el Client ID (es público, no un secreto).';
          }
          let persisted = false;
          try { persisted = K.setKey(CLIENT_ID_KEY, id) === true; } catch { persisted = false; }
          return `Client ID guardado${persisted ? '' : ' (solo por sesión: no se pudo persistir en el llavero)'}. Ahora usá \`/github login\` para vincular tu cuenta desde el navegador.`;
        }

        case 'whoami': {
          try {
            const me = await gh.whoami();
            const name = me.name ? ` (${me.name})` : '';
            return `Conectado a GitHub como **@${me.login}**${name} — repos públicos: ${me.publicRepos}.`;
          } catch {
            return 'No hay una sesión de GitHub activa. Conectá tu cuenta con `/github login`.';
          }
        }

        case 'logout': {
          gh.configure({ token: null });
          let removed = false;
          try { removed = K.deleteKey(GITHUB_TOKEN_KEY) === true; } catch { removed = false; }
          return removed
            ? 'Sesión de GitHub cerrada — token eliminado del llavero.'
            : 'No había token persistido que eliminar.';
        }

        case 'status':
        default: {
          let has = false;
          try { has = await gh.hasToken; } catch { has = false; }
          const clientId = await _resolveClientId(ctx, K);
          const base = has
            ? 'GitHub: hay una cuenta conectada (oculto). Usá `/github whoami` para verla.'
            : 'GitHub: no hay cuenta conectada. Usá `/github login` para vincularla desde el navegador.';
          const clientNote = clientId ? '' : ' Falta configurar el Client ID: `/github client-id <ID>`.';
          return base + clientNote;
        }
      }
    },
  });
};

// ── Login con PAT (power users / CI) ──────────────────────────────────────────

async function _patLogin(token, gh, K) {
  if (token.length < MIN_PAT_LENGTH) {
    return 'El token parece inválido (muy corto). Generá un PAT en github.com/settings/tokens y pegalo completo.';
  }
  gh.configure({ token });
  let me = null;
  try {
    me = await gh.whoami();
  } catch (e) {
    gh.configure({ token: null });
    return `No se pudo verificar el token: ${e.message}`;
  }
  let persisted = false;
  try { persisted = K.setKey(GITHUB_TOKEN_KEY, token) === true; } catch { persisted = false; }
  const name = me.name ? ` (${me.name})` : '';
  const persistNote = persisted ? '' : '\n⚠️ No se pudo persistir en el llavero — el token quedará activo solo durante esta sesión.';
  return `Conectado a GitHub como **@${me.login}**${name}.${persistNote}`;
}

// ── Login con OAuth Device Flow (navegador) ───────────────────────────────────

async function _resolveClientId(ctx, K) {
  if (ctx && ctx.githubClientId) return ctx.githubClientId;
  if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_ID.trim()) return process.env.GITHUB_CLIENT_ID.trim();
  // En el renderer, process.env no siempre refleja el .env cargado en main;
  // preguntamos al proceso principal (env → llavero).
  try {
    if (ctx && ctx.ipcRenderer && typeof ctx.ipcRenderer.invoke === 'function') {
      const viaIpc = await ctx.ipcRenderer.invoke('github-client-id');
      if (viaIpc) return viaIpc;
    }
  } catch {}
  try { const v = K.getKey(CLIENT_ID_KEY); if (v && v.trim()) return v.trim(); } catch {}
  return null;
}

function _openExternal(ctx, url) {
  if (ctx && typeof ctx.openExternal === 'function') return ctx.openExternal(url);
  try {
    const { shell } = require('electron');
    return shell.openExternal(url);
  } catch {
    return null;
  }
}

function _notify(ctx, text) {
  try {
    if (ctx && typeof ctx.addMessage === 'function') ctx.addMessage('assistant', text);
    if (ctx && typeof ctx.pushToSession === 'function') ctx.pushToSession('assistant', text);
  } catch {}
}

async function _deviceLogin(ctx, gh, K, sleep) {
  const clientId = await _resolveClientId(ctx, K);
  if (!clientId) {
    return 'Para vincular tu cuenta desde el navegador primero necesito el Client ID de tu GitHub OAuth App.\n\n1. Creala en github.com/settings/applications/new (Callback URL: `http://localhost` sirve para este flujo).\n2. Guardala con `/github client-id <CLIENT_ID>`.\n\nAlternativa rápida: `/github login <PAT>` con un token personal.';
  }

  const flow = (ctx && ctx.createDeviceFlow)
    ? ctx.createDeviceFlow({ clientId })
    : new OAuthDeviceFlow({ clientId });

  let info;
  try {
    info = await flow.start();
  } catch (e) {
    return `No se pudo iniciar el flujo de vinculación: ${e.message}`;
  }

  const uri = info.verificationUriComplete || info.verificationUri;
  if (uri) _openExternal(ctx, uri);

  _pollDeviceFlow(ctx, gh, K, flow, info, sleep);

  // GitHub (sobre todo las OAuth Apps nuevas, Client ID "Ov23...") pide que
  // escribas el código en la página — mostrarlo siempre es lo robusto,
  // aunque la URI ya lo traiga pre-cargado.
  const codeLine = info.userCode
    ? `1. Si no se abrió el navegador, entrá a **${info.verificationUri || 'github.com/login/device'}**\n2. Ingresá este código: **${info.userCode}**`
    : `Si no se abrió el navegador, entrá a ${info.verificationUri || 'github.com/login/device'}`;
  return `Te abrí GitHub para vincular tu cuenta.\n\n${codeLine}\n\nTe aviso acá cuando autorices.`;
}

async function _pollDeviceFlow(ctx, gh, K, flow, info, sleep) {
  const deadline = Date.now() + (info.expiresIn || 900) * 1000;
  let interval = Math.max(info.interval || 5, 1);

  while (Date.now() < deadline) {
    await sleep(Math.max(interval, POLL_WAIT_MS / 1000) * 1000);
    let res;
    try {
      res = await flow.poll(info.deviceCode);
    } catch (e) {
      _notify(ctx, `Error verificando la autorización: ${e.message}`);
      return;
    }
    if (res.ok && res.accessToken) {
      gh.configure({ token: res.accessToken });
      let me = null;
      try { me = await gh.whoami(); } catch {}
      let persisted = false;
      try { persisted = K.setKey(GITHUB_TOKEN_KEY, res.accessToken) === true; } catch { persisted = false; }
      const who = me ? ` como **@${me.login}**` : '';
      const persistNote = persisted ? '' : '\n No se pudo persistir en el llavero — el token quedará activo solo durante esta sesión.';
      _notify(ctx, `Conectado a GitHub${who}.${persistNote}`);
      return;
    }
    if (res.error === 'access_denied') {
      _notify(ctx, 'Autorización denegada en GitHub. Podés reintentar con `/github login`.');
      return;
    }
    if (res.error === 'expired_token') {
      _notify(ctx, 'El código de vinculación expiró. Reintentá con `/github login`.');
      return;
    }
    if (res.error === 'slow_down') interval += 5;
    // authorization_pending (u otros) → seguir esperando
  }
  _notify(ctx, 'No autorizaste a tiempo. Reintentá con `/github login`.');
}
