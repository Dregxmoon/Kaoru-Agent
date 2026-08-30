// @ts-nocheck
'use strict';
// test_web_verify.js — validación automática de artefactos web (pipeline
// AgentLoop): páginas buenas pasan, rotas se detectan con su error exacto.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { verifyHtmlFiles, _loadChromium } = require('../core/planner/web-verify.js');

async function main() {
  if (!_loadChromium()) {
    console.log('playwright no disponible — suite omitida');
    return;
  }
  let passed = 0;
  const t = (c, m) => {
    assert(c, m);
    passed++;
    console.log('  ✓', m);
  };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webverify-'));

  // 1. Página limpia → ok
  const good = path.join(dir, 'good.html');
  fs.writeFileSync(good, '<!DOCTYPE html><html><body><h1>hola</h1></body></html>');
  const rGood = await verifyHtmlFiles([good]);
  t(rGood.ok === true, 'página sin errores → ok');

  // 2. Página con excepción JS → detectada con mensaje
  const bad = path.join(dir, 'bad.js.html');
  fs.writeFileSync(
    bad,
    '<!DOCTYPE html><html><body><script>variableInexistente.x();</script></body></html>'
  );
  const rBad = await verifyHtmlFiles([bad]);
  t(rBad.ok === false, 'página con excepción → NO ok');
  t(
    /variableInexistente is not defined/i.test((rBad.results[0].errors || []).join(' ')),
    'el error reportado menciona la causa'
  );

  // 3. Sin archivos → ok trivial
  t((await verifyHtmlFiles([])).ok === true, 'lista vacía → ok');

  // 4. Límite de archivos (maxFiles)
  const many = ['a', 'b', 'c', 'd', 'e'].map((n) => {
    const f = path.join(dir, `${n}.html`);
    fs.writeFileSync(f, '<html><body>ok</body></html>');
    return f;
  });
  const rMany = await verifyHtmlFiles(many);
  t(rMany.results.length <= 3, `maxFiles=3 respeta el corte (${rMany.results.length})`);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\nResultado: ${passed} passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
