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

// ── 3. Ejecutar @electron/rebuild para módulos nativos ──────────────────────

function rebuildNativeModules() {
  log('info', 'Reconstruyendo módulos nativos para Electron...');

  try {
    // Invocar el binario local de @electron/rebuild directamente (el shim
    // multiplataforma de node_modules/.bin). Evita `spawnSync('npx', ...)`,
    // que en Windows falla con ENOENT porque npx no está en el PATH del
    // postinstall (hay que usar npx.cmd). El .bin/cmd de Windows funciona.
    const rebuildBin = path.join(
      __dirname,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'electron-rebuild.cmd' : 'electron-rebuild'
    );
    const result = spawnSync(rebuildBin, ['-f', '-w', 'better-sqlite3'], {
      cwd: __dirname,
      stdio: 'inherit',
      timeout: 180000,
      shell: process.platform === 'win32',
    });

    if (result.status === 0) {
      log('ok', 'Módulos nativos reconstruidos correctamente');
    } else {
      log('error', `@electron/rebuild terminó con código ${result.status} — better-sqlite3 probablemente NO va a funcionar`);
      log('error', 'Ejecuta manualmente: npx @electron/rebuild -f -w better-sqlite3');
      if (result.error) {
        log('error', result.error.message);
      }
      exitCode = 1;
    }
  } catch (e) {
    log('error', `No se pudo ejecutar @electron/rebuild: ${e.message} — better-sqlite3 probablemente NO va a funcionar`);
    log('error', 'Instálalo con: npm install -D @electron/rebuild, luego corre: npx @electron/rebuild -f -w better-sqlite3');
    exitCode = 1;
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

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
