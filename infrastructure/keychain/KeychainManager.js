// KeychainManager.js
//
// Fix de seguridad (CWE-78, command injection): la versión anterior armaba
// comandos de shell concatenando keyName/value directamente en el string
// (`secret-tool lookup service ${SERVICE} key ${keyName}`, PowerShell con
// interpolación). keyName no siempre es un valor fijo interno — los
// providers "custom" agregados vía /provider add usan un id definido por
// el usuario que termina como keyName acá, así que era explotable en la
// práctica, no solo en teoría.
//
// Dos capas de defensa, no una sola:
//   1. _sanitizeKeyName() valida el identificador contra un charset
//      cerrado ANTES de que llegue a cualquier función — un keyName que no
//      matchea se rechaza, no se intenta escapar.
//   2. execFileSync() en vez de execSync(): el binario y sus argumentos
//      van en un array, nunca se construye un string que un shell
//      reinterprete. Evita la clase entera de inyección, no solo el caso
//      que se nos ocurrió cubrir.
const { execFileSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const SERVICE = 'asistente-personal';
const CRED_DIR = path.join(os.homedir(), '.asistente-personal');

// Identificadores de provider conocidos + lo que puede generar /provider add:
// letras, números, guion y guion bajo. Nada de espacios, comillas, barras,
// signos de shell. Si algún día un provider necesita otro carácter, se
// amplía esta lista a propósito — no se relaja para "que funcione".
const SAFE_KEYNAME = /^[a-zA-Z0-9_-]{1,64}$/;

function _sanitizeKeyName(keyName) {
  if (typeof keyName !== 'string' || !SAFE_KEYNAME.test(keyName)) {
    throw new Error(`KeychainManager: keyName inválido: ${JSON.stringify(keyName)}`);
  }
  return keyName;
}

function _ensureCredDir() {
  if (!fs.existsSync(CRED_DIR)) {
    fs.mkdirSync(CRED_DIR, { recursive: true, mode: 0o700 });
  }
}

function _linuxIsAvailable() {
  try {
    execFileSync('which', ['secret-tool'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function _linuxGetKey(rawKeyName) {
  try {
    const keyName = _sanitizeKeyName(rawKeyName);
    return execFileSync(
      'secret-tool',
      ['lookup', 'service', SERVICE, 'key', keyName],
      { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim() || null;
  } catch {
    return null;
  }
}

function _linuxSetKey(rawKeyName, value) {
  try {
    const keyName = _sanitizeKeyName(rawKeyName);
    execFileSync(
      'secret-tool',
      ['store', '--label', `Asistente personal - ${keyName}`, 'service', SERVICE, 'key', keyName],
      { input: value, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'ignore', 'ignore'] }
    );
    return true;
  } catch {
    return false;
  }
}

function _linuxDeleteKey(rawKeyName) {
  try {
    const keyName = _sanitizeKeyName(rawKeyName);
    execFileSync(
      'secret-tool',
      ['clear', 'service', SERVICE, 'key', keyName],
      { timeout: 5000, stdio: 'ignore' }
    );
    return true;
  } catch {
    return false;
  }
}

function _winIsAvailable() {
  return process.platform === 'win32';
}

// El script de PowerShell sigue yendo como string (Export-Clixml/
// ConvertTo-SecureString son cmdlets, no admiten un array de argumentos
// separados de forma directa) — pero ahora va como argumento de
// execFileSync, no concatenado en un string que un shell exterior vuelva
// a interpretar. keyName ya está saneado antes de llegar acá, así que solo
// puede formar parte del NOMBRE del archivo/credencial, nunca romper la
// sintaxis del script. El valor del secreto sigue escapando comillas
// simples para el string literal de PowerShell (' → ''), que es la forma
// correcta de escapar dentro de comillas simples en PowerShell.
function _winGetKey(rawKeyName) {
  const keyName = _sanitizeKeyName(rawKeyName);
  const credFile = path.join(CRED_DIR, `cred-${keyName}.xml`);
  if (!fs.existsSync(credFile)) return null;
  try {
    return execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `$c=Import-Clixml '${credFile}'; Write-Output $c.GetNetworkCredential().Password`],
      { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim() || null;
  } catch {
    return null;
  }
}

function _winSetKey(rawKeyName, value) {
  const keyName = _sanitizeKeyName(rawKeyName);
  _ensureCredDir();
  const credFile = path.join(CRED_DIR, `cred-${keyName}.xml`);
  const escaped = String(value).replace(/'/g, "''");
  try {
    execFileSync(
      'powershell',
      ['-NoProfile', '-Command',
        `$sec=ConvertTo-SecureString '${escaped}' -AsPlainText -Force; $cred=New-Object System.Management.Automation.PSCredential('${SERVICE}/${keyName}',$sec); $cred | Export-Clixml '${credFile}'`],
      { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'ignore', 'ignore'] }
    );
    return true;
  } catch {
    return false;
  }
}

function _winDeleteKey(rawKeyName) {
  const keyName = _sanitizeKeyName(rawKeyName);
  const credFile = path.join(CRED_DIR, `cred-${keyName}.xml`);
  try {
    if (fs.existsSync(credFile)) fs.unlinkSync(credFile);
    return true;
  } catch {
    return false;
  }
}

const PLATFORM = os.platform();

const KeychainManager = {
  isAvailable() {
    if (PLATFORM === 'linux') return _linuxIsAvailable();
    if (PLATFORM === 'win32') return _winIsAvailable();
    return false;
  },

  getKey(keyName) {
    try {
      if (PLATFORM === 'linux') return _linuxGetKey(keyName);
      if (PLATFORM === 'win32') return _winGetKey(keyName);
      return null;
    } catch (e) {
      console.warn(`[keychain] getKey rechazado: ${e.message}`);
      return null;
    }
  },

  setKey(keyName, value) {
    try {
      if (PLATFORM === 'linux') return _linuxSetKey(keyName, value);
      if (PLATFORM === 'win32') return _winSetKey(keyName, value);
      return false;
    } catch (e) {
      console.warn(`[keychain] setKey rechazado: ${e.message}`);
      return false;
    }
  },

  deleteKey(keyName) {
    try {
      if (PLATFORM === 'linux') return _linuxDeleteKey(keyName);
      if (PLATFORM === 'win32') return _winDeleteKey(keyName);
      return false;
    } catch (e) {
      console.warn(`[keychain] deleteKey rechazado: ${e.message}`);
      return false;
    }
  },

  getAllKeys(keyNames) {
    const result = {};
    for (const name of keyNames) {
      const value = this.getKey(name);
      if (value) result[name] = value;
    }
    return result;
  },

  setAllKeys(keys) {
    const result = {};
    for (const [name, value] of Object.entries(keys)) {
      if (value) result[name] = this.setKey(name, value);
    }
    return result;
  },
};

module.exports = KeychainManager;