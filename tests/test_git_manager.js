'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GitManager } = require('../core/git/GitManager.js');

const C = {
  green:  (s) => `\x1b[32m${s}\x1b[0m`,
  red:    (s) => `\x1b[31m${s}\x1b[0m`,
  bold:   (s) => `\x1b[1m${s}\x1b[0m`,
  cyan:   (s) => `\x1b[36m${s}\x1b[0m`,
  dim:    (s) => `\x1b[2m${s}\x1b[0m`,
};

let passed = 0;
let failed = 0;

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

function git(repoDir, args) {
  return execFileSync('git', args, { cwd: repoDir, encoding: 'utf-8' });
}

function writeFile(repoDir, rel, content) {
  const p = path.join(repoDir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

let tmpRoot;
let repoDir;

function setup() {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gitmgr-'));
  repoDir = path.join(tmpRoot, 'repo');
  fs.mkdirSync(repoDir);
  git(repoDir, ['init', '-b', 'main']);
  git(repoDir, ['config', 'user.email', 'test@asistente.local']);
  git(repoDir, ['config', 'user.name', 'Test']);
  git(repoDir, ['config', 'commit.gpgsign', 'false']);
}

function teardown() {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
}

// ── Test 1: no-repo → isRepo false / status falla ─────────────────────────────

async function testNotARepo() {
  console.log(C.bold('\n── Test 1: directorio sin repo ─────────────────────────────────'));
  const gm = new GitManager();
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'gitmgr-notrepo-'));
  try {
    const isRepo = await gm.isRepo(empty);
    assert(isRepo === false, 'isRepo() === false en carpeta sin .git');
    let threw = false;
    try { await gm.status(empty); } catch (e) { threw = true; assert(e.exitCode != null || e.message, 'status lanza error estructurado'); }
    assert(threw, 'status() lanza cuando no hay repo');
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
}

// ── Test 2: status parses staged/unstaged/untracked ───────────────────────────

async function testStatus() {
  console.log(C.bold('\n── Test 2: git_status estructurado ──────────────────────────────'));
  const gm = new GitManager();

  writeFile(repoDir, 'a.txt', 'hola\n');
  git(repoDir, ['add', 'a.txt']);
  git(repoDir, ['commit', '-m', 'add a']);

  writeFile(repoDir, 'b.txt', 'nuevo\n');   // untracked
  writeFile(repoDir, 'a.txt', 'hola\ncambio\n'); // unstaged
  writeFile(repoDir, 'c.txt', 'staged\n');
  git(repoDir, ['add', 'c.txt']);            // staged

  const st = await gm.status(repoDir);
  assert(st.branch === 'main', 'branch = main', `branch: ${st.branch}`);
  assert(st.clean === false, 'repo no está limpio');
  assert(st.untracked.includes('b.txt'), 'b.txt untracked', JSON.stringify(st.untracked));
  assert(st.unstaged.some(u => u.path === 'a.txt'), 'a.txt unstaged', JSON.stringify(st.unstaged));
  assert(st.staged.some(s => s.path === 'c.txt'), 'c.txt staged', JSON.stringify(st.staged));
  assert(st.conflicts.length === 0, 'sin conflictos');

  const clean = await gm.status(repoDir);
  assert(clean.total >= 3, 'total cuenta los cambios', `total: ${clean.total}`);
}

// ── Test 3: diff staged/unstaged ──────────────────────────────────────────────

async function testDiff() {
  console.log(C.bold('\n── Test 3: git_diff incluye patch y stat ─────────────────────────'));
  const gm = new GitManager();
  const unstaged = await gm.diff(repoDir, { file: 'a.txt' });
  assert(unstaged.patch.includes('+cambio'), 'patch del unstaged contiene el cambio', unstaged.patch.slice(0, 200));
  assert(Array.isArray(unstaged.summary) && unstaged.summary.length >= 1, 'summary con stat', JSON.stringify(unstaged.summary));

  const staged = await gm.diff(repoDir, { staged: true });
  assert(staged.patch.includes('+staged'), 'patch del staged contiene +staged', staged.patch.slice(0, 200));
}

// ── Test 4: log ───────────────────────────────────────────────────────────────

async function testLog() {
  console.log(C.bold('\n── Test 4: git_log con commits parseados ────────────────────────'));
  const gm = new GitManager();
  const lg = await gm.log(repoDir, { count: 10 });
  assert(lg.total >= 1, 'hay al menos un commit');
  const first = lg.commits[0];
  assert(/^[0-9a-f]{7,}$/.test(first.hash), 'hash corto válido', first.hash);
  assert(first.subject.length > 0, 'subject presente', first.subject);
}

// ── Test 5: branch ────────────────────────────────────────────────────────────

async function testBranch() {
  console.log(C.bold('\n── Test 5: git_branch con current ───────────────────────────────'));
  const gm = new GitManager();
  const b = await gm.branch(repoDir);
  assert(b.current === 'main', 'current = main');
  assert(b.branches.some(x => x.name === 'main' && x.current), 'main marcada current');
}

// ── Test 6: commit ────────────────────────────────────────────────────────────

async function testCommit() {
  console.log(C.bold('\n── Test 6: git_commit hace add + commit ─────────────────────────'));
  const gm = new GitManager();
  writeFile(repoDir, 'd.txt', 'para commit\n');
  const res = await gm.commit(repoDir, { message: 'feat: agrega d' });
  assert(res.committed === true, 'commit exitoso');
  assert(res.hash && /^[0-9a-f]{7,}$/.test(res.hash), 'hash devuelto', res.hash);

  let threw = false;
  try { await gm.commit(repoDir, {}); } catch (e) { threw = /mensaje/.test(e.message); }
  assert(threw, 'commit sin message es rechazado');
}

// ── Test 7: stash ─────────────────────────────────────────────────────────────

async function testStash() {
  console.log(C.bold('\n── Test 7: git_stash list/push ──────────────────────────────────'));
  const gm = new GitManager();
  writeFile(repoDir, 'e.txt', 'e\n');
  git(repoDir, ['add', 'e.txt']);
  git(repoDir, ['commit', '-m', 'add e']);
  writeFile(repoDir, 'e.txt', 'e\nmodificado\n');   // cambio trackeado
  const pushed = await gm.stash(repoDir, { action: 'push', message: 'wip e' });
  assert(pushed.ok === true, 'stash push ok');
  const st = await gm.status(repoDir);
  assert(!st.unstaged.some(u => u.path === 'e.txt') && !st.staged.some(s => s.path === 'e.txt'), 'e.txt ya no aparece como modificado', JSON.stringify({ unstaged: st.unstaged, staged: st.staged }));
  const list = await gm.stash(repoDir, { action: 'list' });
  assert(list.stashes.length >= 1, 'hay stash listado', JSON.stringify(list.stashes));
  const popped = await gm.stash(repoDir, { action: 'pop' });
  assert(popped.ok === true, 'stash pop ok');
  assert(fs.readFileSync(path.join(repoDir, 'e.txt'), 'utf-8').includes('modificado'), 'cambio restaurado tras pop');
}

// ── Test 8: merge con conflicto detectado ─────────────────────────────────────

async function testMergeConflict() {
  console.log(C.bold('\n── Test 8: git_merge detecta conflicto estructurado ─────────────'));
  const gm = new GitManager();
  writeFile(repoDir, 'conflict.txt', 'base\n');
  git(repoDir, ['add', 'conflict.txt']);
  git(repoDir, ['commit', '-m', 'base conflict']);

  git(repoDir, ['checkout', '-b', 'feature']);
  writeFile(repoDir, 'conflict.txt', 'base\nfeature change\n');
  git(repoDir, ['add', 'conflict.txt']);
  git(repoDir, ['commit', '-m', 'feature change']);

  git(repoDir, ['checkout', 'main']);
  writeFile(repoDir, 'conflict.txt', 'base\nmain change\n');
  git(repoDir, ['add', 'conflict.txt']);
  git(repoDir, ['commit', '-m', 'main change']);

  const res = await gm.merge(repoDir, { branch: 'feature' });
  assert(res.conflict === true, 'merge reporta conflicto', JSON.stringify(res).slice(0, 300));
  assert(res.conflictedFiles.includes('conflict.txt'), 'archivo en conflicto detectado', JSON.stringify(res.conflictedFiles));
  assert(res.hint && res.hint.length > 0, 'incluye hint de resolución');

  // el repo queda con UU → status lo ve
  const st = await gm.status(repoDir);
  assert(st.conflicts.length >= 1, 'git_status muestra el conflicto', JSON.stringify(st.conflicts));

  // limpiar para no romper tests siguientes
  git(repoDir, ['reset', '--hard', 'HEAD']);
  git(repoDir, ['branch', '-D', 'feature']);
}

// ── Test 9: validación de parámetros ──────────────────────────────────────────

async function testParamValidation() {
  console.log(C.bold('\n── Test 9: parámetros inválidos rechazados ──────────────────────'));
  const gm = new GitManager();
  let threw = false;
  try { await gm.merge(repoDir, { branch: '--abort' }); } catch (e) { threw = /rama/.test(e.message); }
  assert(threw, 'merge branch "--abort" rechazado');
  threw = false;
  try { await gm.merge(repoDir, { branch: 'feat; rm -rf /' }); } catch (e) { threw = /rama/.test(e.message); }
  assert(threw, 'merge branch con shell metachar rechazado');
}

// ── Test 10: git_push sube commits al remoto ──────────────────────────────────

async function testPush() {
  console.log(C.bold('\n── Test 10: git_push sube commits al remoto ─────────────────────'));
  const gm = new GitManager();
  const remoteDir = path.join(tmpRoot, 'remote.git');
  git(repoDir, ['init', '--bare', remoteDir]);
  git(repoDir, ['remote', 'add', 'origin', remoteDir]);
  writeFile(repoDir, 'push-me.txt', 'v1\n');
  git(repoDir, ['add', 'push-me.txt']);
  git(repoDir, ['commit', '-m', 'to push']);

  // Primera push con branch explícita: -u fija el upstream (hermético, no
  // depende del push.default del entorno).
  const res = await gm.push(repoDir, { branch: 'main' });
  assert(res.pushed === true, 'push ok', JSON.stringify(res).slice(0, 200));
  assert(res.remote === 'origin', 'remote por defecto = origin');
  const received = git(remoteDir, ['log', 'main', '--oneline', '-1']);
  assert(received.includes('to push'), 'el remoto recibió el commit', received);

  // Sin branch explícita: usa el upstream que ya quedó fijado.
  const res2 = await gm.push(repoDir, {});
  assert(res2.pushed === true, 'push sin branch explícita (usa upstream)');

  let threw = false;
  try { await gm.push(repoDir, { branch: '--abort' }); } catch (e) { threw = /rama/.test(e.message); }
  assert(threw, 'branch inválida rechazada');
  threw = false;
  try { await gm.push(repoDir, { remote: '--mirror' }); } catch (e) { threw = /remote/.test(e.message); }
  assert(threw, 'remote inválido rechazado');
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
  console.log(C.bold(C.cyan('  Test Suite: §10 — GitManager (tool nativa) ')));
  console.log(C.bold(C.cyan('════════════════════════════════════════════════════════')));

  setup();
  try {
    await testNotARepo();
    await testStatus();
    await testDiff();
    await testLog();
    await testBranch();
    await testCommit();
    await testStash();
    await testMergeConflict();
    await testParamValidation();
    await testPush();
  } finally {
    teardown();
  }

  console.log(C.bold('\n════════════════════════════════════════════════════════'));
  const total = passed + failed;
  console.log(
    C.bold(`  Resultado: ${C.green(passed + ' passed')}  ${failed > 0 ? C.red(failed + ' failed') : C.dim('0 failed')}  / ${total} total`)
  );
  console.log(C.bold('════════════════════════════════════════════════════════\n'));

  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(C.red('\nERROR FATAL:'), e.message);
  console.error(e.stack);
  try { teardown(); } catch {}
  process.exit(1);
});
