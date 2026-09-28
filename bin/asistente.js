#!/usr/bin/env node
// @ts-check
'use strict';

/**
 * asistente — lanza o retoma el asistente personal en el directorio actual,
 * igual que `opencode` lo hace para su propio agente. Electron garantiza una
 * sola instancia: si Kaoru ya está abierto, la segunda invocación entrega el
 * workspace al proceso principal mediante el evento `second-instance`.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const cwd = process.cwd();

/**
 * Resuelve el binario de Electron para lanzar la app SIN depender de `npx`.
 * En Windows `npx` es `npx.cmd` y `spawn('npx', ...)` falla con ENOENT (node
 * no ejecuta .cmd sin shell). `require('electron')` devuelve la ruta real del
 * binario (electron.exe en Windows), que spawn puede lanzar directo. Si por
 * alguna razón el binario no está (instalación incompleta), cae al fallback
 * npx para que la descarga de electron se dispare sola.
 * @returns {string | null} ruta del binario de Electron
 */
function resolveElectronBinary() {
  try {
    const bin = require('electron');
    if (typeof bin === 'string' && bin && fs.existsSync(bin)) return bin;
  } catch (_) {}
  return null;
}

/**
 * @param {string} appRoot
 * @param {string} workspace
 * @param {typeof spawn} [spawnImpl]
 */
function spawnElectron(appRoot, workspace, spawnImpl = spawn) {
  const bin = resolveElectronBinary();
  const args = bin
    ? [appRoot, '--workspace', workspace]
    : ['electron', appRoot, '--workspace', workspace];
  const cmd = bin || (process.platform === 'win32' ? 'npx.cmd' : 'npx');
  return spawnImpl(cmd, args, {
    cwd: appRoot,
    env: { ...process.env, ASISTENTE_WORKSPACE: workspace },
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
  });
}

function isIntegratedTerminal(env = process.env) {
  return env.KAORU_INTEGRATED_TERMINAL === '1';
}

function main() {
  if (isIntegratedTerminal()) {
    console.log('Kaoru ya está abierta. Usa el selector de workspaces de la aplicación.');
    return;
  }
  const appRoot = path.join(__dirname, '..');
  console.log(`Iniciando asistente en: ${cwd}`);
  const child = spawnElectron(appRoot, cwd);
  child.once('error', (error) => {
    console.error(`No se pudo iniciar Kaoru: ${error.message}`);
    process.exitCode = 1;
  });
  child.unref();
}

if (require.main === module) main();

module.exports = { resolveElectronBinary, spawnElectron, isIntegratedTerminal };
