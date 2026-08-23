// @ts-nocheck
'use strict';
const logger = require('../observability/Logger.js');

const fs = require('fs');
const path = require('path');

const { distanceToSimilarity } = require('../grounding/IntentDetector.js');
const EmbedService = require('../grounding/EmbedService.js');

const SKILL_TABLE = 'skill_catalog';
const VECTOR_TABLE = 'skill_vectors';
const DEFAULT_THRESHOLD = 0.35;
const DEFAULT_TOP_K = 3;
const VECTOR_DIMS = 384;
const SKILL_CATALOG = [];

// ── Presupuesto de contexto (BUG auditoría: buildInjection inyectaba sin límite) ──
// El system prompt tiene MAX_SYSTEM_CHARS=14K (chat) / 30K (agente). Una skill
// gigante podía comerse ese presupuesto entera y sin dejar rastro en logs.
const SKILL_MAX_CHARS = 4_000; // cap por skill individual
const SKILLS_TOTAL_SOFT_CAP = 12_000; // aviso si la inyección total lo supera

/**
 * Trunca el contenido de una skill al cap, cortando en el último salto de
 * línea útil y avisando explícitamente en el prompt (patrón de compactación
 * del AgentLoop: el LLM SABE que está viendo texto cortado).
 * @param {string} content
 * @param {string} name
 * @returns {{ text: string, truncated: boolean }}
 */
function _capSkillContent(content, name) {
  const text = String(content || '');
  if (text.length <= SKILL_MAX_CHARS) return { text, truncated: false };
  const capped = text.slice(0, SKILL_MAX_CHARS);
  const cut = capped.lastIndexOf('\n');
  const out = cut > SKILL_MAX_CHARS * 0.6 ? capped.slice(0, cut) : capped;
  return {
    text: `${out}\n\n[⚠ Skill "${name}" TRUNCADA: ${text.length} → ${out.length} caracteres para respetar el presupuesto de contexto. Si necesitás el resto, pedilo explícitamente.]`,
    truncated: true,
  };
}

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
          meta.replaces_domains = value
            .replace(/[[\]']/g, '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        }
      } else if (key === 'domains') {
        try {
          meta.domains = JSON.parse(value.replace(/'/g, '"'));
        } catch {
          meta.domains = value
            .replace(/[[\]']/g, '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
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
    // Loop de feedback: proveedor opcional de estadísticas por skill
    // ({ name: { uses, successes, rate } }) — lo inyecta init.js desde
    // LearningEngine.skillStats(). Con esto el matching se adapta a qué
    // skills fueron ÚTILES en la práctica, no solo semánticamente cercanas.
    this.statsProvider =
      typeof options.statsProvider === 'function' ? options.statsProvider : null;
    // Última inyección (nombres + timestamp) para correlacionar con el
    // outcome del run en core/core/agent.js.
    /** @type {{ names: string[], ts: number }|null} */
    this.lastInjection = null;
  }

  /**
   * Umbral de similitud ADAPTATIVO por skill según su historial de outcomes:
   *   - rate ≥ 0.7 (útil demostrada) → umbral −0.05 (entra más fácil)
   *   - rate ≤ 0.34 (falló seguido)  → umbral +0.03 (más difícil que dispare)
   * Requiere ≥2 usos para actuar; sin datos queda el umbral base.
   * @param {string} skillName
   * @param {Map<string, {uses: number, successes: number, rate: number}>} [stats]
   * @returns {{ threshold: number, boost: number }}
   */
  _effectiveThresholdFor(skillName, stats) {
    let threshold = this.threshold;
    let boost = 1; // multiplicador de ranking
    const s = stats?.get(skillName);
    if (!s || s.uses < 2) return { threshold, boost };
    if (s.rate >= 0.6) {
      threshold -= 0.05;
      boost = 0.9 + 0.2 * s.rate; // hasta ~1.02-1.04
    } else if (s.rate <= 0.34) {
      threshold += 0.03;
      boost = 0.9 + 0.2 * s.rate; // hasta ~0.97
    }
    return { threshold: Math.max(0.15, Math.min(0.8, threshold)), boost };
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
          logger.warn(
            'SkillManager',
            `[skills] SKILL.md en "${entry.name}" no tiene description en frontmatter, ignorando`
          );
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
        logger.warn('SkillManager', `[skills] Error leyendo skill "${entry.name}": ${e.message}`);
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

    let indexed = 0;

    // Pre-computar vectores fuera de la transacción (el embedder es async).
    // F2.1-D: embeddings en worker_threads (EmbedService).
    const vectorMap = new Map();
    for (const skill of skills) {
      try {
        const tensor = await EmbedService.embedText(skill.description);
        vectorMap.set(skill.name, float32ToBuffer(tensor));
      } catch {
        vectorMap.set(skill.name, null);
      }
    }

    const insertMeta = db.prepare(
      `INSERT OR IGNORE INTO ${SKILL_TABLE} (name, description, version, domains, content) VALUES (?, ?, ?, ?, ?)`
    );
    const insertVec = db.prepare(`INSERT INTO ${VECTOR_TABLE} (rowid, embedding) VALUES (?, ?)`);

    const tx = db.transaction(() => {
      for (const skill of skills) {
        const info = insertMeta.run(
          skill.name,
          skill.description,
          skill.version,
          JSON.stringify(skill.domains),
          skill.content
        );
        if (info.changes > 0) {
          const rowid = info.lastInsertRowid;
          const vec = vectorMap.get(skill.name);
          if (vec) insertVec.run(BigInt(rowid), vec);
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

    // F2.1-D: embedding del mensaje en worker_threads (EmbedService).
    const tensor = await EmbedService.embedText(userMessage).catch(() => null);
    const queryVec = float32ToBuffer(tensor);
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

    // Loop de feedback: estadísticas por skill UNA vez para todo el match.
    let stats = null;
    if (this.statsProvider) {
      try {
        const raw = this.statsProvider();
        if (raw && typeof raw === 'object') {
          stats = new Map(
            Object.entries(raw).map(([name, s]) => [
              name,
              { uses: s.uses || 0, successes: s.successes || 0, rate: s.rate ?? 0 },
            ])
          );
        }
      } catch {}
    }

    const merged = rows.filter((r) => {
      const sim = distanceToSimilarity(r.distance);
      // Umbral adaptativo por skill según outcomes reales.
      const { threshold } = this._effectiveThresholdFor(r.name, stats);
      return sim >= threshold;
    });

    if (merged.length === 0) return [];

    // Merge replaces_domains from scan cache (not stored in DB)
    const cache = this._skillsCache || [];
    const out = merged.map((r) => {
      const cached = cache.find((c) => c.name === r.name);
      const similarity = distanceToSimilarity(r.distance);
      const boost = stats ? this._effectiveThresholdFor(r.name, stats).boost : 1;
      return {
        name: r.name,
        description: r.description,
        domains: safeParseJSON(r.domains, []),
        replaces_domains: cached?.replaces_domains || null,
        content: r.content,
        distance: r.distance,
        score: similarity * boost,
      };
    });
    // Ranking final por score ajustado (reliability boost puede reordenar).
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  // ── Build: match + injectar contenido en string de contexto ──────────
  async buildInjection(userMessage, db) {
    db = db || this.db;
    if (!db) return null;
    const matches = await this.match(userMessage, db);
    if (matches.length === 0) return null;

    // Presupuesto: cap por skill + telemetría del peso total. Sin esto no hay
    // forma de saber cuánto contexto comen las skills en un turno dado.
    let truncatedCount = 0;
    const blocks = matches.map((skill) => {
      const { text, truncated } = _capSkillContent(skill.content, skill.name);
      if (truncated) truncatedCount++;
      const block = `## Skill: ${skill.name}\n${skill.description}\n\n${text}`;
      logger.info(
        'SkillManager',
        `[skills] "${skill.name}": ${block.length} chars${truncated ? ' ⚠ TRUNCADA' : ''}`
      );
      return block;
    });

    // Loop de feedback: registrar QUÉ skills se inyectaron y cuándo, para que
    // core/core/agent.js correlacione con el outcome del run.
    this.lastInjection = {
      names: matches.map((m) => m.name),
      ts: Date.now(),
    };

    const injection = ['---', '**Skills activas para esta tarea:**', ...blocks, '---'].join(
      '\n\n'
    );

    // ~4 chars/token: estimación gruesa pero suficiente para dimensionar.
    const approxTokens = Math.round(injection.length / 4);
    logger.info(
      'SkillManager',
      `[skills] inyección total: ${matches.length} skill(s) · ${injection.length} chars ` +
        `(~${approxTokens} tokens)` +
        (truncatedCount ? ` · ${truncatedCount} truncada(s)` : '') +
        (injection.length > SKILLS_TOTAL_SOFT_CAP ? ' · ⚠ supera soft-cap recomendado' : '')
    );

    return injection;
  }

  // ── Get skill content by name ────────────────────────────────────────
  getSkill(name) {
    if (!this._skillsCache) return null;
    return this._skillsCache.find((s) => s.name === name) || null;
  }

  getAllSkills() {
    if (!this._skillsCache) return [];
    return this._skillsCache.map((s) => ({
      name: s.name,
      description: s.description,
      version: s.version,
      domains: s.domains,
    }));
  }

  async ensureIndexed() {
    if (!this.db) return false;
    this._ensureTables(this.db);
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
function float32ToBuffer(arr) {
  if (!arr) return null;
  if (arr instanceof Float32Array) return Buffer.from(arr.buffer);
  if (ArrayBuffer.isView(arr)) return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
  if (Array.isArray(arr)) return Buffer.from(new Float32Array(arr).buffer);
  return null;
}

function safeParseJSON(str, fallback) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

module.exports = { SkillManager, _parseFrontmatter, float32ToBuffer, _getEmbedder };
