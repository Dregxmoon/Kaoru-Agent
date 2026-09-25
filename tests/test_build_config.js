'use strict';

// @ts-check
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const configPath = require.resolve('../scripts/build-config.js');
const secretNames = [
  'WIN_CSC_LINK',
  'WIN_CSC_KEY_PASSWORD',
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
];

/** @param {Record<string, string>} values */
function loadConfig(values) {
  const original = Object.fromEntries(secretNames.map((name) => [name, process.env[name]]));
  try {
    for (const name of secretNames) {
      if (values[name]) process.env[name] = values[name];
      else delete process.env[name];
    }
    delete require.cache[configPath];
    return require(configPath);
  } finally {
    for (const name of secretNames) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
    delete require.cache[configPath];
  }
}

const unsigned = loadConfig({});
assert.equal(require('../package.json').desktopName, 'com.asistente.personal');
assert.equal(unsigned.linux.icon, 'build/icon.png');
assert.equal(unsigned.linux.syncDesktopName, true);
assert.equal(unsigned.win.verifyUpdateCodeSignature, false);
assert.equal(unsigned.mac.identity, null);
assert.equal(unsigned.mac.hardenedRuntime, false);
assert.equal(unsigned.mac.notarize, false);

const signed = loadConfig({
  WIN_CSC_LINK: 'certificate',
  WIN_CSC_KEY_PASSWORD: 'password',
  CSC_LINK: 'certificate',
  CSC_KEY_PASSWORD: 'password',
});
assert.equal(signed.win.verifyUpdateCodeSignature, true);
assert.equal(Object.hasOwn(signed.mac, 'identity'), false);
assert.equal(signed.mac.hardenedRuntime, true);
assert.equal(signed.mac.notarize, false);

const notarized = loadConfig({
  CSC_LINK: 'certificate',
  CSC_KEY_PASSWORD: 'password',
  APPLE_ID: 'account',
  APPLE_APP_SPECIFIC_PASSWORD: 'password',
  APPLE_TEAM_ID: 'team',
});
assert.equal(notarized.mac.notarize, true);

const image = fs.readFileSync(path.resolve(__dirname, '../build/icon.png'));
assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
assert(image.readUInt32BE(16) >= 512 && image.readUInt32BE(20) >= 512);
console.log('Build config: icono y firma condicional correctos.');
