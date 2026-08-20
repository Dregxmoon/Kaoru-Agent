'use strict';

// E2E real del LSP (G.5, ítem "bloqueante"): happy-path post-edit contra un
// language server REAL, no con mocks.
//
//   - crea un workspace TypeScript real con typescript-language-server vía npx
//     (el server se auto-instala la primera vez, patrón ya usado por el repo);
//   - LSPManager.start() detecta el lenguaje por manifest (package.json);
//   - openDocument → changeDocument con un error de tipo → waitForDiagnostics
//     devuelve el diagnóstico REAL publicado por tsserver;
//   - el fix del error → los diagnósticos desaparecen;
//   - hover resuelve el tipo real del símbolo (LSP.3);
//   - goToDefinition navega al símbolo definido en otro archivo.
//
// Se salta (con aviso) si el server no está disponible: los servidores npx se
// auto-instalan, pero en un entorno offline el e2e no puede correr.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

let passed = 0;
let failed = 0;
let skipped = 0;

function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  ${C.green('✓')} ${label}`);
    passed++;
  } else {
    console.log(`  ${C.red('✗')} ${label}`);
    if (detail) console.log(`    ${C.dim(detail)}`);
    failed++;
  }
}

function skip(label) {
  console.log(`  ${C.yellow('⊘')} ${label} (omitido)`);
  skipped++;
}

const { LSPManager } = require('../core/lsp/LSPManager.js');

// ── Workspace TS real ────────────────────────────────────────────────────────
// paquete.types.ts exporta la función `sum` con tipos; app.ts la usa con un
// error de tipo (string donde va number) que tsserver debe reportar, y un
// hover sobre `sum` que debe resolver el tipo real.

const WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-e2e-ts-'));
const SRC_DIR = path.join(WORKSPACE_DIR, 'src');
const PKG_PATH = path.join(WORKSPACE_DIR, 'package.json');
const TS_CONFIG = path.join(WORKSPACE_DIR, 'tsconfig.json');
const TYPES_PATH = path.join(SRC_DIR, 'types.ts');
const APP_PATH = path.join(SRC_DIR, 'app.ts');

const TYPES_CONTENT = `export function sum(a: number, b: number): number {
  return a + b;
}
export const VERSION: string = '1.0.0';
`;

const APP_GOOD = `import { sum, VERSION } from './types';

export function total(xs: number[]): number {
  return xs.reduce((acc, x) => acc + x, 0);
}
export const label = \`v\${VERSION} total=\${total([1, 2, 3])}\`;
export const s = sum(1, 2);
`;

const APP_ERROR = APP_GOOD.replace('export const s = sum(1, 2);', "export const s = sum('x', 2);");

function setupWorkspace() {
  fs.mkdirSync(SRC_DIR, { recursive: true });
  fs.writeFileSync(
    PKG_PATH,
    JSON.stringify({ name: 'lsp-e2e', private: true, version: '0.0.0' }, null, 2)
  );
  fs.writeFileSync(
    TS_CONFIG,
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2020',
          module: 'commonjs',
          strict: true,
          outDir: './dist',
        },
        include: ['src/**/*.ts'],
      },
      null,
      2
    )
  );
  fs.writeFileSync(TYPES_PATH, TYPES_CONTENT);
  fs.writeFileSync(APP_PATH, APP_GOOD);
}

// El server TS vía npx necesita typescript resoluble desde el workspace.
// npm install typescript (local) evita el "Could not find a valid TypeScript
// installation". Offline → se omite el e2e.
// En Windows npm/npx son shims `.cmd` → shell:true (igual que LSPManager).
const IS_WIN = process.platform === 'win32';
const NPM = IS_WIN ? 'npm.cmd' : 'npm';
const NPX = IS_WIN ? 'npx.cmd' : 'npx';

function installTypescript() {
  try {
    execFileSync(NPM, ['install', '--no-save', 'typescript@5.5.4'], {
      cwd: WORKSPACE_DIR,
      stdio: 'pipe',
      timeout: 120000,
      shell: IS_WIN,
    });
    return true;
  } catch (e) {
    console.log(`  ${C.dim(`  (npm install typescript falló: ${(e && e.message) || e})`)}`);
    return false;
  }
}

function serverAvailable() {
  try {
    const r = spawnSync(NPX, ['--no-install', 'typescript-language-server', '--version'], {
      stdio: 'pipe',
      timeout: 15000,
      shell: IS_WIN,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

async function main() {
  console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
  console.log(C.bold(C.cyan('  LSP e2e real — feedback post-edit contra tsserver')));
  console.log(C.bold(C.cyan('════════════════════════════════════════════════════════')));

  setupWorkspace();
  const tsInstalled = installTypescript();
  if (!tsInstalled) {
    console.log(C.yellow('\n  Sin typescript local — se omite el e2e real (requiere red).'));
    console.log('  Los tests LSP con mocks siguen cubriendo el resto (test_lsp_requests.js).');
    skip('e2e real contra tsserver (sin typescript instalable)');
    finish();
    return;
  }

  if (!serverAvailable()) {
    console.log(C.yellow('\n  typescript-language-server no disponible vía npx.'));
    skip('e2e real contra tsserver (server no disponible)');
    finish();
    return;
  }

  const manager = new LSPManager();

  // ── 1. start: detecta typescript por package.json ─────────────────────────
  console.log(C.bold('\n── 1. start() detecta TS y arranca el server real ──────────────'));
  let primary;
  try {
    primary = await manager.start(WORKSPACE_DIR);
    assert(primary === 'typescript', 'lenguaje primario detectado: typescript', primary);
  } catch (e) {
    assert(false, 'LSPManager.start() arranca sin errores', (e && e.message) || String(e));
    await manager.stop();
    finish();
    return;
  }

  // ── 2. openDocument: abre app.ts (sano) ────────────────────────────────────
  console.log(C.bold('\n── 2. openDocument: archivo sano, sin diagnósticos ──────────────'));
  try {
    await manager.openDocument(APP_PATH);
    await manager.waitForDiagnostics(APP_PATH, { debounceMs: 400, timeoutMs: 15000 });
    const diags = await manager.getDiagnostics(APP_PATH);
    assert(Array.isArray(diags), 'getDiagnostics devuelve array');
    const errors = (diags || []).filter((d) => d.severity === 1);
    assert(
      errors.length === 0,
      'sin errores en el archivo sano',
      JSON.stringify(diags).slice(0, 200)
    );
  } catch (e) {
    assert(false, 'open + waitForDiagnostics en archivo sano', (e && e.message) || String(e));
  }

  // ── 3. changeDocument con error de tipo → diagnóstico REAL ─────────────────
  console.log(C.bold('\n── 3. changeDocument con error → tsserver lo reporta ─────────────'));
  try {
    await manager.changeDocument(APP_PATH, APP_ERROR);
    const diags = await manager.waitForDiagnostics(APP_PATH, { debounceMs: 400, timeoutMs: 15000 });
    const errors = (diags || []).filter((d) => d.severity === 1);
    assert(
      errors.length > 0,
      'el error de tipo aparece en los diagnósticos',
      JSON.stringify(diags).slice(0, 300)
    );
    if (errors.length > 0) {
      const line = errors[0].range?.start?.line ?? null;
      const msg = String(errors[0].message || '');
      assert(
        /number|string/.test(msg),
        'el mensaje real de tsserver menciona el tipo (number/string)',
        msg
      );
      assert(line !== null && line >= 0, 'el diagnóstico lleva range de línea', String(line));
    }
  } catch (e) {
    assert(false, 'changeDocument con error → diagnóstico real', (e && e.message) || String(e));
  }

  // ── 4. fix → los diagnósticos se limpian ───────────────────────────────────
  console.log(C.bold('\n── 4. fix del error → los diagnósticos desaparecen ──────────────'));
  try {
    await manager.changeDocument(APP_PATH, APP_GOOD);
    const diags = await manager.waitForDiagnostics(APP_PATH, { debounceMs: 400, timeoutMs: 15000 });
    const errors = (diags || []).filter((d) => d.severity === 1);
    assert(
      errors.length === 0,
      'tras el fix no quedan errores de tipo',
      JSON.stringify(diags).slice(0, 200)
    );
  } catch (e) {
    assert(false, 'fix → diagnósticos limpios', (e && e.message) || String(e));
  }

  // ── 5. hover: tipo real del símbolo (LSP.3) ────────────────────────────────
  console.log(C.bold('\n── 5. hover resuelve el tipo real de sum() ──────────────────────'));
  try {
    // app.ts sano: línea 6 → `export const s = sum(1, 2);`. sum está en col 15-18.
    const h = await manager.hover(APP_PATH, 6, 18);
    const text = h && typeof h === 'object' ? h.contents : h;
    assert(
      text && typeof text === 'string' && /number/.test(text),
      'hover devuelve el tipo real (number)',
      typeof text === 'string' ? text.slice(0, 120) : 'null'
    );
  } catch (e) {
    assert(false, 'hover sobre sum()', (e && e.message) || String(e));
  }

  // ── 6. goToDefinition: salta a types.ts ────────────────────────────────────
  console.log(C.bold('\n── 6. goToDefinition navega a la definición en types.ts ──────────'));
  try {
    const defs = await manager.goToDefinition(APP_PATH, 6, 18);
    assert(Array.isArray(defs) && defs.length > 0, 'goToDefinition devuelve destinos');
    if (defs.length > 0) {
      const fp = defs[0].filePath || defs[0].uri;
      assert(typeof fp === 'string' && fp.includes('types.ts'), 'el destino es types.ts', fp);
    }
  } catch (e) {
    assert(false, 'goToDefinition a types.ts', (e && e.message) || String(e));
  }

  // ── 7. stop limpio ─────────────────────────────────────────────────────────
  console.log(C.bold('\n── 7. stop() cierra el server sin error ─────────────────────────'));
  try {
    await manager.stop();
    assert(true, 'stop() ok');
  } catch (e) {
    assert(false, 'stop() ok', (e && e.message) || String(e));
  }

  fs.rmSync(WORKSPACE_DIR, { recursive: true, force: true });
  finish();
}

function finish() {
  try {
    fs.rmSync(WORKSPACE_DIR, { recursive: true, force: true });
  } catch {}
  console.log(C.bold('\n════════════════════════════════════════════════════════'));
  const total = passed + failed + skipped;
  console.log(
    C.bold(
      `  Resultado: ${C.green(passed + ' passed')}  ${failed > 0 ? C.red(failed + ' failed') : C.dim('0 failed')}  ${skipped > 0 ? C.yellow(skipped + ' skipped') : ''}  / ${total} total`
    )
  );
  console.log(C.bold('════════════════════════════════════════════════════════\n'));
  if (failed > 0) process.exit(1);
}

main();
