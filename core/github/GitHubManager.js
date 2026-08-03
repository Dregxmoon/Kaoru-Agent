'use strict';

// GitHubManager.js — Cliente REST nativo de GitHub.
//
// Tool propia (no exec crudo): repo_info, issues (list/create/comment/close),
// pull requests (list/create/review) y actions_status. Control total del
// formato de respuesta; las respuestas mutadoras pasan por aprobación
// (ActionParser.isHighImpact).
//
// Credencial: PAT que entra como provider del KeychainManager (key
// "github_token"). Para permitir un futuro OAuth device-flow sin tocar las
// tools, la resolución de token está aislada en _resolveToken() — ahí se
// engancharía el flujo OAuth.
//
// El transport de red es inyectable (this._fetch) para poder testear sin
// hacer llamadas reales a api.github.com.

const KeychainManager = require('../../infrastructure/keychain/KeychainManager.js');

const { getRendererFetch } = require('./net.js');

const API_BASE = 'https://api.github.com';
const GITHUB_TOKEN_KEY = 'github_token';
const MAX_LIST = 30;

const SAFE_REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const SAFE_REVIEW_EVENTS = new Set(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']);
const SAFE_ISSUE_STATE = new Set(['open', 'closed', 'all']);
const SAFE_PR_STATE = new Set(['open', 'closed', 'all']);
const VALID_LABEL_RE = /^[A-Za-z0-9_\-.\s]{1,50}$/;

function _validRepo(repo) {
  return typeof repo === 'string' && SAFE_REPO_RE.test(repo) && !repo.startsWith('-');
}

function _stripMarkdown(text) {
  // Reduce ruido en el resumen para el LLM: se devuelve el body crudo al LLM,
  // pero el manager normaliza longitud.
  return String(text || '');
}

function _httpError(status, body) {
  // Para estados conocidos preferimos un mensaje accionable propio; para el
  // resto, el mensaje que devuelva la API de GitHub.
  const apiMsg = body && (body.message || body.error);
  const known = {
    401: 'Token inválido o sin permisos. Verificá el PAT y su alcance.',
    403: 'Límite de API de GitHub alcanzado.',
    404: 'Recurso no encontrado.',
  };
  const msg = known[status] || apiMsg || `HTTP ${status}`;
  const err = new Error(msg);
  err.status = status;
  return err;
}

class GitHubManager {
  constructor(opts = {}) {
    this._token = opts.token || null;
    // Resolver de token inyectable (tests herméticos); por defecto memoria → llavero → env.
    this._resolveToken = opts.resolveToken || this._defaultResolveToken;
    const f = opts.fetch || getRendererFetch() || globalThis.fetch || null;
    if (typeof f !== 'function') {
      throw new Error('GitHubManager necesita fetch (Node 18+/Electron 28+).');
    }
    // En el renderer, window.fetch exige this === window; si lo guardamos
    // desligado y lo llamamos como this._fetch(...) → "Illegal invocation".
    // Forzamos el receptor correcto en ambos entornos (Node ignora el `this`).
    this._fetch = (url, init) => f.call(globalThis, url, init);
  }

  configure(opts = {}) {
    // `token: undefined` no toca nada; `token: null` limpia el token en
    // memoria (logout) para que la resolución caiga de nuevo a keychain/env.
    if (opts.token !== undefined) this._token = opts.token;
  }

  async _defaultResolveToken() {
    if (this._token) return this._token;
    try {
      const fromKeychain = KeychainManager.getKey(GITHUB_TOKEN_KEY);
      if (fromKeychain) return fromKeychain;
    } catch {
      /* keychain no disponible */
    }
    if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
    return null;
  }

  get hasToken() {
    return this._resolveToken().then(Boolean).catch(() => false);
  }

  async _request(method, apiPath, body, expectedStatuses = [200, 201]) {
    const token = await this._resolveToken();
    if (!token) {
      const err = new Error(
        'No hay token de GitHub configurado. Guardalo con KeychainManager.setKey("github_token", "<PAT>").'
      );
      err.status = 401;
      throw err;
    }
    const res = await this._fetch(`${API_BASE}${apiPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Asistente-Vtuber',
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!expectedStatuses.includes(res.status)) {
      throw _httpError(res.status, data);
    }
    return data;
  }

  async whoami() {
    const data = await this._request('GET', '/user', null, [200]);
    return {
      login: data.login,
      name: data.name,
      publicRepos: data.public_repos,
      htmlUrl: data.html_url,
    };
  }

  // ── repo_info ────────────────────────────────────────────────────────────────
  async repoInfo(repo) {
    if (!_validRepo(repo)) throw new Error('repo_info requiere un repo en formato "owner/repo".');
    const d = await this._request('GET', `/repos/${repo}`, null, [200]);
    return {
      owner: d.owner?.login,
      name: d.name,
      fullName: d.full_name,
      description: d.description,
      htmlUrl: d.html_url,
      defaultBranch: d.default_branch,
      private: d.private,
      language: d.language,
      stars: d.stargazers_count,
      forks: d.forks_count,
      openIssues: d.open_issues_count,
      license: d.license?.spdx_id || null,
      updatedAt: d.updated_at,
    };
  }

  // ── issues ───────────────────────────────────────────────────────────────────
  async issueList(repo, opts = {}) {
    if (!_validRepo(repo)) throw new Error('issue_list requiere un repo en formato "owner/repo".');
    const state = SAFE_ISSUE_STATE.has(opts.state) ? opts.state : 'open';
    const perPage = Math.min(MAX_LIST, Math.max(1, parseInt(opts.limit, 10) || 10));
    const d = await this._request('GET', `/repos/${repo}/issues?state=${state}&per_page=${perPage}`, null, [200]);
    const issues = (Array.isArray(d) ? d : []).map(i => ({
      number: i.number,
      title: i.title,
      state: i.state,
      author: i.user?.login,
      labels: (i.labels || []).map(l => l.name),
      comments: i.comments,
      createdAt: i.created_at,
      htmlUrl: i.html_url,
    }));
    return { repo, state, total: issues.length, issues };
  }

  async issueCreate(repo, opts = {}) {
    if (!_validRepo(repo)) throw new Error('issue_create requiere un repo en formato "owner/repo".');
    const title = _stripMarkdown(opts.title).trim();
    if (!title) throw new Error('issue_create requiere un título (title).');
    const body = _stripMarkdown(opts.body).slice(0, 20000);
    const labels = (opts.labels || [])
      .filter(l => VALID_LABEL_RE.test(l))
      .slice(0, 10);
    const payload = { title, body };
    if (labels.length > 0) payload.labels = labels;
    const d = await this._request('POST', `/repos/${repo}/issues`, payload, [201]);
    return {
      created: true,
      number: d.number,
      title: d.title,
      htmlUrl: d.html_url,
      state: d.state,
    };
  }

  async issueComment(repo, opts = {}) {
    if (!_validRepo(repo)) throw new Error('issue_comment requiere un repo en formato "owner/repo".');
    const issueNumber = parseInt(opts.issue_number, 10);
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) throw new Error('issue_comment requiere issue_number válido.');
    const body = _stripMarkdown(opts.body).trim();
    if (!body) throw new Error('issue_comment requiere un cuerpo (body).');
    const d = await this._request('POST', `/repos/${repo}/issues/${issueNumber}/comments`, { body: body.slice(0, 20000) }, [201]);
    return { commented: true, issueNumber, id: d.id, htmlUrl: d.html_url };
  }

  async issueClose(repo, opts = {}) {
    if (!_validRepo(repo)) throw new Error('issue_close requiere un repo en formato "owner/repo".');
    const issueNumber = parseInt(opts.issue_number, 10);
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) throw new Error('issue_close requiere issue_number válido.');
    const d = await this._request('PATCH', `/repos/${repo}/issues/${issueNumber}`, { state: 'closed' }, [200]);
    return { closed: true, issueNumber, state: d.state, title: d.title };
  }

  // ── pull requests ────────────────────────────────────────────────────────────
  async prList(repo, opts = {}) {
    if (!_validRepo(repo)) throw new Error('pr_list requiere un repo en formato "owner/repo".');
    const state = SAFE_PR_STATE.has(opts.state) ? opts.state : 'open';
    const perPage = Math.min(MAX_LIST, Math.max(1, parseInt(opts.limit, 10) || 10));
    const d = await this._request('GET', `/repos/${repo}/pulls?state=${state}&per_page=${perPage}`, null, [200]);
    const prs = (Array.isArray(d) ? d : []).map(p => ({
      number: p.number,
      title: p.title,
      state: p.state,
      author: p.user?.login,
      head: p.head?.ref,
      base: p.base?.ref,
      mergeable: p.mergeable,
      comments: p.comments,
      createdAt: p.created_at,
      htmlUrl: p.html_url,
    }));
    return { repo, state, total: prs.length, pullRequests: prs };
  }

  async prCreate(repo, opts = {}) {
    if (!_validRepo(repo)) throw new Error('pr_create requiere un repo en formato "owner/repo".');
    const title = _stripMarkdown(opts.title).trim();
    const head = String(opts.head || '').trim();
    const base = String(opts.base || '').trim();
    if (!title) throw new Error('pr_create requiere un título (title).');
    if (!head) throw new Error('pr_create requiere la rama origen (head).');
    if (!base) throw new Error('pr_create requiere la rama destino (base).');
    const payload = {
      title,
      head,
      base,
      body: _stripMarkdown(opts.body).slice(0, 20000),
    };
    const d = await this._request('POST', `/repos/${repo}/pulls`, payload, [201]);
    return {
      created: true,
      number: d.number,
      title: d.title,
      htmlUrl: d.html_url,
      state: d.state,
      head: d.head?.ref,
      base: d.base?.ref,
    };
  }

  async prReview(repo, opts = {}) {
    if (!_validRepo(repo)) throw new Error('pr_review requiere un repo en formato "owner/repo".');
    const pullNumber = parseInt(opts.pull_number, 10);
    if (!Number.isInteger(pullNumber) || pullNumber <= 0) throw new Error('pr_review requiere pull_number válido.');
    const event = String(opts.event || 'COMMENT').toUpperCase();
    if (!SAFE_REVIEW_EVENTS.has(event)) {
      throw new Error(`pr_review event inválido: ${event}. Válidos: ${[...SAFE_REVIEW_EVENTS].join(', ')}.`);
    }
    const body = _stripMarkdown(opts.body).trim();
    if (!body) throw new Error('pr_review requiere un cuerpo (body).');
    const payload = { body: body.slice(0, 20000), event };
    const d = await this._request('POST', `/repos/${repo}/pulls/${pullNumber}/reviews`, payload, [201]);
    return { reviewed: true, pullNumber, state: d.state, id: d.id, htmlUrl: d.html_url };
  }

  // ── actions_status ───────────────────────────────────────────────────────────
  async actionsStatus(repo, opts = {}) {
    if (!_validRepo(repo)) throw new Error('actions_status requiere un repo en formato "owner/repo".');
    const perPage = Math.min(MAX_LIST, Math.max(1, parseInt(opts.limit, 10) || 10));
    const d = await this._request('GET', `/repos/${repo}/actions/runs?per_page=${perPage}`, null, [200]);
    const runs = (d.workflow_runs || []).map(r => ({
      id: r.id,
      name: r.name,
      headBranch: r.head_branch,
      status: r.status,
      conclusion: r.conclusion,
      createdAt: r.created_at,
      htmlUrl: r.html_url,
    }));
    return { repo, total: runs.length, runs };
  }
}

let _instance = null;
function getGitHubManager() {
  if (!_instance) _instance = new GitHubManager();
  return _instance;
}

module.exports = { GitHubManager, getGitHubManager, GITHUB_TOKEN_KEY };
