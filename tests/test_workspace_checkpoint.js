'use strict';

/**
 * test_workspace_checkpoint.js — WorkspaceCheckpoint (core/git) + hook AgentLoop
 * + comando /revertir-tarea.
 *
 * Cubre:
 *   1. Modo git, caso feliz: la tarea edita un archivo trackeado y crea otro;
 *      revertir restaura el estado previo y borra el archivo creado.
 *   2. Caso crítico (working tree sucio previo del usuario): el revert SOLO
 *      deshace los cambios del agente y preserva los cambios previos del
 *      usuario (trackeado sucio y untracked).
 *   3. Modo snapshot (sin repo git): degradación sin git y revert por snapshots.
 *   4. Sin mutaciones: finalize() → null, metadata() → null (no hace ruido).
 *   5. Registro global + revertCheckpoint(id)/listCheckpoints().
 *   6. Comando /revertir-tarea (CommandRegistry) con id y list.
 *   7. Integración AgentLoop: un run real con la mock-bridge deja el checkpoint
 *      finalizado y el revert restaura el working tree.
 *
 * Correr igual que las demás suites (Node de Electron):
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron tests/test_workspace_checkpoint.js
 */

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
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

function assertEqual(a, b, label) {
  assert(a === b, label, `Esperado ${JSON.stringify(b)}, obtenido ${JSON.stringify(a)}`);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@test', ...args],
      { cwd },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`git ${args.join(' ')}: ${stderr || err.message}`));
        resolve((stdout || '').toString());
      }
    );
  });
}

const tempDirs = [];

function mkTmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'init']);
  return dir;
}

function readFile(p) {
  return fs.readFileSync(p, 'utf-8');
}

function fileExists(p) {
  return fs.existsSync(p);
}

// ── Test 1: modo git, caso feliz ─────────────────────────────────────────────

async function testGitHappyPath() {
  console.log(C.bold('\n── Test 1: modo git — revert de un run con mutaciones ─────────'));

  const dir = mkTmpDir('ws-checkpoint-1-');
  fs.writeFileSync(path.join(dir, 'base.txt'), 'original', 'utf-8');
  fs.writeFileSync(path.join(dir, 'otro.txt'), 'otro', 'utf-8');
  initRepo(dir);

  const { WorkspaceCheckpoint } = require('../core/git/WorkspaceCheckpoint.js');
  const cp = new WorkspaceCheckpoint({ cwd: dir });
  await cp.onBeforeMutation({ tool: 'write', params: { path: path.join(dir, 'base.txt'), content: 'x' } });
  fs.writeFileSync(path.join(dir, 'base.txt'), 'agente-edit', 'utf-8');
  fs.writeFileSync(path.join(dir, 'nuevo.txt'), 'nuevo', 'utf-8');

  const meta = await cp.finalize();
  assert(meta !== null, 'finalize() devuelve metadata tras mutación');
  assertEqual(meta.mode, 'git', 'modo git detectado');
  assert(meta.canRevert, 'checkpoint reversible');
  assert(meta.files.includes('nuevo.txt'), 'files incluye el archivo creado');
  assert(meta.files.includes('base.txt'), 'files incluye el archivo editado');

  const res = await cp.revert();
  assert(res.ok, 'revert() ok');
  assertEqual(readFile(path.join(dir, 'base.txt')), 'original', 'base.txt restaurado a su estado original');
  assert(!fileExists(path.join(dir, 'nuevo.txt')), 'nuevo.txt (creado por la tarea) eliminado');
  assertEqual(readFile(path.join(dir, 'otro.txt')), 'otro', 'otro.txt intacto');
}

// ── Test 2: caso crítico — working tree sucio previo del usuario ─────────────

async function testDirtyTreePreserved() {
  console.log(C.bold('\n── Test 2: working tree sucio previo del usuario se preserva ─────'));

  const dir = mkTmpDir('ws-checkpoint-2-');
  fs.writeFileSync(path.join(dir, 'base.txt'), 'v1', 'utf-8');
  initRepo(dir);

  // Sucio previo del usuario: base.txt modificado (trackeado) y user-new.txt (untracked).
  fs.writeFileSync(path.join(dir, 'base.txt'), 'user-edit', 'utf-8');
  fs.writeFileSync(path.join(dir, 'user-new.txt'), 'user-content', 'utf-8');

  const { WorkspaceCheckpoint } = require('../core/git/WorkspaceCheckpoint.js');
  const cp = new WorkspaceCheckpoint({ cwd: dir });

  // La tarea toca base.txt (trackeado sucio), user-new.txt (untracked previo)
  // y crea agente-new.txt — cada mutación pasa por el hook, como en el loop real.
  await cp.onBeforeMutation({ tool: 'write', params: { path: path.join(dir, 'base.txt') } });
  await cp.onBeforeMutation({ tool: 'write', params: { path: path.join(dir, 'user-new.txt') } });
  await cp.onBeforeMutation({ tool: 'write', params: { path: path.join(dir, 'agente-new.txt') } });

  fs.writeFileSync(path.join(dir, 'base.txt'), 'agente-edit', 'utf-8');
  fs.writeFileSync(path.join(dir, 'user-new.txt'), 'agente-touch', 'utf-8');
  fs.writeFileSync(path.join(dir, 'agente-new.txt'), 'x', 'utf-8');

  await cp.finalize();
  const res = await cp.revert();

  assert(res.ok, 'revert() ok');
  assertEqual(readFile(path.join(dir, 'base.txt')), 'user-edit', 'base.txt vuelve al dirty previo del usuario (NO a v1)');
  assertEqual(readFile(path.join(dir, 'user-new.txt')), 'user-content', 'user-new.txt (untracked previo) restaurado');
  assert(!fileExists(path.join(dir, 'agente-new.txt')), 'agente-new.txt (creado por la tarea) eliminado');
  const status = await git(dir, ['status', '--porcelain']);
  assert(status.includes(' M base.txt'), 'git status: base.txt sigue modificado (dirty preservado)');
  assert(status.includes('?? user-new.txt'), 'git status: user-new.txt sigue untracked');
  assert(!status.includes('agente-new'), 'git status: sin rastro del archivo creado por la tarea');
}

// ── Test 3: modo snapshot (sin repo git) ─────────────────────────────────────

async function testSnapshotMode() {
  console.log(C.bold('\n── Test 3: modo snapshot (sin repo git) ──────────────────────────'));

  const dir = mkTmpDir('ws-checkpoint-3-');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello', 'utf-8');

  const { WorkspaceCheckpoint } = require('../core/git/WorkspaceCheckpoint.js');
  const cp = new WorkspaceCheckpoint({ cwd: dir });
  await cp.onBeforeMutation({ tool: 'write', params: { path: path.join(dir, 'a.txt') } });
  await cp.onBeforeMutation({ tool: 'edit', params: { filePath: path.join(dir, 'b.txt') } });

  fs.writeFileSync(path.join(dir, 'a.txt'), 'bye', 'utf-8');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'creado', 'utf-8');

  const meta = await cp.finalize();
  assert(meta !== null, 'finalize() devuelve metadata');
  assertEqual(meta.mode, 'snapshot', 'modo snapshot sin repo git');
  assert(meta.canRevert, 'reversible en modo snapshot');

  const res = await cp.revert();
  assert(res.ok, 'revert() ok en snapshot');
  assertEqual(readFile(path.join(dir, 'a.txt')), 'hello', 'a.txt restaurado del snapshot');
  assert(!fileExists(path.join(dir, 'b.txt')), 'b.txt (creado por la tarea) eliminado');
}

// ── Test 4: sin mutaciones → no hace ruido ───────────────────────────────────

async function testNoMutations() {
  console.log(C.bold('\n── Test 4: sin mutaciones no crea checkpoint ─────────────────────'));

  const dir = mkTmpDir('ws-checkpoint-4-');
  fs.writeFileSync(path.join(dir, 'base.txt'), 'v1', 'utf-8');
  initRepo(dir);

  const { WorkspaceCheckpoint } = require('../core/git/WorkspaceCheckpoint.js');
  const cp = new WorkspaceCheckpoint({ cwd: dir });
  const meta = await cp.finalize();
  assert(meta === null, 'finalize() devuelve null sin mutaciones');
  assert(cp.metadata() === null, 'metadata() devuelve null sin mutaciones');

  // read/edit no son mutaciones de checkpoint (solo write/edit/apply_patch sobre archivos)
  await cp.onBeforeMutation({ tool: 'read', params: { path: path.join(dir, 'base.txt') } });
  assert(cp.metadata() === null, 'read no dispara el checkpoint');
}

// ── Test 5: registro global + revertCheckpoint/listCheckpoints ───────────────

async function testRegistry() {
  console.log(C.bold('\n── Test 5: registro global y revert por id ────────────────────────'));

  const dir = mkTmpDir('ws-checkpoint-5-');
  fs.writeFileSync(path.join(dir, 'base.txt'), 'orig', 'utf-8');
  initRepo(dir);

  const { WorkspaceCheckpoint, getCheckpoint, listCheckpoints, revertCheckpoint } = require('../core/git/WorkspaceCheckpoint.js');
  const cp = new WorkspaceCheckpoint({ cwd: dir });
  await cp.onBeforeMutation({ tool: 'write', params: { path: path.join(dir, 'base.txt') } });
  fs.writeFileSync(path.join(dir, 'base.txt'), 'agente', 'utf-8');
  await cp.finalize();

  assert(getCheckpoint(cp.id) === cp, 'getCheckpoint(id) resuelve la instancia');
  const list = listCheckpoints();
  assert(list.some((m) => m.id === cp.id), 'listCheckpoints() incluye el checkpoint');
  const via = list.find((m) => m.id === cp.id);
  assert(Array.isArray(via.files) && via.files.includes('base.txt'), 'metadata del listado incluye files');

  const res = await revertCheckpoint(cp.id);
  assert(res.ok, 'revertCheckpoint(id) revierte');
  assertEqual(readFile(path.join(dir, 'base.txt')), 'orig', 'archivo restaurado vía registro');
}

// ── Test 6: comando /revertir-tarea ──────────────────────────────────────────

async function testCommand() {
  console.log(C.bold('\n── Test 6: comando /revertir-tarea ────────────────────────────────'));

  const dir = mkTmpDir('ws-checkpoint-6-');
  fs.writeFileSync(path.join(dir, 'base.txt'), 'v0', 'utf-8');
  initRepo(dir);

  const { WorkspaceCheckpoint } = require('../core/git/WorkspaceCheckpoint.js');
  const cp = new WorkspaceCheckpoint({ cwd: dir });
  await cp.onBeforeMutation({ tool: 'write', params: { path: path.join(dir, 'base.txt') } });
  fs.writeFileSync(path.join(dir, 'base.txt'), 'agente', 'utf-8');
  await cp.finalize();

  const { execute } = require('../core/commands/CommandRegistry.js');

  const listResult = await execute('/revertir-tarea list', {});
  assert(
    typeof listResult.result === 'string' && listResult.result.includes(cp.id),
    '/revertir-tarea list muestra el checkpoint',
    listResult.result
  );

  const revertResult = await execute(`/revertir-tarea ${cp.id}`, {});
  assert(typeof revertResult.result === 'string', 'revertir por id devuelve texto');
  assertEqual(readFile(path.join(dir, 'base.txt')), 'v0', 'archivo restaurado vía comando');
}

// ── Test 7: integración AgentLoop ────────────────────────────────────────────

async function testAgentLoopIntegration() {
  console.log(C.bold('\n── Test 7: integración con AgentLoop (run real) ───────────────────'));

  const dir = mkTmpDir('ws-checkpoint-7-');
  fs.writeFileSync(path.join(dir, 'base.txt'), 'original', 'utf-8');
  initRepo(dir);

  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const AP = require('../core/planner/ActionParser.js');
  const { WorkspaceCheckpoint } = require('../core/git/WorkspaceCheckpoint.js');
  AP.setProjectCWD(dir);

  const target = path.join(dir, 'base.txt');
  const created = path.join(dir, 'generado.txt');

  const mockLLM = (() => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls === 1) {
        return `Escribo el cambio.
\`\`\`action
ACCIÓN: write | ARCHIVO: ${target}
\`\`\``;
      }
      if (calls === 2) {
        return `Creo otro archivo.
\`\`\`action
ACCIÓN: write | ARCHIVO: ${created}
\`\`\``;
      }
      return 'Listo.';
    };
    fn.callCount = () => calls;
    return fn;
  })();

  const bridge = {
    execute: async (tool, params) => {
      if (tool === 'write') {
        fs.writeFileSync(params.path, params.content || `contenido de ${path.basename(params.path)}`, 'utf-8');
        return { ok: true, result: 'escrito', error: null, tool, elapsed: 0 };
      }
      return { ok: false, error: `tool desconocida ${tool}`, result: null, tool, elapsed: 0 };
    },
  };

  const checkpoint = new WorkspaceCheckpoint({ cwd: dir });
  const loop = new AgentLoop({ maxIterations: 6, llm: mockLLM, bridge, checkpoint });

  const result = await loop.run('hacé el cambio', 'Sos un asistente de archivos.', [], {
    onApprovalNeeded: async () => true,
  });

  assert(!result.error, 'run() sin error', result.error || '');
  const meta = checkpoint.metadata();
  assert(meta !== null, 'checkpoint finalizado y con metadata tras el run');
  assert(meta.canRevert, 'checkpoint reversible');

  assert(readFile(target) !== 'original', 'el agente modificó base.txt (antes del revert)', readFile(target));
  assert(fileExists(created), 'el agente creó generado.txt');

  const res = await checkpoint.revert();
  assert(res.ok, 'revert() ok tras run real');
  assertEqual(readFile(target), 'original', 'base.txt vuelto al estado original por el revert');
  assert(!fileExists(created), 'generado.txt eliminado por el revert');
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
  console.log(C.bold(' workspace checkpoint'));
  console.log(C.bold('════════════════════════════════════════════════════════'));

  const tests = [
    ['caso feliz (modo git)', testGitHappyPath],
    ['working tree sucio preservado', testDirtyTreePreserved],
    ['modo snapshot sin git', testSnapshotMode],
    ['sin mutaciones', testNoMutations],
    ['registro global', testRegistry],
    ['comando /revertir-tarea', testCommand],
    ['integración AgentLoop', testAgentLoopIntegration],
  ];

  for (const [label, fn] of tests) {
    try {
      await fn();
    } catch (e) {
      console.error(`  ${C.red('✗')} ${label} falló: ${e.message}`);
      failed++;
    }
  }

  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }

  console.log(C.bold('\n════════════════════════════════════════════════════════'));
  const total = passed + failed + skipped;
  const color = failed === 0 ? C.green : C.red;
  const skipNote = skipped > 0 ? `  ${C.yellow(`${skipped} skipped`)}` : '';
  if (failed === 0) {
    console.log(
      `  ${color('Resultado')}: ${color(`${passed} passed`)}  ${C.dim(`0 failed`)}${skipNote}  / ${total} total`
    );
  } else {
    console.log(
      `  Resultado: ${C.green(`${passed} passed`)}  ${C.red(`${failed} failed`)}${skipNote}  / ${total} total`
    );
  }
  console.log(C.bold('════════════════════════════════════════════════════════'));

  if (failed > 0) process.exit(1);
}

main();