// @ts-check
/**
 * verify.js — resolución del plan de verificación forzada para el AgentLoop.
 *
 * Resolución en capas (la primera que dé resultado gana):
 *   1. `agent.verify.command` en config.json — explícito del usuario, SIEMPRE
 *      gana sobre el auto-detect.
 *   2. Auto-detect en package.json del proyecto: primer script existente en el
 *      orden typecheck → lint → test → build (la suite de tests de proyectos
 *      grandes tarda minutos; un typecheck/lint corto es la verificación justa
 *      para cerrar una edición).
 *   3. Nada configurado → `{ enabled: false }` (el loop no verifica y nunca
 *      bloquea la tarea).
 *
 * El comando resultante se ejecuta por el MISMO camino que cualquier tool exec
 * (`bridge.execute('exec', { command })`), heredando el sandbox bwrap,
 * `_safeChildEnv` y el cap de MAX_EXEC_TIMEOUT. NO se crea spawn propio.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { readJsonFile } = require('../utils/fsUtils.js');

// Orden del auto-detect: typecheck/lint cortos primero; test/build al final
// (la suite completa de tests puede tardar varios minutos y no es lo que se
// quiere correr por un typo).
const AUTO_DETECT_ORDER = ['typecheck', 'lint', 'test', 'build'];

/**
 * Resuelve el plan de verificación para un run.
 * @param {string|null|undefined} configPath Ruta a config.json (opcional).
 * @param {string} projectCwd Raíz del proyecto (para leer package.json).
 * @returns {{ enabled: boolean, command?: string }}
 */
function resolveVerifyPlan(configPath, projectCwd) {
  try {
    if (configPath && fs.existsSync(configPath)) {
      const cfg = readJsonFile(configPath, null);
      const command = cfg && cfg.agent && cfg.agent.verify ? cfg.agent.verify.command : null;
      if (typeof command === 'string' && command.trim()) {
        return { enabled: true, command: command.trim() };
      }
    }
  } catch (e) {
    // config.json ilegible → se sigue al auto-detect (nunca bloquea).
  }

  try {
    const pkgPath = path.join(projectCwd, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = readJsonFile(pkgPath, null);
      const scripts = (pkg && pkg.scripts) || {};
      for (const script of AUTO_DETECT_ORDER) {
        if (typeof scripts[script] === 'string' && scripts[script].trim()) {
          return { enabled: true, command: `npm run ${script}` };
        }
      }
    }
  } catch (e) {
    // package.json ilegible → skip sin bloquear.
  }

  return { enabled: false };
}

module.exports = { resolveVerifyPlan, AUTO_DETECT_ORDER };