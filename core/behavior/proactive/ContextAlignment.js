// @ts-check
'use strict';

const path = require('path');

const WORK_CATEGORIES = new Set(['code', 'terminal', 'docs', 'design', 'api']);
const MEDIA_CATEGORIES = new Set(['media', 'game']);
const SEARCH_TITLE_RE =
  /(?:^|\s)(?:google|bing|duckduckgo|startpage|brave)\s+(?:search|búsqueda)|(?:search results?|resultados? de búsqueda|buscar)(?:\s|$)/i;
const MEDIA_TITLE_RE =
  /youtube|youtu\.be|twitch|netflix|prime video|hbo|max:|crunchyroll|vimeo|kick\.com|disney|spotify|vlc|mpv/i;
const PROJECT_HINT_RE =
  /proyect|project|repo|repositorio|workspace|código|codigo|program|desarroll|implement|aplicaci|\bapp\b|feature|\bbug\b|sitio web|backend|frontend/i;
const STOPWORDS = new Set([
  'para',
  'como',
  'este',
  'esta',
  'esto',
  'desde',
  'sobre',
  'entre',
  'with',
  'from',
  'that',
  'this',
  'the',
  'and',
  'una',
  'uno',
  'del',
  'las',
  'los',
  'usuario',
  'proyecto',
  'project',
  'trabajando',
  'trabajo',
  'visual',
  'studio',
  'code',
]);

/** @param {unknown} value */
function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_-]+/g, ' ')
    .trim();
}

/** @param {unknown} value */
function termsOf(value) {
  return [
    ...new Set(
      normalize(value)
        .split(/[\s_-]+/)
        .filter((term) => term.length >= 4 && !STOPWORDS.has(term))
    ),
  ];
}

/**
 * @typedef {'work'|'browser'|'search'|'media'|'neutral'} FocusMode
 * @typedef {'match'|'mismatch'|'unknown'} WorkspaceEvidence
 * @typedef {{mode:FocusMode,text:string,terms:string[],workspaceName:string,workspaceEvidence:WorkspaceEvidence,hasConcreteFocus:boolean}} FocusContext
 */

/**
 * Construye un foco conservador. El workspace aporta identidad de proyecto,
 * pero nunca convierte por sí solo una búsqueda o un vídeo en trabajo activo.
 * @param {{osContext?:any,workspace?:string|null,focusedFile?:string|null,eventContext?:string|null}} [input]
 * @returns {FocusContext}
 */
function buildFocusContext(input = {}) {
  const osContext = input.osContext || {};
  const category = normalize(osContext.category);
  const visibleText = [osContext.friendlyName, osContext.app, osContext.title]
    .filter(Boolean)
    .join(' ');
  const eventContext = String(input.eventContext || '');
  const workspaceName = input.workspace ? path.basename(String(input.workspace)) : '';
  let mode = /** @type {FocusMode} */ ('neutral');
  if (MEDIA_CATEGORIES.has(category) || MEDIA_TITLE_RE.test(visibleText)) mode = 'media';
  else if (category === 'browser' && SEARCH_TITLE_RE.test(visibleText)) mode = 'search';
  else if (WORK_CATEGORIES.has(category)) mode = 'work';
  else if (category === 'browser') mode = 'browser';

  let workspaceEvidence = /** @type {WorkspaceEvidence} */ ('unknown');
  if (input.workspace && input.focusedFile) {
    const relative = path.relative(
      path.resolve(String(input.workspace)),
      path.resolve(String(input.focusedFile))
    );
    workspaceEvidence =
      relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? 'match' : 'mismatch';
  } else if (
    workspaceName &&
    affinityToFocus(workspaceName, {
      mode,
      text: normalize(visibleText),
      terms: termsOf(visibleText),
      workspaceName: '',
      workspaceEvidence: 'unknown',
      hasConcreteFocus: true,
    }) > 0
  ) {
    workspaceEvidence = 'match';
  }
  const contextualBase = [visibleText, eventContext].filter(Boolean).join(' ');
  const contextText =
    mode === 'media' || mode === 'search'
      ? visibleText
      : mode === 'neutral' && workspaceName
        ? `${contextualBase} ${workspaceName}`
        : contextualBase;
  return {
    mode,
    text: normalize(contextText),
    terms: termsOf(contextText),
    workspaceName,
    workspaceEvidence,
    hasConcreteFocus: termsOf(visibleText).length > 0,
  };
}

/** @param {unknown} subject @param {FocusContext} focus */
function affinityToFocus(subject, focus) {
  const subjectTerms = termsOf(subject);
  if (!subjectTerms.length || !focus.terms.length) return 0;
  const hits = subjectTerms.filter((term) => focus.terms.includes(term)).length;
  return hits / Math.min(3, subjectTerms.length);
}

/** @param {any} trigger */
function triggerNeedsContextMatch(trigger) {
  if (!trigger) return false;
  if (trigger.type === 'intention_stale' || trigger.type === 'topic_cold') return true;
  if (!['memory_stale', 'pattern_uncertain', 'memory_tension'].includes(trigger.type)) return false;
  return PROJECT_HINT_RE.test(
    [trigger.label, trigger.content, trigger.contentA, trigger.contentB, trigger.goal]
      .filter(Boolean)
      .join(' ')
  );
}

/**
 * Un candidato ligado a proyecto/tema solo puede hablar si el foco actual lo
 * respalda. Ante búsqueda, vídeo o proyecto distinto se abstiene.
 * @param {any} trigger
 * @param {FocusContext} focus
 */
function assessTriggerAlignment(trigger, focus) {
  if (!trigger) return { allow: false, reason: 'no_trigger', affinity: 0 };
  if (focus.mode === 'media') return { allow: false, reason: 'media_focus', affinity: 0 };
  if (focus.mode === 'search') return { allow: false, reason: 'search_focus', affinity: 0 };

  const subject = [
    trigger.label,
    trigger.content,
    trigger.contentA,
    trigger.contentB,
    trigger.goal,
    trigger.lastProgress,
    trigger.trait,
  ]
    .filter(Boolean)
    .join(' ');
  const affinity = affinityToFocus(subject, focus);

  if (trigger.type === 'knowledge_gap') {
    const workGap = ['trabajo', 'lenguaje_programacion'].includes(trigger.gapKey || trigger.kind);
    if (focus.mode === 'work' && workGap) {
      return { allow: true, reason: 'work_relevant_gap', affinity };
    }
    if (focus.mode === 'work' || focus.mode === 'browser') {
      return affinity > 0
        ? { allow: true, reason: 'context_match', affinity }
        : { allow: false, reason: 'personal_gap_out_of_context', affinity: 0 };
    }
    return { allow: true, reason: 'neutral_personal_gap', affinity };
  }

  if (!triggerNeedsContextMatch(trigger)) {
    if ((focus.mode === 'work' || focus.mode === 'browser') && affinity === 0) {
      return { allow: false, reason: 'personal_topic_out_of_context', affinity: 0 };
    }
    return { allow: true, reason: 'personal_or_general', affinity };
  }

  if (trigger.workspace) {
    const intentionWorkspace = path.basename(String(trigger.workspace));
    const sameWorkspace = normalize(intentionWorkspace) === normalize(focus.workspaceName);
    const workspaceAffinity = affinityToFocus(intentionWorkspace, focus);
    const currentWorkspaceVisible =
      focus.mode === 'neutral' || focus.workspaceEvidence === 'match' || workspaceAffinity > 0;
    if (sameWorkspace && currentWorkspaceVisible) {
      return { allow: true, reason: 'workspace_match', affinity: workspaceAffinity };
    }
    return { allow: false, reason: 'different_project', affinity: 0 };
  }

  if (affinity > 0) return { allow: true, reason: 'context_match', affinity };
  return {
    allow: false,
    reason: focus.hasConcreteFocus ? 'different_context' : 'no_context',
    affinity,
  };
}

/**
 * Los datos personales pueden acompañar transversalmente; los proyectos y
 * creencias técnicas necesitan afinidad positiva con el foco visible.
 * @param {any} node
 * @param {FocusContext} focus
 */
function memoryAllowedForFocus(node, focus) {
  if (!node) return false;
  const subject = `${node.label || ''} ${node.content || ''}`;
  const scoped =
    node.type === 'Project' || (node.type === 'Belief' && PROJECT_HINT_RE.test(subject));
  if (!scoped) return true;
  if (focus.mode === 'media' || focus.mode === 'search') return false;
  return affinityToFocus(subject, focus) > 0;
}

/** @param {unknown} text @param {FocusContext} focus */
function narrativeAllowedForFocus(text, focus) {
  if (focus.mode === 'media' || focus.mode === 'search') return false;
  return affinityToFocus(text, focus) > 0;
}

module.exports = {
  affinityToFocus,
  assessTriggerAlignment,
  buildFocusContext,
  memoryAllowedForFocus,
  narrativeAllowedForFocus,
  termsOf,
  triggerNeedsContextMatch,
};
