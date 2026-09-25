'use strict';

// @ts-check
// Conserva los builds de prueba sin firma; activa la verificación y la
// notarización solo cuando CI dispone de las credenciales correspondientes.
const { build } = require('../package.json');

/** @type {typeof build} */
const config = JSON.parse(JSON.stringify(build));
const windowsSigned = Boolean(process.env.WIN_CSC_LINK && process.env.WIN_CSC_KEY_PASSWORD);
const macSigned = Boolean(process.env.CSC_LINK && process.env.CSC_KEY_PASSWORD);
const macNotarized = Boolean(
  process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID
);

if (windowsSigned) config.win.verifyUpdateCodeSignature = true;
if (macSigned) {
  delete config.mac.identity;
  config.mac.hardenedRuntime = true;
  config.mac.notarize = macNotarized;
}

module.exports = config;
