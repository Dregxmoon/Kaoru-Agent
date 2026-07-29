'use strict';

const path = require('path');
const fs = require('fs');

const MAX_FILE_SIZE = 100 * 1024;
const MAX_FILES = 10;
const MAX_DEPTH = 4;

function resolveFileReferences(text, projectCwd) {
  const refs = [];
  const re = /@([\w./\\-]+(?:\.[\w]+)?)/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const ref = match[1];
    const filePath = path.resolve(projectCwd, ref);
    refs.push({ ref, filePath, index: match.index });
  }
  return refs;
}

function readFileContent(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_FILE_SIZE) return `[Archivo demasiado grande: ${(stat.size / 1024).toFixed(0)} KB, máximo ${MAX_FILE_SIZE / 1024} KB]`;
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function buildFileContext(text, projectCwd) {
  const refs = resolveFileReferences(text, projectCwd);
  if (refs.length === 0) return { text, contexts: [] };

  const contexts = [];
  const resolved = [];

  for (const { ref, filePath } of refs) {
    if (resolved.includes(filePath)) continue;
    resolved.push(filePath);

    const content = readFileContent(filePath);
    contexts.push({
      ref,
      path: ref,
      fullPath: filePath,
      content: content || '[Archivo no encontrado]',
      truncated: content === null,
    });

    if (contexts.length >= MAX_FILES) break;
  }

  return { text, contexts };
}

function listProjectFiles(projectCwd, pattern = '') {
  const results = [];
  const query = pattern.toLowerCase();

  function walk(dir, depth) {
    if (depth > MAX_DEPTH) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(projectCwd, fullPath);

      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '.git') continue;

      if (entry.isDirectory()) {
        if (query === '' || relPath.toLowerCase().includes(query)) {
          results.push({ path: relPath, type: 'directory', name: entry.name });
        }
        walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        const stat = fs.statSync(fullPath);
        const isText = /\.(js|ts|jsx|tsx|json|md|css|html|yml|yaml|toml|env|txt|py|rb|go|rs|c|cpp|h|hpp|java|kt|swift|vue|svelte|xml|svg|sh|bash|zsh|fish|ps1|bat|cfg|ini|conf|lock)$/i.test(entry.name);
        if (!isText && !query) continue;
        if (query === '' || relPath.toLowerCase().includes(query)) {
          results.push({ path: relPath, type: 'file', name: entry.name, size: stat.size });
        }
      }
    }
  }

  walk(projectCwd, 0);
  return results;
}

module.exports = { resolveFileReferences, readFileContent, buildFileContext, listProjectFiles };
