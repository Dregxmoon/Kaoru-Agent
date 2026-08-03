'use strict';

const { GitHubManager, GITHUB_TOKEN_KEY } = require('../core/github/GitHubManager.js');

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

// Fake fetch: devuelve respuestas de acuerdo al path y método.
function makeFetch(routes) {
  const calls = [];
  const fake = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null, auth: opts.headers?.Authorization || null });
    const key = `${opts.method || 'GET'} ${url}`;
    const hit = routes[key] || routes[url];
    if (!hit) {
      return { status: 404, text: async () => JSON.stringify({ message: 'not found' }) };
    }
    if (typeof hit === 'function') {
      const out = await hit({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
      return { status: out.status, text: async () => JSON.stringify(out.body) };
    }
    return { status: hit.status ?? 200, text: async () => JSON.stringify(hit.body ?? {}) };
  };
  fake.calls = calls;
  return fake;
}

// ── Test 1: sin token → error claro ───────────────────────────────────────────

async function testNoToken() {
  console.log(C.bold('\n── Test 1: sin token → error claro ──────────────────────────────'));
  const fake = makeFetch({});
  const gm = new GitHubManager({ fetch: fake, token: null, resolveToken: async () => null });
  let err = null;
  try { await gm.repoInfo('owner/repo'); } catch (e) { err = e; }
  assert(err && /No hay token/.test(err.message), 'lanza "No hay token"', err?.message);
  assert(fake.calls.length === 0, 'no hace ningún request');
}

// ── Test 2: repo_info ─────────────────────────────────────────────────────────

async function testRepoInfo() {
  console.log(C.bold('\n── Test 2: repo_info con token ──────────────────────────────────'));
  const fake = makeFetch({
    'GET https://api.github.com/repos/octo/repo': { body: {
      owner: { login: 'octo' }, name: 'repo', full_name: 'octo/repo',
      description: 'desc', html_url: 'https://github.com/octo/repo',
      default_branch: 'main', private: false, language: 'JavaScript',
      stargazers_count: 42, forks_count: 3, open_issues_count: 5,
      license: { spdx_id: 'MIT' }, updated_at: '2026-01-01T00:00:00Z',
    } },
  });
  const gm = new GitHubManager({ fetch: fake, token: 'ghp_test' });
  const info = await gm.repoInfo('octo/repo');
  assert(info.fullName === 'octo/repo', 'fullName parseado');
  assert(info.defaultBranch === 'main', 'defaultBranch');
  assert(info.stars === 42, 'stars');
  assert(info.license === 'MIT', 'license spdx');
  assert(fake.calls[0].auth === 'Bearer ghp_test', 'manda Authorization Bearer');
}

// ── Test 3: issues list/create/comment/close ─────────────────────────────────

async function testIssues() {
  console.log(C.bold('\n── Test 3: issues ───────────────────────────────────────────────'));
  const fake = makeFetch({
    'GET https://api.github.com/repos/o/r/issues?state=open&per_page=10': { body: [
      { number: 1, title: 'Bug A', state: 'open', user: { login: 'alice' }, labels: [{ name: 'bug' }], comments: 2, created_at: '2026-01-01T00:00:00Z', html_url: 'https://github.com/o/r/issues/1' },
    ] },
    'POST https://api.github.com/repos/o/r/issues': { status: 201, body: { number: 2, title: 'Nuevo', html_url: 'https://github.com/o/r/issues/2', state: 'open' } },
    'POST https://api.github.com/repos/o/r/issues/2/comments': { status: 201, body: { id: 99, html_url: 'https://github.com/o/r/issues/2#issuecomment-99' } },
    'PATCH https://api.github.com/repos/o/r/issues/2': { body: { number: 2, state: 'closed', title: 'Nuevo' } },
  });
  const gm = new GitHubManager({ fetch: fake, token: 't' });

  const list = await gm.issueList('o/r', { state: 'open', limit: 10 });
  assert(list.total === 1 && list.issues[0].number === 1 && list.issues[0].labels.includes('bug'), 'issueList parseado');

  const created = await gm.issueCreate('o/r', { title: 'Nuevo', body: 'cuerpo', labels: ['bug', 'x'] });
  assert(created.number === 2 && created.created, 'issueCreate');
  const postBody = fake.calls.find(c => c.method === 'POST' && c.url.endsWith('/issues')).body;
  assert(postBody.title === 'Nuevo' && postBody.labels.length === 2, 'payload issueCreate', JSON.stringify(postBody));

  const commented = await gm.issueComment('o/r', { issue_number: 2, body: 'mi comentario' });
  assert(commented.commented && commented.id === 99, 'issueComment');

  const closed = await gm.issueClose('o/r', { issue_number: 2 });
  assert(closed.closed && closed.state === 'closed', 'issueClose');
}

// ── Test 4: pull requests list/create/review ─────────────────────────────────

async function testPRs() {
  console.log(C.bold('\n── Test 4: pull requests ────────────────────────────────────────'));
  const fake = makeFetch({
    'GET https://api.github.com/repos/o/r/pulls?state=open&per_page=10': { body: [
      { number: 11, title: 'PR One', state: 'open', user: { login: 'bob' }, head: { ref: 'feat' }, base: { ref: 'main' }, mergeable: true, comments: 1, created_at: '2026-01-01T00:00:00Z', html_url: 'https://github.com/o/r/pull/11' },
    ] },
    'POST https://api.github.com/repos/o/r/pulls': { status: 201, body: { number: 12, title: 'Mi PR', html_url: 'https://github.com/o/r/pull/12', state: 'open', head: { ref: 'feat-x' }, base: { ref: 'main' } } },
    'POST https://api.github.com/repos/o/r/pulls/12/reviews': { status: 201, body: { id: 555, state: 'APPROVED', html_url: 'https://github.com/o/r/pull/12#pullrequestreview-555' } },
  });
  const gm = new GitHubManager({ fetch: fake, token: 't' });

  const list = await gm.prList('o/r', { state: 'open' });
  assert(list.total === 1 && list.pullRequests[0].head === 'feat', 'prList');

  const pr = await gm.prCreate('o/r', { title: 'Mi PR', head: 'feat-x', base: 'main', body: 'desc' });
  assert(pr.created && pr.number === 12, 'prCreate');

  const rev = await gm.prReview('o/r', { pull_number: 12, event: 'APPROVE', body: 'LGTM' });
  assert(rev.reviewed && rev.state === 'APPROVED', 'prReview');

  const revBody = fake.calls.find(c => c.method === 'POST' && c.url.endsWith('/reviews')).body;
  assert(revBody.event === 'APPROVE' && revBody.body === 'LGTM', 'payload review', JSON.stringify(revBody));
}

// ── Test 5: actions_status ────────────────────────────────────────────────────

async function testActions() {
  console.log(C.bold('\n── Test 5: actions_status ───────────────────────────────────────'));
  const fake = makeFetch({
    'GET https://api.github.com/repos/o/r/actions/runs?per_page=5': { body: {
      workflow_runs: [
        { id: 1, name: 'CI', head_branch: 'main', status: 'completed', conclusion: 'success', created_at: '2026-01-01T00:00:00Z', html_url: 'https://github.com/o/r/actions/runs/1' },
      ],
    } },
  });
  const gm = new GitHubManager({ fetch: fake, token: 't' });
  const res = await gm.actionsStatus('o/r', { limit: 5 });
  assert(res.total === 1 && res.runs[0].conclusion === 'success', 'actionsStatus');
}

// ── Test 6: errores HTTP ──────────────────────────────────────────────────────

async function testErrors() {
  console.log(C.bold('\n── Test 6: errores HTTP mapeados ────────────────────────────────'));
  const fake = makeFetch({
    'GET https://api.github.com/repos/o/r': { status: 401, body: { message: 'Bad credentials' } },
    'GET https://api.github.com/repos/o/missing': { status: 404, body: { message: 'Not Found' } },
  });
  const gm = new GitHubManager({ fetch: fake, token: 't' });
  let err = null;
  try { await gm.repoInfo('o/r'); } catch (e) { err = e; }
  assert(err && err.status === 401 && /Token inválido/.test(err.message), '401 → mensaje claro', err?.message);
  err = null;
  try { await gm.repoInfo('o/missing'); } catch (e) { err = e; }
  assert(err && err.status === 404, '404 → Recurso no encontrado', err?.message);
}

// ── Test 7: validación de repos/params ────────────────────────────────────────

async function testValidation() {
  console.log(C.bold('\n── Test 7: params inválidos rechazados ───────────────────────────'));
  const fake = makeFetch({});
  const gm = new GitHubManager({ fetch: fake, token: 't' });

  let threw = false;
  try { await gm.repoInfo('solo-un-param'); } catch (e) { threw = /owner\/repo/.test(e.message); }
  assert(threw, 'repo sin "/" rechazado');

  threw = false;
  try { await gm.prReview('o/r', { pull_number: 5, event: 'LGTM', body: 'x' }); } catch (e) { threw = /event inválido/.test(e.message); }
  assert(threw, 'review event inválido rechazado');

  threw = false;
  try { await gm.issueCreate('o/r', {}); } catch (e) { threw = /título/.test(e.message); }
  assert(threw, 'issue sin título rechazado');
  assert(fake.calls.length === 0, 'ningún request llegó a la red');
}

// ── Test 8: whoami y GITHUB_TOKEN_KEY ─────────────────────────────────────────

async function testWhoami() {
  console.log(C.bold('\n── Test 8: whoami y clave de keychain ───────────────────────────'));
  assert(GITHUB_TOKEN_KEY === 'github_token', 'clave keychain = github_token');
  const fake = makeFetch({
    'GET https://api.github.com/user': { body: { login: 'panfilo', name: 'Panfilo', public_repos: 3, html_url: 'https://github.com/panfilo' } },
  });
  const gm = new GitHubManager({ fetch: fake, token: 't' });
  const me = await gm.whoami();
  assert(me.login === 'panfilo' && me.publicRepos === 3, 'whoami parseado');
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
  console.log(C.bold(C.cyan('  Test Suite: §10 — GitHubManager (cliente REST nativo) ')));
  console.log(C.bold(C.cyan('════════════════════════════════════════════════════════')));

  await testNoToken();
  await testRepoInfo();
  await testIssues();
  await testPRs();
  await testActions();
  await testErrors();
  await testValidation();
  await testWhoami();

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
  process.exit(1);
});
