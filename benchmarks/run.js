'use strict';

/**
 * Runner del benchmark (§8 del roadmap).
 *
 * Para cada tarea:
 *   1. Copia el template a un workspace temporal limpio (git init incluido).
 *   2. Ejecuta Core.runAgent() en evalMode (harness) N veces (por defecto 3).
 *   3. Corre verify.sh sobre el workspace resultante.
 *   4. Acumula resultados en benchmarks/results/<id>.json (serie histórica).
 *
 * Uso:
 *   node benchmarks/run.js                       # todas las tareas, 3 corridas
 *   node benchmarks/run.js rename-multiply       # una tarea
 *   node benchmarks/run.js --runs=5 --tasks=rename-multiply
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const TASKS_DIR = path.join(ROOT, 'tasks');
const RESULTS_DIR = path.join(ROOT, 'results');

const args = process.argv.slice(2);
const runsArg = args.find((a) => a.startsWith('--runs='));
const RUNS = runsArg ? parseInt(runsArg.split('=')[1], 10) : 3;
const taskFilter = args.filter((a) => !a.startsWith('--'))[0];

/**
 * Fase 3, ítem 3: metadata del repositorio en el momento de la corrida, para
 * poder correlacionar el resultado con la versión del código bajo test.
 * Cualquier fallo de git degrada a null (el benchmark no debe morir por esto).
 * @returns {{ sha: string | null, date: string | null, dirty: boolean | null, branch: string | null }}
 */
function gitMeta() {
  const run = (cmd) => {
    try {
      return execFileSync('git', cmd, { cwd: ROOT, encoding: 'utf-8' }).trim() || null;
    } catch {
      return null;
    }
  };
  const dirty = (() => {
    try {
      const s = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf-8' });
      return s.trim().length > 0;
    } catch {
      return null;
    }
  })();
  return {
    sha: run(['rev-parse', 'HEAD']),
    date: run(['log', '-1', '--format=%cI']),
    dirty,
    branch: run(['rev-parse', '--abbrev-ref', 'HEAD']),
  };
}

function listTasks() {
  if (taskFilter) return [taskFilter];
  return fs
    .readdirSync(TASKS_DIR)
    .filter((d) => fs.existsSync(path.join(TASKS_DIR, d, 'task.json')));
}

function prepareWorkspace(taskDir, workspaceRel) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `bench-${path.basename(taskDir)}-`));
  const src = path.join(taskDir, workspaceRel);
  fs.cpSync(src, tmp, { recursive: true });
  fs.rmSync(path.join(tmp, '.git'), { recursive: true, force: true });
  execFileSync('git', ['init', '-q'], { cwd: tmp });
  execFileSync('git', ['add', '-A'], { cwd: tmp });
  execFileSync(
    'git',
    ['-c', 'user.email=bench@x', '-c', 'user.name=bench', 'commit', '-qm', 'init'],
    { cwd: tmp }
  );
  return tmp;
}

function loadResults(taskId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, `${taskId}.json`), 'utf-8'));
  } catch {
    return { id: taskId, runs: [] };
  }
}

function saveResults(taskId, data) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(RESULTS_DIR, `${taskId}.json`),
    JSON.stringify(data, null, 2),
    'utf-8'
  );
}

function runVerify(verifyPath, workspace) {
  try {
    const out = execFileSync('bash', [verifyPath, workspace], { encoding: 'utf-8' });
    return { pass: true, output: out.trim() };
  } catch (e) {
    return { pass: false, output: (e.stdout || e.message || '').trim() };
  }
}

/**
 * Fase 3, ítem 3: verificación "SWE-bench" real. `task.verifyTest` es un
 * comando shell que corre en el workspace de la tarea (típicamente
 * `node --test ...`); requiere exit 0 dentro de un timeout. Si la tarea no lo
 * define, la verificación se limita a verify.sh (gate estático).
 * @param {object} task
 * @param {string} workspace
 * @returns {{ pass: boolean, output: string | null, used: boolean }}
 */
function runVerifyTest(task, workspace) {
  if (!task.verifyTest) return { pass: true, output: null, used: false };
  const timeoutMs = task.verifyTestTimeoutMs || 120000;
  try {
    const out = execFileSync('bash', ['-c', task.verifyTest], {
      cwd: workspace,
      encoding: 'utf-8',
      timeout: timeoutMs,
    });
    return { pass: true, output: out.trim().slice(0, 500), used: true };
  } catch (e) {
    return {
      pass: false,
      output: ((e.stdout || '') + (e.stderr || e.message || '')).trim().slice(0, 500),
      used: true,
    };
  }
}

async function main() {
  const tasks = listTasks();
  if (tasks.length === 0) {
    console.error('No hay tareas de benchmark');
    process.exit(1);
  }
  console.log(`Benchmark: ${tasks.length} tarea(s) × ${RUNS} corrida(s)`);

  for (const taskId of tasks) {
    const taskDir = path.join(TASKS_DIR, taskId);
    const task = JSON.parse(fs.readFileSync(path.join(taskDir, 'task.json'), 'utf-8'));
    const verifyPath = path.join(taskDir, task.verify);
    const results = loadResults(taskId);

    console.log(`\n=== Tarea: ${task.title} ===`);

    for (let r = 1; r <= RUNS; r++) {
      const workspace = prepareWorkspace(taskDir, task.workspace);
      console.log(`\n--- Corrida ${r}/${RUNS} (workspace: ${workspace}) ---`);
      console.log(`Prompt: ${task.prompt}`);

      const { create } = require(path.join(ROOT, 'lib', 'harness.js'));
      const agent = await create({ workspace });
      let outcome;
      try {
        const res = await agent.run(task.prompt);
        const verify = runVerify(verifyPath, workspace);
        const verifyTest = runVerifyTest(task, workspace);
        const ok = verify.pass && verifyTest.pass;
        outcome = {
          ts: new Date().toISOString(),
          ok,
          iterations: res.iterations,
          elapsedMs: res.elapsedMs,
          error: res.error || null,
          errorDetail: res.response || null,
          truncated: res.truncated || false,
          verify: verify.output.slice(0, 500),
          verifyTest: verifyTest.output,
          git: gitMeta(),
          llm: res.llm || null,
        };
        console.log(
          `Resultado: ${ok ? 'PASS' : 'FAIL'} (${res.iterations} iter, ${res.elapsedMs}ms, ` +
            `${res.llm?.provider || '?'}/${res.llm?.model || '?'}, ` +
            `$ ${(res.llm?.costUsd || 0).toFixed(5)})`
        );
        if (!ok) {
          console.log(`  verify: ${verify.output.slice(0, 300)}`);
          if (verifyTest.output) console.log(`  verifyTest: ${verifyTest.output.slice(0, 300)}`);
        }
      } catch (e) {
        outcome = {
          ts: new Date().toISOString(),
          ok: false,
          iterations: 0,
          elapsedMs: 0,
          error: e.message,
          truncated: false,
          verify: '',
          verifyTest: null,
          git: gitMeta(),
          llm: null,
        };
        console.log(`Resultado: FAIL (error del harness: ${e.message})`);
      } finally {
        await agent.close();
      }

      results.runs.push(outcome);
      saveResults(taskId, results);
    }

    // Resumen de la tarea
    const last = results.runs.slice(-RUNS);
    const passed = last.filter((x) => x.ok).length;
    const avgMs = last.length
      ? Math.round(last.reduce((a, x) => a + (x.elapsedMs || 0), 0) / last.length)
      : 0;
    console.log(
      `\nTarea ${task.id}: ${passed}/${RUNS} (pass@${RUNS}) · avg ${avgMs}ms · histórico ${results.runs.length} corridas`
    );
  }

  // G.1: reporte final global — pass@RUNS por tarea + agregado (incluye coste).
  console.log('\n=== Resumen del benchmark ===');
  let totalPassed = 0;
  let totalRuns = 0;
  const rows = tasks.map((taskId) => {
    const data = loadResults(taskId);
    const last = data.runs.slice(-RUNS);
    const ok = last.filter((x) => x.ok).length;
    const avgMs = last.length
      ? Math.round(last.reduce((a, x) => a + (x.elapsedMs || 0), 0) / last.length)
      : 0;
    const avgCost = last.length
      ? last.reduce((a, x) => a + (x.llm?.costUsd || 0), 0) / last.length
      : 0;
    const avgIter = last.length
      ? Math.round(last.reduce((a, x) => a + (x.iterations || 0), 0) / last.length)
      : 0;
    totalPassed += ok;
    totalRuns += last.length;
    return {
      task: taskId,
      pass: `${ok}/${last.length}`,
      passK: last.length ? (ok / last.length).toFixed(2) : '-',
      avgMs,
      avgCost,
      avgIter,
    };
  });
  console.log(
    `  ${'TAREA'.padEnd(20)} ${'PASS@' + RUNS}  ${'avg ms'.padStart(8)}  ${'avg iter'.padStart(8)}  ${'avg $'.padStart(10)}`
  );
  for (const r of rows) {
    console.log(
      `  ${r.task.padEnd(20)} ${r.pass.padEnd(10)} ${String(r.avgMs).padStart(8)} ${String(r.avgIter).padStart(8)} ${r.avgCost.toFixed(5).padStart(10)}`
    );
  }
  if (totalRuns > 0) {
    console.log(
      `\n  GLOBAL pass@${RUNS}: ${totalPassed}/${totalRuns} (${(totalPassed / totalRuns).toFixed(2)})`
    );
  }

  console.log('\n=== Benchmark finalizado ===');
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
