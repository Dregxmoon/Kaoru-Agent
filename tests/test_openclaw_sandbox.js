'use strict';

/**
 * test_openclaw_sandbox.js — Fase 1: sandbox de herramientas.
 *
 * Verifica que el bwrap del openclaw-server resuelva los problemas reales
 * que hundieron una sesión de producción:
 *   1a. `npm`/`npx`/`tsc` accesibles dentro del sandbox aunque vivan en $HOME
 *       (nvm/fnm/volta) — antes: `bwrap: execvp npm: No such file or directory`.
 *   1b. Sintaxis de shell (`cd x && ...`, pipes) resuelta con `sh -c` — antes
 *       `bwrap: execvp cd: No such file or directory`.
 *   1c. Programas interactivos (readline/prompt-sync) alimentados por `stdin`
 *       en vez de quedar colgados hasta el timeout.
 *
 * Correr igual que las demás suites (Node de Electron):
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron tests/test_openclaw_sandbox.js
 *
 * Si bwrap no está disponible la suite se salta (como test_plugin_sandbox).
 */

const path = require('path');

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

const skip = (label) => {
  console.log(`  ${C.yellow('⊘')} ${label}`);
  skipped++;
};

const srv = require('../openclaw-server.js');

// ── Test 1: detección de sintaxis de shell (pura) ─────────────────────────────

function testNeedsShell() {
  console.log(C.bold('\nTest 1: _needsShellCommand detecta sintaxis de shell'));

  assert(srv._needsShellCommand('cd src && npm i') === true, 'cd + && → shell');
  assert(srv._needsShellCommand('ls | grep foo') === true, 'pipe | → shell');
  assert(srv._needsShellCommand('git log --oneline') === false, 'comando simple → sin shell');
  assert(srv._needsShellCommand('node script.js arg') === false, 'node con args → sin shell');
  assert(srv._needsShellCommand('echo x > out.txt') === true, 'redirección > → shell');
  assert(srv._needsShellCommand('npm i ; git status') === true, 'separador ; → shell');
}

// ── Test 2: binds de la toolchain (raíz en $HOME se remonta) ────────────────

function testToolchainBinds() {
  console.log(C.bold('\nTest 2: la toolchain en $HOME se remonta read-only'));

  for (const bin of ['node', 'npm', 'npx', 'tsc', 'ts-node']) {
    const which = srv._whichBin(bin);
    if (!which) {
      skip(`${bin}: no está en el host (skip)`);
      continue;
    }
    assert(
      typeof which === 'string' && which.length > 0,
      `${bin}: ubicado en el host (${which})`,
      which
    );
  }

  const home = process.env.HOME || '';
  const npm = srv._whichBin('npm');
  if (!home || !npm) {
    skip('npm o HOME ausentes → no se puede validar el bind (skip)');
    return;
  }
  let realNpm = npm;
  try {
    realNpm = require('fs').realpathSync(npm);
  } catch {
    // si realpath falla, nos quedamos con la ruta cruda
  }
  const masked = realNpm.startsWith(home + '/');
  const binds = srv.TOOLCHAIN_BINDS();

  if (!masked) {
    // npm vive en una ruta de sistema (ya visible con --ro-bind / /): nada
    // que remontar, pero TOOLCHAIN_BINDS no debe contener /usr ni similar.
    assert(true, `npm en ruta de sistema ${realNpm} — bind no requerido`);
    assert(
      binds.every((d) => d.startsWith(home + '/')),
      'TOOLCHAIN_BINDS solo remonta rutas bajo $HOME',
      JSON.stringify(binds)
    );
    return;
  }

  const covered = binds.some((d) => realNpm === d || realNpm.startsWith(d + path.sep));
  assert(covered, `el árbol de npm se remonta (${binds.join(', ')})`, realNpm);
}

// ── Test 3: exec real dentro del sandbox ─────────────────────────────────────

async function testExecSandbox() {
  console.log(C.bold('\nTest 3: exec real dentro del sandbox'));

  const node = srv._whichBin('node');
  if (!node) {
    skip('node no está en el host — ejecución sandbox no testeable (skip)');
    return;
  }

  const ok = (r, label) =>
    assert(r && r.result && r.result.exitCode === 0, label, r && r.result ? r.result.stderr : '');

  // 1a — npm accesible dentro del sandbox (el bug de producción).
  const npm = srv._whichBin('npm');
  if (npm) {
    const r = await srv.HANDLERS.exec({ command: 'npm --version', timeout: 30 });
    ok(r, 'npm --version → exit 0 (toolchain visible en $HOME)');
    if (r && r.result && r.result.exitCode === 0) {
      assert(/\d+\.\d+\.\d+/.test(r.result.stdout), 'npm devuelve una versión real');
    }
  } else {
    skip('npm ausente en el host (skip)');
  }

  // 1b — shell real: encadenado con cd (builtin) + node.
  const r2 = await srv.HANDLERS.exec({
    command: 'cd / && node -e "console.log(\'chain-ok\')"',
    timeout: 15,
  });
  ok(r2, 'cd / && node → exit 0 (shell real vía sh -c)');
  if (r2 && r2.result && r2.result.exitCode === 0) {
    assert(r2.result.stdout.includes('chain-ok'), 'la salida del comando encadenado llega');
  }

  // 1b — pipe con sh -c.
  const r3 = await srv.HANDLERS.exec({ command: 'printf "a\\nb\\n" | wc -l', timeout: 15 });
  ok(r3, 'printf | wc -l → exit 0 (pipe)');
  if (r3 && r3.result && r3.result.exitCode === 0) {
    assert(r3.result.stdout.trim() === '2', 'wc -l cuenta las 2 líneas');
  }

  // 1c — programa interactivo alimentado por stdin (readline).
  const r4 = await srv.HANDLERS.exec({
    command: `node -e "const r=require('readline').createInterface({input:process.stdin});r.question('num',a=>{console.log('r:'+a);r.close();})"`,
    stdin: '7\n',
    timeout: 15,
  });
  ok(r4, 'readline con stdin → exit 0 (no se cuelga)');
  if (r4 && r4.result && r4.result.exitCode === 0) {
    assert(r4.result.stdout.includes('r:7'), 'el input llega al programa interactivo');
  }

  // 1c — stdin sin valor: el proceso termina con EOF, no timeout.
  const r5 = await srv.HANDLERS.exec({
    command: `node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log('eof:'+s);process.exit(0)});setTimeout(()=>{console.log('timeout!');process.exit(1)},4000)"`,
    timeout: 15,
  });
  ok(r5, 'stdin cerrado → EOF inmediato (no espera 15s)');
  if (r5 && r5.result && r5.result.exitCode === 0) {
    assert(r5.result.stdout.includes('eof:'), 'EOF llega con stdin vacío');
  }

  // workspace: sigue siendo escribible/visible (bind intacto)
  const r6 = await srv.HANDLERS.exec({ command: 'node -e "console.log(\'ok-ws\')"', timeout: 15 });
  ok(r6, 'node directo (toolchain en $HOME) → exit 0');
  if (r6 && r6.result && r6.result.exitCode === 0) {
    assert(r6.result.stdout.includes('ok-ws'), 'la salida de node llega');
  }
}

// ── Runner ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(C.bold(C.cyan('\nSandbox de herramientas (Fase 1)')));
  console.log(`  ${C.dim('sandbox: ' + (srv.sandboxEnabled() ? 'bwrap' : 'DESACTIVADO'))}`);

  testNeedsShell();
  testToolchainBinds();
  if (!srv.sandboxEnabled()) {
    skip('bwrap no disponible — ejecución sandbox real omitida');
  } else {
    await testExecSandbox();
  }

  console.log(C.bold('\n════════════════════════════════════════════════════════'));
  const total = passed + failed + skipped;
  const color = failed === 0 ? C.green : C.red;
  console.log(
    `  ${color('Resultado')}: ${C.green(`${passed} passed`)}  ${C.red(`${failed} failed`)}  ${C.yellow(`${skipped} skipped`)}  / ${total} total`
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(C.red('Fallo en la ejecución de la suite:'), e);
  process.exit(1);
});
