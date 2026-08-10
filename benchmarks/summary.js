'use strict';

/**
 * benchmarks/summary.js — Fase 3, ítem 3: resumen histórico del benchmark.
 *
 * Agrega benchmarks/results/<task>.json y compara la serie:
 *   - pass@N de la última ventana vs la anterior (regresión/mejora).
 *   - latencia, iteraciones y coste medio por corrida.
 *   - desglose por proveedor/modelo (última ventana).
 *
 * Uso:
 *   node benchmarks/summary.js                     # todas las tareas
 *   node benchmarks/summary.js rename-multiply     # una tarea
 *   node benchmarks/summary.js --runs=5            # ventana de comparación
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const RESULTS_DIR = path.join(ROOT, 'results');

const args = process.argv.slice(2);
const runsArg = args.find((a) => a.startsWith('--runs='));
const WINDOW = runsArg ? parseInt(runsArg.split('=')[1], 10) : 3;
const taskFilter = args.filter((a) => !a.startsWith('--'))[0];

function listResultFiles() {
  if (taskFilter) return [path.join(RESULTS_DIR, `${taskFilter}.json`)];
  return fs
    .readdirSync(RESULTS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.join(RESULTS_DIR, f));
}

/** @param {object[]} runs @returns {number} */
function passRate(runs) {
  if (!runs.length) return null;
  return runs.filter((r) => r.ok).length / runs.length;
}

/** @param {object[]} runs @returns {number} */
function avg(runs, key) {
  const list = runs.filter((r) => typeof r[key] === 'number');
  if (!list.length) return null;
  return list.reduce((a, r) => a + r[key], 0) / list.length;
}

function fmtPct(rate) {
  return rate === null ? '-' : `${(rate * 100).toFixed(0)}%`;
}

function main() {
  const files = listResultFiles();
  if (files.length === 0) {
    console.log('No hay resultados en benchmarks/results/ (corré `npm run bench` primero).');
    process.exit(0);
  }

  console.log(`=== Resumen histórico (ventana de comparación: últimas ${WINDOW} corridas) ===\n`);
  console.log(
    `  ${'TAREA'.padEnd(20)} ${'total'.padStart(5)} ${'pass@W'.padStart(7)} ${'prev@W'.padStart(7)} ${'Δ'.padStart(6)}  ${'avg ms'.padStart(8)} ${'avg iter'.padStart(8)} ${'avg $'.padStart(10)}`
  );

  /** @type {Record<string, { runs: number, pass: number, costUsd: number }>} */
  const byLLM = {};
  let globalTotal = 0;
  let globalPass = 0;

  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const runs = data.runs || [];
    if (!runs.length) continue;
    const last = runs.slice(-WINDOW);
    const prev = runs.slice(-2 * WINDOW, -WINDOW);
    const lastRate = passRate(last);
    const prevRate = passRate(prev);
    const delta = lastRate !== null && prevRate !== null ? lastRate - prevRate : null;
    const avgMs = avg(last, 'elapsedMs');
    const avgIter = avg(last, 'iterations');
    const costPerRun = last.reduce((a, r) => a + (r.llm?.costUsd || 0), 0) / last.length;

    globalTotal += last.length;
    globalPass += last.filter((r) => r.ok).length;

    const deltaStr = delta === null ? '-' : `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(0)}%`;
    const fmtAvg = (v) => (v === null ? '-' : String(Math.round(v)));
    console.log(
      `  ${String(data.id || path.basename(file, '.json')).padEnd(20)} ` +
        `${String(runs.length).padStart(5)} ${fmtPct(lastRate).padStart(7)} ${fmtPct(prevRate).padStart(7)} ${deltaStr.padStart(6)}  ` +
        `${fmtAvg(avgMs).padStart(8)} ${fmtAvg(avgIter).padStart(8)} ${costPerRun.toFixed(5).padStart(10)}`
    );

    // Desglose por proveedor/modelo en la última ventana.
    for (const r of last) {
      const llm = r.llm;
      if (!llm) continue;
      const key = `${llm.provider || '?'}/${llm.model || '?'}`;
      const e = (byLLM[key] ||= { runs: 0, pass: 0, costUsd: 0 });
      e.runs += 1;
      if (r.ok) e.pass += 1;
      e.costUsd += llm.costUsd || 0;
    }
  }

  const byLLMKeys = Object.keys(byLLM);
  if (byLLMKeys.length) {
    console.log(`\n=== Por proveedor/modelo (última ventana) ===`);
    console.log(
      `  ${'PROVEEDOR/MODELO'.padEnd(42)} ${'runs'.padStart(5)} ${'pass%'.padStart(6)} ${'avg $/run'.padStart(10)}`
    );
    for (const key of byLLMKeys.sort()) {
      const e = byLLM[key];
      console.log(
        `  ${key.padEnd(42)} ${String(e.runs).padStart(5)} ${fmtPct(e.pass / e.runs).padStart(6)} ${(e.costUsd / e.runs).toFixed(5).padStart(10)}`
      );
    }
  }

  if (globalTotal > 0) {
    console.log(
      `\n  GLOBAL (última ventana): ${globalPass}/${globalTotal} (${fmtPct(globalPass / globalTotal)})`
    );
  }
  console.log('\n=== Fin del resumen ===');
}

try {
  main();
} catch (e) {
  console.error('FATAL:', e.message);
  process.exit(1);
}
