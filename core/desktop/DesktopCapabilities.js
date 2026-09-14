// @ts-check
'use strict';

/**
 * Capacidades de escritorio controlables por el usuario. Una regla
 * `capability:<id> = deny` desactiva toda la familia antes de solicitar una
 * aprobación puntual. Habilitarla no sustituye el consentimiento por acción.
 */
const DESKTOP_CAPABILITIES = Object.freeze([
  { id: 'applications', label: 'Aplicaciones' },
  { id: 'browser', label: 'Navegador y multimedia' },
  { id: 'screen', label: 'Pantalla y accesibilidad' },
  { id: 'pointer', label: 'Puntero y controles' },
  { id: 'keyboard', label: 'Teclado en controles observados' },
  { id: 'processes', label: 'Procesos' },
  { id: 'camera', label: 'Cámara' },
]);

/**
 * Mapa tool → familia, DERIVADO de la tabla única (ToolPolicy.js).
 * No editar a mano: agregar la capability en la tabla y la paridad la
 * verifica tests/test_tool_policy.js.
 */
const { toolCapabilities } = require('../security/ToolPolicy.js');

/** @type {Readonly<Record<string, string>>} */
const TOOL_CAPABILITIES = toolCapabilities();

/** @param {unknown} tool @returns {string|null} */
function capabilityForTool(tool) {
  return TOOL_CAPABILITIES[String(tool || '')] || null;
}

/** @param {unknown} capability @returns {string} */
function capabilityPermissionTool(capability) {
  return `capability:${String(capability || '')}`;
}

module.exports = {
  DESKTOP_CAPABILITIES,
  TOOL_CAPABILITIES,
  capabilityForTool,
  capabilityPermissionTool,
};
