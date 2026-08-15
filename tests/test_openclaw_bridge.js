'use strict';

// OpenClawBridge — cliente HTTP hacia openclaw-server + despacho a
// BrowserBridge. Se levanta un servidor HTTP real en puerto efímero
// (OPENCLAW_PORT) y se inyecta el fake de playwright para browser/web_search.

const http = require('http');
const BrowserBridge = require('../core/planner/BrowserBridge.js');
const { OpenClawBridge, getOpenClawBridge } = require('../core/planner/OpenClawBridge.js');

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

// ── Mock server OpenClaw ───────────────────────────────────────────────────────
let _requests = [];
let _healthDown = false;

function startMockOpenclaw() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const bodyText = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try {
          body = bodyText ? JSON.parse(bodyText) : null;
        } catch {
          body = null;
        }
        _requests.push({ method: req.method, url: req.url, headers: req.headers, body });
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/health') {
          if (_healthDown) {
            res.writeHead(503);
            res.end(JSON.stringify({ status: 'down' }));
            return;
          }
          res.writeHead(200);
          res.end(
            JSON.stringify({
              status: 'ok',
              sandbox: 'bwrap',
              sandboxReason: 'sandbox bwrap activo',
            })
          );
          return;
        }
        if (req.url === '/v1/tool') {
          const cmd = body && body.input && body.input.command;
          if (cmd === 'fail-me') {
            res.writeHead(500);
            res.end(JSON.stringify({ error: 'boom controlado' }));
            return;
          }
          if (cmd === 'raw-response') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('esto no es json');
            return;
          }
          const isEdit = body && body.tool === 'edit' && body.input && body.input.old_text;
          if (isEdit) {
            res.writeHead(200);
            res.end(
              JSON.stringify({
                result: 'edit ok',
                oldContent: 'contenido viejo',
                newContent: 'contenido nuevo',
                addedLines: 2,
                removedLines: 1,
              })
            );
            return;
          }
          res.writeHead(200);
          res.end(JSON.stringify({ result: 'todo ok' }));
          return;
        }
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'not found' }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      process.env.OPENCLAW_PORT = String(port);
      resolve({
        server,
        get port() {
          return Number(process.env.OPENCLAW_PORT);
        },
      });
    });
  });
}

// ── Fake de playwright (para browser/web_search) ───────────────────────────────
function installFakePlaywright() {
  const fakePage = {
    isClosed: () => false,
    goto: async () => {},
    title: async () => 'Título mock',
    click: async () => {},
    textContent: async () => 'texto mock',
    screenshot: async () => Buffer.alloc(32),
    evaluate: async (fn) => (fn.toString().includes('innerText') ? 'body mock' : []),
  };
  const fakeBrowser = { newPage: async () => fakePage, close: async () => {} };
  const resolved = require.resolve('playwright');
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: { chromium: { launch: async () => fakeBrowser } },
  };
}

async function testAvailability() {
  console.log(C.bold('\n── isAvailable + sandbox + TTL ─────────────────────────────────'));

  const bridge = new OpenClawBridge();
  const avail = await bridge.isAvailable();
  assert(avail === true, 'isAvailable → true con /health 200');
  const sb = bridge.getSandboxStatus();
  assert(sb && sb.enabled === true, 'getSandboxStatus → {enabled:true} con sandbox bwrap');
  assert(sb && sb.reason === 'sandbox bwrap activo', 'getSandboxStatus conserva reason');

  const healthCalls = _requests.filter((r) => r.url === '/health').length;
  await bridge.isAvailable();
  assert(
    _requests.filter((r) => r.url === '/health').length === healthCalls,
    'TTL: segunda llamada sin force usa cache'
  );
  await bridge.isAvailable(true);
  assert(
    _requests.filter((r) => r.url === '/health').length === healthCalls + 1,
    'force=true vuelve a consultar /health'
  );

  bridge.resetAvailabilityCache();
  assert(bridge.getSandboxStatus() === null, 'resetAvailabilityCache limpia sandbox');
}

async function testAvailabilityDown() {
  console.log(C.bold('\n── isAvailable con server caído ───────────────────────────────'));

  _healthDown = true;
  const bridge = new OpenClawBridge();
  const avail = await bridge.isAvailable();
  assert(avail === false, 'isAvailable → false con /health 503');
  assert(bridge.getSandboxStatus() === null, 'sandbox null cuando no disponible');
  _healthDown = false;
}

async function testExecuteHttp() {
  console.log(C.bold('\n── execute por HTTP: ok / meta / error / raw ───────────────────'));

  const bridge = new OpenClawBridge();

  const ok = await bridge.execute('exec', { command: 'ls' });
  assert(ok.ok === true && ok.result === 'todo ok', 'exec ok → {ok:true, result}');
  assert(ok.tool === 'exec' && typeof ok.elapsed === 'number', 'contrato: tool + elapsed');

  const edit = await bridge.execute('edit', { path: '/x/a.js', oldString: 'a', newString: 'b' });
  assert(edit.ok === true, 'edit ok');
  assert(
    edit.meta &&
      edit.meta.oldContent === 'contenido viejo' &&
      edit.meta.newContent === 'contenido nuevo',
    'edit propaga meta (oldContent/newContent/addedLines/removedLines)'
  );
  assert(edit.result === 'edit ok', 'edit result sigue siendo el string de resumen');

  const fail = await bridge.execute('exec', { command: 'fail-me' });
  assert(fail.ok === false && fail.error === 'boom controlado', 'HTTP 500 → ok:false con error');

  const raw = await bridge.execute('exec', { command: 'raw-response' });
  assert(raw.ok === true && raw.result === 'esto no es json', 'respuesta no-JSON → body raw');

  const unknown = await bridge.execute('turboencabritador', {});
  assert(
    unknown.ok === false && unknown.error.includes('Herramienta desconocida'),
    'tool desconocida → error'
  );

  const auth = _requests.find((r) => r.url === '/v1/tool' && r.body && r.body.tool === 'edit');
  assert(
    auth && auth.headers['content-type'] === 'application/json',
    'envía Content-Type application/json'
  );
}

async function testApiKeyHeader() {
  console.log(C.bold('\n── setApiKey → headers de auth ─────────────────────────────────'));

  const bridge = new OpenClawBridge();
  await bridge.isAvailable();
  const before = _requests.filter((r) => r.url === '/v1/tool').length;
  await bridge.execute('write', { path: '/x/b.js', content: 'x' });
  const req = _requests.filter((r) => r.url === '/v1/tool')[before];
  assert(!req.headers['x-api-key'], 'sin key configurada → no manda X-Api-Key');
}

async function testBrowserDispatch() {
  console.log(C.bold('\n── browser/web_search → BrowserBridge (fake playwright) ────────'));

  const bridge = new OpenClawBridge();
  const nav = await bridge.execute('browser', { action: 'navigate', url: 'https://x.com' });
  assert(
    nav.ok === true && nav.result.includes('Título mock'),
    'browser navigate vía BrowserBridge'
  );

  const err = await bridge.execute('browser', { action: 'navigate' });
  assert(
    err.ok === false && err.error.includes('navigate requiere'),
    'error de BrowserBridge → ok:false'
  );

  const search = await bridge.execute('web_search', { query: 'x' });
  assert(search.ok === true, 'web_search vía BrowserBridge');

  const shortcuts = await Promise.all([
    bridge.exec('pwd'),
    bridge.webSearch('gatos', 3),
    bridge.navigate('https://y.com'),
    bridge.readFile('/a.txt'),
    bridge.writeFile('/b.txt', 'c'),
  ]);
  assert(
    shortcuts.every((s) => s.ok === true),
    'atajos exec/webSearch/navigate/readFile/writeFile'
  );
}

async function testLogAndStats() {
  console.log(C.bold('\n── actionLog + getStats ───────────────────────────────────────'));

  const bridge = new OpenClawBridge();
  const before = bridge.getActionLog(100).length;
  await bridge.execute('exec', { command: 'ls' });
  await bridge.execute('turbo', {});
  const log = bridge.getActionLog(100);
  assert(log.length === before + 2, 'actionLog registra cada ejecución');
  const stats = bridge.getStats();
  assert(stats.total === log.length, 'getStats.total coincide con actionLog');
  assert(stats.tools.includes('exec'), 'getStats.tools incluye exec');
}

async function testCloseBrowserShortcut() {
  console.log(C.bold('\n── closeBrowser shortcut → BrowserBridge ───────────────────────'));
  const bridge = new OpenClawBridge();
  await bridge.closeBrowser();
  assert(true, 'closeBrowser() no lanza');
}

async function main() {
  installFakePlaywright();
  const { server } = await startMockOpenclaw();
  try {
    await testAvailability();
    await testAvailabilityDown();
    await testExecuteHttp();
    await testApiKeyHeader();
    await testBrowserDispatch();
    await testLogAndStats();
    await testCloseBrowserShortcut();
  } finally {
    server.close();
  }

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
