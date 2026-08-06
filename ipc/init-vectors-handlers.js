'use strict';

const { ipcMain } = require('electron');

function register(ctx) {
  const { Core } = ctx;

  const EXEC_COMMAND_ALLOWLIST = new Set([
    'git log --oneline -1',
    'git reset --soft HEAD~1',
    'npx eslint . --format compact 2>&1 || true',
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
    } catch (err) {
      return {
        exitCode: err.code || 1,
        stdout: err.stdout || '',
        stderr: err.stderr || err.message || '',
      };
    }
  });
}

module.exports = { register };
