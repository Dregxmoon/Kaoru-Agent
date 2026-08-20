'use strict';

/**
 * test_model_picker_default.js — Model picker: filtro default del selector de
 * modelos. Sin query solo se muestran favoritos + proveedores con API key
 * (hasKey); escribir texto abre la búsqueda contra el catálogo completo.
 *
 * La lógica del default vive main-side (computeDefaultPickerRows) porque el
 * renderer no puede require módulos core (sandbox). La búsqueda del renderer
 * opera sobre _pickerData.models (catálogo completo); el contrato de "escribir
 * texto alcanza todo" se verifica replicando la expresión de match del
 * renderer (label/modelId/provider name) sobre el catálogo completo.
 *
 * Correr como las demás suites (Node de Electron):
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron tests/test_model_picker_default.js
 */

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

let passed = 0;
let failed = 0;

function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  ${C.green('✓')} ${label}`);
    passed++;
  } else {
    console.log(`  ${C.red('✗')} ${label}`);
    if (detail) console.log(`    ${C.dim(detail)}`);
    failed++;
  }
}

const { computeDefaultPickerRows } = require('../core/llm/LLMProvider.js');

// ── Fixtures sintéticos ────────────────────────────────────────────────────
// 2 proveedores conectados (3 modelos c/u) + 400+ providers remotos sin key
// (2 modelos c/u) + favoritos de providers sin key. La posición de cada modelo
// en el array es: con_0 → model-0..model-2, con_1 → model-3..model-5,
// remote_i → 6 + 2*i, 7 + 2*i (label "Remoto i model-<n>").
function makeProviders(connected, remote) {
  const providers = [];
  for (let i = 0; i < connected; i++) {
    providers.push({ id: `con_${i}`, name: `Conectado ${i}`, hasKey: true });
  }
  for (let i = 0; i < remote; i++) {
    providers.push({ id: `remote_${i}`, name: `Remoto ${i}`, hasKey: false });
  }
  return providers;
}

function makeModels(providers, perProvider, offset = 0) {
  const models = [];
  let n = offset;
  for (const p of providers) {
    for (let k = 0; k < perProvider; k++) {
      models.push({
        providerId: p.id,
        modelId: `model-${n}`,
        label: `${p.name} model-${n}`,
      });
      n++;
    }
  }
  return models;
}

function rendererMatch(models, providers, q) {
  const byId = new Map(providers.map((p) => [p.id, p]));
  const query = q.toLowerCase();
  return models.filter((m) => {
    const p = byId.get(m.providerId) || {};
    return (
      m.label.toLowerCase().includes(query) ||
      m.modelId.toLowerCase().includes(query) ||
      (p.name || '').toLowerCase().includes(query)
    );
  });
}

function key(m) {
  return `${m.providerId}/${m.modelId}`;
}

// ── Tests ─────────────────────────────────────────────────────────────────
console.log(C.bold('\nModel picker — filtro default (computeDefaultPickerRows)'));

{
  const providers = makeProviders(2, 410);
  const models = makeModels(providers, 3); // 6 + 410*2 = 826 modelos
  const favorites = [key(models.find((m) => m.providerId === 'remote_7'))];
  const def = computeDefaultPickerRows(providers, models, favorites);

  assert(def.length <= 30, 'default sin query no supera N=30 filas', `obtuvo ${def.length} filas`);
  assert(def.length > 0, 'default no está vacío (hay 2 conectados + 1 favorito remoto)');
  assert(
    def.length === 2 * 3 + 1,
    'default = modelos de proveedores con key (6) + modelo favorito remoto (1)',
    `obtuvo ${def.length}`
  );
  const onlyConnectedOrFav = def.every(
    (m) => providers.find((p) => p.id === m.providerId).hasKey || favorites.includes(key(m))
  );
  assert(onlyConnectedOrFav, 'default solo incluye proveedores con key o favoritos');
  assert(
    def.some((m) => m.providerId === 'remote_7'),
    'favorito de provider sin key SÍ aparece en default'
  );
  assert(
    !def.some((m) => m.providerId === 'remote_0'),
    'provider remoto sin key y sin favorito NO aparece en default'
  );
}

{
  // Ningún proveedor conectado ni favoritos → default vacío (no abrumar).
  const providers = makeProviders(0, 420);
  const models = makeModels(providers, 2);
  const def = computeDefaultPickerRows(providers, models, []);
  assert(def.length === 0, 'sin conectados ni favoritos, default vacío', `obtuvo ${def.length}`);
}

{
  // Orden: favoritos primero, luego providerId alfabético.
  const providers = makeProviders(2, 0);
  const models = makeModels(providers, 2);
  const favKey = key(models.find((m) => m.providerId === 'con_1'));
  const def = computeDefaultPickerRows(providers, models, [favKey]);
  assert(
    def[0].providerId === 'con_1',
    'favorito va primero',
    `primero es ${def[0] && def[0].providerId}`
  );
  assert(
    def[1].providerId === 'con_0',
    'luego providerId alfabético',
    `segundo es ${def[1] && def[1].providerId}`
  );
}

console.log(C.bold('\nModel picker — búsqueda abre el catálogo completo'));

{
  const providers = makeProviders(2, 410);
  const models = makeModels(providers, 2);
  const favorites = [key(models.find((m) => m.providerId === 'remote_7'))];
  const def = computeDefaultPickerRows(providers, models, favorites);

  assert(
    models.length > 800,
    'catálogo completo sigue disponible (826 modelos)',
    `models.length = ${models.length}`
  );

  const q1 = rendererMatch(models, providers, 'remoto');
  assert(
    q1.length > 0 && q1.every((m) => m.providerId.startsWith('remote_')),
    'query de texto llega a providers remotos sin key',
    `${q1.length} resultados`
  );
  assert(
    q1.length > def.length,
    'resultado de búsqueda no está limitado al default',
    `default=${def.length} resultados=${q1.length}`
  );

  const q2 = rendererMatch(models, providers, 'model-800');
  assert(
    q2.some((m) => m.providerId === 'remote_398'),
    'la búsqueda alcanza modelos lejanos del catálogo (no solo conectados)'
  );
}

console.log(C.bold('\nResumen'));
console.log(`  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
