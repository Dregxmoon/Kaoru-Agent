'use strict';

// Fase A1 — resolver universal de destinos web: ya no existe un callejón sin
// salida cuando el destino no es una URL completa ni uno de los 8
// SITE_ALIASES fijos. Estos tests cubren los 3 caminos (URL directa, alias
// como atajo, fallback de búsqueda) sin depender de red real: webSearch y
// urlGuard se inyectan como mocks deterministas.

const { OpenClawBridge } = require('../core/planner/OpenClawBridge.js');

let passed = 0;
let failed = 0;

function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
    passed++;
  } else {
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

async function rejects(fn, pattern, label) {
  try {
    await fn();
    assert(false, label, 'no rechazó');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(pattern.test(message), label, message);
  }
}

function makeBridge({ webSearch, urlGuard, desktopControl } = {}) {
  return new OpenClawBridge({
    webSearch,
    urlGuard,
    desktopControl: desktopControl || {
      execute: async (tool, params) =>
        tool === 'open_website'
          ? { kind: 'website', url: params.target, browser: params.browser || 'default' }
          : { tool, params },
    },
  });
}

async function testUrlDirecta() {
  console.log('\n── Camino 1: URL https completa ───────────────────────');
  const bridge = makeBridge({
    webSearch: async () => {
      throw new Error('no debería llamarse: ya era una URL válida');
    },
  });
  const result = await bridge.execute('open_website', { target: 'https://example.org/ruta' });
  assert(result.ok, 'una URL https completa se abre sin tocar el resolver de búsqueda');
  assert(result.result.resolvedBy === 'url', 'se marca resolvedBy=url');
}

async function testAliasComoAtajo() {
  console.log('\n── Camino 2: alias conocido (atajo, no lista blanca) ──');
  const bridge = makeBridge({
    webSearch: async () => {
      throw new Error('no debería llamarse: youtube es un alias conocido');
    },
  });
  const result = await bridge.execute('open_website', { target: 'youtube' });
  assert(result.ok && result.result.url === 'https://www.youtube.com/', 'alias resuelve directo');
  assert(result.result.resolvedBy === 'alias', 'se marca resolvedBy=alias');
}

async function testFallbackBusqueda() {
  console.log('\n── Camino 3: destino desconocido → fallback de búsqueda ─');
  let searchedQuery = null;
  const bridge = makeBridge({
    webSearch: async ({ query }) => {
      searchedQuery = query;
      return {
        result: [
          { title: 'Sitio bloqueado', url: 'https://blocked.example/' },
          { title: 'Amazon España', url: 'https://www.amazon.es/' },
          { title: 'Otra opción', url: 'https://otra.example/' },
        ],
      };
    },
    urlGuard: async (url) => ({ safe: !url.includes('blocked.example') }),
  });
  const result = await bridge.execute('open_website', { target: 'amazon' });
  assert(
    result.ok && result.result.url === 'https://www.amazon.es/',
    'destino no predefinido se resuelve por búsqueda + UrlGuard, saltando el primer resultado bloqueado',
    JSON.stringify(result)
  );
  assert(result.result.resolvedBy === 'search', 'se marca resolvedBy=search');
  assert(
    result.result.resolvedFromQuery === 'amazon',
    'se conserva la consulta usada como evidencia'
  );
  assert(searchedQuery === 'amazon', 'la búsqueda usa el texto tal como lo pidió el usuario');
}

async function testFallbackSinResultadosSeguros() {
  console.log('\n── Sin resultados seguros → error honesto, no crash ───');
  const bridge = makeBridge({
    webSearch: async () => ({
      result: [
        { title: 'x', url: 'https://blocked.example/' },
        { title: 'y', url: 'http://inseguro.example/' },
      ],
    }),
    urlGuard: async () => ({ safe: false }),
  });
  await rejects(
    () =>
      bridge.execute('open_website', { target: 'un sitio inexistente' }).then((r) => {
        if (!r.ok) throw new Error(r.error);
        return r;
      }),
    /No encontré un destino seguro/,
    'informa honestamente cuando ningún resultado pasa el candado de seguridad'
  );
}

async function testBusquedaFalla() {
  console.log('\n── La búsqueda misma falla → error claro ──────────────');
  const bridge = makeBridge({
    webSearch: async () => {
      throw new Error('captcha de Google');
    },
  });
  const result = await bridge.execute('open_website', { target: 'un sitio raro' });
  assert(!result.ok, 'no declara éxito si la búsqueda de respaldo falla');
  assert(/captcha de Google/.test(result.error), 'propaga el motivo real del fallo', result.error);
}

async function testScoringRelevancia() {
  console.log('\n── P1: elige por relevancia, no por orden de llegada ───');
  const bridge = makeBridge({
    webSearch: async () => ({
      result: [
        { title: 'Directorio genérico de tiendas', url: 'https://directorio.example/tiendas' },
        { title: 'Amazon España', url: 'https://www.amazon.es/' },
      ],
    }),
    urlGuard: async () => ({ safe: true }),
  });
  const result = await bridge.execute('open_website', { target: 'amazon' });
  assert(
    result.ok && result.result.url === 'https://www.amazon.es/',
    'el host que cubre la consulta gana aunque llegue segundo',
    JSON.stringify(result)
  );
  assert(
    typeof result.result.score === 'number' && result.result.score > 0,
    'el score viaja como evidencia auditable'
  );
}

async function testCache() {
  console.log('\n── P1: la búsqueda se cachea con TTL ───');
  let searches = 0;
  const bridge = makeBridge({
    webSearch: async () => {
      searches++;
      return { result: [{ title: 'Amazon', url: 'https://www.amazon.es/' }] };
    },
    urlGuard: async () => ({ safe: true }),
  });
  const first = await bridge.execute('open_website', { target: 'amazon tienda' });
  const second = await bridge.execute('open_website', { target: 'amazon tienda' });
  assert(first.ok && second.ok, 'ambas resoluciones tienen éxito');
  assert(searches === 1, 'la segunda resolución no tocó la red (caché)', `búsquedas: ${searches}`);
  assert(second.result.cached === true, 'se marca cached:true como evidencia');
}

async function testParidadDesktopControl() {
  console.log('\n── P0: DesktopControl directo resuelve igual que el bridge ───');
  const { DesktopControl } = require('../core/desktop/DesktopControl.js');
  const { WebsiteResolver } = require('../core/desktop/WebsiteResolver.js');
  const { SITE_ALIASES } = require('../core/desktop/DesktopControl.js');
  const opened = [];
  const control = new DesktopControl({
    platform: 'linux',
    openExternal: async (url) => opened.push(url),
    urlGuard: async () => ({ safe: true }),
  });
  control.setWebsiteResolver(
    new WebsiteResolver({
      aliases: SITE_ALIASES,
      webSearch: async () => ({ result: [{ title: 'Amazon', url: 'https://www.amazon.es/' }] }),
      urlGuard: async () => ({ safe: true }),
    })
  );
  const result = await control.openWebsite({ target: 'amazon' });
  assert(
    opened[0] === 'https://www.amazon.es/' && result.resolvedBy === 'search',
    'el control directo abre el destino resuelto con evidencia',
    JSON.stringify(result)
  );

  const sinResolver = new DesktopControl({
    platform: 'linux',
    openExternal: async () => {},
    urlGuard: async () => ({ safe: true }),
  });
  let mensaje = '';
  try {
    await sinResolver.openWebsite({ target: 'amazon' });
  } catch (error) {
    mensaje = error instanceof Error ? error.message : String(error);
  }
  assert(
    /sitio conocido/.test(mensaje),
    'sin resolver inyectado se conserva el error clásico (sin regresión)'
  );
}

async function testWindowsLinux() {
  console.log('\n── Paridad Linux/Windows en apertura resuelta ───');
  const { DesktopControl } = require('../core/desktop/DesktopControl.js');
  const { WebsiteResolver } = require('../core/desktop/WebsiteResolver.js');
  const { SITE_ALIASES } = require('../core/desktop/DesktopControl.js');
  for (const platform of ['linux', 'win32']) {
    const launched = [];
    const control = new DesktopControl({
      platform,
      openExternal: async (url) => launched.push(url),
      urlGuard: async () => ({ safe: true }),
    });
    control.setWebsiteResolver(
      new WebsiteResolver({
        aliases: SITE_ALIASES,
        webSearch: async () => ({ result: [{ title: 'Y', url: 'https://www.youtube.com/' }] }),
        urlGuard: async () => ({ safe: true }),
      })
    );
    const result = await control.openWebsite({ target: 'youtube' });
    assert(
      result.url === 'https://www.youtube.com/' && result.resolvedBy === 'alias',
      `alias en ${platform} no toca la red ni el lanzador`,
      JSON.stringify(result)
    );
  }
}

(async () => {
  console.log('\x1b[1m\n════ Resolver universal de open_website (Fase A1) ════\x1b[0m');
  await testUrlDirecta();
  await testAliasComoAtajo();
  await testFallbackBusqueda();
  await testFallbackSinResultadosSeguros();
  await testBusquedaFalla();
  await testScoringRelevancia();
  await testCache();
  await testParidadDesktopControl();
  await testWindowsLinux();
  console.log(`\nResultado: ${passed} passed  ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
