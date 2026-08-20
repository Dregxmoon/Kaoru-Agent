'use strict';

// S2 — la API key de Gemini NO debe viajar en el query string de la URL
// (?key=...), sino en el header `x-goog-api-key` (método documentado por
// Google). Verifica ambos callers: callGeminiProvider (stream y no-stream).
// Un servidor local captura req.url y req.headers y responde en el formato
// real de la Gemini API (generateContent JSON y SSE con alt=sse).

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

const http = require('http');
const LLMProvider = require('../core/llm/LLMProvider.js');

// Registra los requests recibidos: { url, headers }.
// Responde en formato Gemini:
//  - con alt=sse → SSE data: (JSON por línea)
//  - sin alt=sse → JSON plano
function startGeminiCapture() {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    if (String(req.url || '').includes('alt=sse')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
      const payload = { candidates: [{ content: { parts: [{ text: 'hola' }] } }] };
      res.end(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`);
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hola gemini' }] } }] }));
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, seen }));
  });
}

async function main() {
  console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
  console.log(C.bold('  S2: API key de Gemini fuera del query string'));
  console.log(C.bold(C.cyan('════════════════════════════════════════════════════════')));

  const { server, seen } = await startGeminiCapture();
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  const SECRET = 'AIza-super-secreta-test';

  LLMProvider.registerProvider({
    id: 'mock-gemini-s2',
    name: 'Mock Gemini S2',
    type: 'gemini',
    baseURL,
    models: { smart: 'gemini-test-smart', fast: 'gemini-test-fast' },
    free: true,
  });
  LLMProvider.configure({
    llm: {
      primary: 'mock-gemini-s2',
      apiKeys: { 'mock-gemini-s2': SECRET },
    },
  });

  // ── Test 1: no-stream — la key va en el header, no en la URL ─────────────
  await LLMProvider.complete([{ role: 'user', content: 'hola' }], 'system', { mode: 'fast' });
  const req = seen[seen.length - 1];
  assert(!String(req.url).includes(SECRET), 'la key NO aparece en la URL');
  assert(!String(req.url).includes('?key='), 'sin query param ?key=');
  assert(req.headers['x-goog-api-key'] === SECRET, 'header x-goog-api-key presente con la key');
  assert(String(req.url).includes(':generateContent'), 'endpoint generateContent correcto');

  // ── Test 2: streaming (alt=sse) — misma regla ───────────────────────────
  const tokens = [];
  await LLMProvider.complete([{ role: 'user', content: 'hola' }], 'system', {
    onToken: (t) => tokens.push(t),
  });
  const reqStream = seen[seen.length - 1];
  assert(String(reqStream.url).includes('alt=sse'), 'streaming usa alt=sse');
  assert(!String(reqStream.url).includes(SECRET), 'streaming: la key NO aparece en la URL');
  assert(!String(reqStream.url).includes('?key='), 'streaming: sin query param ?key=');
  assert(
    reqStream.headers['x-goog-api-key'] === SECRET,
    'streaming: header x-goog-api-key presente con la key'
  );
  assert(tokens.join('') === 'hola', 'streaming sigue funcionando (tokens recibidos)');

  // ── Test 3: ningún request del test llevó la key en la URL ─────────────
  assert(
    seen.every((r) => !String(r.url).includes(SECRET) && !String(r.url).includes('?key=')),
    'ningún request registrado expone la key en la URL'
  );

  LLMProvider.configure({ llm: { primary: null } });
  server.close();

  const total = passed + failed;
  console.log(
    `\n${C.bold(C.cyan(`🔐 Gemini key header: ${passed}/${total} tests passed`))}${
      failed > 0 ? C.red(` (${failed} failed)`) : C.green(' ✅')
    }`
  );
  module.exports = { passed, failed };
}

main().catch((e) => {
  console.error(C.red(`\nERROR: ${e.stack || e}`));
  process.exit(1);
});
