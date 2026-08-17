// @ts-check
'use strict';
// Instala el comando `asistente` (bin/asistente.js) en el directorio de bins
// global de npm, para que esté disponible desde cualquier carpeta después de
// `npm install` — sin depender de `npm link` manual ni de que el usuario sepa
// dónde queda el bin de la versión de node activa.
//
// Multiplataforma:
//   - Linux/macOS: symlink `asistente` → bin/asistente.js. Se prefiere
//     ~/.local/bin (si existe y está en el PATH del usuario) porque sobrevive
//     a cambios de versión de node/mise; si no, el bin global de npm.
//   - Windows: shims `asistente.cmd` (cmd/PowerShell) + `asistente` (bash de
//     git-bash) en el prefix global de npm (%APPDATA%\npm por default), que ya
//     está en el PATH. `node` se resuelve desde el PATH del usuario.
//
// Best-effort: si no se puede escribir (CI, permisos), solo avisa — el npm
// install no debe fallar por esto.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const ASISTENTE_BIN_NAME = 'asistente';

/** @param {string} js Ruta absoluta a bin/asistente.js */
function _shimCmd(js) {
  return '@ECHO off\r\nnode "' + String(js).replace(/"/g, '""') + '" %*\r\n';
}

/** @param {string} js Ruta absoluta a bin/asistente.js */
function _shimPs1(js) {
  return (
    '#!/usr/bin/env pwsh\n$ErrorActionPreference = "Stop"\nnode "' +
    String(js).replace(/"/g, '`"') +
    '" @args\n'
  );
}

/** @param {string} js Ruta absoluta a bin/asistente.js */
function _shimBash(js) {
  return '#!/usr/bin/env bash\nnode "' + String(js).replace(/"/g, '\\"') + '" "$@"\n';
}

/**
 * Resuelve el directorio de bins donde instalar `asistente`.
 * @param {NodeJS.Platform} [platform]
 * @returns {string}
 */
function _resolveBinDir(platform = process.platform) {
  if (platform === 'win32') {
    // En Windows el prefix global de npm ES el directorio de bins
    // (default %APPDATA%\npm), ya en el PATH.
    return _npmGlobalPrefix();
  }
  // Linux/macOS: preferir ~/.local/bin cuando existe (sobrevive a cambios de
  // versión de node/mise que mueven el bin global). Si no, el bin de npm.
  const homeLocalBin = path.join(os.homedir(), '.local', 'bin');
  if (fs.existsSync(homeLocalBin)) return homeLocalBin;
  return path.join(_npmGlobalPrefix(), 'bin');
}

function _npmGlobalPrefix() {
  try {
    const prefix = execSync('npm prefix -g', { encoding: 'utf8' }).trim();
    if (prefix) return prefix;
  } catch (_) {}
  if (process.env.npm_config_prefix) return process.env.npm_config_prefix;
  throw new Error('no se pudo determinar el prefix global de npm');
}

function _removeIfPresent(dest) {
  try {
    const st = fs.lstatSync(dest);
    if (st.isSymbolicLink() || st.isFile()) fs.unlinkSync(dest);
  } catch (_) {}
}

/**
 * Crea los enlaces/shim del comando `asistente`.
 * @param {object} opts
 * @param {string} opts.binDir Directorio de destino (ya debe existir).
 * @param {NodeJS.Platform} [opts.platform]
 * @param {string} [opts.appRoot] Raíz del proyecto (default: ../ desde scripts/).
 * @param {(m: string) => void} [opts.log]
 * @returns {string[]} rutas creadas
 */
function installAsistente({
  binDir,
  platform = process.platform,
  appRoot = path.join(__dirname, '..'),
  log = () => {},
}) {
  if (!fs.existsSync(binDir)) {
    throw new Error(`directorio de bins no existe: ${binDir}`);
  }
  const targetJs = path.join(appRoot, 'bin', ASISTENTE_BIN_NAME + '.js');
  if (!fs.existsSync(targetJs)) {
    throw new Error(`binario fuente no existe: ${targetJs}`);
  }

  const created = [];
  if (platform === 'win32') {
    const cmdPath = path.join(binDir, ASISTENTE_BIN_NAME + '.cmd');
    const ps1Path = path.join(binDir, ASISTENTE_BIN_NAME + '.ps1');
    const bashPath = path.join(binDir, ASISTENTE_BIN_NAME);
    _removeIfPresent(cmdPath);
    _removeIfPresent(ps1Path);
    _removeIfPresent(bashPath);
    fs.writeFileSync(cmdPath, _shimCmd(targetJs), 'utf8');
    fs.writeFileSync(ps1Path, _shimPs1(targetJs), 'utf8');
    fs.writeFileSync(bashPath, _shimBash(targetJs), 'utf8');
    created.push(cmdPath, ps1Path, bashPath);
  } else {
    const linkPath = path.join(binDir, ASISTENTE_BIN_NAME);
    _removeIfPresent(linkPath);
    fs.symlinkSync(targetJs, linkPath);
    fs.chmodSync(targetJs, 0o755);
    created.push(linkPath);
  }

  for (const p of created) log(`  ✓ ${p}`);
  return created;
}

function main() {
  console.log('[link-asistente] Instalando comando "asistente"...');
  let binDir;
  try {
    binDir = _resolveBinDir();
  } catch (e) {
    console.error(`[link-asistente] aviso: ${e.message}`);
    console.error('[link-asistente] manual: ejecutá "npm link" dentro del proyecto.');
    return;
  }
  try {
    installAsistente({ binDir });
    console.log(
      `[link-asistente] Listo. Ejecutá "asistente" desde cualquier carpeta. (bin: ${binDir})`
    );
  } catch (e) {
    console.error(`[link-asistente] aviso: no se pudo enlazar (¿CI o permisos?): ${e.message}`);
    console.error('[link-asistente] manual: ejecutá "npm link" dentro del proyecto.');
  }
}

if (require.main === module) main();

module.exports = {
  installAsistente,
  _shimCmd,
  _shimPs1,
  _shimBash,
  _resolveBinDir,
};
