/**
 * Planner.js — Fase 3
 *
 * Descompone un objetivo de alto nivel en una secuencia de pasos ejecutables
 * usando las herramientas de OpenClaw.
 *
 * Flujo:
 *   1. El LLM responde con una intención de acción (detectada por el ActionParser)
 *   2. Planner.plan() recibe esa intención y produce un Plan
 *   3. Planner.execute() ejecuta los pasos secuencialmente via OpenClawBridge
 *   4. Cada paso puede generar un resultado que condiciona el siguiente
 *   5. El resultado final vuelve al renderer para que March lo procese
 *
 * Un Plan tiene esta forma:
 * {
 *   id:       string    — UUID del plan
 *   goal:     string    — objetivo en lenguaje natural
 *   steps:    Step[]    — pasos a ejecutar
 *   status:   'pending' | 'running' | 'done' | 'failed' | 'cancelled'
 *   result:   any       — resultado acumulado de todos los pasos
 *   error:    string    — error si status==='failed'
 *   created:  number    — timestamp
 *   finished: number    — timestamp
 * }
 *
 * Un Step tiene esta forma:
 * {
 *   id:          string
 *   tool:        string    — herramienta de OpenClaw
 *   params:      object    — parámetros para la herramienta
 *   description: string    — qué hace este paso (para mostrar al usuario)
 *   requiresApproval: boolean — si el usuario debe aprobar antes de ejecutar
 *   dependsOn:   string[] — ids de pasos anteriores cuyos resultados necesita
 *   status:      'pending' | 'running' | 'done' | 'failed' | 'skipped'
 *   result:      any
 *   error:       string
 * }
 *
 * Sistema de aprobación (no negociable para acciones de alto impacto):
 *   HIGH IMPACT  → requiresApproval: true siempre
 *     - exec con rm, del, format, shutdown, reboot
 *     - write a paths fuera del workspace
 *     - apply_patch a archivos de sistema
 *   LOW IMPACT   → requiresApproval: false
 *     - web_search, read, browser navigate, exec readonly
 */

'use strict';

const { getOpenClawBridge } = require('./OpenClawBridge.js');

// ── Clasificación de impacto ──────────────────────────────────────────────────

const HIGH_IMPACT_PATTERNS = [
  // Comandos destructivos
  /\brm\s+-rf?\b/i,
  /\bdel\s+\/[sqf]/i,
  /\bformat\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bpoweroff\b/i,
  /\bkill\s+-9\b/,
  /\bregsvr32\b/i,
  /\bnetsh\b.*firewall/i,
  // Escritura fuera del workspace
  /C:\\Windows\\/i,
  /\/etc\//,
  /\/sys\//,
  /\/boot\//,
];

function isHighImpact(tool, params) {
  if (tool === 'exec' && params.command) {
    return HIGH_IMPACT_PATTERNS.some(p => p.test(params.command));
  }
  if (tool === 'write' && params.path) {
    return HIGH_IMPACT_PATTERNS.some(p => p.test(params.path));
  }
  if (tool === 'apply_patch') return true; // siempre requiere aprobación
  return false;
}

// ── Generador de IDs ──────────────────────────────────────────────────────────

let _planCounter  = 0;
let _stepCounter  = 0;
function planId()  { return `plan_${Date.now()}_${++_planCounter}`; }
function stepId()  { return `step_${Date.now()}_${++_stepCounter}`; }

// ── ActionParser: detecta intenciones de acción en la respuesta del LLM ───────

// ── Helpers de limpieza ───────────────────────────────────────────────────────

/**
 * Limpia un path capturado por regex:
 * - Elimina puntuación final (punto, coma, etc.) que el LLM añade al final de frase
 * - Elimina comillas que el LLM envuelve alrededor del path
 */
function _cleanPath(raw) {
  return (raw || '')
    .trim()
    .replace(/^["'`]|["'`]$/g, '')  // quitar comillas envolventes
    .replace(/[.,;:!?]+$/, '');      // quitar puntuación final de oración
}

/**
 * Limpia un comando capturado por regex:
 * - Elimina comillas envolventes que el LLM añade ("git status")
 * - Elimina texto narrativo que el LLM añade después del comando real
 *   ej: "git status" para ver el estado → "git status"
 * - Elimina puntuación final
 */
function _cleanCommand(raw) {
  let cmd = (raw || '').trim();

  // Quitar comillas envolventes: "git status" → git status
  cmd = cmd.replace(/^["'`]|["'`]$/g, '');

  // Si el LLM añadió texto narrativo después de comillas de cierre, cortar ahí
  // ej: git status" para ver el estado → git status
  const quoteEnd = cmd.search(/["'`]\s+\w/);
  if (quoteEnd !== -1) cmd = cmd.slice(0, quoteEnd);

  // Cortar en "para ver", "para listar", etc. (texto narrativo del LLM)
  cmd = cmd.replace(/\s+para\s+.*/i, '');
  cmd = cmd.replace(/\s+y\s+ver\s+.*/i, '');
  cmd = cmd.replace(/\s+con\s+el\s+fin\s+.*/i, '');

  // Quitar puntuación final
  cmd = cmd.replace(/[.,;:!?]+$/, '');

  return cmd.trim();
}

/**
 * Patrones que reconocemos como acciones concretas.
 * Cada uno tiene: pattern, tool, buildParams(match, fullText)
 */
const ACTION_PATTERNS = [
  // "buscar en la web: X" / "busca X en internet"
  {
    pattern: /(?:busca(?:r|me)?\s+en\s+(?:la\s+)?(?:web|internet|google)|voy\s+a\s+buscar)\s*[:\-]?\s*(.+?)(?:\.|$)/i,
    tool: 'web_search',
    buildParams: (m) => ({ query: m[1].trim() }),
    description: (m) => `Buscar en la web: "${m[1].trim()}"`,
  },
  // "ejecutar: X" / "ejecuta el comando: X"
  {
    pattern: /(?:ejecuta(?:r|ndo)?|corre(?:r)?|lanza(?:r)?)\s+(?:el\s+comando\s+)?[:\-]?\s*`?([^`\n]{2,120})`?/i,
    tool: 'exec',
    buildParams: (m) => ({ command: _cleanCommand(m[1]) }),
    description: (m) => `Ejecutar: ${_cleanCommand(m[1])}`,
  },
  // "leer el archivo: X"
  {
    pattern: /(?:lee(?:r)?|abrir?|mostrar?)\s+(?:el\s+)?archivo\s*[:\-]?\s*`?([^\s`\n]{2,200})`?/i,
    tool: 'read',
    buildParams: (m) => ({ path: _cleanPath(m[1]) }),
    description: (m) => `Leer archivo: ${_cleanPath(m[1])}`,
  },
  // "crear archivo X con contenido Y" — captura solo el path
  {
    pattern: /(?:crea(?:r)?|escribir?)\s+(?:el\s+)?(?:archivo|fichero)\s*[:\-]?\s*`?([^\s`\n]{2,200})`?/i,
    tool: 'write',
    buildParams: (m, fullText) => ({
      path:    _cleanPath(m[1]),
      content: '',
    }),
    description: (m) => `Crear archivo: ${_cleanPath(m[1])}`,
  },
  // "navegar a X" / "abrir en el navegador: X"
  {
    pattern: /(?:navega(?:r)?\s+a|abre?\s+en\s+(?:el\s+)?navegador|visita(?:r)?)\s*[:\-]?\s*(https?:\/\/[^\s\n]{2,300})/i,
    tool: 'browser',
    buildParams: (m) => ({ action: 'navigate', url: m[1].trim() }),
    description: (m) => `Navegar a: ${m[1].trim()}`,
  },
  // git add/commit/push/pull — atajo frecuente
  {
    pattern: /git\s+(add|commit|push|pull|status|log|diff|branch|checkout|merge|stash|clone)\s*([^\n]*)/i,
    tool: 'exec',
    buildParams: (m) => ({ command: `git ${m[1]} ${_cleanCommand(m[2] || '')}`.trim() }),
    description: (m) => `Git: ${m[1]} ${_cleanCommand(m[2] || '')}`,
  },
  // npm/pip install
  {
    pattern: /(npm|pip|pip3)\s+(install|uninstall|update|run)\s+([^\n]{1,100})/i,
    tool: 'exec',
    buildParams: (m) => ({ command: `${m[1]} ${m[2]} ${m[3]}`.trim() }),
    description: (m) => `${m[1]} ${m[2]}: ${m[3].trim()}`,
  },
];

class ActionParser {
  /**
   * Analiza el texto de respuesta del LLM buscando intenciones de acción.
   * @param {string} llmResponse
   * @returns {Array<{tool, params, description, rawMatch}>}
   */
  static parse(llmResponse) {
    const actions = [];
    const text    = llmResponse || '';

    for (const { pattern, tool, buildParams, description } of ACTION_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        try {
          const params = buildParams(match, text);
          actions.push({
            tool,
            params,
            description: description(match),
            rawMatch: match[0],
          });
        } catch(e) {
          console.warn('[action-parser] error parseando:', e.message);
        }
      }
    }

    return actions;
  }
}

// ── Planner ───────────────────────────────────────────────────────────────────

class Planner {
  constructor() {
    this._bridge    = getOpenClawBridge();
    this._activePlan = null;
    this._history   = []; // últimos planes ejecutados
    this._maxHistory = 50;
  }

  // ── Construcción de planes ──────────────────────────────────────────────────

  /**
   * Crea un plan simple de un solo paso.
   * Útil para acciones directas detectadas por ActionParser.
   *
   * @param {string} goal
   * @param {string} tool
   * @param {object} params
   * @param {string} description
   * @returns {object} Plan
   */
  planSingleStep(goal, tool, params, description) {
    const step = {
      id:               stepId(),
      tool,
      params,
      description:      description || `${tool}: ${JSON.stringify(params).slice(0, 80)}`,
      requiresApproval: isHighImpact(tool, params),
      dependsOn:        [],
      status:           'pending',
      result:           null,
      error:            null,
    };

    return {
      id:       planId(),
      goal,
      steps:    [step],
      status:   'pending',
      result:   null,
      error:    null,
      created:  Date.now(),
      finished: null,
    };
  }

  /**
   * Crea un plan multi-paso.
   * Los steps se ejecutan en orden, pudiendo depender de resultados anteriores.
   *
   * @param {string} goal
   * @param {Array<{tool, params, description, dependsOn?}>} stepsConfig
   * @returns {object} Plan
   */
  planMultiStep(goal, stepsConfig) {
    const steps = stepsConfig.map(cfg => ({
      id:               stepId(),
      tool:             cfg.tool,
      params:           cfg.params,
      description:      cfg.description || `${cfg.tool}`,
      requiresApproval: isHighImpact(cfg.tool, cfg.params),
      dependsOn:        cfg.dependsOn || [],
      status:           'pending',
      result:           null,
      error:            null,
    }));

    return {
      id:       planId(),
      goal,
      steps,
      status:   'pending',
      result:   null,
      error:    null,
      created:  Date.now(),
      finished: null,
    };
  }

  /**
   * Parsea la respuesta del LLM y construye un plan automáticamente.
   * Retorna null si no detecta ninguna acción.
   *
   * @param {string} llmResponse
   * @param {string} userGoal — el mensaje original del usuario
   * @returns {object|null} Plan o null
   */
  planFromLLMResponse(llmResponse, userGoal) {
    const actions = ActionParser.parse(llmResponse);
    if (!actions.length) return null;

    if (actions.length === 1) {
      const { tool, params, description } = actions[0];
      return this.planSingleStep(userGoal, tool, params, description);
    }

    // Múltiples acciones → plan multi-paso
    return this.planMultiStep(userGoal, actions);
  }

  // ── Ejecución ───────────────────────────────────────────────────────────────

  /**
   * Ejecuta un plan paso a paso.
   *
   * @param {object}   plan
   * @param {object}   [opts]
   * @param {Function} [opts.onStepStart]   — callback(step) antes de cada paso
   * @param {Function} [opts.onStepDone]    — callback(step, result) al terminar cada paso
   * @param {Function} [opts.onApprovalNeeded] — callback(step) → Promise<boolean>
   *                                            debe retornar true para continuar
   * @returns {Promise<object>} Plan con status y result finales
   */
  async execute(plan, opts = {}) {
    if (this._activePlan) {
      console.warn('[planner] ya hay un plan activo:', this._activePlan.id);
    }

    plan.status      = 'running';
    this._activePlan = plan;

    const stepResults = {}; // stepId → result

    for (const step of plan.steps) {
      // Verificar que los pasos de los que dependemos terminaron OK
      const blocked = step.dependsOn.find(id => {
        const dep = plan.steps.find(s => s.id === id);
        return dep && dep.status !== 'done';
      });

      if (blocked) {
        step.status = 'skipped';
        step.error  = `Paso ${blocked} no completado`;
        console.log(`[planner] paso ${step.id} omitido (dependencia fallida)`);
        continue;
      }

      // Resolver dependencias en params (interpolación de resultados)
      const resolvedParams = this._resolveParams(step.params, stepResults);

      // Notificar inicio
      opts.onStepStart?.(step);
      step.status = 'running';

      // ¿Requiere aprobación?
      if (step.requiresApproval) {
        const approved = opts.onApprovalNeeded
          ? await opts.onApprovalNeeded(step)
          : false; // sin callback → denegar por seguridad

        if (!approved) {
          step.status = 'skipped';
          step.error  = 'Acción cancelada por el usuario';
          console.log(`[planner] paso ${step.id} cancelado por usuario`);
          opts.onStepDone?.(step, null);
          continue;
        }
      }

      // Ejecutar
      console.log(`[planner] ejecutando paso: ${step.description}`);
      const res = await this._bridge.execute(step.tool, resolvedParams);

      if (!res.ok) {
        step.status = 'failed';
        step.error  = res.error;
        opts.onStepDone?.(step, null);
        // Si falla un paso crítico, abortar el plan
        plan.status   = 'failed';
        plan.error    = `Paso "${step.description}" falló: ${res.error}`;
        plan.finished = Date.now();
        this._activePlan = null;
        this._archivePlan(plan);
        return plan;
      }

      step.status = 'done';
      step.result = res.result;
      stepResults[step.id] = res.result;
      opts.onStepDone?.(step, res.result);
    }

    // Plan completado
    const allDone    = plan.steps.every(s => s.status === 'done' || s.status === 'skipped');
    const anyFailed  = plan.steps.some(s => s.status === 'failed');

    plan.status   = anyFailed ? 'failed' : 'done';
    plan.result   = this._aggregateResults(plan.steps);
    plan.finished = Date.now();
    this._activePlan = null;
    this._archivePlan(plan);

    console.log(`[planner] plan ${plan.id} completado: ${plan.status}`);
    return plan;
  }

  /**
   * Cancela el plan activo.
   */
  cancel() {
    if (!this._activePlan) return;
    this._activePlan.status   = 'cancelled';
    this._activePlan.finished = Date.now();
    this._archivePlan(this._activePlan);
    this._activePlan = null;
    console.log('[planner] plan cancelado');
  }

  // ── Helpers internos ────────────────────────────────────────────────────────

  /**
   * Resuelve referencias a resultados de pasos anteriores en los params.
   * Sintaxis: "$step_id" en cualquier valor string.
   */
  _resolveParams(params, stepResults) {
    const resolved = { ...params };
    for (const [key, val] of Object.entries(resolved)) {
      if (typeof val === 'string' && val.startsWith('$')) {
        const refId = val.slice(1);
        if (stepResults[refId] !== undefined) {
          resolved[key] = stepResults[refId];
        }
      }
    }
    return resolved;
  }

  /**
   * Combina los resultados de todos los pasos en un objeto legible.
   */
  _aggregateResults(steps) {
    const results = {};
    for (const step of steps) {
      if (step.status === 'done' && step.result !== null) {
        results[step.description] = step.result;
      }
    }
    // Si hay un solo paso, devolver su resultado directamente
    const doneSteps = steps.filter(s => s.status === 'done');
    if (doneSteps.length === 1) return doneSteps[0].result;
    return Object.keys(results).length ? results : null;
  }

  _archivePlan(plan) {
    this._history.push(plan);
    if (this._history.length > this._maxHistory) this._history.shift();
  }

  // ── Stats ───────────────────────────────────────────────────────────────────

  getStats() {
    const total    = this._history.length;
    const done     = this._history.filter(p => p.status === 'done').length;
    const failed   = this._history.filter(p => p.status === 'failed').length;
    const cancelled= this._history.filter(p => p.status === 'cancelled').length;
    return {
      total, done, failed, cancelled,
      active:  this._activePlan?.id ?? null,
      bridge:  this._bridge.getStats(),
    };
  }

  getHistory(n = 10) {
    return this._history.slice(-n).map(p => ({
      id:       p.id,
      goal:     p.goal,
      status:   p.status,
      steps:    p.steps.length,
      elapsed:  p.finished ? p.finished - p.created : null,
      result:   typeof p.result === 'string' ? p.result.slice(0, 200) : p.result,
      error:    p.error,
    }));
  }
}

// Singleton
let _plannerInstance = null;
function getPlanner() {
  if (!_plannerInstance) _plannerInstance = new Planner();
  return _plannerInstance;
}

module.exports = { Planner, ActionParser, getPlanner, isHighImpact };