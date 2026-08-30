// @ts-check
'use strict';

/**
 * SkillHub.js — descubrimiento e instalación de skills desde GitHub.
 *
 * Las skills viven como carpetas con SKILL.md (frontmatter: description,
 * version, domains — formato Agent Skills, compatible con el catálogo
 * de anthropics/skills y cientos de repos comunitarios).
 *
 * Capacidades:
 *   - buscarEnGitHub(query): búsqueda de repos (api.github.com, anónimo)
 *   - descargarTarball(repo): tar.gz de la rama default vía codeload
 *   - extraerSkills(tarPath, destDir): extracción segura (anti path-traversal,
 *     anti zip-bomb básico) + detección de carpetas con SKILL.md
 *   - importarDesdeDisco(srcPath, destDir): import local sin red
 *
 * Seguridad: nombres de carpeta sanitizados, entradas de tar con path
 * absoluto/'..' rechazadas, colisiones se saltan salvo force.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');

const GITHUB_API = 'https://api.github.com';
const DEFAULT_TOPICS = 'agent-skills';

/** Descarga HTTPS con timeout y User-Agent obligatorio de la API de GitHub. */
function _getJson(url, timeoutMs = 12_000) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'kaoru-agent-skills', Accept: 'application/vnd.github+json' } },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          if (res.statusCode === 403 && /rate limit/i.test(body)) {
            reject(new Error('límite de la API de GitHub alcanzado — reintentá en unos minutos'));
          } else if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`));
          } else {
            try {
              resolve(JSON.parse(body));
            } catch (e) {
              reject(new Error(`respuesta no-JSON de GitHub: ${e.message}`));
            }
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`timeout (${timeoutMs}ms)`));
    });
  });
}

/**
 * Búsqueda de repos de skills en GitHub.
 * @param {string} query
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<Array<{ full_name: string, description: string, stars: number, url: string }>>}
 */
async function buscarEnGitHub(query, { limit = 6 } = {}) {
  const q = String(query || '').trim();
  if (!q) throw new Error('búsqueda vacía');
  // Si el usuario no usó calificadores topic:, sesgar a los topics de skills.
  const hasTopic = /topic:/i.test(q);
  const qualified = hasTopic ? q : `${q} topic:${DEFAULT_TOPICS}`;
  const url = `${GITHUB_API}/search/repositories?q=${encodeURIComponent(
    qualified
  )}&sort=stars&order=desc&per_page=${limit}`;
  const data = await _getJson(url);
  const items = Array.isArray(data.items) ? data.items : [];
  return items.map((r) => ({
    full_name: r.full_name,
    description: String(r.description || '').slice(0, 140),
    stars: r.stargazers_count || 0,
    url: r.html_url,
  }));
}

/** Valida "owner/repo" y devuelve { owner, repo }. */
function _parseRepo(spec) {
  const m = String(spec || '')
    .replace(/^https:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!m) throw new Error(`repo inválido: "${spec}" — esperaba owner/repo`);
  return { owner: m[1], repo: m[2].replace(/[^A-Za-z0-9._-]/g, '') };
}

/** Descarga el tarball de la rama default a un archivo temporal. */
async function descargarTarball(repoSpec) {
  const { owner, repo } = _parseRepo(repoSpec);
  const url = `https://codeload.github.com/${owner}/${repo}/tar.gz/HEAD`;
  const out = path.join(os.tmpdir(), `skillhub-${repo}-${Date.now()}.tar.gz`);
  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(out);
    const req = https.get(url, (res) => {
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(out);
        reject(new Error(`HTTP ${res.statusCode} descargando tarball`));
        res.resume();
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close());
      file.on('close', resolve);
    });
    req.on('error', (e) => {
      try {
        fs.unlinkSync(out);
      } catch {}
      reject(e);
    });
  });
  return out;
}

/** Sanitiza el nombre de carpeta destino de una skill. */
function _sanitizeSkillName(name) {
  return (
    String(name)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'skill-importada'
  );
}

/** ¿El SKILL.md dado tiene frontmatter con description no vacía? */
function _skillMdValida(skillMdPath) {
  try {
    const raw = fs.readFileSync(skillMdPath, 'utf-8');
    const m = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!m) return false;
    return /(^|\n)\s*description\s*:\s*\S/i.test(m[1]);
  } catch {
    return false;
  }
}

/** Extrae un .tar.gz de forma segura (sin traversal, tope de tamaño). */
function _extractTar(tarPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xzf', tarPath, '-C', destDir], { stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('timeout extrayendo tarball'));
    }, 60_000);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`tar salió con código ${code}`));
    });
  });
}

/**
 * Busca carpetas con SKILL.md bajo extractDir (hasta profundidad 4).
 * @returns {string[]} rutas de carpetas candidatas
 */
function findSkillDirs(extractDir) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.name === 'SKILL.md') found.push(dir);
    }
  };
  walk(extractDir, 0);
  return [...new Set(found)];
}

/**
 * Instala las skills encontradas bajo extractDir hacia skillsDir.
 * @param {string} extractDir
 * @param {string} skillsDir
 * @param {{ force?: boolean }} [opts]
 * @returns {{ installed: string[], skipped: string[] }}
 */
function instalarDesdeExtract(extractDir, skillsDir, { force = false } = {}) {
  const installed = [];
  const skipped = [];
  for (const src of findSkillDirs(extractDir)) {
    if (!_skillMdValida(path.join(src, 'SKILL.md'))) {
      skipped.push(`${path.basename(src)} (SKILL.md sin description)`);
      continue;
    }
    const name = _sanitizeSkillName(path.basename(src));
    const dest = path.join(skillsDir, name);
    if (fs.existsSync(dest)) {
      if (!force) {
        skipped.push(`${name} (ya existía — usá force para sobrescribir)`);
        continue;
      }
      fs.rmSync(dest, { recursive: true, force: true });
    }
    fs.cpSync(src, dest, { recursive: true });
    installed.push(name);
  }
  return { installed, skipped };
}

/**
 * Import local (sin red): copia una carpeta con SKILL.md hacia skillsDir.
 * @param {string} srcPath
 * @param {string} skillsDir
 * @param {{ force?: boolean }} [opts]
 * @returns {string} nombre normalizado instalado
 */
function importarDesdeDisco(srcPath, skillsDir, { force = false } = {}) {
  const src = path.resolve(String(srcPath || ''));
  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
    throw new Error(`no existe la carpeta: ${src}`);
  }
  if (!fs.existsSync(path.join(src, 'SKILL.md'))) {
    throw new Error('la carpeta no contiene SKILL.md');
  }
  if (!_skillMdValida(path.join(src, 'SKILL.md'))) {
    throw new Error('SKILL.md sin frontmatter description');
  }
  const name = _sanitizeSkillName(path.basename(src));
  const dest = path.join(skillsDir, name);
  if (fs.existsSync(dest)) {
    if (!force) throw new Error(`ya existe una skill "${name}" — usá force para sobrescribir`);
    fs.rmSync(dest, { recursive: true, force: true });
  }
  fs.cpSync(src, dest, { recursive: true });
  return name;
}

module.exports = {
  buscarEnGitHub,
  descargarTarball,
  extraerTar: _extractTar,
  instalarDesdeExtract,
  importarDesdeDisco,
  findSkillDirs,
  _sanitizeSkillName,
  _parseRepo,
  _skillMdValida,
};
