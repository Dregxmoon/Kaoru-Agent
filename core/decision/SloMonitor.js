'use strict';

/**
 * F-5 — SLOs por tipo de señal + degradación automática.
 *
 * El ROADMAP exige: aceptación ≥ X%, ignorados ≤ Y% por tipo, con degradación
 * automática y telemetría de "tasa de no-molestia".
 *
 *  - assess(statsPorTipo) → por tipo: { total, acceptanceRate, ignoreRate,
 *    nonNuisanceRate, degraded, sampleOk }.
 *  - acceptanceRate = accepted / (accepted + rejected): de las propuestas que
 *    el usuario SÍ respondió, cuántas aceptó.
 *  - ignoreRate      = ignored / total: cuántas dejó morir sin tocar.
 *  - nonNuisanceRate = 1 - ignoreRate: telemetría de "no molestar".
 *  - degraded        = (acceptance < minAccept) ∨ (ignore > maxIgnore), solo
 *    con muestra suficiente. Un tipo degradado se promociona más difícil
 *    (histéresis del núcleo: sube el umbral de ACT en el gate).
 *
 * Puro y determinista: la calibración vive en DEFAULT_SLOS (política).
 */

const DEFAULT_SLOS = {
  minSample: 5, // mínimo de propuestas enviadas para evaluar un tipo
  perType: {
    default: { minAccept: 0.5, maxIgnore: 0.4 },
    git_redflag:      { minAccept: 0.6, maxIgnore: 0.3 },
    system_warning:   { minAccept: 0.6, maxIgnore: 0.3 },
    lsp_error:        { minAccept: 0.6, maxIgnore: 0.3 },
    error_title:      { minAccept: 0.4, maxIgnore: 0.5 },
    clipboard_context:{ minAccept: 0.4, maxIgnore: 0.5 },
    upcoming_event:   { minAccept: 0.4, maxIgnore: 0.5 },
  },
};

const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

/**
 * Evalúa los SLO por tipo de señal.
 * @param {object} statsPorTipo  { tipo: { accepted, rejected, ignored } }
 * @param {object} [slos]        override parcial de DEFAULT_SLOS
 * @returns {object} { porTipo: {...}, global: {...} }
 */
function assess(statsPorTipo = {}, slos = DEFAULT_SLOS) {
  const merged = { ...DEFAULT_SLOS, ...slos, perType: { ...DEFAULT_SLOS.perType, ...(slos.perType || {}) } };

  const porTipo = {};
  let sumAccepted = 0, sumRejected = 0, sumIgnored = 0, sumSent = 0;

  for (const [type, s] of Object.entries(statsPorTipo)) {
    const accepted = s.accepted || 0;
    const rejected = s.rejected || 0;
    const ignored  = s.ignored || 0;
    const total    = accepted + rejected + ignored;
    const responded = accepted + rejected;

    const target = merged.perType[type] || merged.perType.default;
    const sampleOk = total >= merged.minSample;
    const acceptanceRate = responded ? round(accepted / responded) : null;
    const ignoreRate     = total ? round(ignored / total) : null;
    const nonNuisanceRate = total ? round(1 - ignoreRate) : null;

    porTipo[type] = {
      type,
      total,
      sampleOk,
      acceptanceRate,
      ignoreRate,
      nonNuisanceRate,
      degraded: sampleOk &&
        ((acceptanceRate !== null && acceptanceRate < target.minAccept) ||
         (ignoreRate !== null && ignoreRate > target.maxIgnore)),
      slo: target,
    };

    sumAccepted += accepted; sumRejected += rejected; sumIgnored += ignored; sumSent += total;
  }

  const responded = sumAccepted + sumRejected;
  return {
    porTipo,
    global: {
      sent:         sumSent,
      accepted:     sumAccepted,
      rejected:     sumRejected,
      ignored:      sumIgnored,
      acceptanceRate: responded ? round(sumAccepted / responded) : null,
      nonNuisanceRate: sumSent ? round(1 - sumIgnored / sumSent) : null,
    },
  };
}

/** Tipos que hoy están degradados (para que el gate les suba el umbral). */
function degradedTypes(statsPorTipo = {}, slos = DEFAULT_SLOS) {
  const r = assess(statsPorTipo, slos);
  return new Set(Object.values(r.porTipo).filter(t => t.degraded).map(t => t.type));
}

module.exports = { assess, degradedTypes, DEFAULT_SLOS };
