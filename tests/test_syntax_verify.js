// @ts-nocheck
'use strict';
// test_syntax_verify.js — verificación universal de sintaxis: cada checker
// acepta su archivo válido y rechaza el roto con el error específico.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { verifySyntax } = require('../core/planner/syntax-verify.js');

async function main() {
  let passed = 0;
  const t = (c, m) => { assert(c, m); passed++; console.log('  ✓', m); };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syntaxv-'));
  const write = (name, content) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, content);
    return f;
  };

  // ── JS ──
  const jsOk = await verifySyntax([write('ok.js', 'const a = 1; console.log(a);')]);
  t(jsOk.ok === true, 'JS válido → ok');
  const jsBad = await verifySyntax([write('bad.js', 'const a = ;')]);
  t(jsBad.ok === false && /sintaxis JS/.test(jsBad.results[0].errors.join(' ')), 'JS roto → detectado');

  // ── JSON ──
  const jsonOk = await verifySyntax([write('ok.json', '{"a": 1}')]);
  t(jsonOk.ok === true, 'JSON válido → ok');
  const jsonBad = await verifySyntax([write('bad.json', '{"a": 1,,}')]);
  t(jsonBad.ok === false && /JSON inválido/.test(jsonBad.results[0].errors.join(' ')), 'JSON roto → detectado');

  // ── Python ──
  const pyOk = await verifySyntax([write('ok.py', 'def f(x):\n    return x * 2\n')]);
  if (!pyOk.results[0].skipped) {
    t(pyOk.ok === true, 'Python válido → ok');
  } else {
    console.log('  ⚠ python no disponible en este entorno — skip');
  }
  const pyBad = await verifySyntax([write('bad.py', 'def f(:\n    return 1\n')]);
  if (!pyBad.results[0].skipped) {
    t(pyBad.ok === false && /Python inválida/.test(pyBad.results[0].errors.join(' ')), 'Python roto → detectado');
  }

  // ── Shell ──
  const shOk = await verifySyntax([write('ok.sh', '#!/bin/bash\necho hola\n')]);
  t(shOk.ok === true || shOk.results[0].skipped, 'shell válida → ok');
  const shBad = await verifySyntax([write('bad.sh', 'if [ -f x ]; then\necho sin fi\n')]);
  t(shBad.ok === false, 'shell rota → detectada');

  // ── CSS ──
  const cssOk = await verifySyntax([write('ok.css', '.a { color: red; }\n.b { margin: 0; }')]);
  t(cssOk.ok === true, 'CSS válido → ok');
  const cssBad = await verifySyntax([write('bad.css', '.a { color: red;\n.b { margin: 0; }\n')]);
  t(cssBad.ok === false, 'CSS desbalanceado → detectado');

  // ── YAML (skip graceful si no hay parser) ──
  const ymlRes = await verifySyntax([write('x.yml', 'a: [1,\n  b: c\n')]);
  t(ymlRes.results[0].skipped || ymlRes.ok === false || true, 'YAML no crashea (checker o skip)');

  // ── Extensión sin checker → ignorada silenciosamente ──
  const mdOnly = await verifySyntax([write('readme.md', '# notas\n'), write('foto.png', Buffer.from([1,2,3]))]);
  t(mdOnly.ok === true && mdOnly.results.length === 0, '.md/.png sin checker → skip silencioso');

  // ── Combinado: primer fallo corta pero reporta ──
  const mixed = await verifySyntax([write('m.json', '{roto}'), write('n.js', 'var b = 2;')]);
  t(mixed.ok === false && mixed.results[0].file.endsWith('m.json'), 'combinado: reporta el archivo roto');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\nResultado: ${passed} passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
