// @ts-check
'use strict';

/**
 * ToolPolicy.js — TABLA ÚNICA DE AUTORIDAD de permisos por herramienta.
 *
 * Antes convivían tres listas mantenidas a mano que debían coincidir:
 *   1. `isHighImpact()` en ActionParser.js (¿pide aprobación?),
 *   2. `TOOL_CAPABILITIES` en DesktopCapabilities.js (¿a qué familia pertenece?),
 *   3. `alwaysPromptTools` en ipc/openclaw-handlers.js (¿ni autoApprove la salta?),
 * IrreversiblePolicy mantiene aparte la detección sensible a parámetros.
 * Una sola omisión al agregar una tool = bypass silencioso de aprobación.
 *
 * Ahora la tabla vive AQUÍ. Los otros módulos delegan en ella para la parte
 * estática; la lógica sensible a parámetros (exec/read/write/edit/paths,
 * mcp, git_stash...) sigue en ActionParser.js porque depende del contenido.
 *
 * impact:
 *   'high'    → requiere aprobación salvo permiso allow o aprobación de sesión.
 *   'low'     → no pide aprobación por sí misma.
 *   'dynamic' → lo decide ActionParser según params (ver isHighImpact).
 * capability: familia DesktopCapabilities o null.
 * alwaysPrompt: excluida de agent.autoApprove; permisos y sesión siguen aparte.
 */

/** @type {Readonly<Record<string, {impact: 'high'|'low'|'dynamic', capability: string|null, alwaysPrompt: boolean}>>} */
const TOOL_POLICY = Object.freeze({
  // ── Navegador y multimedia ──────────────────────────────────────────────
  browser: { impact: 'high', capability: 'browser', alwaysPrompt: true },
  open_website: { impact: 'high', capability: 'browser', alwaysPrompt: false },
  play_media: { impact: 'high', capability: 'browser', alwaysPrompt: false },
  personal_browser_detect: { impact: 'high', capability: 'browser', alwaysPrompt: true },
  personal_browser_link: { impact: 'high', capability: 'browser', alwaysPrompt: true },
  personal_browser_status: { impact: 'high', capability: 'browser', alwaysPrompt: true },
  personal_browser_close: { impact: 'high', capability: 'browser', alwaysPrompt: true },
  personal_browser_login: { impact: 'high', capability: 'browser', alwaysPrompt: true },
  // ── Escritorio: aplicaciones ────────────────────────────────────────────
  list_apps: { impact: 'high', capability: 'applications', alwaysPrompt: false },
  launch_app: { impact: 'high', capability: 'applications', alwaysPrompt: false },
  window_list: { impact: 'high', capability: 'applications', alwaysPrompt: true },
  window_focus: { impact: 'high', capability: 'applications', alwaysPrompt: true },
  window_close: { impact: 'high', capability: 'applications', alwaysPrompt: true },
  // ── Pantalla y accesibilidad ────────────────────────────────────────────
  desktop_snapshot: { impact: 'high', capability: 'screen', alwaysPrompt: true },
  desktop_screenshot: { impact: 'high', capability: 'screen', alwaysPrompt: true },
  ocr_query: { impact: 'high', capability: 'screen', alwaysPrompt: false },
  ui_get_state: { impact: 'high', capability: 'screen', alwaysPrompt: true },
  ui_wait: { impact: 'high', capability: 'screen', alwaysPrompt: true },
  // ── Puntero y teclado ───────────────────────────────────────────────────
  pointer_click: { impact: 'high', capability: 'pointer', alwaysPrompt: true },
  ui_click: { impact: 'high', capability: 'pointer', alwaysPrompt: true },
  ui_select: { impact: 'high', capability: 'pointer', alwaysPrompt: true },
  ui_scroll: { impact: 'high', capability: 'pointer', alwaysPrompt: true },
  ui_type: { impact: 'high', capability: 'keyboard', alwaysPrompt: true },
  ui_press: { impact: 'high', capability: 'keyboard', alwaysPrompt: true },
  // ── Procesos y cámara ───────────────────────────────────────────────────
  process_list: { impact: 'high', capability: 'processes', alwaysPrompt: true },
  process_stop: { impact: 'high', capability: 'processes', alwaysPrompt: true },
  camera_status: { impact: 'high', capability: 'camera', alwaysPrompt: true },
  open_camera: { impact: 'high', capability: 'camera', alwaysPrompt: true },
  desktop_capabilities: { impact: 'high', capability: null, alwaysPrompt: true },
  // ── Archivos y shell (dinámicos por params — ver ActionParser) ──────────
  exec: { impact: 'dynamic', capability: null, alwaysPrompt: false },
  read: { impact: 'dynamic', capability: null, alwaysPrompt: false },
  write: { impact: 'dynamic', capability: null, alwaysPrompt: false },
  edit: { impact: 'dynamic', capability: null, alwaysPrompt: false },
  edit_file: { impact: 'dynamic', capability: null, alwaysPrompt: false },
  create_file: { impact: 'dynamic', capability: null, alwaysPrompt: false },
  apply_patch: { impact: 'high', capability: null, alwaysPrompt: false },
  code_execution: { impact: 'high', capability: null, alwaysPrompt: false },
  grep: { impact: 'low', capability: null, alwaysPrompt: false },
  glob: { impact: 'low', capability: null, alwaysPrompt: false },
  // ── Web de solo lectura ─────────────────────────────────────────────────
  web_search: { impact: 'low', capability: null, alwaysPrompt: false },
  websearch: { impact: 'low', capability: null, alwaysPrompt: false },
  webfetch: { impact: 'low', capability: null, alwaysPrompt: false },
  // ── Git / GitHub ────────────────────────────────────────────────────────
  git_status: { impact: 'low', capability: null, alwaysPrompt: false },
  git_diff: { impact: 'low', capability: null, alwaysPrompt: false },
  git_log: { impact: 'low', capability: null, alwaysPrompt: false },
  git_branch: { impact: 'low', capability: null, alwaysPrompt: false },
  git_add: { impact: 'high', capability: null, alwaysPrompt: false },
  git_commit: { impact: 'high', capability: null, alwaysPrompt: false },
  git_stash: { impact: 'dynamic', capability: null, alwaysPrompt: false },
  git_merge: { impact: 'high', capability: null, alwaysPrompt: false },
  git_rebase: { impact: 'high', capability: null, alwaysPrompt: false },
  git_push: { impact: 'high', capability: null, alwaysPrompt: false },
  github_repo_info: { impact: 'low', capability: null, alwaysPrompt: false },
  github_issue_list: { impact: 'low', capability: null, alwaysPrompt: false },
  github_issue_create: { impact: 'high', capability: null, alwaysPrompt: false },
  github_issue_comment: { impact: 'high', capability: null, alwaysPrompt: false },
  github_issue_close: { impact: 'high', capability: null, alwaysPrompt: false },
  github_pr_list: { impact: 'low', capability: null, alwaysPrompt: false },
  github_pr_create: { impact: 'high', capability: null, alwaysPrompt: false },
  github_pr_review: { impact: 'high', capability: null, alwaysPrompt: false },
  github_actions_status: { impact: 'low', capability: null, alwaysPrompt: false },
  // ── LSP ─────────────────────────────────────────────────────────────────
  get_diagnostics: { impact: 'low', capability: null, alwaysPrompt: false },
  go_to_definition: { impact: 'low', capability: null, alwaysPrompt: false },
  find_references: { impact: 'low', capability: null, alwaysPrompt: false },
  go_to_implementation: { impact: 'low', capability: null, alwaysPrompt: false },
  completion: { impact: 'low', capability: null, alwaysPrompt: false },
  signature_help: { impact: 'low', capability: null, alwaysPrompt: false },
  call_hierarchy: { impact: 'low', capability: null, alwaysPrompt: false },
  get_symbols: { impact: 'low', capability: null, alwaysPrompt: false },
  workspace_symbols: { impact: 'low', capability: null, alwaysPrompt: false },
  hover: { impact: 'low', capability: null, alwaysPrompt: false },
  rename: { impact: 'dynamic', capability: null, alwaysPrompt: false },
  code_actions: { impact: 'low', capability: null, alwaysPrompt: false },
  // ── Subagentes ──────────────────────────────────────────────────────────
  subagent: { impact: 'low', capability: null, alwaysPrompt: false },
  subagent_batch: { impact: 'low', capability: null, alwaysPrompt: false },
  // ── MCP (dinámico: importa tools ajenas en runtime) ──────────────────────
  mcp: { impact: 'dynamic', capability: null, alwaysPrompt: false },
  // ── Plugins: código arbitrario del usuario → siempre preguntar ────────────
  plugin: { impact: 'high', capability: null, alwaysPrompt: false },
});

/** @param {unknown} tool @returns {{impact: string, capability: string|null, alwaysPrompt: boolean}|null} */
function policyFor(tool) {
  const entry = TOOL_POLICY[String(tool || '')];
  return entry || null;
}

/** @param {unknown} tool @returns {boolean} */
function isAlwaysPrompt(tool) {
  const entry = TOOL_POLICY[String(tool || '')];
  return !!entry && entry.alwaysPrompt === true;
}

/** @returns {Set<string>} conjunto para el handler de aprobaciones (se genera, no se copia). */
function alwaysPromptTools() {
  const set = new Set();
  for (const [name, entry] of Object.entries(TOOL_POLICY)) {
    if (entry.alwaysPrompt) set.add(name);
  }
  return set;
}

/** @returns {Readonly<Record<string, string>>} mapa tool → capability derivado de la tabla. */
function toolCapabilities() {
  /** @type {Record<string, string>} */
  const map = {};
  for (const [name, entry] of Object.entries(TOOL_POLICY)) {
    if (entry.capability) map[name] = entry.capability;
  }
  return Object.freeze(map);
}

module.exports = {
  TOOL_POLICY,
  policyFor,
  isAlwaysPrompt,
  alwaysPromptTools,
  toolCapabilities,
};
