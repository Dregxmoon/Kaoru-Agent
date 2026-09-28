'use strict';

const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { TerminalService } = require('../core/terminal/TerminalService.js');

async function main() {
  const packets = [];
  let onData;
  const service = new TerminalService({
    send: (channel, payload) => {
      if (channel === 'terminal-data') packets.push(payload);
    },
    spawnPty: () => ({
      onData: (callback) => {
        onData = callback;
      },
      onExit: () => {},
      write: () => {},
      resize: () => {},
      kill: () => {},
    }),
  });
  service.open(1, process.cwd());
  const chunk = 'x'.repeat(1024);
  const started = performance.now();
  for (let index = 0; index < 8192; index++) onData(chunk);
  const snapshot = service.open(1, process.cwd());
  const elapsed = Math.round(performance.now() - started);
  assert.equal(snapshot.seq, 8192);
  assert.equal(snapshot.scrollback.length, 256 * 1024, 'el historial queda acotado');
  assert.equal(
    packets.reduce((length, packet) => length + packet.data.length, 0),
    8 * 1024 * 1024,
    'la salida masiva no pierde bytes'
  );
  assert(packets.length <= 512, 'los fragmentos se agrupan antes de enviarlos al renderer');
  assert.equal(service.metrics(1).packetsSent, packets.length);
  service.closeAll();
  console.log(`Terminal: 8 MiB en ${elapsed} ms, ${packets.length} paquetes, historial acotado OK`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
