// @ts-nocheck
'use strict';

/**
 * F-2 — Normalización de señales → candidatos.
 *
 * Convierte los payloads brutos que emiten los sensores en un candidato
 * uniforme que el núcleo de decisión (F-1) puede puntuar:
 *
 *   candidato = {
 *     tipo,          // git_redflag | system_warning | lsp_error | error_title | clipboard_context | upcoming_event
 *     kind,          // variante del sensor (p. ej. 'env_unignored', 'battery_critical')
 *     urgencia,      // [0,1] qué tan urgente es
 *     confianza,     // [0,1] qué tan confiable es la señal (sensores deterministas ≈ 1)
 *     accionabilidad,// [0,1] si hay algo concreto que hacer
 *     saliencia,     // [0,1] si está delante de los ojos del usuario ahora
 *     signal: { severity, actionability, salience, costOfIgnore },  // vector F-1
 *     source: { sensor, at },
 *     payload,       // copia del payload bruto (para contexto del LLM)
 *   }
 *
 * Todo es puro y determinista: la calibración de umbrales vive en la política,
 * no aquí. La urgencia temporal (eventos próximos) se resuelve con `now`.
 */

const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

// Perfil base por tipo: define el vector de señal y los campos semánticos.
// `severity` se puede ajustar después según el payload (count, pct, focused...).
const PROFILES = {
  git_redflag: {
    env_unignored: {
      severity: 0.9,
      actionability: 0.9,
      salience: 0.2,
      costOfIgnore: 1.0,
      urgencia: 0.85,
      confianza: 0.95,
    },
    merge_conflict: {
      severity: 0.8,
      actionability: 0.8,
      salience: 0.3,
      costOfIgnore: 0.7,
      urgencia: 0.75,
      confianza: 0.95,
    },
    uncommitted: {
      severity: 0.4,
      actionability: 0.6,
      salience: 0.2,
      costOfIgnore: 0.2,
      urgencia: 0.35,
      confianza: 0.9,
    },
    unpushed_commits: {
      severity: 0.5,
      actionability: 0.6,
      salience: 0.2,
      costOfIgnore: 0.3,
      urgencia: 0.45,
      confianza: 0.9,
    },
    default: {
      severity: 0.5,
      actionability: 0.5,
      salience: 0.2,
      costOfIgnore: 0.3,
      urgencia: 0.5,
      confianza: 0.9,
    },
  },
  system_warning: {
    battery_critical: {
      severity: 0.85,
      actionability: 0.4,
      salience: 0.5,
      costOfIgnore: 0.9,
      urgencia: 0.8,
      confianza: 0.95,
    },
    battery_low: {
      severity: 0.5,
      actionability: 0.3,
      salience: 0.4,
      costOfIgnore: 0.4,
      urgencia: 0.45,
      confianza: 0.95,
    },
    disk: {
      severity: 0.6,
      actionability: 0.4,
      salience: 0.3,
      costOfIgnore: 0.5,
      urgencia: 0.55,
      confianza: 0.9,
    },
    memory: {
      severity: 0.55,
      actionability: 0.3,
      salience: 0.3,
      costOfIgnore: 0.5,
      urgencia: 0.5,
      confianza: 0.9,
    },
    cpu: {
      severity: 0.4,
      actionability: 0.2,
      salience: 0.3,
      costOfIgnore: 0.3,
      urgencia: 0.35,
      confianza: 0.9,
    },
    default: {
      severity: 0.5,
      actionability: 0.3,
      salience: 0.3,
      costOfIgnore: 0.4,
      urgencia: 0.5,
      confianza: 0.9,
    },
  },
  lsp_error: {
    default: {
      severity: 0.6,
      actionability: 0.7,
      salience: 0.5,
      costOfIgnore: 0.4,
      urgencia: 0.6,
      confianza: 0.9,
    },
  },
  error_title: {
    default: {
      severity: 0.5,
      actionability: 0.2,
      salience: 0.8,
      costOfIgnore: 0.4,
      urgencia: 0.5,
      confianza: 0.6,
    },
  },
  clipboard_context: {
    stacktrace: {
      severity: 0.5,
      actionability: 0.6,
      salience: 0.6,
      costOfIgnore: 0.4,
      urgencia: 0.5,
      confianza: 0.7,
    },
    url: {
      severity: 0.2,
      actionability: 0.4,
      salience: 0.5,
      costOfIgnore: 0.1,
      urgencia: 0.2,
      confianza: 0.6,
    },
    default: {
      severity: 0.3,
      actionability: 0.4,
      salience: 0.5,
      costOfIgnore: 0.2,
      urgencia: 0.3,
      confianza: 0.6,
    },
  },
  upcoming_event: {
    default: {
      severity: 0.3,
      actionability: 0.1,
      salience: 0.4,
      costOfIgnore: 0.2,
      urgencia: 0.4,
      confianza: 0.8,
    },
  },
};

// Perfiles para los triggers TEMPORALES (F-4, Gap 2): su condición de disparo
// (horas de silencio, vuelta de una pausa, fecha especial...) ya validó el
// momento. El gate los marca `selfGated`: solo impone presupuesto y SLO, no
// chat/idle/flow. Igual generan score + audit (ROADMAP: cada mensaje con score).
const TEMPORAL_PROFILES = {
  long_silence: {
    severity: 0.45,
    actionability: 0.35,
    salience: 0.4,
    costOfIgnore: 0.3,
    urgencia: 0.4,
    confianza: 0.8,
  },
  special_date: {
    severity: 0.4,
    actionability: 0.3,
    salience: 0.8,
    costOfIgnore: 0.3,
    urgencia: 0.5,
    confianza: 0.9,
  },
  late_night: {
    severity: 0.35,
    actionability: 0.3,
    salience: 0.5,
    costOfIgnore: 0.2,
    urgencia: 0.4,
    confianza: 0.8,
  },
  return_from_break: {
    severity: 0.4,
    actionability: 0.45,
    salience: 0.6,
    costOfIgnore: 0.3,
    urgencia: 0.5,
    confianza: 0.9,
  },
  sustained_focus: {
    severity: 0.4,
    actionability: 0.5,
    salience: 0.6,
    costOfIgnore: 0.3,
    urgencia: 0.5,
    confianza: 0.9,
  },
  context_switch_thrash: {
    severity: 0.4,
    actionability: 0.6,
    salience: 0.5,
    costOfIgnore: 0.3,
    urgencia: 0.5,
    confianza: 0.9,
  },
  session_end: {
    severity: 0.35,
    actionability: 0.4,
    salience: 0.5,
    costOfIgnore: 0.2,
    urgencia: 0.4,
    confianza: 0.8,
  },
  pending_recap: {
    severity: 0.35,
    actionability: 0.4,
    salience: 0.4,
    costOfIgnore: 0.2,
    urgencia: 0.4,
    confianza: 0.8,
  },
  followup: {
    severity: 0.45,
    actionability: 0.5,
    salience: 0.6,
    costOfIgnore: 0.3,
    urgencia: 0.5,
    confianza: 0.9,
  },
  session_start: {
    severity: 0.3,
    actionability: 0.3,
    salience: 0.4,
    costOfIgnore: 0.2,
    urgencia: 0.35,
    confianza: 0.8,
  },
};

// Eventos de telemetría/contexto que NUNCA son una señal proactiva (no hay
// nada que puntuar: son el estado del sistema, no algo que merezca hablar).
const CONTEXT_EVENTS = new Set([
  'os:idle-changed',
  'os:app-changed',
  'os:app-tick',
  'os:history-updated',
  'os:windows-updated',
  'workspace:changed',
  'session:started',
  'session:closed',
  'memory:turn-added',
  'memory-status',
  'behavior:evaluated',
  'git:branch-changed',
  'plan:started',
  'plan:generated',
  'plan:step-start',
  'plan:step-done',
  'plan:finished',
  'agent:completed',
  'openclaw:available',
]);

const TYPE_BY_EVENT = {
  'git:redflag': 'git_redflag',
  'system:warning': 'system_warning',
  'lsp:error': 'lsp_error',
  'os:error-title': 'error_title',
  'clipboard:copied': 'clipboard_context',
  'memory:upcoming-event': 'upcoming_event',
};

// Señales CRÍTICAS: saltan el presupuesto normal (ESCALATE en el núcleo).
// En el ROADMAP: "un secreto expuesto no se puede ignorar".
const CRITICAL = {
  git_redflag: { env_unignored: true },
};

// Inverso: tipo de trigger → evento del bus (para reutilizar normalize()).
const EVENT_BY_TYPE = Object.fromEntries(Object.entries(TYPE_BY_EVENT).map(([e, t]) => [t, e]));

function _sanitizeType(name) {
  return String(name)
    .replace(/[^a-z0-9_]+/gi, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Registra un perfil para un evento nuevo en caliente (Gap 1): el motor puede
 * enseñar al normalizador señales que aún no tienen perfil sin tocar el código.
 * El tipo queda con el perfil indicado y pasa a ser candidato real (con gate).
 */
function registerProfile(event, kind, profile) {
  const tipo = _sanitizeType(event);
  TYPE_BY_EVENT[event] = tipo;
  PROFILES[tipo] = PROFILES[tipo] || {};
  PROFILES[tipo][kind] = { ...(PROFILES[tipo]?.default || {}), ...profile };
  EVENT_BY_TYPE[tipo] = event;
  return tipo;
}

/**
 * Heurística genérica para eventos SIN perfil registrado (Gap 1). En lugar de
 * descartar en silencio un evento desconocido, se deriva un perfil razonable
 * del payload (palabras críticas, error/fallo, acción posible...). Devuelve
 * null solo si el payload no trae ningún dato (telemetría vacía / contexto).
 */
function _deriveGenericProfile(payload = {}) {
  const hasData = Object.keys(payload).some((k) => payload[k] != null && payload[k] !== '');
  if (!hasData) return null;

  const text = [
    payload.message,
    payload.title,
    payload.error,
    payload.context,
    payload.snippet,
    payload.detail,
    payload.reason,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  const isCritical =
    /secret|password|credential|\.env|token|api[_-]?key|vuln|crack|breach|exposed/.test(text);
  const isError = /error|fail|crash|fatal|panic|exception|denied|refused|timeout/.test(text);
  const actionable = !!(
    payload.file ||
    payload.code ||
    payload.patch ||
    payload.path ||
    payload.command
  );
  const count = typeof payload.count === 'number' ? payload.count : 0;

  return {
    severity: isCritical ? 0.9 : isError ? 0.65 : 0.45,
    actionability: actionable ? 0.7 : count > 0 ? 0.5 : 0.35,
    salience: payload.focused ? 1 : payload.title || payload.window ? 0.6 : 0.3,
    costOfIgnore: isCritical ? 0.9 : 0.35,
    urgencia: isCritical ? 0.8 : isError ? 0.6 : 0.4,
    confianza: 0.7,
    isCritical,
  };
}

/**
 * Ensambla el candidato final desde un perfil base (vector de señal + campos
 * semánticos + fuente). Lo usan tanto `normalize()` como `candidateFromTrigger`.
 */
function _buildCandidate(tipo, kind, base, payload, { sensor, selfGated } = {}, opts = {}) {
  const now = opts.now ?? Date.now();
  const p = { ...base };
  const signal = {
    severity: clamp(p.severity),
    actionability: clamp(p.actionability),
    salience: clamp(p.salience),
    costOfIgnore: clamp(p.costOfIgnore),
  };
  return {
    tipo,
    kind,
    isCritical: !!p.isCritical || !!CRITICAL[tipo]?.[kind],
    urgencia: clamp(p.urgencia),
    confianza: clamp(p.confianza),
    accionabilidad: clamp(p.actionability),
    saliencia: signal.salience,
    signal,
    selfGated: !!selfGated,
    source: { sensor, at: now },
    payload,
  };
}

/**
 * Construye un candidato desde un trigger ya armado por el ProactiveEngine.
 * Reutiliza la misma tabla de perfiles y ajustes que `normalize()`: el trigger
 * lleva `type` ('git_redflag', ...), `kind` y los campos del sensor.
 *
 * Los triggers TEMPORALES (F-4) usan TEMPORAL_PROFILES y se marcan `selfGated`:
 * su condición de disparo ya validó el momento, así que el gate les aplica solo
 * presupuesto y SLO (Gap 2), nunca chat/idle/flow.
 *
 * Devuelve null solo para triggers realmente desconocidos.
 */
function candidateFromTrigger(trigger = {}, opts = {}) {
  const event = EVENT_BY_TYPE[trigger.type];
  if (event) return normalize(event, { ...trigger }, opts);

  const base = TEMPORAL_PROFILES[trigger.type];
  if (base) {
    return _buildCandidate(
      _sanitizeType(trigger.type),
      trigger.kind || 'default',
      base,
      { ...trigger },
      { sensor: `trigger:${trigger.type}`, selfGated: true },
      opts
    );
  }
  return null;
}

/**
 * Normaliza un evento del bus en un candidato. Devuelve null solo si:
 *  - es un evento de telemetría/contexto (no es una señal proactiva), o
 *  - el payload no trae ningún dato.
 *
 * Los eventos desconocidos con datos reales NO se descartan en silencio (Gap 1):
 * se deriva un perfil genérico del payload para que entren al gate con score.
 *
 * @param {string} event  nombre del evento del bus ('git:redflag', ...)
 * @param {object} payload payload emitido por el sensor
 * @param {object} [opts] { now, workspace, focusedFile }
 */
function normalize(event, payload = {}, opts = {}) {
  if (!event || !payload || typeof payload !== 'object') return null;
  if (CONTEXT_EVENTS.has(event)) return null;

  const kind = payload.kind || 'default';
  let tipo = TYPE_BY_EVENT[event];
  let base = tipo ? PROFILES[tipo]?.[kind] || PROFILES[tipo]?.default : null;

  // Gap 1: evento sin perfil → derivar uno genérico en lugar de descartarlo.
  if (!base) {
    const derived = _deriveGenericProfile(payload);
    if (!derived) return null;
    tipo = _sanitizeType(event);
    base = derived;
  }

  const now = opts.now ?? Date.now();

  let p = { ...base };

  // ── Ajustes específicos según el payload ──────────────────────────────────
  if (tipo === 'git_redflag') {
    // A más archivos/commits en riesgo, más urgente (con techo).
    const count = payload.count ?? 0;
    if (count > 1) p.urgencia = clamp(p.urgencia + Math.log10(count) * 0.08);
    if (payload.kind === 'uncommitted' && count >= 20) p.urgencia = clamp(p.urgencia + 0.15);
  }

  if (tipo === 'system_warning') {
    // severity/urgencia según el porcentaje medido (battery, disk, memory, cpu).
    const level = payload.level;
    if (typeof level === 'number') {
      // El umbral ya fue cruzado por el sensor; aquí solo graduamos la urgencia
      // en el tramo medio-alto. level ∈ [0,100].
      if (level >= 90) p.urgencia = clamp(p.urgencia + 0.2);
      else if (level >= 75) p.urgencia = clamp(p.urgencia + 0.1);
    }
    if (payload.kind === 'battery_critical') p.urgencia = clamp(p.urgencia, 0.8, 1);
  }

  if (tipo === 'lsp_error') {
    const count = payload.count ?? payload.errors?.length ?? 0;
    const focused = !!payload.focused;
    // Muchos errores → más severo; archivo enfocado → saliencia y accionabilidad altas.
    if (count > 1) p.severity = clamp(p.severity + Math.min(count, 5) * 0.05);
    if (focused) {
      p.salience = 1;
      p.actionability = 0.85;
      p.urgencia = clamp(p.urgencia + 0.15);
    }
    // Errores de severidad 1 en el LSP se detectan con alta confianza; pero si el
    // archivo NO está enfocado, la señal es menos segura como "algo que molesta".
    if (!focused) p.confianza = clamp(p.confianza - 0.15);
  }

  if (tipo === 'error_title') {
    // El usuario está mirando la ventana con el error → saliencia máxima.
    p.salience = 0.9;
    // categoría del TitleWatcher (si viene) afina urgencia.
    const cat = payload.category;
    if (cat === 'crash' || cat === 'fatal') {
      p.severity = 0.8;
      p.urgencia = 0.75;
    } else if (cat === 'build') {
      p.severity = 0.6;
      p.urgencia = 0.6;
    }
  }

  if (tipo === 'clipboard_context' && payload.kind === 'stacktrace') {
    p.urgencia = clamp(p.urgencia + 0.1);
  }

  if (tipo === 'upcoming_event' && typeof payload.when === 'number') {
    // Urgencia temporal: más cerca del momento → más urgente.
    const mins = (payload.when - now) / 60000;
    if (mins <= 10) p.urgencia = 0.8;
    else if (mins <= 60) p.urgencia = 0.6;
    else if (mins <= 180) p.urgencia = 0.4;
  }

  // El perfil genérico (Gap 1) ya marca isCritical; para los registrados lo
  // marca la tabla CRITICAL. `_buildCandidate` aplica clamps y arma el vector.
  return _buildCandidate(tipo, kind, p, payload, { sensor: event }, opts);
}

module.exports = {
  normalize,
  candidateFromTrigger,
  registerProfile,
  PROFILES,
  TEMPORAL_PROFILES,
  TYPE_BY_EVENT,
  CRITICAL,
};
