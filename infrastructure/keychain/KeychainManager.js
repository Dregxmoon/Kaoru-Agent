const { execSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const SERVICE = 'march7th';
const CRED_DIR = path.join(os.homedir(), '.march7th');

function _ensureCredDir() {
  if (!fs.existsSync(CRED_DIR)) {
    fs.mkdirSync(CRED_DIR, { recursive: true, mode: 0o700 });
  }
}

function _linuxIsAvailable() {
  try {
    execSync('which secret-tool', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function _linuxGetKey(keyName) {
  try {
    return execSync(
      `secret-tool lookup service ${SERVICE} key ${keyName}`,
      { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim() || null;
  } catch {
    return null;
  }
}

function _linuxSetKey(keyName, value) {
  try {
    execSync(
      `secret-tool store --label='March 7th - ${keyName}' service ${SERVICE} key ${keyName}`,
      { input: value, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'ignore', 'ignore'] }
    );
    return true;
  } catch {
    return false;
  }
}

function _linuxDeleteKey(keyName) {
  try {
    execSync(`secret-tool clear service ${SERVICE} key ${keyName}`, { timeout: 5000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function _winIsAvailable() {
  return process.platform === 'win32';
}

function _winGetKey(keyName) {
  const credFile = path.join(CRED_DIR, `cred-${keyName}.xml`);
  if (!fs.existsSync(credFile)) return null;
  try {
    return execSync(
      `powershell -NoProfile -Command "$c=Import-Clixml '${credFile}'; Write-Output $c.GetNetworkCredential().Password"`,
      { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim() || null;
  } catch {
    return null;
  }
}

function _winSetKey(keyName, value) {
  _ensureCredDir();
  const credFile = path.join(CRED_DIR, `cred-${keyName}.xml`);
  const escaped = value.replace(/'/g, "''");
  try {
    execSync(
      `powershell -NoProfile -Command "$sec=ConvertTo-SecureString '${escaped}' -AsPlainText -Force; $cred=New-Object System.Management.Automation.PSCredential('${SERVICE}/${keyName}',$sec); $cred | Export-Clixml '${credFile}'"`,
      { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'ignore', 'ignore'] }
    );
    return true;
  } catch {
    return false;
  }
}

function _winDeleteKey(keyName) {
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
    if (PLATFORM === 'linux') return _linuxGetKey(keyName);
    if (PLATFORM === 'win32') return _winGetKey(keyName);
    return null;
  },

  setKey(keyName, value) {
    if (PLATFORM === 'linux') return _linuxSetKey(keyName, value);
    if (PLATFORM === 'win32') return _winSetKey(keyName, value);
    return false;
  },

  deleteKey(keyName) {
    if (PLATFORM === 'linux') return _linuxDeleteKey(keyName);
    if (PLATFORM === 'win32') return _winDeleteKey(keyName);
    return false;
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
