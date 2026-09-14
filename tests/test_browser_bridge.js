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
  videoHref: '/watch?v=abc123_DEF',
  playing: false,
  filled: '',
  pressed: '',
  currentUrl: 'https://x.com/',
  results: [
    { title: 'Resultado Uno', url: 'https://ejemplo.com/1', snippet: 'snippet uno' },
    { title: 'Resultado Dos', url: 'https://ejemplo.com/2', snippet: 'snippet dos' },
  ],
};

const fakePage = {
  isClosed: () => false,
  goto: async () => {},
  url: () => fakePageState.currentUrl,
  goBack: async () => {},
  goForward: async () => {},
  keyboard: { press: async (key) => (fakePageState.pressed = key) },
  setDefaultTimeout: () => {},
  bringToFront: async () => {},
  title: async () => 'Título de prueba',
  click: async () => {},
  textContent: async (sel) => (sel === '#missing' ? null : 'Contenido del selector'),
  screenshot: async () => Buffer.alloc(64),
  locator: (selector) => ({
    first() {
      return this;
    },
    waitFor: async () => {},
    getAttribute: async () => fakePageState.videoHref,
    textContent: async () => (selector === '#missing' ? null : 'Contenido del selector'),
    fill: async (value) => (fakePageState.filled = value),
    inputValue: async () => fakePageState.filled,
    press: async (key) => (fakePageState.pressed = key),
    click: async () => {
      if (selector.includes('play-button')) fakePageState.playing = true;
    },
  }),
  getByRole: () => ({
    first() {
      return this;
    },
    count: async () => 0,
    click: async () => {},
    fill: async (value) => (fakePageState.filled = value),
    press: async (key) => (fakePageState.pressed = key),
    waitFor: async () => {},
    textContent: async () => 'Contenido semántico',
  }),
  getByLabel: () => fakePage.locator('#label'),
  getByPlaceholder: () => fakePage.locator('#placeholder'),
  getByText: () => fakePage.locator('#text'),
  waitForFunction: async () => {
    if (!fakePageState.playing) throw new Error('no reproduce');
  },
  evaluate: async (fn, arg) => {
    if (fn.toString().includes("querySelector('video')")) return fakePageState.playing;
    if (fn.toString().includes('video-title')) return fakePageState.videoHref;
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
const fakeManagedContext = {
  pages: () => [fakePage],
  newPage: async () => fakePage,
  close: async () => {},
};
const fakePlaywright = {
  chromium: {
    launch: async () => fakeBrowser,
    launchPersistentContext: async () => fakeManagedContext,
  },
};

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
  assert(nav.result.title === 'Título de prueba', 'navigate devuelve metadatos + título');

  await expectReject(
    () => BrowserBridge.executeBrowserAction({ action: 'navigate' }),
    'navigate sin url → Error'
  );

  const click = await BrowserBridge.executeBrowserAction({
    action: 'click',
    selector: '#boton',
    sessionId: nav.result.sessionId,
    pageId: nav.result.pageId,
    expectedOrigin: nav.result.origin,
  });
  assert(
    click.result.executed && click.result.status === 'executed_unverified',
    'click diferencia ejecución de intención verificada'
  );

  await expectReject(
    () =>
      BrowserBridge.executeBrowserAction({
        action: 'click',
        sessionId: nav.result.sessionId,
        pageId: nav.result.pageId,
        expectedOrigin: nav.result.origin,
      }),
    'click sin selector → Error'
  );

  const browserScope = {
    sessionId: nav.result.sessionId,
    pageId: nav.result.pageId,
    expectedOrigin: nav.result.origin,
  };
  const sel = await BrowserBridge.executeBrowserAction({
    action: 'get_text',
    selector: '#titulo',
    ...browserScope,
  });
  assert(
    typeof sel.result.text === 'string' && sel.result.text.length > 0,
    'get_text con selector'
  );

  await expectReject(
    () =>
      BrowserBridge.executeBrowserAction({
        action: 'get_text',
        selector: '#missing',
        ...browserScope,
      }),
    'get_text con elemento inexistente → Error'
  );

  const body = await BrowserBridge.executeBrowserAction({ action: 'get_text', ...browserScope });
  assert(typeof body.result.text === 'string', 'get_text sin selector → body');

  const managed = await BrowserBridge.executeBrowserAction({ action: 'snapshot', mode: 'managed' });

  await BrowserBridge.executeBrowserAction({
    action: 'type',
    role: 'textbox',
    name: 'Buscar',
    value: 'Yorushika',
    mode: 'managed',
    sessionId: managed.result.sessionId,
    pageId: managed.result.pageId,
    expectedOrigin: managed.result.origin,
  });
  assert(fakePageState.filled === 'Yorushika', 'type usa localizador semántico en modo visible');
  await BrowserBridge.executeBrowserAction({
    action: 'press',
    key: 'Enter',
    mode: 'managed',
    sessionId: managed.result.sessionId,
    pageId: managed.result.pageId,
    expectedOrigin: managed.result.origin,
  });
  assert(fakePageState.pressed === 'Enter', 'press controla el teclado de la sesión visible');
  const current = await BrowserBridge.executeBrowserAction({
    action: 'get_url',
    mode: 'managed',
  });
  assert(current.result.url === 'https://x.com/', 'get_url devuelve URL y contexto verificable');

  const shot = await BrowserBridge.executeBrowserAction({ action: 'screenshot', ...browserScope });
  assert(
    shot.result.byteLength === 64 && shot.result.dataUrl.startsWith('data:image/jpeg;base64,'),
    'screenshot devuelve imagen y metadatos'
  );

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
  BrowserBridge._setRssFallbackForTests(null);
  const empty = await BrowserBridge.executeWebSearch({ query: 'nada' });
  assert(
    Array.isArray(empty.result) && empty.result.length === 0,
    'web_search sin resultados → []'
  );
  assert(empty.error && empty.error.length > 0, 'web_search sin resultados → error explicativo');

  // Fallback Bing RSS inyectado: Google vacío + RSS con datos → resultados.
  BrowserBridge._setRssFallbackForTests(async () => [
    { title: 'Amazon', url: 'https://www.amazon.com.mx/', snippet: 'tienda' },
  ]);
  const rescued = await BrowserBridge.executeWebSearch({ query: 'amazon' });
  assert(
    Array.isArray(rescued.result) &&
      rescued.result.length === 1 &&
      rescued.result[0].url === 'https://www.amazon.com.mx/' &&
      !rescued.error,
    'Google vacío + RSS con datos → rescata resultados sin error'
  );

  // Fallback que falla → error honesto original, sin crash.
  BrowserBridge._setRssFallbackForTests(async () => {
    throw new Error('red caída');
  });
  const stillEmpty = await BrowserBridge.executeWebSearch({ query: 'nada' });
  assert(
    stillEmpty.result.length === 0 && stillEmpty.error && stillEmpty.error.length > 0,
    'RSS caído → error explicativo original'
  );
  BrowserBridge._setRssFallbackForTests(undefined);
  fakePageState.results = [
    { title: 'Resultado Uno', url: 'https://ejemplo.com/1', snippet: 'snippet uno' },
  ];

  await expectReject(() => BrowserBridge.executeWebSearch({}), 'web_search sin query → Error');
}

async function testNetworkPolicy() {
  console.log(C.bold('\n── política de red y contexto ────────────────────────────'));
  let handler = null;
  const context = {
    route: async (_pattern, callback) => {
      handler = callback;
    },
  };
  BrowserBridge._setUrlGuardForTests(null);
  await BrowserBridge._installNetworkPolicy(context);
  let aborted = false;
  let continued = false;
  await handler({
    request: () => ({ url: () => 'http://127.0.0.1/private' }),
    continue: async () => {
      continued = true;
    },
    abort: async () => {
      aborted = true;
    },
  });
  assert(aborted && !continued, 'bloquea solicitudes del contexto hacia loopback');
  BrowserBridge._setUrlGuardForTests(async () => ({ safe: true }));
}

async function testYouTubeResolver() {
  console.log(C.bold('\n── YouTube: resolver primer video ──────────────────────'));
  const url = await BrowserBridge.findFirstYouTubeVideo('guitarra acústica');
  assert(
    url.startsWith('https://www.youtube.com/watch?v=abc123_DEF'),
    'acepta solo /watch de YouTube'
  );
  assert(url.includes('autoplay=1'), 'solicita reproducción automática');
  assert(
    BrowserBridge._youtubeWatchUrl('https://evil.example/watch?v=abc123_DEF') === null,
    'rechaza un host externo aunque imite /watch'
  );
  const ranked = BrowserBridge._rankYouTubeCandidates('Ado kira kira', [
    { title: 'Kira Kira pop mix', href: '/watch?v=wrong12' },
    { title: 'Ado - Kira Kira (Official Video)', href: '/watch?v=correct9' },
  ]);
  assert(
    ranked?.includes('v=correct9'),
    'elige el resultado que mejor cubre artista y canción, no solo el primero'
  );
  fakePageState.playing = false;
  const playback = await BrowserBridge.playYouTubeMedia('guitarra acústica');
  assert(playback.browser === 'kaoru-managed-chromium', 'usa un navegador visible controlable');
  assert(playback.playing && playback.verified, 'verifica reproducción real tras pulsar play');
  await expectReject(() => BrowserBridge.findFirstYouTubeVideo(''), 'rechaza consulta vacía');
}

async function testCloseBrowser() {
  console.log(C.bold('\n── closeBrowser: idempotente ───────────────────────────────────'));
  await BrowserBridge.closeBrowser();
  await BrowserBridge.closeBrowser();
  assert(true, 'closeBrowser dos veces no lanza');
}

async function main() {
  installFakePlaywright();
  BrowserBridge._setUrlGuardForTests(async () => ({ safe: true }));
  await testBrowserActions();
  await testNetworkPolicy();
  await testWebSearch();
  await testYouTubeResolver();
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
