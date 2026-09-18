// @ts-check
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  credentialKeysFromConfig,
  performFactoryReset,
} = require('../infrastructure/config/FactoryReset.js');

let passed = 0;
let failed = 0;

/** @param {boolean} condition @param {string} message */
function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoru-factory-reset-'));
  const userData = path.join(root, 'userData');
  const localAppData = path.join(root, 'local');
  const homeDir = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(path.join(localAppData, 'KaoruAgent', 'sandbox'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.asistente-personal'), { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'project.txt'), 'preservar', 'utf8');
  fs.writeFileSync(
    path.join(userData, 'config.json'),
    JSON.stringify({ llm: { providers: { custom_provider: {} }, apiKeys: { gemini: 'secret' } } }),
    'utf8'
  );

  const keys = await credentialKeysFromConfig(path.join(userData, 'config.json'));
  assert(
    keys.includes('custom_provider'),
    'descubre providers personalizados antes de borrar config'
  );
  assert(
    keys.includes('github_token') && keys.includes('app_pin_hash'),
    'incluye credenciales internas'
  );

  const deletedKeys = [];
  const result = await performFactoryReset({
    userData,
    localAppData,
    homeDir,
    platform: 'win32',
    keychain: {
      deleteKey(name) {
        deletedKeys.push(name);
        return true;
      },
    },
  });

  assert(result.failed.length === 0, 'completa la limpieza de rutas propias');
  assert(!fs.existsSync(userData), 'borra userData');
  assert(!fs.existsSync(path.join(localAppData, 'KaoruAgent')), 'borra caché del sandbox Windows');
  assert(!fs.existsSync(path.join(homeDir, '.asistente-personal')), 'borra credenciales locales');
  assert(
    fs.readFileSync(path.join(workspace, 'project.txt'), 'utf8') === 'preservar',
    'preserva workspaces'
  );
  assert(
    deletedKeys.includes('custom_provider'),
    'elimina la credencial del provider personalizado'
  );

  const installer = fs.readFileSync(path.join(__dirname, '..', 'build', 'installer.nsh'), 'utf8');
  assert(
    installer.includes('IfSilent keepKaoruData'),
    'la desinstalación silenciosa conserva datos'
  );
  assert(
    installer.includes('¿También quieres borrar'),
    'el desinstalador interactivo ofrece limpieza'
  );
  const configHandlers = fs.readFileSync(
    path.join(__dirname, '..', 'ipc', 'config-handlers.js'),
    'utf8'
  );
  assert(
    configHandlers.includes('dialog.showMessageBox') &&
      configHandlers.includes("confirmation !== 'BORRAR TODO'"),
    'el proceso principal exige frase y confirmación nativa antes del borrado'
  );

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\nResultado: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
