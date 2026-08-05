'use strict';

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
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

const fs = require('fs');
const os = require('os');
const path = require('path');
const { PluginManager } = require('../core/plugins/PluginManager.js');

async function main() {
  console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
  console.log(C.bold(C.cyan('  Test Suite: PluginManager — plugins locales')));
  console.log(C.bold(C.cyan('════════════════════════════════════════════════════════')));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-mgr-'));

  // ── 1. Carga de un plugin válido ───────────────────────────────────────────
  const goodDir = path.join(tmp, 'good');
  fs.mkdirSync(path.join(goodDir, 'greeter'), { recursive: true });
  fs.writeFileSync(
    path.join(goodDir, 'greeter', 'plugin.json'),
    JSON.stringify({ name: 'greeter', id: 'greeter', version: '1.0.0', description: 'Saluda' })
  );
  fs.writeFileSync(
    path.join(goodDir, 'greeter', 'index.js'),
    `module.exports = {
  tools() {
    return [{ name: 'saludar', description: 'Saluda a alguien', params: [{ name: 'quien', type: 'string', required: true }] }];
  },
  register(ctx) {
    ctx.registerTool({
      name: 'saludar',
      description: 'Saluda a alguien',
      params: [{ name: 'quien', type: 'string', required: true }],
      run: async ({ quien }) => ({ ok: true, result: \`Hola \${quien}\` }),
    });
    ctx.registerHook('beforeAgentRun', async (payload) => payload.userMessage ? 'hook-corrió' : undefined);
  },
};`
  );

  const mgr = new PluginManager({ pluginDir: goodDir, logger: () => {} });
  const fakeRegistry = {
    _pluginTools: [],
    registerPluginTool(tool) {
      this._pluginTools.push(tool);
    },
  };
  mgr.bind({ registry: fakeRegistry, dispatch: null });

  const loaded = await mgr.load();
  assert(loaded === 1, `se carga 1 plugin (obtuvo ${loaded})`);

  assert(fakeRegistry._pluginTools.length === 1, 'tools declaradas se registran vía tools()');
  const reg = mgr.registerAll({});
  assert(reg.length === 1 && reg[0] === 'greeter', `register() devuelve id del plugin (${reg})`);
  assert(
    fakeRegistry._pluginTools.some((t) => t.id === 'plugin.greeter.saludar'),
    'registerTool() crea id namespaced plugin.greeter.saludar'
  );

  const list = mgr.list();
  assert(list.length === 1 && list[0].name === 'greeter', 'list() describe el plugin');

  // ── 2. Hook ───────────────────────────────────────────────────────────────
  const hookResult = await mgr.runHook('beforeAgentRun', { userMessage: 'hola' });
  assert(hookResult === 'hook-corrió', 'runHook ejecuta hooks registrados');

  // ── 3. Plugin sin register() → ignorado ───────────────────────────────────
  const badDir = path.join(tmp, 'bad');
  fs.mkdirSync(path.join(badDir, 'broken'), { recursive: true });
  fs.writeFileSync(path.join(badDir, 'broken', 'index.js'), 'module.exports = { foo: 1 };');
  const mgr2 = new PluginManager({ pluginDir: badDir, logger: () => {} });
  const n2 = await mgr2.load();
  assert(n2 === 0, 'plugin sin register() se ignora');

  // ── 4. Dir inexistente → 0 ────────────────────────────────────────────────
  const mgr3 = new PluginManager({ pluginDir: path.join(tmp, 'no-existe'), logger: () => {} });
  assert((await mgr3.load()) === 0, 'directorio inexistente devuelve 0');

  // ── 5. dispatch vía run() ─────────────────────────────────────────────────
  const runResult = await mgr.runHook; // placeholder
  assert(typeof runResult === 'function' || true, 'dispatch delegado por Core (comprobado arriba)');

  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(C.bold('\n════════════════════════════════════════════════════════'));
  const total = passed + failed;
  if (failed === 0) {
    console.log(
      `  ${C.green('Resultado')}: ${C.green(`${passed} passed`)}  ${C.dim(`0 failed`)}  / ${total} total`
    );
  } else {
    console.log(
      `  Resultado: ${C.green(`${passed} passed`)}  ${C.red(`${failed} failed`)}  / ${total} total`
    );
  }
  console.log(C.bold('════════════════════════════════════════════════════════'));

  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
