'use strict';

/**
 * test_openclaw_node_eval.js — regresión del bug de verificación JS en exec.
 *
 * El agente verificaba lógica JS con `node -e 'script'` (script multilínea,
 * con comillas) y fallaba 2 veces con "-e requires an argument", y luego con
 * heredocs que dependen de shell. Causa raíz: sin un shell real, el
 * tokenizador no puede manejar de forma fiable el script inline (comillas
 * anidadas, saltos de línea, backslashes de regex, operadores JS `||`/`&&`/
 * `;` que la detección de shell malinterpreta, y el script vacío que se
 * descartaba → "-e requires an argument").
 *
 * Fix: `node -e 'script'` con el script entre comillas se reescribe a
 * `node -` pasándolo por stdin — el mismo modo de evaluación que `node -e`
 * (require relativo al cwd, top-level await), sin escape de por medio.
 *
 * Correr igual que las demás suites (Node de Electron):
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron tests/test_openclaw_node_eval.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

let passed = 0;
let failed = 0;
let skipped = 0;

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

const skip = (label) => {
  console.log(`  ${C.yellow('⊘')} ${label}`);
  skipped++;
};

const srv = require('../openclaw-server.js');

// ── Test 1: _extractNodeEvalScript (pura, sin server) ───────────────────────

function testExtract() {
  console.log(C.bold('\nTest 1: _extractNodeEvalScript extrae el script crudo'));

  const eq = (cmd, expectedScript, label) => {
    const r = srv._extractNodeEvalScript(cmd);
    assert(r && r.script === expectedScript, label, JSON.stringify(r));
  };
  const nul = (cmd, label) => {
    const r = srv._extractNodeEvalScript(cmd);
    assert(r === null, label, JSON.stringify(r));
  };

  eq(`node -e 'console.log(2+2)'`, 'console.log(2+2)', 'comillas simples');
  eq(
    `node -e '\\nconst a = 1;\\nconsole.log(a);\\n'`,
    '\\nconst a = 1;\\nconsole.log(a);\\n',
    'multilínea con comillas simples'
  );
  eq(
    `node -e "console.log('hi'); console.log(2+2)"`,
    "console.log('hi'); console.log(2+2)",
    'comillas dobles con simples adentro'
  );
  eq(
    `node -e "console.log(\\"x\\ty\\")"`,
    'console.log(\\"x\\ty\\")',
    'comillas dobles con escapes preservados (verbatim)'
  );
  eq(
    `node -e 'const m = "a1".match(/\\d/);'`,
    'const m = "a1".match(/\\d/);',
    'backslash de regex se preserva tal cual'
  );
  eq(`node -e ''`, '', 'script vacío se extrae (ya no "-e requires an argument")');
  eq(`nodejs -e 'console.log(1)'`, 'console.log(1)', 'alias nodejs');
  eq(`node --eval 'console.log(1)'`, 'console.log(1)', '--eval largo');
  eq(`  node -e 'x'`, 'x', 'whitespace inicial tolerado');

  nul(`node -e console.log(1)`, 'sin comillas → no se reescribe (camino normal)');
  nul(`node -e 'x' | grep y`, 'contenido tras el cierre → no se reescribe');
  nul(`node -e 'sin cerrar`, 'comilla sin cerrar → no se reescribe');
  nul(`npm test`, 'no es node -e → null');
  nul(`node -e`, 'node -e sin script → null');

  console.log(C.bold('  _scriptReadsStdin'));
  assert(srv._scriptReadsStdin("process.stdin.on('data')"), 'process.stdin → true');
  assert(srv._scriptReadsStdin("require('readline')"), 'readline → true');
  assert(!srv._scriptReadsStdin("console.log('x')"), 'script normal → false');
  assert(!srv._scriptReadsStdin('const a = 1;'), 'código simple → false');
}

// ── Test 2: exec real con node -e (los escenarios que fallaban) ─────────────

async function testExecNodeEval() {
  console.log(C.bold('\nTest 2: exec real con node -e (escenarios de producción)'));

  const node = srv._whichBin('node');
  if (!node) {
    skip('node no está en el host — ejecución real omitida');
    return;
  }

  const ok = (r, label) =>
    assert(r && r.result && r.result.exitCode === 0, label, r && r.result ? r.result.stderr : '');
  const out = (r) => (r && r.result ? r.result.stdout : '');

  // El fallo reportado: `node -e` con script multilínea con comillas.
  const r1 = await srv.HANDLERS.exec({
    command: `node -e '\nconst a = 40 + 2;\nconsole.log("result=" + a);\n'`,
    timeout: 15,
  });
  ok(r1, 'node -e multilínea con comillas → exit 0 (antes fallaba el escape)');
  if (r1 && r1.result && r1.result.exitCode === 0) {
    assert(out(r1).includes('result=42'), 'el script multilínea corrió de verdad');
  }

  // El otro fallo reportado: "-e requires an argument" (script vacío o arg perdido).
  const r2 = await srv.HANDLERS.exec({ command: `node -e ''`, timeout: 15 });
  ok(r2, 'node -e con script vacío → exit 0 (antes "-e requires an argument")');

  // Operadores JS que la detección de shell mandaba a sh -c (y sh mangleaba).
  const r3 = await srv.HANDLERS.exec({
    command: `node -e '\nconst a = 1 || 2;\nconst b = 3 && 4;\nif (a !== 1 || b !== 4) process.exit(1);\nconsole.log("ops-ok");\n'`,
    timeout: 15,
  });
  ok(r3, '|| / && dentro del script → exit 0 (no pasan por sh -c corruptor)');
  if (r3 && r3.result && r3.result.exitCode === 0) {
    assert(out(r3).includes('ops-ok'), 'los operadores JS se evaluaron bien');
  }

  const r4 = await srv.HANDLERS.exec({
    command: `node -e '\nconsole.log("a");\nconsole.log("b");\n'`,
    timeout: 15,
  });
  ok(r4, '; y múltiples líneas → exit 0');
  if (r4 && r4.result && r4.result.exitCode === 0) {
    assert(out(r4).includes('a') && out(r4).includes('b'), 'ambas líneas del script corrieron');
  }

  // Top-level await (verificación asíncrona) — node -e lo soporta.
  const r5 = await srv.HANDLERS.exec({
    command: `node -e '\nconst v = await Promise.resolve(7);\nconsole.log("tla=" + v);\n'`,
    timeout: 15,
  });
  ok(r5, 'top-level await en node -e → exit 0');
  if (r5 && r5.result && r5.result.exitCode === 0) {
    assert(out(r5).includes('tla=7'), 'el await se evaluó');
  }

  // Regex con backslash (el tokenizador se comía la \ antes).
  const r6 = await srv.HANDLERS.exec({
    command: `node -e '\nconst m = "a1".match(/\\d/);\nconsole.log(m && m[0]);\n'`,
    timeout: 15,
  });
  ok(r6, 'regex con \\d → exit 0 (backslash no se corrompe)');
  if (r6 && r6.result && r6.result.exitCode === 0) {
    assert(out(r6).includes('1'), 'la regex corrió de verdad');
  }

  // Sin regresión: programa interactivo con stdin explícito sigue funcionando
  // (ahí NO se reescribe a node -; el script va inline y lee su propio stdin).
  const r7 = await srv.HANDLERS.exec({
    command: `node -e "const r=require('readline').createInterface({input:process.stdin});r.question('num',a=>{console.log('r:'+a);r.close();})"`,
    stdin: '7\n',
    timeout: 15,
  });
  ok(r7, 'readline con stdin → exit 0 (sin regresión)');
  if (r7 && r7.result && r7.result.exitCode === 0) {
    assert(out(r7).includes('r:7'), 'el input llega al programa interactivo');
  }

  // Sin regresión: script que LEE su stdin con stdin cerrado → EOF, no timeout.
  const r8 = await srv.HANDLERS.exec({
    command: `node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log('eof:'+s);process.exit(0)});setTimeout(()=>{console.log('timeout!');process.exit(1)},4000)"`,
    timeout: 15,
  });
  ok(r8, 'script que lee stdin con stdin cerrado → exit 0 (EOF, no timeout)');
  if (r8 && r8.result && r8.result.exitCode === 0) {
    assert(out(r8).includes('eof:'), 'el EOF llega al script');
  }

  // require relativo al cwd (verificar módulos del proyecto) sigue resolviendo
  // desde el workspace, igual que node -e.
  const fixture = `.node-req-fixture-${crypto.randomBytes(4).toString('hex')}.js`;
  try {
    fs.writeFileSync(path.join(process.cwd(), fixture), 'module.exports = 42;', 'utf8');
    const r9 = await srv.HANDLERS.exec({
      command: `node -e '\nconst v = require("./${fixture}");\nconsole.log("req=" + v);\n'`,
      timeout: 15,
    });
    ok(r9, 'require("./...") relativo al cwd → exit 0');
    if (r9 && r9.result && r9.result.exitCode === 0) {
      assert(out(r9).includes('req=42'), 'el módulo del workspace se requirió');
    }
  } finally {
    try {
      fs.rmSync(path.join(process.cwd(), fixture), { force: true });
    } catch {}
  }

  // Pipeline REAL completo A — bloque estructurado con COMANDO de 1 línea
  // (punto y coma entre sentencias + \n dentro de un string JS) →
  // StructuredActionParser → command → exec del server.
  const { getStructuredActionParser } = require('../core/planner/StructuredActionParser.js');
  const parser = getStructuredActionParser(process.cwd());
  const parsed = parser.parse(
    '```action\nACCIÓN: run_command | COMANDO: node -e \'const a = 40 + 2; if (a !== 42) process.exit(1); console.log("pipeline-ok\\nvia-string");\'\n```',
    null
  );
  const act = parsed && parsed.find((x) => x.tool === 'exec');
  assert(!!act, 'parser: COMANDO de 1 línea se preserva completo', JSON.stringify(parsed));
  if (act) {
    const r10 = await srv.HANDLERS.exec({ command: act.params.command, timeout: 15 });
    ok(r10, 'pipeline A parser→exec: node -e 1-línea → exit 0');
    if (r10 && r10.result && r10.result.exitCode === 0) {
      assert(out(r10).includes('pipeline-ok'), 'el script verificó de verdad');
    }
  }

  // Pipeline REAL completo B — COMANDO multilínea (script `node -e` con
  // saltos de línea reales, tal como el LLM lo escribe en el bloque): el span
  // de COMANDO del parser lo preserva entero y el exec lo evalúa por stdin.
  const blockB = [
    '```action',
    'ACCIÓN: run_command',
    "COMANDO: node -e '",
    'const b = 40 + 2;',
    'if (b !== 42) process.exit(1);',
    'console.log("pipeline-multiline-ok");',
    "'",
    '```',
  ].join('\n');
  const parsedB = parser.parse(blockB, null);
  const actB = parsedB && parsedB.find((x) => x.tool === 'exec');
  assert(
    !!actB && typeof actB.params.command === 'string' && actB.params.command.includes('\n'),
    'parser: COMANDO multilínea se preserva completo',
    JSON.stringify(parsedB)
  );
  if (actB) {
    const r11 = await srv.HANDLERS.exec({ command: actB.params.command, timeout: 15 });
    ok(r11, 'pipeline B parser→exec: node -e multilínea → exit 0');
    if (r11 && r11.result && r11.result.exitCode === 0) {
      assert(out(r11).includes('pipeline-multiline-ok'), 'el script multilínea verificó de verdad');
    }
  }
}

// ── Runner ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(C.bold(C.cyan('\nnode -e en exec sin shell (regresión verificación JS)')));

  testExtract();
  await testExecNodeEval();

  console.log(C.bold('\n════════════════════════════════════════════════════════'));
  const total = passed + failed + skipped;
  const color = failed === 0 ? C.green : C.red;
  console.log(
    `  ${color('Resultado')}: ${C.green(`${passed} passed`)}  ${C.red(`${failed} failed`)}  ${C.yellow(`${skipped} skipped`)}  / ${total} total`
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(C.red('Fallo en la ejecución de la suite:'), e);
  process.exit(1);
});
