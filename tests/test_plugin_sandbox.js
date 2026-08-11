'use strict';

// test_plugin_sandbox.js — sandbox real para plugins (VM con acceso mediado)
// + firmado Ed25519 (PluginSigner) + marketplace firmado (PluginMarketplace).
//
// Verifica:
//   Sandbox:      el plugin corre en la VM (API intacta), require whitelist,
//                 requires relativos, `fs` mediado (dentro sí, fuera NO),
//                 módulos peligrosos rechazados, `process.env` congelado.
//   Firmado:      sign → verify ok; tocar index.js o el manifest → firma rota.
//   Manager:      requireSigned acepta firmado y rechaza sin-firma; rechaza
//                 firma inválida.
//   Marketplace:  índice firmado list()/verifyPackage/install de punta a punta.

const fs = require('fs');
const os = require('os');
const path = require('path');

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

const { PluginManager } = require('../core/plugins/PluginManager.js');
const { PluginSandbox } = require('../core/plugins/PluginSandbox.js');
const {
  generateKeyPair,
  signPlugin,
  verifyPlugin,
  ALGORITHM,
} = require('../core/plugins/PluginSigner.js');
const { PluginMarketplace } = require('../core/plugins/PluginMarketplace.js');

function makePluginDir(root, id, indexCode, manifestExtra = {}) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'plugin.json'),
    JSON.stringify({
      name: id,
      id,
      version: '1.0.0',
      description: 'plugin de prueba',
      ...manifestExtra,
    })
  );
  fs.writeFileSync(path.join(dir, 'index.js'), indexCode);
  return dir;
}

function fakeRegistry() {
  const r = {
    tools: [],
    registerPluginTool(tool) {
      this.tools.push(tool);
    },
  };
  return r;
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-sbx-'));

  // ══ 1. Sandbox: API del plugin intacta bajo la VM ══════════════════════════
  console.log(C.bold('\n── Test 1: sandbox conserva el contrato del plugin ──'));
  {
    const root = path.join(tmp, 't1');
    const dir = makePluginDir(
      root,
      'greeter',
      `module.exports = {
  tools() {
    return [{ name: 'saludar', description: 'Saluda', params: [] }];
  },
  register(ctx) {
    ctx.registerTool({
      name: 'saludar',
      description: 'Saluda',
      run: async ({ quien }) => ({ ok: true, result: 'Hola ' + quien }),
    });
    ctx.registerHook('beforeAgentRun', async () => 'hook-ok');
  },
};`
    );
    const mgr = new PluginManager({ pluginDir: root, logger: () => {} });
    const reg = fakeRegistry();
    mgr.bind({ registry: reg, dispatch: null });
    assert((await mgr.load()) === 1, 'plugin se carga en la VM');
    const registered = mgr.registerAll({});
    assert(
      registered.length === 1 && registered[0] === 'greeter',
      'register() corre dentro de la VM'
    );
    const tool = reg.tools.find(
      (t) => t.id === 'plugin.greeter.saludar' && typeof t.run === 'function'
    );
    assert(!!tool, 'registerTool() registra la tool desde la VM');
    const out = await tool.run({ quien: 'mundo' });
    assert(
      out.ok && out.result === 'Hola mundo',
      'la tool run() funciona cross-realm',
      JSON.stringify(out)
    );
    assert(
      (await mgr.runHook('beforeAgentRun', {})) === 'hook-ok',
      'runHook ejecuta hooks de la VM'
    );
  }

  // ══ 2. Sandbox: builtins whitelist + require relativo ═════════════════════
  console.log(C.bold('\n── Test 2: require mediado (whitelist + relativo) ──'));
  {
    const dir = path.join(tmp, 't2');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'helper.js'),
      `module.exports = { greet: (n) => 'hola ' + n };`
    );
    fs.writeFileSync(
      path.join(dir, 'index.js'),
      `const pathMod = require('path');
const helper = require('./helper.js');
module.exports = { register(ctx) {
  ctx.registerTool({
    name: 'pep',
    run: async () => ({ ok: true, result: helper.greet('x') + '|' + pathMod.basename('/a/b/c.js') }),
  });
} };`
    );
    const sandbox = new PluginSandbox({ root: dir, tag: 't2', logger: () => {} });
    const api = sandbox.load(path.join(dir, 'index.js'));
    let result;
    api.register({
      registerTool(t) {
        result = t;
      },
      registerHook() {},
    });
    const r = await result.run({});
    assert(r.result === 'hola x|c.js', 'whitelist (path) y require relativo funcionan', r.result);
  }

  // ══ 3. Sandbox: fs mediado — dentro SÍ, fuera NO ═════════════════════════
  console.log(C.bold('\n── Test 3: fs mediado (contención por directorio) ──'));
  {
    const dir = path.join(tmp, 't3');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'index.js'),
      `const fsMod = require('fs');
module.exports = { register(ctx) {
  ctx.registerTool({
    name: 'leer',
    run: async ({ modo }) => {
      if (modo === 'dentro') {
        fsMod.writeFileSync('memo.txt', 'contenido del plugin');
        return { ok: true, result: fsMod.readFileSync('memo.txt', 'utf8') };
      }
      if (modo === 'fuera') {
        try {
          fsMod.readFileSync('../../../etc/hostname', 'utf8');
          return { ok: true, result: 'LEIDO_FUERA' };
        } catch (e) {
          return { ok: false, result: 'BLOQUEADO: ' + e.message };
        }
      }
      return { ok: true, result: 'env=' + JSON.stringify(process.env) };
    },
  });
} };`
    );
    const sandbox = new PluginSandbox({ root: dir, tag: 't3', logger: () => {} });
    const api = sandbox.load(path.join(dir, 'index.js'));
    let tool;
    api.register({
      registerTool(t) {
        tool = t;
      },
      registerHook() {},
    });

    const dentro = await tool.run({ modo: 'dentro' });
    assert(
      dentro.ok && dentro.result === 'contenido del plugin',
      'fs escribe/lee dentro del plugin'
    );
    assert(
      fs.existsSync(path.join(dir, 'memo.txt')),
      'el archivo quedó en el directorio del plugin'
    );

    const fuera = await tool.run({ modo: 'fuera' });
    assert(
      !fuera.ok && fuera.result.includes('BLOQUEADO'),
      'fs bloquea lecturas fuera del directorio',
      fuera.result
    );

    const env = await tool.run({ modo: 'env' });
    assert(env.result === 'env={}', 'process.env está congelado y vacío', env.result);
  }

  // ══ 4. Sandbox: módulos peligrosos rechazados ═══════════════════════════
  console.log(C.bold('\n── Test 4: módulos peligrosos rechazados ──'));
  {
    const root = path.join(tmp, 't4');
    makePluginDir(
      root,
      'evil',
      `require('child_process');
module.exports = { register(ctx) {} };`
    );
    const mgr = new PluginManager({ pluginDir: root, logger: () => {} });
    assert(
      (await mgr.load()) === 0,
      'plugin que require child_process NO carga',
      'falló el require'
    );
  }

  // ══ 5. Firmado: sign → verify ok; modificar algo rompe la firma ═══════
  console.log(C.bold('\n── Test 5: firmado Ed25519 ──'));
  {
    const { publicKey, privateKey } = generateKeyPair();
    assert(
      publicKey.includes('PUBLIC KEY') && privateKey.includes('PRIVATE KEY'),
      'genera par de llaves Ed25519'
    );

    const dir = makePluginDir(
      path.join(tmp, 't5'),
      'firmado',
      `module.exports = { register(ctx) {} };`
    );
    signPlugin(dir, privateKey, 'test-market');
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
    assert(
      manifest.signature && manifest.signature.algorithm === ALGORITHM,
      'plugin.json queda firmado (signature)'
    );
    assert(verifyPlugin(dir, publicKey).ok, 'verifyPlugin: firma válida');

    // tocar index.js
    fs.appendFileSync(path.join(dir, 'index.js'), '\n// hack');
    assert(!verifyPlugin(dir, publicKey).ok, 'tocar index.js invalida la firma');
    // restaurar y tocar el manifest
    fs.writeFileSync(path.join(dir, 'index.js'), `module.exports = { register(ctx) {} };`);
    signPlugin(dir, privateKey);
    const m2 = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
    m2.description = 'modificado';
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(m2, null, 2));
    assert(!verifyPlugin(dir, publicKey).ok, 'tocar el manifest invalida la firma');

    // firma con OTRA key
    const dir2 = makePluginDir(
      path.join(tmp, 't5b'),
      'otro',
      `module.exports = { register(ctx) {} };`
    );
    const otherKey = generateKeyPair();
    signPlugin(dir2, otherKey.privateKey);
    assert(!verifyPlugin(dir2, publicKey).ok, 'firma de otra key se rechaza');
  }

  // ══ 6. Manager: requireSigned + rechazo de firma inválida ══════════════
  console.log(C.bold('\n── Test 6: PluginManager con requireSigned ──'));
  {
    const { publicKey, privateKey } = generateKeyPair();

    const signedRoot = path.join(tmp, 't6-signed');
    const signedDir = makePluginDir(
      signedRoot,
      'firmado',
      `module.exports = { register(ctx) {} };`
    );
    signPlugin(signedDir, privateKey);
    const mgrSigned = new PluginManager({
      pluginDir: signedRoot,
      publicKey,
      requireSigned: true,
      logger: () => {},
    });
    assert((await mgrSigned.load()) === 1, 'requireSigned carga el plugin firmado');

    const unsignedRoot = path.join(tmp, 't6-unsigned');
    makePluginDir(unsignedRoot, 'sinfirma', `module.exports = { register(ctx) {} };`);
    const mgrUnsigned = new PluginManager({
      pluginDir: unsignedRoot,
      publicKey,
      requireSigned: true,
      logger: () => {},
    });
    assert((await mgrUnsigned.load()) === 0, 'requireSigned rechaza el plugin sin firma');

    const tamperedRoot = path.join(tmp, 't6-tampered');
    const tamperedDir = makePluginDir(
      tamperedRoot,
      'tampered',
      `module.exports = { register(ctx) {} };`
    );
    signPlugin(tamperedDir, privateKey);
    fs.appendFileSync(path.join(tamperedDir, 'index.js'), '// hack');
    const mgrTampered = new PluginManager({
      pluginDir: tamperedRoot,
      publicKey,
      requireSigned: true,
      logger: () => {},
    });
    assert((await mgrTampered.load()) === 0, 'firma inválida se rechaza al cargar');

    const noKeyRoot = path.join(tmp, 't6-nokey');
    const noKeyDir = makePluginDir(noKeyRoot, 'firmado', `module.exports = { register(ctx) {} };`);
    signPlugin(noKeyDir, privateKey);
    const mgrNoKey = new PluginManager({
      pluginDir: noKeyRoot,
      requireSigned: true,
      logger: () => {},
    });
    assert((await mgrNoKey.load()) === 0, 'firmado sin key de confianza se rechaza (fail-safe)');
  }

  // ══ 7. Marketplace firmado: list/verify/install de punta a punta ═══════
  console.log(C.bold('\n── Test 7: marketplace firmado ──'));
  {
    const { publicKey, privateKey } = generateKeyPair();
    const marketDir = path.join(tmp, 'market');
    const pkgDir = makePluginDir(
      path.join(marketDir, 'packages'),
      'hello',
      `module.exports = {
  register(ctx) {
    ctx.registerTool({ name: 'ping', run: async () => ({ ok: true, result: 'pong' }) });
  },
};`
    );
    signPlugin(pkgDir, privateKey, 'test-market');
    fs.writeFileSync(path.join(marketDir, 'key.pub'), publicKey);

    const market = new PluginMarketplace({ marketplaceDir: marketDir, publicKey });
    const hash = market.computePackageHash(pkgDir);
    const index = {
      generated: new Date().toISOString(),
      plugins: [
        {
          id: 'hello',
          name: 'hello',
          version: '1.0.0',
          description: 'saluda',
          sha256: hash,
          path: 'packages/hello',
        },
      ],
    };
    fs.writeFileSync(path.join(marketDir, 'index.json'), JSON.stringify(index, null, 2));
    const sig = require('crypto')
      .sign(null, Buffer.from(JSON.stringify(index, null, 2)), privateKey)
      .toString('base64');
    fs.writeFileSync(path.join(marketDir, 'index.sig'), sig);

    assert(market.verifyIndex().ok, 'índice firmado se verifica');
    assert(
      market.list().ok && market.list().plugins.length === 1,
      'list() devuelve el plugin publicado'
    );

    // installer: pluginManager con la key del marketplace
    const pluginsDir = path.join(tmp, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    const mgr = new PluginManager({
      pluginDir: pluginsDir,
      marketplaceDir: marketDir,
      publicKey,
      requireSigned: true,
      logger: () => {},
    });
    const installed = await mgr.installFromMarketplace('hello');
    assert(installed.ok, 'install() copia el paquete y verifica firma', installed.error || '');
    assert(
      fs.existsSync(path.join(pluginsDir, 'hello', 'index.js')),
      'el plugin quedó en plugins/'
    );
    assert(
      mgr.list().length === 1 && mgr.list()[0].id === 'hello',
      'el plugin instalado se carga y lista'
    );

    // paquete adulterado → verifyPackage falla
    fs.appendFileSync(path.join(pkgDir, 'index.js'), '// hack');
    assert(!market.verifyPackage('hello').ok, 'paquete adulterado no pasa verifyPackage');

    // índice adulterado (otra key) → verifyIndex falla
    const other = generateKeyPair();
    const index2 = JSON.parse(fs.readFileSync(path.join(marketDir, 'index.json'), 'utf8'));
    const sig2 = require('crypto')
      .sign(null, Buffer.from(JSON.stringify(index2, null, 2)), other.privateKey)
      .toString('base64');
    fs.writeFileSync(path.join(marketDir, 'index.sig'), sig2);
    assert(!market.verifyIndex().ok, 'índice firmado por otra key se rechaza');
  }

  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(C.bold('\n═══════════════════════════════════════════'));
  const total = passed + failed;
  console.log(
    C.bold(
      `  Resultado: ${C.green(`${passed} passed`)}  ${failed > 0 ? C.red(`${failed} failed`) : C.dim('0 failed')}  / ${total} total`
    )
  );
  console.log(C.bold('═══════════════════════════════════════════\n'));
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL:', e.stack);
  process.exit(1);
});
