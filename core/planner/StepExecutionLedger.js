// @ts-check
'use strict';

const crypto = require('crypto');

const DIRECT_EVIDENCE_TOOLS = new Set([
  'desktop_mission',
  'git_commit',
  'git_push',
  'github_issue_create',
  'github_issue_comment',
  'github_issue_close',
  'github_pr_create',
  'github_pr_review',
]);
const MUTATION_TOOLS = new Set([
  'write',
  'edit',
  'apply_patch',
  'create_file',
  'edit_file',
  'code_execution',
]);

const SIGNALS = Object.freeze({
  verify: ['test', 'lint', 'typecheck', 'build', 'check', 'verific', 'valid', 'prueba'],
  inspect: ['read', 'grep', 'glob', 'status', 'list', 'search', 'review', 'revis', 'inspect'],
  mutate: [
    'write',
    'edit',
    'patch',
    'create',
    'implement',
    'modific',
    'anad',
    'agreg',
    'crea',
    'escrib',
    'editar',
  ],
  publish: ['commit', 'push', 'issue', 'pull', 'public', 'subir', 'enviar'],
});

/** @param {unknown} value */
function _words(value) {
  return new Set(
    String(value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .match(/[a-z0-9_]{3,}/g) || []
  );
}

/** @param {string} tool @param {Record<string,unknown>} params */
function _kind(tool, params) {
  const text = `${tool} ${String(params.command || '')}`.toLowerCase();
  if (DIRECT_EVIDENCE_TOOLS.has(tool) || SIGNALS.publish.some((word) => text.includes(word))) {
    return 'publish';
  }
  if (SIGNALS.verify.some((word) => text.includes(word))) return 'verify';
  if (MUTATION_TOOLS.has(tool) || SIGNALS.mutate.some((word) => tool.includes(word))) {
    return 'mutate';
  }
  return 'inspect';
}

/** @param {any} step @param {string} tool @param {Record<string,unknown>} params */
function _affinity(step, tool, params) {
  const target = _words(`${step.description || ''} ${(step.successCriteria || []).join(' ')}`);
  const source = _words(`${tool} ${JSON.stringify(params || {})}`);
  let score = 0;
  for (const word of source) if (target.has(word)) score += 3;
  const kind = _kind(tool, params);
  for (const signal of SIGNALS[kind] || []) {
    if ([...target].some((word) => word.includes(signal))) score += 2;
  }
  return score;
}

/** @param {any} step @param {string} kind */
function _directlySatisfied(step, kind) {
  const text = `${step.description || ''} ${(step.successCriteria || []).join(' ')}`.toLowerCase();
  if (kind === 'publish') return true;
  if (kind === 'verify') return SIGNALS.verify.some((word) => text.includes(word));
  if (kind === 'inspect') return SIGNALS.inspect.some((word) => text.includes(word));
  return false;
}

/**
 * Ledger determinista que vincula acciones y evidencia con un paso concreto.
 * No autoriza acciones ni usa el texto final del modelo como prueba.
 */
class StepExecutionLedger {
  /** @param {{steps?:string[],criteria?:string[],stepStates?:any[]}|null} plan */
  constructor(plan) {
    const prior = Array.isArray(plan?.stepStates) ? plan.stepStates : [];
    this.steps = (plan?.steps || []).map((description, index) => {
      const saved = prior.find((item) => Number(item.ordinal) === index + 1);
      return {
        ordinal: index + 1,
        description: String(description || ''),
        successCriteria: plan?.criteria?.[index] ? [String(plan.criteria[index])] : [],
        dependsOn: index > 0 ? [index] : [],
        status: saved?.status === 'completed' ? 'completed' : 'pending',
        evidence: Array.isArray(saved?.evidence) ? saved.evidence.slice(0, 20) : [],
      };
    });
  }

  /** @param {any} toolResult */
  record(toolResult) {
    if (!this.steps.length || !toolResult) return null;
    const action = toolResult._action || {};
    const tool = String(toolResult.tool || action.tool || 'unknown');
    const params = action.params && typeof action.params === 'object' ? action.params : {};
    const explicit = Number(action.stepOrdinal || action.step_ordinal);
    let candidates = this.steps.filter((step) => step.status !== 'completed');
    if (!candidates.length) candidates = this.steps.slice(-1);
    let step = Number.isInteger(explicit)
      ? candidates.find((item) => item.ordinal === explicit)
      : null;
    if (!step) {
      step = candidates
        .map((item, index) => ({ item, index, score: _affinity(item, tool, params) }))
        .sort((a, b) => b.score - a.score || a.index - b.index)[0]?.item;
    }
    if (!step) return null;
    const kind = _kind(tool, params);
    const evidence = {
      id: crypto
        .createHash('sha256')
        .update(`${step.ordinal}:${tool}:${Date.now()}:${step.evidence.length}`)
        .digest('hex')
        .slice(0, 16),
      tool: tool.slice(0, 80),
      kind,
      ok: Boolean(toolResult.ok),
      at: Date.now(),
      elapsedMs: Math.max(0, Number(toolResult.elapsed) || 0),
      source: tool === 'mcp' ? String(params.server || 'mcp').slice(0, 80) : 'agent_tool',
      reason: toolResult.ok
        ? 'tool_confirmed'
        : String(toolResult.error || 'tool_failed').slice(0, 300),
    };
    step.evidence.push(evidence);
    step.evidence = step.evidence.slice(-20);
    if (toolResult.ok) {
      const dependenciesComplete = step.dependsOn.every(
        (ordinal) => this.steps.find((item) => item.ordinal === ordinal)?.status === 'completed'
      );
      step.status =
        dependenciesComplete && (DIRECT_EVIDENCE_TOOLS.has(tool) || _directlySatisfied(step, kind))
          ? 'completed'
          : 'awaiting_verification';
    } else if (step.status === 'pending') {
      step.status = 'in_progress';
    }
    toolResult.stepOrdinal = step.ordinal;
    toolResult.stepEvidenceId = evidence.id;
    return evidence;
  }

  /** @param {{status?:string,reason?:string}|null|undefined} verification */
  applyVerification(verification) {
    if (verification?.status !== 'passed') return;
    for (const step of this.steps) {
      if (
        step.status !== 'awaiting_verification' ||
        !step.evidence.some((/** @type {any} */ item) => item.ok)
      )
        continue;
      if (
        !step.dependsOn.every(
          (ordinal) => this.steps.find((item) => item.ordinal === ordinal)?.status === 'completed'
        )
      ) {
        continue;
      }
      step.status = 'completed';
      step.evidence.push({
        id: crypto.randomUUID(),
        tool: 'project_verify',
        kind: 'verify',
        ok: true,
        at: Date.now(),
        elapsedMs: 0,
        source: 'verify_runner',
        reason: String(verification.reason || 'verification_passed').slice(0, 300),
      });
    }
  }

  /** @param {{steps?:string[],criteria?:string[]}|null} plan */
  snapshot(plan) {
    const stepStates = this.steps.map((step) => ({
      ordinal: step.ordinal,
      status: step.status,
      evidence: step.evidence.map((/** @type {any} */ item) => ({ ...item })),
    }));
    return {
      steps: (plan?.steps || []).slice(),
      criteria: (plan?.criteria || []).slice(),
      stepStates,
      done: stepStates.filter((step) => step.status === 'completed').length,
      total: stepStates.length,
      coverageComplete:
        stepStates.length > 0 && stepStates.every((step) => step.status === 'completed'),
    };
  }
}

/** @param {any} plan @param {any[]} toolResults @param {any} verification */
function buildStepProgress(plan, toolResults = [], verification = null) {
  const ledger = new StepExecutionLedger(plan);
  for (const result of toolResults) ledger.record(result);
  ledger.applyVerification(verification);
  return ledger.snapshot(plan);
}

module.exports = { StepExecutionLedger, buildStepProgress };
