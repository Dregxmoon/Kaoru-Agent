// @ts-check
'use strict';

const path = require('path');
const { isHighImpact } = require('../planner/ActionParser.js');
const { isIrreversible } = require('./IrreversiblePolicy.js');
const {
  capabilityForTool,
  capabilityPermissionTool,
} = require('../desktop/DesktopCapabilities.js');

const MISSION_GRANTED_TOOLS = new Set([
  'list_apps',
  'launch_app',
  'window_list',
  'window_focus',
  'desktop_snapshot',
  'desktop_capabilities',
  'ui_get_state',
  'ui_wait',
  'ui_click',
  'ui_type',
  'ui_press',
  'ui_select',
  'ui_scroll',
]);
const OBSERVED_ACTIONS = new Set([
  'window_focus',
  'ui_get_state',
  'ui_click',
  'ui_type',
  'ui_press',
  'ui_select',
  'ui_scroll',
]);

/** @param {unknown} value */
function normalizeApplication(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase();
}

/**
 * Concesión temporal creada solo después de aprobar la misión en la UI. No
 * concede permisos a herramientas fuera del escritorio semántico.
 */
class MissionGrant {
  /**
   * @param {{applications:string[],now?:()=>number,maxActions?:number,durationMs?:number,
   * resolveObservedApplication?:(params:Record<string,unknown>)=>string}} input
   */
  constructor(input) {
    const applications = Array.isArray(input.applications) ? input.applications : [];
    this.applications = new Set(applications.map(normalizeApplication).filter(Boolean));
    this._now = input.now || Date.now;
    this.expiresAt =
      this._now() + Math.min(20 * 60_000, Math.max(60_000, input.durationMs || 15 * 60_000));
    this.maxActions = Math.min(80, Math.max(1, input.maxActions || 60));
    this.usedActions = 0;
    this._resolveObservedApplication = input.resolveObservedApplication || null;
    this.currentApplication = '';
  }

  /** @param {string} application */
  setStepApplication(application) {
    const normalized = normalizeApplication(application);
    if (!this.applications.has(normalized))
      throw new Error('Aplicación fuera del alcance de la misión');
    this.currentApplication = normalized;
  }

  /** @param {unknown} application */
  _withinScope(application) {
    const normalized = normalizeApplication(application);
    return (
      this.applications.has(normalized) &&
      (!this.currentApplication || normalized === this.currentApplication)
    );
  }

  /** @param {{tool:string,params?:Record<string,unknown>}} action */
  allows(action) {
    if (this._now() >= this.expiresAt || this.usedActions >= this.maxActions) return false;
    if (!MISSION_GRANTED_TOOLS.has(action.tool) || !this.applications.size) return false;
    const params = action.params || {};
    if (action.tool === 'desktop_capabilities') return true;
    if (action.tool === 'list_apps') return this._withinScope(params.query);
    if (action.tool === 'launch_app') {
      return this._withinScope(params.app);
    }
    if (OBSERVED_ACTIONS.has(action.tool)) {
      try {
        const application = this._resolveObservedApplication?.(params) || '';
        return this._withinScope(application);
      } catch (_) {
        return false;
      }
    }
    return this._withinScope(params.application);
  }

  /** Consume el presupuesto antes de ejecutar, incluso si la tool falla. */
  consume() {
    this.usedActions++;
  }
}

/**
 * Evaluación compartida por AgentLoop y DesktopMissionLoop. El modelo propone;
 * esta función decide fuera del modelo si se permite, consulta o bloquea.
 * @param {{tool:string,params?:Record<string,unknown>}} action
 * @param {{permissionManager?:any,workspace?:string,missionGrant?:MissionGrant|null,
 * forceApproval?:boolean}} [options]
 */
function assessAction(action, options = {}) {
  const irreversible = isIrreversible(action);
  const requiresApproval = irreversible || isHighImpact(action.tool, action.params || {});
  let permissionAction = /** @type {'allow'|'ask'|'deny'} */ (requiresApproval ? 'ask' : 'allow');
  const permissionManager = options.permissionManager || null;
  if (permissionManager?.check) {
    const desktopCapability = capabilityForTool(action.tool);
    const capabilityPermission = desktopCapability
      ? permissionManager.check({
          tool: capabilityPermissionTool(desktopCapability),
          path: '',
          defaultAction: 'ask',
        })
      : null;
    const params = action.params || {};
    const targetPath = String(params.path || params.filePath || params.cwd || '');
    const permissionPath = targetPath
      ? path.resolve(options.workspace || process.cwd(), targetPath)
      : '';
    const perm = permissionManager.check({
      tool: action.tool,
      path: permissionPath,
      defaultAction: requiresApproval ? 'ask' : 'allow',
    });
    permissionAction = perm.action;
    if (capabilityPermission?.rule?.action === 'deny') permissionAction = 'deny';
  }
  const grantCoversAction =
    options.missionGrant?.allows(action) === true && !irreversible && permissionAction !== 'deny';
  if (grantCoversAction) permissionAction = 'allow';
  if (permissionAction !== 'deny' && (irreversible || options.forceApproval)) {
    permissionAction = 'ask';
  }
  return {
    irreversible,
    requiresApproval: requiresApproval || options.forceApproval === true,
    permissionAction,
    grantCoversAction,
  };
}

/**
 * @param {{permissionAction:'allow'|'ask'|'deny',requiresApproval:boolean,grantCoversAction:boolean}} assessment
 * @param {{tool:string,params?:Record<string,unknown>}} action
 * @param {{onApprovalNeeded?:(action:any)=>Promise<any>,missionGrant?:MissionGrant|null}} [options]
 */
async function requestActionApproval(assessment, action, options = {}) {
  if (assessment.permissionAction === 'deny')
    return { approved: false, reason: 'blocked_by_policy' };
  if (assessment.permissionAction === 'ask') {
    if (!options.onApprovalNeeded) return { approved: false, reason: 'approval_handler_missing' };
    const decision = await options.onApprovalNeeded(action);
    const objectDecision = decision !== null && typeof decision === 'object';
    const approved = objectDecision ? Boolean(decision.approved) : Boolean(decision);
    return {
      approved,
      reason: approved ? null : objectDecision ? String(decision.reason || 'denied') : 'denied',
      prompted: true,
    };
  }
  if (assessment.grantCoversAction && !options.missionGrant?.allows(action)) {
    return { approved: false, reason: 'mission_grant_expired' };
  }
  if (assessment.grantCoversAction) options.missionGrant?.consume();
  return { approved: true, reason: null, prompted: false };
}

module.exports = {
  MissionGrant,
  MISSION_GRANTED_TOOLS,
  assessAction,
  requestActionApproval,
};
