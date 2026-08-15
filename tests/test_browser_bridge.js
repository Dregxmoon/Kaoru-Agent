'use strict';

// BrowserBridge — navegador propio del asistente (Playwright headless).
// Se inyecta un fake de `playwright` en require.cache para ejercitar
// executeBrowserAction/executeWebSearch/closeBrowser sin lanzar Chromium real.

const BrowserBridge = require('../core/planner/BrowserBridge.js');

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

// ── Fake de playwright + page ──────────────────────────────────────────────────
const fakePageState = {
  bodyText: 'Contenido del body de la página',
  results: [
    { title: 'Resultado Uno', url: 'https://ejemplo.com/1', snippet: 'snippet uno' },
    { title: 'Resultado Dos', url: 'https://ejemplo.com/2', snippet: 'snippet dos' },
  ],
};

const fakePage = {
  isClosed: () => false,
  goto: async () => {},
  title: async () => 'Título de prueba',
  click: async () => {},
  textContent: async (sel) => (sel === '#missing' ? null : 'Contenido del selector'),
  screenshot: async () => Buffer.alloc(64),
  evaluate: async (fn, arg) => {
    // get_text sin selector: evaluate(fn) sin arg → body; web_search:
    // evaluate(fn, max_results) → resultados del DOM fake.
    if (arg === undefined) return fakePageState.bodyText;
    return fakePageState.results.slice(0, arg).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.snippet,
    }));
  },
};

const fakeBrowser = { newPage: async () => fakePage, close: async () => {} };
const fakePlaywright = { chromium: { launch: async () => fakeBrowser } };

function installFakePlaywright() {
  const resolved = require.resolve('playwright');
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: fakePlaywright,
  };
}

async function expectReject(fn, label, detail = '') {
  try {
    await fn();
    assert(false, label, detail);
  } catch (e) {
    assert(e && e.message && e.message.length > 0, label, detail);
  }
}

async function testBrowserActions() {
  console.log(C.bold('\n── executeBrowserAction: navigate/click/get_text/screenshot ─────'));

  const nav = await BrowserBridge.executeBrowserAction({
    action: 'navigate',
    url: 'https://x.com',
  });
  assert(nav.result.includes('Título de prueba'), 'navigate devuelve url + título', nav.result);

  await expectReject(
    () => BrowserBridge.executeBrowserAction({ action: 'navigate' }),
    'navigate sin url → Error'
  );

  const click = await BrowserBridge.executeBrowserAction({ action: 'click', selector: '#boton' });
  assert(click.result.includes('#boton'), 'click devuelve selector', click.result);

  await expectReject(
    () => BrowserBridge.executeBrowserAction({ action: 'click' }),
    'click sin selector → Error'
  );

  const sel = await BrowserBridge.executeBrowserAction({ action: 'get_text', selector: '#titulo' });
  assert(typeof sel.result === 'string' && sel.result.length > 0, 'get_text con selector');

  await expectReject(
    () => BrowserBridge.executeBrowserAction({ action: 'get_text', selector: '#missing' }),
    'get_text con elemento inexistente → Error'
  );

  const body = await BrowserBridge.executeBrowserAction({ action: 'get_text' });
  assert(typeof body.result === 'string', 'get_text sin selector → body');

  const shot = await BrowserBridge.executeBrowserAction({ action: 'screenshot' });
  assert(shot.result.includes('64 bytes'), 'screenshot devuelve tamaño', shot.result);

  await expectReject(
    () => BrowserBridge.executeBrowserAction({ action: 'hack' }),
    'acción desconocida → Error'
  );
}

async function testWebSearch() {
  console.log(C.bold('\n── executeWebSearch: resultados reales (DOM fake) ───────────────'));

  const ok = await BrowserBridge.executeWebSearch({ query: 'gatos', max_results: 2 });
  assert(Array.isArray(ok.result) && ok.result.length === 2, 'web_search devuelve resultados');
  assert(!ok.error, 'web_search sin error');

  fakePageState.results = [];
  const empty = await BrowserBridge.executeWebSearch({ query: 'nada' });
  assert(
    Array.isArray(empty.result) && empty.result.length === 0,
    'web_search sin resultados → []'
  );
  assert(empty.error && empty.error.length > 0, 'web_search sin resultados → error explicativo');
  fakePageState.results = [
    { title: 'Resultado Uno', url: 'https://ejemplo.com/1', snippet: 'snippet uno' },
  ];

  await expectReject(() => BrowserBridge.executeWebSearch({}), 'web_search sin query → Error');
}

async function testCloseBrowser() {
  console.log(C.bold('\n── closeBrowser: idempotente ───────────────────────────────────'));
  await BrowserBridge.closeBrowser();
  await BrowserBridge.closeBrowser();
  assert(true, 'closeBrowser dos veces no lanza');
}

async function main() {
  installFakePlaywright();
  await testBrowserActions();
  await testWebSearch();
  await testCloseBrowser();

  console.log(C.bold('\n════════════════════════════════════════════════════════'));
  const total = passed + failed;
  console.log(
    C.bold(
      `  Resultado: ${C.green(passed + ' passed')}  ${failed > 0 ? C.red(failed + ' failed') : C.dim('0 failed')}  / ${total} total`
    )
  );
  console.log(C.bold('════════════════════════════════════════════════════════\n'));

  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(C.red('\nERROR FATAL:'), e.message);
  console.error(e.stack);
  process.exit(1);
});
