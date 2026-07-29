'use strict';

const fs = require('fs');
const path = require('path');

const SKILL_TABLE = 'skill_catalog';
const VECTOR_TABLE = 'skill_vectors';
const DEFAULT_THRESHOLD = 0.72;
const DEFAULT_TOP_K = 3;
const VECTOR_DIMS = 384;
const SKILL_CATALOG = [];

let _embedder = null; // lazy singleton shared with IntentDetector
let _pipelineModule = null;

async function _getEmbedder() {
  if (_embedder) return _embedder;
  try {
    if (!_pipelineModule) {
      _pipelineModule = await import('@xenova/transformers');
    }
    const pipe = await _pipelineModule.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    _embedder = async (text) => {
      const output = await pipe(text, { pooling: 'mean', normalize: true });
      return output.data;
    };
  } catch (e) {
    throw new Error(`No se pudo cargar el embedder: ${e.message}`);
  }
  return _embedder;
}

function _parseFrontmatter(raw) {
  const lines = raw.split('\n');
  const meta = { description: '', version: '1.0.0', domains: [] };
  let inFrontmatter = false;
  let bodyStart = 0;

  if (lines[0] && lines[0].trim() === '---') {
    inFrontmatter = true;
    let foundClosing = false;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        bodyStart = i + 1;
        foundClosing = true;
        break;
      }
      const colonIdx = lines[i].indexOf(':');
      if (colonIdx === -1) continue;
      const key = lines[i].slice(0, colonIdx).trim().toLowerCase();
      let value = lines[i].slice(colonIdx + 1).trim();
      value = value.replace(/^["']|["']$/g, '');
      if (key === 'description') meta.description = value;
      else if (key === 'version') meta.version = value;
      else if (key === 'replaces_domains') {
        try {
          meta.replaces_domains = JSON.parse(value.replace(/'/g, '"'));
        } catch {
          meta.replaces_domains = value.replace(/[\[\]']/g, '').split(',').map(s => s.trim()).filter(Boolean);
        }
      } else if (key === 'domains') {
        try {
          meta.domains = JSON.parse(value.replace(/'/g, '"'));
        } catch {
          meta.domains = value.replace(/[\[\]']/g, '').split(',').map(s => s.trim()).filter(Boolean);
        }
      }
    }
    if (!foundClosing) {
      bodyStart = lines.length;
    }
  }

  const body = lines.slice(bodyStart).join('\n').trim();
  return { meta, body };
}

class SkillManager {
  constructor(options = {}) {
    this.skillsDir = options.skillsDir || path.resolve(process.cwd(), 'skills');
    this.db = options.db || null;
    this.threshold = options.threshold || DEFAULT_THRESHOLD;
    this.topK = options.topK || DEFAULT_TOP_K;
    this._skillsCache = null;
    this._embedder = null;
  }

  // ── Scan: leer skills/ y parsear SKILL.md ───────────────────────────
  async scan(force = false) {
    if (this._skillsCache && !force) return this._skillsCache;

    const skillsDir = this.skillsDir;
    if (!fs.existsSync(skillsDir)) {
      this._skillsCache = [];
      return [];
    }

    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    const skills = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillPath = path.join(skillsDir, entry.name);
      const skillFile = path.join(skillPath, 'SKILL.md');
      if (!fs.existsSync(skillFile)) continue;

      try {
        const raw = fs.readFileSync(skillFile, 'utf-8');
        const { meta, body } = _parseFrontmatter(raw);
        if (!meta.description) {
          console.warn(`[skills] SKILL.md en "${entry.name}" no tiene description en frontmatter, ignorando`);
          continue;
        }
        skills.push({
          name: entry.name,
          description: meta.description,
          version: meta.version || '1.0.0',
          domains: Array.isArray(meta.domains) ? meta.domains : [],
          replaces_domains: Array.isArray(meta.replaces_domains) ? meta.replaces_domains : null,
          content: body || meta.description || '',
        });
      } catch (e) {
        console.warn(`[skills] Error leyendo skill "${entry.name}": ${e.message}`);
      }
    }

    this._skillsCache = skills;
    return skills;
  }

  // ── Index: embedding + inserción en DB ──────────────────────────────
  async index(skills) {
    if (!this.db) throw new Error('SkillManager necesita una conexión db para indexar');
    const db = this.db;

    this._ensureTables(db);

    if (!skills) skills = await this.scan();
    if (skills.length === 0) return 0;

    const embed = await _getEmbedder();
    let indexed = 0;

    const insertMeta = db.prepare(
      `INSERT OR IGNORE INTO ${SKILL_TABLE} (name, description, version, domains, content) VALUES (?, ?, ?, ?, ?)`
    );
    const insertVec = db.prepare(
      `INSERT INTO ${VECTOR_TABLE} (rowid, embedding) VALUES (?, ?)`
    );

    const tx = db.transaction(() => {
      for (const skill of skills) {
        const info = insertMeta.run(
          skill.name, skill.description, skill.version,
          JSON.stringify(skill.domains), skill.content
        );
        if (info.changes > 0) {
          const rowid = info.lastInsertRowid;
          const vec = awaitEmbed(embed, skill.description);
          insertVec.run(rowid, vec);
          indexed++;
        }
      }
    });

    tx();
    return indexed;
  }

  // ── Match: KNN search contra user message ────────────────────────────
  async match(userMessage, db) {
    db = db || this.db;
    if (!db) throw new Error('SkillManager necesita una conexión db para matchear');

    this._ensureTables(db);

    const embed = await _getEmbedder();
    const queryVec = awaitEmbed(embed, userMessage);
    if (!queryVec) return [];

    const sql = `
      SELECT sc.name, sc.description, sc.domains, sc.content, sv.distance
      FROM ${VECTOR_TABLE} sv
      JOIN ${SKILL_TABLE} sc ON sc.id = sv.rowid
      WHERE sv.embedding MATCH ?
        AND k = ?
      ORDER BY sv.distance ASC
    `;

    let rows;
    try {
      rows = db.prepare(sql).all(queryVec, this.topK);
    } catch {
      return [];
    }

    const merged = rows
      .filter(r => r.distance <= (1 - this.threshold));

    if (merged.length === 0) return [];

    // Merge replaces_domains from scan cache (not stored in DB)
    const cache = this._skillsCache || [];
    return merged.map(r => {
      const cached = cache.find(c => c.name === r.name);
      return {
        name: r.name,
        description: r.description,
        domains: safeParseJSON(r.domains, []),
        replaces_domains: cached?.replaces_domains || null,
        content: r.content,
        distance: r.distance,
        score: 1 - r.distance,
      };
    });
  }

  // ── Build: match + injectar contenido en string de contexto ──────────
  async buildInjection(userMessage, db) {
    db = db || this.db;
    if (!db) return null;
    const matches = await this.match(userMessage, db);
    if (matches.length === 0) return null;

    const blocks = matches.map(skill => {
      return `## Skill: ${skill.name}\n${skill.description}\n\n${skill.content}`;
    });

    return [
      '---',
      '**Skills activas para esta tarea:**',
      ...blocks,
      '---',
    ].join('\n\n');
  }

  // ── Get skill content by name ────────────────────────────────────────
  getSkill(name) {
    if (!this._skillsCache) return null;
    return this._skillsCache.find(s => s.name === name) || null;
  }

  getAllSkills() {
    if (!this._skillsCache) return [];
    return this._skillsCache.map(s => ({
      name: s.name, description: s.description, version: s.version, domains: s.domains,
    }));
  }

  async ensureIndexed() {
    if (!this.db) return false;
    await this.scan();
    const count = this.db.prepare(`SELECT COUNT(*) as cnt FROM ${SKILL_TABLE}`).get();
    if (count.cnt > 0) return false;
    await this.index();
    return true;
  }

  _ensureTables(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${SKILL_TABLE} (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        version     TEXT NOT NULL DEFAULT '1.0.0',
        domains     TEXT NOT NULL DEFAULT '[]',
        content     TEXT NOT NULL DEFAULT '',
        created_at  INTEGER DEFAULT (strftime('%s', 'now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_catalog_name ON ${SKILL_TABLE}(name);
      CREATE VIRTUAL TABLE IF NOT EXISTS ${VECTOR_TABLE} USING vec0(
        embedding float[${VECTOR_DIMS}]
      );
    `);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────
function awaitEmbed(embedFn, text) {
  try {
    const tensor = embedFn(text);
    if (tensor && typeof tensor.then === 'function') {
      return tensor.then(t => float32ToBuffer(t));
    }
    return float32ToBuffer(tensor);
  } catch {
    return null;
  }
}

function float32ToBuffer(arr) {
  if (!arr) return null;
  if (arr instanceof Float32Array) return Buffer.from(arr.buffer);
  if (ArrayBuffer.isView(arr)) return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
  if (Array.isArray(arr)) return Buffer.from(new Float32Array(arr).buffer);
  return null;
}

function safeParseJSON(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

module.exports = { SkillManager, _parseFrontmatter, float32ToBuffer, _getEmbedder };
