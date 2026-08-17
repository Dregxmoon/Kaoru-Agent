'use strict';

// @ts-check
// Test de regresión del canal IPC 'agent-subagent-progress': se añadió al
// renderer del chat pero NO a las allowlists → el renderer lanzaba
// "[ipc-whitelist] canal ... no permitido para on()" y el chat no cargaba.
//
// Reglas que garantiza este test:
//   1. Todo canal que usa el renderer del chat (src/chat/*.js vía el bridge
//      `ipcRenderer = assistant`) debe existir en la allowlist local del
//      preload del chat (src/chat/preload.js). Es la lista que realmente
//      bloquea (el preload lanza si falta).
//   2. La allowlist local del chat es un subconjunto de la fuente documentada
//      (ipc/channel-whitelist.js): si un canal se añade solo en channel-whitelist
//      pero se olvida en el preload del chat, el renderer igual falla.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
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

// Extrae los nombres de canal de `const NOMBRE = new Set([ 'a', 'b', ... ])`.
function extractSet(source, name) {
  const start = source.indexOf(`const ${name}`);
  if (start < 0) return [];
  const block = source.slice(start, source.indexOf(']);', start));
  const re = /['"]([a-zA-Z0-9:_-]+)['"]/g;
  const out = [];
  let m;
  while ((m = re.exec(block))) out.push(m[1]);
  return out;
}

function readAllowlists(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf-8');
  return {
    invoke: new Set(extractSet(src, 'INVOKE_ALLOWLIST')),
    send: new Set(extractSet(src, 'SEND_ALLOWLIST')),
    on: new Set(extractSet(src, 'ON_ALLOWLIST')),
  };
}

// Canales que el renderer usa vía `ipcRenderer.*` pero que apuntan a
// funcionalidad aún NO conectada a un handler de main (botones de auto-update).
// Se excluyen explícitamente para no contaminar el chequeo de cobertura.
const KNOWN_RAW_UNWIRED = new Set(['update:download', 'update:install']);

function scanRendererChannels() {
  const files = fs.readdirSync(path.join(ROOT, 'src', 'chat')).filter((f) => f.endsWith('.js'));
  const used = { invoke: new Set(), send: new Set(), on: new Set() };
  const re =
    /(?:ipcRenderer|assistant|window\.assistant)\.(on|send|invoke)\(\s*['"]([a-zA-Z0-9:_-]+)['"]/g;
  for (const file of files) {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'chat', file), 'utf-8');
    let m;
    while ((m = re.exec(src))) {
      const kind = m[1] === 'on' ? 'on' : m[1] === 'send' ? 'send' : 'invoke';
      const channel = m[2];
      if (KNOWN_RAW_UNWIRED.has(channel)) continue;
      used[kind].add(channel);
    }
  }
  return used;
}

async function main() {
  console.log(C.bold('\n── Whitelist IPC: renderer del chat vs allowlists ──────────────'));

  const chatPreload = readAllowlists('src/chat/preload.js');
  const globalWl = readAllowlists('ipc/channel-whitelist.js');

  // Regla 1: los canales que usa el renderer existen en la allowlist del preload.
  const used = scanRendererChannels();
  const kindLabel = { invoke: 'invoke()', send: 'send()', on: 'on()' };
  for (const kind of ['invoke', 'send', 'on']) {
    const missing = [...used[kind]].filter((c) => !chatPreload[kind].has(c));
    assert(
      missing.length === 0,
      `renderer usa canales ${kindLabel[kind]} todos en preload del chat`,
      missing.length ? `faltan en src/chat/preload.js: ${missing.join(', ')}` : ''
    );
  }

  // Regla 2: la allowlist local del chat es subconjunto de channel-whitelist.js.
  for (const kind of ['invoke', 'send', 'on']) {
    const missing = [...chatPreload[kind]].filter((c) => !globalWl[kind].has(c));
    assert(
      missing.length === 0,
      `allowlist ${kindLabel[kind]} del chat ⊆ channel-whitelist.js`,
      missing.length ? `falta en ipc/channel-whitelist.js: ${missing.join(', ')}` : ''
    );
  }

  // Regla 3 (regresión concreta): el canal de subagentes debe estar en ambas.
  assert(
    chatPreload.on.has('agent-subagent-progress') && globalWl.on.has('agent-subagent-progress'),
    "'agent-subagent-progress' permitido para on() en ambas allowlists"
  );

  const total = passed + failed;
  console.log(C.bold('\n════════════════════════════════════════════════════════'));
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

module.exports = { passed, failed };
