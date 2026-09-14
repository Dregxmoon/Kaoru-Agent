'use strict';

// IntentClassifier: intenciones por inferencia (coseno contra descripciones
// de dominio), sin regex ni listas por idioma. Tests deterministas con
// embedFn inyectado; la calibración con el modelo real va aparte (viva).

const {
  classify,
  clearDescriptionCache,
  DOMAIN_DESCRIPTIONS,
} = require('../core/task/IntentClassifier.js');

let passed = 0;
let failed = 0;

function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
    passed++;
  } else {
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

const DIMS = 384;
function axis(i) {
  const v = new Array(DIMS).fill(0);
  v[i] = 1;
  return v;
}
function mix(a, b, weightA) {
  const v = a.map((x, i) => x * weightA + b[i] * (1 - weightA));
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

// Cada descripción de dominio vive en su propio eje; las queries se mezclan.
function makeEmbedFn() {
  const table = new Map();
  let axisIdx = 0;
  const axisByText = new Map();
  const fn = async (text) => {
    if (table.has(text)) return table.get(text);
    if (!axisByText.has(text)) axisByText.set(text, axis(axisIdx++ % (DIMS - 1)));
    const v = axisByText.get(text);
    table.set(text, v);
    return v;
  };
  fn.table = table;
  const counted = async (text) => {
    counted.calls++;
    return fn(text);
  };
  counted.calls = 0;
  counted.table = table;
  counted.axisByText = axisByText;
  return counted;
}

// Ejes distintos por dominio para TODOS (si no, el auto-assign colisiona con
// los presets y dos dominios comparten vector).
function presetAllDomains(embedFn, step = 20) {
  Object.values(DOMAIN_DESCRIPTIONS).forEach((descs, i) => {
    for (const d of descs) embedFn.table.set(d, axis(10 + i * step));
  });
}

async function main() {
  console.log('\x1b[1m\n════ IntentClassifier por embeddings ════\x1b[0m');

  console.log('\n── Casos borde ──');
  assert((await classify('', { embedFn: async () => axis(0) })).level === 'none', 'vacío → none');
  assert((await classify('hola')).level === 'none', 'sin embedFn → none');
  assert(
    (
      await classify('hola', {
        embedFn: async () => {
          throw new Error('caído');
        },
      })
    ).level === 'none',
    'embed caído → none (fallback a regex)'
  );
  assert(
    (await classify('hola', { embedFn: async () => [1, 2, 3] })).level === 'none',
    'dims incorrectas → none'
  );

  console.log('\n── Clasificación determinista ──');
  clearDescriptionCache();
  const embedFn = makeEmbedFn();
  presetAllDomains(embedFn);
  const webAxis = 10 + Object.keys(DOMAIN_DESCRIPTIONS).indexOf('web') * 20;
  const sysAxis = 10 + Object.keys(DOMAIN_DESCRIPTIONS).indexOf('system') * 20;
  const nearWeb = mix(axis(webAxis), axis(300), 0.95);
  const r1 = await classify('abre amazon por favor', {
    embedFn: async (t) => (t === 'abre amazon por favor' ? nearWeb : embedFn(t)),
  });
  assert(
    r1.isTask && r1.domain.id === 'web' && r1.level === 'high',
    'cercano a web → web high',
    JSON.stringify(r1)
  );

  // mix con peso 0.43 → sim ≈ 0.60 (zona medium).
  const midWeb = mix(axis(webAxis), axis(300), 0.43);
  const r2 = await classify('algo web más o menos', {
    embedFn: async (t) => (t === 'algo web más o menos' ? midWeb : embedFn(t)),
  });
  assert(
    r2.isTask && r2.domain.id === 'web' && r2.level === 'medium',
    'sim media → medium',
    JSON.stringify(r2)
  );

  // El mejor entre dos cercanos gana (sin listas, por scores).
  const nearBoth = mix(axis(webAxis), axis(sysAxis), 0.7);
  const r25 = await classify('abrir sitio del sistema', {
    embedFn: async (t) => (t === 'abrir sitio del sistema' ? nearBoth : embedFn(t)),
  });
  assert(r25.isTask && r25.domain.id === 'web', 'compite por scores, gana el mayor');

  const far = axis(301);
  const r3 = await classify('blabla sin sentido', {
    embedFn: async (t) => (t === 'blabla sin sentido' ? far : embedFn(t)),
  });
  assert(!r3.isTask && r3.level === 'none', 'lejos de todo → none');

  // Sin margen no hay decisión aunque el mejor supere el piso.
  const tied = mix(axis(webAxis), axis(sysAxis), 0.5);
  const r4 = await classify('empate total', {
    embedFn: async (t) => (t === 'empate total' ? tied : embedFn(t)),
  });
  assert(
    !r4.isTask && r4.level === 'none',
    'empate entre dominios → none',
    JSON.stringify(r4.scores)
  );

  console.log('\n── Caché de descripciones ──');
  clearDescriptionCache();
  const counting = makeEmbedFn();
  presetAllDomains(counting);
  const q = async (t) => (t.startsWith('q') ? mix(axis(10), axis(300), 0.95) : counting(t));
  const descCount = Object.values(DOMAIN_DESCRIPTIONS).flat().length;
  const before = counting.calls;
  await classify('q1', { embedFn: q });
  const afterFirst = counting.calls;
  await classify('q2', { embedFn: q });
  const afterSecond = counting.calls;
  // Las queries del harness no pasan por el contador; las descripciones sí.
  assert(
    afterFirst - before === descCount,
    'primera vez embebe descripciones',
    `${afterFirst - before} vs ${descCount}`
  );
  assert(
    afterSecond - afterFirst === 0,
    'segunda vez nada (caché de descripciones)',
    `${afterSecond - afterFirst}`
  );

  console.log('\n── Catálogo de dominios ──');
  assert(Object.keys(DOMAIN_DESCRIPTIONS).length >= 10, 'cubre los dominios de TaskDetector');
  assert(
    Object.values(DOMAIN_DESCRIPTIONS).every((lines) => lines.length >= 2),
    'cada dominio con al menos 2 descripciones'
  );

  console.log(`\nResultado: ${passed} passed  ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
