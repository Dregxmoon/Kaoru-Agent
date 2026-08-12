// @ts-check
'use strict';

// Capa de recomendación de modelos (nivel opencode). El usuario elige QUÉ
// quiere hacer (charla, tareas de agente, imágenes, económico) y aquí se
// resuelve provider+modelo según la METADATA del catálogo — nunca por IDs
// crudos. Internamente mapea al modo del pipeline ('fast'/'smart').

const LLMProvider = require('./LLMProvider.js');

/**
 * @typedef {Object} ProviderCtx contexto de un provider de getAvailableProviders()
 * @property {string} id
 * @property {string} name
 * @property {boolean} hasKey
 * @property {boolean} [free]
 * @property {Record<string, import('./catalog.js').ModelMeta>} [modelMeta]
 * @property {{fast?: string, smart?: string}} [activeModel]
 */

/**
 * Specs por tarea. mode → modo del pipeline que alimenta; requireTools/requireVision
 * filtran candidatos por capacidad (metadatos del catálogo).
 * @type {Record<string, { label: string, mode: 'fast'|'smart', requireTools: boolean, requireVision: boolean, preferFree: boolean }>}
 */
const TASKS = {
  chat: {
    label: 'Charla',
    mode: 'fast',
    requireTools: false,
    requireVision: false,
    preferFree: false,
  },
  agent: {
    label: 'Tareas de agente',
    mode: 'smart',
    requireTools: true,
    requireVision: false,
    preferFree: false,
  },
  vision: {
    label: 'Imágenes / visión',
    mode: 'smart',
    requireTools: false,
    requireVision: true,
    preferFree: false,
  },
  cheap: {
    label: 'Económico',
    mode: 'fast',
    requireTools: false,
    requireVision: false,
    preferFree: true,
  },
};

/**
 * @param {import('./catalog.js').ModelMeta} meta
 * @param {{requireTools: boolean, requireVision: boolean}} spec
 */
function _matchesTask(meta, spec) {
  if (!meta) return false;
  if (spec.requireTools && !meta.tools) return false;
  if (spec.requireVision && !meta.vision) return false;
  return true;
}

/**
 * @param {string} task
 * @param {import('./catalog.js').ModelMeta} meta
 */
function _reason(task, meta) {
  if (task === 'agent') return meta.tools ? 'Soporta herramientas (agente)' : 'Sin tools';
  if (task === 'vision') return 'Acepta imágenes';
  if (task === 'cheap') return meta.free ? 'Gratis' : 'Bajo coste';
  return 'Respuestas rápidas';
}

/**
 * @param {import('./catalog.js').ModelMeta} meta
 * @param {boolean} providerFree
 */
function _costLabel(meta, providerFree) {
  if (providerFree || meta.free) return 'gratis';
  const { in: cIn, out: cOut } = meta.cost || {};
  if (typeof cIn === 'number' && typeof cOut === 'number' && (cIn > 0 || cOut > 0)) {
    return `~$${cIn} / $${cOut} por M`;
  }
  return 'pago';
}

/**
 * Candidatos ordenados para una tarea. Un entry por provider CON key, con el
 * mejor modelo de ese provider para la tarea. Orden determinista: respeta el
 * orden de getAvailableProviders() (orden de registro); en 'cheap' los gratis
 * van primero.
 * @param {string} task
 * @param {Array<ProviderCtx>} [providers] lista de getAvailableProviders() (para tests)
 * @returns {Array<{ provider: string, providerName: string, model: string, label: string, reason: string, costLabel: string, free: boolean, tools: boolean, vision: boolean }>}
 */
function recommend(task, providers) {
  const spec = TASKS[task];
  if (!spec) return [];
  const list = providers || LLMProvider.getAvailableProviders();
  const out = [];
  for (const p of list) {
    if (!p.hasKey) continue;
    /** @type {Record<string, import('./catalog.js').ModelMeta>} */
    const meta = p.modelMeta || {};
    /** @type {{fast?: string, smart?: string}} */
    const active = p.activeModel || {};
    // Preferencia: modelo activo del rol → el otro rol → cualquier catálogo.
    const candidates = [
      active[spec.mode],
      active[spec.mode === 'fast' ? 'smart' : 'fast'],
      ...Object.keys(meta),
    ];
    const seen = new Set();
    let pick = null;
    for (const id of candidates) {
      if (!id || typeof id !== 'string' || seen.has(id)) continue;
      seen.add(id);
      const m = meta[id] || LLMProvider.getModelMeta(p.id, id) || null;
      if (_matchesTask(m, spec)) {
        pick = { id, m };
        break;
      }
    }
    if (!pick) continue;
    out.push({
      provider: p.id,
      providerName: p.name,
      model: pick.id,
      label: pick.m.label || pick.id,
      reason: _reason(task, pick.m),
      costLabel: _costLabel(pick.m, !!p.free),
      free: !!p.free || !!pick.m.free,
      tools: !!pick.m.tools,
      vision: !!pick.m.vision,
    });
  }
  if (spec.preferFree) {
    out.sort((a, b) => (a.free === b.free ? 0 : a.free ? -1 : 1));
  }
  return out;
}

/**
 * Aplica en memoria la mejor recomendación de una tarea (configura
 * llm.providers[provider].model[mode]). No persiste: eso lo hacen los comandos
 * /model y la UI. Devuelve el entry elegido o null si no hay ninguno viable.
 * @param {string} task
 * @param {Array<ProviderCtx>} [providers] lista de getAvailableProviders() (para tests)
 */
function applyRecommended(task, providers) {
  const spec = TASKS[task];
  if (!spec) return null;
  const list = recommend(task, providers);
  if (list.length === 0) return null;
  const best = list[0];
  LLMProvider.configure({
    llm: {
      providers: { [best.provider]: { model: { [spec.mode]: best.model } } },
    },
  });
  return best;
}

module.exports = { TASKS, recommend, applyRecommended };
