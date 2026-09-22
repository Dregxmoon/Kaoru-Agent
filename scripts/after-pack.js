// @ts-check
'use strict';

// electron-builder hook: compila el launcher AppContainer en el runner nativo
// de Windows y lo coloca junto a app.asar. Así el primer arranque instalado no
// necesita invocar Add-Type; los clones mantienen la compilación como fallback.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const asar = require('@electron/asar');

/** @param {{appOutDir: string, electronPlatformName: string}} context */
function verifyRuntimeContents(context) {
  let resources = path.join(context.appOutDir, 'resources');
  if (context.electronPlatformName === 'darwin') {
    const bundle = fs.readdirSync(context.appOutDir).find((entry) => entry.endsWith('.app'));
    if (!bundle) throw new Error('Falta el bundle .app de macOS');
    resources = path.join(context.appOutDir, bundle, 'Contents', 'Resources');
  }
  const archive = path.join(resources, 'app.asar');
  if (!fs.existsSync(archive)) throw new Error('Falta app.asar en el paquete');
  for (const resource of ['asr_stream.py', 'requirements.txt']) {
    if (!fs.existsSync(path.join(resources, resource)))
      throw new Error(`Falta recurso opcional de ASR: ${resource}`);
  }
  const contents = new Set(asar.listPackage(archive).map((entry) => entry.replace(/\\/g, '/')));
  const runtimeDependencies = Object.keys(require('../package.json').dependencies);
  for (const dependency of runtimeDependencies) {
    const manifest = `/node_modules/${dependency}/package.json`;
    if (!contents.has(manifest)) throw new Error(`Falta librería del release: ${dependency}`);
  }
  for (const required of [
    '/vendor/live2dcubismcore.min.js',
    '/models/March 7th/march 7th.model3.json',
    '/node_modules/pixi.js/dist/browser/pixi.min.js',
    '/node_modules/pixi-live2d-display/dist/cubism4.min.js',
    '/node_modules/node-edge-tts/dist/edge-tts.js',
    '/core/voice/NeuralTts.js',
  ]) {
    if (!contents.has(required)) throw new Error(`Falta dependencia del release: ${required}`);
  }
}

/** @param {string} executable @param {string[]} args @returns {Promise<void>} */
function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: 'inherit',
      shell: false,
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`compilador AppContainer terminó con código ${code}`));
    });
  });
}

/** @param {{ electronPlatformName: string, appOutDir: string }} context */
async function afterPack(context) {
  verifyRuntimeContents(context);
  if (context.electronPlatformName !== 'win32' || process.platform !== 'win32') return;
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
  if (!systemRoot) throw new Error('SystemRoot no está definido en el build de Windows');
  const powershell = path.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  if (!fs.existsSync(powershell)) throw new Error(`PowerShell 5.1 no encontrado: ${powershell}`);

  const script = path.join(__dirname, '..', 'core', 'sandbox', 'compile-windows-sandbox.ps1');
  const output = path.join(context.appOutDir, 'resources', 'Kaoru.WindowsSandbox.exe');
  await run(powershell, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-OutputPath',
    output,
  ]);
  if (!fs.existsSync(output)) throw new Error('PowerShell no produjo Kaoru.WindowsSandbox.exe');
}

module.exports = afterPack;
module.exports.run = run;
module.exports.verifyRuntimeContents = verifyRuntimeContents;
