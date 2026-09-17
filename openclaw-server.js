// @ts-check
'use strict';

// Entrada heredada para instalaciones, scripts y plugins anteriores. El host
// mantenido por Kaoru vive en kaoru-tool-host.js.
const host = require('./kaoru-tool-host.js');

if (require.main === module) {
  const apiKey = process.env.KAORU_TOOL_HOST_API_KEY || process.env.OPENCLAW_API_KEY;
  if (!apiKey) {
    process.stderr.write('KAORU_TOOL_HOST_API_KEY no definida — abortando\n');
    process.exit(1);
  }
  host.startServer().catch((error) => {
    process.stderr.write(`kaoru-tool-host no pudo iniciar: ${error.message}\n`);
    process.exit(1);
  });
  const stop = () => host.stopServer().finally(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

module.exports = host;
