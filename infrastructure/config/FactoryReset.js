// @ts-check
'use strict';

const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const BUILTIN_CREDENTIAL_KEYS = [
  'groq',
  'gemini',
  'openai',
  'anthropic',
  'xai',
  'nvidia',
  'huggingface',
  'deepseek',
  'github_token',
  'github_client_id',
  'app_pin_hash',
];

/** @param {string} configPath @returns {Promise<string[]>} */
async function credentialKeysFromConfig(configPath) {
  const keys = new Set(BUILTIN_CREDENTIAL_KEYS);
  try {
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    for (const id of [
      ...Object.keys(config?.llm?.providers || {}),
      ...Object.keys(config?.llm?.apiKeys || {}),
    ]) {
      if (/^[a-zA-Z0-9_-]{1,64}$/.test(id)) keys.add(id);
    }
  } catch (_) {}
  return [...keys];
}

/**
 * Borra exclusivamente datos propiedad de Kaoru. Nunca recibe rutas del
 * renderer y nunca toca workspaces o Documentos del usuario.
 * @param {{ userData: string, keychain: { deleteKey(name: string): boolean }, platform?: NodeJS.Platform, localAppData?: string, homeDir?: string }} opts
 * @returns {Promise<{ removed: string[], failed: Array<{ path: string, error: string }> }>}
 */
async function performFactoryReset(opts) {
  const userData = path.resolve(opts.userData);
  const platform = opts.platform || process.platform;
  const homeDir = path.resolve(opts.homeDir || os.homedir());
  const localAppData = path.resolve(opts.localAppData || process.env.LOCALAPPDATA || os.tmpdir());
  const configPath = path.join(userData, 'config.json');

  for (const key of await credentialKeysFromConfig(configPath)) {
    try {
      opts.keychain.deleteKey(key);
    } catch (_) {}
  }

  const targets = [userData, path.join(homeDir, '.asistente-personal')];
  if (platform === 'win32') targets.push(path.join(localAppData, 'KaoruAgent'));

  /** @type {string[]} */
  const removed = [];
  /** @type {Array<{ path: string, error: string }>} */
  const failed = [];
  for (const target of targets) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      removed.push(target);
    } catch (error) {
      failed.push({ path: target, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { removed, failed };
}

module.exports = { BUILTIN_CREDENTIAL_KEYS, credentialKeysFromConfig, performFactoryReset };
