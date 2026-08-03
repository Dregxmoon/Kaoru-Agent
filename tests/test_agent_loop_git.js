'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

const C = {
  green:  (s) => `\x1b[32m${s}\x1b[0m`,
  red:    (s) => `\x1b[31m${s}\x1b[0m`,
  cyan:   (s) => `\x1b[36m${s}\x1b[0m`,
  bold:   (s) => `\x1b[1m${s}\x1b[0m`,
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Mocks ─────────────────────────────────────────────────────────────────────

function createTrackingBridge() {
  const calls = [];
  return {
    calls,
    execute: async (tool, params) => {
      calls.push(tool);
      return { ok: true, result: `[bridge] ${tool}`, error: null, tool, elapsed: 0 };
    },
  };
}

function createMockGit(overrides = {}) {
  const calls = [];
  return {
    calls,
    status: async (cwd) => { calls.push(['status', cwd]); return { branch: 'main', clean: true }; },
    diff: async (cwd, o) => { calls.push(['diff', cwd, o]); return { patch: '--- a/x\n+++ b/x' }; },
    log: async (cwd, o) => { calls.push(['log', cwd, o]); return { total: 1, commits: [{ hash: 'abc1234', subject: 'x' }] }; },
    branch: async (cwd) => { calls.push(['branch', cwd]); return { current: 'main', branches: [] }; },
    commit: async (cwd, o) => { calls.push(['commit', cwd, o]); return { committed: true, hash: 'abc1234' }; },
    stash: async (cwd, o) => { calls.push(['stash', cwd, o]); return { ok: true, stashes: [] }; },
    merge: async (cwd, o) => { calls.push(['merge', cwd, o]); return { merged: true }; },
    rebase: async (cwd, o) => { calls.push(['rebase', cwd, o]); return { rebased: true }; },
    ...overrides,
  };
}

function createMockGitHub(overrides = {}) {
  const calls = [];
  return {
    calls,
    hasToken: true,
    repoInfo: async (repo) => { calls.push(['repoInfo', repo]); return { fullName: repo }; },
    issueList: async (repo, o) => { calls.push(['issueList', repo, o]); return { total: 0, issues: [] }; },
    issueCreate: async (repo, o) => { calls.push(['issueCreate', repo, o]); return { created: true, number: 1 }; },
    issueComment: async (repo, o) => { calls.push(['issueComment', repo, o]); return { commented: true }; },
    issueClose: async (repo, o) => { calls.push(['issueClose', repo, o]); return { closed: true }; },
    prList: async (repo, o) => { calls.push(['prList', repo, o]); return { total: 0, pullRequests: [] }; },
    prCreate: async (repo, o) => { calls.push(['prCreate', repo, o]); return { created: true, number: 2 }; },
    prReview: async (repo, o) => { calls.push(['prReview', repo, o]); return { reviewed: true }; },
    actionsStatus: async (repo, o) => { calls.push(['actionsStatus', repo, o]); return { total: 0, runs: [] }; },
    ...overrides,
  };
}

function stubCompleteWithTools(toolCalls, finalContent = 'Listo.') {
  const LLMProvider = require('../core/llm/LLMProvider.js');
  const original = LLMProvider.completeWithTools;
  let i = 0;
  LLMProvider.completeWithTools = async () => {
    if (i < toolCalls.length) {
      const tc = toolCalls[i];
      i++;
      return { content: null, toolCalls: [tc] };
    }
    return { content: finalContent, toolCalls: null };
  };
  return { restore: () => { LLMProvider.completeWithTools = original; } };
}

// ── Test 1: tool git se despacha al GitManager, no al bridge ─────────────────

async function testGitDispatch() {
  console.log(C.bold('\n── Test 1: tools git se ejecutan en el GitManager ───────────────'));
  const bridge = createTrackingBridge();
  const git = createMockGit();
  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const stub = stubCompleteWithTools([{ tool: 'git_status', params: { cwd: '/tmp/x' } }]);
  try {
    const loop = new AgentLoop({ bridge, git, maxIterations: 3 });
    const out = await loop.run('¿qué cambió en el repo?', 'Sistema', [], {
      tools: [{ name: 'git_status', inputSchema: {} }],
    });
    assert(out.toolResults.length === 1, 'hubo un resultado de tool');
    assert(out.toolResults[0].ok === true, 'resultado ok');
    assert(out.toolResults[0].result.branch === 'main', 'resultado estructurado del git');
    assert(git.calls.some(([tool]) => tool === 'status'), 'GitManager.status fue llamado');
    assert(bridge.calls.length === 0, 'el bridge NO fue llamado para git');
  } finally {
    stub.restore();
  }
}

// ── Test 2: git_commit pasa por GitManager y marca aprobación ────────────────

async function testGitCommitApproval() {
  console.log(C.bold('\n── Test 2: git_commit = mutador que pide aprobación ─────────────'));
  const bridge = createTrackingBridge();
  const git = createMockGit();
  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const approvals = [];
  const stub = stubCompleteWithTools([{ tool: 'git_commit', params: { message: 'feat: x' } }]);
  try {
    const loop = new AgentLoop({ bridge, git, maxIterations: 3 });
    const out = await loop.run('commitear el cambio', 'Sistema', [], {
      tools: [{ name: 'git_commit', inputSchema: {} }],
      onApprovalNeeded: async (action) => { approvals.push(action.tool); return true; },
    });
    assert(approvals.length === 1 && approvals[0] === 'git_commit', 'pidió aprobación para git_commit');
    assert(out.toolResults[0].ok === true, 'ejecutó tras aprobar');
    assert(git.calls.some(([tool]) => tool === 'commit'), 'GitManager.commit llamado');
  } finally {
    stub.restore();
  }
}

// ── Test 3: git_status NO requiere aprobación ─────────────────────────────────

async function testGitStatusNoApproval() {
  console.log(C.bold('\n── Test 3: git_status = lectura sin aprobación ───────────────────'));
  const AP = require('../core/planner/ActionParser.js');
  assert(AP.isHighImpact('git_status', {}) === false, 'git_status no es high impact');
  assert(AP.isHighImpact('git_diff', {}) === false, 'git_diff no es high impact');
  assert(AP.isHighImpact('git_log', {}) === false, 'git_log no es high impact');
  assert(AP.isHighImpact('git_branch', {}) === false, 'git_branch no es high impact');
  assert(AP.isHighImpact('git_stash', { action: 'list' }) === false, 'stash list no es high impact');
  assert(AP.isHighImpact('git_commit', {}) === true, 'git_commit es high impact');
  assert(AP.isHighImpact('git_stash', { action: 'push' }) === true, 'stash push es high impact');
  assert(AP.isHighImpact('git_merge', {}) === true, 'git_merge es high impact');
  assert(AP.isHighImpact('git_rebase', {}) === true, 'git_rebase es high impact');
}

// ── Test 4: tool github se despacha al GitHubManager ─────────────────────────

async function testGitHubDispatch() {
  console.log(C.bold('\n── Test 4: tools github se ejecutan en el GitHubManager ─────────'));
  const bridge = createTrackingBridge();
  const github = createMockGitHub();
  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const stub = stubCompleteWithTools([{ tool: 'github_repo_info', params: { repo: 'octo/repo' } }]);
  try {
    const loop = new AgentLoop({ bridge, github, maxIterations: 3 });
    const out = await loop.run('dame info del repo', 'Sistema', [], {
      tools: [{ name: 'github_repo_info', inputSchema: {} }],
    });
    assert(out.toolResults[0].ok === true, 'resultado ok');
    assert(out.toolResults[0].result.fullName === 'octo/repo', 'resultado del github');
    assert(github.calls.some(([tool]) => tool === 'repoInfo'), 'GitHubManager.repoInfo llamado');
    assert(bridge.calls.length === 0, 'el bridge NO fue llamado para github');
  } finally {
    stub.restore();
  }
}

// ── Test 5: github sin token → error claro ───────────────────────────────────

async function testGitHubNoToken() {
  console.log(C.bold('\n── Test 5: github sin token devuelve error accionable ───────────'));
  const bridge = createTrackingBridge();
  const github = createMockGitHub({ hasToken: false });
  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const stub = stubCompleteWithTools([{ tool: 'github_repo_info', params: { repo: 'octo/repo' } }]);
  try {
    const loop = new AgentLoop({ bridge, github, maxIterations: 3 });
    const out = await loop.run('info del repo', 'Sistema', [], {
      tools: [{ name: 'github_repo_info', inputSchema: {} }],
    });
    assert(out.toolResults[0].ok === false, 'resultado fallido');
    assert(/No hay token/.test(out.toolResults[0].error), 'error menciona el token', out.toolResults[0].error);
  } finally {
    stub.restore();
  }
}

// ── Test 6: isHighImpact para github mutadores ───────────────────────────────

async function testGitHubApproval() {
  console.log(C.bold('\n── Test 6: isHighImpact de tools github ─────────────────────────'));
  const AP = require('../core/planner/ActionParser.js');
  assert(AP.isHighImpact('github_repo_info', {}) === false, 'repo_info lectura');
  assert(AP.isHighImpact('github_issue_list', {}) === false, 'issue_list lectura');
  assert(AP.isHighImpact('github_pr_list', {}) === false, 'pr_list lectura');
  assert(AP.isHighImpact('github_actions_status', {}) === false, 'actions_status lectura');
  assert(AP.isHighImpact('github_issue_create', {}) === true, 'issue_create mutador');
  assert(AP.isHighImpact('github_issue_comment', {}) === true, 'issue_comment mutador');
  assert(AP.isHighImpact('github_issue_close', {}) === true, 'issue_close mutador');
  assert(AP.isHighImpact('github_pr_create', {}) === true, 'pr_create mutador');
  assert(AP.isHighImpact('github_pr_review', {}) === true, 'pr_review mutador');
}

// ── Test 7: ToolRegistry expone git/github en catálogo y prompt ──────────────

async function testRegistry() {
  console.log(C.bold('\n── Test 7: ToolRegistry incluye git y github ────────────────────'));
  const { getToolRegistry } = require('../core/task/ToolRegistry.js');
  const reg = getToolRegistry();

  const gitTools = reg._getGitTools();
  const githubTools = reg._getGitHubTools();
  assert(gitTools.length === 8, '8 tools git', `git: ${gitTools.length}`);
  assert(githubTools.length === 9, '9 tools github', `github: ${githubTools.length}`);

  const cat = reg.getCatalog();
  assert(cat.bySource.git === 8 && cat.bySource.github === 9, 'getCatalog bySource');

  const gitCommit = reg.getToolById('git.git_commit');
  assert(gitCommit && gitCommit.highImpact === true, 'git_commit marcado highImpact en catálogo');
  const prCreate = reg.getToolById('github.github_pr_create');
  assert(prCreate && prCreate.highImpact === true, 'pr_create marcado highImpact en catálogo');

  const prompt = reg.serializeToPrompt();
  assert(prompt.includes('git_status'), 'prompt incluye git_status');
  assert(prompt.includes('github_repo_info'), 'prompt incluye github_repo_info');
  assert(prompt.includes('(requiere aprobación)'), 'prompt avisa aprobación');
}

// ── Test 8: ToolResolver incluye schemas nativos de git/github ───────────────

async function testResolver() {
  console.log(C.bold('\n── Test 8: ToolResolver incluye schemas nativos git/github ──────'));
  const { getToolRegistry } = require('../core/task/ToolRegistry.js');
  const { resolveToolset } = require('../core/task/ToolResolver.js');
  const res = await resolveToolset({ userMessage: 'usa git', toolRegistry: getToolRegistry() });

  const names = (res.nativeToolSchemas || []).map(s => s.name);
  assert(names.includes('git_status'), 'native schemas incluyen git_status', names.join(', '));
  assert(names.includes('git_commit'), 'native schemas incluyen git_commit');
  assert(names.includes('github_repo_info'), 'native schemas incluyen github_repo_info');
  assert(names.includes('github_pr_create'), 'native schemas incluyen github_pr_create');
  assert(res.promptCatalog.includes('Herramientas Git'), 'prompt catalog tiene sección Git');
  assert(res.promptCatalog.includes('Herramientas GitHub'), 'prompt catalog tiene sección GitHub');
}

// ── Test 9: ToolSchemas expone los nombres para tool-calling ────────────────

async function testToolSchemas() {
  console.log(C.bold('\n── Test 9: ToolSchemas.js expone git/github ──────────────────────'));
  const { getToolSchemas } = require('../core/llm/ToolSchemas.js');
  const names = getToolSchemas().map(s => s.name);
  assert(names.includes('git_status') && names.includes('git_merge'), 'schemas git');
  assert(names.includes('github_repo_info') && names.includes('github_pr_review'), 'schemas github');
  const commit = getToolSchemas().find(s => s.name === 'git_commit');
  assert(commit && commit.inputSchema.required.includes('message'), 'git_commit exige message');
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
  console.log(C.bold(C.cyan('  Test Suite: §10 — integración AgentLoop + Git/GitHub ')));
  console.log(C.bold(C.cyan('════════════════════════════════════════════════════════')));

  await testGitDispatch();
  await testGitCommitApproval();
  await testGitStatusNoApproval();
  await testGitHubDispatch();
  await testGitHubNoToken();
  await testGitHubApproval();
  await testRegistry();
  await testResolver();
  await testToolSchemas();

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
