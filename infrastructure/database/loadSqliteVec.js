// @ts-check
'use strict';

const fs = require('fs');
const sqliteVec = require('sqlite-vec');

/**
 * SQLite carga extensiones mediante rutas del sistema operativo. Si el binario
 * está fuera de app.asar, la ruta virtual del paquete no sirve para SQLite.
 * @param {{loadExtension: (path: string) => void}} db
 */
function loadSqliteVec(db) {
  const resolved = sqliteVec.getLoadablePath();
  const unpacked = resolved.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  const nativePath = unpacked !== resolved && fs.existsSync(unpacked) ? unpacked : resolved;
  db.loadExtension(nativePath);
}

module.exports = { loadSqliteVec };
