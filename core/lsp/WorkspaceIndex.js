'use strict';

const path = require('path');
const fs = require('fs');
const { LSPManager } = require('./LSPManager');

/**
 * WorkspaceIndex — G.3: índice estructural del workspace.
 *
 * Capa 1 (estructural): tipo de proyecto + convenciones detectadas vía los
 * manifiestos de G.1. No toca embeddings ni sqlite-vec; eso es la Capa 2
 * (semántica) que viene después.
 *
 * Uso:
 *   const idx = new WorkspaceIndex();
 *   const info = await idx.analyze('/path/to/project');
 *   // { languages: ['typescript','python'], packageManager: 'npm',
 *   //   hasTests: true, testRunner: 'jest', conventions: {...} }
 */

class WorkspaceIndex {
  constructor() {
    this._cache = new Map(); // wsPath → info
  }

  /**
   * Analiza un workspace y devuelve su perfil estructural.
   * Resultado cacheado ( TTL 5 min ).
   */
  async analyze(workspacePath) {
    const abs = path.resolve(workspacePath);
    const cached = this._cache.get(abs);
    if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.info;

    const has = (f) => { try { return fs.existsSync(path.join(abs, f)); } catch { return false; } };
    const readJSON = (f) => { try { return JSON.parse(fs.readFileSync(path.join(abs, f), 'utf-8')); } catch { return null; } };

    // ── Lenguajes (usa LSPManager.detectLanguagesForWorkspace) ──────────
    const languages = LSPManager.detectLanguagesForWorkspace(abs);

    // ── Package manager ─────────────────────────────────────────────────
    let packageManager = 'unknown';
    if (has('package-lock.json') || has('npm-shrinkwrap.json')) packageManager = 'npm';
    else if (has('yarn.lock')) packageManager = 'yarn';
    else if (has('pnpm-lock.yaml')) packageManager = 'pnpm';
    else if (has('bun.lockb')) packageManager = 'bun';
    else if (has('Cargo.toml')) packageManager = 'cargo';
    else if (has('go.mod')) packageManager = 'go';
    else if (has('Gemfile')) packageManager = 'bundler';
    else if (has('composer.json')) packageManager = 'composer';
    else if (has('pyproject.toml')) {
      const py = readJSON('pyproject.toml');
      if (py?.tool?.poetry || py?.project?.dependencies) packageManager = 'pip';
    }

    // ── Test runner ─────────────────────────────────────────────────────
    let testRunner = 'unknown';
    const pkg = readJSON('package.json');
    if (pkg) {
      const scripts = pkg.scripts || {};
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if (scripts.test?.includes('jest') || deps.jest) testRunner = 'jest';
      else if (scripts.test?.includes('vitest') || deps.vitest) testRunner = 'vitest';
      else if (scripts.test?.includes('mocha') || deps.mocha) testRunner = 'mocha';
      else if (scripts.test?.includes('ava') || deps.ava) testRunner = 'ava';
      else if (scripts.test) testRunner = 'npm-scripts';
    }
    const hasTests = testRunner !== 'unknown' || has('tests') || has('test') || has('__tests__');

    // ── Convenciones ────────────────────────────────────────────────────
    const conventions = {};

    // TypeScript config
    if (has('tsconfig.json')) {
      const tsconfig = readJSON('tsconfig.json');
      if (tsconfig?.compilerOptions) {
        conventions.strict = tsconfig.compilerOptions.strict ?? null;
        conventions.target = tsconfig.compilerOptions.target ?? null;
        conventions.moduleResolution = tsconfig.compilerOptions.moduleResolution ?? null;
        conventions.paths = tsconfig.compilerOptions.paths ? Object.keys(tsconfig.compilerOptions.paths) : [];
      }
    }

    // Python config
    if (has('pyproject.toml')) {
      const pyproject = readJSON('pyproject.toml');
      if (pyproject?.tool?.pyright) conventions.pyright = Object.keys(pyproject.tool.pyright);
      if (pyproject?.project?.python_requires) conventions.pythonVersion = pyproject.project.python_requires;
    }

    // Frameworks
    if (pkg) {
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if (deps.react || deps['react-dom']) conventions.framework = 'react';
      else if (deps.vue) conventions.framework = 'vue';
      else if (deps.svelte) conventions.framework = 'svelte';
      else if (deps.next) conventions.framework = 'next';
      else if (deps.nuxt) conventions.framework = 'nuxt';
      else if (deps.electron) conventions.framework = 'electron';
    }

    // ── Archivos de configuración relevantes ────────────────────────────
    const configFiles = [];
    for (const f of [
      'tsconfig.json', 'jsconfig.json', 'pyproject.toml', '.eslintrc.js',
      '.eslintrc.json', 'prettier.config.js', '.prettierrc', 'biome.json',
      '.editorconfig', '.gitignore', 'docker-compose.yml', 'Dockerfile',
    ]) {
      if (has(f)) configFiles.push(f);
    }

    const info = {
      path: abs,
      languages,
      packageManager,
      testRunner,
      hasTests,
      conventions,
      configFiles,
      analyzedAt: new Date().toISOString(),
    };

    this._cache.set(abs, { at: Date.now(), info });
    return info;
  }

  invalidate(workspacePath) {
    this._cache.delete(path.resolve(workspacePath));
  }

  getStats() {
    return { cacheSize: this._cache.size };
  }
}

module.exports = { WorkspaceIndex };
