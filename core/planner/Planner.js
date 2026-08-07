// @ts-nocheck
/**
 * Planner.js — Fase 3 v9
 *
 * Fix v8 → v9:
 *   _cleanPath() solo quitaba UN carácter de comilla/backtick en cada
 *   extremo, y esa clase de caracteres ni siquiera incluía asterisco o
 *   guion bajo. Cuando el LLM anunciaba una acción con el nombre de
 *   archivo en negrita markdown ("Voy a leer el archivo **main.js**."),
 *   el path capturado por el regex de "leer archivo" quedaba como
 *   "**main.js**" literal — OpenClaw intentaba resolver ese path
 *   inexistente y la herramienta fallaba o devolvía contenido vacío,
 *   sin que el usuario tuviera ninguna señal visible de qué pasó (el
 *   plan se marcaba "COMPLETADO" igual, porque el paso en sí no
 *   lanzaba excepción — solo no encontraba nada que leer).
 *
 *   Este bug era intermitente por diseño: solo aparecía cuando el LLM
 *   decidía formatear el nombre de archivo en negrita/cursiva/código en
 *   su anuncio narrativo, lo cual no es determinístico turno a turno.
 *
 *   Fix: _cleanPath() ahora quita TODOS los caracteres de envoltorio
 *   markdown (*, _, `, comillas) en cualquier cantidad en ambos
 *   extremos, no solo un carácter. La puntuación final (.,;:!?) se
 *   limpia en la MISMA pasada que el envoltorio de cierre, porque
 *   pueden venir intercalados (ej. "**main.js**." tiene el punto
 *   DESPUÉS de los asteriscos de cierre — limpiarlos en pasadas
 *   separadas en el orden equivocado dejaría basura pegada al nombre).
 *
 *   Esto afecta a TODOS los puntos que usan _cleanPath(): el patrón de
 *   "leer archivo", "crear archivo", "aplicar patch", y _detectEditIntent
 *   (estrategias A y B) — se corrige en un solo lugar para los cuatro.
 *
 * Cambios v7 → v8 (mantenidos):
 *   _llmTransform (modo chunking) — antes solo identificaba UNA sección
 *   relevante (mejor puntaje de keywords) y transformaba solo esa. Si la
 *   instrucción aplicaba a varias secciones dispersas en el archivo
 *   (ej. "renombra la función X a Y en todo el archivo" y X aparece en
 *   varias funciones distintas), solo se editaba la primera coincidencia
 *   y el resto del archivo quedaba intacto SIN avisar al usuario.
 *
 *   Ahora _findRelevantSections (plural) devuelve TODAS las secciones
 *   con al menos un keyword-match, no solo la de mejor puntaje. Si hay
 *   una sola sección relevante, el comportamiento es idéntico al de v7
 *   (incluye contexto de secciones vecinas). Si hay varias, cada una se
 *   procesa con su propia llamada al LLM y se reemplaza individualmente
 *   — el resto del archivo se conserva exactamente igual.
 *
 * Cambios mantenidos de v7:
 *   code_execution — patrón en ActionParser para "ejecuta este código: `...`".
 *   apply_patch — patrón para "aplica este patch a app.js: ```...```".
 *   isHighImpact — code_execution y apply_patch requieren aprobación,
 *                  igual que edit_file/create_file.
 *   exec (comandos de shell) — requiere aprobación SOLO si matchea
 *                  HIGH_IMPACT_PATTERNS. Esto es intencional — no tocar.
 *   web_search/browser — implementación real en BrowserBridge.js, vía
 *                  OpenClawBridge.js. Planner solo detecta intención.
 *
 * Cambios mantenidos de v6:
 *   _executeStep única definición (antes había una duplicada — bug crítico).
 *   create_file — llm → write → verify para archivos nuevos.
 *   edit_file   — read → llm_transform → write → verify para archivos existentes.
 *   Chunking dinámico para archivos grandes según el proveedor LLM activo.
 */

'use strict';
const logger = require('../observability/Logger.js');

const { getOpenClawBridge } = require('./OpenClawBridge.js');
const { getStructuredActionParser } = require('./StructuredActionParser.js');
const AP = require('./ActionParser.js');

// ── LLM Provider ──────────────────────────────────────────────────────────────
function _getLLMComplete() {
  try {
    const LLMProvider = require('../llm/LLMProvider.js');
    if (typeof LLMProvider.completeTask === 'function') {
      return LLMProvider.completeTask.bind(LLMProvider);
    }
    return LLMProvider.complete.bind(LLMProvider);
  } catch (e) {
    throw new Error('LLMProvider no encontrado. Asegúrate de que ../llm/LLMProvider.js existe.');
  }
}

let PROVIDER_LIMITS = {
  groq: 8_000,
  gemini: 100_000,
  openai: 80_000,
  default: 8_000,
};

function setProviderLimits(limits) {
  if (limits && typeof limits === 'object') {
    PROVIDER_LIMITS = { ...PROVIDER_LIMITS, ...limits };
  }
}

function _getProviderLimit() {
  try {
    const LLMProvider = require('../llm/LLMProvider.js');
    const provider = LLMProvider.getActiveProvider() || 'default';
    return PROVIDER_LIMITS[provider] ?? PROVIDER_LIMITS.default;
  } catch {
    return PROVIDER_LIMITS.default;
  }
}

function _splitIntoSections(content, filePath) {
  const ext = filePath.split('.').pop().toLowerCase();
  const lines = content.split('\n');

  if (['md', 'markdown', 'txt', 'rst'].includes(ext)) {
    const sections = [];
    let current = [];
    for (const line of lines) {
      if (/^#\s/.test(line) && current.length > 0) {
        sections.push(current.join('\n'));
        current = [];
      }
      current.push(line);
    }
    if (current.length) sections.push(current.join('\n'));
    return sections.length > 1 ? sections : [content];
  }

  if (['js', 'ts', 'jsx', 'tsx', 'py', 'java', 'cs', 'go', 'rs', 'cpp', 'c'].includes(ext)) {
    const SECTION_START =
      /^(?:function\s|class\s|const\s+\w+\s*=\s*(?:async\s+)?(?:function|\()|async\s+function\s|def\s|public\s|private\s|protected\s|export\s)/;
    const sections = [];
    let current = [];
    for (const line of lines) {
      if (SECTION_START.test(line) && current.length > 5) {
        sections.push(current.join('\n'));
        current = [];
      }
      current.push(line);
    }
    if (current.length) sections.push(current.join('\n'));
    return sections.length > 1 ? sections : [content];
  }

  const sections = [];
  for (let i = 0; i < lines.length; i += 200) {
    sections.push(lines.slice(i, i + 200).join('\n'));
  }
  return sections;
}

/**
 * FIX v8: antes _findRelevantSection (singular) devolvía solo el índice
 * de la sección con mejor puntaje de keywords. Ahora devuelve TODAS las
 * secciones que tengan al menos un keyword-match, así una instrucción
 * que aplica a varias partes dispersas del archivo no se queda corta.
 *
 * Si ninguna sección matchea ningún keyword (instrucción muy genérica,
 * ej. "arregla el bug"), cae al comportamiento anterior: devuelve solo
 * la de mejor puntaje (aunque sea 0), para no romper el caso ambiguo.
 *
 * @returns {number[]} índices de secciones relevantes, en orden original
 */
function _findRelevantSections(sections, instruction) {
  const STOPWORDS = new Set([
    'el',
    'la',
    'los',
    'las',
    'un',
    'una',
    'en',
    'de',
    'que',
    'y',
    'a',
    'con',
    'por',
    'para',
    'al',
    'del',
  ]);
  const keywords = instruction
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w));

  if (!keywords.length) return [0];

  const scored = sections.map((section, i) => {
    const sectionLower = section.toLowerCase();
    const score = keywords.filter((kw) => sectionLower.includes(kw)).length;
    return { i, score };
  });

  const matched = scored.filter((s) => s.score > 0).map((s) => s.i);
  if (matched.length > 0) return matched;

  // Sin matches en ninguna sección — fallback al comportamiento anterior:
  // una sola sección, la de mejor puntaje (puede ser 0 en todas, en cuyo
  // caso se queda con la primera por orden de iteración).
  let bestIdx = 0,
    bestScore = -1;
  for (const s of scored) {
    if (s.score > bestScore) {
      bestScore = s.score;
      bestIdx = s.i;
    }
  }
  return [bestIdx];
}

async function _llmTransform(originalContent, instruction, filePath) {
  const complete = _getLLMComplete();
  const limit = _getProviderLimit();

  const systemPrompt = [
    'Eres un editor de archivos de texto.',
    'Recibirás el contenido de un archivo (completo o en sección) y una instrucción.',
    'Devuelve ÚNICAMENTE el contenido modificado, sin explicaciones,',
    'sin bloques markdown (no uses ```), sin comentarios adicionales.',
    'El output es exactamente el texto que debe quedar en el archivo.',
    'No agregues nada antes ni después del contenido.',
  ].join(' ');

  if (originalContent.length <= limit) {
    logger.info(
      'Planner',
      `[planner] _llmTransform: modo completo (${originalContent.length} chars, límite ${limit})`
    );

    const userMessage = [
      `Archivo: ${filePath}`,
      '',
      '--- CONTENIDO ACTUAL ---',
      originalContent,
      '--- FIN CONTENIDO ---',
      '',
      `Instrucción: ${instruction}`,
      '',
      'Devuelve el nuevo contenido completo del archivo.',
    ].join('\n');

    const newContent = await complete([{ role: 'user', content: userMessage }], systemPrompt);

    if (!newContent || !newContent.trim()) {
      throw new Error('El LLM devolvió contenido vacío (modo completo).');
    }

    return newContent;
  }

  logger.info(
    'Planner',
    `[planner] _llmTransform: modo chunking (${originalContent.length} chars > límite ${limit})`
  );

  const sections = _splitIntoSections(originalContent, filePath);
  const relevantIndices = _findRelevantSections(sections, instruction);

  logger.info(
    'Planner',
    `[planner] chunking: ${sections.length} secciones, relevantes: [${relevantIndices.join(', ')}]`
  );

  // ── Caso simple: una sola sección relevante ─────────────────────────────
  // Comportamiento idéntico a v7 — incluye secciones vecinas como contexto
  // para que el LLM no pierda continuidad con lo que viene antes/después.
  if (relevantIndices.length === 1) {
    const relevantIdx = relevantIndices[0];

    const CONTEXT_SECTIONS = [
      relevantIdx > 0 ? sections[relevantIdx - 1] : null,
      sections[relevantIdx],
      relevantIdx < sections.length - 1 ? sections[relevantIdx + 1] : null,
    ].filter(Boolean);

    const contextContent = CONTEXT_SECTIONS.join('\n');

    const chunkContent =
      contextContent.length <= limit ? contextContent : sections[relevantIdx].slice(0, limit);

    const isPartial = sections.length > 1;
    const sectionInfo = isPartial
      ? `Esta es la sección ${relevantIdx + 1} de ${sections.length} del archivo.`
      : '';

    const userMessage = [
      `Archivo: ${filePath}`,
      sectionInfo,
      '',
      '--- CONTENIDO A MODIFICAR ---',
      chunkContent,
      '--- FIN CONTENIDO ---',
      '',
      `Instrucción: ${instruction}`,
      '',
      isPartial
        ? 'Devuelve ÚNICAMENTE esta sección modificada. No incluyas otras partes del archivo.'
        : 'Devuelve el nuevo contenido completo del archivo.',
    ]
      .filter(Boolean)
      .join('\n');

    const modifiedChunk = await complete([{ role: 'user', content: userMessage }], systemPrompt);

    if (!modifiedChunk || !modifiedChunk.trim()) {
      throw new Error('El LLM devolvió contenido vacío (modo chunking).');
    }

    if (!isPartial) return modifiedChunk;

    const startIdx = Math.max(0, relevantIdx - 1);
    const endIdx = Math.min(sections.length - 1, relevantIdx + 1);

    const rebuiltSections = [
      ...sections.slice(0, startIdx),
      modifiedChunk,
      ...sections.slice(endIdx + 1),
    ];

    return rebuiltSections.join('\n');
  }

  // ── Caso múltiple: varias secciones dispersas matchean la instrucción ──
  // FIX v8: antes esto ni existía — solo se procesaba la mejor sección y
  // el resto del archivo quedaba intacto sin avisar. Ahora se procesa
  // CADA sección relevante con su propia llamada al LLM, y solo esas se
  // reemplazan; las demás secciones se conservan exactamente igual.
  logger.info(
    'Planner',
    `[planner] _llmTransform: ${relevantIndices.length} secciones afectadas, procesando cada una por separado`
  );

  const resultSections = [...sections];

  for (const idx of relevantIndices) {
    const sectionInfo = `Esta es la sección ${idx + 1} de ${sections.length} del archivo. Aplica la instrucción solo si corresponde a esta sección — si no aplica aquí, devuelve la sección sin cambios.`;

    const userMessage = [
      `Archivo: ${filePath}`,
      sectionInfo,
      '',
      '--- CONTENIDO A MODIFICAR ---',
      sections[idx],
      '--- FIN CONTENIDO ---',
      '',
      `Instrucción: ${instruction}`,
      '',
      'Devuelve ÚNICAMENTE esta sección (modificada o sin cambios). No incluyas otras partes del archivo.',
    ].join('\n');

    const modifiedChunk = await complete([{ role: 'user', content: userMessage }], systemPrompt);

    if (!modifiedChunk || !modifiedChunk.trim()) {
      throw new Error(`El LLM devolvió contenido vacío (sección ${idx + 1}/${sections.length}).`);
    }

    resultSections[idx] = modifiedChunk;
  }

  return resultSections.join('\n');
}

// ── isHighImpact, _cleanPath y ActionParser fueron movidos a ActionParser.js ──

// ── IDs ───────────────────────────────────────────────────────────────────────
let _planCounter = 0,
  _stepCounter = 0;
function planId() {
  return `plan_${Date.now()}_${++_planCounter}`;
}
function stepId() {
  return `step_${Date.now()}_${++_stepCounter}`;
}

// ── Planner ───────────────────────────────────────────────────────────────────

class Planner {
  constructor() {
    this._bridge = getOpenClawBridge();
    this._activePlan = null;
    this._planQueue = [];
    this._history = [];
    this._maxHistory = 50;
    this._abort = new AbortController();
  }

  planSingleStep(goal, tool, params, description) {
    const step = {
      id: stepId(),
      tool,
      params,
      description: description || `${tool}`,
      requiresApproval: AP.isHighImpact(tool, params),
      dependsOn: [],
      status: 'pending',
      result: null,
      error: null,
    };
    return {
      id: planId(),
      goal,
      steps: [step],
      status: 'pending',
      result: null,
      error: null,
      created: Date.now(),
      finished: null,
    };
  }

  /**
   * Plan multi-paso. Cada cfg admite `id` opcional (id estable para referenciar
   * en `dependsOn` de otros pasos); sin `id`, se genera uno interno.
   *
   *   planner.planMultiStep('objetivo', [
   *     { id: 'leer', tool: 'read', params: { path: 'a.js' }, description: 'leer a' },
   *     { id: 'editar', tool: 'edit', params: { path: 'a.js', instruction: '...' }, description: 'editar a', dependsOn: ['leer'] },
   *   ]);
   */
  planMultiStep(goal, stepsConfig) {
    const steps = stepsConfig.map((cfg) => ({
      id: cfg.id || stepId(),
      tool: cfg.tool,
      params: cfg.params,
      description: cfg.description || `${cfg.tool}`,
      requiresApproval: AP.isHighImpact(cfg.tool, cfg.params),
      dependsOn: cfg.dependsOn || [],
      status: 'pending',
      result: null,
      error: null,
    }));
    return {
      id: planId(),
      goal,
      steps,
      status: 'pending',
      result: null,
      error: null,
      created: Date.now(),
      finished: null,
    };
  }

  /**
   * FIX — Fase 3 (integración pendiente resuelta): antes esta función SOLO
   * usaba el ActionParser regex legacy, ignorando por completo el bloque
   * ```action``` estructurado que GroqSerializer ya le pide al LLM cuando
   * IntentDetector detecta una intención de nivel 'high'/'medium'. Es decir:
   * el LLM obedecía la instrucción y devolvía el bloque, pero nada en el
   * pipeline real lo leía — se descartaba en silencio y la respuesta caía
   * como si fuera puramente conversacional.
   *
   * Ahora se usa StructuredActionParser, que intenta el bloque estructurado
   * primero y cae automáticamente al ActionParser regex si no lo encuentra
   * (compatibilidad total con el flujo narrativo "Ejecutar: X" que se usa
   * cuando toolIntent no se detectó — ver Core.buildContext()).
   *
   * @param {object} toolIntent — resultado de IntentDetector (opcional).
   *   Solo se usa para un log de diagnóstico si el LLM ignoró el bloque
   *   pedido; no cambia el parsing en sí.
   */
  planFromLLMResponse(llmResponse, userGoal, toolIntent = null) {
    const parser = getStructuredActionParser(AP.PROJECT_CWD);
    const actions = parser.parse(llmResponse, userGoal, toolIntent);
    if (!actions || !actions.length) return null;
    if (actions.length === 1) {
      const action = actions[0];
      if (!action || !action.tool) return null;
      return this.planSingleStep(
        userGoal,
        action.tool,
        action.params || {},
        action.description || ''
      );
    }
    return this.planMultiStep(userGoal, actions);
  }

  async execute(plan, opts = {}) {
    this._planQueue = this._planQueue.filter((p) => p !== plan);
    if (this._activePlan) {
      this._planQueue.push(plan);
      logger.info(
        'Planner',
        `[planner] plan ${plan.id} encolado (${this._planQueue.length} pendientes)`
      );
      return { ...plan, status: 'queued', info: 'Encolado hasta que el plan activo termine' };
    }

    return this._runPlan(plan, opts);
  }

  async _runPlan(plan, opts = {}) {
    if (this._activePlan) {
      this._planQueue.push(plan);
      return { ...plan, status: 'queued', info: 'Encolado hasta que el plan activo termine' };
    }

    plan.status = 'running';
    this._activePlan = plan;
    this._abort = new AbortController();
    const signal = this._abort.signal;
    const stepResults = {};

    // G.1: subagentes paralelos. Los pasos sin dependencias pendientes se
    // agrupan en oleadas y se ejecutan en paralelo (Promise.all); el orden
    // topológico se respeta porque un paso solo entra a una oleada cuando
    // TODAS sus dependsOn ya terminaron. Si antes el plan era secuencial puro.
    const remaining = new Set(plan.steps.map((s) => s.id));
    let failedStep = null;

    while (remaining.size > 0) {
      if (signal.aborted) {
        for (const s of plan.steps) {
          if (!remaining.has(s.id)) continue;
          s.status = 'skipped';
          s.error = 'Plan cancelado';
          opts.onStepDone?.(s, null);
        }
        break;
      }

      const ready = plan.steps.filter(
        (s) => remaining.has(s.id) && (s.dependsOn || []).every((depId) => !remaining.has(depId))
      );

      if (ready.length === 0) {
        // Ciclo de dependencias o dependencia fallida: no hay nada ejecutable.
        for (const s of plan.steps) {
          if (!remaining.has(s.id)) continue;
          s.status = 'skipped';
          s.error = 'Dependencia no disponible';
          opts.onStepDone?.(s, null);
        }
        break;
      }

      const wave = await Promise.all(
        ready.map(async (step) => {
          const resolvedParams = this._resolveParams(step.params, stepResults);

          if (step.requiresApproval) {
            const approved =
              typeof opts.onApprovalNeeded === 'function'
                ? await opts.onApprovalNeeded(step)
                : false;
            if (!approved) {
              step.status = 'skipped';
              step.error = 'Cancelado por el usuario';
              opts.onStepDone?.(step, null);
              return { step, res: null, skipped: true };
            }
          }

          step.status = 'running';
          opts.onStepStart?.(step);
          logger.info('Planner', `[planner] ejecutando paso: ${step.description}`);

          let res;
          try {
            res = await this._executeStep(step.tool, resolvedParams);
          } catch (e) {
            res = { ok: false, error: e.message, result: null, tool: step.tool, elapsed: 0 };
          }
          return { step, res, skipped: false };
        })
      );

      for (const { step, res, skipped } of wave) {
        remaining.delete(step.id);
        if (skipped) continue;

        if (!res.ok) {
          step.status = 'failed';
          step.error = res.error;
          step.result = res.result || null;
          opts.onStepDone?.(step, null);
          failedStep = step;
          break;
        }

        step.status = 'done';
        step.result = res.result;
        stepResults[step.id] = res.result;
        opts.onStepDone?.(step, res.result);
      }

      if (failedStep) {
        // Cancelar lo que quede pendiente (depende de un paso que falló).
        for (const s of plan.steps) {
          if (!remaining.has(s.id)) continue;
          s.status = 'skipped';
          s.error = 'Plan falló en otro paso';
          opts.onStepDone?.(s, null);
        }
        break;
      }
    }

    if (failedStep) {
      plan.status = 'failed';
      plan.error = `"${failedStep.description}" falló: ${failedStep.error}`;
      plan.finished = Date.now();
      this._activePlan = null;
      this._archivePlan(plan);
      this._dequeueNext(opts);
      return plan;
    }

    const anyFailed = plan.steps.some((s) => s.status === 'failed');
    plan.status = anyFailed ? 'failed' : 'done';
    plan.result = this._aggregateResults(plan.steps);
    plan.finished = Date.now();
    this._activePlan = null;
    this._archivePlan(plan);
    this._dequeueNext(opts);

    logger.info('Planner', `[planner] plan ${plan.id} → ${plan.status}`);
    return plan;
  }

  async _executeStep(tool, params) {
    if (tool === 'edit_file' || tool === 'edit') return this._executeEditFile(params);
    if (tool === 'create_file' || tool === 'write') return this._executeCreateFile(params);
    if (tool === 'mcp') return this._executeMCP(params);
    if (tool === 'plugin') return this._executePlugin(params);
    return this._bridge.execute(tool, params);
  }

  /**
   * Ejecuta una tool de un plugin registrado. `params` espera `{ name, args }`
   * o `{ tool, args }` donde name/tool es el id `plugin.<plugin>.<tool>`.
   * El dispatch real lo provee el PluginManager enlazado en Core (bind).
   */
  async _executePlugin(params = {}) {
    const { getPluginManager } = require('../plugins/PluginManager.js');
    const mgr = getPluginManager();
    const toolId = params.name || params.tool;
    const args = params.args || {};
    if (!toolId) {
      return { ok: false, error: 'plugin_call requiere name/tool', result: null, tool: 'plugin' };
    }
    try {
      if (typeof mgr._dispatch !== 'function') {
        return {
          ok: false,
          error: 'PluginManager no enlazado al dispatch',
          result: null,
          tool: 'plugin',
        };
      }
      const result = await mgr._dispatch(toolId, args);
      return {
        ok: result?.ok !== false,
        result: result?.result ?? null,
        error: result?.error || null,
        tool: `plugin:${toolId}`,
      };
    } catch (e) {
      logger.warn('Planner', `[planner] error plugin ${toolId}:`, e.message);
      return { ok: false, error: e.message, result: null, tool: `plugin:${toolId}` };
    }
  }

  /**
   * Ejecuta una tool de un servidor MCP conectado. A diferencia del resto
   * de tools (que van a OpenClawBridge/mock-openclaw), esto pasa por
   * MCPManager — independiente de si OpenClaw está corriendo o no.
   */
  async _executeMCP(params = {}) {
    const { server, tool, args } = params;
    if (!server || !tool) {
      return {
        ok: false,
        error: 'server y tool requeridos para mcp_call',
        result: null,
        tool: 'mcp',
      };
    }
    const { getMCPManager } = require('../mcp/MCPManager.js');
    const mgr = getMCPManager();
    try {
      const result = await mgr.callTool(server, tool, args || {});
      const text =
        (result?.content || [])
          .filter((c) => c.type === 'text')
          .map((c) => c.text)
          .join('\n') || JSON.stringify(result);
      return { ok: true, result: text, tool: `mcp:${server}:${tool}` };
    } catch (e) {
      logger.warn('Planner', `[planner] error ejecutando mcp:${server}:${tool}:`, e.message);
      return { ok: false, error: e.message, result: null, tool: `mcp:${server}:${tool}` };
    }
  }

  async _executeEditFile({ path: filePath, instruction } = {}) {
    const start = Date.now();

    if (!filePath)
      return {
        ok: false,
        error: 'filePath requerido',
        result: null,
        tool: 'edit_file',
        elapsed: 0,
      };
    const instr = instruction || 'Realiza los cambios necesarios en el archivo.';
    logger.info('Planner', `[planner] paso 1: Leer ${filePath}`);
    const readResult = await this._bridge.execute('read', { path: filePath });

    if (!readResult.ok) {
      return {
        ok: false,
        error: `No se pudo leer "${filePath}": ${readResult.error}`,
        result: null,
        tool: 'edit_file',
        elapsed: Date.now() - start,
      };
    }

    const originalContent =
      typeof readResult.result === 'string' ? readResult.result : JSON.stringify(readResult.result);

    logger.info('Planner', `[planner] paso 2: Generar contenido actualizado para ${filePath}`);
    let newContent;
    try {
      newContent = await _llmTransform(originalContent, instr, filePath);
    } catch (e) {
      return {
        ok: false,
        error: `Error al transformar "${filePath}": ${e.message}`,
        result: null,
        tool: 'edit_file',
        elapsed: Date.now() - start,
      };
    }

    logger.info('Planner', `[planner] paso 3: Escribir ${filePath}`);
    const writeResult = await this._bridge.execute('write', {
      path: filePath,
      content: newContent,
    });

    if (!writeResult.ok) {
      return {
        ok: false,
        error: `No se pudo escribir "${filePath}": ${writeResult.error}`,
        result: null,
        tool: 'edit_file',
        elapsed: Date.now() - start,
      };
    }

    logger.info('Planner', `[planner] plan completado — ${filePath} modificado correctamente`);

    return {
      ok: true,
      result: {
        status: 'success',
        path: filePath,
        originalContent,
        newContent,
      },
      tool: 'edit_file',
      elapsed: Date.now() - start,
    };
  }

  async _executeCreateFile({ path: filePath, instruction } = {}) {
    const start = Date.now();

    if (!filePath)
      return {
        ok: false,
        error: 'filePath requerido',
        result: null,
        tool: 'create_file',
        elapsed: 0,
      };
    logger.info('Planner', `[planner] paso 1: Generar contenido para ${filePath}`);

    const complete = _getLLMComplete();
    const systemPrompt = [
      'Eres un generador de archivos de texto.',
      'Recibirás una instrucción que describe qué archivo crear y con qué contenido.',
      'Devuelve ÚNICAMENTE el contenido que debe tener el archivo nuevo.',
      'Sin explicaciones, sin bloques markdown (no uses ```), sin comentarios.',
      'Si la instrucción incluye texto literal a escribir, usa exactamente ese texto.',
    ].join(' ');

    const userMessage = [
      `Archivo a crear: ${filePath}`,
      '',
      `Instrucción: ${instruction}`,
      '',
      'Devuelve el contenido completo del archivo nuevo.',
    ].join('\n');

    let content;
    try {
      content = await complete([{ role: 'user', content: userMessage }], systemPrompt);
    } catch (e) {
      return {
        ok: false,
        error: `Error generando contenido para "${filePath}": ${e.message}`,
        result: null,
        tool: 'create_file',
        elapsed: Date.now() - start,
      };
    }

    if (!content || !content.trim()) {
      return {
        ok: false,
        error: 'El LLM devolvió contenido vacío.',
        result: null,
        tool: 'create_file',
        elapsed: Date.now() - start,
      };
    }

    logger.info('Planner', `[planner] paso 2: Escribir ${filePath}`);
    const writeResult = await this._bridge.execute('write', { path: filePath, content });

    if (!writeResult.ok) {
      return {
        ok: false,
        error: `No se pudo escribir "${filePath}": ${writeResult.error}`,
        result: null,
        tool: 'create_file',
        elapsed: Date.now() - start,
      };
    }

    logger.info('Planner', `[planner] plan completado — ${filePath} creado correctamente`);

    return {
      ok: true,
      result: { status: 'success', path: filePath, content },
      tool: 'create_file',
      elapsed: Date.now() - start,
    };
  }

  _dequeueNext(opts) {
    if (this._planQueue.length === 0) return;
    const next = this._planQueue.shift();
    logger.info(
      'Planner',
      `[planner] desencolando plan ${next.id} (${this._planQueue.length} pendientes)`
    );
    this._runPlan(next, opts || {}).catch((e) => {
      logger.error('Planner', `[planner] plan encolado ${next.id} falló:`, e.message);
      next.status = 'failed';
      next.error = e.message;
    });
  }

  cancel() {
    if (this._activePlan) {
      this._activePlan.status = 'cancelled';
      this._activePlan.finished = Date.now();
      this._archivePlan(this._activePlan);
      this._activePlan = null;
    }
    this._abort.abort();
    this._abort = new AbortController();
    this._dequeueNext({});
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
    const doneSteps = steps.filter((s) => s.status === 'done' && s.result != null);
    if (doneSteps.length === 0) return null;
    if (doneSteps.length === 1) return doneSteps[0].result;
    const results = {};
    for (const s of doneSteps) {
      const val =
        typeof s.result === 'string' && s.result.length > 800
          ? s.result.slice(0, 800) + '[...]'
          : s.result;
      results[s.description] = val;
    }
    return results;
  }

  _archivePlan(plan) {
    this._history.push(plan);
    if (this._history.length > this._maxHistory) this._history.shift();
  }

  getStats() {
    return {
      total: this._history.length,
      done: this._history.filter((p) => p.status === 'done').length,
      failed: this._history.filter((p) => p.status === 'failed').length,
      cancelled: this._history.filter((p) => p.status === 'cancelled').length,
      active: this._activePlan?.id ?? null,
      bridge: this._bridge.getStats(),
    };
  }

  getHistory(n = 10) {
    return this._history.slice(-n).map((p) => ({
      id: p.id,
      goal: p.goal,
      status: p.status,
      steps: p.steps.length,
      elapsed: p.finished ? p.finished - p.created : null,
      result: typeof p.result === 'string' ? p.result.slice(0, 200) : p.result,
      error: p.error,
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
  ActionParser: AP.ActionParser,
  getPlanner,
  isHighImpact: AP.isHighImpact,
  setProjectCWD: AP.setProjectCWD,
  getProjectCWD: () => AP.PROJECT_CWD,
};
