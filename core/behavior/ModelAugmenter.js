'use strict';

// ModelAugmenter — descubre las animaciones/expresiones que un modelo Live2D
// trae en disco y las inyecta en un clon del settings del model3.json.
//
// Por qué existe: varios modelos (hutao, huohuo, Miku, 椿, 薇薇安…) traen
// carpetas llenas de *.exp3.json / *.motion3.json pero su model3.json NO las
// referencia (FileReferences.Motions/Expressions ausentes o vacías), así que
// el SDK jamás las carga y el asistente no puede animarlas. En lugar de
// escribir archivos ajenos, se construye un objeto settings en memoria
// (Live2DModel.from acepta el JSON del model3.json como objeto; ver
// `setupLive2DModel`/`Pe`+`Ce` en el dist de pixi-live2d-display 0.4.0), con
// la ruta del model3.json en `url` para que los paths relativos resuelvan
// bien (settings.resolveURL usa url.resolve sobre esa url).
//
// El resultado NO se escribe en disco ni se tocan los model3.json originales.

const fs = require('fs');
const path = require('path');

// Las animaciones cuyo nombre coincide con /idle/i pasan al grupo "Idle", que
// el SDK reproduce en bucle automáticamente (MotionManager.update →
// shouldRequestIdleMotion → startRandomMotion(groups.idle, IDLE)). El resto
// van a un grupo "motions" para dispararse a demanda.
const IDLE_MOTION_RE = /idle/i;

const MAX_WALK_DEPTH = 4;

const _cache = new Map(); // model3Path → { gestures, settings }

function _readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    return null;
  }
}

function _toPosix(p) {
  return p.split(path.sep).join('/');
}

function _walkModelDir(dir, out, depth) {
  if (depth > MAX_WALK_DEPTH) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) _walkModelDir(full, out, depth + 1);
    else if (entry.name.endsWith('.exp3.json')) out.exp3.push(full);
    else if (entry.name.endsWith('.motion3.json')) out.motion3.push(full);
  }
}

// Nombre "legible" a partir del nombre de archivo: sin extensión, sin
// directorio, espacios normalizados.
function _nameFromFile(file) {
  return path
    .basename(file, path.extname(file))
    .replace(/\.(exp3|motion3)$/i, '')
    .trim();
}

function _uniqueName(base, used) {
  let name = base;
  let i = 2;
  while (used.has(name)) name = `${base} ${i++}`;
  used.add(name);
  return name;
}

function _discover(model3Path) {
  const dir = path.dirname(model3Path);
  const out = { exp3: [], motion3: [] };
  _walkModelDir(dir, out, 0);

  const raw = _readJson(model3Path) || {};
  const fileRefs = raw.FileReferences || {};
  const refExpr = Array.isArray(fileRefs.Expressions) ? fileRefs.Expressions : [];
  const refMots = fileRefs.Motions && typeof fileRefs.Motions === 'object' ? fileRefs.Motions : {};

  // Mapa: ruta relativa (posix) → Name, para las expresiones YA referenciadas.
  // Importante: el Name referenciado es la fuente de la semántica (ej. los
  // "1.exp3.json" de March 7th se llaman 捂脸/比耶/... aunque el archivo no diga nada).
  const refByName = new Map();
  const refExprBases = new Set(); // basename de archivos referenciados (para no duplicar subcarpetas tipo exp/1.exp3.json)
  for (const e of refExpr) {
    if (!e || typeof e.Name !== 'string' || typeof e.File !== 'string') continue;
    refByName.set(_toPosix(path.normalize(e.File).replace(/^\.\//, '')), e.Name);
    refExprBases.add(path.basename(e.File));
  }

  const expressions = [];
  const motions = [];
  const usedExprNames = new Set();
  const usedMotionNames = new Set();

  // 1) Expresiones ya referenciadas (preserva Name exacto).
  for (const [rel, name] of refByName) {
    expressions.push({ type: 'expression', name, file: rel, referenced: true });
    usedExprNames.add(name);
  }

  // 2) Expresiones descubiertas en disco que aún no están referenciadas.
  for (const file of out.exp3) {
    const rel = _toPosix(path.relative(dir, file));
    if (refByName.has(rel)) continue;
    if (refExprBases.has(path.basename(file))) continue; // duplicado en subcarpeta (ej. exp/1.exp3.json)
    const name = _uniqueName(_nameFromFile(file), usedExprNames);
    expressions.push({ type: 'expression', name, file: rel, referenced: false });
  }

  // 3) Motions: referenciadas en el model3.json + descubiertas en disco.
  // Las referenciadas PRESERVAN el grupo original del model3.json: un motion
  // bajo "Motions.Idle" (aunque el archivo se llame mtn_00.motion3.json y no
  // tenga "idle" en el nombre) debe seguir en el grupo "Idle" para el auto-loop
  // del SDK. Solo lo descubierto en disco sin referencia se clasifica por nombre
  // (idle → "Idle"; el resto → "motions"). Si el grupo original es una cadena
  // vacía (quirk de 免费模型艾莲), se cae a la clasificación por nombre.
  const groups = new Map(); // group → array de { name, file, referenced }
  const seenMotionRel = new Set(); // paths relativos ya añadidos (dedupe)
  const refMotBases = new Set(); // basenames referenciados (dedupe subcarpetas)
  for (const defs of Object.values(refMots)) {
    if (!Array.isArray(defs)) continue;
    for (const d of defs) {
      if (d && typeof d.File === 'string') refMotBases.add(path.basename(d.File));
    }
  }
  const addMotion = (name, file, { referenced = false, group = null } = {}) => {
    if (seenMotionRel.has(file)) return;
    seenMotionRel.add(file);
    const g =
      typeof group === 'string' && group.trim()
        ? group
        : IDLE_MOTION_RE.test(name)
          ? 'Idle'
          : 'motions';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push({ name, file, group: g, referenced });
  };
  // 3a) Referenciadas: preservan la clave de grupo original del model3.json.
  for (const [group, defs] of Object.entries(refMots)) {
    if (!Array.isArray(defs)) continue;
    for (const d of defs) {
      if (!d || typeof d.File !== 'string') continue;
      const rel = _toPosix(path.normalize(d.File).replace(/^\.\//, ''));
      addMotion(_nameFromFile(path.basename(rel)), rel, { referenced: true, group });
    }
  }
  // 3b) Descubiertas en disco no referenciadas (y no duplicadas por basename,
  // p. ej. una subcarpeta que repite un archivo ya referenciado).
  for (const file of out.motion3) {
    const rel = _toPosix(path.relative(dir, file));
    if (seenMotionRel.has(rel)) continue;
    if (refMotBases.has(path.basename(file))) continue;
    addMotion(_nameFromFile(file), rel, { referenced: false });
  }
  for (const [group, defs] of groups) {
    defs.forEach((d, index) => {
      motions.push({
        type: 'motion',
        name: _uniqueName(d.name, usedMotionNames),
        group,
        file: d.file,
        index,
        referenced: !!d.referenced,
      });
    });
  }

  return {
    modelName: typeof raw.Name === 'string' ? raw.Name : path.basename(dir),
    expressions,
    motions,
  };
}

/**
 * Lista los gestos disponibles para un model3.json (con caché).
 * @param {string} model3Path ruta absoluta al model3.json
 * @returns {{ expressions: Array, motions: Array }} gestos
 */
function listGestures(model3Path) {
  if (!model3Path || typeof model3Path !== 'string') {
    return { modelName: '', expressions: [], motions: [] };
  }
  const cached = _cache.get(model3Path);
  if (cached) return cached.gestures;
  const gestures = _discover(model3Path);
  _cache.set(model3Path, { gestures });
  return gestures;
}

/**
 * Construye el objeto `settings` que Live2DModel.from puede consumir, con las
 * expresiones/motions inyectadas. No toca archivos en disco.
 * @param {string} model3Path
 * @returns {{ settings: Object, gestures: Object }}
 */
function augmentModel(model3Path) {
  if (!model3Path || typeof model3Path !== 'string' || !fs.existsSync(model3Path)) {
    return { settings: null, gestures: { modelName: '', expressions: [], motions: [] } };
  }

  const cached = _cache.get(model3Path);
  if (cached && cached.settings) return { settings: cached.settings, gestures: cached.gestures };

  const raw = _readJson(model3Path) || {};
  const gestures = _discover(model3Path);

  const fileRefs = { ...(raw.FileReferences || {}) };
  if (gestures.expressions.length) {
    fileRefs.Expressions = gestures.expressions.map((e) => ({ Name: e.name, File: e.file }));
  }
  if (gestures.motions.length) {
    const motions = {};
    for (const m of gestures.motions) {
      if (!motions[m.group]) motions[m.group] = [];
      motions[m.group].push({ File: m.file });
    }
    fileRefs.Motions = motions;
  }

  const settings = {
    ...raw,
    url: 'file:///' + _toPosix(model3Path.replace(/^\/+/, '')),
    FileReferences: fileRefs,
  };

  _cache.set(model3Path, { settings, gestures });
  return { settings, gestures };
}

function resetCache() {
  _cache.clear();
}

module.exports = { augmentModel, listGestures, resetCache, IDLE_MOTION_RE };
