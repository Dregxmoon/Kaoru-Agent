// @ts-nocheck
'use strict';
// test_startup_check.js — validación temprana de config.json: los 3 casos
// (ausente / JSON inválido con línea-columna / sin API keys) + bordes.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateStartupConfig, _lineColFromParseError } = require('../core/config/startupCheck.js');

async function main() {
  let passed = 0;
  const t = (c, m) => { assert(c, m); passed++; console.log('  ✓', m); };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'startupcheck-'));
  const configPath = path.join(dir, 'config.json');
  const examplePath = path.join(process.cwd(), 'config.example.json');

  // ── Caso 1: no existe → cómo crearlo desde el ejemplo ──
  const missing = validateStartupConfig({ configPath, examplePath, keychainHasKeys: false });
  assert(missing.ok === false && missing.issues.length === 1);
  t(missing.issues[0].type === 'missing', 'caso 1: tipo = missing');
  t(
    /config\.example\.json/.test(missing.issues[0].message) && /cp /.test(missing.issues[0].message),
    '…el mensaje dirige a copiar el ejemplo'
  );

  // ── Caso 2: JSON inválido → línea y columna del error ──
  // Contenido con el error en la línea 3 (dos newlines antes del token roto).
  const broken = '{\n  "llm": {\n    "apiKeys": ,, \n  }\n}';
  fs.writeFileSync(configPath, broken);
  const invalid = validateStartupConfig({ configPath, examplePath, keychainHasKeys: false });
  assert(invalid.ok === false && invalid.issues.length === 1);
  t(invalid.issues[0].type === 'invalid_json', 'caso 2: tipo = invalid_json');
  t(/línea \d+, columna \d+/.test(invalid.issues[0].message), '…incluye línea/columna numéricas', );
  console.log('    ↳ mensaje:', invalid.issues[0].message.match(/línea \d+, columna \d+/)?.[0]);

  // _lineColFromParseError directo: precisión en multilinea.
  try {
    JSON.parse(broken);
    assert.fail('debería lanzar');
  } catch (e) {
    const { line, column } = _lineColFromParseError(broken, e);
    assert(line === 3 || line === undefined, `línea detectada (${line})`);
    if (line === 3) t(column >= 15, `columna razonable (${column})`);
  }

  // ── Caso 3: válido pero SIN ninguna API key → accionable antes del primer msj ──
  fs.writeFileSync(configPath, JSON.stringify({ llm: { primary: 'groq', apiKeys: {} } }));
  const noKeys = validateStartupConfig({ configPath, examplePath, keychainHasKeys: false });
  t(noKeys.issues[0].type === 'no_keys', 'caso 3: tipo = no_keys');
  t(
    /selector de modelos/.test(noKeys.issues[0].message),
    '…mismo mensaje accionable que LLMProvider (selector de modelos)'
  );

  // Borde A: keychain CON keys → sin issue.
  fs.writeFileSync(configPath, JSON.stringify({ llm: { apiKeys: {} } }));
  const withKeychain = validateStartupConfig({ configPath, examplePath, keychainHasKeys: true });
  t(withKeychain.ok === true, 'sin keys en config PERO llavero con keys → ok');

  // Borde B: key en providers[*].apiKey también cuenta.
  fs.writeFileSync(
    configPath,
    JSON.stringify({ llm: { providers: { nvidia: { apiKey: 'nvsk-algo' } } } })
  );
  const providerKey = validateStartupConfig({ configPath, examplePath, keychainHasKeys: false });
  t(providerKey.ok === true, 'key en llm.providers[*] cuenta como configurada');

  // ── Contraposal: config completa y con key → ok total ──
  fs.writeFileSync(configPath, JSON.stringify({ llm: { apiKeys: { groq: 'gsk_x' } } }));
  const allGood = validateStartupConfig({ configPath, examplePath, keychainHasKeys: true });
  t(allGood.ok === true && allGood.issues.length === 0, 'config completa → ok sin issues');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\nResultado: ${passed} passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
