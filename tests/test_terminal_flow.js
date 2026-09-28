'use strict';

const assert = require('node:assert/strict');
const { TerminalService } = require('../core/terminal/TerminalService.js');

async function main() {
  const packets = [];
  let onData;
  let onExit;
  let pauses = 0;
  let resumes = 0;
  const inputs = [];
  let ptyOptions;
  const child = {
    onData: (callback) => {
      onData = callback;
    },
    onExit: (callback) => {
      onExit = callback;
    },
    write: (data) => inputs.push(data),
    resize: () => {},
    kill: () => {},
    pause: () => {
      pauses++;
    },
    resume: () => {
      resumes++;
    },
  };
  const service = new TerminalService({
    send: (channel, payload) => packets.push({ channel, ...payload }),
    spawnPty: (_file, _args, options) => {
      ptyOptions = options;
      return child;
    },
  });
  const id = 7;
  service.open(id, process.cwd());
  assert.equal(ptyOptions.env.KAORU_INTEGRATED_TERMINAL, '1');
  for (let index = 0; index < 1000; index++) onData('x');
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(packets.length, 1, 'mil fragmentos pequeños usan un solo paquete IPC');
  assert.equal(packets[0].data, 'x'.repeat(1000));
  assert.equal(packets[0].seq, 1000);
  assert.deepEqual(service.metrics(id), {
    chunksReceived: 1000,
    packetsSent: 1,
    paused: false,
  });

  onData('final');
  const snapshot = service.open(id, process.cwd());
  assert.equal(snapshot.seq, 1001);
  assert(snapshot.scrollback.endsWith('final'));
  assert.equal(packets[1].data, 'final', 'se vacía el lote antes del snapshot');
  assert.equal(packets[1].seq, snapshot.seq);

  assert.equal(service.setFlow(id, true), true);
  assert.equal(service.setFlow(id, true), false);
  assert.equal(service.write(id, 'echo listo\r'), true);
  assert.equal(service.write(id, '\t\x03'), true);
  assert.deepEqual(
    inputs,
    ['echo listo\r', '\t\x03'],
    'Tab y Ctrl+C se entregan al PTY incluso si la salida está pausada'
  );
  assert.equal(service.setFlow(id, false), true);
  assert.equal(pauses, 1);
  assert.equal(resumes, 1);
  onData('salida de cierre');
  onExit({ exitCode: 0 });
  assert.equal(packets.at(-2).data, 'salida de cierre');
  assert.equal(packets.at(-1).channel, 'terminal-exit');
  assert.equal(service.metrics(id), null);
  console.log('Terminal: lotes, snapshot sin solapamiento y flujo PTY OK');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
