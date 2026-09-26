'use strict';

const assert = require('assert');
const cp = require('child_process');
const { EventEmitter } = require('events');
const path = require('path');
const state = require('../core/core/state.js');
const {
  startOpenClaw,
  restartOpenClawForWorkspace,
  stopOpenClaw,
} = require('../core/core/openclaw.js');

const originalFork = cp.fork;
const originalBus = state.bus;
const launches = [];
state.bus = { emit() {} };
cp.fork = (_script, _args, options) => {
  const process = new EventEmitter();
  process.pid = 999999999;
  process.stdout = new EventEmitter();
  process.stderr = new EventEmitter();
  process.kill = () => true;
  launches.push({ process, allowedPath: options.env.OPENCLAW_ALLOWED_PATH });
  return process;
};

try {
  const first = path.resolve('/tmp/kaoru-restart-first');
  const second = path.resolve('/tmp/kaoru-restart-second');
  startOpenClaw(first);
  assert.strictEqual(state.openclawStarting, true);
  restartOpenClawForWorkspace(second);
  assert.strictEqual(launches.length, 2, 'se reinicia incluso mientras el anterior arranca');
  assert.strictEqual(launches[1].allowedPath, second);
  const active = state.openclawProcess;
  launches[0].process.emit('exit', 0);
  assert.strictEqual(
    state.openclawProcess,
    active,
    'la salida del servidor viejo no borra el nuevo'
  );
  assert.strictEqual(state.openclawWorkspace, second);
  console.log('OpenClaw: cambio de workspace durante arranque conserva el servidor nuevo');
} finally {
  stopOpenClaw();
  cp.fork = originalFork;
  state.bus = originalBus;
}
