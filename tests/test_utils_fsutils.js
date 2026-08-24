// @ts-nocheck
'use strict';
// test_utils_fsutils.js — readJsonFile (nunca lanza), appendJsonLine (JSONL,
// nunca lanza) y delay.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
let passed = 0;
const t = (c, m) => { assert(c, m); passed++; console.log('  ✓', m); };

const { readJsonFile, appendJsonLine, delay } = require('../core/utils/fsUtils.js');

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsutils-'));
  const file = path.join(dir, 'data.json');

  // ── readJsonFile ──
  fs.writeFileSync(file, JSON.stringify({ a: 1, lista: [2, 3] }));
  const ok = readJsonFile(file, null);
  t(ok && ok.a === 1 && Array.isArray(ok.lista), 'JSON válido se parsea');

  t(readJsonFile(path.join(dir, 'no-existe.json'), 'fallback') === 'fallback', 'archivo inexistente → fallback');
  t(readJsonFile('', 'fb') === 'fb', 'path vacío → fallback');

  fs.writeFileSync(path.join(dir, 'roto.json'), '{esto no es json,,');
  t(readJsonFile(path.join(dir, 'roto.json'), null) === null, 'JSON inválido → fallback');

  // Un objeto vacío es un valor legítimo: el fallback NO lo pisa.
  fs.writeFileSync(path.join(dir, 'vacio.json'), '{}');
  const empty = readJsonFile(path.join(dir, 'vacio.json'), 'fb');
  t(typeof empty === 'object' && empty !== null, 'objeto {} válido no se confunde con fallback');

  // ── appendJsonLine ──
  const jsonl = path.join(dir, 'events.jsonl');
  appendJsonLine(jsonl, { ev: 1 });
  appendJsonLine(jsonl, { ev: 2 });
  const lines = fs.readFileSync(jsonl, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
  t(lines.length === 2 && lines[0].ev === 1 && lines[1].ev === 2, 'dos appends → dos líneas JSONL parseables');

  // Borde: append a directorio inexistente no lanza (falla en silencio).
  let threw = false;
  try {
    appendJsonLine(path.join(dir, 'no', 'existe', 'x.jsonl'), { a: 1 });
  } catch {
    threw = true;
  }
  t(threw === false, 'append a ruta imposible NUNCA lanza');

  // ── delay ──
  const t0 = Date.now();
  await delay(60);
  const elapsed = Date.now() - t0;
  t(elapsed >= 50, `delay(60) espera al menos ~50ms (${elapsed}ms)`);

  await delay(0); // resuelve sin colgarse

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\nResultado: ${passed} passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
