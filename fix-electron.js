const fs = require('fs');
const path = require('path');
const { spawnSync, execSync } = require('child_process');

const ELECTRON_DIR = path.join(__dirname, 'node_modules', 'electron');
const DIST_DIR = path.join(ELECTRON_DIR, 'dist');
const VERSION = JSON.parse(fs.readFileSync(path.join(ELECTRON_DIR, 'package.json'), 'utf8')).version;

let exitCode = 0;

function log(label, msg) {
  console.log(`[fix-electron] ${label}: ${msg}`);
}

// ── 1. Verificar si Electron ya está instalado ──────────────────────────────

function isElectronInstalled() {
  try {
    const versionFile = path.join(DIST_DIR, 'version');
    if (fs.existsSync(versionFile) && fs.readFileSync(versionFile, 'utf-8').replace(/^v/, '') === VERSION) {
      return true;
    }
    const pathFile = path.join(ELECTRON_DIR, 'path.txt');
    if (fs.existsSync(pathFile)) {
      const binName = fs.readFileSync(pathFile, 'utf-8').trim();
      if (binName && fs.existsSync(path.join(DIST_DIR, binName))) {
        return true;
      }
    }
  } catch (_) {}
  return false;
}

// ── 2. Forzar instalación de Electron ───────────────────────────────────────

function ensureElectronBinary() {
  if (isElectronInstalled()) {
    log('ok', `Electron v${VERSION} ya está instalado`);
    return;
  }

  log('info', `Electron v${VERSION} no encontrado, instalando...`);

  if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) {
    log('warn', 'ELECTRON_SKIP_BINARY_DOWNLOAD está activo, saltando descarga');
    return;
  }

  // Intentar primero con install.js del propio electron
  try {
    const installScript = path.join(ELECTRON_DIR, 'install.js');
    if (fs.existsSync(installScript)) {
      log('info', 'Ejecutando install.js de electron...');
      const result = spawnSync('node', [installScript], {
        cwd: ELECTRON_DIR,
        stdio: 'inherit',
        timeout: 120000,
        env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: '' },
      });
      if (result.status === 0 && isElectronInstalled()) {
        log('ok', 'Electron instalado correctamente vía install.js');
        return;
      }
      if (result.error) {
        log('warn', `install.js falló (${result.error.message}), intentando descarga directa...`);
      } else {
        log('warn', `install.js terminó con código ${result.status}, intentando descarga directa...`);
      }
    }
  } catch (e) {
    log('warn', `No se pudo ejecutar install.js: ${e.message}`);
  }

  // Fallback: descarga manual del zip
  downloadElectronManual();
}

function downloadElectronManual() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const platform = process.platform;
  const ext = platform === 'win32' ? 'zip' : 'tar.gz';
  const zipName = `electron-v${VERSION}-${platform}-${arch}.${ext}`;
  const zipUrl = `https://github.com/electron/electron/releases/download/v${VERSION}/${zipName}`;

  log('info', `Descargando ${zipUrl} ...`);

  if (!fs.existsSync(DIST_DIR)) {
    fs.mkdirSync(DIST_DIR, { recursive: true });
  }

  const zipPath = path.join(DIST_DIR, zipName);

  try {
    const downloadTool = platform === 'win32'
      ? `powershell -NoProfile -NonInteractive -Command "& {` +
        `\$wc = New-Object System.Net.WebClient; ` +
        `\$wc.DownloadProgressChanged = {` +
        `  \$$ = \`$($_.ProgressPercentage); ` +
        `  Write-Progress -Activity 'Descargando Electron' -PercentComplete \`$($_.ProgressPercentage); ` +
        `}; ` +
        `\$wc.DownloadFile('${zipUrl}', '${zipPath}')}"`
      : `curl -L# "${zipUrl}" -o "${zipPath}"`;

    execSync(downloadTool, { stdio: 'inherit', timeout: 300000 });
  } catch (e) {
    log('error', `No se pudo descargar Electron: ${e.message}`);
    log('error', 'Descárgalo manualmente desde https://github.com/electron/electron/releases');
    log('error', `y extrae el contenido en: ${DIST_DIR}`);
    exitCode = 1;
    return;
  }

  log('info', `Extrayendo ${zipName} ...`);

  try {
    if (ext === 'zip') {
      execSync(`powershell -NoProfile -NonInteractive -Command "Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${DIST_DIR}' -Force"`, { stdio: 'inherit', timeout: 60000 });
    } else {
      execSync(`tar -xzf "${zipPath}" -C "${DIST_DIR}"`, { stdio: 'inherit', timeout: 60000 });
    }
    fs.unlinkSync(zipPath);
  } catch (e) {
    log('error', `Error extrayendo: ${e.message}`);
    exitCode = 1;
    return;
  }

  const binName = platform === 'win32' ? 'electron.exe' : 'electron';
  fs.writeFileSync(path.join(ELECTRON_DIR, 'path.txt'), binName, 'utf8');

  if (isElectronInstalled()) {
    log('ok', 'Electron instalado correctamente vía descarga manual');
  } else {
    log('error', 'El binario de Electron no apareció después de la extracción');
    exitCode = 1;
  }
}

// ── 3a. Verificar si better-sqlite3 ya está compilado para el ABI de Electron ──

function isBetterSqlite3Ready() {
  try {
    const sqlite3 = require(path.join(__dirname, 'node_modules', 'better-sqlite3'));
    // better-sqlite3 exporta Database directamente o como propiedad.
    if (typeof sqlite3 === 'function' || typeof sqlite3.Database === 'function') {
      return true;
    }
    return false;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('ERR_NODE_BINDING') || msg.includes('native') || msg.includes('ABI') || msg.includes('did not self-register')) {
      return false;
    }
  }
  return false;
}

// ── 3b. Reconstrucción con fallback gracioso ──────────────────────

function rebuildNativeModules() {
  log('info', 'Verificando módulos nativos para Electron...');

  // Pre-check: ¿better-sqlite3 ya funciona?
  if (isBetterSqlite3Ready()) {
    log('ok', 'better-sqlite3 ya está compilado y listo (ABI compatible)');
    return;
  }

  log('info', 'better-sqlite3 necesita reconstrucción para el ABI de Electron');

  const rebuildBin = path.join(
    __dirname,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'electron-rebuild.cmd' : 'electron-rebuild'
  );

  // Intentar reconstrucción con @electron/rebuild
  try {
    if (!fs.existsSync(rebuildBin)) {
      log('warn', '@electron/rebuild no encontrado — intentando npm install');
      try {
        execSync('npm install @electron/rebuild --save-dev', {
          cwd: __dirname,
          stdio: 'inherit',
          timeout: 120000,
        });
      } catch (_) {
        log('error', 'No se pudo instalar @electron/rebuild');
      }
    }

    if (!fs.existsSync(rebuildBin)) {
      log('error', 'No se encontró electron-rebuild en node_modules/.bin');
      log('warn', 'Intentando alternativa con node directamente...');
      tryRebuildViaNode();
      return;
    }

    const result = spawnSync(rebuildBin, ['-f', '-w', 'better-sqlite3'], {
      cwd: __dirname,
      stdio: 'inherit',
      timeout: 180000,
      shell: process.platform === 'win32',
    });

    if (result.status === 0 && isBetterSqlite3Ready()) {
      log('ok', 'Módulos nativos reconstruidos correctamente — better-sqlite3 funcional');
      return;
    }

    if (result.status === 0) {
      log('warn', '@electron/rebuild terminó con código 0 pero better-sqlite3 no carga');
      log('warn', 'Posible mismatch de ABI — reintenta con: npm run rebuild');
    } else {
      log('error', `@electron/rebuild terminó con código ${result.status}`);
    }

    if (result.error) {
      log('error', result.error.message);
    }

    // Fallback: intentar reconstrucción individual
    log('info', 'Intentando fallback de reconstrucción...');
    tryFallbackRebuild();
  } catch (e) {
    log('error', `No se pudo ejecutar @electron/rebuild: ${e instanceof Error ? e.message : String(e)}`);
    log('warn', 'Intentando alternativa con node directamente...');
    tryFallbackRebuild();
  }
}

function tryRebuildViaNode() {
  try {
    const result = spawnSync(
      process.execPath,
      [
        path.join(__dirname, 'node_modules', '@electron', 'rebuild', 'cli.js'),
        '-f', '-w', 'better-sqlite3',
      ],
      { cwd: __dirname, stdio: 'inherit', timeout: 180000 }
    );
    if (result.status === 0 && isBetterSqlite3Ready()) {
      log('ok', 'Reconstrucción vía node exitosa');
      return;
    }
  } catch (_) {}
  log('warn', 'Fallback de reconstrucción no disponible');
  log('warn', 'El asistente puede seguir funcionando sin better-sqlite3 (memoria en RAM).');
  log('warn', 'Para corregir, ejecuta: npm run rebuild');
}

function tryFallbackRebuild() {
  // Último intento: ejecutar rebuild directamente con node
  try {
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `require('@electron/rebuild').rebuild({ buildFromSource: true, modules: ['better-sqlite3'] })`,
      ],
      { cwd: __dirname, stdio: 'inherit', timeout: 180000 }
    );
    if (result.status === 0 && isBetterSqlite3Ready()) {
      log('ok', 'Fallback de reconstrucción exitoso');
      return;
    }
  } catch (_) {}

  log('error', 'No se pudo reconstruir better-sqlite3 con ningún método');
  log('error', 'El asistente usará memoria en RAM como fallback');
  log('warn', 'Para corregir permanentemente ejecuta:');
  log('warn', '  npm run rebuild');
  log('warn', 'O en Windows: npx @electron/rebuild -f -w better-sqlite3');
}

// ── Main ────────────────────────────────────────────────────────────

console.log('═══════════════════════════════════════════════════════');
console.log('  fix-electron — instalación multiplataforma');
console.log('═══════════════════════════════════════════════════════');

ensureElectronBinary();

if (exitCode === 0) {
  rebuildNativeModules();
}

console.log('═══════════════════════════════════════════════════════');
if (exitCode === 0) {
  console.log('  Todo listo — el asistente puede iniciarse');
} else {
  console.log('  ⚠  Algo salió mal, revisa los mensajes de error');
}
console.log('═══════════════════════════════════════════════════════');

process.exit(exitCode);
