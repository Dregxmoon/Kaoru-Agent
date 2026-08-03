'use strict';

// GestureHeuristic — traduce un estado de ánimo (o el nombre exacto de un
// gesto) al gesto REAL que el modelo activo puede reproducir, puntuando los
// nombres de expresiones (.exp3.json) y animaciones (.motion3.json) contra el
// vocabulario multilingüe de GestureLexicon.
//
// Orden de precedencia:
//   1. mappings explícitos de config (opts.mappings: mood → nombre de gesto)
//   2. default/idle/normal → animación del grupo "Idle" si existe
//   3. scoring léxico (exacto 100, substring 70, contenido 50; umbral 60),
//      con desempate hacia expresión para emociones y motion para acciones.

const Lexicon = require('./GestureLexicon.js');

const THRESHOLD = 60;

const _cache = new Map(); // model3Path → resultado de resolveAll

function _idleMotion(gestures) {
  const motions = gestures.motions || [];
  return motions.find(m => m.group === 'Idle') || null;
}

function _allGestures(gestures) {
  return [
    ...(gestures.expressions || []).map(g => ({ ...g, kind: 'expression' })),
    ...(gestures.motions || []).map(g => ({ ...g, kind: 'motion' })),
  ];
}

// Score de un gesto contra un mood. 0 = sin coincidencia.
function scoreGesture(gesture, mood) {
  const gname = Lexicon.normalizeToken(gesture.name);
  if (!gname) return 0;

  let tokens = Lexicon.tokensFor(mood);
  if (!tokens.length) tokens = [Lexicon.normalizeToken(mood)];

  let best = 0;
  for (const tok of tokens) {
    if (!tok) continue;
    if (tok === gname) { best = 100; break; }
    // Tokens latin cortos (p. ej. "hi", "no") generan falsos positivos por
    // substring ("white eyes".includes("hi")); los CJK sí son significativos
    // en fragmentos ("哭" dentro de "大哭").
    const isCJK = /[\u3040-\u30ff\u4e00-\u9fff]/.test(tok);
    if (gname.includes(tok) && (tok.length >= 3 || isCJK)) {
      best = Math.max(best, 70);
    } else if (tok.length >= 3 && tok.includes(gname)) {
      best = Math.max(best, 50);
    }
  }
  return best;
}

/**
 * Resuelve un mood (o nombre de gesto) al gesto que mejor lo representa.
 * @param {string} mood
 * @param {{expressions:Array, motions:Array}} gestures
 * @param {{mappings?: Object}} [opts]
 */
function resolveMood(mood, gestures, opts = {}) {
  if (!gestures) return { ok: false, mood, gesture: null, score: 0, source: 'sin gestos' };

  const m = Lexicon.normalizeToken(mood);
  if (!m) return { ok: false, mood, gesture: null, score: 0, source: 'mood vacío' };

  // 1) Mapping explícito de config: mood → nombre de gesto.
  const mappings = opts.mappings || {};
  if (mappings[m]) {
    const target = _allGestures(gestures).find(g => g.name === mappings[m]);
    if (target) return { ok: true, mood: m, gesture: target, score: 100, source: 'config' };
  }

  // 2) default/idle/normal → motion del grupo "Idle" si el modelo lo tiene.
  if (m === 'default' || m === 'idle' || m === 'normal') {
    const idle = _idleMotion(gestures);
    if (idle) return { ok: true, mood: m, gesture: idle, score: 80, source: 'idle' };
  }

  // 3) Scoring léxico.
  const preferMotion = Lexicon.isActionMood(m);
  let best = null;
  for (const g of _allGestures(gestures)) {
    const s = scoreGesture(g, m);
    if (s < THRESHOLD) continue;
    if (!best || s > best.score) {
      best = { score: s, gesture: g };
    } else if (s === best.score) {
      const want = preferMotion ? 'motion' : 'expression';
      if (g.kind === want && best.gesture.kind !== want) {
        best = { score: s, gesture: g };
      }
    }
  }

  if (!best) {
    return { ok: false, mood: m, gesture: null, score: 0, source: 'sin coincidencia' };
  }
  return { ok: true, mood: m, gesture: best.gesture, score: best.score, source: 'lexicon' };
}

/**
 * Mapa mood → gesto para todos los moods del léxico + gestos sin mapear.
 */
function resolveAll(gestures, opts = {}) {
  const map = {};
  const used = new Set();
  for (const mood of Lexicon.MOODS) {
    const r = resolveMood(mood, gestures, opts);
    if (r.ok && r.gesture) {
      map[mood] = r.gesture;
      used.add(r.gesture.name);
    }
  }
  const unmapped = _allGestures(gestures)
    .filter(g => !used.has(g.name))
    .map(g => g.name);
  return { map, unmapped, modelName: gestures.modelName || '' };
}

// Moods que un gesto dado es capaz de transmitir (para /gestos).
function describeGesture(gesture) {
  const name = Lexicon.normalizeToken(gesture.name);
  const words = name.match(/[a-z0-9]+|[\u3040-\u30ff\u4e00-\u9fff]+/g) || [name];
  const moods = new Set();
  for (const w of words) {
    if (Lexicon.isNoise(w)) continue;
    for (const mood of Lexicon.moodOfToken(w)) moods.add(mood);
  }
  return [...moods];
}

function resolveCached(model3Path, gestures, opts = {}) {
  if (model3Path && _cache.has(model3Path)) return _cache.get(model3Path);
  const result = resolveAll(gestures, opts);
  if (model3Path) _cache.set(model3Path, result);
  return result;
}

function resetCache() {
  _cache.clear();
}

module.exports = {
  THRESHOLD,
  scoreGesture,
  resolveMood,
  resolveAll,
  resolveCached,
  describeGesture,
  resetCache,
};
