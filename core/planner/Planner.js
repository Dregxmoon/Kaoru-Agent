/**
 * Planner.js — Fase 3 v5
 *
 * Fix v4 → v5:
 *   _llmTransform ya NO llama a Anthropic directamente.
 *   Usa LLMProvider.complete() — el mismo cliente Groq/Gemini/OpenAI
 *   que usa el resto del proyecto.
 *
 *   setAnthropicConfig() eliminado — reemplazado por setLLMProvider(fn)
 *   que acepta cualquier función compatible con LLMProvider.complete().
 *
 * Cambios respecto a v3 (mantenidos):
 *   edit_file detection — dos estrategias:
 *     A) verbos de edición clásicos + archivo.ext
 *     B) verbos de escritura (escribir, poner, guardar…) con archivo
 *        en cualquier posición de la oración
 *   userGoal como fuente de verdad para la instrucción de edit_file
 *   _executeEditFile: read → llm_transform → write → verify (real, sin simulación)
 */

'use strict';

const path = require('path');
const { getOpenClawBridge } = require('./OpenClawBridge.js');

// ── CWD del proyecto ──────────────────────────────────────────────────────────
let PROJECT_CWD = process.cwd();

function setProjectCWD(cwd) {
  if (cwd && typeof cwd === 'string') {
    PROJECT_CWD = cwd;
    console.log('[planner] CWD del proyecto:', PROJECT_CWD);
  }
}

// ── LLM Provider ──────────────────────────────────────────────────────────────
// Por defecto intenta cargar LLMProvider del proyecto.
// Se puede sobreescribir con setLLMProvider(fn) para tests.
let _llmComplete = null;

function _getLLMComplete() {
  if (_llmComplete) return _llmComplete;
  try {
    const LLMProvider = require('../llm/LLMProvider.js');
    return LLMProvider.complete.bind(LLMProvider);
  } catch (e) {
    throw new Error(
      'LLMProvider no encontrado. Asegúrate de que ../llm/LLMProvider.js existe, ' +
      'o usa setLLMProvider(fn) para inyectar tu propio cliente.'
    );
  }
}

/**
 * Inyecta una función LLM personalizada para tests o entornos especiales.
 * La función debe tener la misma firma que LLMProvider.complete:
 *   async (messages: Array<{role, content}>, systemPrompt: string) => string
 */
function setLLMProvider(fn) {
  if (typeof fn !== 'function') throw new Error('setLLMProvider: se esperaba una función');
  _llmComplete = fn;
  console.log('[planner] LLMProvider personalizado configurado');
}

/**
 * Llama al LLM del proyecto para transformar el contenido de un archivo.
 * Usa Groq/Gemini/OpenAI según la configuración activa — nunca Anthropic.
 *
 * @param {string} originalContent  — contenido actual del archivo
 * @param {string} instruction      — instrucción completa del usuario
 * @param {string} filePath         — ruta del archivo (contexto)
 * @returns {Promise<string>}       — nuevo contenido completo del archivo
 */
async function _llmTransform(originalContent, instruction, filePath) {
  const complete = _getLLMComplete();

  const systemPrompt = [
    'Eres un editor de archivos de texto.',
    'Recibirás el contenido actual de un archivo y una instrucción del usuario.',
    'Devuelve ÚNICAMENTE el nuevo contenido completo del archivo.',
    'Sin explicaciones, sin bloques markdown (no uses ```), sin comentarios.',
    'El output es exactamente el texto que debe quedar escrito en el archivo.',
    'No agregues nada antes ni después del contenido del archivo.',
  ].join(' ');

  const userMessage = [
    `Archivo: ${filePath}`,
    '',
    '--- CONTENIDO ACTUAL ---',
    originalContent,
    '--- FIN CONTENIDO ---',
    '',
    `Instrucción del usuario: ${instruction}`,
    '',
    'Devuelve el nuevo contenido completo del archivo.',
  ].join('\n');

  const newContent = await complete(
    [{ role: 'user', content: userMessage }],
    systemPrompt
  );

  if (!newContent || !newContent.trim()) {
    throw new Error('El LLM devolvió contenido vacío.');
  }

  return newContent;
}

// ── Clasificación de impacto ──────────────────────────────────────────────────
const HIGH_IMPACT_PATTERNS = [
  /\brm\s+-rf?\b/i, /\bdel\s+\/[sqf]/i, /\bformat\b/i,
  /\bshutdown\b/i,  /\breboot\b/i,      /\bpoweroff\b/i,
  /\bkill\s+-9\b/,  /C:\\Windows\\/i,   /\/etc\//,
  /\/sys\//,        /\/boot\//,
];

function isHighImpact(tool, params) {
  if (tool === 'exec' && params.command)
    return HIGH_IMPACT_PATTERNS.some(p => p.test(params.command));
  if (tool === 'write' && params.path)
    return HIGH_IMPACT_PATTERNS.some(p => p.test(params.path));
  if (tool === 'edit_file')   return true;
  if (tool === 'apply_patch') return true;
  return false;
}

// ── IDs ───────────────────────────────────────────────────────────────────────
let _planCounter = 0, _stepCounter = 0;
function planId() { return `plan_${Date.now()}_${++_planCounter}`; }
function stepId() { return `step_${Date.now()}_${++_stepCounter}`; }

// ── Helpers de limpieza ───────────────────────────────────────────────────────
function _cleanPath(raw) {
  return (raw || '').trim()
    .replace(/^["'`]|["'`]$/g, '')
    .replace(/[.,;:!?]+$/, '');
}

function _cleanCommand(raw) {
  if (!raw) return '';
  let cmd = raw.trim();

  // Quitar backticks, comillas y espacios envolventes
  cmd = cmd.replace(/^["'`]+|["'`]+$/g, '').trim();

  const NARRATIVE_STARTS = [
    /^el\s+comando(?!\s+(?:git|npm|pip|node|python|cd|ls|dir|echo|curl|yarn|npx))\s*/i,
    /^proporcionado\b/i, /^que\s+se\s+/i, /^para\s+/i,
    /^lo\s+siguiente\s*:/i, /^ahora\s+voy\s+/i, /^voy\s+a\s+/i, /^listo\b/i,
  ];
  for (const p of NARRATIVE_STARTS) { if (p.test(cmd)) return ''; }

  cmd = cmd.replace(/\.\s+[A-ZÁÉÍÓÚ][a-z].*$/, '');
  cmd = cmd.replace(/\s+para\s+(?:ver|listar|asegurar|verificar|comprobar|ejecutar).*/i, '');
  cmd = cmd.replace(/\s+y\s+(?:ver|ejecutar|listar).*/i, '');
  cmd = cmd.replace(/[,;:!?]+$/, '').trim();

  // Quitar backticks residuales
  cmd = cmd.replace(/`/g, '').trim();

  // Cerrar comillas abiertas — git commit -m "mensaje sin cerrar → agregar "
  const doubleQuotes = (cmd.match(/"/g) || []).length;
  if (doubleQuotes % 2 !== 0) cmd = cmd + '"';

  return cmd.length < 2 ? '' : cmd;
}

function _isValidCommand(cmd) {
  if (!cmd || cmd.length < 2) return false;

  // Rechazar narrativa española — artículos, pronombres, frases inventadas
  if (/^(?:los|las|el|la|un|una|esto|estos|estas|lo|le|les|se|su|sus)\s/i.test(cmd)) return false;

  // Comandos conocidos — siempre válidos
  const VALID = [
    /^git\s/i, /^npm\s/i, /^pip3?\s/i, /^node\s/i, /^python\s/i,
    /^cd\s/i,  /^ls\b/i,  /^dir\b/i,   /^echo\b/i, /^cat\s/i,
    /^type\s/i,/^mkdir\s/i,/^cp\s/i,   /^mv\s/i,   /^touch\s/i,
    /^curl\s/i,/^wget\s/i, /^yarn\s/i, /^npx\s/i,  /^electron\b/i,
    /^code\s/i,/^pwsh\b/i, /^where\s/i,/^which\s/i,/^set\s/i, /^export\s/i,
  ];
  if (VALID.some(p => p.test(cmd))) return true;

  // Comandos encadenados — válidos si tienen operadores shell
  if (/&&|\|\||[|>]/.test(cmd)) return true;

  // Rechazar si contiene prosa española obvia
  if (/\b(voy|ahora|listo|correcto|asegurarme|verificar|antes|después|durante|luego|entonces|siguientes|comandos|archivos|cambios)\b/i.test(cmd))
    return false;

  // Fallback: solo aceptar si parece un ejecutable (empieza con palabra sin espacios largos)
  return /^[a-zA-Z0-9_\-./\\]{2,30}(\s|$)/.test(cmd) && cmd.length < 40;
}

function _isValidPath(p) {
  if (!p || p.length === 0) return false;
  return !p.includes(' ') || /\.\w{1,5}$/.test(p);
}

// ── Detección de intención de edición ────────────────────────────────────────

/**
 * Estrategia A — verbos de edición clásicos con archivo después.
 * "modifica README.md", "añade línea en src/index.js"
 */
const EDIT_VERBS_A =
  '(?:modifica(?:r)?|edita(?:r)?|cambia(?:r)?|inserta(?:r)?|' +
  'añad(?:e|ir)?|agreg(?:a|ar)?|reemplaz(?:a|ar)?|' +
  'actualiza(?:r)?|borra(?:r)?|elimina(?:r)?)';

const EDIT_PATTERN_A = new RegExp(
  EDIT_VERBS_A + '(?:[^\\n]{0,80}?)' +
  '([\\w][\\w./\\\\-]{0,150}\\.\\w{2,10})',
  'i'
);

/**
 * Estrategia B — verbos de escritura con archivo en cualquier posición.
 * "puedes escribir en README.md la frase X"
 * "escribe esto al final de README.md"
 * "pon este contenido en config.json"
 */
const WRITE_INTENT_B = /(?:escrib(?:e|ir|o|iendo)|pon(?:er|e|ga|go)|coloca(?:r)?|guarda(?:r)?)\b/i;
const FILE_ANYWHERE  = /\b([\w][\w./\\-]{0,150}\.\w{2,10})\b/g;

function _detectEditIntent(text) {
  // A: verbo de edición + archivo después
  const mA = EDIT_PATTERN_A.exec(text);
  if (mA) {
    const p = _cleanPath(mA[1]);
    if (_isValidPath(p)) return { path: p, strategy: 'A', match: mA[0] };
  }

  // B: verbo de escritura + archivo en cualquier posición
  if (WRITE_INTENT_B.test(text)) {
    FILE_ANYWHERE.lastIndex = 0;
    let fm;
    while ((fm = FILE_ANYWHERE.exec(text)) !== null) {
      const p = _cleanPath(fm[1]);
      if (_isValidPath(p)) return { path: p, strategy: 'B', match: text };
    }
  }

  return null;
}

// ── ActionParser ──────────────────────────────────────────────────────────────

const ACTION_PATTERNS = [
  // búsqueda web
  {
    pattern: /(?:busca(?:r|me)?\s+en\s+(?:la\s+)?(?:web|internet|google)|voy\s+a\s+buscar\s+en\s+(?:la\s+)?web)\s*[:\-]?\s*(.+?)(?:\.|$)/i,
    tool: 'web_search',
    buildParams: (m) => ({ query: m[1].trim() }),
    description: (m) => `Buscar en la web: "${m[1].trim()}"`,
  },

  // git
  {
    pattern: /\b(git\s+(?:add|commit|push|pull|status|log|diff|branch|checkout|merge|stash|clone|init|remote|fetch|reset|rebase)(?:\s+[^\n]{1,120})?)/i,
    tool: 'exec',
    buildParams: (m) => ({ command: _cleanCommand(m[1]), cwd: PROJECT_CWD }),
    description: (m) => `Ejecutar: ${_cleanCommand(m[1])}`,
    validate: (m) => _isValidCommand(_cleanCommand(m[1])),
  },

  // npm / pip / yarn
  {
    pattern: /\b((?:npm|pip|pip3|yarn|npx)\s+(?:install|uninstall|run|start|build|test|update|init)[^\n]{0,80})/i,
    tool: 'exec',
    buildParams: (m) => ({ command: _cleanCommand(m[1]), cwd: PROJECT_CWD }),
    description: (m) => `Ejecutar: ${_cleanCommand(m[1])}`,
    validate: (m) => _isValidCommand(_cleanCommand(m[1])),
  },

  // exec genérico
  {
    pattern: /(?:ejecuta(?:r|ndo)?|corre(?:r)?|lanza(?:r)?)\s+(?:el\s+comando\s+)?[:\-]?\s*`([^`\n]{2,120})`/i,

    tool: 'exec',
    buildParams: (m) => ({ command: _cleanCommand(m[1]), cwd: PROJECT_CWD }),
    description: (m) => `Ejecutar: ${_cleanCommand(m[1])}`,
    validate: (m) => _isValidCommand(_cleanCommand(m[1])),
  },

  // leer archivo
  {
    pattern: /(?:lee(?:r)?|abrir?|mostrar?)\s+(?:el\s+)?archivo\s*[:\-]?\s*`?([^\s`\n]{2,200})`?/i,
    tool: 'read',
    buildParams: (m) => ({ path: _cleanPath(m[1]) }),
    description: (m) => `Leer archivo: ${_cleanPath(m[1])}`,
    validate: (m) => _isValidPath(_cleanPath(m[1])),
  },

  // crear archivo nuevo (sin contenido previo — no es edit_file)
  {
    pattern: /crea(?:r)?\s+(?:un\s+)?(?:nuevo\s+)?(?:archivo|fichero)\s*[:\-]?\s*`?([^\s`\n]{2,200})`?/i,
    tool: 'write',
    buildParams: (m) => ({ path: _cleanPath(m[1]), content: '' }),
    description: (m) => `Crear archivo: ${_cleanPath(m[1])}`,
    validate: (m) => _isValidPath(_cleanPath(m[1])),
  },

  // navegar URL
  {
    pattern: /(?:navega(?:r)?\s+a|abre?\s+en\s+(?:el\s+)?navegador|visita(?:r)?)\s*[:\-]?\s*(https?:\/\/[^\s\n]{2,300})/i,
    tool: 'browser',
    buildParams: (m) => ({ action: 'navigate', url: m[1].trim() }),
    description: (m) => `Navegar a: ${m[1].trim()}`,
  },
];

class ActionParser {
  /**
   * Parsea texto buscando acciones ejecutables.
   *
   * IMPORTANTE: edit_file se detecta sobre userGoal (mensaje real del usuario),
   * no sobre llmResponse (narrativa inventada del LLM).
   *
   * @param {string} llmResponse — respuesta del LLM (para detectar comandos shell/git/etc)
   * @param {string} [userGoal]  — mensaje original del usuario (fuente de verdad para edición)
   */
  static parse(llmResponse, userGoal) {
    const actions = [];
    const seen    = new Set();
    const text    = llmResponse || '';

    // ── edit_file: detectar sobre userGoal, no sobre llmResponse ─────────────
    const editSource = userGoal || text;
    const editIntent = _detectEditIntent(editSource);

    if (editIntent) {
      const key = `edit_file:${editIntent.path}`;
      if (!seen.has(key)) {
        seen.add(key);
        actions.push({
          tool:        'edit_file',
          params:      { path: editIntent.path, instruction: editSource },
          description: `Editar archivo: ${editIntent.path}`,
          rawMatch:    editIntent.match,
        });
      }
    }

    // ── resto de patrones (comandos shell, búsqueda, navegación…) ─────────────
    for (const { pattern, tool, buildParams, description, validate } of ACTION_PATTERNS) {
      let match;
      const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g';
      const re = new RegExp(pattern.source, flags);
      while ((match = re.exec(text)) !== null) {
  if (validate && !validate(match)) break;
  try {
    const contextText = (tool === 'edit_file' && userGoal) ? userGoal : text;
    const params = buildParams(match, contextText);

    if (tool === 'exec' && (!params.command || params.command.trim().length < 2)) break;

    const key = `${tool}:${params.command || params.path || params.query || ''}`;
    if (seen.has(key)) break;
    seen.add(key);

    actions.push({ tool, params, description: description(match), rawMatch: match[0] });
  } catch (e) {
    console.warn('[action-parser] error:', e.message);
  }
  // ← sin break: continúa buscando más matches del mismo patrón
}
    }

    return actions;
  }
}

// ── Planner ───────────────────────────────────────────────────────────────────

class Planner {
  constructor() {
    this._bridge      = getOpenClawBridge();
    this._activePlan  = null;
    this._history     = [];
    this._maxHistory  = 50;
  }

  planSingleStep(goal, tool, params, description) {
    const step = {
      id:               stepId(),
      tool,
      params,
      description:      description || `${tool}`,
      requiresApproval: isHighImpact(tool, params),
      dependsOn:        [],
      status:           'pending',
      result:           null,
      error:            null,
    };
    return {
      id: planId(), goal, steps: [step],
      status: 'pending', result: null, error: null,
      created: Date.now(), finished: null,
    };
  }

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
      id: planId(), goal, steps,
      status: 'pending', result: null, error: null,
      created: Date.now(), finished: null,
    };
  }

  /**
   * Construye un plan desde la respuesta del LLM.
   * userGoal siempre debe pasarse — es la fuente de verdad para edit_file.
   */
  planFromLLMResponse(llmResponse, userGoal) {
    const actions = ActionParser.parse(llmResponse, userGoal);
    if (!actions.length) return null;
    if (actions.length === 1) {
      const { tool, params, description } = actions[0];
      return this.planSingleStep(userGoal, tool, params, description);
    }
    return this.planMultiStep(userGoal, actions);
  }

  // ── Ejecución ───────────────────────────────────────────────────────────────

  async execute(plan, opts = {}) {
    if (this._activePlan) {
      console.warn('[planner] ya hay un plan activo, rechazando:', plan.id);
      return { ...plan, status: 'failed', error: 'Otro plan está en ejecución' };
    }

    plan.status      = 'running';
    this._activePlan = plan;
    const stepResults = {};

    for (const step of plan.steps) {
      const blocked = step.dependsOn.find(id => {
        const dep = plan.steps.find(s => s.id === id);
        return dep && dep.status !== 'done';
      });
      if (blocked) {
        step.status = 'skipped';
        step.error  = `Dependencia ${blocked} no completada`;
        opts.onStepDone?.(step, null);
        continue;
      }

      const resolvedParams = this._resolveParams(step.params, stepResults);
      opts.onStepStart?.(step);
      step.status = 'running';

      if (step.requiresApproval) {
        const approved = opts.onApprovalNeeded
          ? await opts.onApprovalNeeded(step)
          : false;
        if (!approved) {
          step.status = 'skipped';
          step.error  = 'Cancelado por el usuario';
          opts.onStepDone?.(step, null);
          continue;
        }
      }

      console.log(`[planner] ejecutando paso: ${step.description}`);

      let res;
      try {
        res = await this._executeStep(step.tool, resolvedParams);
      } catch (e) {
        res = { ok: false, error: e.message, result: null, tool: step.tool, elapsed: 0 };
      }

      if (!res.ok) {
        step.status = 'failed';
        step.error  = res.error;
        step.result = res.result || null;
        opts.onStepDone?.(step, null);

        plan.status   = 'failed';
        plan.error    = `"${step.description}" falló: ${res.error}`;
        plan.finished = Date.now();
        this._activePlan = null;
        this._archivePlan(plan);
        return plan;
      }

      step.status  = 'done';
      step.result  = res.result;
      stepResults[step.id] = res.result;
      opts.onStepDone?.(step, res.result);
    }

    const anyFailed = plan.steps.some(s => s.status === 'failed');
    plan.status   = anyFailed ? 'failed' : 'done';
    plan.result   = this._aggregateResults(plan.steps);
    plan.finished = Date.now();
    this._activePlan = null;
    this._archivePlan(plan);

    console.log(`[planner] plan ${plan.id} → ${plan.status}`);
    return plan;
  }

  /**
   * Despacha la ejecución según el tipo de herramienta.
   * edit_file se expande en el flujo read → llm → write → verify.
   * El resto va directamente al bridge.
   */
  async _executeStep(tool, params) {
    if (tool === 'edit_file') {
      return this._executeEditFile(params);
    }
    return this._bridge.execute(tool, params);
  }

  /**
   * Flujo completo de edición de archivo.
   *
   * Paso 1 — read    : lee el contenido actual del archivo via OpenClaw
   * Paso 2 — llm     : genera el nuevo contenido con LLMProvider (Groq/etc)
   * Paso 3 — write   : escribe el nuevo contenido via OpenClaw
   * Paso 4 — verify  : re-lee para confirmar que la escritura fue exitosa
   *
   * La respuesta final usa SOLO resultados reales de las herramientas.
   * Si cualquier paso falla → { ok: false, error } sin inventar éxito.
   */
  async _executeEditFile({ path: filePath, instruction }) {
    const start = Date.now();

    // ── Paso 1: leer el archivo ───────────────────────────────────────────────
    console.log(`[planner] paso 1: Leer ${filePath}`);
    const readResult = await this._bridge.execute('read', { path: filePath });

    if (!readResult.ok) {
      return {
        ok:      false,
        error:   `No se pudo leer "${filePath}": ${readResult.error}`,
        result:  null,
        tool:    'edit_file',
        elapsed: Date.now() - start,
      };
    }

    const originalContent = typeof readResult.result === 'string'
      ? readResult.result
      : JSON.stringify(readResult.result);

    // ── Paso 2: generar nuevo contenido con el LLM del proyecto ──────────────
    console.log(`[planner] paso 2: Generar contenido actualizado para ${filePath}`);
    let newContent;
    try {
      newContent = await _llmTransform(originalContent, instruction, filePath);
    } catch (e) {
      return {
        ok:      false,
        error:   `Error al transformar "${filePath}": ${e.message}`,
        result:  null,
        tool:    'edit_file',
        elapsed: Date.now() - start,
      };
    }

    // ── Paso 3: escribir el archivo ───────────────────────────────────────────
    console.log(`[planner] paso 3: Escribir ${filePath}`);
    const writeResult = await this._bridge.execute('write', {
      path:    filePath,
      content: newContent,
    });

    if (!writeResult.ok) {
      return {
        ok:      false,
        error:   `No se pudo escribir "${filePath}": ${writeResult.error}`,
        result:  null,
        tool:    'edit_file',
        elapsed: Date.now() - start,
      };
    }

    // ── Paso 4: verificar la escritura ────────────────────────────────────────
    console.log(`[planner] paso 4: Verificar escritura de ${filePath}`);
    const verifyResult = await this._bridge.execute('read', { path: filePath });

    if (!verifyResult.ok) {
      // Escritura realizada pero no se puede verificar — éxito con advertencia
      return {
        ok:     true,
        result: {
          status:  'written_unverified',
          path:    filePath,
          newContent,
          warning: `Archivo escrito pero no verificado: ${verifyResult.error}`,
        },
        tool:    'edit_file',
        elapsed: Date.now() - start,
      };
    }

    const verifiedContent = typeof verifyResult.result === 'string'
      ? verifyResult.result
      : JSON.stringify(verifyResult.result);

    console.log(`[planner] plan completado — ${filePath} modificado correctamente`);

    return {
      ok:     true,
      result: {
        status:          'success',
        path:            filePath,
        originalContent,
        newContent,
        verifiedContent,
        verified:        verifiedContent === newContent,
      },
      tool:    'edit_file',
      elapsed: Date.now() - start,
    };
  }

  // ── Utilidades ───────────────────────────────────────────────────────────────

  cancel() {
    if (!this._activePlan) return;
    this._activePlan.status   = 'cancelled';
    this._activePlan.finished = Date.now();
    this._archivePlan(this._activePlan);
    this._activePlan = null;
  }

  _resolveParams(params, stepResults) {
    const resolved = { ...params };
    for (const [key, val] of Object.entries(resolved)) {
      if (typeof val === 'string' && val.startsWith('$')) {
        const refId = val.slice(1);
        if (stepResults[refId] !== undefined) resolved[key] = stepResults[refId];
      }
    }
    return resolved;
  }

  _aggregateResults(steps) {
    const doneSteps = steps.filter(s => s.status === 'done' && s.result != null);
    if (doneSteps.length === 0) return null;
    if (doneSteps.length === 1) return doneSteps[0].result;
    const results = {};
    for (const s of doneSteps) results[s.description] = s.result;
    return results;
  }

  _archivePlan(plan) {
    this._history.push(plan);
    if (this._history.length > this._maxHistory) this._history.shift();
  }

  getStats() {
    return {
      total:     this._history.length,
      done:      this._history.filter(p => p.status === 'done').length,
      failed:    this._history.filter(p => p.status === 'failed').length,
      cancelled: this._history.filter(p => p.status === 'cancelled').length,
      active:    this._activePlan?.id ?? null,
      bridge:    this._bridge.getStats(),
    };
  }

  getHistory(n = 10) {
    return this._history.slice(-n).map(p => ({
      id:      p.id,
      goal:    p.goal,
      status:  p.status,
      steps:   p.steps.length,
      elapsed: p.finished ? p.finished - p.created : null,
      result:  typeof p.result === 'string' ? p.result.slice(0, 200) : p.result,
      error:   p.error,
    }));
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────
let _plannerInstance = null;
function getPlanner() {
  if (!_plannerInstance) _plannerInstance = new Planner();
  return _plannerInstance;
}

module.exports = {
  Planner,
  ActionParser,
  getPlanner,
  isHighImpact,
  setProjectCWD,
  setLLMProvider,   // inyectar LLM personalizado (tests / entornos especiales)
};