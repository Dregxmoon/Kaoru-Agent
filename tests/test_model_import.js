'use strict';

/**
 * test_model_import.js — importación de modelos Live2D (model-import).
 *
 * Regresiones cubiertas:
 *   - En builds empaquetados `models/` vive dentro de app.asar (solo lectura):
 *     los modelos importados deben ir a userData/models, nunca al directorio
 *     incluido en el release.
 *   - Un .model3.json en una subcarpeta (p. ej. `runtime/`) debía copiarse pero
 *     luego no se listaba → "No se pudo activar el modelo importado."
 *   - Sin carpetas huérfanas cuando la importación falla.
 *   - Raíz de unidad (C:\) → error claro en lugar de copiar sobre `models/`.
 *
 * Correr igual que las demás suites (Node de Electron):
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron tests/test_model_import.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoru-model-import-'));
let userData = path.join(tmp, 'userData');
const handlers = new Map();
const electronMock = {
  app: { quit() {}, getPath: () => userData },
  ipcMain: {
    on() {},
    handle: (channel, handler) => handlers.set(channel, handler),
  },
};
const originalLoad = Module._load;
Module._load = function mockLoad(request, parent, isMain) {
  if (request === 'electron') return electronMock;
  return originalLoad.call(this, request, parent, isMain);
};
let register;
try {
  ({ register } = require('../ipc/window-model-handlers.js'));
} finally {
  Module._load = originalLoad;
}

const saved = [];
const broadcasts = [];
const S = { chatWindow: null, mainWindow: null, activeModelId: '' };
const ctx = {
  S,
  savedConfig: {},
  loadConfig: () => ({}),
  saveConfig: (patch) => saved.push(patch),
  sendToChat: (channel, payload) => broadcasts.push({ channel, payload }),
  buildTrayMenu: () => null,
};
register(ctx);
const importModel = (folderPath) => handlers.get('model-import')({}, { folderPath });

const bundledDir = path.join(__dirname, '..', 'models');
const bundledBefore = fs.existsSync(bundledDir) ? fs.readdirSync(bundledDir).sort() : [];

function makeModel(root, name, { nested } = {}) {
  const base = path.join(root, name);
  const dir = nested ? path.join(base, nested) : base;
  fs.mkdirSync(path.join(dir, 'textures'), { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.model3.json`), '{}');
  fs.writeFileSync(path.join(dir, 'textures', 't0.png'), 'x');
  return base;
}

const sources = path.join(tmp, 'sources');
let passed = 0;
function check(label, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${label}`);
}

try {
  // 1) modelo plano
  const flat = makeModel(sources, 'FlatModel');
  let res = importModel(flat);
  check('importa un modelo con .model3.json en la raíz', () => {
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.info.id, 'FlatModel');
    assert.equal(S.activeModelId, 'FlatModel');
  });
  check('copia a userData/models (no al directorio incluido en el release)', () => {
    assert.ok(fs.existsSync(path.join(userData, 'models', 'FlatModel', 'textures', 't0.png')));
    assert.ok(res.info.model3Path.startsWith(path.join(userData, 'models')));
    assert.ok(!fs.existsSync(path.join(bundledDir, 'FlatModel')));
  });
  check('persiste el modelo activo y avisa a las ventanas', () => {
    assert.deepEqual(saved.at(-1), { activeModel: 'FlatModel' });
    assert.ok(broadcasts.some((b) => b.channel === 'model-changed'));
  });

  // 2) .model3.json en subcarpeta (regresión del "No se pudo activar")
  const nested = makeModel(sources, 'NestedModel', { nested: 'runtime' });
  res = importModel(nested);
  check('importa y activa un modelo con .model3.json en runtime/', () => {
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(S.activeModelId, 'NestedModel');
    assert.ok(res.info.model3Path.endsWith(path.join('runtime', 'NestedModel.model3.json')));
  });

  // 3) listModels: importados + incluidos, con bandera `imported`
  const list = handlers.get('models-list')();
  check('models-list combina importados e incluidos', () => {
    const ids = list.map((m) => m.id);
    assert.ok(ids.includes('FlatModel') && ids.includes('NestedModel'));
    assert.equal(list.find((m) => m.id === 'FlatModel').imported, true);
    for (const b of bundledBefore) {
      const m = list.find((x) => x.id === b);
      if (m) assert.equal(m.imported, false);
    }
    assert.equal(list.filter((m) => m.active).length, 1);
  });

  // 4) reimportar el mismo modelo no falla
  res = importModel(flat);
  check('reimportar el mismo modelo funciona', () => assert.equal(res.ok, true));

  // 5) importar la copia ya importada (src === dest) solo activa
  res = importModel(path.join(userData, 'models', 'FlatModel'));
  check('importar la copia de userData solo la activa', () => assert.equal(res.ok, true));

  // 6) errores de validación
  check('ruta inválida / inexistente / archivo', () => {
    assert.match(importModel(undefined).error, /inválida/);
    assert.match(importModel(path.join(tmp, 'nope')).error, /no existe/);
    const file = path.join(tmp, 'file.txt');
    fs.writeFileSync(file, 'x');
    assert.match(importModel(file).error, /no es una carpeta/);
  });
  check('carpeta sin .model3.json: error y sin copiar nada', () => {
    const empty = path.join(sources, 'NoModel');
    fs.mkdirSync(empty, { recursive: true });
    assert.match(importModel(empty).error, /model3\.json/);
    assert.ok(!fs.existsSync(path.join(userData, 'models', 'NoModel')));
  });
  check('raíz de unidad: error claro', () => {
    assert.match(importModel(path.parse(tmp).root).error, /raíz de una unidad/);
  });

  // 7) fallo de copia: no deja carpetas huérfanas ni cambia el modelo activo
  const before = S.activeModelId;
  const blocker = path.join(tmp, 'blocker');
  fs.writeFileSync(blocker, 'x'); // userData cuelga de un archivo → mkdir falla
  userData = path.join(blocker, 'sub');
  res = importModel(makeModel(sources, 'WillFail'));
  check('si falla la copia devuelve error y no cambia el modelo activo', () => {
    assert.match(res.error, /No se pudo copiar el modelo/);
    assert.equal(S.activeModelId, before);
  });

  // 8) el directorio incluido en el release nunca se modifica
  check('el directorio models/ del release queda intacto', () => {
    const after = fs.existsSync(bundledDir) ? fs.readdirSync(bundledDir).sort() : [];
    assert.deepEqual(after, bundledBefore);
  });

  console.log(`\nModel import: ${passed} comprobaciones correctas.`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
