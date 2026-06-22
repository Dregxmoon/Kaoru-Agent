#!/usr/bin/env node
/**
 * audit-node-deps.js — detecta paquetes usados vía require() que no
 * aparecen declarados en package.json (dependencies + devDependencies).
 *
 * Uso (desde la raíz del repo):
 *   node audit-node-deps.js
 *
 * Limitación: no detecta require(variable) dinámico ni import ESM.
 * Este repo usa require() de CommonJS en todo lo que hemos visto, así
 * que cubre el caso real.
 */
const fs = require('fs');
const path = require('path');
const builtins = new Set(require('module').builtinModules);

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', '.git', 'build', 'dist', 'out']);

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.name.endsWith('.js')) files.push(full);
  }
  return files;
}

const requireRe = /require\(\s*['"]([^'".\/][^'"]*)['"]\s*\)/g;
const found = new Map(); // paquete -> [archivos donde aparece]

for (const file of walk(ROOT)) {
  let content;
  try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
  let m;
  while ((m = requireRe.exec(content))) {
    const raw = m[1];
    const pkgName = raw.startsWith('@')
      ? raw.split('/').slice(0, 2).join('/')
      : raw.split('/')[0];
    if (builtins.has(pkgName)) continue;
    if (!found.has(pkgName)) found.set(pkgName, new Set());
    found.get(pkgName).add(path.relative(ROOT, file));
  }
}

const pkgJsonPath = path.join(ROOT, 'package.json');
const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
const declared = new Set([
  ...Object.keys(pkgJson.dependencies || {}),
  ...Object.keys(pkgJson.devDependencies || {}),
]);

console.log('Paquetes externos usados en el código:', [...found.keys()].sort().join(', '));

const missing = [...found.keys()].filter(p => !declared.has(p));
if (missing.length) {
  console.log('\n⚠️  Usados en código pero NO declarados en package.json:');
  for (const p of missing) {
    console.log(`  - ${p}  (en: ${[...found.get(p)].join(', ')})`);
  }
} else {
  console.log('\n✔ Todo lo usado en el código está declarado en package.json.');
}