// @ts-nocheck
'use strict';

const { ipcMain } = require('electron');

function register(ctx) {
  const { Core } = ctx;

/**
 * ejecucion segura — whitelist estricta de comandos.
 * Solo permite 3 comandos de bajo impacto: ver historial git, deshacer
 * último commit, y lint. Cualquier otro comando es rechazado.
 *
 * Modelo de seguridad: exec shell (child_process.exec) se usa porque
 * algunos comandos necesitan pipes (2>&1) y shell expansion. La defensa
 * es la allowlist exacta — no hay riesgo de inyección porque el usuario
 * solo puede enviar strings que matcheen exactamente una de las 3 entradas.
 *
 * Límites: timeout máximo 60s, buffer máximo 1MB.
 */
const EXEC_COMMAND_ALLOWLIST = new Set([
    'git log --oneline -1',        // ver último commit
    'git reset --soft HEAD~1',     // deshacer último commit (soft)
    'npx eslint . --format compact 2>&1 || true',  // lint del proyecto
]);

  ipcMain.handle('exec-command', async (e, { command, timeout }) => {
    if (!EXEC_COMMAND_ALLOWLIST.has(command)) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `comando no permitido: ${JSON.stringify(command)}`,
      };
    }
    const util = require('util');
    const exec = util.promisify(require('child_process').exec);
    const safeTimeout = Math.min(timeout || 10, 60) * 1000;
    try {
      const { stdout, stderr } = await exec(command, {
        timeout: safeTimeout,
        maxBuffer: 1024 * 1024,
      });
      return { exitCode: 0, stdout: stdout || '', stderr: stderr || '' };
    } catch (e) {
      return {
        exitCode: e.code || 1,
        stdout: e.stdout || '',
        stderr: e.stderr || e.message || '',
      };
    }
  });
}

module.exports = { register };
