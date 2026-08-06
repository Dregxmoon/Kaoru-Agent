'use strict';

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

function assertEqual(a, b, label) {
  const ok = a === b;
  assert(ok, label, ok ? '' : `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const http = require('http');

const TEST_KEY = 'test-key-for-web-tools-2026';
process.env.OPENCLAW_API_KEY = TEST_KEY;

const srv = require('../openclaw-server.js');

// ── Test 1: _htmlToText (función pura) ──────────────────────────────────────
function testHtmlToText() {
  console.log(C.bold('\n── _htmlToText ──────────────────────────────────────────'));

  const simple = srv._htmlToText(
    '<html><body><p>Hola <b>mundo</b></p><p>Línea 2</p></body></html>'
  );
  assert(simple.includes('Hola mundo'), 'estrips tags, texto se une');
  assert(simple.includes('Línea 2'), 'contenido entre párrafos se conserva');

  const entities = srv._htmlToText('a &amp; b &lt; c &gt; d &quot;e&quot; &#39;f&#39;');
  assertEqual(entities, 'a & b < c > d "e" \'f\'', 'entidades HTML decodificadas');

  const scripts = srv._htmlToText('<script>evil()</script><style>.x{}</style>hola');
  assert(!scripts.includes('evil'), 'script eliminado');
  assert(!scripts.includes('.x{}'), 'style eliminado');
  assert(scripts.includes('hola'), 'texto visible conservado');

  assertEqual(srv._htmlToText(''), '', 'string vacío → vacío');
}

// ── Test 2: _parseDuckDuckGoHTML (función pura) ─────────────────────────────
function testParseDuckDuckGo() {
  console.log(C.bold('\n── _parseDuckDuckGoHTML ────────────────────────────────'));

  const html =
    '<div id="links">' +
    '<div class="result">' +
    '<a class="result__a" href="https://nodejs.org/api/fs.html">Node fs API</a>' +
    '<a class="result__snippet">Lee y escribe archivos</a>' +
    '</div>' +
    '<div class="result">' +
    '<a class="result__a" href="//duckduckgo.com/l/?uddg=' +
    encodeURIComponent('https://example.com/page?q=1&x=2') +
    '">Ejemplo redirect</a>' +
    '<a class="result__snippet">Página de ejemplo</a>' +
    '</div>' +
    '</div>';

  const results = srv._parseDuckDuckGoHTML(html);
  assertEqual(results.length, 2, 'extrae 2 resultados');
  assertEqual(results[0].title, 'Node fs API', 'título del primer resultado');
  assertEqual(results[0].url, 'https://nodejs.org/api/fs.html', 'URL directa');
  assertEqual(results[0].snippet, 'Lee y escribe archivos', 'snippet extraído');
  assertEqual(results[1].url, 'https://example.com/page?q=1&x=2', 'URL uddg decodificada');
  assertEqual(srv._parseDuckDuckGoHTML('no results here').length, 0, 'sin resultados → []');
}

// ── Test 3: validación de input (sin red) ───────────────────────────────────
async function testInputValidation() {
  console.log(C.bold('\n── validación de input ─────────────────────────────────'));

  const noUrl = await srv.handleTool({ tool: 'webfetch', input: {} });
  assert(noUrl.error && noUrl.error.includes('url required'), 'webfetch sin url → error');

  const badProtocol = await srv.handleTool({
    tool: 'webfetch',
    input: { url: 'file:///etc/passwd' },
  });
  assert(
    badProtocol.error && badProtocol.error.includes('Protocolo no soportado'),
    'webfetch con file:// → error'
  );

  const badUrl = await srv.handleTool({ tool: 'webfetch', input: { url: 'not a url' } });
  assert(badUrl.error && badUrl.error.includes('URL inválida'), 'webfetch con url rota → error');

  const noQuery = await srv.handleTool({ tool: 'websearch', input: {} });
  assert(noQuery.error && noQuery.error.includes('query required'), 'websearch sin query → error');
}

// ── Test 4: webfetch real contra servidor local (sin internet) ──────────────
async function testWebfetchLive() {
  console.log(C.bold('\n── webfetch contra servidor local ──────────────────────'));

  const local = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/page' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><head><title>Local</title></head><body><p>Hola desde local</p></body></html>');
  });

  await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve));
  const port = local.address().port;

  try {
    const ok = await srv.handleTool({
      tool: 'webfetch',
      input: { url: `http://127.0.0.1:${port}/page` },
    });
    assert(ok.result && ok.result.text.includes('Hola desde local'), 'webfetch obtiene texto');
    assertEqual(ok.result.statusCode, 200, 'statusCode 200');
    assert(ok.result.contentType.includes('text/html'), 'contentType reportado');

    const redirect = await srv.handleTool({
      tool: 'webfetch',
      input: { url: `http://127.0.0.1:${port}/redirect` },
    });
    assert(
      redirect.result && redirect.result.text.includes('Hola desde local'),
      'sigue redirect 302'
    );

    const connRefused = await srv.handleTool({
      tool: 'webfetch',
      input: { url: 'http://127.0.0.1:1/' },
    });
    assert(connRefused.error, 'conexión rechazada → error (no cuelga)');
  } finally {
    await new Promise((resolve) => local.close(resolve));
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────

console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
console.log(C.bold(C.cyan('  Kaoru — Test Suite: Herramientas Web (webfetch/websearch)')));
console.log(C.bold(C.cyan('════════════════════════════════════════════════════════')));

async function main() {
  testHtmlToText();
  testParseDuckDuckGo();
  try {
    await testInputValidation();
  } catch (e) {
    console.error(`  ${C.red('✗')} validación de input falló: ${e.message}`);
    failed++;
  }
  try {
    await testWebfetchLive();
  } catch (e) {
    console.error(`  ${C.red('✗')} webfetch live falló: ${e.message}`);
    failed++;
  }

  console.log(C.bold('\n════════════════════════════════════════════════════════'));
  const total = passed + failed + skipped;
  const skipNote = skipped > 0 ? `  ${C.yellow(`${skipped} skipped`)}` : '';
  if (failed === 0) {
    console.log(
      `  ${C.green('Resultado')}: ${C.green(`${passed} passed`)}  ${C.dim(`0 failed`)}${skipNote}  / ${total} total`
    );
  } else {
    console.log(
      `  Resultado: ${C.green(`${passed} passed`)}  ${C.red(`${failed} failed`)}${skipNote}  / ${total} total`
    );
  }
  console.log(C.bold('════════════════════════════════════════════════════════'));

  if (failed > 0) process.exit(1);
}

main();
